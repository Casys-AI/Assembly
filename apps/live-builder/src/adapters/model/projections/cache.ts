/** W2f composition: immutable pure projections, versioned read facades.
 * Only small version pins and in-flight string inputs are retained here.
 * Full revisions belong to repository/reader calls and never enter this cache. */
import type { ModelBuildStore } from "../../../application/model/builds/ports/out/build-store.port.ts";
import {
  ModelProjectionRegistry,
  projectionKey,
  type ProjectionParams,
  type ProjectionStatus,
} from "../../../application/model/projections/registry.ts";
import {
  ModelRepositoryError,
  type ModelRepositoryPort,
} from "../../../application/model/repository.ts";
import type { ModelBoardReader } from "../../../application/model/projections/ports/out/model-board-reader.port.ts";
import type { AuthorityMatrixReader } from "../../../application/governance/authority-matrix.ts";
import type { ModelViewsReader } from "../../../application/model/projections/ports/out/model-views-reader.port.ts";
import type { AuthorityMatrix } from "../../../domain/governance/records/authority-matrix.ts";
import {
  artifactDigest,
  type BuildDescriptor,
} from "../../../domain/model/value-objects/build.ts";
import {
  executionDigest,
  sha256,
} from "../../../domain/primitives/execution-digest.ts";
import { parseModelRevisionId } from "../../../domain/shared-kernel/revision-id.ts";
import { ToolkitModelBoardReader } from "./board-reader.ts";
import { CompiledAuthorityMatrixReader } from "../../out/sysml-toolkit/projections/authority-matrix/reader.ts";
import {
  ToolkitModelViewDiagramReader,
  ToolkitModelViewListReader,
  ToolkitModelViewPlantumlReader,
} from "./views/readers.ts";
import type {
  AuthorityMatrixProjection,
  MatrixProcessObserver,
} from "../../out/sysml-toolkit/projections/authority-matrix/worker-client.ts";
import type { SysmlToolkitAdapter } from "../../out/sysml-toolkit/adapter.ts";

const CACHED_PROJECTION_KINDS = [
  "board",
  "authority-matrix",
  "views",
  "view-diagram",
  "plantuml",
] as const;
type CachedProjectionKind = typeof CACHED_PROJECTION_KINDS[number];
const DEFAULT_PROJECTOR_VERSIONS: Readonly<
  Record<CachedProjectionKind, string>
> = Object.freeze({
  board: "1",
  "authority-matrix": "1",
  views: "1",
  "view-diagram": "1",
  plantuml: "1",
});
interface BuildDescriptorPort {
  buildDescriptor(
    version: string,
    signal?: AbortSignal,
  ): Promise<BuildDescriptor | null>;
}
interface ProjectionPin {
  version: string;
  sourceDigest: string;
  artifactDigest?: string;
  origin: "descriptor" | "computed" | "legacy";
}
export interface CachedModelProjectionsOptions {
  repository:
    & Pick<ModelRepositoryPort, "at" | "header">
    & Partial<BuildDescriptorPort>
    & { descriptorAt?(version: string): Promise<BuildDescriptor | null> };
  repositoryId: string;
  projectId: string;
  tooling: Pick<
    SysmlToolkitAdapter,
    "board" | "views" | "diagram" | "plantuml"
  >;
  buildStore?: ModelBuildStore;
  maxBytes?: number;
  maxPins?: number;
  toolkitIdentity?: string;
  projectorVersions?: Partial<Record<CachedProjectionKind, string>>;
  authorityMatrixProject?: AuthorityMatrixProjection;
  matrixObserver?: MatrixProcessObserver;
  now?: () => number;
}
interface VersionProjectionStatus {
  kind: CachedProjectionKind;
  version: string;
  state: ProjectionStatus["state"];
  projectorVersion: string;
  artifactDigest?: string;
  params?: ProjectionParams;
  projectionDigest?: string;
  bytes?: number;
  error?: ProjectionStatus["error"];
  pinOrigin?: ProjectionPin["origin"];
}
interface CurrentVersionProjection {
  kind: CachedProjectionKind;
  state: ProjectionStatus["state"];
  requestedVersion?: string;
  availableVersion?: string;
  requestedArtifact?: string;
  availableArtifact?: string;
  error?: ProjectionStatus["error"];
}
type ViewOptions = { viewId?: string };
interface Trigger {
  version: string;
  viewId?: string;
  pin: ProjectionPin;
}
type PureMatrix = Omit<AuthorityMatrix, "version" | "digest">;

function validateVersion(version: string): void {
  try {
    parseModelRevisionId(version);
  } catch {
    throw new ModelRepositoryError(
      "INVALID_REQUEST",
      "Invalid immutable model version",
    );
  }
}
function mismatch(version: string, receivedVersion: string): never {
  throw {
    code: "MODEL_VERSION_MISMATCH",
    context: { version, receivedVersion },
    recovery:
      "Correct the projection reader to return the requested model version before requesting it again.",
  };
}

export function createCachedModelProjections(
  options: CachedModelProjectionsOptions,
) {
  const { repository, repositoryId, projectId } = options;
  const maxPins = options.maxPins ?? 64;
  if (!Number.isInteger(maxPins) || maxPins < 1) {
    throw new Error("maxPins must be a positive integer");
  }
  const registry = new ModelProjectionRegistry({
    maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
    store: options.buildStore,
  });
  const pins = new Map<string, ProjectionPin>();
  const pinWork = new Map<string, Promise<ProjectionPin>>();
  const triggers = new Map<string, Trigger>();
  const reads = new Map<string, Promise<unknown>>();
  const listeners = new Set<
    (status: ProjectionStatus & { versions: string[] }) => void
  >();
  const pointers = new Map<
    string,
    {
      requestedVersion: string;
      availableVersion?: string;
      state: ProjectionStatus["state"];
      error?: ProjectionStatus["error"];
    }
  >();
  let head: string | undefined;
  let epoch = 0;
  const rawBoard = new ToolkitModelBoardReader(
    repository,
    options.tooling,
    options.now,
  );
  const rawMatrix = new CompiledAuthorityMatrixReader(
    repository,
    projectId,
    options.authorityMatrixProject,
    options.now,
    options.matrixObserver,
  );
  const rawList = new ToolkitModelViewListReader(
    repository,
    options.tooling,
    options.now,
  );
  const rawDiagram = new ToolkitModelViewDiagramReader(
    repository,
    options.tooling,
    { read: (version) => views.list(version) },
    options.now,
  );
  const rawPlantuml = new ToolkitModelViewPlantumlReader(
    repository,
    options.tooling,
    { read: (version) => views.list(version) },
    options.now,
  );

  function retain(pin: ProjectionPin) {
    pins.delete(pin.version);
    pins.set(pin.version, Object.freeze(pin));
    while (pins.size > maxPins) pins.delete(pins.keys().next().value!);
    return pin;
  }
  async function pinFor(version: string): Promise<ProjectionPin> {
    validateVersion(version);
    const cached = pins.get(version);
    if (cached) {
      pins.delete(version);
      pins.set(version, cached);
      return cached;
    }
    const pending = pinWork.get(version);
    if (pending) return await pending;
    if (pinWork.size >= 64) {
      throw new ModelRepositoryError(
        "UPSTREAM_FAILURE",
        "Projection pin queue is full",
      );
    }
    const work = (async () => {
      const header = await repository.header(version);
      if (header.version !== version) mismatch(version, header.version);
      const descriptorReader = repository.buildDescriptor ??
        repository.descriptorAt;
      if (descriptorReader) {
        const descriptor = await descriptorReader.call(repository, version);
        if (!descriptor) {
          return retain({
            version,
            sourceDigest: header.sourceDigest,
            origin: "legacy",
          });
        }
        if (
          descriptor.repositoryId !== repositoryId ||
          descriptor.sourceDigest !== header.sourceDigest ||
          !/^[a-f0-9]{64}$/.test(descriptor.artifactDigest)
        ) {
          throw new ModelRepositoryError(
            "INVALID_REPOSITORY",
            "Projection build descriptor does not match the immutable source snapshot",
          );
        }
        return retain({
          version,
          sourceDigest: header.sourceDigest,
          artifactDigest: descriptor.artifactDigest,
          origin: "descriptor",
        });
      }
      const revision = await repository.at(version);
      if (revision.version !== version) mismatch(version, revision.version);
      if (revision.sourceDigest !== header.sourceDigest) {
        throw new ModelRepositoryError(
          "INVALID_REPOSITORY",
          "Projection artifact does not match the immutable source snapshot",
        );
      }
      return retain({
        version,
        sourceDigest: header.sourceDigest,
        artifactDigest: await artifactDigest(revision),
        origin: "computed",
      });
    })();
    pinWork.set(version, work);
    try {
      return await work;
    } finally {
      pinWork.delete(version);
    }
  }
  // Params fit the registry's bounded contract. Hash arbitrary external names,
  // keeping normal source/repository/project identifiers inspectable in events.
  const paramNames = new Map<string, string>();
  async function param(value: string): Promise<string> {
    return value.length <= 512 ? value : `sha256:${await sha256(value)}`;
  }
  async function parameters(
    pin: ProjectionPin,
    viewId?: string,
  ): Promise<ProjectionParams> {
    const params = {
      repositoryId: await param(repositoryId),
      projectId: await param(projectId),
      sourceDigest: pin.sourceDigest,
      ...(viewId === undefined ? {} : { view: await param(viewId) }),
    };
    paramNames.set(`${pin.version}\n${viewId ?? ""}`, JSON.stringify(params));
    // This memo retains only strings, bounded independently of diagram count.
    while (paramNames.size > maxPins * 8) {
      paramNames.delete(paramNames.keys().next().value!);
    }
    return params;
  }
  async function raw(
    kind: CachedProjectionKind,
    version: string,
    viewId?: string,
  ): Promise<unknown> {
    switch (kind) {
      case "board":
        return await rawBoard.read(version);
      case "authority-matrix":
        return await rawMatrix.read(version);
      case "views":
        return await rawList.list(version);
      case "view-diagram":
        return await rawDiagram.diagram(version, viewId!);
      case "plantuml":
        return await rawPlantuml.plantuml(version, viewId!);
    }
  }
  for (const kind of CACHED_PROJECTION_KINDS) {
    const baseVersion = options.projectorVersions?.[kind] ??
      DEFAULT_PROJECTOR_VERSIONS[kind];
    registry.register({
      kind,
      version: baseVersion +
        (kind !== "authority-matrix" && options.toolkitIdentity
          ? `+tk.${options.toolkitIdentity}`
          : ""),
      async compute(ctx) {
        const trigger = triggers.get(
          projectionKey(
            kind,
            ctx.projectorVersion,
            ctx.artifactDigest,
            ctx.params,
          ),
        );
        if (!trigger) {
          throw {
            code: "PROJECTION_INPUT_MISSING",
            message: "Read through the cached projection reader",
          };
        }
        const value = await raw(kind, trigger.version, trigger.viewId);
        if (kind === "authority-matrix") {
          const matrix = value as AuthorityMatrix;
          if (matrix.version !== trigger.version) {
            mismatch(trigger.version, matrix.version);
          }
          if (matrix.model.sourceDigest !== trigger.pin.sourceDigest) {
            throw new ModelRepositoryError(
              "INVALID_REPOSITORY",
              "Matrix source digest does not match projection pin",
            );
          }
          const { version: _version, digest: _digest, ...pure } = matrix;
          return pure;
        }
        if (
          kind === "board" &&
          (value as Awaited<ReturnType<ModelBoardReader["read"]>>).meta
              .sourceDigest !== trigger.pin.sourceDigest
        ) {
          throw new ModelRepositoryError(
            "INVALID_REPOSITORY",
            "Board source digest does not match projection pin",
          );
        }
        return value;
      },
    });
  }
  registry.subscribe((status) => {
    const versions = [...pins.values()].filter((pin) =>
      pin.artifactDigest === status.artifactDigest &&
      pin.sourceDigest === status.params?.sourceDigest
    ).map((pin) => pin.version);
    for (const listener of listeners) {
      try {
        listener({ ...status, versions });
      } catch { /* Subscriber isolation. */ }
    }
  });

  async function read<T>(
    kind: CachedProjectionKind,
    version: string,
    viewId?: string,
  ): Promise<T> {
    validateVersion(version);
    if ((kind === "view-diagram" || kind === "plantuml") && !viewId) {
      throw new ModelRepositoryError(
        "INVALID_REQUEST",
        "Invalid model view id",
      );
    }
    const readKey = `${kind}\n${version}\n${viewId ?? ""}`;
    const pending = reads.get(readKey);
    if (pending) return structuredClone(await pending) as T;
    if (reads.size >= 128) {
      throw new ModelRepositoryError(
        "UPSTREAM_FAILURE",
        "Projection read queue is full",
      );
    }
    const work = (async () => {
      let pin: ProjectionPin;
      try {
        pin = await pinFor(version);
      } catch {
        return await raw(kind, version, viewId);
      }
      if (!pin.artifactDigest) return await raw(kind, version, viewId);
      const params = await parameters(pin, viewId);
      const key = projectionKey(
        kind,
        registry.projectorVersion(kind)!,
        pin.artifactDigest,
        params,
      );
      // The registry owns coalescing across commits sharing A/S. Its ephemeral
      // input must survive all joiners, so only its installing caller removes it.
      const ownsTrigger = !triggers.has(key);
      if (ownsTrigger) {
        if (triggers.size >= 64) {
          throw new ModelRepositoryError(
            "UPSTREAM_FAILURE",
            "Projection computation queue is full",
          );
        }
        triggers.set(key, { version, viewId, pin });
      }
      try {
        const value = await registry.get<unknown>(kind, pin.artifactDigest, {
          params,
        });
        if (kind === "authority-matrix") {
          const pure = value as PureMatrix;
          if (pure.model.sourceDigest !== pin.sourceDigest) {
            throw new ModelRepositoryError(
              "INVALID_REPOSITORY",
              "Cached matrix source digest mismatch",
            );
          }
          const body = { ...pure, version: parseModelRevisionId(version) };
          const { name: _name, ...identity } = pure.model;
          return {
            ...body,
            digest: await executionDigest({ ...body, model: identity }),
          };
        }
        if (
          kind === "board" &&
          (value as Awaited<ReturnType<ModelBoardReader["read"]>>).meta
              .sourceDigest !== pin.sourceDigest
        ) {
          throw new ModelRepositoryError(
            "INVALID_REPOSITORY",
            "Cached board source digest mismatch",
          );
        }
        return value;
      } catch (error) {
        // A coalesced computation may have been started by another commit
        // sharing A/S. Preserve the failure, but localize its requested version.
        const triggerVersion = triggers.get(key)?.version;
        if (error && typeof error === "object" && !(error instanceof Error)) {
          const failure = error as { context?: Record<string, unknown> };
          if (failure.context?.version === triggerVersion) {
            throw { ...failure, context: { ...failure.context, version } };
          }
        }
        throw error;
      } finally {
        if (ownsTrigger) triggers.delete(key);
      }
    })();
    reads.set(readKey, work);
    try {
      return structuredClone(await work) as T;
    } finally {
      reads.delete(readKey);
    }
  }
  const board: ModelBoardReader = { read: (version) => read("board", version) };
  const authorityMatrix: AuthorityMatrixReader = {
    read: (version) => read("authority-matrix", version),
  };
  const views: ModelViewsReader = {
    list: (version) => read("views", version),
    diagram: (version, viewId) => read("view-diagram", version, viewId),
    plantuml: (version, viewId) => read("plantuml", version, viewId),
  };
  function status(
    kind: CachedProjectionKind,
    version: string,
    view: ViewOptions = {},
  ): VersionProjectionStatus {
    const pin = pins.get(version);
    const memo = paramNames.get(`${version}\n${view.viewId ?? ""}`);
    const params = memo ? JSON.parse(memo) as ProjectionParams : undefined;
    return {
      version,
      projectorVersion: registry.projectorVersion(kind)!,
      state: "unrequested",
      ...(pin ? { pinOrigin: pin.origin } : {}),
      ...(pin?.artifactDigest ? { artifactDigest: pin.artifactDigest } : {}),
      ...(pin?.artifactDigest && params
        ? registry.status(kind, pin.artifactDigest, { params })
        : {}),
      kind,
    };
  }
  function current(
    kind: CachedProjectionKind,
    view: ViewOptions = {},
  ): CurrentVersionProjection {
    const pointer = pointers.get(`${kind}\n${view.viewId ?? ""}`);
    if (!pointer) return { kind, state: "unrequested" as const };
    const requested = status(kind, pointer.requestedVersion, view);
    const available = pointer.availableVersion
      ? pins.get(pointer.availableVersion)
      : undefined;
    return {
      ...requested,
      state: pointer.state,
      requestedVersion: pointer.requestedVersion,
      availableVersion: pointer.availableVersion,
      requestedArtifact: requested.artifactDigest,
      availableArtifact: available?.artifactDigest,
      ...(pointer.error ? { error: pointer.error } : {}),
    };
  }
  function requestCurrent(version: string): Promise<void> {
    validateVersion(version);
    head = version;
    const requestEpoch = ++epoch;
    for (const kind of ["board", "authority-matrix", "views"] as const) {
      const key = `${kind}\n`;
      const old = pointers.get(key);
      const pointer = {
        requestedVersion: version,
        availableVersion: old?.availableVersion,
        state: "pending" as ProjectionStatus["state"],
        error: undefined as ProjectionStatus["error"] | undefined,
      };
      pointers.set(key, pointer);
      void read(kind, version).then(() => {
        if (requestEpoch === epoch) {
          pointer.availableVersion = version;
          pointer.state = "ready";
          // Memory hits emit no registry event. Notify completion explicitly so
          // a newly requested commit sharing A/S cannot leave SSE pending.
          const pin = pins.get(version);
          const snapshot = status(kind, version);
          if (pin?.artifactDigest && snapshot.params) {
            const ready = registry.status(kind, pin.artifactDigest, {
              params: snapshot.params,
            });
            for (const listener of listeners) {
              try {
                listener({ ...ready, versions: [version] });
              } catch { /* Subscriber isolation. */ }
            }
          }
        }
      }, (error: unknown) => {
        if (requestEpoch === epoch) {
          pointer.state = "failed";
          pointer.error = {
            code: String(
              (error as { code?: string })?.code ?? "PROJECTION_FAILED",
            ),
            message: error instanceof Error ? error.message : String(error),
          };
        }
      });
    }
    return Promise.resolve();
  }
  return {
    board,
    authorityMatrix,
    views,
    registry,
    pinFor,
    status,
    current,
    requestCurrent,
    currentVersion: () => head,
    subscribe(
      listener: (status: ProjectionStatus & { versions: string[] }) => void,
    ) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stats: () => ({
      pins: pins.size,
      heldRevisions: 0,
      triggers: triggers.size,
      registry: registry.stats(),
    }),
  };
}
