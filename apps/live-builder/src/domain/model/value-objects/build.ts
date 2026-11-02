import { assertClosedRecord } from "../../primitives/closed-record.ts";
import { canonical } from "../../primitives/canonical-json.ts";
import type {
  CompilerDescriptor,
  JsonObject,
} from "../records/compiled-model.ts";
import {
  canonicalDigest,
  isSha256Hex,
  sha256,
} from "../../primitives/execution-digest.ts";

/** Deterministic build identity: recipe R, key K, artifact A, descriptor. No I/O. */
const RECIPE_SCHEMA = 1;
export const ARTIFACT_SCHEMA = 1;
const BUILD_INPUT_KIND = "ase-build-input-v1";
const BUILD_DESCRIPTOR_KIND = "ase-model-build";
const BUILD_DESCRIPTOR_VERSION = 1;

interface BuildToolkitIdentity {
  readonly version: string;
  readonly bundleDigest: string;
}
export interface BuildRecipeInputs {
  readonly toolkit: BuildToolkitIdentity;
  readonly format: string;
  readonly normalizerVersion: number;
  readonly irVersion: string;
  readonly artifactSchema: number;
  readonly engineVersion: string;
}
interface BuildDescriptorRecipe extends BuildRecipeInputs {
  readonly digest: string;
}
export interface BuildDescriptor {
  readonly v: 1;
  readonly kind: "ase-model-build";
  readonly repositoryId: string;
  readonly sourceDigest: string;
  readonly recipe: BuildDescriptorRecipe;
  readonly buildKey: string;
  readonly artifactDigest: string;
  readonly bytes: number;
}
interface BuildArtifactInputs {
  readonly provider?: CompilerDescriptor;
  readonly engineVersion: string;
  readonly elements: JsonObject[];
}

export class ModelBuildError extends Error {
  readonly recovery: string;
  constructor(
    readonly code: "BUILD_RECIPE_INVALID" | "BUILD_DESCRIPTOR_INVALID",
    readonly context: { readonly reason: string; readonly path?: string },
    message: string,
  ) {
    super(message);
    this.name = "ModelBuildError";
    this.recovery = code === "BUILD_RECIPE_INVALID"
      ? "Fix the recipe inputs and recompute the digest."
      : "Rebuild the descriptor from the commit sources and recipe, then retry.";
  }
}

function requireText(
  value: unknown,
  path: string,
  limit: number,
  code: ModelBuildError["code"] = "BUILD_RECIPE_INVALID",
): string {
  if (
    typeof value !== "string" || !value || value.length > limit
  ) {
    throw new ModelBuildError(
      code,
      { reason: `Expected 1–${limit} characters`, path },
      `Invalid build recipe field: ${path}`,
    );
  }
  return value;
}

function requireVersionNumber(
  value: unknown,
  path: string,
  code: ModelBuildError["code"] = "BUILD_RECIPE_INVALID",
): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
  ) {
    throw new ModelBuildError(
      code,
      { reason: "Expected a safe integer >= 0", path },
      `Invalid build recipe field: ${path}`,
    );
  }
  return value;
}

function requireDigest(
  value: unknown,
  path: string,
  code: ModelBuildError["code"] = "BUILD_RECIPE_INVALID",
): string {
  if (!isSha256Hex(value)) {
    throw new ModelBuildError(
      code,
      { reason: "Expected 64 lowercase hex characters", path },
      `Invalid build digest: ${path}`,
    );
  }
  return value;
}

/** R: the pipeline identity; every future compile option enters here. */
export async function recipeDigest(recipe: BuildRecipeInputs): Promise<string> {
  requireText(recipe.toolkit.version, "toolkit.version", 64);
  requireDigest(recipe.toolkit.bundleDigest, "toolkit.bundleDigest");
  requireText(recipe.format, "format", 128);
  requireVersionNumber(recipe.normalizerVersion, "normalizerVersion");
  requireText(recipe.irVersion, "irVersion", 32);
  requireVersionNumber(recipe.artifactSchema, "artifactSchema");
  requireText(recipe.engineVersion, "engineVersion", 64);
  return await canonicalDigest({
    recipeSchema: RECIPE_SCHEMA,
    toolkit: {
      version: recipe.toolkit.version,
      bundleDigest: recipe.toolkit.bundleDigest,
    },
    format: recipe.format,
    normalizerVersion: recipe.normalizerVersion,
    irVersion: recipe.irVersion,
    artifactSchema: recipe.artifactSchema,
    engineVersion: recipe.engineVersion,
  });
}

/** K: the build input identity, from the source digest S and the recipe R. */
export async function buildKey(
  sourceDigest: string,
  recipe: string,
): Promise<string> {
  requireDigest(sourceDigest, "sourceDigest");
  requireDigest(recipe, "recipe");
  return await canonicalDigest({
    kind: BUILD_INPUT_KIND,
    sourceDigest,
    recipe,
  });
}

/** Canonical A payload; A authenticates these exact uncompressed bytes. */
export function artifactPayload(input: BuildArtifactInputs): string {
  requireText(input.engineVersion, "engineVersion", 64);
  if (!Array.isArray(input.elements)) {
    throw new ModelBuildError(
      "BUILD_RECIPE_INVALID",
      { reason: "Expected an elements array", path: "elements" },
      "Invalid build artifact inputs: elements",
    );
  }
  return canonical({
    v: ARTIFACT_SCHEMA,
    ...(input.provider ? { provider: { ...input.provider } } : {}),
    engineVersion: input.engineVersion,
    elements: input.elements,
  });
}

/** A: the artifact identity, over uncompressed bytes; storage may compress. */
export async function artifactDigest(
  input: BuildArtifactInputs,
): Promise<string> {
  return await sha256(artifactPayload(input));
}

export function buildDescriptor(input: {
  repositoryId: string;
  sourceDigest: string;
  recipe: BuildRecipeInputs;
  recipeDigest: string;
  buildKey: string;
  artifactDigest: string;
  bytes: number;
}): BuildDescriptor {
  if (
    typeof input.repositoryId !== "string" || !input.repositoryId ||
    input.repositoryId.length > 512
  ) {
    throw new ModelBuildError(
      "BUILD_DESCRIPTOR_INVALID",
      { reason: "Expected 1–512 characters", path: "repositoryId" },
      "Invalid build descriptor: repositoryId",
    );
  }
  if (
    typeof input.bytes !== "number" || !Number.isSafeInteger(input.bytes) ||
    input.bytes < 0
  ) {
    throw new ModelBuildError(
      "BUILD_DESCRIPTOR_INVALID",
      { reason: "Expected a safe integer >= 0", path: "bytes" },
      "Invalid build descriptor: bytes",
    );
  }
  return {
    v: BUILD_DESCRIPTOR_VERSION,
    kind: BUILD_DESCRIPTOR_KIND,
    repositoryId: input.repositoryId,
    sourceDigest: requireDigest(
      input.sourceDigest,
      "sourceDigest",
      "BUILD_DESCRIPTOR_INVALID",
    ),
    recipe: {
      toolkit: {
        version: requireText(
          input.recipe.toolkit.version,
          "recipe.toolkit.version",
          64,
          "BUILD_DESCRIPTOR_INVALID",
        ),
        bundleDigest: requireDigest(
          input.recipe.toolkit.bundleDigest,
          "recipe.toolkit.bundleDigest",
          "BUILD_DESCRIPTOR_INVALID",
        ),
      },
      format: requireText(
        input.recipe.format,
        "recipe.format",
        128,
        "BUILD_DESCRIPTOR_INVALID",
      ),
      normalizerVersion: requireVersionNumber(
        input.recipe.normalizerVersion,
        "recipe.normalizerVersion",
        "BUILD_DESCRIPTOR_INVALID",
      ),
      irVersion: requireText(
        input.recipe.irVersion,
        "recipe.irVersion",
        32,
        "BUILD_DESCRIPTOR_INVALID",
      ),
      artifactSchema: requireVersionNumber(
        input.recipe.artifactSchema,
        "recipe.artifactSchema",
        "BUILD_DESCRIPTOR_INVALID",
      ),
      engineVersion: requireText(
        input.recipe.engineVersion,
        "recipe.engineVersion",
        64,
        "BUILD_DESCRIPTOR_INVALID",
      ),
      digest: requireDigest(
        input.recipeDigest,
        "recipe.digest",
        "BUILD_DESCRIPTOR_INVALID",
      ),
    },
    buildKey: requireDigest(
      input.buildKey,
      "buildKey",
      "BUILD_DESCRIPTOR_INVALID",
    ),
    artifactDigest: requireDigest(
      input.artifactDigest,
      "artifactDigest",
      "BUILD_DESCRIPTOR_INVALID",
    ),
    bytes: input.bytes,
  };
}

function reject(
  reason: string,
  path?: string,
): never {
  throw new ModelBuildError(
    "BUILD_DESCRIPTOR_INVALID",
    path ? { reason, path } : { reason },
    path ? `Invalid build descriptor: ${path}` : "Invalid build descriptor",
  );
}

function field(record: Record<string, unknown>, path: string): unknown {
  if (!Object.hasOwn(record, path)) reject("Missing field", path);
  return record[path];
}

function closedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  assertClosedRecord(
    record,
    allowed,
    (key) => reject(`Unexpected field ${key}`, path),
  );
}

/** Strict descriptor parse: closed keys, typed fields, hex digests. */
export function parseBuildDescriptorStrict(value: unknown): BuildDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    reject("Expected an object");
  }
  const record = value as Record<string, unknown>;
  closedKeys(record, [
    "v",
    "kind",
    "repositoryId",
    "sourceDigest",
    "recipe",
    "buildKey",
    "artifactDigest",
    "bytes",
  ], "");
  if (field(record, "v") !== BUILD_DESCRIPTOR_VERSION) {
    reject("Bad version", "v");
  }
  if (field(record, "kind") !== BUILD_DESCRIPTOR_KIND) {
    reject("Bad kind", "kind");
  }
  const recipe = field(record, "recipe");
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
    reject("Expected an object", "recipe");
  }
  const recipeRecord = recipe as Record<string, unknown>;
  closedKeys(recipeRecord, [
    "digest",
    "toolkit",
    "format",
    "normalizerVersion",
    "irVersion",
    "artifactSchema",
    "engineVersion",
  ], "recipe");
  const toolkit = field(recipeRecord, "toolkit");
  if (!toolkit || typeof toolkit !== "object" || Array.isArray(toolkit)) {
    reject("Expected an object", "recipe.toolkit");
  }
  const toolkitRecord = toolkit as Record<string, unknown>;
  closedKeys(toolkitRecord, ["version", "bundleDigest"], "recipe.toolkit");
  try {
    return buildDescriptor({
      repositoryId: field(record, "repositoryId") as string,
      sourceDigest: field(record, "sourceDigest") as string,
      recipe: {
        toolkit: {
          version: field(toolkitRecord, "version") as string,
          bundleDigest: field(toolkitRecord, "bundleDigest") as string,
        },
        format: field(recipeRecord, "format") as string,
        normalizerVersion: field(recipeRecord, "normalizerVersion") as number,
        irVersion: field(recipeRecord, "irVersion") as string,
        artifactSchema: field(recipeRecord, "artifactSchema") as number,
        engineVersion: field(recipeRecord, "engineVersion") as string,
      },
      recipeDigest: field(recipeRecord, "digest") as string,
      buildKey: field(record, "buildKey") as string,
      artifactDigest: field(record, "artifactDigest") as string,
      bytes: field(record, "bytes") as number,
    });
  } catch (error) {
    if (error instanceof ModelBuildError) throw error;
    reject("Malformed descriptor");
  }
}
