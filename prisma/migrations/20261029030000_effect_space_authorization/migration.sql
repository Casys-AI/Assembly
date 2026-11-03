-- Existing receipts remain unproven (NULL), never reconstructed or reauthorized.
ALTER TABLE "ExecutionEffect" ADD COLUMN "authorizationJson" TEXT;
ALTER TABLE "ExecutionEffect" ADD CONSTRAINT "ExecutionEffect_authorization_check"
CHECK ("authorizationJson" IS NULL OR (
  octet_length("authorizationJson") BETWEEN 2 AND 32768
  AND jsonb_typeof("authorizationJson"::jsonb) = 'object'
));

-- Extend the existing receipt guard, preserving every earlier identity/status rule.
CREATE OR REPLACE FUNCTION assembly_preserve_execution_effect() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."projectId", NEW."systemId", NEW."executionSpaceId", NEW."operatorId", NEW."threadId", NEW."effectKey", NEW."runId", NEW."contributionId", NEW."nodeId", NEW."requestDigest", NEW."epoch", NEW."jobId", NEW."retryCount", NEW."startedAt", NEW."authorizationJson")
    IS DISTINCT FROM
    ROW(OLD."projectId", OLD."systemId", OLD."executionSpaceId", OLD."operatorId", OLD."threadId", OLD."effectKey", OLD."runId", OLD."contributionId", OLD."nodeId", OLD."requestDigest", OLD."epoch", OLD."jobId", OLD."retryCount", OLD."startedAt", OLD."authorizationJson") THEN
    RAISE EXCEPTION 'Assembly execution effect identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('completed', 'unknown') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Assembly settled or unknown effect cannot be rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
