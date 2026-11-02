/** Worker-owned preparation. This module is also the port-injected seam used
 * to prove cache/lease behavior without launching a process. */
import type { BuildArtifactPayload } from "../../../application/model/builds/ports/out/build-materializer.port.ts";
import type { ModelBuildVaultPort } from "../../../application/model/builds/ports/out/build-vault.port.ts";
import {
  ModelBuildServiceError,
  sha256HexOfBytes,
  validateBuildArtifact,
  validateBuildDescriptor,
} from "../../../application/model/builds/service.ts";
import {
  BuildStoreError,
  type ModelBuildStore,
} from "../../../application/model/builds/ports/out/build-store.port.ts";
import {
  contextualProjectorVersion,
  SemanticIndexError,
} from "../../../application/model/semantic/index-service.ts";
import type { ModelRdfProjector } from "../../../application/model/semantic/ports/out/rdf-projector.port.ts";
import {
  type BuildDescriptor,
  parseBuildDescriptorStrict,
} from "../../../domain/model/value-objects/build.ts";
import {
  type BuildRef,
  buildRefFromDescriptor,
  buildRefKey,
  parseBuildRef,
  parseProjectionRef,
  type ProjectionRef,
} from "../../../domain/model/value-objects/element-ref.ts";
import {
  DeterministicRdfModelProjector,
  RDF_QUADS_KIND,
  RDF_QUADS_PROJECTOR_VERSION,
} from "./rdf.ts";
import { assertStoredBuildCompatible } from "../../model/builds/materialization/stored.ts";

export interface SemanticProjectionPreparationInput {
  readonly build: BuildRef;
  readonly descriptor: BuildDescriptor;
}
export interface PreparedSemanticProjection {
  readonly projection: ProjectionRef;
}

/** S has already been bound to repository sources by the host. The child
 * independently verifies R/K and the complete immutable build reference. */
export async function validateSemanticPreparationInput(
  input: SemanticProjectionPreparationInput,
): Promise<SemanticProjectionPreparationInput> {
  const build = parseBuildRef(input.build);
  const descriptor = await validateBuildDescriptor(
    input.descriptor,
    build.repositoryId,
    build.sourceDigest,
  );
  if (buildRefKey(buildRefFromDescriptor(descriptor)) !== buildRefKey(build)) {
    throw new ModelBuildServiceError(
      "BUILD_DESCRIPTOR_MISMATCH",
      {},
      "Preparation descriptor does not match the complete build pin",
    );
  }
  return Object.freeze({ build, descriptor });
}

/** Synchronous closed-shape snapshot before queueing, so callers cannot change
 * an admitted job while it waits. Hash validation runs inside the child. */
export function snapshotSemanticPreparationInput(
  value: unknown,
): SemanticProjectionPreparationInput {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !["build", "descriptor"].includes(key))
  ) {
    throw new SemanticIndexError(
      "INDEX_INVALID_INPUT",
      {},
      "Invalid semantic preparation input",
    );
  }
  const input = value as SemanticProjectionPreparationInput;
  return Object.freeze({
    build: parseBuildRef(input.build),
    descriptor: parseBuildDescriptorStrict(input.descriptor),
  });
}

function libraryIds(artifact: BuildArtifactPayload): string[] {
  return artifact.elements.filter((element) =>
    element.isLibraryElement === true
  ).map((element) => {
    const id = element["@id"];
    if (typeof id !== "string" || !id) {
      throw new SemanticIndexError(
        "INDEX_PROJECTION_CORRUPT",
        {},
        "Verified library element has no canonical native ID",
      );
    }
    return id;
  });
}

export interface SemanticPreparationDependencies {
  readonly store: Pick<
    ModelBuildStore,
    | "get"
    | "hasProjection"
    | "getProjection"
    | "putProjection"
    | "acquireLease"
    | "releaseLease"
  >;
  readonly vault: Pick<ModelBuildVaultPort, "getVerified">;
  readonly leaseOwner: string;
  readonly leaseTtlMs?: number;
  readonly leaseWaitAttempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly projector?: ModelRdfProjector;
}

/** No compiler, IR materializer, source mutation, sweep or projection repair.
 * Durable A recovery follows the build service; projection corruption remains
 * a failure and never authorizes repair of its immutable identity. */
export async function prepareSemanticProjection(
  input: SemanticProjectionPreparationInput,
  dependencies: SemanticPreparationDependencies,
): Promise<PreparedSemanticProjection> {
  const { build, descriptor } = await validateSemanticPreparationInput(input);
  const { store, vault, leaseOwner } = dependencies;
  const projector = dependencies.projector ??
    new DeterministicRdfModelProjector();
  if (
    projector.kind !== RDF_QUADS_KIND ||
    projector.projectorVersion !== RDF_QUADS_PROJECTOR_VERSION
  ) {
    throw new SemanticIndexError(
      "INDEX_INVALID_INPUT",
      {},
      "Unsupported semantic projector",
    );
  }
  if (typeof leaseOwner !== "string" || !leaseOwner) {
    throw new SemanticIndexError(
      "INDEX_INVALID_INPUT",
      {},
      "Preparation lease owner is required",
    );
  }
  const verifyArtifact = async (bytes: Uint8Array) => {
    const artifact = await validateBuildArtifact(bytes, descriptor);
    assertStoredBuildCompatible(artifact, descriptor);
    return artifact;
  };
  const resolveArtifact = async () => {
    let cacheFailure: BuildStoreError | ModelBuildServiceError;
    try {
      return await verifyArtifact(await store.get(descriptor.artifactDigest));
    } catch (error) {
      // Preserve the existing build-service fallback families. Compatibility
      // failures are not cache failures and must never be masked by the vault.
      if (
        error instanceof BuildStoreError && [
            "BUILD_BLOB_MISSING",
            "BUILD_BLOB_CORRUPT",
            "BUILD_STORE_UNAVAILABLE",
            "BUILD_STORE_BUSY",
          ].includes(error.code) ||
        error instanceof ModelBuildServiceError &&
          error.code === "BUILD_CORRUPT"
      ) {
        cacheFailure = error;
      } else throw error;
    }
    const restored = await vault.getVerified(descriptor.artifactDigest);
    if (restored !== null) return await verifyArtifact(restored);
    if (cacheFailure.code !== "BUILD_BLOB_MISSING") throw cacheFailure;
    throw new ModelBuildServiceError("BUILD_UNAVAILABLE", {
      artifactDigest: descriptor.artifactDigest,
      reason:
        "verified artifact missing from cache and vault; compilation prohibited",
    }, "Verified build bytes are unavailable for semantic preparation");
  };
  const artifact = await resolveArtifact();
  const libraryNativeIds = libraryIds(artifact);
  const projectorVersion = await contextualProjectorVersion(
    projector.projectorVersion,
    build,
    libraryNativeIds,
  );
  const readCached = async (): Promise<
    PreparedSemanticProjection | undefined
  > => {
    let cached: Uint8Array;
    try {
      cached = await store.getProjection(
        projector.kind,
        projectorVersion,
        build.artifactDigest,
      );
    } catch (error) {
      if (
        error instanceof BuildStoreError && error.code === "BUILD_BLOB_MISSING"
      ) {
        if (
          !await store.hasProjection(
            projector.kind,
            projectorVersion,
            build.artifactDigest,
          )
        ) {
          return undefined;
        }
        // Published metadata with absent physical bytes is an incomplete entry,
        // not permission to repair an immutable identity. A concurrent publisher
        // may have completed since the first read, so accept only a verified
        // reread; otherwise preserve its coded failure without projecting/putting.
        cached = await store.getProjection(
          projector.kind,
          projectorVersion,
          build.artifactDigest,
        );
      } else throw error;
    }
    const projectionDigest = await sha256HexOfBytes(cached);
    if (projectionDigest === build.artifactDigest) {
      throw new SemanticIndexError(
        "INDEX_PROJECTION_CORRUPT",
        {},
        "Projection digest must differ from artifact A",
      );
    }
    return {
      projection: parseProjectionRef({
        kind: projector.kind,
        projectorVersion,
        artifactDigest: build.artifactDigest,
        projectionDigest,
      }),
    };
  };
  const cached = await readCached();
  if (cached) return cached;
  const leaseKey =
    `projection:${projector.kind}:${projectorVersion}:${build.artifactDigest}`;
  const ttl = dependencies.leaseTtlMs ?? 61_000;
  const sleep = dependencies.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = dependencies.leaseWaitAttempts ?? 1200;
  let acquired = false;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    acquired = await store.acquireLease(leaseKey, leaseOwner, ttl);
    if (acquired) break;
    if (attempt === attempts) break;
    await sleep(25);
    const joined = await readCached();
    if (joined) return joined;
  }
  if (!acquired) {
    throw new SemanticIndexError("INDEX_BUSY", {
      reason: "projection lease held",
    }, "Another process is preparing this projection");
  }
  try {
    const joined = await readCached();
    if (joined) return joined;
    const produced = await projector.project({
      build,
      elements: artifact.elements,
      libraryNativeIds,
    });
    const projection = parseProjectionRef(produced.projection);
    if (
      projection.kind !== projector.kind ||
      projection.projectorVersion !== projectorVersion ||
      projection.artifactDigest !== build.artifactDigest ||
      projection.projectionDigest === build.artifactDigest ||
      projection.projectionDigest !== await sha256HexOfBytes(produced.quads)
    ) {
      throw new SemanticIndexError(
        "INDEX_PROJECTION_CORRUPT",
        {},
        "Projector output does not match its immutable projection reference",
      );
    }
    const persisted = await store.putProjection(
      projector.kind,
      projectorVersion,
      build.artifactDigest,
      produced.quads,
    );
    if (
      persisted.digest !== projection.projectionDigest ||
      persisted.bytes !== produced.quads.byteLength
    ) {
      throw new SemanticIndexError(
        "INDEX_PROJECTION_CORRUPT",
        {},
        "Persisted projection does not match the projected bytes",
      );
    }
    return { projection };
  } finally {
    await store.releaseLease(leaseKey, leaseOwner).catch(() => undefined);
  }
}
