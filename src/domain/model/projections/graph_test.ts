import assert from "node:assert/strict";
import {
  buildModelGraph,
  type ModelGraphData,
  type NativeRelations,
} from "./graph.ts";
import type { ElementRecord, ModelSnapshot } from "../records/snapshot.ts";

const element = (
  id: string,
  metaclass: string,
  name: string,
  ownerId: string,
  typeIds: string[] = [],
): ElementRecord => ({
  id,
  metaclass,
  name,
  ownerId,
  typeIds,
  qualifiedName: `Fixture::${name}`,
  direction: "",
  generalIds: [],
  isReference: false,
  redefinedIds: [],
  multiplicity: "",
  doc: "",
});
function fixture(): ModelSnapshot {
  return {
    rootId: "root",
    invocations: [],
    patternIds: [],
    messages: [],
    elements: [
      element("pkg", "Package", "ASE", "root"),
      element("library", "Package", "APEPromotion", "root"),
      element("agent-type", "PartDefinition", "Agent", "pkg"),
      element("agent-port", "PortUsage", "requests", "agent-type"),
      element("promotion-type", "ActionDefinition", "Promotion", "library"),
      element("test", "ActionUsage", "test", "promotion-type"),
      element("decision", "DecisionNode", "outcome", "promotion-type"),
      element("review", "ActionUsage", "review", "promotion-type"),
      element("refuse", "ActionUsage", "refuse", "promotion-type"),
      element("tests", "ItemUsage", "tests", "promotion-type"),
      element("passed", "AttributeUsage", "passed", "tests"),
      element("revision", "AttributeUsage", "revision", "promotion-type"),
      element("test-revision", "AttributeUsage", "revision", "test"),
      element("system", "PartUsage", "system", "pkg"),
      element("a", "PartUsage", "builder", "system", ["agent-type"]),
      element("b", "PartUsage", "reviewer", "system", ["agent-type"]),
      element("promotion", "PerformActionUsage", "promotion", "system", [
        "promotion-type",
      ]),
    ],
    connectors: [
      {
        id: "ports",
        metaclass: "ConnectionUsage",
        ownerId: "system",
        name: "requests",
        ends: [
          {
            chain: [{ id: "a", name: "builder" }, {
              id: "agent-port",
              name: "requests",
            }],
          },
          {
            chain: [{ id: "b", name: "reviewer" }, {
              id: "agent-port",
              name: "requests",
            }],
          },
        ],
      },
      {
        id: "allocate",
        metaclass: "AllocationUsage",
        ownerId: "system",
        name: "",
        ends: [
          {
            chain: [{ id: "promotion", name: "promotion" }, {
              id: "review",
              name: "review",
            }],
          },
          { chain: [{ id: "b", name: "reviewer" }] },
        ],
      },
      {
        id: "branch-succession",
        metaclass: "SuccessionAsUsage",
        ownerId: "promotion-type",
        name: "",
        ends: [
          { chain: [{ id: "decision", name: "outcome" }] },
          { chain: [{ id: "review", name: "review" }] },
        ],
      },
    ],
  };
}
const native: NativeRelations = {
  relations: [
    {
      id: "branch",
      metaclass: "TransitionUsage",
      ownerId: "promotion-type",
      sourceId: "decision",
      targetId: "review",
      guard: "tests.passed",
      guardIds: ["guard"],
      successionId: "branch-succession",
    },
    {
      id: "else-branch",
      metaclass: "TransitionUsage",
      ownerId: "promotion-type",
      sourceId: "decision",
      targetId: "refuse",
      guard: "else",
    },
  ],
};
const node = (graph: ModelGraphData, nativeId: string) =>
  graph.nodes.find((candidate) =>
    candidate.nativeId === nativeId && candidate.role === "usage"
  )!;

Deno.test("native actions, decisions and items expand beneath a performed behavior; definitions remain separate", () => {
  const graph = buildModelGraph(fixture(), native);
  const promotion = node(graph, "promotion");
  assert.equal(promotion.metaclass, "PerformActionUsage");
  assert.equal(promotion.kind, "perform-action-usage");
  assert.equal(promotion.dimension, "behavior");
  assert.equal(node(graph, "review").parentId, promotion.id);
  assert.equal(node(graph, "decision").kind, "decision-node");
  assert.equal(node(graph, "tests").kind, "item-usage");
  assert.equal(
    graph.nodes.find((candidate) => candidate.id === "def:promotion-type")
      ?.role,
    "definition",
  );
  assert.equal(
    graph.nodes.filter((candidate) => candidate.category === "pattern").length,
    0,
  );
  assert.deepEqual(graph.diagnostics, []);
});

Deno.test("duplicate typed usage contexts keep distinct native ports with correct part owners", () => {
  const graph = buildModelGraph(fixture());
  const ports = graph.nodes.filter((candidate) =>
    candidate.nativeId === "agent-port"
  );
  assert.equal(ports.length, 2);
  assert.equal(new Set(ports.map((candidate) => candidate.id)).size, 2);
  assert.deepEqual(
    new Set(ports.map((candidate) => candidate.parentId)),
    new Set([node(graph, "a").id, node(graph, "b").id]),
  );
  const connection = graph.edges.find((edge) => edge.nativeId === "ports")!;
  assert.equal(
    connection.source,
    ports.find((port) => port.parentId === node(graph, "a").id)!.id,
  );
  assert.equal(
    connection.target,
    ports.find((port) => port.parentId === node(graph, "b").id)!.id,
  );
});

Deno.test("native identity paths survive source reorder and display renaming", () => {
  const before = buildModelGraph(fixture(), native);
  const changed = fixture();
  changed.elements.reverse();
  for (const candidate of changed.elements) {
    candidate.name = `renamed_${candidate.name}`;
  }
  const after = buildModelGraph(changed, native);
  assert.deepEqual(
    after.nodes.map((candidate) => candidate.id).sort(),
    before.nodes.map((candidate) => candidate.id).sort(),
  );
  assert.deepEqual(
    after.edges.map((edge) => edge.id).sort(),
    before.edges.map((edge) => edge.id).sort(),
  );
});

Deno.test("guarded transitions replace their owned successions and preserve actual relation evidence", () => {
  const graph = buildModelGraph(fixture(), native, "Fixture", "native project");
  const edge = graph.edges.find((candidate) =>
    candidate.nativeId === "branch"
  )!;
  assert.equal(edge.kind, "succession");
  assert.equal(edge.guard, "tests.passed");
  assert.deepEqual(edge.guardIds, ["guard"]);
  assert.deepEqual(edge.sourceEvidence, {
    file: "native project",
    line: "branch",
  });
  assert.equal(
    graph.edges.some((candidate) => candidate.nativeId === "branch-succession"),
    false,
  );
  assert.equal(
    graph.edges.find((candidate) => candidate.nativeId === "else-branch")
      ?.guard,
    "else",
  );
  assert.equal(
    graph.nodes.some((candidate) => candidate.nativeId === "branch"),
    false,
  );
});

Deno.test("allocation retains feature chaining and records the actual native performer", () => {
  const graph = buildModelGraph(fixture(), native);
  const allocation = graph.edges.find((edge) => edge.nativeId === "allocate")!;
  assert.equal(allocation.source, node(graph, "review").id);
  assert.equal(allocation.target, node(graph, "b").id);
  assert.deepEqual(allocation.sourceFeaturePath, ["promotion", "review"]);
  assert.deepEqual(node(graph, "review").performerLabels, ["reviewer"]);
  assert.deepEqual(node(graph, "promotion").performerLabels, ["system"]);
});

Deno.test("scalar field bindings retain native endpoint chains without fabricating nodes", () => {
  const snapshot = fixture();
  snapshot.connectors.push({
    id: "field-binding",
    metaclass: "BindingConnectorAsUsage",
    ownerId: "promotion-type",
    name: "",
    ends: [
      {
        chain: [{ id: "test", name: "test" }, {
          id: "test-revision",
          name: "revision",
        }],
      },
      { chain: [{ id: "revision", name: "revision" }] },
    ],
  });
  const graph = buildModelGraph(snapshot, native);
  const binding = graph.edges.find((edge) =>
    edge.nativeId === "field-binding"
  )!;
  assert.equal(binding.source, node(graph, "test").id);
  assert.equal(binding.target, node(graph, "promotion").id);
  assert.deepEqual(binding.sourceFeaturePath, ["test", "test-revision"]);
  assert.equal(
    graph.nodes.some((candidate) => candidate.nativeId === "test-revision"),
    false,
  );
  assert.deepEqual(graph.diagnostics, []);
});

Deno.test("external start endpoint is included only when a native endpoint record exists", () => {
  const snapshot = fixture();
  snapshot.connectors.push({
    id: "start-edge",
    metaclass: "SuccessionAsUsage",
    ownerId: "promotion-type",
    name: "",
    ends: [
      { chain: [{ id: "external-start", name: "start" }] },
      { chain: [{ id: "test", name: "test" }] },
    ],
  });
  const missing = buildModelGraph(snapshot, native);
  assert.equal(
    missing.nodes.some((candidate) => candidate.label === "start"),
    false,
  );
  assert.ok(
    missing.diagnostics.some((message) => message.includes("start-edge")),
  );
  const graph = buildModelGraph(snapshot, {
    ...native,
    endpointElements: [
      element("external-start", "ActionUsage", "start", "standard-library"),
    ],
  });
  assert.equal(
    node(graph, "external-start").parentId,
    node(graph, "promotion").id,
  );
  assert.equal(node(graph, "external-start").source.line, "external-start");
  assert.deepEqual(graph.diagnostics, []);
});

Deno.test("unresolved and ambiguous native endpoints report diagnostics instead of guessing", () => {
  const snapshot = fixture();
  snapshot.connectors.push({
    id: "ambiguous",
    metaclass: "FlowConnectionUsage",
    ownerId: "system",
    name: "",
    ends: [
      { chain: [{ id: "agent-port", name: "requests" }] },
      { chain: [{ id: "promotion", name: "promotion" }] },
    ],
  });
  const graph = buildModelGraph(snapshot, {
    relations: [{
      id: "bad-guard",
      metaclass: "TransitionUsage",
      ownerId: "promotion-type",
      sourceId: "decision",
      targetId: "review",
      guardIds: ["unsupported"],
      unresolvedGuardIds: ["unsupported"],
    }],
  });
  assert.equal(
    graph.edges.some((candidate) => candidate.nativeId === "ambiguous"),
    false,
  );
  assert.ok(graph.diagnostics.some((message) => message.includes("ambiguous")));
  assert.ok(
    graph.diagnostics.some((message) => message.includes("unsupported")),
  );
  assert.equal(
    graph.edges.find((candidate) => candidate.nativeId === "bad-guard")?.guard,
    undefined,
  );
});

function portFixture(): ModelSnapshot {
  const payload = element(
    "payload",
    "ItemUsage",
    "candidate",
    "candidate-port",
    ["candidate-contract"],
  );
  payload.direction = "out";
  return {
    rootId: "root",
    invocations: [],
    patternIds: [],
    messages: [],
    connectors: [],
    elements: [
      element("pkg", "Package", "ASE", "root"),
      element(
        "candidate-contract",
        "ItemDefinition",
        "CandidateContract",
        "pkg",
      ),
      element("candidate-port", "PortDefinition", "CandidatePort", "pkg"),
      // Neither marker nor usage labels contain '~': proof is native metaclass
      // plus the marker's original-definition owner, not a naming convention.
      element(
        "conjugated-port",
        "ConjugatedPortDefinition",
        "receiverType",
        "candidate-port",
      ),
      payload,
      element("builder-type", "PartDefinition", "Builder", "pkg"),
      element("proposals", "PortUsage", "proposals", "builder-type", [
        "candidate-port",
      ]),
      element("reviewer-type", "PartDefinition", "Reviewer", "pkg"),
      element("candidates", "PortUsage", "candidates", "reviewer-type", [
        "conjugated-port",
      ]),
      element("system", "PartUsage", "liveBuilder", "pkg"),
      element("builder", "PartUsage", "builder", "system", ["builder-type"]),
      element("reviewer", "PartUsage", "reviewer", "system", ["reviewer-type"]),
    ],
  };
}
Deno.test("shared native port definition keeps producer declared out and conjugated receiver effective in", () => {
  const graph = buildModelGraph(portFixture());
  const proposals = node(graph, "proposals");
  const candidates = node(graph, "candidates");
  const producer = graph.nodes.find((candidate) =>
    candidate.nativeId === "payload" && candidate.parentId === proposals.id
  )!;
  const receiver = graph.nodes.find((candidate) =>
    candidate.nativeId === "payload" && candidate.parentId === candidates.id
  )!;
  assert.equal(proposals.conjugated, false);
  assert.equal(candidates.conjugated, true);
  assert.deepEqual(candidates.conjugationSourceIds, ["conjugated-port"]);
  assert.equal(producer.declaredDirection, "out");
  assert.equal(producer.effectiveDirection, undefined);
  assert.equal(receiver.declaredDirection, "out");
  assert.equal(receiver.effectiveDirection, "in");
  assert.deepEqual(receiver.directionConjugationIds, ["conjugated-port"]);
  assert.notEqual(producer.id, receiver.id);
  assert.equal(producer.nativeId, receiver.nativeId);
  assert.equal(
    graph.nodes.filter((candidate) => candidate.id === "def:candidate-port")
      .length,
    1,
  );
  assert.equal(
    graph.nodes.filter((candidate) => candidate.id === "def:candidate-contract")
      .length,
    1,
  );
  const typings = graph.edges.filter((edge) =>
    edge.kind === "typing" &&
    [proposals.id, candidates.id].includes(edge.source)
  );
  assert.equal(typings.length, 2);
  assert.ok(typings.every((edge) => edge.target === "def:candidate-port"));
  assert.deepEqual(graph.diagnostics, []);
});
Deno.test("native conjugation reverses in/out and preserves inout without changing declared values", () => {
  const snapshot = portFixture();
  const incoming = element(
    "incoming",
    "ItemUsage",
    "incoming",
    "candidate-port",
  );
  incoming.direction = "in";
  const bidirectional = element(
    "bidirectional",
    "ItemUsage",
    "bidirectional",
    "candidate-port",
  );
  bidirectional.direction = "inout";
  const unset = element("unset", "ItemUsage", "unset", "candidate-port");
  snapshot.elements.push(incoming, bidirectional, unset);
  const graph = buildModelGraph(snapshot);
  const portId = node(graph, "candidates").id;
  const receiverFeature = (nativeId: string) =>
    graph.nodes.find((candidate) =>
      candidate.nativeId === nativeId && candidate.parentId === portId
    )!;
  assert.equal(receiverFeature("incoming").declaredDirection, "in");
  assert.equal(receiverFeature("incoming").effectiveDirection, "out");
  assert.equal(receiverFeature("bidirectional").declaredDirection, "inout");
  assert.equal(receiverFeature("bidirectional").effectiveDirection, "inout");
  assert.equal(receiverFeature("unset").declaredDirection, "");
  assert.equal(receiverFeature("unset").effectiveDirection, undefined);
});
Deno.test("conjugation requires a resolved native original definition and never follows '~' labels", () => {
  const snapshot = portFixture();
  snapshot.elements.find((candidate) => candidate.id === "proposals")!.name =
    "~looksConjugated";
  snapshot.elements.find((candidate) => candidate.id === "conjugated-port")!
    .ownerId = "missing-original";
  const graph = buildModelGraph(snapshot);
  assert.equal(node(graph, "proposals").conjugated, false);
  assert.equal(node(graph, "candidates").conjugated, undefined);
  assert.ok(
    graph.diagnostics.some((message) =>
      message.includes("no resolved native original port definition")
    ),
  );
  assert.ok(
    graph.nodes.every((candidate) =>
      candidate.effectiveDirection === undefined
    ),
  );
});

function stateFixture(): ModelSnapshot {
  const snapshot = fixture();
  snapshot.elements.push(
    element("candidate-type", "PartDefinition", "ToolCandidate", "pkg"),
    element("candidate", "PartUsage", "tool_actual", "system", [
      "candidate-type",
    ]),
    element("lifecycle-type", "StateDefinition", "CandidateLifecycle", "pkg"),
    element("lifecycle", "ExhibitStateUsage", "lifecycle", "candidate-type", [
      "lifecycle-type",
    ]),
    element("entry", "ActionUsage", "", "lifecycle-type"),
    element("proposed", "StateUsage", "proposed", "lifecycle-type"),
    element("testing", "StateUsage", "testing", "lifecycle-type"),
    element("event-type", "ItemDefinition", "TestingStarted", "pkg"),
    element(
      "requirement-type",
      "RequirementDefinition",
      "ActiveOnlyCallable",
      "pkg",
    ),
    element("requirement", "RequirementUsage", "activeOnlyCallable", "system", [
      "requirement-type",
    ]),
  );
  return snapshot;
}
Deno.test("native exhibited state scopes retain their child states and actual entry identity", () => {
  const graph = buildModelGraph(stateFixture(), {
    stateEntries: [{ ownerId: "lifecycle-type", entryActionId: "entry" }],
    relations: [{
      id: "initial-transition",
      metaclass: "TransitionUsage",
      ownerId: "lifecycle-type",
      sourceId: "entry",
      targetId: "proposed",
    }],
  });
  const lifecycle = node(graph, "lifecycle");
  assert.equal(lifecycle.metaclass, "ExhibitStateUsage");
  assert.equal(lifecycle.parentId, node(graph, "candidate").id);
  assert.equal(node(graph, "proposed").parentId, lifecycle.id);
  assert.equal(node(graph, "testing").parentId, lifecycle.id);
  assert.equal(node(graph, "entry").metaclass, "ActionUsage");
  assert.equal(node(graph, "entry").stateRole, "initial");
  assert.equal(node(graph, "entry").stateRoleSourceId, "lifecycle-type");
  const transition = graph.edges.find((edge) =>
    edge.nativeId === "initial-transition"
  )!;
  assert.equal(transition.source, node(graph, "entry").id);
  assert.equal(transition.target, node(graph, "proposed").id);
  assert.equal(
    graph.nodes.filter((candidate) => candidate.metaclass === "StateUsage")
      .length,
    2,
  );
  assert.equal(node(graph, "decision").metaclass, "DecisionNode");
  assert.equal(node(graph, "decision").parentId, node(graph, "promotion").id);
  assert.deepEqual(graph.diagnostics, []);
});
Deno.test("state transition events and guards retain separate native evidence and combined display label", () => {
  const graph = buildModelGraph(stateFixture(), {
    relations: [
      {
        id: "state-transition",
        metaclass: "TransitionUsage",
        ownerId: "lifecycle-type",
        sourceId: "proposed",
        targetId: "testing",
        event: "TestingStarted",
        triggerIds: ["trigger-1"],
        eventTypeIds: ["event-type"],
        guard: "tests.passed",
        guardIds: ["guard"],
      },
    ],
  });
  const transition = graph.edges.find((edge) =>
    edge.nativeId === "state-transition"
  )!;
  assert.equal(transition.event, "TestingStarted");
  assert.equal(transition.guard, "tests.passed");
  assert.equal(transition.label, "TestingStarted [tests.passed]");
  assert.deepEqual(transition.triggerIds, ["trigger-1"]);
  assert.deepEqual(transition.eventTypeIds, ["event-type"]);
  assert.equal(transition.sourceEvidence.line, "state-transition");
});
Deno.test("satisfaction is a declared responsibility from native part to requirement usage", () => {
  const graph = buildModelGraph(stateFixture(), {
    relations: [
      {
        id: "satisfy",
        metaclass: "SatisfyRequirementUsage",
        ownerId: "system",
        sourceId: "b",
        targetId: "requirement",
        sourceEvidenceIds: ["subject-expression"],
      },
      {
        id: "negative-satisfy",
        metaclass: "SatisfyRequirementUsage",
        ownerId: "system",
        sourceId: "a",
        targetId: "requirement",
        isNegated: true,
      },
    ],
  });
  const satisfy = graph.edges.find((edge) => edge.nativeId === "satisfy")!;
  assert.equal(satisfy.kind, "satisfies");
  assert.equal(satisfy.source, node(graph, "b").id);
  assert.equal(satisfy.target, node(graph, "requirement").id);
  assert.equal(satisfy.satisfaction, "declared");
  assert.deepEqual(satisfy.sourceEvidenceIds, ["subject-expression"]);
  assert.equal("verified" in satisfy, false);
  assert.equal(
    graph.edges.find((edge) => edge.nativeId === "negative-satisfy")?.kind,
    "not-satisfies",
  );
});

function referenceFixture(): ModelSnapshot {
  const snapshot = fixture();
  const assigned = element("assigned", "ItemUsage", "assigned", "agent-type", [
    "contract-type",
  ]);
  assigned.isReference = true;
  const owner = element("owner", "ReferenceUsage", "owner", "contract-type", [
    "agent-type",
  ]);
  owner.isReference = true;
  snapshot.elements.push(
    element("contract-type", "ItemDefinition", "Contract", "pkg"),
    assigned,
    owner,
    element("contract-a", "ItemUsage", "contractA", "system", [
      "contract-type",
    ]),
    element("contract-b", "ItemUsage", "contractB", "system", [
      "contract-type",
    ]),
  );
  for (
    const [partId, contractId] of [["a", "contract-a"], ["b", "contract-b"]]
  ) {
    snapshot.connectors.push(
      {
        id: `assignment-${partId}`,
        metaclass: "BindingConnectorAsUsage",
        ownerId: "system",
        name: "",
        ends: [
          { chain: [{ id: partId, name: "" }, { id: "assigned", name: "" }] },
          { chain: [{ id: contractId, name: "" }] },
        ],
      },
      {
        id: `owner-${partId}`,
        metaclass: "BindingConnectorAsUsage",
        ownerId: "system",
        name: "",
        ends: [
          { chain: [{ id: contractId, name: "" }, { id: "owner", name: "" }] },
          { chain: [{ id: partId, name: "" }] },
        ],
      },
    );
  }
  return snapshot;
}
Deno.test("structural reference cycles retain references, typing and native bindings without cloning referred contents", () => {
  const graph = buildModelGraph(referenceFixture(), native);
  const assignments = graph.nodes.filter((candidate) =>
    candidate.nativeId === "assigned"
  );
  const owners = graph.nodes.filter((candidate) =>
    candidate.nativeId === "owner"
  );
  assert.equal(assignments.length, 2);
  assert.equal(owners.length, 2);
  assert.ok(
    [...assignments, ...owners].every((candidate) => candidate.isReference),
  );
  assert.ok(
    graph.nodes.every((candidate) =>
      ![...assignments, ...owners].some((reference) =>
        reference.id === candidate.parentId
      )
    ),
  );
  assert.ok(
    assignments.every((reference) =>
      graph.edges.some((edge) =>
        edge.kind === "typing" && edge.source === reference.id &&
        edge.target === "def:contract-type"
      )
    ),
  );
  assert.ok(
    owners.every((reference) =>
      graph.edges.some((edge) =>
        edge.kind === "typing" && edge.source === reference.id &&
        edge.target === "def:agent-type"
      )
    ),
  );
  for (
    const [partId, contractId] of [["a", "contract-a"], ["b", "contract-b"]]
  ) {
    const assignment = graph.edges.find((edge) =>
      edge.nativeId === `assignment-${partId}`
    )!;
    const ownerBinding = graph.edges.find((edge) =>
      edge.nativeId === `owner-${partId}`
    )!;
    assert.equal(
      graph.nodes.find((candidate) => candidate.id === assignment.source)!
        .parentId,
      node(graph, partId).id,
    );
    assert.equal(assignment.target, node(graph, contractId).id);
    assert.equal(
      graph.nodes.find((candidate) => candidate.id === ownerBinding.source)!
        .parentId,
      node(graph, contractId).id,
    );
    assert.equal(ownerBinding.target, node(graph, partId).id);
  }
  assert.deepEqual(graph.diagnostics, []);
});
Deno.test("reference ports and referenced behavior scopes continue to expose actual contract members", () => {
  const snapshot = portFixture();
  for (
    const candidate of snapshot.elements.filter((candidate) =>
      candidate.metaclass === "PortUsage"
    )
  ) candidate.isReference = true;
  const graph = buildModelGraph(snapshot);
  assert.equal(
    graph.nodes.filter((candidate) => candidate.nativeId === "payload").length,
    2,
  );
  assert.equal(
    graph.nodes.find((candidate) =>
      candidate.nativeId === "payload" &&
      candidate.parentId === node(graph, "candidates").id
    )?.effectiveDirection,
    "in",
  );
  const behavior = fixture();
  behavior.elements.find((candidate) => candidate.id === "promotion")!
    .isReference = true;
  const behaviorGraph = buildModelGraph(behavior, native);
  assert.equal(
    node(behaviorGraph, "review").parentId,
    node(behaviorGraph, "promotion").id,
  );
  assert.deepEqual(graph.diagnostics, []);
  assert.deepEqual(behaviorGraph.diagnostics, []);
});
Deno.test("reference declarations retain explicit local members and scoped scalar field endpoints", () => {
  const snapshot = referenceFixture();
  snapshot.elements.push(
    element("local-detail", "ItemUsage", "localDetail", "assigned"),
    element("contract-code", "AttributeUsage", "code", "contract-type"),
  );
  snapshot.connectors.push({
    id: "reference-field",
    metaclass: "BindingConnectorAsUsage",
    ownerId: "system",
    name: "",
    ends: [
      {
        chain: [{ id: "a", name: "" }, { id: "assigned", name: "" }, {
          id: "contract-code",
          name: "code",
        }],
      },
      {
        chain: [{ id: "contract-a", name: "" }, {
          id: "contract-code",
          name: "code",
        }],
      },
    ],
  });
  const graph = buildModelGraph(snapshot, native);
  const localMembers = graph.nodes.filter((candidate) =>
    candidate.nativeId === "local-detail"
  );
  assert.equal(localMembers.length, 2);
  assert.ok(
    localMembers.every((candidate) =>
      graph.nodes.find((parent) => parent.id === candidate.parentId)
        ?.nativeId === "assigned"
    ),
  );
  const scopedBinding = graph.edges.find((edge) =>
    edge.nativeId === "reference-field"
  )!;
  assert.equal(
    graph.nodes.find((candidate) => candidate.id === scopedBinding.source)!
      .nativeId,
    "assigned",
  );
  assert.deepEqual(scopedBinding.sourceFeaturePath, [
    "a",
    "assigned",
    "contract-code",
  ]);
  assert.equal(scopedBinding.target, node(graph, "contract-a").id);
  assert.deepEqual(graph.diagnostics, []);
});
Deno.test("owned recursive structures still report a bounded expansion diagnostic", () => {
  const snapshot = fixture();
  snapshot.elements.push(
    element("owned-recursion", "PartUsage", "nested", "agent-type", [
      "agent-type",
    ]),
  );
  const graph = buildModelGraph(snapshot);
  assert.ok(
    graph.diagnostics.some((message) =>
      message.startsWith("Recursive feature expansion stopped")
    ),
  );
});

Deno.test("candidate-owned contract binding resolves its full absolute native chain without suffix guesses", () => {
  const snapshot = fixture();
  const reference = element(
    "contract-feature",
    "ItemUsage",
    "contract",
    "candidate-type",
    ["contract-type"],
  );
  reference.isReference = true;
  snapshot.elements.push(
    element("candidate-type", "PartDefinition", "ToolCandidate", "pkg"),
    element("contract-type", "ItemDefinition", "CapabilityContract", "pkg"),
    reference,
    element("catalog", "PartUsage", "catalog", "system"),
    element("candidate-a", "PartUsage", "candidateA", "catalog", [
      "candidate-type",
    ]),
    element("candidate-b", "PartUsage", "candidateB", "catalog", [
      "candidate-type",
    ]),
    element("contract-a", "ItemUsage", "contractA", "catalog", [
      "contract-type",
    ]),
    element("contract-b", "ItemUsage", "contractB", "catalog", [
      "contract-type",
    ]),
  );
  const chain = (...ids: string[]) => ({
    chain: ids.map((id) => ({ id, name: id })),
  });
  for (
    const [candidate, contract] of [["candidate-a", "contract-a"], [
      "candidate-b",
      "contract-b",
    ]]
  ) {
    snapshot.connectors.push({
      id: `${candidate}-binding`,
      metaclass: "BindingConnectorAsUsage",
      ownerId: candidate!,
      name: "",
      ends: [chain("contract-feature"), chain("system", "catalog", contract!)],
    });
  }
  let graph = buildModelGraph(snapshot);
  const bindings = graph.edges.filter((edge) => edge.kind === "binding");
  assert.equal(bindings.length, 2);
  for (
    const [candidate, contract] of [["candidate-a", "contract-a"], [
      "candidate-b",
      "contract-b",
    ]]
  ) {
    const binding = bindings.find((edge) =>
      edge.nativeId === `${candidate}-binding`
    )!;
    const source = graph.nodes.find((node) => node.id === binding.source)!;
    assert.equal(source.nativeId, "contract-feature");
    assert.equal(source.parentId, node(graph, candidate!).id);
    assert.equal(binding.target, node(graph, contract!).id);
    assert.deepEqual(binding.targetFeaturePath, [
      "system",
      "catalog",
      contract,
    ]);
  }
  assert.deepEqual(graph.diagnostics, []);
  snapshot.connectors.at(-1)!.ends[1] = chain(
    "system",
    "unknown-catalog",
    "contract-b",
  );
  graph = buildModelGraph(snapshot);
  assert.equal(
    graph.edges.some((edge) => edge.nativeId === "candidate-b-binding"),
    false,
  );
  assert.ok(
    graph.diagnostics.some((message) =>
      message.includes("candidate-b-binding")
    ),
  );
});
