import { deepStrictEqual } from "node:assert/strict";
import type { ModelView } from "../../../../src/domain/model/records/diagram-views.ts";
import { unconnectedDecisions } from "./notes.ts";

Deno.test("a decision without native outgoing branches is flagged, unlike terminal or merge nodes", () => {
  const node = (id: string, metaclass: string) => ({
    id,
    name: id,
    kind: "control",
    metaclass,
    rows: [],
  });
  const view: ModelView = {
    id: "flow",
    title: "Flow",
    kind: "action",
    group: "behavior",
    element: "Flow",
    nodes: 4,
    edges: 1,
    diagram: {
      nodes: [
        node("missing", "DecisionNode"),
        node("complete", "DecisionNode"),
        node("merge", "MergeNode"),
        node("end", "FinalNode"),
      ],
      edges: [{ kind: "succession", source: "complete", target: "end" }],
    },
  };
  deepStrictEqual(unconnectedDecisions(view).map((n) => n.id), ["missing"]);
  deepStrictEqual(unconnectedDecisions({ ...view, kind: "state" }), []);
});
