-- Add evidence about the source shape without rewriting historical receipts.
-- Historical NULL is interpreted by the two previously admitted evidence kinds.
ALTER TABLE "NativeContinuationReceipt" ADD COLUMN "sourceKind" TEXT;
ALTER TABLE "NativeContinuationReceipt" ADD COLUMN "sourceOccurrenceId" TEXT;
ALTER TABLE "NativeContinuationReceipt" ADD CONSTRAINT "NativeContinuationReceipt_source_kind_check"
  CHECK ("sourceKind" IS NULL OR "sourceKind" IN ('settled-effect', 'unconsumed-input-wait'));

CREATE OR REPLACE FUNCTION assembly_require_continuation_source_effect() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  effect_row RECORD;
  predecessor RECORD;
  snapshot JSONB;
BEGIN
  IF NEW."sourceKind" IS NULL OR NEW."sourceKind" NOT IN ('settled-effect', 'unconsumed-input-wait') OR
     NEW."sourceOccurrenceId" IS NULL OR btrim(NEW."sourceOccurrenceId") = '' OR
     NEW."sourceNativeActionId" IS NULL OR btrim(NEW."sourceNativeActionId") = '' THEN
    RAISE EXCEPTION 'Assembly new continuation requires its explicit source shape and occurrence' USING ERRCODE = '23514';
  END IF;
  EXECUTE format('SELECT * FROM %I."ExecutionEffect" WHERE "projectId"=$1 AND "systemId"=$2 AND "executionSpaceId"=$3 AND "operatorId"=$4 AND "threadId"=$5 AND "effectKey"=$6', TG_TABLE_SCHEMA)
    INTO effect_row USING NEW."projectId", NEW."systemId", NEW."executionSpaceId", NEW."operatorId", NEW."threadId", NEW."settledEffectKey";
  EXECUTE format('SELECT r.*,e."purpose",e."identityJson" FROM %I."ExecutionRun" r JOIN %I."OperatorExecution" e USING ("projectId","systemId","executionSpaceId","operatorId","threadId") WHERE r."projectId"=$1 AND r."systemId"=$2 AND r."executionSpaceId"=$3 AND r."operatorId"=$4 AND r."threadId"=$5 AND r."runId"=$6', TG_TABLE_SCHEMA, TG_TABLE_SCHEMA)
    INTO predecessor USING NEW."projectId", NEW."systemId", NEW."executionSpaceId", NEW."operatorId", NEW."threadId", NEW."predecessorRunId";
  IF predecessor."runId" IS NULL OR predecessor."checkpointNamespace" IS DISTINCT FROM NEW."sourceCheckpointNamespace" OR
     predecessor."checkpointId" IS DISTINCT FROM NEW."sourceCheckpointId" THEN
    RAISE EXCEPTION 'Assembly continuation requires its exact scoped predecessor checkpoint' USING ERRCODE = '23514';
  END IF;
  IF NEW."sourceKind" = 'settled-effect' THEN
    IF NEW."evidenceKind" <> 'verified-catalog-advance' OR effect_row."effectKey" IS NULL OR
       effect_row."runId" IS DISTINCT FROM NEW."predecessorRunId" OR effect_row."status" <> 'completed' OR
       effect_row."resultJson" IS NULL OR effect_row."nodeId" IS DISTINCT FROM NEW."sourceNativeActionId" THEN
      RAISE EXCEPTION 'Assembly catalog continuation requires its exact settled source effect' USING ERRCODE = '23503';
    END IF;
  ELSE
    snapshot := predecessor."snapshotJson"::jsonb;
    IF NEW."evidenceKind" NOT IN ('verified-catalog-advance', 'verified-mandate-advance') OR
       effect_row."effectKey" IS NOT NULL OR predecessor."purpose" <> 'conversation' OR
       snapshot IS NULL OR snapshot->>'status' IS DISTINCT FROM 'waiting' OR
       snapshot->'identity' IS DISTINCT FROM predecessor."identityJson"::jsonb OR
       jsonb_array_length(snapshot->'waits') IS DISTINCT FROM 1 OR
       snapshot->'waits'->0->>'kind' IS DISTINCT FROM 'input' OR
       snapshot->'waits'->0->>'mechanism' IS DISTINCT FROM 'await_input' OR
       snapshot->'waits'->0->>'nodeId' IS DISTINCT FROM NEW."sourceOccurrenceId" OR
       jsonb_array_length(snapshot->'unsettledEffects') IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Assembly continuation requires its exact unconsumed conversation input wait' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION assembly_preserve_continuation_source_shape() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."sourceKind",NEW."sourceOccurrenceId") IS DISTINCT FROM ROW(OLD."sourceKind",OLD."sourceOccurrenceId") THEN
    RAISE EXCEPTION 'Assembly continuation source shape is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "NativeContinuationReceipt_preserve_source_shape" BEFORE UPDATE ON "NativeContinuationReceipt"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_continuation_source_shape();
