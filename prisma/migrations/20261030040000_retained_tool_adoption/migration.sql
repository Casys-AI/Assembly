-- Preserve all admission pin and proof guards; permit only bounded, unchanged retained resources.
CREATE OR REPLACE FUNCTION "assembly_request_admission_immutable"() RETURNS trigger LANGUAGE plpgsql
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
      prior_permissions->'acts' = '["conversation"]'::jsonb AND
      jsonb_typeof(prior_permissions->'resourceIds') = 'array' AND
      jsonb_array_length(prior_permissions->'resourceIds') <= 256 AND
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(prior_permissions->'resourceIds') AS resource(value)
        WHERE jsonb_typeof(value) <> 'string' OR value #>> '{}' !~ '^retained-tool:v1:[0-9a-f]{64}$') AND
      (SELECT count(*) = count(DISTINCT value) FROM jsonb_array_elements(prior_permissions->'resourceIds') AS resource(value)) AND
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
