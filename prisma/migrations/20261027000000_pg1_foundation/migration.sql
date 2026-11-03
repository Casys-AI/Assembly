-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Project" (
    "projectId" TEXT NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "AssemblySystem" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,

    CONSTRAINT "AssemblySystem_pkey" PRIMARY KEY ("projectId","systemId")
);

-- CreateTable
CREATE TABLE "ExecutionSpace" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "parentExecutionSpaceId" TEXT,
    "caseId" TEXT,
    "lifecycle" TEXT NOT NULL DEFAULT 'active',
    "lifecycleRevision" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ExecutionSpace_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId")
);

-- CreateTable
CREATE TABLE "CaseIdentity" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "number" BIGINT NOT NULL,

    CONSTRAINT "CaseIdentity_pkey" PRIMARY KEY ("projectId","systemId","caseId")
);

-- CreateTable
CREATE TABLE "CaseSequence" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "lastNumber" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "CaseSequence_pkey" PRIMARY KEY ("projectId","systemId")
);

-- CreateTable
CREATE TABLE "SpaceManifest" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpaceManifest_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","revision")
);

-- CreateTable
CREATE TABLE "OperatorRuntime" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,

    CONSTRAINT "OperatorRuntime_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId")
);

-- CreateTable
CREATE TABLE "SourceRepository" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "sourceScopeId" TEXT NOT NULL,

    CONSTRAINT "SourceRepository_pkey" PRIMARY KEY ("projectId","systemId","repositoryId")
);

-- CreateTable
CREATE TABLE "ArtifactVersion" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceReferenceVersion" BIGINT NOT NULL DEFAULT 1,
    "sourceScopeId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "commitOid" TEXT NOT NULL,
    "manifestPath" TEXT NOT NULL,
    "entryPath" TEXT NOT NULL,
    "contentDigest" TEXT NOT NULL,
    "contentEncoding" TEXT NOT NULL,
    "manifestDigestVersion" TEXT NOT NULL,
    "manifestDigest" TEXT NOT NULL,
    "publishedAt" TIMESTAMPTZ(3) NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtifactVersion_pkey" PRIMARY KEY ("projectId","systemId","versionId")
);

-- CreateTable
CREATE TABLE "ArtifactBinding" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "localArtifactId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "provenancePayload" TEXT NOT NULL,

    CONSTRAINT "ArtifactBinding_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","bindingId")
);

-- CreateTable
CREATE TABLE "ProtectedBindingReference" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProtectedBindingReference_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","referenceId","revision")
);

-- CreateTable
CREATE TABLE "RuntimeState" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "payload" TEXT NOT NULL,

    CONSTRAINT "RuntimeState_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId")
);

-- CreateTable
CREATE TABLE "RuntimeRevision" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL,
    "runtimeStateId" TEXT NOT NULL,
    "catalogRevision" BIGINT NOT NULL,
    "modelPayload" TEXT,
    "eventCount" BIGINT NOT NULL,
    "origin" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "agentCount" BIGINT NOT NULL,
    "activeToolCount" BIGINT NOT NULL,

    CONSTRAINT "RuntimeRevision_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","revision")
);

-- CreateTable
CREATE TABLE "WorkBudget" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "payload" TEXT NOT NULL,

    CONSTRAINT "WorkBudget_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","scopeId")
);

-- CreateTable
CREATE TABLE "WorkPlan" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "payload" TEXT NOT NULL,

    CONSTRAINT "WorkPlan_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","id")
);

-- CreateTable
CREATE TABLE "GovernedMemory" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "digest" TEXT NOT NULL,
    "payload" TEXT NOT NULL,

    CONSTRAINT "GovernedMemory_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","ownerId","id")
);

-- CreateTable
CREATE TABLE "MemoryInvocation" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "callerId" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,

    CONSTRAINT "MemoryInvocation_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","ownerId","callerId","invocationId")
);

-- CreateTable
CREATE TABLE "SkillCatalog" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "payload" TEXT NOT NULL,

    CONSTRAINT "SkillCatalog_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","ownerId")
);

-- CreateTable
CREATE TABLE "SkillInvocation" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "callerId" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "kind" TEXT NOT NULL,

    CONSTRAINT "SkillInvocation_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","ownerId","callerId","invocationId")
);

-- CreateTable
CREATE TABLE "ContextSelection" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "selectionId" TEXT NOT NULL,
    "caseId" TEXT,
    "stateRevision" BIGINT NOT NULL,
    "sourceRangePayload" TEXT NOT NULL,
    "selectedVersionsPayload" TEXT NOT NULL,
    "derivedProjectionPayload" TEXT,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextSelection_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","selectionId")
);

-- CreateTable
CREATE TABLE "RuntimeProjection" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "digest" TEXT NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL,
    "payload" TEXT NOT NULL,

    CONSTRAINT "RuntimeProjection_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","revision")
);

-- CreateIndex
CREATE INDEX "ExecutionSpace_projectId_systemId_parentExecutionSpaceId_idx" ON "ExecutionSpace"("projectId", "systemId", "parentExecutionSpaceId");

-- CreateIndex
CREATE INDEX "ExecutionSpace_projectId_systemId_caseId_idx" ON "ExecutionSpace"("projectId", "systemId", "caseId");

-- CreateIndex
CREATE UNIQUE INDEX "CaseIdentity_projectId_systemId_number_key" ON "CaseIdentity"("projectId", "systemId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRepository_projectId_systemId_repositoryId_sourceScop_key" ON "SourceRepository"("projectId", "systemId", "repositoryId", "sourceScopeId");

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactVersion_projectId_systemId_artifactId_kind_reposito_key" ON "ArtifactVersion"("projectId", "systemId", "artifactId", "kind", "repositoryId", "commitOid", "manifestPath");

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactBinding_projectId_systemId_executionSpaceId_operato_key" ON "ArtifactBinding"("projectId", "systemId", "executionSpaceId", "operatorId", "ownerId", "invocationId");

-- AddForeignKey
ALTER TABLE "AssemblySystem" ADD CONSTRAINT "AssemblySystem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("projectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionSpace" ADD CONSTRAINT "ExecutionSpace_projectId_systemId_fkey" FOREIGN KEY ("projectId", "systemId") REFERENCES "AssemblySystem"("projectId", "systemId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionSpace" ADD CONSTRAINT "ExecutionSpace_projectId_systemId_parentExecutionSpaceId_fkey" FOREIGN KEY ("projectId", "systemId", "parentExecutionSpaceId") REFERENCES "ExecutionSpace"("projectId", "systemId", "executionSpaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionSpace" ADD CONSTRAINT "ExecutionSpace_projectId_systemId_caseId_fkey" FOREIGN KEY ("projectId", "systemId", "caseId") REFERENCES "CaseIdentity"("projectId", "systemId", "caseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseIdentity" ADD CONSTRAINT "CaseIdentity_projectId_systemId_fkey" FOREIGN KEY ("projectId", "systemId") REFERENCES "AssemblySystem"("projectId", "systemId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseSequence" ADD CONSTRAINT "CaseSequence_projectId_systemId_fkey" FOREIGN KEY ("projectId", "systemId") REFERENCES "AssemblySystem"("projectId", "systemId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpaceManifest" ADD CONSTRAINT "SpaceManifest_projectId_systemId_executionSpaceId_fkey" FOREIGN KEY ("projectId", "systemId", "executionSpaceId") REFERENCES "ExecutionSpace"("projectId", "systemId", "executionSpaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorRuntime" ADD CONSTRAINT "OperatorRuntime_projectId_systemId_executionSpaceId_fkey" FOREIGN KEY ("projectId", "systemId", "executionSpaceId") REFERENCES "ExecutionSpace"("projectId", "systemId", "executionSpaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceRepository" ADD CONSTRAINT "SourceRepository_projectId_systemId_fkey" FOREIGN KEY ("projectId", "systemId") REFERENCES "AssemblySystem"("projectId", "systemId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_projectId_systemId_repositoryId_sourceScop_fkey" FOREIGN KEY ("projectId", "systemId", "repositoryId", "sourceScopeId") REFERENCES "SourceRepository"("projectId", "systemId", "repositoryId", "sourceScopeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactBinding" ADD CONSTRAINT "ArtifactBinding_projectId_systemId_executionSpaceId_operat_fkey" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId") REFERENCES "OperatorRuntime"("projectId", "systemId", "executionSpaceId", "operatorId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactBinding" ADD CONSTRAINT "ArtifactBinding_projectId_systemId_versionId_fkey" FOREIGN KEY ("projectId", "systemId", "versionId") REFERENCES "ArtifactVersion"("projectId", "systemId", "versionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProtectedBindingReference" ADD CONSTRAINT "ProtectedBindingReference_projectId_systemId_executionSpac_fkey" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId") REFERENCES "OperatorRuntime"("projectId", "systemId", "executionSpaceId", "operatorId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeState" ADD CONSTRAINT "RuntimeState_projectId_systemId_executionSpaceId_operatorI_fkey" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId") REFERENCES "OperatorRuntime"("projectId", "systemId", "executionSpaceId", "operatorId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeRevision" ADD CONSTRAINT "RuntimeRevision_projectId_systemId_executionSpaceId_operat_fkey" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId") REFERENCES "OperatorRuntime"("projectId", "systemId", "executionSpaceId", "operatorId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkBudget" ADD CONSTRAINT "WorkBudget_projectId_systemId_executionSpaceId_operatorId_fkey" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId") REFERENCES "OperatorRuntime"("projectId", "systemId", "executionSpaceId", "operatorId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkPlan" ADD CONSTRAINT "WorkPlan_projectId_systemId_executionSpaceId_operatorId_fkey" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId") REFERENCES "OperatorRuntime"("projectId", "systemId", "executionSpaceId", "operatorId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GovernedMemory" ADD CONSTRAINT "GovernedMemory_projectId_systemId_executionSpaceId_operato_fkey" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId") REFERENCES "OperatorRuntime"("projectId", "systemId", "executionSpaceId", "operatorId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryInvocation" ADD CONSTRAINT "MemoryInvocation_projectId_systemId_executionSpaceId_opera_fkey" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId") REFERENCES "OperatorRuntime"("projectId", "systemId", "executionSpaceId", "operatorId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillCatalog" ADD CONSTRAINT "SkillCatalog_projectId_systemId_executionSpaceId_operatorI_fkey" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId") REFERENCES "OperatorRuntime"("projectId", "systemId", "executionSpaceId", "operatorId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillInvocation" ADD CONSTRAINT "SkillInvocation_projectId_systemId_executionSpaceId_operat_fkey" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId") REFERENCES "OperatorRuntime"("projectId", "systemId", "executionSpaceId", "operatorId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextSelection" ADD CONSTRAINT "ContextSelection_source_fkey" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "stateRevision") REFERENCES "RuntimeRevision"("projectId", "systemId", "executionSpaceId", "operatorId", "revision") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextSelection" ADD CONSTRAINT "ContextSelection_projectId_systemId_executionSpaceId_opera_fkey" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId") REFERENCES "OperatorRuntime"("projectId", "systemId", "executionSpaceId", "operatorId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeProjection" ADD CONSTRAINT "RuntimeProjection_projectId_systemId_executionSpaceId_oper_fkey" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "revision") REFERENCES "RuntimeRevision"("projectId", "systemId", "executionSpaceId", "operatorId", "revision") ON DELETE RESTRICT ON UPDATE CASCADE;

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
