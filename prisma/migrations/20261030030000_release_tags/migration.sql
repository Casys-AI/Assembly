-- Nullable publication relation beside historical captures/manifests. No backfill.
ALTER TABLE "SavedSystem"
  ADD COLUMN "tagSelection" TEXT,
  ADD COLUMN "tagBinding" TEXT,
  ADD COLUMN "tagRepositoryId" TEXT,
  ADD COLUMN "tagName" TEXT,
  ADD COLUMN "tagVerified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "tagRejection" TEXT,
  ADD CONSTRAINT "SavedSystem_tag_complete" CHECK (
    ("tagSelection" IS NULL AND "tagBinding" IS NULL AND
     "tagRepositoryId" IS NULL AND "tagName" IS NULL AND NOT "tagVerified") OR
    ("tagSelection" IS NOT NULL AND "tagBinding" IS NOT NULL AND
     "tagRepositoryId" IS NOT NULL AND "tagName" IS NOT NULL)
  ),
  ADD CONSTRAINT "SavedSystem_tag_rejection" CHECK (
    "tagRejection" IS NULL OR
    ("tagSelection" IS NULL AND "status"='conflict' AND
     "manifest" IS NULL AND "digest" IS NULL)
  ),
  ADD CONSTRAINT "SavedSystem_repository_tag_key"
    UNIQUE ("projectId", "systemId", "tagRepositoryId", "tagName");

CREATE FUNCTION assembly_preserve_release_tag() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."tagRejection" IS DISTINCT FROM OLD."tagRejection" OR
    (OLD."tagRejection" IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Release tag rejection is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW."tagSelection" IS DISTINCT FROM OLD."tagSelection" OR
    NEW."tagBinding" IS DISTINCT FROM OLD."tagBinding" OR
    NEW."tagRepositoryId" IS DISTINCT FROM OLD."tagRepositoryId" OR
    NEW."tagName" IS DISTINCT FROM OLD."tagName" OR
    (OLD."tagSelection" IS NOT NULL AND (
      NEW."id" IS DISTINCT FROM OLD."id" OR
      NEW."projectId" IS DISTINCT FROM OLD."projectId" OR
      NEW."systemId" IS DISTINCT FROM OLD."systemId" OR
      NEW."executionSpaceId" IS DISTINCT FROM OLD."executionSpaceId" OR
      NEW."saveKey" IS DISTINCT FROM OLD."saveKey")) OR
    (OLD."tagVerified" AND NOT NEW."tagVerified") THEN
    RAISE EXCEPTION 'Release tag reservation is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "SavedSystem_preserve_tag" BEFORE UPDATE ON "SavedSystem"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_release_tag();
