-- Explicit bounded manifest. Existing effect identity/unknown-result triggers
-- remain unchanged; each member still owns its own ExecutionEffect receipt.
CREATE TABLE "ImmutableConsultationGroup" (
  "projectId" TEXT NOT NULL,
  "systemId" TEXT NOT NULL,
  "executionSpaceId" TEXT NOT NULL,
  "operatorId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "contributionId" TEXT NOT NULL,
  "manifestDigest" TEXT NOT NULL,
  "manifestJson" TEXT NOT NULL,
  "publicationJson" TEXT,
  "registeredAt" TIMESTAMPTZ(3) NOT NULL,
  "publishedAt" TIMESTAMPTZ(3),
  CONSTRAINT "ImmutableConsultationGroup_pkey" PRIMARY KEY ("projectId","systemId","executionSpaceId","operatorId","threadId","groupId"),
  CONSTRAINT "ImmutableConsultationGroup_run_fk" FOREIGN KEY ("projectId","systemId","executionSpaceId","operatorId","threadId","runId","contributionId")
    REFERENCES "ExecutionRun" ("projectId","systemId","executionSpaceId","operatorId","threadId","runId","contributionId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ImmutableConsultationGroup_manifest_check" CHECK (
    "manifestDigest" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("manifestJson"::jsonb) = 'object'
    AND ("manifestJson"::jsonb->>'groupId') IS NOT DISTINCT FROM "groupId"
    AND ("manifestJson"::jsonb->>'manifestDigest') IS NOT DISTINCT FROM "manifestDigest"
    AND (jsonb_typeof("manifestJson"::jsonb->'members') = 'array') IS TRUE
    AND jsonb_array_length("manifestJson"::jsonb->'members') BETWEEN 1 AND 4
  ),
  CONSTRAINT "ImmutableConsultationGroup_publication_check" CHECK (
    ("publicationJson" IS NULL AND "publishedAt" IS NULL)
    OR ("publicationJson" IS NOT NULL AND "publishedAt" IS NOT NULL
      AND jsonb_typeof("publicationJson"::jsonb) = 'object'
      AND ("publicationJson"::jsonb->>'groupId') IS NOT DISTINCT FROM "groupId"
      AND ("publicationJson"::jsonb->>'manifestDigest') IS NOT DISTINCT FROM "manifestDigest")
  )
);

-- Fenced registration serializes on the execution row; this also refuses a
-- second unjoined manifest if an independent writer bypasses that protocol.
CREATE UNIQUE INDEX "ImmutableConsultationGroup_one_open_idx"
  ON "ImmutableConsultationGroup" ("projectId","systemId","executionSpaceId","operatorId","threadId")
  WHERE "publicationJson" IS NULL;

CREATE FUNCTION assembly_preserve_immutable_consultation_group() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Assembly immutable consultation receipts cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."projectId",NEW."systemId",NEW."executionSpaceId",NEW."operatorId",NEW."threadId",NEW."groupId",NEW."runId",NEW."contributionId",NEW."manifestDigest",NEW."manifestJson",NEW."registeredAt")
    IS DISTINCT FROM
    ROW(OLD."projectId",OLD."systemId",OLD."executionSpaceId",OLD."operatorId",OLD."threadId",OLD."groupId",OLD."runId",OLD."contributionId",OLD."manifestDigest",OLD."manifestJson",OLD."registeredAt") THEN
    RAISE EXCEPTION 'Assembly immutable consultation membership cannot change' USING ERRCODE = '23514';
  END IF;
  IF OLD."publicationJson" IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Assembly immutable consultation publication cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ImmutableConsultationGroup_preserve_manifest" BEFORE UPDATE OR DELETE ON "ImmutableConsultationGroup"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_immutable_consultation_group();
