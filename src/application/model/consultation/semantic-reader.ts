/** Adds derived semantic evidence without changing the source reader's contract. */
import type { ModelConsultationReader } from "../../work/context/information-ports.ts";
import {
  type ModelContextQuery,
  type ModelContextQueryResult,
  type ModelGraphQueryResult,
  type ModelGraphSelection,
  ModelNavigationError,
  type ModelSemanticEvidence,
} from "../../../domain/model/consultation/context.ts";

export class SemanticModelContextReader {
  constructor(
    private readonly source: ModelConsultationReader,
    private readonly backend: {
      inspect(
        version: string,
        sourceDigest: string,
        nativeId: string,
        operation: "inspect" | "references",
        graph?: ModelGraphSelection,
      ): Promise<ModelSemanticEvidence>;
      queryGraph?(
        version: string,
        sourceDigest: string,
        expression: string,
      ): Promise<ModelGraphQueryResult>;
    },
  ) {}
  overview(requested?: string) {
    return this.source.overview(requested);
  }
  async query(input: ModelContextQuery): Promise<ModelContextQueryResult> {
    const result = await this.source.query(input);
    if (result.operation !== "inspect" && result.operation !== "references") {
      return result;
    }
    let semantic: ModelSemanticEvidence;
    try {
      semantic = await this.backend.inspect(
        result.version,
        result.sourceDigest,
        result.selected.id,
        result.operation,
        input.graph,
      );
    } catch (error) {
      if (error instanceof ModelNavigationError) throw error;
      const detail = error as { code?: string; recovery?: string };
      throw new ModelNavigationError({
        state: "unavailable",
        advisory: true,
        version: result.version,
        code: detail?.code ?? "INDEX_UNAVAILABLE",
        message: error instanceof Error
          ? error.message
          : "Semantic index unavailable",
        recovery: detail?.recovery ??
          "Restore the exact pinned semantic index and retry. Independent source reads remain available.",
      });
    }
    if (semantic.state !== "ready") throw new ModelNavigationError(semantic);
    type EndpointSource = Pick<
      typeof semantic.neighbors[number],
      "source" | "sourceUnavailable"
    >;
    const sourceResolutions = new Map<string, Promise<EndpointSource>>();
    const neighbors = await Promise.all(
      semantic.neighbors.map(async (neighbor) => {
        if (neighbor.scope === "library") {
          return { ...neighbor, sourceUnavailable: "library" as const };
        }
        if (!neighbor.ref) {
          return { ...neighbor, sourceUnavailable: "unmapped" as const };
        }
        const nativeId = neighbor.ref.nativeId;
        const key = `${neighbor.scope}\0${nativeId}`;
        let resolution = sourceResolutions.get(key);
        if (!resolution) {
          resolution = (async (): Promise<EndpointSource> => {
            try {
              const endpoint = await this.source.query({
                operation: "inspect",
                version: result.version,
                elementId: nativeId,
                limit: 1,
              });
              if (
                endpoint.version !== result.version ||
                endpoint.sourceDigest !== result.sourceDigest ||
                endpoint.operation !== "inspect" ||
                endpoint.selected.id !== nativeId
              ) {
                throw new ModelNavigationError({
                  state: "unavailable",
                  advisory: true,
                  version: result.version,
                  build: semantic.build,
                  projection: semantic.projection,
                  code: "INDEX_PROJECTION_CORRUPT",
                  message:
                    "Graph endpoint source does not match the immutable pin",
                  recovery: "Restore the exact source/build mapping and retry.",
                });
              }
              return endpoint.selected.source
                ? {
                  source: {
                    version: result.version,
                    sourceDigest: result.sourceDigest,
                    elementId: endpoint.selected.id,
                    ...endpoint.selected.source,
                  },
                }
                : { sourceUnavailable: "unmapped" };
            } catch (error) {
              const detail = error as
                | { code?: unknown; recovery?: unknown }
                | null;
              if (
                ["NOT_FOUND", "AMBIGUOUS_SOURCE", "INVALID_SOURCE_RANGE"]
                  .includes(String(detail?.code))
              ) {
                return { sourceUnavailable: "unmapped" };
              }
              throw new ModelNavigationError({
                state: "unavailable",
                advisory: true,
                version: result.version,
                build: semantic.build,
                projection: semantic.projection,
                code: typeof detail?.code === "string"
                  ? detail.code
                  : "INDEX_UNAVAILABLE",
                message: error instanceof Error
                  ? error.message
                  : "Endpoint source resolution failed",
                recovery: typeof detail?.recovery === "string"
                  ? detail.recovery
                  : "Restore the exact pinned source and semantic index, then retry this version.",
              });
            }
          })();
          sourceResolutions.set(key, resolution);
        }
        return { ...neighbor, ...await resolution };
      }),
    );
    return { ...result, semantic: { ...semantic, neighbors } };
  }

  queryGraph(
    version: string,
    sourceDigest: string,
    expression: string,
  ): Promise<ModelGraphQueryResult> {
    if (!this.backend.queryGraph) {
      throw new ModelNavigationError({
        state: "unavailable",
        advisory: true,
        version,
        code: "INDEX_UNAVAILABLE",
        message: "Semantic query backend is not configured",
        recovery:
          "Restore the pinned semantic backend and retry the same SPARQL request.",
      });
    }
    return this.backend.queryGraph(version, sourceDigest, expression);
  }
}
