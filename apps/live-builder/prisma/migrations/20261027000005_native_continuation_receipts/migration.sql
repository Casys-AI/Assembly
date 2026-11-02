-- Preserve the original #4 same-thread lineage without rewriting any row.
ALTER TABLE "ExecutionRun" RENAME COLUMN "parentRunId" TO "predecessorRunId";
ALTER TABLE "ExecutionRun" RENAME CONSTRAINT "ExecutionRun_parent_fk" TO "ExecutionRun_predecessor_fk";
ALTER TABLE "ExecutionRun" RENAME CONSTRAINT "ExecutionRun_parent_check" TO "ExecutionRun_predecessor_check";
ALTER TABLE "ExecutionRun" ADD COLUMN "parentThreadId" TEXT, ADD COLUMN "parentRunId" TEXT,
  ADD COLUMN "modelReferenceJson" TEXT;
ALTER TABLE "ExecutionRun" ADD CONSTRAINT "ExecutionRun_parent_fk"
  FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "parentThreadId", "parentRunId")
  REFERENCES "ExecutionRun" ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExecutionRun" ADD CONSTRAINT "ExecutionRun_parent_check"
  CHECK (("parentThreadId" IS NULL AND "parentRunId" IS NULL) OR
    ("parentThreadId" IS NOT NULL AND "parentRunId" IS NOT NULL AND
      ("parentThreadId" <> "threadId" OR "parentRunId" <> "runId")));

-- AlterTable
ALTER TABLE "OperatorExecution" ADD COLUMN     "advanceAuthorizationJson" TEXT,
ADD COLUMN     "authorizedPinJson" TEXT,
ADD COLUMN     "predecessorThreadId" TEXT,
ADD COLUMN     "terminalReceiptJson" TEXT;

-- CreateTable
CREATE TABLE "NativeContinuationReceipt" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "predecessorRunId" TEXT NOT NULL,
    "sourceCheckpointNamespace" TEXT NOT NULL,
    "sourceCheckpointId" TEXT NOT NULL,
    "preparedNodeId" TEXT NOT NULL,
    "settledEffectKey" TEXT NOT NULL,
    "sourceNativeActionId" TEXT,
    "evidenceKind" TEXT NOT NULL,
    "evidenceDigest" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "successorRunId" TEXT NOT NULL,
    "targetPinJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "successorCheckpointNamespace" TEXT,
    "successorCheckpointId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "selectedAt" TIMESTAMPTZ(3),

    CONSTRAINT "NativeContinuationReceipt_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","threadId","id")
);

-- CreateTable
CREATE TABLE "ExecutionThreadBinding" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "executionSpaceId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "identityDigest" TEXT NOT NULL,
    "identityJson" TEXT NOT NULL,
    "activeThreadId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ExecutionThreadBinding_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","identityDigest")
);

-- CreateIndex
CREATE UNIQUE INDEX "NativeContinuationReceipt_source_key" ON "NativeContinuationReceipt"("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "predecessorRunId", "sourceCheckpointNamespace", "sourceCheckpointId", "evidenceDigest");

-- AddForeignKey
ALTER TABLE "OperatorExecution" ADD CONSTRAINT "OperatorExecution_predecessor_thread_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "predecessorThreadId") REFERENCES "OperatorExecution"("projectId", "systemId", "executionSpaceId", "operatorId", "threadId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeContinuationReceipt" ADD CONSTRAINT "NativeContinuationReceipt_effect_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "settledEffectKey") REFERENCES "ExecutionEffect"("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "effectKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeContinuationReceipt" ADD CONSTRAINT "NativeContinuationReceipt_predecessor_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "predecessorRunId") REFERENCES "ExecutionRun"("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeContinuationReceipt" ADD CONSTRAINT "NativeContinuationReceipt_successor_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "successorRunId") REFERENCES "ExecutionRun"("projectId", "systemId", "executionSpaceId", "operatorId", "threadId", "runId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionThreadBinding" ADD CONSTRAINT "ExecutionThreadBinding_active_thread_fk" FOREIGN KEY ("projectId", "systemId", "executionSpaceId", "operatorId", "activeThreadId") REFERENCES "OperatorExecution"("projectId", "systemId", "executionSpaceId", "operatorId", "threadId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Sequential generations and nested thread parentage are distinct immutable pins.
CREATE OR REPLACE FUNCTION assembly_preserve_execution_run_pin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."projectId", NEW."systemId", NEW."executionSpaceId", NEW."operatorId", NEW."threadId", NEW."runId", NEW."predecessorRunId", NEW."parentThreadId", NEW."parentRunId", NEW."generation", NEW."contributionId", NEW."pinJson", NEW."checkpointNamespace", NEW."createdAt")
    IS DISTINCT FROM
    ROW(OLD."projectId", OLD."systemId", OLD."executionSpaceId", OLD."operatorId", OLD."threadId", OLD."runId", OLD."predecessorRunId", OLD."parentThreadId", OLD."parentRunId", OLD."generation", OLD."contributionId", OLD."pinJson", OLD."checkpointNamespace", OLD."createdAt") THEN
    RAISE EXCEPTION 'Assembly execution run pin is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."snapshotJson" IS NOT NULL AND NEW."snapshotJson" IS DISTINCT FROM OLD."snapshotJson" THEN
    RAISE EXCEPTION 'Assembly accepted execution snapshot receipt is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."modelReferenceJson" IS NOT NULL AND NEW."modelReferenceJson" IS DISTINCT FROM OLD."modelReferenceJson" THEN
    RAISE EXCEPTION 'Assembly original execution model reference is bound once' USING ERRCODE = '23514';
  END IF;
  IF NEW."epoch" < OLD."epoch" THEN
    RAISE EXCEPTION 'Assembly execution run epoch cannot decrease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE "NativeContinuationReceipt" ADD CONSTRAINT "NativeContinuationReceipt_kind_check"
  CHECK ("evidenceKind" = 'verified-catalog-advance' AND "evidenceDigest" ~ '^[0-9a-f]{64}$');
ALTER TABLE "NativeContinuationReceipt" ADD CONSTRAINT "NativeContinuationReceipt_status_check"
  CHECK ("status" IN ('intent', 'selected', 'rejected'));
ALTER TABLE "NativeContinuationReceipt" ADD CONSTRAINT "NativeContinuationReceipt_checkpoint_pair_check"
  CHECK (("successorCheckpointNamespace" IS NULL AND "successorCheckpointId" IS NULL) OR
    ("successorCheckpointNamespace" IS NOT NULL AND "successorCheckpointId" IS NOT NULL));
ALTER TABLE "NativeContinuationReceipt" ADD CONSTRAINT "NativeContinuationReceipt_selection_check"
  CHECK (("status" = 'selected' AND "successorCheckpointNamespace" IS NOT NULL AND "successorCheckpointId" IS NOT NULL AND "selectedAt" IS NOT NULL) OR
    ("status" IN ('intent', 'rejected') AND "selectedAt" IS NULL));
ALTER TABLE "NativeContinuationReceipt" ADD CONSTRAINT "NativeContinuationReceipt_distinct_run_check"
  CHECK ("predecessorRunId" <> "successorRunId");
ALTER TABLE "NativeContinuationReceipt" ALTER CONSTRAINT "NativeContinuationReceipt_successor_fk" DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION assembly_preserve_native_continuation_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."projectId", NEW."systemId", NEW."executionSpaceId", NEW."operatorId", NEW."threadId", NEW."id", NEW."predecessorRunId", NEW."sourceCheckpointNamespace", NEW."sourceCheckpointId", NEW."preparedNodeId", NEW."settledEffectKey", NEW."sourceNativeActionId", NEW."evidenceKind", NEW."evidenceDigest", NEW."evidenceJson", NEW."successorRunId", NEW."targetPinJson", NEW."createdAt")
    IS DISTINCT FROM
    ROW(OLD."projectId", OLD."systemId", OLD."executionSpaceId", OLD."operatorId", OLD."threadId", OLD."id", OLD."predecessorRunId", OLD."sourceCheckpointNamespace", OLD."sourceCheckpointId", OLD."preparedNodeId", OLD."settledEffectKey", OLD."sourceNativeActionId", OLD."evidenceKind", OLD."evidenceDigest", OLD."evidenceJson", OLD."successorRunId", OLD."targetPinJson", OLD."createdAt") THEN
    RAISE EXCEPTION 'Assembly native continuation evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD."successorCheckpointNamespace" IS NOT NULL AND NEW."successorCheckpointNamespace" IS DISTINCT FROM OLD."successorCheckpointNamespace") OR
     (OLD."successorCheckpointId" IS NOT NULL AND NEW."successorCheckpointId" IS DISTINCT FROM OLD."successorCheckpointId") OR
     (OLD."selectedAt" IS NOT NULL AND NEW."selectedAt" IS DISTINCT FROM OLD."selectedAt") OR
     (OLD."status" <> 'intent' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Assembly selected or rejected native continuation cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "NativeContinuationReceipt_preserve_evidence" BEFORE UPDATE ON "NativeContinuationReceipt"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_native_continuation_receipt();
CREATE TRIGGER "NativeContinuationReceipt_preserve_history" BEFORE DELETE ON "NativeContinuationReceipt"
  FOR EACH ROW EXECUTE FUNCTION assembly_reject_immutable_change();

-- A reserved successor exists durably but cannot become current/execute until
-- the ledger verifies evidence, selects its fork and explicitly marks it running.
ALTER TABLE "ExecutionRun" DROP CONSTRAINT "ExecutionRun_status_check";
ALTER TABLE "ExecutionRun" ADD CONSTRAINT "ExecutionRun_status_check"
  CHECK ("status" IN ('reserved', 'running', 'waiting', 'completed', 'failed', 'uncertain'));
ALTER TABLE "OperatorExecution" ADD CONSTRAINT "OperatorExecution_successor_check"
  CHECK ("predecessorThreadId" IS NULL OR
    ("predecessorThreadId" <> "threadId" AND "authorizedPinJson" IS NOT NULL AND "advanceAuthorizationJson" IS NOT NULL));
ALTER TABLE "ExecutionThreadBinding" ADD CONSTRAINT "ExecutionThreadBinding_identity_check"
  CHECK ("identityDigest" ~ '^[0-9a-f]{64}$' AND "revision" BETWEEN 0 AND 9007199254740991);

CREATE OR REPLACE FUNCTION assembly_preserve_operator_execution_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."projectId", NEW."systemId", NEW."executionSpaceId", NEW."operatorId", NEW."threadId", NEW."identityJson", NEW."scopeKind", NEW."scopeId", NEW."rootRequestId", NEW."ownerId", NEW."purpose", NEW."subjectId", NEW."predecessorThreadId", NEW."advanceAuthorizationJson", NEW."createdAt")
    IS DISTINCT FROM
    ROW(OLD."projectId", OLD."systemId", OLD."executionSpaceId", OLD."operatorId", OLD."threadId", OLD."identityJson", OLD."scopeKind", OLD."scopeId", OLD."rootRequestId", OLD."ownerId", OLD."purpose", OLD."subjectId", OLD."predecessorThreadId", OLD."advanceAuthorizationJson", OLD."createdAt") THEN
    RAISE EXCEPTION 'Assembly execution identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."authorizedPinJson" IS NOT NULL AND NEW."authorizedPinJson" IS DISTINCT FROM OLD."authorizedPinJson" THEN
    RAISE EXCEPTION 'Assembly authorized execution pin is bound once' USING ERRCODE = '23514';
  END IF;
  IF OLD."terminalReceiptJson" IS NOT NULL AND NEW."terminalReceiptJson" IS DISTINCT FROM OLD."terminalReceiptJson" THEN
    RAISE EXCEPTION 'Assembly terminal execution receipt is bound once' USING ERRCODE = '23514';
  END IF;
  IF NEW."revision" < OLD."revision" OR NEW."epoch" < OLD."epoch" THEN
    RAISE EXCEPTION 'Assembly execution counters cannot decrease' USING ERRCODE = '23514';
  END IF;
  IF OLD."retiredAt" IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Assembly retired execution is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION assembly_preserve_execution_thread_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."projectId", NEW."systemId", NEW."executionSpaceId", NEW."operatorId", NEW."identityDigest", NEW."identityJson", NEW."createdAt")
    IS DISTINCT FROM
    ROW(OLD."projectId", OLD."systemId", OLD."executionSpaceId", OLD."operatorId", OLD."identityDigest", OLD."identityJson", OLD."createdAt") THEN
    RAISE EXCEPTION 'Assembly execution binding identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."revision" < OLD."revision" OR
    (NEW."activeThreadId" IS DISTINCT FROM OLD."activeThreadId" AND NEW."revision" <> OLD."revision" + 1) THEN
    RAISE EXCEPTION 'Assembly execution binding revision changed incorrectly' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExecutionThreadBinding_preserve_identity" BEFORE UPDATE ON "ExecutionThreadBinding"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_execution_thread_binding();

-- Recovery stores only the original accepted business-revision reference.
-- Nullable historical placeholders do not authorize reconstruction from current
-- state; new adapters must supply the validated exact reference at Run creation.
ALTER TABLE "OperatorExecution" ADD CONSTRAINT "OperatorExecution_terminal_receipt_check"
  CHECK ("terminalReceiptJson" IS NULL OR ("status" = 'completed' AND "retiredAt" IS NOT NULL));

-- Existing human commands and scheduled wakeups remain authenticated canonical
-- deliveries. Merely storing their kind does not grant execution authority.
ALTER TABLE "ExecutionContribution" DROP CONSTRAINT "ExecutionContribution_receipt_check";
ALTER TABLE "ExecutionContribution" ADD CONSTRAINT "ExecutionContribution_receipt_check"
  CHECK ("digest" ~ '^[0-9a-f]{64}$' AND
    ("requestDigest" IS NULL OR "requestDigest" ~ '^[0-9a-f]{64}$') AND
    (("requestDigest" IS NULL AND "runId" IS NULL) OR ("requestDigest" IS NOT NULL AND "runId" IS NOT NULL)) AND
    "kind" IN ('contribution', 'continuation', 'notification', 'input', 'resume', 'command', 'schedule') AND
    "status" IN ('queued', 'running', 'completed', 'failed', 'uncertain'));
