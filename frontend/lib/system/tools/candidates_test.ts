import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type {
  OperatorTool,
  OperatorToolsSnapshot,
} from "../../../../src/application/work/operators/conversation-types.ts";
import type { Candidate } from "../../../../src/domain/work/records/candidates.ts";
import {
  candidatePresentation,
  candidateReadMessage,
  candidatesFor,
  candidateState,
  hasToolChips,
  ownerIdsFor,
} from "./candidates.ts";
import {
  board,
  skill,
  tool as declaredTool,
  unit,
} from "../../../test/support/board-fixture.ts";

function tool(
  agentId: string,
  stage: Candidate["stage"] = "proposed",
  id = "same-candidate",
): OperatorTool {
  return {
    agentId,
    agentName: "Same operator name",
    revision: 1,
    candidate: {
      id,
      name: "Same tool name",
      description: "Read the selected page",
      digest: "a".repeat(64),
      kind: "read_web_page",
      code: "",
      stage,
      createdAt: "now",
      baseCatalogRevision: 0,
    },
  };
}

const catalogue = (tools: OperatorTool[]): OperatorToolsSnapshot => ({
  systemId: "system",
  version: "catalogue-1",
  tools,
});
const read = (source: OperatorToolsSnapshot | null, over = {}) => ({
  catalogue: source,
  loading: false,
  stale: false,
  error: "",
  ...over,
});

Deno.test("candidate chips retain exact owners, IDs and terminal states in catalogue order", () => {
  const source = catalogue([
    tool("a:b", "refused", "c"),
    tool("a", "failed", "b:c"),
    tool("a:b", "testing"),
    tool("a", "reviewing"),
  ]);
  const before = JSON.stringify(source);
  const own = candidatesFor(read(source), ["a:b"]);
  deepStrictEqual(own.map((entry) => [entry.agentId, entry.candidate.stage]), [[
    "a:b",
    "refused",
  ], ["a:b", "testing"]]);
  const presentations = source.tools.map((entry) =>
    candidatePresentation(entry, read(source))
  );
  equal(new Set(presentations.map((entry) => entry.key)).size, 4);
  equal(JSON.stringify(source), before);
  deepStrictEqual(candidatesFor(read(source), ["Same operator name"]), []);
});

Deno.test("native roster IDs translate to exact session owners without guessing", () => {
  deepStrictEqual(
    ownerIdsFor(["native:a"], [
      { nativeId: "native:a", agentId: "session:a" },
      { nativeId: "native:b", agentId: "native:a" },
      { nativeId: "native:a" },
    ]),
    ["session:a"],
  );
  deepStrictEqual(
    ownerIdsFor(["unknown"], [{ nativeId: "native:a", agentId: "primary" }]),
    [],
  );
});

Deno.test("Has replaces only the exact native bound tool and keeps homonymous declarations", () => {
  const model = board({
    team: [unit({ id: "u", title: "Unit" })],
    cando: [
      {
        ...declaredTool("bound", "u", "Same tool name"),
        element: "native:bound",
      },
      declaredTool("other", "u", "Same tool name"),
      skill("skill", "u", "Same tool name"),
    ],
  });
  const exact = tool("owner", "awaiting-admission");
  exact.candidate.binding = {
    elementId: "native:bound",
    graphPath: "model.tool",
  };
  const another = tool("owner", "testing", "another");
  const declarations = ["bound", "other", "skill"].map((id) => ({
    id,
    text: "Same tool name",
  }));
  const before = JSON.stringify(model);
  const composed = hasToolChips(model, declarations, [exact, another]);
  deepStrictEqual(
    composed.map((entry) => [
      entry.chip?.id,
      entry.candidates.map((tool) => tool.candidate.id),
    ]),
    [
      ["bound", ["same-candidate"]],
      ["other", []],
      ["skill", []],
      [undefined, ["another"]],
    ],
  );
  equal(JSON.stringify(model), before);
});

Deno.test("all preparation stages have human labels; unknown stages stay explicit", () => {
  const stages = [
    "proposed",
    "testing",
    "reviewing",
    "awaiting-admission",
    "activating",
    "refused",
    "failed",
    "future-stage",
  ] as Candidate["stage"][];
  deepStrictEqual(
    stages.map((stage) =>
      candidateState(tool("operator", stage).candidate).label
    ),
    [
      "Proposed",
      "Testing",
      "Under review",
      "Awaiting admission",
      "Activating",
      "Refused",
      "Failed",
      "Unknown state",
    ],
  );
});

Deno.test("active needs its native binding, independently of optional graph navigation", () => {
  const candidate = tool("operator", "active").candidate;
  for (
    const binding of [
      undefined,
      { elementId: "", graphPath: "model.tool" },
      { elementId: "  ", graphPath: "model.tool" },
    ]
  ) {
    const state = candidateState({ ...candidate, binding });
    equal(state.label, "Unknown state");
    equal(state.tone, "warning");
  }
  equal(candidate.activationModelDigest, undefined);
  // Recovery can confirm the exact native catalogue while graph lookup fails.
  for (const graphPath of ["model.tool", "", "\n"]) {
    deepStrictEqual(
      candidateState({
        ...candidate,
        binding: { elementId: "tool", graphPath },
      }),
      { label: "Active", tone: "active" },
    );
  }
});

Deno.test("retained catalogue states are last observations only when stale or refreshing", () => {
  const active = tool("operator", "active");
  active.candidate.binding = { elementId: "tool", graphPath: "model.tool" };
  const source = catalogue([active]);
  for (
    const over of [{ loading: true }, { stale: true }, {
      stale: true,
      error: "Read failed",
    }]
  ) {
    const result = candidatePresentation(active, read(source, over));
    equal(result.state.label, "Last observed: Active");
    equal(result.state.tone, "plain");
    ok(
      candidateReadMessage(read(source, over))?.includes(
        "current activity is unknown",
      ),
    );
  }
  const reconciled = read(source, { error: "Decision rejected" });
  equal(candidatePresentation(active, reconciled).state.label, "Active");
  equal(candidatePresentation(active, reconciled).state.tone, "active");
  equal(candidateReadMessage(reconciled), undefined);
});

Deno.test("absent, loading and failed catalogues say why they are unavailable", () => {
  equal(
    candidateReadMessage(read(null)),
    "The tool catalogue is not available.",
  );
  equal(
    candidateReadMessage(read(null, { loading: true })),
    "Loading the tools…",
  );
  equal(
    candidateReadMessage(read(null, { error: "Unavailable" })),
    "Unavailable",
  );
  deepStrictEqual(candidatesFor(read(null), ["owner"]), []);
  equal(candidateReadMessage(read(catalogue([]))), undefined);
});
