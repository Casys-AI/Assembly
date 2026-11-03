import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  ARTIFACT_MANIFEST_DIGEST,
  ARTIFACT_MANIFEST_FORMAT,
  ArtifactSourceError,
  validateSourceReference,
} from "../../../domain/work/artifacts/source-reference.ts";
import {
  type ArtifactPackageManifest,
  packageManifestDigest,
  packageReference,
  parsePackageManifest,
  parseRepositoryManifest,
  repositoryManifest,
} from "./repository-format.ts";
import { encodeArtifactSource } from "./artifact-content.ts";
import { skillContentDigest } from "../../../domain/skills/context-skills.ts";
import { toolDraftDigest } from "../../../application/work/artifacts/catalog.ts";

const manifest: ArtifactPackageManifest = {
  version: 2,
  format: ARTIFACT_MANIFEST_FORMAT,
  scopeId: "scope",
  repositoryId: "repository",
  artifactId: "skill",
  kind: "skill-document",
  entryPath: "SKILL.md",
  contentEncoding: "utf8-v1",
  contentDigest: "a".repeat(64),
  manifestDigestVersion: ARTIFACT_MANIFEST_DIGEST,
  modelBase: {
    version: `commit:${"b".repeat(40)}`,
    sourceDigest: "c".repeat(64),
  },
};

Deno.test("common repository and package manifests are canonical explicit v2 contracts", async () => {
  const digest = await packageManifestDigest(manifest);
  const root = repositoryManifest("repository", [digest]);
  deepStrictEqual(parseRepositoryManifest(canonical(root), "repository"), root);
  deepStrictEqual(
    parsePackageManifest(canonical(manifest), "repository"),
    manifest,
  );
  const ref = packageReference(manifest, digest, "d".repeat(40));
  validateSourceReference(ref);
  equal(ref.entryPath, `artifacts/${digest}/SKILL.md`);
  equal(ref.manifestPath, `artifacts/${digest}/manifest.json`);
  for (
    const changed of [
      { ...ref, version: 1 },
      { ...ref, entryPath: "../SKILL.md" },
      { ...ref, manifestPath: "manifest.json" },
      { ...ref, extra: true },
      { ...ref, contentEncoding: "tool-draft-json-v1" },
    ]
  ) throws(() => validateSourceReference(changed), ArtifactSourceError);
  for (
    const changed of [
      { ...manifest, version: 1 },
      { ...manifest, extra: true },
      { ...manifest, entryPath: "../SKILL.md" },
      { ...manifest, repositoryId: "other" },
      { ...manifest, modelBase: { ...manifest.modelBase, extra: true } },
    ]
  ) {
    throws(
      () => parsePackageManifest(canonical(changed), "repository"),
      ArtifactSourceError,
    );
  }
  throws(
    () => parsePackageManifest(JSON.stringify(manifest), "repository"),
    ArtifactSourceError,
  );
  throws(
    () =>
      parseRepositoryManifest(canonical({ ...root, version: 3 }), "repository"),
    ArtifactSourceError,
  );
  throws(
    () => repositoryManifest("repository", [digest, digest]),
    ArtifactSourceError,
  );
});

Deno.test("source codecs preserve existing tool and UTF-8 skill digest encodings", async () => {
  const content = "# Skill\nCafé 台灣\n";
  equal(
    (await encodeArtifactSource({
      artifactId: "skill",
      kind: "skill-document",
      content,
    })).digest,
    await skillContentDigest(content),
  );
  const draft = {
    name: "tool",
    description: "description",
    kind: "read_web_page" as const,
    code: "return 1;",
  };
  equal(
    (await encodeArtifactSource({
      artifactId: "tool",
      kind: "tool-draft",
      content: draft,
    })).digest,
    await toolDraftDigest(draft),
  );
});
