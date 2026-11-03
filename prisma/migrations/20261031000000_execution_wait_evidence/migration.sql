-- R4a is additive: existing runs, checkpoints, snapshots, effects and journals
-- retain their exact bytes. Only companion protocol rows classify old runs.
CREATE TABLE "ExecutionWaitProtocol" (
  "projectId" TEXT NOT NULL,
  "systemId" TEXT NOT NULL,
  "executionSpaceId" TEXT NOT NULL,
  "operatorId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "protocol" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ExecutionWaitProtocol_pkey" PRIMARY KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId"),
  CONSTRAINT "ExecutionWaitProtocol_run_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId") REFERENCES "ExecutionRun" ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ExecutionWaitProtocol_protocol_check" CHECK ("protocol" IN ('legacy-checkpoint-v0', 'typed-wait-v1'))
);

INSERT INTO "ExecutionWaitProtocol" ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId", "protocol", "createdAt")
SELECT "projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId", 'legacy-checkpoint-v0', clock_timestamp()
FROM "ExecutionRun";

CREATE TABLE "ExecutionWaitReceipt" (
  "projectId" TEXT NOT NULL,
  "systemId" TEXT NOT NULL,
  "executionSpaceId" TEXT NOT NULL,
  "operatorId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "checkpointNamespace" TEXT NOT NULL,
  "checkpointId" TEXT NOT NULL,
  "waitJson" TEXT NOT NULL,
  "pinJson" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ExecutionWaitReceipt_pkey" PRIMARY KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId", "checkpointNamespace", "checkpointId"),
  CONSTRAINT "ExecutionWaitReceipt_run_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId") REFERENCES "ExecutionRun" ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ExecutionWaitReceipt_protocol_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId") REFERENCES "ExecutionWaitProtocol" ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ExecutionWaitReceipt_shape_check" CHECK (length(btrim("checkpointId")) > 0 AND jsonb_typeof("waitJson"::jsonb) = 'object' AND jsonb_typeof("pinJson"::jsonb) = 'object'),
  CONSTRAINT "ExecutionWaitReceipt_origin_check" CHECK ("origin" IN ('interrupt-v1', 'legacy-import-v0', 'fork-v1'))
);

CREATE TABLE "ExecutionWaitConsumption" (
  "projectId" TEXT NOT NULL,
  "systemId" TEXT NOT NULL,
  "executionSpaceId" TEXT NOT NULL,
  "operatorId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "contributionId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "sourceRunId" TEXT,
  "sourceCheckpointNamespace" TEXT,
  "sourceCheckpointId" TEXT,
  "successorCheckpointNamespace" TEXT NOT NULL,
  "successorCheckpointId" TEXT NOT NULL,
  "consumptionJson" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ExecutionWaitConsumption_pkey" PRIMARY KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId", "contributionId"),
  CONSTRAINT "ExecutionWaitConsumption_run_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId") REFERENCES "ExecutionRun" ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ExecutionWaitConsumption_contribution_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "contributionId") REFERENCES "ExecutionContribution" ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "contributionId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ExecutionWaitConsumption_source_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "sourceRunId", "sourceCheckpointNamespace", "sourceCheckpointId") REFERENCES "ExecutionWaitReceipt" ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId", "checkpointNamespace", "checkpointId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ExecutionWaitConsumption_shape_check" CHECK (length(btrim("contributionId")) > 0 AND length(btrim("successorCheckpointId")) > 0 AND jsonb_typeof("consumptionJson"::jsonb) = 'object'),
  CONSTRAINT "ExecutionWaitConsumption_kind_check" CHECK (
    ("kind" = 'input-v1' AND "sourceRunId" IS NULL AND "sourceCheckpointNamespace" IS NULL AND "sourceCheckpointId" IS NULL) OR
    ("kind" IN ('wait-v1', 'legacy-import-v0') AND "sourceRunId" IS NOT NULL AND "sourceCheckpointNamespace" IS NOT NULL AND "sourceCheckpointId" IS NOT NULL AND length(btrim("sourceRunId")) > 0 AND length(btrim("sourceCheckpointId")) > 0)
  )
);

CREATE UNIQUE INDEX "ExecutionWaitConsumption_source_key" ON "ExecutionWaitConsumption" ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "sourceRunId", "sourceCheckpointNamespace", "sourceCheckpointId");

-- Identical replay uses INSERT ... ON CONFLICT DO NOTHING followed by exact
-- payload comparison. Even a no-op UPDATE is forbidden for these proof rows.
CREATE FUNCTION assembly_preserve_execution_wait_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Assembly execution wait evidence is immutable' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER "ExecutionWaitProtocol_preserve_evidence" BEFORE UPDATE OR DELETE ON "ExecutionWaitProtocol"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_execution_wait_evidence();
CREATE TRIGGER "ExecutionWaitReceipt_preserve_evidence" BEFORE UPDATE OR DELETE ON "ExecutionWaitReceipt"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_execution_wait_evidence();
CREATE TRIGGER "ExecutionWaitConsumption_preserve_evidence" BEFORE UPDATE OR DELETE ON "ExecutionWaitConsumption"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_execution_wait_evidence();
