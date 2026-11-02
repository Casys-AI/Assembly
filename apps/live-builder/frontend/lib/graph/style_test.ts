import cytoscape from "cytoscape";
import {
  graphStyle,
  isStructuralView,
  STRUCTURAL_EDGE_CLASS,
} from "./style.ts";
function assert(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}
Deno.test("served Cytoscape styles keep actions neutral and distinguish mandate scope from a generic view", () => {
  const graph = cytoscape({
    headless: true,
    styleEnabled: true,
    style: graphStyle,
    layout: { name: "preset" },
    elements: [
      {
        data: { id: "propose", label: "propose" },
        classes: "action general-action judgment-action",
      },
      {
        data: { id: "review", label: "review" },
        classes: "action general-action judgment-action",
      },
      {
        data: { id: "operator", label: "builder" },
        classes: "part operator",
      },
      {
        data: { id: "scope", label: "Mandat" },
        classes: "native-view mandate-scope",
      },
      {
        data: { id: "generic", label: "Other view" },
        classes: "native-view",
      },
      {
        data: {
          id: "guarded",
          source: "propose",
          target: "review",
          label: "[candidate.ready]",
        },
        classes: "directed",
      },
    ],
  });
  try {
    for (const id of ["propose", "review"]) {
      assert(
        graph.getElementById(id).style("background-color") ===
          "rgb(237,243,248)",
        `${id} received ochre`,
      );
    }
    assert(
      graph.getElementById("operator").style("background-color") ===
        "rgb(232,193,132)",
      "Operator lost ochre",
    );
    assert(
      graph.getElementById("scope").style("border-style") === "dashed",
      "Mandate scope lost dashed frame",
    );
    assert(
      graph.getElementById("scope").style("border-color") === "rgb(128,85,20)",
      "Mandate scope lost ochre border",
    );
    assert(
      graph.getElementById("scope").style("color") === "rgb(41,55,59)",
      "Mandate label must remain dark and readable",
    );
    assert(
      graph.getElementById("generic").style("border-style") === "solid",
      "Generic view became a mandate",
    );
    const guarded = graph.getElementById("guarded");
    assert(
      guarded.style("text-background-color") === "rgb(255,255,255)",
      "Guard label lost its readable background",
    );
    assert(
      guarded.style("text-border-color") === "rgb(215,225,233)",
      "Guard label lost its border",
    );
    assert(
      Number(guarded.style("arrow-scale")) > 1,
      "Directed edge arrow is undersized",
    );
  } finally {
    graph.destroy();
  }
});

Deno.test("structural edges route as taxi with labels on demand only", () => {
  assert(isStructuralView("interconnection"), "interconnection is structural");
  assert(isStructuralView("general"), "general is structural");
  assert(!isStructuralView("action-flow"), "action-flow is behavioral");
  assert(
    !isStructuralView("state-transition"),
    "state-transition is behavioral",
  );
  assert(!isStructuralView(undefined), "missing view is not structural");
  const graph = cytoscape({
    headless: true,
    styleEnabled: true,
    style: graphStyle,
    layout: { name: "preset" },
    elements: [
      { data: { id: "a", label: "a" }, position: { x: 0, y: 0 } },
      { data: { id: "b", label: "b" }, position: { x: 200, y: 100 } },
      { data: { id: "c", label: "c" }, position: { x: 0, y: 200 } },
      {
        data: {
          id: "struct",
          source: "a",
          target: "b",
          label: "lien métier",
          kind: "connection",
        },
        classes: `${STRUCTURAL_EDGE_CLASS} edge-connection`,
      },
      {
        data: {
          id: "binding",
          source: "b",
          target: "c",
          label: "=",
          kind: "binding",
        },
        classes: `${STRUCTURAL_EDGE_CLASS} edge-binding`,
      },
      {
        data: {
          id: "behav",
          source: "a",
          target: "c",
          label: "[ready]",
          kind: "succession",
        },
        classes: "directed",
      },
    ],
  });
  try {
    const struct = graph.getElementById("struct"),
      binding = graph.getElementById("binding"),
      behav = graph.getElementById("behav");
    assert(struct.style("curve-style") === "taxi", "structural edge not taxi");
    assert(
      struct.style("taxi-direction") === "auto",
      "structural taxi direction is not auto",
    );
    assert(
      struct.style("label") === "" && struct.data("label") === "lien métier",
      "structural label must be hidden by default but kept in data",
    );
    assert(
      binding.style("label") === "",
      "structural binding label must be hidden by default",
    );
    struct.addClass("hl");
    assert(
      struct.style("label") === "lien métier",
      "hl must reveal the structural label",
    );
    binding.addClass("hl");
    assert(binding.style("label") === "=", "hl must reveal the binding label");
    struct.removeClass("hl");
    assert(struct.style("label") === "", "unhighlighted label must hide again");
    struct.select();
    assert(
      struct.style("label") === "lien métier",
      "selected must reveal the structural label",
    );
    struct.unselect();
    assert(struct.style("label") === "", "unselected label must hide again");
    assert(
      behav.style("curve-style") === "bezier",
      "behavioral succession lost its bezier curve",
    );
    assert(
      behav.style("label") === "[ready]",
      "behavioral guard must stay always visible",
    );
  } finally {
    graph.destroy();
  }
});
