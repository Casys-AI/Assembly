import type { ModelView } from "../../../../src/domain/model/records/diagram-views.ts";

/** Toolkit 0.10.10 can omit the native source of decision branches. Do not
 * fabricate an edge from textual ordering; identify the incomplete picture. */
export function unconnectedDecisions(view: ModelView) {
  if (view.kind !== "action") return [];
  const outgoing = new Set(view.diagram.edges.map((edge) => edge.source));
  return view.diagram.nodes.filter((node) =>
    node.metaclass === "DecisionNode" && !outgoing.has(node.id)
  );
}
