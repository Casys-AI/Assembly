-- Supplemental PostgreSQL invariants appended to the generated initial migration.
-- Prisma describes keys/types; PostgreSQL enforces immutable accepted evidence.

ALTER TABLE "ExecutionSpace" ADD CONSTRAINT "ExecutionSpace_lifecycle_check"
  CHECK ("lifecycle" IN ('active', 'closed') AND
    (("lifecycle" = 'active' AND "closedAt" IS NULL) OR
     ("lifecycle" = 'closed' AND "closedAt" IS NOT NULL)));
ALTER TABLE "ExecutionSpace" ADD CONSTRAINT "ExecutionSpace_parent_check"
  CHECK ("parentExecutionSpaceId" IS NULL OR
    "parentExecutionSpaceId" <> "executionSpaceId");
ALTER TABLE "SpaceManifest" ADD CONSTRAINT "SpaceManifest_kind_check"
  CHECK ("kind" IN ('baseline', 'adoption') AND "digest" ~ '^[0-9a-f]{64}$');
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_pin_check"
  CHECK ("commitOid" ~ '^[0-9a-f]{40}$' AND
    "contentDigest" ~ '^[0-9a-f]{64}$' AND
    "manifestDigest" ~ '^[0-9a-f]{64}$' AND
    "sourceReferenceVersion" = 1 AND
    "manifestDigestVersion" = 'sha256-canonical-json-v1' AND
    (("kind" = 'tool-draft' AND "contentEncoding" = 'tool-draft-json-v1') OR
     ("kind" = 'skill-document' AND "contentEncoding" = 'utf8-v1')));
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_path_check"
  CHECK (length("entryPath") > 0 AND length("manifestPath") > 0 AND
    "entryPath" !~ '(^/|\\|(^|/)\.{1,2}(/|$)|//|/$)' AND
    "manifestPath" !~ '(^/|\\|(^|/)\.{1,2}(/|$)|//|/$)');
ALTER TABLE "ProtectedBindingReference" ADD CONSTRAINT "ProtectedBindingReference_status_check"
  CHECK ("status" IN ('active', 'revoked'));
ALTER TABLE "RuntimeRevision" ADD CONSTRAINT "RuntimeRevision_origin_check"
  CHECK ("origin" IN ('commit', 'legacy_backfill'));

-- Identifiers and counters retain the full legacy JavaScript safe integer range.
DO $$
DECLARE column_record record;
BEGIN
  FOR column_record IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND data_type = 'bigint'
      AND table_name IN (
        'ExecutionSpace', 'CaseIdentity', 'CaseSequence', 'SpaceManifest',
        'ArtifactVersion', 'ArtifactBinding', 'ProtectedBindingReference',
        'RuntimeState', 'RuntimeRevision', 'RuntimeProjection', 'WorkBudget',
        'WorkPlan', 'GovernedMemory', 'SkillCatalog', 'ContextSelection')
  LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I BETWEEN 0 AND 9007199254740991)',
      column_record.table_name,
      column_record.table_name || '_' || column_record.column_name || '_safe_integer',
      column_record.column_name);
  END LOOP;
END $$;

CREATE FUNCTION assembly_reject_immutable_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable Assembly evidence cannot be changed' USING ERRCODE = '23514';
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'RuntimeRevision', 'RuntimeProjection', 'SpaceManifest', 'ArtifactVersion',
    'MemoryInvocation', 'SkillInvocation', 'ContextSelection', 'ProtectedBindingReference'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION assembly_reject_immutable_change()',
      table_name || '_immutable', table_name);
  END LOOP;
END $$;

CREATE UNIQUE INDEX "SpaceManifest_single_baseline" ON "SpaceManifest"
  ("projectId", "systemId", "executionSpaceId") WHERE "kind" = 'baseline';

-- Parentage and canonical identities cannot be rewritten after space creation.
-- Together with immediate foreign keys, this also prevents introducing cycles.
CREATE FUNCTION assembly_preserve_space_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."projectId", NEW."systemId", NEW."executionSpaceId", NEW."parentExecutionSpaceId", NEW."caseId")
    IS DISTINCT FROM ROW(OLD."projectId", OLD."systemId", OLD."executionSpaceId", OLD."parentExecutionSpaceId", OLD."caseId") THEN
    RAISE EXCEPTION 'Assembly execution-space identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExecutionSpace_preserve_identity" BEFORE UPDATE ON "ExecutionSpace"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_space_identity();
