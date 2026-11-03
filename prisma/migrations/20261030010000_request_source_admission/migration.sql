-- Preserve the existing immutable SpaceManifest rows and baseline index.
-- Source admission is distinct from runtime adoption.
ALTER TABLE "SpaceManifest" DROP CONSTRAINT "SpaceManifest_kind_check";
ALTER TABLE "SpaceManifest" ADD CONSTRAINT "SpaceManifest_kind_check"
  CHECK ("kind" IN ('baseline', 'adoption', 'source-admission') AND "digest" ~ '^[0-9a-f]{64}$');
