import { matchesExactRevision } from "../../../domain/shared-kernel/revision-id.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import {
  ARTIFACT_MANIFEST_DIGEST,
  ARTIFACT_MANIFEST_FORMAT,
  artifactEntry,
  artifactPrefix,
  type ArtifactSourceKind,
  type ArtifactSourceReference,
  requireSource,
  sourceDigest,
  sourceIdentity,
} from "../../../domain/work/artifacts/source-reference.ts";

export const REPOSITORY_FORMAT_PATH = ".assembly-repository.json";
export const MAX_PACKAGE_MANIFEST_BYTES = 8192;
export const MAX_REPOSITORY_MANIFEST_BYTES = 65_536;
export const MAX_ARTIFACT_PACKAGES = 64;
export const MAX_ARTIFACT_TOTAL_BYTES = 32 * 1_048_576;
export interface ArtifactPackageManifest {
  version: 2;
  format: typeof ARTIFACT_MANIFEST_FORMAT;
  scopeId: string;
  repositoryId: string;
  artifactId: string;
  kind: ArtifactSourceKind;
  entryPath: "source.json" | "SKILL.md";
  contentEncoding: "tool-draft-json-v1" | "utf8-v1";
  contentDigest: string;
  manifestDigestVersion: typeof ARTIFACT_MANIFEST_DIGEST;
  /** Provenance only; copied contracts never become another authority. */
  modelBase: { version: string; sourceDigest: string };
  command?: { commandId: string; commandDigest: string };
}
export interface CommonRepositoryManifest {
  version: 2;
  kind: "assembly-common-git";
  repositoryId: string;
  modelSources: "sources/";
  packages: string[];
}
function parse(text: string, maximum: number): unknown {
  requireSource(new TextEncoder().encode(text).length <= maximum, "limit");
  try {
    return JSON.parse(text);
  } catch {
    requireSource(false, "integrity");
  }
}
export function repositoryManifest(
  repositoryId: string,
  packages: readonly string[],
): CommonRepositoryManifest {
  requireSource(
    sourceIdentity(repositoryId) && packages.length <= MAX_ARTIFACT_PACKAGES &&
      packages.every(sourceDigest) &&
      new Set(packages).size === packages.length,
    "integrity",
  );
  return {
    version: 2,
    kind: "assembly-common-git",
    repositoryId,
    modelSources: "sources/",
    packages: [...packages].sort(),
  };
}
export function parseRepositoryManifest(
  text: string,
  repositoryId: string,
): CommonRepositoryManifest {
  const input = parse(
    text,
    MAX_REPOSITORY_MANIFEST_BYTES,
  ) as CommonRepositoryManifest;
  requireSource(
    !!input && typeof input === "object" && Array.isArray(input.packages),
    "integrity",
  );
  const expected = repositoryManifest(repositoryId, input.packages);
  requireSource(
    canonical(input) === canonical(expected) && text === canonical(expected),
    "integrity",
  );
  return expected;
}
export function parsePackageManifest(
  text: string,
  repositoryId: string,
): ArtifactPackageManifest {
  const input = parse(
    text,
    MAX_PACKAGE_MANIFEST_BYTES,
  ) as ArtifactPackageManifest;
  requireSource(
    !!input && typeof input === "object" && input.version === 2 &&
      input.format === ARTIFACT_MANIFEST_FORMAT &&
      input.repositoryId === repositoryId &&
      sourceIdentity(input.scopeId) && sourceIdentity(input.artifactId) &&
      sourceDigest(input.contentDigest) &&
      input.manifestDigestVersion === ARTIFACT_MANIFEST_DIGEST &&
      ((input.kind === "tool-draft" && input.entryPath === "source.json" &&
        input.contentEncoding === "tool-draft-json-v1") ||
        (input.kind === "skill-document" && input.entryPath === "SKILL.md" &&
          input.contentEncoding === "utf8-v1")) &&
      !!input.modelBase && typeof input.modelBase.version === "string" &&
      matchesExactRevision(input.modelBase.version) &&
      sourceDigest(input.modelBase.sourceDigest),
    "integrity",
  );
  const expected: ArtifactPackageManifest = {
    version: 2,
    format: ARTIFACT_MANIFEST_FORMAT,
    scopeId: input.scopeId,
    repositoryId,
    artifactId: input.artifactId,
    kind: input.kind,
    entryPath: artifactEntry(input.kind),
    contentEncoding: input.contentEncoding,
    contentDigest: input.contentDigest,
    manifestDigestVersion: ARTIFACT_MANIFEST_DIGEST,
    modelBase: {
      version: input.modelBase.version,
      sourceDigest: input.modelBase.sourceDigest,
    },
  };
  if (input.command !== undefined) {
    requireSource(
      !!input.command && typeof input.command.commandId === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.command.commandId) &&
        !input.command.commandId.includes("..") &&
        !input.command.commandId.endsWith(".") &&
        !input.command.commandId.endsWith(".lock") &&
        sourceDigest(input.command.commandDigest),
      "integrity",
    );
    expected.command = {
      commandId: input.command.commandId,
      commandDigest: input.command.commandDigest,
    };
  }
  requireSource(text === canonical(expected), "integrity");
  return expected;
}
export async function packageManifestDigest(
  manifest: ArtifactPackageManifest,
): Promise<string> {
  const text = canonical(manifest);
  parsePackageManifest(text, manifest.repositoryId);
  return await sha256(text);
}
export function packageReference(
  manifest: ArtifactPackageManifest,
  manifestDigest: string,
  commitOid: string,
): ArtifactSourceReference {
  const prefix = artifactPrefix(manifestDigest);
  return {
    version: 2,
    scopeId: manifest.scopeId,
    repositoryId: manifest.repositoryId,
    artifactId: manifest.artifactId,
    kind: manifest.kind,
    commitOid,
    entryPath: prefix + manifest.entryPath,
    manifestPath: prefix + "manifest.json",
    contentEncoding: manifest.contentEncoding,
    contentDigest: manifest.contentDigest,
    manifestFormat: ARTIFACT_MANIFEST_FORMAT,
    manifestDigestVersion: ARTIFACT_MANIFEST_DIGEST,
    manifestDigest,
  };
}
