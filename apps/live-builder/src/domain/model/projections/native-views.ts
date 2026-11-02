/** Read-only projection of native ViewUsage exposures; view membership is not ownership. */
import type { ModelGraphData } from "./graph.ts";

export interface NativeViewExposure {
  nativeId: string;
  importedMembershipId: string;
  kind?: "membership" | "namespace";
  importedNamespaceId?: string;
  isImportAll?: boolean;
  targetNativeId: string;
  /** Native feature chain, when present. Never reconstructed from display labels. */
  featurePath: string[];
  recursive: boolean;
}
export interface NativeViewRecord {
  nativeId: string;
  label: string;
  ownerNativeId: string;
  exposures: NativeViewExposure[];
}
interface NativeModelView {
  id: string;
  nativeId: string;
  label: string;
  ownerNativeId: string;
  members: Array<
    NativeViewExposure & {
      graphNodeIds: string[];
      nestedViewId?: string;
      resolution: "resolved" | "ambiguous" | "unresolved";
    }
  >;
  sourceEvidenceIds: string[];
}

/** An exposure of a shared definition feature must not select an arbitrary occurrence. */
export function projectNativeViews(
  records: NativeViewRecord[],
  graph: Pick<ModelGraphData, "nodes">,
): { views: NativeModelView[]; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const byNativeId = new Map(
    records.map((record) => [record.nativeId, record]),
  );
  const views = records.map((record): NativeModelView => ({
    id: `view:${record.nativeId}`,
    nativeId: record.nativeId,
    label: record.label,
    ownerNativeId: record.ownerNativeId,
    members: record.exposures.map((exposure) => {
      const nestedView = byNativeId.get(exposure.targetNativeId);
      if (nestedView && exposure.kind !== "namespace") {
        return {
          ...exposure,
          graphNodeIds: [],
          nestedViewId: `view:${nestedView.nativeId}`,
          resolution: "resolved",
        };
      }
      const chain = exposure.featurePath.length
        ? exposure.featurePath
        : [exposure.targetNativeId];
      const candidates = graph.nodes.filter((node) =>
        node.nativeId === exposure.targetNativeId &&
        (chain.length === 1 ||
          node.contextPath.length >= chain.length &&
            chain.every((id, index) =>
              id ===
                node.contextPath[node.contextPath.length - chain.length + index]
            ))
      );
      const resolution = candidates.length === 1
        ? "resolved"
        : candidates.length > 1
        ? "ambiguous"
        : "unresolved";
      if (resolution !== "resolved") {
        diagnostics.push(
          `Native view ${record.nativeId} exposure ${exposure.nativeId} is ${resolution}; no occurrence selected.`,
        );
      }
      return {
        ...exposure,
        graphNodeIds: resolution === "resolved"
          ? graph.nodes.filter((node) =>
            (exposure.kind === "namespace"
              ? node.parentId === candidates[0]!.id
              : node.id === candidates[0]!.id) ||
            exposure.recursive && candidates[0]!.role === "usage" &&
              node.role === "usage" &&
              node.contextPath.length > candidates[0]!.contextPath.length &&
              candidates[0]!.contextPath.every((id, i) =>
                node.contextPath[i] === id
              )
          ).map((node) => node.id)
          : [],
        resolution,
      };
    }),
    sourceEvidenceIds: [
      record.nativeId,
      ...record.exposures.flatMap((exposure) => [
        exposure.nativeId,
        exposure.importedMembershipId,
        exposure.importedNamespaceId ?? "",
        exposure.targetNativeId,
        ...exposure.featurePath,
      ]),
    ].filter((id, index, ids) => !!id && ids.indexOf(id) === index),
  }));
  return { views, diagnostics };
}
