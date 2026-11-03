-- Private evidence beside the existing intention, never a grant in retained assets.
ALTER TABLE "SavedSystem" ADD COLUMN "creationAuthorization" TEXT;
CREATE FUNCTION assembly_preserve_release_creation_authorization() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."creationAuthorization" IS NOT NULL AND
    NEW."creationAuthorization" IS DISTINCT FROM OLD."creationAuthorization" THEN
    RAISE EXCEPTION 'Release creation authority evidence is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "SavedSystem_preserve_creation_authorization" BEFORE UPDATE ON "SavedSystem"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_release_creation_authorization();
