-- A post-approve dialogue resumption journals its approved-change advance beside
-- catalog advances; only the two verified evidence kinds are admitted.
ALTER TABLE "NativeContinuationReceipt" DROP CONSTRAINT "NativeContinuationReceipt_kind_check";
ALTER TABLE "NativeContinuationReceipt" ADD CONSTRAINT "NativeContinuationReceipt_kind_check"
  CHECK ("evidenceKind" IN ('verified-catalog-advance', 'verified-mandate-advance') AND "evidenceDigest" ~ '^[0-9a-f]{64}$');

-- A catalog continuation references its exact settled source effect; a mandate
-- continuation resumes an unconsumed input wait, whose await_input prepare
-- records no effect. The reference is conditional on the evidence kind, which
-- a plain foreign key cannot express, so the key becomes a trigger. Scope and
-- evidence columns are immutable after insert, therefore insert-only is exact.
ALTER TABLE "NativeContinuationReceipt" DROP CONSTRAINT "NativeContinuationReceipt_effect_fk";
CREATE FUNCTION assembly_require_continuation_source_effect() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  found BOOLEAN;
BEGIN
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I."ExecutionEffect" WHERE "projectId"=$1 AND "systemId"=$2 AND "executionSpaceId"=$3 AND "operatorId"=$4 AND "threadId"=$5 AND "effectKey"=$6)',
    TG_TABLE_SCHEMA
  ) INTO found USING NEW."projectId", NEW."systemId", NEW."executionSpaceId", NEW."operatorId", NEW."threadId", NEW."settledEffectKey";
  IF NEW."evidenceKind" = 'verified-catalog-advance' AND NOT found THEN
    RAISE EXCEPTION 'Assembly catalog continuation requires its settled source effect' USING ERRCODE = '23503';
  END IF;
  IF NEW."evidenceKind" = 'verified-mandate-advance' AND found THEN
    RAISE EXCEPTION 'Assembly mandate continuation requires an unconsumed input wait' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "NativeContinuationReceipt_require_source_effect" BEFORE INSERT ON "NativeContinuationReceipt"
  FOR EACH ROW EXECUTE FUNCTION assembly_require_continuation_source_effect();
