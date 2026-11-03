-- AlterTable
ALTER TABLE "ArtifactVersion" ADD COLUMN     "manifestFormat" TEXT,
ALTER COLUMN "sourceReferenceVersion" DROP DEFAULT;

-- Retain immutable historical v1 snapshots without inferring a v2 format.
ALTER TABLE "ArtifactVersion" DROP CONSTRAINT "ArtifactVersion_pin_check";
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_pin_check"
  CHECK ("commitOid" ~ '^[0-9a-f]{40}$' AND
    "contentDigest" ~ '^[0-9a-f]{64}$' AND
    "manifestDigest" ~ '^[0-9a-f]{64}$' AND
    "manifestDigestVersion" = 'sha256-canonical-json-v1' AND
    (("kind" = 'tool-draft' AND "contentEncoding" = 'tool-draft-json-v1') OR
     ("kind" = 'skill-document' AND "contentEncoding" = 'utf8-v1')) AND
    (("sourceReferenceVersion" = 1 AND "manifestFormat" IS NULL) OR
     ("sourceReferenceVersion" = 2 AND "manifestFormat" IS NOT NULL AND
      "manifestFormat" = 'assembly-artifact-package-v2' AND
      "manifestPath" = 'artifacts/' || "manifestDigest" || '/manifest.json' AND
      "entryPath" = 'artifacts/' || "manifestDigest" || '/' ||
        CASE WHEN "kind" = 'tool-draft' THEN 'source.json' ELSE 'SKILL.md' END)));
