-- Member adoption: a member advances only its own admitted pin under an exact
-- same-transaction adoption proof; the BO path below is unchanged.
-- 4.8e: a Request space admits its Branch Operator and up to three verified
-- sub-operators. The admission pin may now carry that team: a team adoption
-- (its proof names the whole verified candidate team) adds exactly one member;
-- every other adoption, human, delegated or software, keeps each member and
-- its digest. Members are never removed. All other guards are unchanged.
BEGIN;

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
  -- A member's source pin is independent of the BO's shared admission source.
  -- Keep the established BO/human/software branch below byte-for-byte intact.
  IF prior_permissions->>'sourceVersion' = next_permissions->>'sourceVersion' THEN
    IF (jsonb_typeof(prior_permissions)='object' AND jsonb_typeof(next_permissions)='object' AND
      prior_permissions ?& ARRAY['operatorIds','acts','sourceVersion','modelDigests','resourceIds'] AND
      next_permissions ?& ARRAY['operatorIds','acts','sourceVersion','modelDigests','resourceIds'] AND
      prior_permissions-ARRAY['operatorIds','acts','sourceVersion','modelDigests','resourceIds']='{}'::jsonb AND
      next_permissions-ARRAY['operatorIds','acts','sourceVersion','modelDigests','resourceIds']='{}'::jsonb AND
      prior_permissions-ARRAY['operatorIds','modelDigests'] = next_permissions-ARRAY['operatorIds','modelDigests'] AND
      jsonb_typeof(prior_permissions->'operatorIds')='array' AND jsonb_typeof(next_permissions->'operatorIds')='array' AND
      jsonb_typeof(prior_permissions->'modelDigests')='array' AND jsonb_typeof(next_permissions->'modelDigests')='array' AND
      jsonb_array_length(prior_permissions->'operatorIds') BETWEEN 2 AND 4 AND
      jsonb_array_length(next_permissions->'operatorIds') BETWEEN 2 AND 4 AND
      jsonb_array_length(prior_permissions->'modelDigests')=jsonb_array_length(prior_permissions->'operatorIds') AND
      jsonb_array_length(next_permissions->'modelDigests')=jsonb_array_length(next_permissions->'operatorIds') AND
      prior_permissions->'acts'='["conversation"]'::jsonb AND
      prior_permissions->>'sourceVersion' ~ '^commit:[a-f0-9]{40}$' AND
      jsonb_typeof(prior_permissions->'resourceIds')='array' AND jsonb_array_length(prior_permissions->'resourceIds')<=256 AND
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(prior_permissions->'resourceIds') x(value)
        WHERE jsonb_typeof(value)<>'string' OR value#>>'{}' !~ '^retained-tool:v1:[0-9a-f]{64}$') AND
      (SELECT count(*)=count(DISTINCT value) FROM jsonb_array_elements(prior_permissions->'resourceIds') x(value)) AND
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(prior_permissions->'operatorIds') x(value)
        WHERE jsonb_typeof(value)<>'string' OR value#>>'{}' IN ('','*')) AND
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(next_permissions->'operatorIds') x(value)
        WHERE jsonb_typeof(value)<>'string' OR value#>>'{}' IN ('','*')) AND
      (SELECT count(*)=count(DISTINCT value) FROM jsonb_array_elements(prior_permissions->'operatorIds') x(value)) AND
      (SELECT count(*)=count(DISTINCT value) FROM jsonb_array_elements(next_permissions->'operatorIds') x(value)) AND
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(prior_permissions->'modelDigests') x(value)
        WHERE jsonb_typeof(value)<>'string' OR value#>>'{}' !~ '^[a-f0-9]{64}$') AND
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(next_permissions->'modelDigests') x(value)
        WHERE jsonb_typeof(value)<>'string' OR value#>>'{}' !~ '^[a-f0-9]{64}$')) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'Invalid member admission pin envelope';
    END IF;
    WITH candidates AS MATERIALIZED (
      SELECT m."revision", m."payload"::jsonb AS proof
      FROM "SpaceManifest" m
      WHERE m."projectId"=OLD."projectId" AND m."systemId"=OLD."systemId" AND
        m."executionSpaceId"=OLD."executionSpaceId" AND m."kind"='runtime-adoption' AND
        m.xmin=pg_current_xact_id()::xid AND
        m."digest"=encode(sha256(convert_to(m."payload", 'UTF8')), 'hex')
    )
    SELECT count(*) INTO proof_count
    FROM candidates m
    JOIN "SpaceOpening" o ON o."projectId"=OLD."projectId" AND o."systemId"=OLD."systemId" AND
      o."id"=OLD."openingId" AND o."executionSpaceId"=OLD."executionSpaceId" AND o."ownerId"=OLD."ownerId" AND
      o."admissionId"=OLD."id" AND o."baseDigest"=OLD."baseDigest" AND o."phase"='dispatched'
    JOIN "ExecutionSpace" e ON e."projectId"=o."projectId" AND e."systemId"=o."systemId" AND
      e."executionSpaceId"=o."executionSpaceId" AND e."caseId"=o."caseId" AND e."parentExecutionSpaceId"='main' AND
      e."lifecycle"='active' AND e."closedAt" IS NULL
    JOIN LATERAL jsonb_array_elements_text(prior_permissions->'operatorIds') WITH ORDINALITY AS target(operator_id, n)
      ON target.n>1 AND target.operator_id=m.proof#>>'{intent,target,operatorId}'
    JOIN "EvolutionDossier" d ON d."projectId"=o."projectId" AND d."systemId"=o."systemId" AND
      d."id"=m.proof->>'commandId' AND d."repositoryId"=m.proof#>>'{intent,target,repositoryId}' AND
      d."kind"='request-owner-adoption-v2' AND d."executionSpaceId"=o."executionSpaceId" AND
      d."targetScopeKey"='request:'||o."executionSpaceId" AND d."status"='armed'
    JOIN "EvolutionTargetBarrier" b ON b."projectId"=d."projectId" AND b."systemId"=d."systemId" AND
      b."repositoryId"=d."repositoryId" AND b."targetScopeKey"=d."targetScopeKey" AND
      b."executionSpaceId"=d."executionSpaceId" AND b."dossierId"=d."id" AND b."operatorId"=target.operator_id
    JOIN "SpaceManifest" source ON source."projectId"=o."projectId" AND source."systemId"=o."systemId" AND
      source."executionSpaceId"=o."executionSpaceId" AND source."kind"='source-admission' AND
      source."revision"=(m.proof#>>'{sourceHead,revision}')::bigint AND
      source."digest"=m.proof#>>'{sourceHead,manifestDigest}' AND
      source."digest"=encode(sha256(convert_to(source."payload", 'UTF8')), 'hex')
    JOIN "SpaceManifest" predecessor ON predecessor."projectId"=o."projectId" AND predecessor."systemId"=o."systemId" AND
      predecessor."executionSpaceId"=o."executionSpaceId" AND predecessor."revision"=(m.proof#>>'{predecessor,revision}')::bigint AND
      predecessor."digest"=m.proof#>>'{predecessor,digest}' AND source."revision"<=predecessor."revision"
    -- The target pin is the most recent verified member adoption, or the
    -- team adoption that first admitted it. Runtime payloads may be compressed.
    JOIN LATERAL (
      SELECT previous."payload"::jsonb AS proof, previous."revision", previous."digest"
      FROM "SpaceManifest" previous
      WHERE previous."projectId"=o."projectId" AND previous."systemId"=o."systemId" AND
        previous."executionSpaceId"=o."executionSpaceId" AND previous."kind"='runtime-adoption' AND
        previous."revision" < m."revision" AND
        previous."digest"=encode(sha256(convert_to(previous."payload", 'UTF8')), 'hex') AND
        previous."payload"::jsonb->>'format'='request-runtime-adoption/v2' AND
        (previous."payload"::jsonb#>>'{intent,target,operatorId}'=target.operator_id OR
          (NOT (previous."payload"::jsonb#>'{intent,previous,admission,permissions,operatorIds}' @> jsonb_build_array(target.operator_id)) AND
           EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(previous."payload"::jsonb#>'{intent,team,team}', '[]'::jsonb)) child
             WHERE child->>'operatorId'=target.operator_id)))
      ORDER BY previous."revision" DESC LIMIT 1
    ) member_pin ON TRUE
    JOIN "RuntimeState" r ON r."projectId"=o."projectId" AND r."systemId"=o."systemId" AND
      r."executionSpaceId"=o."executionSpaceId" AND r."operatorId"=b."operatorId" AND
      r."revision"=(m.proof->>'committedRuntimeRevision')::bigint AND r.xmin=pg_current_xact_id()::xid
    JOIN "RuntimeRevision" prior ON prior."projectId"=r."projectId" AND prior."systemId"=r."systemId" AND
      prior."executionSpaceId"=r."executionSpaceId" AND prior."operatorId"=r."operatorId" AND
      prior."revision"=(m.proof->>'previousRuntimeRevision')::bigint
    JOIN "RuntimeRevision" authorized ON authorized."projectId"=r."projectId" AND authorized."systemId"=r."systemId" AND
      authorized."executionSpaceId"=r."executionSpaceId" AND authorized."operatorId"=r."operatorId" AND
      authorized."revision"=(m.proof->>'authorizationRuntimeRevision')::bigint AND authorized.xmin=pg_current_xact_id()::xid
    JOIN "RuntimeRevision" committed ON committed."projectId"=r."projectId" AND committed."systemId"=r."systemId" AND
      committed."executionSpaceId"=r."executionSpaceId" AND committed."operatorId"=r."operatorId" AND
      committed."revision"=r."revision" AND committed."payload"=r."payload" AND committed.xmin=pg_current_xact_id()::xid AND
      committed."runtimeStateId"=authorized."runtimeStateId" AND prior."runtimeStateId"=authorized."runtimeStateId" AND
      committed."runtimeStateId"='request:'||o."executionSpaceId"||':'||b."operatorId"
    WHERE (m.proof->>'format'='request-runtime-adoption/v2' AND
      d."payload"::jsonb->'intent'=m.proof->'intent' AND
      m.proof#>>'{intent,decision,kind}' IN ('request-delegated-adoption-decision','request-creation-grant-adoption-decision') AND
      m.proof#>>'{completion,kind}'=m.proof#>>'{intent,decision,kind}' AND
      m.proof#>>'{intent,target,openingId}'=o."id" AND m.proof#>>'{intent,target,caseId}'=o."caseId" AND
      m.proof#>>'{intent,target,branchId}'=o."branchId" AND m.proof#>>'{intent,target,operatorId}'=b."operatorId" AND
      o."baseJson"::jsonb#>>'{requestOwner,operatorId}'=prior_permissions#>>'{operatorIds,0}' AND
      o."baseJson"::jsonb#>>'{manifest,source,repositoryId}'=d."repositoryId" AND
      m.proof#>>'{intent,openingBaseDigest}'=OLD."baseDigest" AND
      m.proof#>>'{intent,previous,admission,id}'=OLD."id" AND
      m.proof#>>'{intent,previous,admission,scope,projectId}'=OLD."projectId" AND
      m.proof#>>'{intent,previous,admission,scope,systemId}'=OLD."systemId" AND
      m.proof#>>'{intent,previous,admission,executionSpaceId}'=OLD."executionSpaceId" AND
      m.proof#>>'{intent,previous,admission,openingId}'=OLD."openingId" AND
      m.proof#>>'{intent,previous,admission,ownerId}'=OLD."ownerId" AND
      m.proof#>>'{intent,previous,admission,baseDigest}'=OLD."baseDigest" AND
      m.proof#>>'{intent,previous,admission,status}'=OLD."status" AND
      (m.proof#>>'{intent,previous,admission,revision}')::integer=OLD."revision" AND
      m.proof#>>'{intent,previous,admission,capabilityId}'=OLD."capabilityId" AND
      (m.proof#>>'{intent,previous,admission,capabilityRevision}')::integer=OLD."capabilityRevision" AND
      (m.proof#>>'{intent,previous,admission,expiresAt}')::timestamptz=OLD."expiresAt" AND
      (m.proof#>>'{intent,previous,admission,createdAt}')::timestamptz=OLD."createdAt" AND
      m.proof#>'{intent,previous,admission,authority}'=OLD."authorityJson"::jsonb AND
      m.proof#>'{intent,previous,admission,permissions}'=prior_permissions AND
      m.proof#>>'{intent,previous,pin,modelDigest}'=prior_permissions#>>ARRAY['modelDigests',(target.n-1)::text] AND
      m.proof#>'{intent,previous,pin,source}'=member_pin.proof#>'{intent,candidate,source}' AND
      m.proof#>'{intent,previous,pin,sourceAdmission}'=member_pin.proof#>'{intent,candidate,sourceAdmission}' AND
      (CASE WHEN member_pin.proof#>>'{intent,target,operatorId}'=target.operator_id THEN
        EXISTS (SELECT 1 FROM "EvolutionDossier" old_dossier
          WHERE old_dossier."projectId"=o."projectId" AND old_dossier."systemId"=o."systemId" AND
            old_dossier."id"=member_pin.proof->>'commandId' AND old_dossier."kind"='request-owner-adoption-v2' AND
            old_dossier."executionSpaceId"=o."executionSpaceId" AND old_dossier."status"='adopted' AND
            old_dossier."payload"::jsonb#>>'{receipt,commandId}'=member_pin.proof->>'commandId' AND
            (old_dossier."payload"::jsonb#>>'{receipt,journalRevision}')::bigint=member_pin."revision" AND
            old_dossier."payload"::jsonb#>>'{receipt,journalDigest}'=member_pin."digest" AND
            m.proof#>>'{intent,previous,pin,adoption,commandId}'=member_pin.proof->>'commandId' AND
            m.proof#>>'{intent,previous,pin,adoption,receiptDigest}'=old_dossier."payload"::jsonb#>>'{receipt,receiptDigest}' AND
            (m.proof#>>'{intent,previous,pin,adoption,committedRuntimeRevision}')::bigint=(member_pin.proof->>'committedRuntimeRevision')::bigint)
      ELSE m.proof#>'{intent,previous,pin,adoption}'='null'::jsonb END) AND
      m.proof#>>'{intent,previous,pin,modelDigest}'=CASE
        WHEN member_pin.proof#>>'{intent,target,operatorId}'=target.operator_id
          THEN member_pin.proof#>>'{intent,candidate,model,version,digest}'
        ELSE (SELECT child->>'modelDigest' FROM jsonb_array_elements(member_pin.proof#>'{intent,team,team}') child
          WHERE child->>'operatorId'=target.operator_id)
        END AND
      (m.proof->>'admissionRevision')::integer=NEW."revision" AND
      m.proof#>>'{intent,candidate,model,identity,builderId}'=target.operator_id AND
      m.proof#>>'{intent,candidate,model,version,digest}'=next_permissions#>>ARRAY['modelDigests',(target.n-1)::text] AND
      prior_permissions#>>ARRAY['modelDigests',(target.n-1)::text] <> next_permissions#>>ARRAY['modelDigests',(target.n-1)::text] AND
      m.proof#>'{sourceHead}'=m.proof#>'{intent,candidate,sourceAdmission}' AND
      source."payload"::jsonb->>'format'='request-source-admission/v1' AND
      source."payload"::jsonb#>'{result,source}'=m.proof#>'{intent,candidate,source}' AND
      source."payload"::jsonb#>>'{result,model,digest}'=m.proof#>>'{intent,candidate,model,version,digest}' AND
      source."payload"::jsonb#>'{result,model,identity}'=m.proof#>'{intent,candidate,model,identity}' AND
      source."payload"::jsonb#>>'{authority,requester,operatorId}'=target.operator_id AND
      source."payload"::jsonb#>>'{authority,requester,executionSpaceId}'=o."executionSpaceId" AND
      source."payload"::jsonb->>'authorityDigest'=m.proof#>>'{intent,decision,authorityDigest}' AND
      ((m.proof#>>'{intent,decision,kind}'='request-delegated-adoption-decision' AND
        source."payload"::jsonb#>>'{authority,kind}'='request-delegated-authority') OR
       (m.proof#>>'{intent,decision,kind}'='request-creation-grant-adoption-decision' AND
        source."payload"::jsonb#>>'{authority,kind}'='request-creation-grant')) AND
      (m.proof->>'authorizationRuntimeRevision')::bigint=(m.proof->>'previousRuntimeRevision')::bigint+1 AND
      (m.proof->>'committedRuntimeRevision')::bigint=(m.proof->>'authorizationRuntimeRevision')::bigint+1 AND
      m."revision"=(m.proof#>>'{predecessor,revision}')::bigint+1 AND
      prior."modelPayload"::jsonb=m.proof#>'{intent,previous,identity}' AND
      authorized."modelPayload"::jsonb=m.proof#>'{intent,previous,identity}' AND
      committed."modelPayload"::jsonb=m.proof#>'{intent,candidate,model,identity}' AND
      -- Every old member retains its position; only the target digest changes.
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(prior_permissions->'operatorIds') WITH ORDINALITY x(value,n)
        WHERE next_permissions->'operatorIds'->((x.n-1)::integer) IS DISTINCT FROM x.value OR
          (x.n<>target.n AND next_permissions->'modelDigests'->((x.n-1)::integer) IS DISTINCT FROM prior_permissions->'modelDigests'->((x.n-1)::integer))) AND
      (CASE WHEN m.proof#>'{intent,team}' IS NULL THEN
        next_permissions->'operatorIds'=prior_permissions->'operatorIds'
      ELSE
        m.proof#>>'{intent,team,kind}'='request-team-creation-adoption/v1' AND
        jsonb_typeof(m.proof#>'{intent,team,team}')='array' AND
        jsonb_array_length(next_permissions->'operatorIds')=jsonb_array_length(prior_permissions->'operatorIds')+1 AND
        next_permissions->'operatorIds'=jsonb_build_array(prior_permissions#>>'{operatorIds,0}') ||
          COALESCE((SELECT jsonb_agg(member->'operatorId' ORDER BY ordinality)
            FROM jsonb_array_elements(m.proof#>'{intent,team,team}') WITH ORDINALITY t(member,ordinality)), '[]'::jsonb) AND
        (next_permissions->'modelDigests')-0=
          COALESCE((SELECT jsonb_agg(member->'modelDigest' ORDER BY ordinality)
            FROM jsonb_array_elements(m.proof#>'{intent,team,team}') WITH ORDINALITY t(member,ordinality)), '[]'::jsonb)
      END)) IS TRUE;
    IF proof_count <> 1 THEN
      RAISE EXCEPTION 'Member pin advance requires its exact current-transaction adoption proof';
    END IF;
    RETURN NEW;
  ELSE
  IF (jsonb_typeof(prior_permissions) = 'object' AND jsonb_typeof(next_permissions) = 'object' AND
      prior_permissions ?& ARRAY['operatorIds','acts','sourceVersion','modelDigests','resourceIds'] AND
      next_permissions ?& ARRAY['operatorIds','acts','sourceVersion','modelDigests','resourceIds'] AND
      prior_permissions-ARRAY['operatorIds','acts','sourceVersion','modelDigests','resourceIds'] = '{}'::jsonb AND
      next_permissions-ARRAY['operatorIds','acts','sourceVersion','modelDigests','resourceIds'] = '{}'::jsonb AND
      prior_permissions-ARRAY['operatorIds','sourceVersion','modelDigests'] = next_permissions-ARRAY['operatorIds','sourceVersion','modelDigests'] AND
      -- 4.8e: the BO first, then at most three verified members, each with
      -- its own digest. Members are never removed; a team adoption adds one.
      jsonb_typeof(prior_permissions->'operatorIds') = 'array' AND
      jsonb_typeof(next_permissions->'operatorIds') = 'array' AND
      jsonb_array_length(prior_permissions->'operatorIds') BETWEEN 1 AND 4 AND
      jsonb_array_length(next_permissions->'operatorIds') IN (
        jsonb_array_length(prior_permissions->'operatorIds'),
        jsonb_array_length(prior_permissions->'operatorIds') + 1) AND
      jsonb_array_length(next_permissions->'operatorIds') <= 4 AND
      jsonb_typeof(prior_permissions#>'{operatorIds,0}') = 'string' AND prior_permissions#>>'{operatorIds,0}' NOT IN ('','*') AND
      next_permissions#>'{operatorIds,0}' = prior_permissions#>'{operatorIds,0}' AND
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(next_permissions->'operatorIds') AS operator(value)
        WHERE jsonb_typeof(value) <> 'string' OR value #>> '{}' IN ('','*')) AND
      (SELECT count(*) = count(DISTINCT value) FROM jsonb_array_elements(next_permissions->'operatorIds') AS operator(value)) AND
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(prior_permissions->'operatorIds') AS operator(value)
        WHERE NOT next_permissions->'operatorIds' @> jsonb_build_array(value)) AND
      jsonb_typeof(prior_permissions->'modelDigests') = 'array' AND
      jsonb_typeof(next_permissions->'modelDigests') = 'array' AND
      jsonb_array_length(prior_permissions->'modelDigests') = jsonb_array_length(prior_permissions->'operatorIds') AND
      jsonb_array_length(next_permissions->'modelDigests') = jsonb_array_length(next_permissions->'operatorIds') AND
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(next_permissions->'modelDigests') AS digest(value)
        WHERE jsonb_typeof(value) <> 'string' OR value #>> '{}' !~ '^[a-f0-9]{64}$') AND
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
    -- 4.8e: only a team adoption writes a new team, exactly its verified
    -- candidate team; any other adoption keeps every member and its digest.
    (CASE WHEN m.proof#>'{intent,team}' IS NULL THEN
      next_permissions->'operatorIds' = prior_permissions->'operatorIds' AND
      (next_permissions->'modelDigests') - 0 = (prior_permissions->'modelDigests') - 0
    ELSE
      jsonb_typeof(m.proof#>'{intent,team,team}') = 'array' AND
      next_permissions->'operatorIds' = jsonb_build_array(m.proof#>>'{intent,target,operatorId}') ||
        COALESCE((SELECT jsonb_agg(member->'operatorId' ORDER BY ordinality)
          FROM jsonb_array_elements(m.proof#>'{intent,team,team}') WITH ORDINALITY AS t(member, ordinality)), '[]'::jsonb) AND
      (next_permissions->'modelDigests') - 0 =
        COALESCE((SELECT jsonb_agg(member->'modelDigest' ORDER BY ordinality)
          FROM jsonb_array_elements(m.proof#>'{intent,team,team}') WITH ORDINALITY AS t(member, ordinality)), '[]'::jsonb)
    END) AND
    -- Require the actual state/history append sequence. Native
    -- and human authorization validation stays in their existing domain owners.
    (m.proof->>'authorizationRuntimeRevision')::bigint=(m.proof->>'previousRuntimeRevision')::bigint+1 AND
    (m.proof->>'committedRuntimeRevision')::bigint=(m.proof->>'authorizationRuntimeRevision')::bigint+1 AND
    m."revision"=(m.proof#>>'{predecessor,revision}')::bigint+1 AND
    authorized."modelPayload"::jsonb=m.proof#>'{intent,previous,identity}' AND
    committed."modelPayload"::jsonb=m.proof#>'{intent,candidate,model,identity}') IS TRUE;
  -- A separate software proof; never decode a human authority as software.
  -- The existing permission envelope and retained-resource checks above apply
  -- to both branches. The source admission is an earlier immutable D2 row;
  -- the runtime manifest and both state revisions must be from this transaction.
  IF proof_count = 0 THEN
    WITH candidates AS MATERIALIZED (
      SELECT m."revision", CASE WHEN m."kind"='runtime-adoption' AND
        m.xmin=pg_current_xact_id()::xid AND
        m."digest"=encode(sha256(convert_to(m."payload", 'UTF8')), 'hex')
        THEN m."payload"::jsonb ELSE NULL END AS proof
      FROM "SpaceManifest" m
      WHERE m."projectId"=OLD."projectId" AND m."systemId"=OLD."systemId" AND
        m."executionSpaceId"=OLD."executionSpaceId" AND m."kind"='runtime-adoption' AND
        m.xmin=pg_current_xact_id()::xid
    )
    SELECT count(*) INTO proof_count
    FROM candidates m
    JOIN "SpaceOpening" o ON o."projectId"=OLD."projectId" AND o."systemId"=OLD."systemId" AND
      o."id"=OLD."openingId" AND o."executionSpaceId"=OLD."executionSpaceId" AND
      o."ownerId"=OLD."ownerId" AND o."admissionId"=OLD."id" AND o."baseDigest"=OLD."baseDigest" AND o."phase"='dispatched'
    JOIN "ExecutionSpace" e ON e."projectId"=o."projectId" AND e."systemId"=o."systemId" AND
      e."executionSpaceId"=o."executionSpaceId" AND e."caseId"=o."caseId" AND e."parentExecutionSpaceId"='main' AND
      e."lifecycle"='active' AND e."closedAt" IS NULL
    JOIN "EvolutionDossier" d ON d."projectId"=o."projectId" AND d."systemId"=o."systemId" AND
      d."id"=m.proof->>'dossierId' AND d."kind"='software-evolution-scoped-v2' AND
      d."executionSpaceId"=o."executionSpaceId" AND d."targetScopeKey"='request:'||o."executionSpaceId" AND
      d."status"='published-awaiting-adoption'
    JOIN "EvolutionTargetBarrier" b ON b."projectId"=d."projectId" AND b."systemId"=d."systemId" AND
      b."repositoryId"=d."repositoryId" AND b."targetScopeKey"=d."targetScopeKey" AND
      b."executionSpaceId"=d."executionSpaceId" AND b."dossierId"=d."id" AND
      b."operatorId"=prior_permissions#>>'{operatorIds,0}'
    JOIN "SpaceManifest" source ON source."projectId"=o."projectId" AND source."systemId"=o."systemId" AND
      source."executionSpaceId"=o."executionSpaceId" AND source."kind"='source-admission' AND
      source."revision"=(m.proof#>>'{sourceAdmission,revision}')::bigint AND
      source."digest"=m.proof#>>'{sourceAdmission,manifestDigest}' AND
      source."digest"=encode(sha256(convert_to(source."payload", 'UTF8')), 'hex')
    JOIN "SpaceManifest" predecessor ON predecessor."projectId"=o."projectId" AND predecessor."systemId"=o."systemId" AND
      predecessor."executionSpaceId"=o."executionSpaceId" AND
      predecessor."revision"=(m.proof#>>'{predecessor,revision}')::bigint AND
      predecessor."digest"=m.proof#>>'{predecessor,digest}' AND source."revision"<=predecessor."revision"
    JOIN "RuntimeState" r ON r."projectId"=o."projectId" AND r."systemId"=o."systemId" AND
      r."executionSpaceId"=o."executionSpaceId" AND r."operatorId"=b."operatorId" AND
      r."revision"=(m.proof->>'committedRuntimeRevision')::bigint
    JOIN "RuntimeRevision" prior ON prior."projectId"=r."projectId" AND prior."systemId"=r."systemId" AND
      prior."executionSpaceId"=r."executionSpaceId" AND prior."operatorId"=r."operatorId" AND
      prior."revision"=(m.proof#>>'{boundary,previousRuntimeRevision}')::bigint
    JOIN "RuntimeRevision" authorized ON authorized."projectId"=r."projectId" AND authorized."systemId"=r."systemId" AND
      authorized."executionSpaceId"=r."executionSpaceId" AND authorized."operatorId"=r."operatorId" AND
      authorized."revision"=(m.proof->>'authorizationRuntimeRevision')::bigint AND authorized.xmin=pg_current_xact_id()::xid
    JOIN "RuntimeRevision" committed ON committed."projectId"=r."projectId" AND committed."systemId"=r."systemId" AND
      committed."executionSpaceId"=r."executionSpaceId" AND committed."operatorId"=r."operatorId" AND
      committed."revision"=r."revision" AND committed."payload"=r."payload" AND committed.xmin=pg_current_xact_id()::xid AND
      committed."runtimeStateId"=authorized."runtimeStateId" AND prior."runtimeStateId"=authorized."runtimeStateId" AND
      committed."runtimeStateId"='request:'||o."executionSpaceId"||':'||b."operatorId"
    WHERE (m.proof->>'format'='request-software-runtime-adoption/v2' AND
      m.proof#>>'{target,projectId}'=o."projectId" AND m.proof#>>'{target,systemId}'=o."systemId" AND
      m.proof#>>'{target,executionSpaceId}'=o."executionSpaceId" AND m.proof#>>'{target,operatorId}'=b."operatorId" AND
      m.proof->'target'=m.proof#>'{boundary,target}' AND
      m.proof#>>'{boundary,format}'='software-evolution-final-boundary/v2' AND
      m.proof#>>'{boundary,previousPin,source,version}'=prior_permissions->>'sourceVersion' AND
      m.proof#>>'{boundary,previousPin,modelDigest}'=prior_permissions#>>'{modelDigests,0}' AND
      m.proof#>>'{boundary,previousBusinessRevision,__assemblyRuntimeRevision,systemId}'=prior."runtimeStateId" AND
      m.proof#>>'{boundary,previousBusinessRevision,__assemblyRuntimeRevision,operatorId}'=b."operatorId" AND
      (m.proof#>>'{boundary,previousBusinessRevision,__assemblyRuntimeRevision,revision}')::bigint=prior."revision" AND
      m.proof#>>'{boundary,previousBusinessRevision,__assemblyRuntimeRevision,modelDigest}'=prior_permissions#>>'{modelDigests,0}' AND
      (m.proof->>'authorizationRuntimeRevision')::bigint=prior."revision"+1 AND
      (m.proof->>'committedRuntimeRevision')::bigint=prior."revision"+2 AND
      (m.proof->>'admissionRevision')::integer=NEW."revision" AND
      -- A software evolution of the BO keeps every member and its digest.
      next_permissions->'operatorIds' = prior_permissions->'operatorIds' AND
      (next_permissions->'modelDigests') - 0 = (prior_permissions->'modelDigests') - 0 AND
      m."revision"=(m.proof#>>'{predecessor,revision}')::bigint+1 AND
      d."payload"::jsonb->>'intentDigest'=m.proof->>'intentDigest' AND
      d."payload"::jsonb#>>'{proposal,digest}'=m.proof->>'proposalDigest' AND
      d."payload"::jsonb->'adoptionAuthorization'=m.proof->'adoptionAuthorization' AND
      d."payload"::jsonb#>>'{scope,openingBaseDigest}'=OLD."baseDigest" AND
      d."payload"::jsonb#>>'{scope,destination,openingId}'=o."id" AND
      d."payload"::jsonb#>>'{scope,destination,caseId}'=o."caseId" AND
      d."payload"::jsonb#>>'{scope,destination,branchId}'=o."branchId" AND
      EXISTS (SELECT 1 FROM jsonb_array_elements(d."payload"::jsonb#>'{scope,targets}') item
        WHERE item->'target'=m.proof->'target' AND item->'previousPin'=m.proof#>'{boundary,previousPin}') AND
      source."payload"::jsonb->>'format'='request-software-source-admission/v2' AND
      source."payload"::jsonb->>'evolutionDossierId'=d."id" AND
      source."payload"::jsonb->>'evolutionIntentDigest'=m.proof->>'intentDigest' AND
      source."payload"::jsonb->>'proposalDigest'=m.proof->>'proposalDigest' AND
      source."payload"::jsonb#>>'{result,source,repositoryId}'=d."repositoryId" AND
      source."payload"::jsonb#>>'{result,source,version}'=next_permissions->>'sourceVersion' AND
      EXISTS (SELECT 1 FROM jsonb_array_elements(source."payload"::jsonb#>'{result,targets}') item
        WHERE item->>'operatorId'=b."operatorId" AND item->>'digest'=next_permissions#>>'{modelDigests,0}' AND
        item->'identity'=committed."modelPayload"::jsonb) AND
      prior."modelPayload"=authorized."modelPayload" AND
      authorized."modelPayload"=committed."modelPayload") IS TRUE;
  END IF;
  IF proof_count <> 1 THEN
    RAISE EXCEPTION 'Admission pin advance requires its exact current-transaction runtime adoption proof';
  END IF;
  RETURN NEW;
  END IF;
END $$;

COMMIT;
