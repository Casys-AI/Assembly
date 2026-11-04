import { assertClosedRecord } from "../../primitives/closed-record.ts";
import { isSha256Hex } from "../../primitives/execution-digest.ts";
/** Harmonized model/build/element identities shared by W2, W5 and W6.
 *
 * Pure value types and boundary validators: no I/O, no RDF, no hashing.
 * Element identity is `(revision | build, nativeId)`; the declared name and
 * the metaclass are attributes, never substitutes. These identities are
 * distinct from `OperatorId`/mandates (business authority), from ephemeral
 * native session references (adapter-internal, never persisted or exposed),
 * and from the native `stateDigest`, which is not the artifact digest `A`.
 */
import type { BuildDescriptor } from "./build.ts";
import {
  type ModelRevisionId,
  parseModelRevisionId,
} from "../../shared-kernel/revision-id.ts";

/** An immutable model commit in one repository. */
export interface ModelRevisionRef {
  readonly repositoryId: string;
  readonly version: ModelRevisionId;
}

/** One verified build: sources `S`, recipe `R`, key `K`, artifact `A`.
 * Mirrors `BuildDescriptor` fields without carrying the recipe body. */
export interface BuildRef {
  readonly repositoryId: string;
  readonly sourceDigest: string;
  readonly recipeDigest: string;
  readonly buildKey: string;
  readonly artifactDigest: string;
}

/** One element of one verified build (`A.elements`). The build descriptor
 * relates a build to its commit sources; two commits may share a build. */
export interface BuildElementRef {
  readonly build: BuildRef;
  readonly nativeId: string;
}

/** One immutable derived projection of an artifact. The projection digest
 * authenticates the projection bytes; it is distinct from `A`. */
export interface ProjectionRef {
  readonly kind: string;
  readonly projectorVersion: string;
  readonly artifactDigest: string;
  readonly projectionDigest: string;
}

/** Whether an element IRI denotes a repository element or a normative
 * library element. Library elements are never repository-scoped. */
export type ElementIriScope = "user" | "library";

export class ModelRefError extends Error {
  readonly recovery =
    "Fix the reference at the boundary and re-derive it from the revision or build descriptor; do not synthesize ids from names.";
  constructor(
    readonly code: "MODEL_REF_INVALID",
    readonly context: { readonly reason: string; readonly path?: string },
    message: string,
  ) {
    super(message);
    this.name = "ModelRefError";
  }
}

const MAX_REPOSITORY_ID = 512;
const MAX_NATIVE_ID = 2048;

export function invalid(reason: string, path?: string): never {
  throw new ModelRefError(
    "MODEL_REF_INVALID",
    path ? { reason, path } : { reason },
    path ? `Invalid model reference: ${path}` : "Invalid model reference",
  );
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("Expected an object", path || undefined);
  }
  return value as Record<string, unknown>;
}

function field(
  owner: Record<string, unknown>,
  name: string,
  path: string,
): unknown {
  if (!Object.hasOwn(owner, name)) invalid("Missing field", path);
  return owner[name];
}

function closedKeys(
  owner: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  assertClosedRecord(
    owner,
    allowed,
    (key) => invalid(`Unexpected field ${key}`, path),
  );
}

export function requireRepositoryId(value: unknown, path: string): string {
  if (
    typeof value !== "string" || !value || value.length > MAX_REPOSITORY_ID
  ) {
    invalid(`Expected 1–${MAX_REPOSITORY_ID} characters`, path);
  }
  return value as string;
}

export function requireNativeId(value: unknown, path: string): string {
  if (
    typeof value !== "string" || !value || value.length > MAX_NATIVE_ID ||
    value.includes("\0")
  ) {
    invalid(`Expected 1–${MAX_NATIVE_ID} characters without NUL`, path);
  }
  return value as string;
}

export function requireDigest(value: unknown, path: string): string {
  if (!isSha256Hex(value)) {
    invalid("Expected 64 lowercase hex characters", path);
  }
  return value as string;
}

function requireVersion(value: unknown, path: string): ModelRevisionId {
  if (typeof value !== "string") invalid("Expected a revision id", path);
  try {
    return parseModelRevisionId(value as string);
  } catch {
    invalid("Expected an immutable model commit identity", path);
  }
}

export function parseModelRevisionRef(value: unknown): ModelRevisionRef {
  const owner = record(value, "");
  closedKeys(owner, ["repositoryId", "version"], "");
  return Object.freeze({
    repositoryId: requireRepositoryId(
      field(owner, "repositoryId", "repositoryId"),
      "repositoryId",
    ),
    version: requireVersion(field(owner, "version", "version"), "version"),
  });
}

export function parseBuildRef(value: unknown): BuildRef {
  const owner = record(value, "");
  closedKeys(owner, [
    "repositoryId",
    "sourceDigest",
    "recipeDigest",
    "buildKey",
    "artifactDigest",
  ], "");
  return Object.freeze({
    repositoryId: requireRepositoryId(
      field(owner, "repositoryId", "repositoryId"),
      "repositoryId",
    ),
    sourceDigest: requireDigest(
      field(owner, "sourceDigest", "sourceDigest"),
      "sourceDigest",
    ),
    recipeDigest: requireDigest(
      field(owner, "recipeDigest", "recipeDigest"),
      "recipeDigest",
    ),
    buildKey: requireDigest(
      field(owner, "buildKey", "buildKey"),
      "buildKey",
    ),
    artifactDigest: requireDigest(
      field(owner, "artifactDigest", "artifactDigest"),
      "artifactDigest",
    ),
  });
}

export function buildRefFromDescriptor(
  descriptor: BuildDescriptor,
): BuildRef {
  return parseBuildRef({
    repositoryId: descriptor.repositoryId,
    sourceDigest: descriptor.sourceDigest,
    recipeDigest: descriptor.recipe.digest,
    buildKey: descriptor.buildKey,
    artifactDigest: descriptor.artifactDigest,
  });
}

export function parseProjectionRef(value: unknown): ProjectionRef {
  const owner = record(value, "");
  closedKeys(owner, [
    "kind",
    "projectorVersion",
    "artifactDigest",
    "projectionDigest",
  ], "");
  const kind = field(owner, "kind", "kind");
  if (
    typeof kind !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(kind)
  ) {
    invalid("Expected a lowercase projection kind", "kind");
  }
  const projectorVersion = field(
    owner,
    "projectorVersion",
    "projectorVersion",
  );
  if (
    typeof projectorVersion !== "string" || !projectorVersion ||
    projectorVersion.length > 128
  ) {
    invalid("Expected 1–128 characters", "projectorVersion");
  }
  return Object.freeze({
    kind: kind as string,
    projectorVersion: projectorVersion as string,
    artifactDigest: requireDigest(
      field(owner, "artifactDigest", "artifactDigest"),
      "artifactDigest",
    ),
    projectionDigest: requireDigest(
      field(owner, "projectionDigest", "projectionDigest"),
      "projectionDigest",
    ),
  });
}

export function buildRefKey(ref: BuildRef): string {
  return JSON.stringify([
    ref.repositoryId,
    ref.sourceDigest,
    ref.recipeDigest,
    ref.buildKey,
    ref.artifactDigest,
  ]);
}
export function sameBuildRef(left: BuildRef, right: BuildRef): boolean {
  return buildRefKey(left) === buildRefKey(right);
}
