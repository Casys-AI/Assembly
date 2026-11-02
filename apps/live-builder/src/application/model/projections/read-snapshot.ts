import { sha256 } from "../../../domain/primitives/execution-digest.ts";
/** Independent identities for the native projection and its observed journal. */
interface ProjectionIdentity {
  projectionDigest: string;
  activityDigest: string;
}

export type ProjectionDigestScope = "native" | "legacy-with-activity";

export async function digestProjection(value: unknown): Promise<string> {
  return await sha256(JSON.stringify(value));
}

/** The returned native graph is the only payload eligible for new persistence. */
export async function graphReadSnapshot<G extends object, A>(
  sourceGraph: G,
  observations: readonly A[],
  recordedDigest?: string,
) {
  const nativeGraph = structuredClone(sourceGraph) as
    & Omit<
      G,
      "executionSequences"
    >
    & { executionSequences?: unknown };
  const legacyActivity = Object.hasOwn(nativeGraph, "executionSequences");
  delete nativeGraph.executionSequences;
  const [projectionDigest, activityDigest] = await Promise.all([
    recordedDigest ?? digestProjection(nativeGraph),
    digestProjection(observations),
  ]);
  const projectionDigestScope: ProjectionDigestScope = recordedDigest &&
      legacyActivity
    ? "legacy-with-activity"
    : "native";
  return {
    nativeGraph,
    graph: {
      ...structuredClone(nativeGraph),
      executionSequences: structuredClone([...observations]),
    },
    version: projectionDigest.slice(0, 20),
    projectionDigest,
    projectionDigestScope,
    activityDigest,
  };
}

/** A historical observation is immutable, including captures made by older code. */
export async function recordNativeProjection(
  store: {
    loadProjection(revision: number): Promise<unknown>;
    recordProjection(
      revision: number,
      graph: unknown,
      digest: string,
    ): Promise<void>;
  },
  revision: number,
  snapshot: { nativeGraph: object; projectionDigest: string },
): Promise<void> {
  if (await store.loadProjection(revision)) return;
  await store.recordProjection(
    revision,
    snapshot.nativeGraph,
    snapshot.projectionDigest,
  );
}

/** A journal update cannot become a model update merely by sharing a channel. */
export function projectionChanges(
  previous: ProjectionIdentity | undefined,
  next: ProjectionIdentity,
  recovered = false,
) {
  return {
    model: previous?.projectionDigest !== next.projectionDigest || recovered,
    activity: previous?.activityDigest !== next.activityDigest,
  };
}
