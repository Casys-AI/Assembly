-- Cross-thread admission lineage; existing continuation receipts remain unchanged.
CREATE TABLE "InitialAdmissionTransferReceipt" (
  "projectId" TEXT NOT NULL,
  "systemId" TEXT NOT NULL,
  "executionSpaceId" TEXT NOT NULL,
  "operatorId" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "sourceThreadId" TEXT NOT NULL,
  "sourceRunId" TEXT NOT NULL,
  "sourceCheckpointNamespace" TEXT NOT NULL,
  "sourceCheckpointId" TEXT NOT NULL,
  "targetThreadId" TEXT NOT NULL,
  "targetRunId" TEXT NOT NULL,
  "targetCheckpointNamespace" TEXT NOT NULL,
  "targetCheckpointId" TEXT,
  "intentDigest" TEXT NOT NULL,
  "intentJson" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "selectedAt" TIMESTAMPTZ(3),
  CONSTRAINT "InitialAdmissionTransferReceipt_pkey" PRIMARY KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "id"),
  CONSTRAINT "InitialAdmissionTransfer_source_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "sourceThreadId", "sourceRunId") REFERENCES "ExecutionRun" ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InitialAdmissionTransfer_target_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "targetThreadId", "targetRunId") REFERENCES "ExecutionRun" ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InitialAdmissionTransfer_distinct_threads_check" CHECK ("sourceThreadId" <> "targetThreadId"),
  CONSTRAINT "InitialAdmissionTransfer_digest_check" CHECK ("intentDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "InitialAdmissionTransfer_phase_check" CHECK (("status" = 'intent' AND "targetCheckpointId" IS NULL AND "selectedAt" IS NULL) OR ("status" = 'forked' AND "targetCheckpointId" IS NOT NULL AND "selectedAt" IS NULL) OR ("status" = 'selected' AND "targetCheckpointId" IS NOT NULL AND "selectedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "InitialAdmissionTransfer_source_key" ON "InitialAdmissionTransferReceipt" ("projectId", "systemId", "executionSpaceId", "operatorId", "sourceThreadId", "sourceRunId");
CREATE UNIQUE INDEX "InitialAdmissionTransfer_target_key" ON "InitialAdmissionTransferReceipt" ("projectId", "systemId", "executionSpaceId", "operatorId", "targetThreadId", "targetRunId");
