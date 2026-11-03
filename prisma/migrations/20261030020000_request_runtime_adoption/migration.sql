-- Metadata only for existing Main v1 dossiers: preserve payload bytes, IDs,
-- revisions, timestamp text and repository/dossier foreign keys verbatim.
ALTER TABLE "EvolutionDossier"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'software-evolution-v1',
  ADD COLUMN "targetScopeKey" TEXT NOT NULL DEFAULT 'main',
  ADD COLUMN "executionSpaceId" TEXT;
ALTER TABLE "EvolutionTargetBarrier"
  ADD COLUMN "targetScopeKey" TEXT NOT NULL DEFAULT 'main',
  ADD COLUMN "executionSpaceId" TEXT;
ALTER TABLE "EvolutionTargetBarrier" DROP CONSTRAINT "EvolutionTargetBarrier_pkey";
ALTER TABLE "EvolutionTargetBarrier" ADD PRIMARY KEY
  ("projectId", "systemId", "repositoryId", "targetScopeKey", "operatorId");
ALTER TABLE "EvolutionTargetBarrier" ADD CONSTRAINT "EvolutionTargetBarrier_scope_check" CHECK ((
  ("targetScopeKey" = 'main' AND "executionSpaceId" IS NULL) OR
  ("executionSpaceId" IS NOT NULL AND "executionSpaceId" <> 'main' AND
   "executionSpaceId" ~ '^[A-Za-z0-9_-]{1,128}$' AND
   "targetScopeKey" = 'request:' || "executionSpaceId")
) IS TRUE);
-- Main keeps its existing adapter-owned payload validation and corruption
-- refusal behavior. CASE prevents PostgreSQL expression reordering from parsing
-- historical v1 payload bytes as part of Request-only metadata consistency.
ALTER TABLE "EvolutionDossier" ADD CONSTRAINT "EvolutionDossier_scope_kind_check" CHECK ((
  CASE
    WHEN "kind" = 'software-evolution-v1' THEN
      "targetScopeKey" = 'main' AND "executionSpaceId" IS NULL
    WHEN "kind" = 'request-owner-adoption-v2' THEN
      "executionSpaceId" IS NOT NULL AND "executionSpaceId" <> 'main' AND
      "executionSpaceId" ~ '^[A-Za-z0-9_-]{1,128}$' AND "targetScopeKey" = 'request:' || "executionSpaceId" AND
      "payload"::jsonb->>'v' = '2' AND "payload"::jsonb->>'kind' = 'request-owner-adoption' AND
      "payload"::jsonb#>>'{intent,target,executionSpaceId}' = "executionSpaceId" AND
      "payload"::jsonb#>>'{intent,target,repositoryId}' = "repositoryId" AND
      "payload"::jsonb#>>'{intent,target,host,projectId}' = "projectId" AND
      "payload"::jsonb#>>'{intent,target,host,systemId}' = "systemId"
    ELSE FALSE
  END
) IS TRUE);
CREATE INDEX "EvolutionDossier_scoped_recent_idx" ON "EvolutionDossier"
  ("projectId", "systemId", "repositoryId", "kind", "targetScopeKey", "updatedAt" DESC, "id");

-- Keep every existing immutable journal row and kind. Runtime adoption is a
-- separate canonical append; it never rewrites source-admission or B0 bytes.
ALTER TABLE "SpaceManifest" DROP CONSTRAINT "SpaceManifest_kind_check";
ALTER TABLE "SpaceManifest" ADD CONSTRAINT "SpaceManifest_kind_check"
  CHECK ("kind" IN ('baseline', 'adoption', 'source-admission', 'runtime-adoption')
    AND "digest" ~ '^[0-9a-f]{64}$'
    AND CASE WHEN "kind" = 'runtime-adoption' THEN
      "digest" = encode(sha256(convert_to("payload", 'UTF8')), 'hex')
    ELSE TRUE END);

-- Credentials retain assembly_space_control_immutable without modification.
-- Only the admission table gains a narrow, same-transaction pin transition.
DROP TRIGGER "SpaceExecutionAdmission_immutable" ON "SpaceExecutionAdmission";
CREATE FUNCTION "assembly_request_admission_immutable"() RETURNS trigger LANGUAGE plpgsql
SET search_path FROM CURRENT AS $$
DECLARE
  prior_permissions jsonb;
  next_permissions jsonb;
  proof_count bigint;
BEGIN
  IF OLD."status" <> 'active' OR NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'Immutable space execution admission identity or revision';
  END IF;
  -- Preserve the old revocation path, including exact original payload bytes.
  -- It does not parse historical authority/permission JSON or permit renewal.
  IF NEW."status" = 'revoked' THEN
    IF (to_jsonb(NEW)-ARRAY['revision','status']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['revision','status']) THEN
      RAISE EXCEPTION 'Immutable space execution admission revocation envelope';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" <> 'active' OR NEW."executionSpaceId" = 'main' OR
     (to_jsonb(NEW)-ARRAY['revision','permissionsJson']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['revision','permissionsJson']) OR
     NEW."permissionsJson" = OLD."permissionsJson" THEN
    RAISE EXCEPTION 'Immutable space execution admission pin envelope';
  END IF;
  prior_permissions := OLD."permissionsJson"::jsonb;
  next_permissions := NEW."permissionsJson"::jsonb;
  IF (jsonb_typeof(prior_permissions) = 'object' AND jsonb_typeof(next_permissions) = 'object' AND
      prior_permissions ?& ARRAY['operatorIds','acts','sourceVersion','modelDigests','resourceIds'] AND
      next_permissions ?& ARRAY['operatorIds','acts','sourceVersion','modelDigests','resourceIds'] AND
      prior_permissions-ARRAY['operatorIds','acts','sourceVersion','modelDigests','resourceIds'] = '{}'::jsonb AND
      next_permissions-ARRAY['operatorIds','acts','sourceVersion','modelDigests','resourceIds'] = '{}'::jsonb AND
      prior_permissions-ARRAY['sourceVersion','modelDigests'] = next_permissions-ARRAY['sourceVersion','modelDigests'] AND
      jsonb_typeof(prior_permissions->'operatorIds') = 'array' AND jsonb_array_length(prior_permissions->'operatorIds') = 1 AND
      jsonb_typeof(prior_permissions#>'{operatorIds,0}') = 'string' AND prior_permissions#>>'{operatorIds,0}' NOT IN ('','*') AND
      jsonb_typeof(prior_permissions->'modelDigests') = 'array' AND jsonb_array_length(prior_permissions->'modelDigests') = 1 AND
      jsonb_typeof(next_permissions->'modelDigests') = 'array' AND jsonb_array_length(next_permissions->'modelDigests') = 1 AND
      jsonb_typeof(prior_permissions#>'{modelDigests,0}') = 'string' AND jsonb_typeof(next_permissions#>'{modelDigests,0}') = 'string' AND
      prior_permissions->'acts' = '["conversation"]'::jsonb AND prior_permissions->'resourceIds' = '[]'::jsonb AND
      prior_permissions->>'sourceVersion' ~ '^commit:[a-f0-9]{40}$' AND
      next_permissions->>'sourceVersion' ~ '^commit:[a-f0-9]{40}$' AND
      prior_permissions#>>'{modelDigests,0}' ~ '^[a-f0-9]{64}$' AND
      next_permissions#>>'{modelDigests,0}' ~ '^[a-f0-9]{64}$' AND
      prior_permissions->>'sourceVersion' <> next_permissions->>'sourceVersion' AND
      prior_permissions->'modelDigests' <> next_permissions->'modelDigests') IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Only an exact conversation admission model/source pin may advance';
  END IF;
  -- xmin prevents a historical committed manifest from authorizing a later SQL
  -- update. No deferred mechanism or separately committed intermediate state.
  WITH candidates AS MATERIALIZED (
    SELECT m."revision", CASE WHEN m."kind" = 'runtime-adoption' AND
      m.xmin = pg_current_xact_id()::xid AND
      m."digest" = encode(sha256(convert_to(m."payload", 'UTF8')), 'hex')
      THEN m."payload"::jsonb ELSE NULL END AS proof
    FROM "SpaceManifest" m
    WHERE m."projectId"=OLD."projectId" AND m."systemId"=OLD."systemId" AND
      m."executionSpaceId"=OLD."executionSpaceId" AND m."kind"='runtime-adoption' AND
      m.xmin = pg_current_xact_id()::xid
  )
  SELECT count(*) INTO proof_count
  FROM candidates m
  JOIN "SpaceOpening" o ON o."projectId"=OLD."projectId" AND o."systemId"=OLD."systemId" AND
    o."id"=OLD."openingId" AND o."executionSpaceId"=OLD."executionSpaceId" AND o."ownerId"=OLD."ownerId" AND
    o."admissionId"=OLD."id" AND o."baseDigest"=OLD."baseDigest" AND o."phase"='dispatched'
  JOIN "ExecutionSpace" e ON e."projectId"=o."projectId" AND e."systemId"=o."systemId" AND
    e."executionSpaceId"=o."executionSpaceId" AND e."caseId"=o."caseId" AND e."parentExecutionSpaceId"='main' AND
    e."lifecycle"='active' AND e."closedAt" IS NULL
  JOIN "EvolutionDossier" d ON d."projectId"=o."projectId" AND d."systemId"=o."systemId" AND
    d."id"=m.proof->>'commandId' AND d."repositoryId"=m.proof#>>'{intent,target,repositoryId}' AND
    d."kind"='request-owner-adoption-v2' AND d."executionSpaceId"=o."executionSpaceId" AND
    d."targetScopeKey"='request:'||o."executionSpaceId" AND d."status"='armed'
  JOIN "EvolutionTargetBarrier" b ON b."projectId"=d."projectId" AND b."systemId"=d."systemId" AND
    b."repositoryId"=d."repositoryId" AND b."targetScopeKey"=d."targetScopeKey" AND
    b."executionSpaceId"=d."executionSpaceId" AND b."dossierId"=d."id" AND
    b."operatorId"=prior_permissions#>>'{operatorIds,0}'
  JOIN "RuntimeState" r ON r."projectId"=o."projectId" AND r."systemId"=o."systemId" AND
    r."executionSpaceId"=o."executionSpaceId" AND r."operatorId"=b."operatorId" AND
    r."revision"=(m.proof->>'committedRuntimeRevision')::bigint
  JOIN "RuntimeRevision" authorized ON authorized."projectId"=r."projectId" AND authorized."systemId"=r."systemId" AND
    authorized."executionSpaceId"=r."executionSpaceId" AND authorized."operatorId"=r."operatorId" AND
    authorized."revision"=(m.proof->>'authorizationRuntimeRevision')::bigint
  JOIN "RuntimeRevision" committed ON committed."projectId"=r."projectId" AND committed."systemId"=r."systemId" AND
    committed."executionSpaceId"=r."executionSpaceId" AND committed."operatorId"=r."operatorId" AND
    committed."revision"=r."revision" AND committed."payload"=r."payload" AND
    committed."runtimeStateId"=authorized."runtimeStateId" AND
    committed."runtimeStateId"='request:'||o."executionSpaceId"||':'||b."operatorId"
  WHERE (m.proof->>'format'='request-runtime-adoption/v2' AND
    -- The closed application decoder owns intent/authority semantics. Bind its
    -- exact persisted armed intent to the fresh manifest and actual destination.
    CASE WHEN d."kind"='request-owner-adoption-v2' THEN d."payload"::jsonb->'intent' ELSE NULL END=m.proof->'intent' AND
    m.proof#>>'{intent,target,openingId}'=o."id" AND
    m.proof#>>'{intent,target,caseId}'=o."caseId" AND m.proof#>>'{intent,target,branchId}'=o."branchId" AND
    m.proof#>>'{intent,target,operatorId}'=b."operatorId" AND o."baseJson"::jsonb#>>'{requestOwner,operatorId}'=b."operatorId" AND
    o."baseJson"::jsonb#>>'{manifest,source,repositoryId}'=d."repositoryId" AND
    m.proof#>>'{intent,openingBaseDigest}'=OLD."baseDigest" AND
    -- The original admission and its capability/pin identify the transition.
    -- Structural OLD/NEW equality above preserves authority, expiry and rights.
    m.proof#>>'{intent,previous,admission,id}'=OLD."id" AND
    (m.proof#>>'{intent,previous,admission,revision}')::integer=OLD."revision" AND
    m.proof#>>'{intent,previous,admission,capabilityId}'=OLD."capabilityId" AND
    (m.proof#>>'{intent,previous,admission,capabilityRevision}')::integer=OLD."capabilityRevision" AND
    m.proof#>'{intent,previous,admission,permissions}'=prior_permissions AND
    m.proof#>>'{intent,previous,pin,source,version}'=prior_permissions->>'sourceVersion' AND
    m.proof#>>'{intent,previous,pin,modelDigest}'=prior_permissions#>>'{modelDigests,0}' AND
    (m.proof->>'admissionRevision')::integer=NEW."revision" AND
    m.proof#>>'{intent,candidate,source,version}'=next_permissions->>'sourceVersion' AND
    m.proof#>>'{intent,candidate,model,version,digest}'=next_permissions#>>'{modelDigests,0}' AND
    -- Require the actual state/history append sequence. Native
    -- and human authorization validation stays in their existing domain owners.
    (m.proof->>'authorizationRuntimeRevision')::bigint=(m.proof->>'previousRuntimeRevision')::bigint+1 AND
    (m.proof->>'committedRuntimeRevision')::bigint=(m.proof->>'authorizationRuntimeRevision')::bigint+1 AND
    m."revision"=(m.proof#>>'{predecessor,revision}')::bigint+1 AND
    authorized."modelPayload"::jsonb=m.proof#>'{intent,previous,identity}' AND
    committed."modelPayload"::jsonb=m.proof#>'{intent,candidate,model,identity}') IS TRUE;
  IF proof_count <> 1 THEN
    RAISE EXCEPTION 'Admission pin advance requires its exact current-transaction runtime adoption proof';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "SpaceExecutionAdmission_immutable" BEFORE UPDATE ON "SpaceExecutionAdmission"
  FOR EACH ROW EXECUTE FUNCTION "assembly_request_admission_immutable"();
