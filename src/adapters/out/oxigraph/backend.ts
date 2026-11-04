/** W5/W6 composition over exact, persisted W2 builds. Derived read access only. */
import type { ModelRepositoryPort } from "../../../application/model/repository.ts";
import {
  type ModelBuildService,
  validateBuildDescriptor,
} from "../../../application/model/builds/service.ts";
import type { BuildDescriptor } from "../../../domain/model/value-objects/build.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import {
  admitReadOnlySparql,
  ModelSemanticIndexService,
  SemanticIndexError,
  type SemanticIndexStatus,
} from "../../../application/model/semantic/index-service.ts";
import type { NativeSemanticIndexPort } from "../../../application/model/semantic/ports/out/native-semantic-index.port.ts";
import type { SemanticProjectionCache } from "../../../application/model/semantic/ports/out/semantic-projection-cache.port.ts";
import type {
  SemanticQueryLimits,
  SemanticQueryResult,
} from "../../../application/model/semantic/queries/inputs.ts";
import type { ModelDiagnosticsReader } from "../../../application/model/diagnostics/ports/out/diagnostics-reader.port.ts";
import { compareDiagnostics } from "../../../application/model/diagnostics/shapes.ts";
import { lintModelDiagnostics } from "../../../domain/model/policies/diagnostics.ts";
import {
  buildElementIri,
  type BuildElementRef,
  type BuildRef,
  buildRefFromDescriptor,
  buildRefKey,
  type ElementIriScope,
  type ProjectionRef,
} from "../../../domain/model/value-objects/element-ref.ts";
import { parseModelRevisionId } from "../../../domain/shared-kernel/revision-id.ts";
import type { BoundModelReader } from "./ldkit-reader.ts";
import {
  type ModelGraphQueryResult,
  type ModelGraphSelection,
  ModelNavigationError,
  type ModelSemanticEvidence,
} from "../../../domain/model/consultation/context.ts";
import {
  ASE_VOCAB,
  DeterministicRdfModelProjector,
  metaclassIri,
  propPredicate,
} from "./rdf.ts";
import {
  createNativeShaclEngine,
  ShaclModelDiagnostics,
} from "../shacl/diagnostics.ts";

/** Native defaults admit four stores; reserve one slot for worker bookkeeping/recovery. */
export const MAX_RESIDENT_SEMANTIC_GRAPHS = 3;
export const MAX_QUEUED_SEMANTIC_READS = 16;
export const SCALAR_INSPECT_QUAD_BUDGET = 16;

/** Single-entity scalar lens. Relationship cardinality never expands its
 * CONSTRUCT; relation discovery has its own bounded neighbor query. */
export function scalarInspectionSchema(metaclass: string) {
  const optionalString = (
    iri: string,
  ) => ({ "@id": iri, "@type": "xsd:string", "@optional": true } as const);
  return {
    "@type": metaclassIri(metaclass),
    nativeId: { "@id": ASE_VOCAB.nativeId, "@type": "xsd:string" },
    metaclass: { "@id": ASE_VOCAB.metaclass, "@type": "xsd:string" },
    name: optionalString(ASE_VOCAB.name),
    qualifiedName: optionalString(ASE_VOCAB.qualifiedName),
    declaredName: optionalString(propPredicate("declaredName")),
  } as const;
}

/** The cursor is a bounded opaque transport for OFFSET and exact provenance.
 * It grants no authority; all fields are revalidated after resolving the pin. */
function cursorOffset(cursor: string | undefined, binding: string): number {
  if (cursor === undefined) return 0;
  try {
    if (cursor.length > 8192) throw new Error();
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(cursor), (c) => c.charCodeAt(0)),
    ));
    if (
      !Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== 1 ||
      decoded[1] !== binding || !Number.isSafeInteger(decoded[2]) ||
      decoded[2] < 1 || decoded[2] > 1_000_000
    ) throw new Error();
    return decoded[2];
  } catch {
    throw new SemanticIndexError(
      "INDEX_INVALID_INPUT",
      {},
      "Graph cursor does not match this version/build/projection/target/selectors",
    );
  }
}
function graphCursor(binding: string, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > 1_000_000) {
    throw new SemanticIndexError(
      "INDEX_QUERY_LIMIT",
      {},
      "Graph continuation exceeds the 1000000 offset budget",
    );
  }
  return btoa(
    String.fromCharCode(
      ...new TextEncoder().encode(JSON.stringify([1, binding, offset])),
    ),
  );
}

export function navigationFailure(
  error: unknown,
  version: string,
  build?: BuildRef,
  projection?: ProjectionRef,
): ModelNavigationError {
  if (error instanceof ModelNavigationError) return error;
  const detail = error as { code?: unknown; recovery?: unknown } | null;
  return new ModelNavigationError({
    state: "unavailable",
    advisory: true,
    version,
    ...(build ? { build } : {}),
    ...(projection ? { projection } : {}),
    code: typeof detail?.code === "string" ? detail.code : "INDEX_UNAVAILABLE",
    message: error instanceof Error
      ? error.message
      : "Semantic index unavailable",
    recovery: typeof detail?.recovery === "string"
      ? detail.recovery
      : "Restore the exact pinned native semantic index and retry this version. Independent search/read_source remain available.",
  });
}

/** Canonical source and graph pages have separate budgets and continuation. */
export async function semanticNeighborEvidence(
  reader: Pick<BoundModelReader, "neighborsPage" | "referencesToPage">,
  target: BuildElementRef,
  operation: "inspect" | "references",
  scope: ElementIriScope,
  requested: number | ModelGraphSelection = {},
  pin?: { version: string; projection: ProjectionRef },
): Promise<
  Pick<
    Extract<ModelSemanticEvidence, { state: "ready" }>,
    "neighbors" | "neighborPage"
  >
> {
  const options = typeof requested === "number"
    ? { limit: requested }
    : requested;
  const limit = Math.min(options.limit ?? 20, 50);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new SemanticIndexError(
      "INDEX_INVALID_INPUT",
      {},
      "Semantic neighbor page limit must be a positive integer",
    );
  }
  const direction = options.direction ??
    (operation === "references" ? "in" : "out");
  const binding = JSON.stringify([
    pin?.version,
    target.build,
    pin?.projection,
    target.nativeId,
    scope,
    direction,
    options.property ?? null,
  ]);
  const offset = cursorOffset(options.cursor, binding);
  const page = await reader.neighborsPage(target, {
    scope,
    direction,
    limit,
    property: options.property,
    offset,
  });
  return {
    neighbors: page.items.map((n) => ({
      direction: n.direction,
      property: n.property,
      predicate: n.predicate,
      iri: n.otherIri,
      ...(n.other ? { ref: n.other.ref, scope: n.other.scope } : {}),
      ...(n.occurrence ? { occurrence: n.occurrence } : {}),
      ...(n.position !== undefined ? { position: n.position } : {}),
    })),
    neighborPage: {
      limit: page.limit,
      complete: page.complete,
      ...(page.nativeTruncated !== undefined
        ? { nativeTruncated: page.nativeTruncated }
        : {}),
      ...(page.nextOffset !== undefined && pin
        ? { nextCursor: graphCursor(binding, page.nextOffset) }
        : {}),
    },
  };
}

export interface ModelSemanticBackendOptions {
  repositoryId: string;
  repository: Pick<ModelRepositoryPort, "header" | "descriptorAt">;
  buildService: Pick<ModelBuildService, "resolve">;
  /** Production callers supply the child-process Oxigraph adapter. */
  native: NativeSemanticIndexPort;
  /** Production preparation returns a reference only. Omit solely for the
   * existing explicit in-process byte seam used by tests and tools. */
  projectionPreparer?: {
    prepare(input: {
      readonly build: BuildRef;
      readonly descriptor: BuildDescriptor;
    }): Promise<{ readonly projection: ProjectionRef }>;
  };
  cache?: SemanticProjectionCache;
  diagnosticsReader?: ModelDiagnosticsReader;
}

export class ModelSemanticBackend {
  readonly #index: ModelSemanticIndexService;
  readonly #versions = new Map<string, string>();
  readonly #graphs = new Map<
    string,
    { build: BuildRef; pins: number; touched: number }
  >();
  readonly #waiters: Array<{ resolve(): void; reject(error: Error): void }> =
    [];
  #gate: Promise<void> = Promise.resolve();
  #clock = 0;
  #closeTask?: Promise<void>;
  #closed = false;
  readonly #shapes: ShaclModelDiagnostics;
  constructor(private readonly options: ModelSemanticBackendOptions) {
    this.#index = new ModelSemanticIndexService(
      options.projectionPreparer
        ? {
          native: options.native,
          preparer: {
            prepare: async (build) => {
              const { descriptor, header } = await this.#boundDescriptor(build);
              // Hash the immutable source snapshot, rather than trusting the header's
              // declared S. No artifact or CompiledModel is needed for this binding.
              const sourceDigest = await modelSourceDigest(header.sources);
              const verified = await validateBuildDescriptor(
                descriptor,
                options.repositoryId,
                sourceDigest,
              );
              return await options.projectionPreparer!.prepare({
                build,
                descriptor: verified,
              });
            },
          },
        }
        : {
          native: options.native,
          cache: options.cache,
          projector: new DeterministicRdfModelProjector(),
          source: {
            verifiedElements: async (build) => {
              const { descriptor, header } = await this.#boundDescriptor(build);
              const resolved = await options.buildService.resolve(
                descriptor,
                header.sources,
                { allowRebuild: false },
              );
              return {
                elements: resolved.artifact.elements,
                libraryNativeIds: resolved.artifact.elements.filter((e) =>
                  e.isLibraryElement === true
                ).map((e) => {
                  const id = e["@id"];
                  if (typeof id !== "string" || !id) {
                    throw new SemanticIndexError(
                      "INDEX_PROJECTION_CORRUPT",
                      {},
                      "Verified library element has no canonical native ID",
                    );
                  }
                  return id;
                }),
              };
            },
          },
        },
    );
    this.#shapes = new ShaclModelDiagnostics({
      engine: createNativeShaclEngine,
      cache: options.cache,
    });
  }

  async #boundDescriptor(build: BuildRef) {
    const version = this.#versions.get(buildRefKey(build));
    if (!version) {
      throw new SemanticIndexError(
        "INDEX_PROJECTION_MISSING",
        {},
        "Resolve the immutable version before loading its projection",
      );
    }
    const binding = await this.#descriptor(version, build.sourceDigest);
    if (
      buildRefKey(buildRefFromDescriptor(binding.descriptor)) !==
        buildRefKey(build)
    ) {
      throw new SemanticIndexError(
        "INDEX_PROJECTION_CORRUPT",
        {},
        "Persisted build identity changed",
      );
    }
    return binding;
  }

  async #descriptor(version: string, expectedDigest?: string) {
    parseModelRevisionId(version);
    const header = await this.options.repository.header(version);
    if (
      header.version !== version ||
      expectedDigest !== undefined && header.sourceDigest !== expectedDigest
    ) {
      throw new SemanticIndexError(
        "INDEX_PROJECTION_CORRUPT",
        { version },
        "Source pin does not match immutable header",
      );
    }
    const descriptor = await this.options.repository.descriptorAt?.(version);
    if (!descriptor) {
      throw new SemanticIndexError(
        "INDEX_PROJECTION_MISSING",
        { version, reason: "BUILD_RECIPE_UNAVAILABLE" },
        "Legacy revision has no persisted build recipe; semantic projection unavailable",
      );
    }
    if (
      descriptor.repositoryId !== this.options.repositoryId ||
      descriptor.sourceDigest !== header.sourceDigest
    ) {
      throw new SemanticIndexError(
        "INDEX_PROJECTION_CORRUPT",
        { version },
        "Build descriptor does not match repository and source pin",
      );
    }
    return { descriptor, header };
  }

  async resolveBuild(
    version: string,
    expectedSourceDigest?: string,
  ): Promise<BuildRef> {
    if (this.#closed) {
      throw new SemanticIndexError(
        "INDEX_UNAVAILABLE",
        {},
        "Semantic backend is closed",
      );
    }
    const { descriptor } = await this.#descriptor(
      version,
      expectedSourceDigest,
    );
    if (this.#closed) {
      throw new SemanticIndexError(
        "INDEX_UNAVAILABLE",
        {},
        "Semantic backend is closed",
      );
    }
    const build = buildRefFromDescriptor(descriptor);
    const key = buildRefKey(build);
    this.#versions.delete(key);
    this.#versions.set(key, version);
    // Logical provenance mappings are distinct from native graph residency.
    // Never release graphs here: a lookup/validator may overlap an inspection.
    while (this.#versions.size > 16) {
      const oldest = [...this.#versions.keys()].find((entry) =>
        !this.#graphs.has(entry)
      );
      if (!oldest) break;
      this.#versions.delete(oldest);
    }
    return build;
  }

  async inspect(
    version: string,
    sourceDigest: string,
    nativeId: string,
    operation: "inspect" | "references",
    options: number | ModelGraphSelection = {},
  ): Promise<ModelSemanticEvidence> {
    let build: BuildRef | undefined;
    let projection: ProjectionRef | undefined;
    try {
      build = await this.resolveBuild(version, sourceDigest);
      // The source verifies artifact bytes through W2; no compiler output is cached here.
      const { descriptor, header } = await this.#descriptor(
        version,
        sourceDigest,
      );
      const resolved = await this.options.buildService.resolve(
        descriptor,
        header.sources,
        { allowRebuild: false },
      );
      const element = resolved.artifact.elements.find((e) =>
        e["@id"] === nativeId
      );
      if (!element || typeof element["@type"] !== "string") {
        throw new SemanticIndexError("INDEX_PROJECTION_MISSING", {
          version,
          nativeId,
        }, "Element has no verified canonical metaclass");
      }
      const scope = element.isLibraryElement === true ? "library" : "user";
      const iri = buildElementIri({ build, nativeId }, scope);
      const pinnedBuild = build;
      return await this.#withGraph(pinnedBuild, version, async (status) => {
        projection = status.projection;
        if (status.state !== "ready" || !status.projection) {
          throw new SemanticIndexError(
            "INDEX_UNAVAILABLE",
            { version },
            "Projection is not ready",
          );
        }
        const { BoundModelReader, createLdkitLens } = await import(
          "./ldkit-reader.ts"
        );
        // One entity, five scalar attributes plus rdf:type. This limit counts
        // CONSTRUCT quads, not entities; relationships have a separate budget.
        const lens = await createLdkitLens(
          scalarInspectionSchema(element["@type"] as string),
          {
            index: this.#index,
            build: pinnedBuild,
            limits: { maxResults: SCALAR_INSPECT_QUAD_BUDGET, timeoutMs: 5000 },
          },
        );
        const typed = await lens.findByIri(iri);
        if (!typed) {
          throw new SemanticIndexError("INDEX_PROJECTION_MISSING", {
            version,
            nativeId,
          }, "LDkit could not read the verified element");
        }
        const reader = new BoundModelReader(this.#index, pinnedBuild, {
          maxBytes: 65_536,
          timeoutMs: 5000,
        });
        const neighbors = await semanticNeighborEvidence(
          reader,
          { build: pinnedBuild, nativeId },
          operation,
          scope,
          options,
          { version, projection: status.projection },
        );
        return {
          state: "ready",
          advisory: true,
          version,
          build: pinnedBuild,
          projection: status.projection,
          iri,
          scope,
          metaclass: typed.metaclass,
          readerVersion: "ase-ldkit-reader-v1",
          ...neighbors,
          coverage: "bounded-direct-neighbors",
        };
      });
    } catch (error) {
      throw navigationFailure(
        error,
        version,
        build,
        projection ??
          (build ? (await this.#index.status(build)).projection : undefined),
      );
    }
  }

  /** Agent SPARQL is SELECT/ASK only. Native AST admission remains authoritative. */
  async queryGraph(
    version: string,
    sourceDigest: string,
    expression: string,
  ): Promise<ModelGraphQueryResult> {
    let build: BuildRef | undefined;
    let projection: ProjectionRef | undefined;
    try {
      build = await this.resolveBuild(version, sourceDigest);
      if (typeof expression !== "string" || [...expression].length > 4096) {
        throw new SemanticIndexError(
          "INDEX_INVALID_INPUT",
          {},
          "SPARQL expression exceeds 4096 characters",
        );
      }
      admitReadOnlySparql(expression, ["SELECT", "ASK"]);
      return await this.readGraph(version, sourceDigest, async (graph) => {
        projection = graph.projection;
        if (!projection) {
          throw new SemanticIndexError(
            "INDEX_PROJECTION_MISSING",
            {},
            "Pinned projection unavailable",
          );
        }
        const limits = { maxResults: 50, maxBytes: 65_536, timeoutMs: 5000 };
        const result = await graph.query(expression, limits);
        if (result.form !== "solutions" && result.form !== "boolean") {
          throw new SemanticIndexError(
            "INDEX_QUERY_REFUSED",
            {},
            "Only SELECT/ASK results are supported",
          );
        }
        return {
          operation: "query",
          mode: "sparql",
          version,
          sourceDigest,
          build: graph.build,
          projection,
          limits,
          result,
        };
      });
    } catch (error) {
      throw navigationFailure(
        error,
        version,
        build,
        projection ??
          (build ? (await this.#index.status(build)).projection : undefined),
      );
    }
  }

  async validate(version: string) {
    const build = await this.resolveBuild(version);
    if (!this.options.diagnosticsReader) {
      throw new SemanticIndexError(
        "INDEX_UNAVAILABLE",
        { version },
        "Source diagnostics reader is not configured",
      );
    }
    const source = await this.options.diagnosticsReader.read(version);
    if (source.version !== version || source.digest !== build.sourceDigest) {
      throw new SemanticIndexError(
        "INDEX_PROJECTION_CORRUPT",
        { version },
        "Diagnostic facts do not match build source pin",
      );
    }
    const facts = typeof source.input === "function"
      ? await source.input()
      : source.input;
    const report = await this.readGraph(
      version,
      source.digest,
      (graph) => this.#shapes.validateBuild({ build, facts, graph }),
    );
    return {
      version,
      sourceDigest: source.digest,
      advisory: true as const,
      report,
      comparison: compareDiagnostics({
        shacl: report.diagnostics,
        reference: lintModelDiagnostics(facts),
        codes: ["LOOP_WITHOUT_BUDGET", "CAPABILITY_BEYOND_MANDATE"],
      }),
    };
  }

  #locked<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.#gate.then(operation);
    this.#gate = result.then(() => {}, () => {});
    return result;
  }

  #wake(): void {
    for (const waiter of this.#waiters.splice(0)) waiter.resolve();
  }

  async #acquireGraph(build: BuildRef, version: string): Promise<void> {
    const key = buildRefKey(build);
    while (true) {
      const admission = await this.#locked(async () => {
        if (this.#closed) {
          throw new SemanticIndexError(
            "INDEX_UNAVAILABLE",
            {},
            "Semantic backend is closed",
          );
        }
        const existing = this.#graphs.get(key);
        if (existing) {
          existing.pins++;
          existing.touched = ++this.#clock;
          this.#versions.set(key, version);
          return { admitted: true as const };
        }
        if (this.#graphs.size >= MAX_RESIDENT_SEMANTIC_GRAPHS) {
          const idle = [...this.#graphs.entries()].filter(([, graph]) =>
            graph.pins === 0
          )
            .sort((a, b) => a[1].touched - b[1].touched)[0];
          if (!idle) {
            if (this.#waiters.length >= MAX_QUEUED_SEMANTIC_READS) {
              throw new SemanticIndexError(
                "INDEX_BUSY",
                {},
                "Semantic graph read queue is full",
              );
            }
            const wait = new Promise<void>((resolve, reject) =>
              this.#waiters.push({ resolve, reject })
            );
            return { admitted: false as const, wait };
          }
          // Hold the admission gate until native ack: the freed slot cannot be
          // reused before release, and an idle graph cannot acquire a new pin.
          await this.#index.release(idle[1].build);
          this.#graphs.delete(idle[0]);
        }
        this.#graphs.set(key, { build, pins: 1, touched: ++this.#clock });
        this.#versions.set(key, version);
        return { admitted: true as const };
      });
      if (admission.admitted) return;
      await admission.wait;
    }
  }

  async #withGraph<T>(
    build: BuildRef,
    version: string,
    read: (status: SemanticIndexStatus) => Promise<T>,
  ): Promise<T> {
    await this.#acquireGraph(build, version);
    try {
      return await read(await this.#index.ensureProjection(build));
    } finally {
      await this.#locked(() => {
        const graph = this.#graphs.get(buildRefKey(build));
        if (graph) {
          graph.pins--;
          graph.touched = ++this.#clock;
        }
        this.#wake();
      });
    }
  }

  /** Fixed-build, read-only graph callback. Its lease spans every awaited query.
   * A caller must not retain this callback surface after it returns. */
  async readGraph<T>(
    version: string,
    sourceDigest: string,
    read: (graph: {
      readonly build: BuildRef;
      readonly projection: SemanticIndexStatus["projection"];
      query(
        sparql: string,
        limits?: Partial<SemanticQueryLimits>,
      ): Promise<SemanticQueryResult>;
    }) => Promise<T> | T,
  ): Promise<T> {
    const build = await this.resolveBuild(version, sourceDigest);
    return await this.#withGraph(build, version, async (status) => {
      let active = true;
      const queries = new Set<Promise<SemanticQueryResult>>();
      try {
        return await read(
          Object.freeze({
            build,
            projection: status.projection,
            query: (sparql: string, limits?: Partial<SemanticQueryLimits>) => {
              if (!active) {
                return Promise.reject(
                  new SemanticIndexError(
                    "INDEX_UNAVAILABLE",
                    {},
                    "Semantic graph lease has ended",
                  ),
                );
              }
              const query = this.#index.queryReadOnly({
                build,
                sparql,
                limits,
              });
              queries.add(query);
              // Observe rejections immediately, including a callback that forgets
              // to await its read; the lease still drains all started queries.
              void query.catch(() => {});
              return query;
            },
          }),
        );
      } finally {
        active = false;
        await Promise.allSettled(queries);
      }
    });
  }

  async release(version: string): Promise<void> {
    const build = await this.resolveBuild(version);
    await this.#locked(async () => {
      const key = buildRefKey(build);
      const graph = this.#graphs.get(key);
      if (graph?.pins) {
        throw new SemanticIndexError(
          "INDEX_BUSY",
          { version },
          "Semantic graph is pinned by an active read",
        );
      }
      if (graph) await this.#index.release(build);
      this.#graphs.delete(key);
      this.#versions.delete(key);
      this.#wake();
    });
  }

  /** Drain admitted reads, reject queued reads, attempt every native release.
   * Root closes the native requester after this completes or rejects. */
  close(): Promise<void> {
    return this.#closeTask ??= this.#close();
  }

  async #close(): Promise<void> {
    this.#closed = true;
    const error = new SemanticIndexError(
      "INDEX_UNAVAILABLE",
      {},
      "Semantic backend is closed",
    );
    await this.#locked(() => {
      for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
    });
    while (true) {
      const waiting = await this.#locked(() => {
        if (![...this.#graphs.values()].some((graph) => graph.pins > 0)) {
          return null;
        }
        return {
          promise: new Promise<void>((resolve) =>
            this.#waiters.push({ resolve, reject: () => resolve() })
          ),
        };
      });
      if (!waiting) break;
      await waiting.promise;
    }
    const results = await Promise.allSettled(
      [...this.#graphs.values()].map((graph) =>
        this.#index.release(graph.build)
      ),
    );
    this.#versions.clear();
    this.#graphs.clear();
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (errors.length) {
      throw new AggregateError(errors, "Semantic graph cleanup failed");
    }
  }
}

export function createModelSemanticBackend(
  options: ModelSemanticBackendOptions,
): ModelSemanticBackend {
  return new ModelSemanticBackend(options);
}
