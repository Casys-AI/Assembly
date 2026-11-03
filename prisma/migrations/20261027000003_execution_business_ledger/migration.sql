-- CreateTable
CREATE TABLE "OperatorExecution" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "identityJson" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "rootRequestId" TEXT,
    "ownerId" TEXT,
    "purpose" TEXT NOT NULL,
    "subjectId" TEXT,
    "revision" BIGINT NOT NULL DEFAULT 0,
    "epoch" BIGINT NOT NULL DEFAULT 0,
    "currentRunId" TEXT,
    "currentJobId" TEXT,
    "currentRetry" INTEGER,
    "status" TEXT NOT NULL,
    "checkpointNamespace" TEXT NOT NULL,
    "currentCheckpointId" TEXT,
    "retiredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OperatorExecution_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","threadId")
);

-- CreateTable
CREATE TABLE "ExecutionRun" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "parentRunId" TEXT,
    "generation" BIGINT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "pinJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "checkpointNamespace" TEXT NOT NULL,
    "checkpointId" TEXT,
    "snapshotJson" TEXT,
    "epoch" BIGINT NOT NULL,
    "jobId" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL,
    "errorJson" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ExecutionRun_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","threadId","runId")
);

-- CreateTable
CREATE TABLE "ExecutionContribution" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "requestDigest" TEXT,
    "kind" TEXT NOT NULL,
    "originJson" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "jobId" TEXT,
    "runId" TEXT,
    "status" TEXT NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ExecutionContribution_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","threadId","contributionId")
);

-- CreateTable
CREATE TABLE "ExecutionEffect" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "effectKey" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "resultJson" TEXT,
    "epoch" BIGINT NOT NULL,
    "jobId" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ExecutionEffect_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","threadId","effectKey")
);

-- CreateIndex
CREATE INDEX "OperatorExecution_status_idx" ON "OperatorExecution"("projectId", "systemId", "executionSpaceId", "operatorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionRun_generation_key" ON "ExecutionRun"("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionRun_contribution_key" ON "ExecutionRun"("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId", "contributionId");

-- CreateIndex
CREATE INDEX "ExecutionContribution_status_idx" ON "ExecutionContribution"("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "status");

-- CreateIndex
CREATE INDEX "ExecutionEffect_status_idx" ON "ExecutionEffect"("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "status");

-- AddForeignKey
ALTER TABLE "OperatorExecution" ADD CONSTRAINT "OperatorExecution_operator_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId") REFERENCES "OperatorRuntime"("projectId", "systemId", "executionSpaceId", "operatorId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorExecution" ADD CONSTRAINT "OperatorExecution_current_run_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "currentRunId") REFERENCES "ExecutionRun"("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionRun" ADD CONSTRAINT "ExecutionRun_thread_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId") REFERENCES "OperatorExecution"("projectId", "systemId", "executionSpaceId", "operatorId", "threadId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionRun" ADD CONSTRAINT "ExecutionRun_parent_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "parentRunId") REFERENCES "ExecutionRun"("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionRun" ADD CONSTRAINT "ExecutionRun_contribution_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "contributionId") REFERENCES "ExecutionContribution"("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "contributionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionContribution" ADD CONSTRAINT "ExecutionContribution_thread_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId") REFERENCES "OperatorExecution"("projectId", "systemId", "executionSpaceId", "operatorId", "threadId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionContribution" ADD CONSTRAINT "ExecutionContribution_run_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId", "contributionId") REFERENCES "ExecutionRun"("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId", "contributionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionEffect" ADD CONSTRAINT "ExecutionEffect_run_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId", "contributionId") REFERENCES "ExecutionRun"("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId", "contributionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- First-open promotion may create its run before binding the contribution;
-- both scoped records must exist at commit. This is not a deferred authority check.
ALTER TABLE "ExecutionRun" ALTER CONSTRAINT "ExecutionRun_contribution_fk" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ExecutionContribution" ALTER CONSTRAINT "ExecutionContribution_run_fk" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "OperatorExecution" ALTER CONSTRAINT "OperatorExecution_current_run_fk" DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "OperatorExecution" ADD CONSTRAINT "OperatorExecution_counter_check"
  CHECK ("revision" BETWEEN 0 AND 9007199254740991 AND "epoch" BETWEEN 0 AND 9007199254740991 AND ("currentRetry" IS NULL OR "currentRetry" >= 0));
ALTER TABLE "OperatorExecution" ADD CONSTRAINT "OperatorExecution_identity_check"
  CHECK ("purpose" IN ('conversation', 'promotion') AND
    (("scopeKind" = 'request' AND "rootRequestId" IS NOT NULL AND "ownerId" IS NULL) OR
     ("scopeKind" = 'designer' AND "ownerId" IS NOT NULL AND "rootRequestId" IS NULL)));
ALTER TABLE "OperatorExecution" ADD CONSTRAINT "OperatorExecution_status_check"
  CHECK ("status" IN ('queued', 'running', 'waiting', 'completed', 'failed', 'uncertain'));
ALTER TABLE "ExecutionRun" ADD CONSTRAINT "ExecutionRun_counter_check"
  CHECK ("generation" BETWEEN 1 AND 9007199254740991 AND "epoch" BETWEEN 1 AND 9007199254740991 AND "retryCount" >= 0);
ALTER TABLE "ExecutionRun" ADD CONSTRAINT "ExecutionRun_parent_check"
  CHECK ("parentRunId" IS NULL OR "parentRunId" <> "runId");
ALTER TABLE "ExecutionRun" ADD CONSTRAINT "ExecutionRun_status_check"
  CHECK ("status" IN ('running', 'waiting', 'completed', 'failed', 'uncertain'));
ALTER TABLE "ExecutionContribution" ADD CONSTRAINT "ExecutionContribution_receipt_check"
  CHECK ("digest" ~ '^[0-9a-f]{64}$' AND
    ("requestDigest" IS NULL OR "requestDigest" ~ '^[0-9a-f]{64}$') AND
    (("requestDigest" IS NULL AND "runId" IS NULL) OR ("requestDigest" IS NOT NULL AND "runId" IS NOT NULL)) AND
    "kind" IN ('contribution', 'continuation', 'notification', 'input', 'resume') AND
    "status" IN ('queued', 'running', 'completed', 'failed', 'uncertain'));
ALTER TABLE "ExecutionEffect" ADD CONSTRAINT "ExecutionEffect_counter_check"
  CHECK ("epoch" BETWEEN 1 AND 9007199254740991 AND "retryCount" >= 0 AND "requestDigest" ~ '^[0-9a-f]{64}$');
ALTER TABLE "ExecutionEffect" ADD CONSTRAINT "ExecutionEffect_status_check"
  CHECK (("status" IN ('started', 'unknown') AND "resultJson" IS NULL AND "completedAt" IS NULL) OR
    ("status" = 'completed' AND "resultJson" IS NOT NULL AND "completedAt" IS NOT NULL));

CREATE FUNCTION assembly_preserve_operator_execution_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."projectId", NEW."systemId", NEW."executionSpaceId", NEW."operatorId", NEW."threadId", NEW."identityJson", NEW."scopeKind", NEW."scopeId", NEW."rootRequestId", NEW."ownerId", NEW."purpose", NEW."subjectId", NEW."createdAt")
    IS DISTINCT FROM
    ROW(OLD."projectId", OLD."systemId", OLD."executionSpaceId", OLD."operatorId", OLD."threadId", OLD."identityJson", OLD."scopeKind", OLD."scopeId", OLD."rootRequestId", OLD."ownerId", OLD."purpose", OLD."subjectId", OLD."createdAt") THEN
    RAISE EXCEPTION 'Assembly execution identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."revision" < OLD."revision" OR NEW."epoch" < OLD."epoch" THEN
    RAISE EXCEPTION 'Assembly execution counters cannot decrease' USING ERRCODE = '23514';
  END IF;
  IF OLD."retiredAt" IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Assembly retired execution is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "OperatorExecution_preserve_identity" BEFORE UPDATE ON "OperatorExecution"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_operator_execution_identity();

CREATE FUNCTION assembly_preserve_execution_run_pin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."projectId", NEW."systemId", NEW."executionSpaceId", NEW."operatorId", NEW."threadId", NEW."runId", NEW."parentRunId", NEW."generation", NEW."contributionId", NEW."pinJson", NEW."checkpointNamespace", NEW."createdAt")
    IS DISTINCT FROM
    ROW(OLD."projectId", OLD."systemId", OLD."executionSpaceId", OLD."operatorId", OLD."threadId", OLD."runId", OLD."parentRunId", OLD."generation", OLD."contributionId", OLD."pinJson", OLD."checkpointNamespace", OLD."createdAt") THEN
    RAISE EXCEPTION 'Assembly execution run pin is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."snapshotJson" IS NOT NULL AND NEW."snapshotJson" IS DISTINCT FROM OLD."snapshotJson" THEN
    RAISE EXCEPTION 'Assembly accepted execution snapshot receipt is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."epoch" < OLD."epoch" THEN
    RAISE EXCEPTION 'Assembly execution run epoch cannot decrease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExecutionRun_preserve_pin" BEFORE UPDATE ON "ExecutionRun"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_execution_run_pin();

CREATE FUNCTION assembly_preserve_execution_contribution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."projectId", NEW."systemId", NEW."executionSpaceId", NEW."operatorId", NEW."threadId", NEW."contributionId", NEW."digest", NEW."kind", NEW."originJson", NEW."payloadJson", NEW."jobId", NEW."acceptedAt")
    IS DISTINCT FROM
    ROW(OLD."projectId", OLD."systemId", OLD."executionSpaceId", OLD."operatorId", OLD."threadId", OLD."contributionId", OLD."digest", OLD."kind", OLD."originJson", OLD."payloadJson", OLD."jobId", OLD."acceptedAt") THEN
    RAISE EXCEPTION 'Assembly accepted execution contribution is immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD."requestDigest" IS NOT NULL AND NEW."requestDigest" IS DISTINCT FROM OLD."requestDigest") OR
     (OLD."runId" IS NOT NULL AND NEW."runId" IS DISTINCT FROM OLD."runId") OR
     (OLD."completedAt" IS NOT NULL AND NEW."completedAt" IS DISTINCT FROM OLD."completedAt") OR
     (OLD."status" = 'completed' AND NEW."status" <> 'completed') THEN
    RAISE EXCEPTION 'Assembly bound contribution receipt cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExecutionContribution_preserve_receipt" BEFORE UPDATE ON "ExecutionContribution"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_execution_contribution();

CREATE FUNCTION assembly_preserve_execution_effect() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."projectId", NEW."systemId", NEW."executionSpaceId", NEW."operatorId", NEW."threadId", NEW."effectKey", NEW."runId", NEW."contributionId", NEW."nodeId", NEW."requestDigest", NEW."epoch", NEW."jobId", NEW."retryCount", NEW."startedAt")
    IS DISTINCT FROM
    ROW(OLD."projectId", OLD."systemId", OLD."executionSpaceId", OLD."operatorId", OLD."threadId", OLD."effectKey", OLD."runId", OLD."contributionId", OLD."nodeId", OLD."requestDigest", OLD."epoch", OLD."jobId", OLD."retryCount", OLD."startedAt") THEN
    RAISE EXCEPTION 'Assembly execution effect identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('completed', 'unknown') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Assembly settled or unknown effect cannot be rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExecutionEffect_preserve_receipt" BEFORE UPDATE ON "ExecutionEffect"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_execution_effect();
