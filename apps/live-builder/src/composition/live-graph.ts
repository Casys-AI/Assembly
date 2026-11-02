/** Lot 10 composition: the live source-graph projection, its polling refresh,
 * its SSE broadcast and its read-only HTTP handler. Moved verbatim from the
 * former `main.ts` assembly; the refresh/order semantics are unchanged. */
import type { ClockPort } from "../application/work/runtime/ports.ts";
import { SystemClock } from "../infrastructure/clock.ts";
import { createModelGraphHandler } from "../adapters/in/http/model/graph.ts";
import {
  projectSourceGraph,
  type SourceGraph,
} from "../adapters/model/projections/graph/source.ts";
import { sourceModelIdentity } from "../adapters/model/sources/source-model.ts";
import {
  digestProjection,
  graphReadSnapshot,
  projectionChanges,
  type ProjectionDigestScope,
  recordNativeProjection,
} from "../application/model/projections/read-snapshot.ts";
import { projectExecutionSequence } from "../adapters/work/execution-sequence.ts";
import { broadcastSse as send } from "../infrastructure/http/sse.ts";
import type { SystemRuntime } from "../application/work/runtime/system.ts";
import type { OperatorStorage } from "../adapters/out/postgres/host-storage.ts";
import type { openModelBackend } from "./model-backend.ts";

type ModelBackend = Awaited<ReturnType<typeof openModelBackend>>;

export interface LiveGraphDependencies {
  clock?: ClockPort;
  service: SystemRuntime;
  model: ModelBackend["model"];
  store: OperatorStorage["state"];
  repository: ModelBackend["repository"];
  projectId: string;
}

export interface LiveGraphStatus {
  version: string;
  activityDigest: string;
  error: string | null;
}

export interface LiveGraphAssembly {
  graphClients: Set<ReadableStreamDefaultController<Uint8Array>>;
  handleModelGraph: (request: Request) => Promise<Response | null>;
  refresh: () => Promise<void>;
  pendingRead: () => Promise<void> | null;
  status: () => LiveGraphStatus;
  attachStateBroadcast: (
    clients: Set<ReadableStreamDefaultController<Uint8Array>>,
  ) => void;
  startPolling: () => void;
  stopPolling: () => void;
}

type LiveGraph = Omit<SourceGraph, "nodes"> & {
  executionSequences?: ReturnType<typeof projectExecutionSequence>[];
  nodes: Array<
    Omit<SourceGraph["nodes"][number], "observedState"> & {
      modelStage?: string;
      runtimeStage?: string;
      runtimeColor?: string;
      observedState?: boolean;
      runtimeStateEvidence?: {
        candidateId: string;
        catalogRevision: number;
        stage: string;
      };
    }
  >;
};

const stageNames: Record<string, string> = {
  proposed: "proposé",
  testing: "en essai",
  reviewing: "en revue",
  "awaiting-admission": "en attente d’admission",
  refused: "refusé",
  activating: "intégration",
  active: "actif",
  failed: "interrompu",
};

export function createLiveGraph(
  dependencies: LiveGraphDependencies,
): LiveGraphAssembly {
  const clock = dependencies.clock ?? new SystemClock();
  const { service, model, store, repository, projectId } = dependencies;
  const graphClients = new Set<
    ReadableStreamDefaultController<Uint8Array>
  >();
  let graphState: {
    version: string;
    projectionDigest: string;
    activityDigest: string;
    projectionDigestScope: ProjectionDigestScope;
    readAt: string;
    graph: LiveGraph;
  };
  let graphRead: Promise<void> | null = null;
  let graphAgain = false;
  let graphFailure: string | null = null;
  let recordedProjectionRevision: number | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  async function refreshGraph(): Promise<void> {
    if (graphRead) {
      graphAgain = true;
      return await graphRead;
    }
    const slowRead = setTimeout(() => {
      graphFailure =
        "Lecture du modèle en attente : le dernier instantané confirmé reste affiché.";
      send(graphClients, "model-error", { message: graphFailure });
    }, 30_000);
    graphRead = (async () => {
      do {
        graphAgain = false;
        const state = service.snapshot;
        const graph = await model.graph(state.model!) as LiveGraph;
        const byElement = new Map(
          state.candidates.filter((c) => c.binding).map((
            c,
          ) => [c.binding!.elementId, c]),
        );
        for (const node of graph.nodes) {
          // Scope comes from the verified host/model mandate, never from catalog
          // membership alone. Bind only concrete currently active capabilities.
          if (
            node.nativeId === state.model!.builderId && node.operator &&
            node.mandate?.holderNativeId === state.model!.builderId &&
            node.mandate.evidenceLevel === "configured"
          ) {
            if (graph.networkScope) {
              node.mandate.networkScope = {
                allowedHosts: [...graph.networkScope.allowedHosts],
                sourceRefs: [...graph.networkScope.nativeSourceIds],
              };
            }
            node.operator.capabilityBindings.push(
              ...state.candidates.filter((c) =>
                c.stage === "active" && c.binding
              )
                .map((c) => ({
                  kind: c.kind,
                  relationship: "may-invoke" as const,
                  nativeId: c.binding!.elementId,
                  name: c.name,
                  sourceRefs: [
                    ...node.mandate!.sourceRefs,
                    `host catalog revision ${state.catalogRevision}: ${c.id}@${c.digest}`,
                  ],
                  evidenceLevel: "configured" as const,
                })),
            );
          }
          const candidate = byElement.get(node.source.line);
          if (candidate) {
            node.label = candidate.name;
            node.runtimeStage = candidate.stage;
            node.runtimeColor = candidate.stage === "active"
              ? "#2a9d8f"
              : ["refused", "failed"].includes(candidate.stage)
              ? "#b95757"
              : "#c88b35";
            node.description = `${candidate.description}\nÉtat du modèle : ${
              node.modelStage ?? "non lu"
            }. État du catalogue exécuté : ${stageNames[candidate.stage]}. ${
              candidate.review?.reason ?? ""
            }`;
          }
          if (node.metaclass === "StateUsage") {
            const owner = state.candidates.find((c) =>
              c.binding && node.contextPath.includes(c.binding.elementId)
            );
            if (owner && node.label === owner.stage) {
              node.observedState = true;
              node.runtimeStateEvidence = {
                candidateId: owner.id,
                catalogRevision: state.catalogRevision,
                stage: owner.stage,
              };
            }
          }
        }
        // Journal observations are a derived read layer, separate from the
        // source-owned interaction scenarios and executable contract.
        const observed = projectExecutionSequence(state, graph);
        const snapshot = await graphReadSnapshot(
          graph,
          observed.messages.length ? [observed] : [],
        );
        const changed = projectionChanges(
          graphState,
          snapshot,
          graphFailure !== null,
        );
        graphFailure = null;
        graphState = {
          version: snapshot.version,
          projectionDigest: snapshot.projectionDigest,
          projectionDigestScope: snapshot.projectionDigestScope,
          activityDigest: snapshot.activityDigest,
          readAt: clock.now(),
          graph: snapshot.graph,
        };
        const confirmed = service.snapshot;
        if (
          !state.busy && !confirmed.busy &&
          confirmed.revision === state.revision &&
          recordedProjectionRevision !== state.revision
        ) {
          try {
            await recordNativeProjection(
              store,
              state.revision,
              snapshot,
            );
            recordedProjectionRevision = state.revision;
          } catch (error) {
            // The first observation of an accepted revision is immutable. A
            // later source revision may legitimately differ without changing
            // application state; it remains live but cannot rewrite PIT history.
            if (
              !(error instanceof Error) ||
              !error.message.includes("already exists with different content")
            ) throw error;
          }
        }
        if (changed.model) {
          send(graphClients, "model", {
            version: graphState.version,
            projectionDigest: graphState.projectionDigest,
          });
        }
        if (changed.activity) {
          send(graphClients, "model-activity", {
            activityDigest: graphState.activityDigest,
          });
        }
      } while (graphAgain);
    })().catch((error) => {
      graphFailure =
        "Lecture du modèle indisponible : le dernier instantané confirmé reste affiché.";
      send(graphClients, "model-error", { message: graphFailure });
      throw error;
    }).finally(() => {
      clearTimeout(slowRead);
      graphRead = null;
    });
    return await graphRead;
  }
  const handleModelGraph = createModelGraphHandler({
    current: () => ({ ...graphState, error: graphFailure, history: null }),
    async source(modelVersion) {
      const revision = await repository.at(modelVersion);
      const identity = sourceModelIdentity(
        revision,
        projectId,
      );
      const graph = projectSourceGraph(revision.elements, identity);
      const digest = await digestProjection(graph);
      return {
        graph,
        version: digest.slice(0, 20),
        projectionDigest: digest,
        projectionDigestScope: "native",
        error: null,
        history: { modelVersion: revision.version },
      };
    },
    async recorded(historicalRevision) {
      const projection = await store.loadProjection(historicalRevision);
      if (!projection) return null;
      const recordedGraph = projection.graph as LiveGraph;
      const state = await store.loadRevision(historicalRevision);
      const observed = state
        ? projectExecutionSequence(state, recordedGraph)
        : null;
      // The journal is reconstructed from the recorded state, never persisted
      // again with the graph. Old mixed digests retain their explicit scope.
      const snapshot = await graphReadSnapshot(
        recordedGraph,
        observed?.messages.length ? [observed] : [],
        projection.digest,
      );
      return {
        graph: snapshot.graph,
        version: snapshot.version,
        projectionDigest: snapshot.projectionDigest,
        projectionDigestScope: snapshot.projectionDigestScope,
        activityDigest: snapshot.activityDigest,
        error: null,
        history: {
          revision: projection.revision,
          recordedAt: projection.recordedAt,
        },
      };
    },
  });
  return {
    graphClients,
    handleModelGraph,
    refresh: () => refreshGraph(),
    pendingRead: () => graphRead,
    status: () => ({
      version: graphState.version,
      activityDigest: graphState.activityDigest,
      error: graphFailure,
    }),
    attachStateBroadcast: (clients) => {
      service.onState((state) => {
        send(clients, "state", state);
        refreshGraph().catch(
          () => {/* Keep the last confirmed model projection. */},
        );
      });
    },
    startPolling: () => {
      poll = setInterval(() => {
        // Timer ticks do not queue another expensive native read. Actual model/state
        // changes still request one coalesced follow-up while a read is running.
        if (!graphRead) refreshGraph().catch(() => {});
      }, 5_000);
    },
    stopPolling: () => {
      clearInterval(poll);
    },
  };
}
