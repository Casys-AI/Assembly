import {
  type BuildElementRef,
  type BuildRef,
  type ElementIriScope,
  invalid,
  ModelRefError,
  requireDigest,
  requireNativeId,
  requireRepositoryId,
} from "../../../domain/model/value-objects/element-ref.ts";

type ParsedElementIri =
  | {
    readonly scope: "user";
    readonly repositoryId: string;
    readonly nativeId: string;
  }
  | { readonly scope: "library"; readonly nativeId: string };

// --- Reversible IRI codec (pure strings; RDF stays in adapters) ---
//
// Segments are UTF-8 percent-encoded outside [A-Za-z0-9._-], so ':' never
// appears inside a segment and splitting on ':' is unambiguous. Distinct
// (repositoryId, nativeId) pairs cannot collide, including when either
// side itself contains ':' or '%'.

const SEGMENT_SAFE = /^[A-Za-z0-9._-]$/;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeIriSegment(value: string): string {
  let out = "";
  for (const byte of utf8Encoder.encode(value)) {
    const char = String.fromCharCode(byte);
    out += SEGMENT_SAFE.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export function decodeIriSegment(segment: string, path = "iri"): string {
  const bytes: number[] = [];
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index] as string;
    if (char === "%") {
      const hex = segment.slice(index + 1, index + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) {
        invalid("Bad percent-encoding in IRI segment", path);
      }
      bytes.push(parseInt(hex, 16));
      index += 2;
    } else if (SEGMENT_SAFE.test(char)) {
      bytes.push(char.charCodeAt(0));
    } else {
      invalid(`Unencoded character ${JSON.stringify(char)} in IRI`, path);
    }
  }
  try {
    const text = utf8Decoder.decode(new Uint8Array(bytes));
    // Re-encoding must reproduce the segment exactly (canonical form).
    if (encodeIriSegment(text) !== segment) {
      invalid("Non-canonical IRI segment encoding", path);
    }
    return text;
  } catch (error) {
    if (error instanceof ModelRefError) throw error;
    invalid("IRI segment is not valid UTF-8", path);
  }
}

/** Named graph of one build's RDF projection: `urn:ase:build:<A>`. */
export function buildGraphIri(build: BuildRef | string): string {
  const artifactDigest = typeof build === "string"
    ? requireDigest(build, "artifactDigest")
    : build.artifactDigest;
  return `urn:ase:build:${artifactDigest}`;
}

/** Repository-scoped element IRI: `urn:ase:model:<repo>:<nativeId>`.
 * Stable across builds of the same repository; the named graph carries
 * the build version. */
export function userElementIri(
  repositoryId: string,
  nativeId: string,
): string {
  requireRepositoryId(repositoryId, "repositoryId");
  requireNativeId(nativeId, "nativeId");
  return `urn:ase:model:${encodeIriSegment(repositoryId)}:${
    encodeIriSegment(nativeId)
  }`;
}

/** Normative library element IRI: `urn:ase:library:<nativeId>`. */
export function libraryElementIri(nativeId: string): string {
  requireNativeId(nativeId, "nativeId");
  return `urn:ase:library:${encodeIriSegment(nativeId)}`;
}

function elementIri(
  repositoryId: string,
  nativeId: string,
  scope: ElementIriScope,
): string {
  return scope === "library"
    ? libraryElementIri(nativeId)
    : userElementIri(repositoryId, nativeId);
}

export function buildElementIri(
  ref: BuildElementRef,
  scope: ElementIriScope = "user",
): string {
  return elementIri(ref.build.repositoryId, ref.nativeId, scope);
}

export function parseElementIri(iri: string): ParsedElementIri {
  const parts = iri.split(":");
  if (parts[0] !== "urn" || parts[1] !== "ase") {
    invalid("Expected an urn:ase element IRI", "iri");
  }
  if (parts[2] === "model" && parts.length === 5) {
    return Object.freeze({
      scope: "user" as const,
      repositoryId: requireRepositoryId(
        decodeIriSegment(parts[3] as string),
        "iri",
      ),
      nativeId: requireNativeId(
        decodeIriSegment(parts[4] as string),
        "iri",
      ),
    });
  }
  if (parts[2] === "library" && parts.length === 4) {
    return Object.freeze({
      scope: "library" as const,
      nativeId: requireNativeId(
        decodeIriSegment(parts[3] as string),
        "iri",
      ),
    });
  }
  invalid("Expected urn:ase:model:<repo>:<id> or urn:ase:library:<id>", "iri");
}

/** Verified `$id` (LDkit) → identity conversion inside one build. The
 * repository carried by a user IRI must match the build's repository;
 * library IRIs carry no repository and are accepted as library scope. */
export function buildElementRefFromIri(
  build: BuildRef,
  iri: string,
): { readonly ref: BuildElementRef; readonly scope: ElementIriScope } {
  const parsed = parseElementIri(iri);
  if (parsed.scope === "user" && parsed.repositoryId !== build.repositoryId) {
    invalid("Element IRI belongs to another repository", "iri");
  }
  return Object.freeze({
    ref: Object.freeze({ build, nativeId: parsed.nativeId }),
    scope: parsed.scope,
  });
}
