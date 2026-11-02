import { isSha256Hex } from "../../primitives/execution-digest.ts";
/** Source identity and provenance never confer admission, loading or execution rights. */
export type ArtifactSourceKind = "tool-draft" | "skill-document";
export const ARTIFACT_MANIFEST_FORMAT = "assembly-artifact-package-v2";
export const ARTIFACT_MANIFEST_DIGEST = "sha256-canonical-json-v1";
export interface ArtifactSourceReference {
  version: 2;
  scopeId: string;
  repositoryId: string;
  artifactId: string;
  kind: ArtifactSourceKind;
  commitOid: string;
  entryPath: string;
  manifestPath: string;
  contentEncoding: "tool-draft-json-v1" | "utf8-v1";
  contentDigest: string;
  manifestFormat: typeof ARTIFACT_MANIFEST_FORMAT;
  manifestDigestVersion: typeof ARTIFACT_MANIFEST_DIGEST;
  manifestDigest: string;
}
/** Immutable target-local receipt; the current catalog still owns admission/load. */
export interface ArtifactSourceBindingReference {
  version: 1;
  bindingId: string;
  versionId: string;
  revision: number;
  ownerId: string;
  localArtifactId: string;
  invocationId: string;
  reference: ArtifactSourceReference;
}
export type ArtifactSourceErrorCode =
  | "invalid"
  | "scope"
  | "not-found"
  | "integrity"
  | "limit"
  | "repository";
export class ArtifactSourceError extends Error {
  constructor(readonly code: ArtifactSourceErrorCode) {
    super(`Artifact source: ${code}`);
    this.name = "ArtifactSourceError";
  }
}
export function requireSource(
  condition: unknown,
  code: ArtifactSourceErrorCode,
): asserts condition {
  if (!condition) throw new ArtifactSourceError(code);
}
export function sourceIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value.trim() === value && !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ||
        (character.length === 1 && code >= 0xd800 && code <= 0xdfff);
    });
}
export function sourceDigest(value: unknown): value is string {
  return isSha256Hex(value);
}
export function artifactEntry(
  kind: ArtifactSourceKind,
): "source.json" | "SKILL.md" {
  return kind === "tool-draft" ? "source.json" : "SKILL.md";
}
export function artifactPrefix(manifestDigest: string): string {
  requireSource(sourceDigest(manifestDigest), "invalid");
  return `artifacts/${manifestDigest}/`;
}
export function validateSourceReference(
  value: unknown,
): asserts value is ArtifactSourceReference {
  requireSource(
    !!value && typeof value === "object" && !Array.isArray(value),
    "invalid",
  );
  const ref = value as ArtifactSourceReference;
  const fields = [
    "version",
    "scopeId",
    "repositoryId",
    "artifactId",
    "kind",
    "commitOid",
    "entryPath",
    "manifestPath",
    "contentEncoding",
    "contentDigest",
    "manifestFormat",
    "manifestDigestVersion",
    "manifestDigest",
  ];
  requireSource(
    Object.keys(ref).length === fields.length &&
      Object.keys(ref).every((key) => fields.includes(key)),
    "invalid",
  );
  requireSource(
    ref.version === 2 && sourceIdentity(ref.scopeId) &&
      sourceIdentity(ref.repositoryId) && sourceIdentity(ref.artifactId) &&
      typeof ref.commitOid === "string" &&
      /^[0-9a-f]{40}$/.test(ref.commitOid) &&
      sourceDigest(ref.contentDigest) && sourceDigest(ref.manifestDigest) &&
      ref.manifestFormat === ARTIFACT_MANIFEST_FORMAT &&
      ref.manifestDigestVersion === ARTIFACT_MANIFEST_DIGEST &&
      ((ref.kind === "tool-draft" &&
        ref.contentEncoding === "tool-draft-json-v1") ||
        (ref.kind === "skill-document" && ref.contentEncoding === "utf8-v1")),
    "invalid",
  );
  const prefix = artifactPrefix(ref.manifestDigest);
  requireSource(
    ref.manifestPath === `${prefix}manifest.json` &&
      ref.entryPath === `${prefix}${artifactEntry(ref.kind)}`,
    "invalid",
  );
}

export function validateSourceBindingReference(
  value: unknown,
): asserts value is ArtifactSourceBindingReference {
  requireSource(
    !!value && typeof value === "object" && !Array.isArray(value),
    "invalid",
  );
  const binding = value as ArtifactSourceBindingReference;
  const fields = [
    "version",
    "bindingId",
    "versionId",
    "revision",
    "ownerId",
    "localArtifactId",
    "invocationId",
    "reference",
  ];
  requireSource(
    Object.keys(binding).length === fields.length &&
      Object.keys(binding).every((key) => fields.includes(key)) &&
      binding.version === 1 && sourceIdentity(binding.bindingId) &&
      sourceIdentity(binding.versionId) &&
      Number.isSafeInteger(binding.revision) && binding.revision > 0 &&
      sourceIdentity(binding.ownerId) &&
      sourceIdentity(binding.localArtifactId) &&
      sourceIdentity(binding.invocationId),
    "invalid",
  );
  validateSourceReference(binding.reference);
}
