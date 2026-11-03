-- R4b is additive: historical checkpoints keep their trace bytes, no row is
-- backfilled or rewritten. New executions stop accumulating NativeTrace in
-- checkpoints and record each emission durably in this append-only journal.
-- An observation grants no authority, settles no effect, proves no
-- consumption and permits no continuation.
CREATE TABLE "ExecutionNativeObservation" (
  "projectId" TEXT NOT NULL,
  "systemId" TEXT NOT NULL,
  "executionSpaceId" TEXT NOT NULL,
  "operatorId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "checkpointNamespace" TEXT NOT NULL,
  "producerPhase" TEXT NOT NULL,
  "occurrenceId" TEXT NOT NULL,
  "emissionStep" BIGINT NOT NULL,
  "eventOrdinal" INTEGER NOT NULL,
  "batchCount" INTEGER NOT NULL,
  "batchDigest" TEXT NOT NULL,
  "contributionId" TEXT NOT NULL,
  "identityJson" TEXT NOT NULL,
  "pinJson" TEXT NOT NULL,
  "payloadJson" TEXT NOT NULL,
  "epoch" BIGINT NOT NULL,
  "jobId" TEXT NOT NULL,
  "retryCount" INTEGER NOT NULL,
  "firstRecordedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ExecutionNativeObservation_pkey" PRIMARY KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId", "checkpointNamespace", "producerPhase", "occurrenceId", "emissionStep", "eventOrdinal"),
  CONSTRAINT "ExecutionNativeObservation_run_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId") REFERENCES "ExecutionRun" ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ExecutionNativeObservation_contribution_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "contributionId") REFERENCES "ExecutionContribution" ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "contributionId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ExecutionNativeObservation_phase_check" CHECK ("producerPhase" IN ('preparation', 'immutable-group-join', 'node-commit')),
  CONSTRAINT "ExecutionNativeObservation_shape_check" CHECK (
    length(btrim("occurrenceId")) > 0 AND
    length(btrim("contributionId")) > 0 AND
    "emissionStep" > 0 AND
    "eventOrdinal" >= 0 AND
    "batchCount" > 0 AND
    "eventOrdinal" < "batchCount" AND
    "batchDigest" ~ '^[0-9a-f]{64}$' AND
    "epoch" >= 0 AND
    "retryCount" >= 0 AND
    jsonb_typeof("identityJson"::jsonb) = 'object' AND
    jsonb_typeof("pinJson"::jsonb) = 'object' AND
    jsonb_typeof("payloadJson"::jsonb) = 'object'
  )
);

CREATE INDEX "ExecutionNativeObservation_run_step_idx" ON "ExecutionNativeObservation" ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId", "emissionStep");

-- Exact replay uses INSERT ... ON CONFLICT DO NOTHING followed by exact
-- payload/pin/owner/batch comparison. Even a no-op UPDATE is forbidden:
-- first-writer content, provenance and firstRecordedAt stay immutable.
CREATE FUNCTION assembly_preserve_execution_native_observation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Assembly execution native observations are immutable' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER "ExecutionNativeObservation_preserve_observation" BEFORE UPDATE OR DELETE ON "ExecutionNativeObservation"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_execution_native_observation();
