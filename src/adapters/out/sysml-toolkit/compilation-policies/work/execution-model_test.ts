import { executeFlow } from "../../../../../../test/support/native-flow-oracle.ts";
import { executionDigest } from "../../../../../domain/primitives/execution-digest.ts";
import {
  deepStrictEqual,
  rejects as assertRejects,
  throws as assertThrows,
} from "node:assert/strict";
import { CaseError } from "../../../../../domain/work/errors/case.ts";
import type { NativeCaseType } from "../../../../../domain/work/records/case-types.ts";
import { compileNativeAuthority } from "./execution-model.ts";
import { isPrimaryDesigner } from "../../../../../domain/model/records/primary-designer.ts";
import { type NativeLiteral } from "../../../../../domain/model/records/native-literal.ts";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../../../../domain/shared-kernel/model-identity.ts";
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function rejects(action: () => unknown, text: string) {
  assertThrows(action, (error: unknown) => {
    assert(
      error instanceof Error && error.message.includes(text),
      String(error),
    );
    return true;
  });
}
function fixture() {
  const elements: ElementRecord[] = [], literals: NativeLiteral[] = [];
  const add = (
    id: string,
    name: string,
    metaclass: string,
    ownerId: string,
    typeIds: string[] = [],
  ) => {
    elements.push({
      id,
      name,
      metaclass,
      ownerId,
      typeIds,
      qualifiedName: name,
      direction: "",
      generalIds: [],
      isReference: false,
      redefinedIds: [],
      multiplicity: "",
      doc: "",
    });
  };
  add("pkg", "ASELiveBuilder", "Package", "root");
  for (
    const [id, name, metaclass] of [
      ["system-type", "ConversationSystem", "PartDefinition"],
      ["builder-type", "ConversationBuilder", "PartDefinition"],
      ["catalog-type", "ToolCatalog", "PartDefinition"],
      ["candidate-type", "ToolCandidate", "PartDefinition"],
      ["operator-type", "SoftwareOperator", "PartDefinition"],
      ["mandate-type", "ConfiguredMandate", "ItemDefinition"],
      ["policy-type", "ExecutionPolicy", "ItemDefinition"],
      ["contract-type", "CapabilityContract", "ItemDefinition"],
      ["conversation-type", "ConversationCase", "ActionDefinition"],
    ]
  ) add(id, name, metaclass, "pkg");
  elements.find((e) => e.id === "builder-type")!.generalIds = ["operator-type"];
  elements.find((e) => e.id === "conversation-type")!.qualifiedName =
    "AssemblyConversation::ConversationCase";
  add("system", "liveBuilder", "PartUsage", "pkg", ["system-type"]);
  add("builder", "builder", "PartUsage", "system", ["builder-type"]);
  add("catalog", "catalog", "PartUsage", "system", ["catalog-type"]);
  add("mandate-feature", "mandate", "ItemUsage", "operator-type", [
    "mandate-type",
  ]);
  add("holder-feature", "holder", "ReferenceUsage", "mandate-type", [
    "operator-type",
  ]);
  add("mandate", "builderMandate", "ItemUsage", "system", ["mandate-type"]);
  add("conversation", "conversation", "PerformActionUsage", "system", [
    "conversation-type",
  ]);
  add("policy", "executionPolicy", "ItemUsage", "conversation", [
    "policy-type",
  ]);
  add("contract-feature", "contract", "ItemUsage", "candidate-type", [
    "contract-type",
  ]);
  elements.find((e) => e.id === "contract-feature")!.isReference = true;
  const field = (
    owner: string,
    name: string,
    value: string | boolean | number,
    scalar = typeof value === "boolean"
      ? "Boolean"
      : typeof value === "number"
      ? "Integer"
      : "String",
  ) => {
    const attributeId = `${owner}-${name}`,
      literalId = `${attributeId}-literal`;
    add(attributeId, name, "AttributeUsage", owner, [`${scalar}-type`]);
    literals.push({
      owner,
      name,
      attributeId,
      literalId,
      kind: `Literal${scalar}`,
      value: String(value),
      typeIds: [`${scalar}-type`],
      typeNames: [`ScalarValues::${scalar}`],
    });
  };
  for (
    const [name, value] of Object.entries({
      configurationId: "native-config",
      configurationRevision: "0",
      admissionMode: "human",
      envelopeKind: "conversational-case-management",
      envelopePattern: "1.3",
      envelopeRevision: "1",
      networkHosts: "[]",
    })
  ) field("system", name, value);
  for (
    const [name, value] of Object.entries({
      id: "builder-v1",
      version: "1",
      mayProposeReadWebPage: true,
      mayProposeReadWebPageOutline: false,
      mayInvokeActiveCatalog: true,
      mayReviewExactCandidate: false,
      mayAdmit: false,
      mayActivate: false,
      mayChangeOwnMandate: false,
      mayCreateAgents: false,
    })
  ) field("mandate", name, value);
  for (
    const [name, value] of Object.entries({
      maxAgentDecisions: 7,
      maxToolProposals: 2,
      maxFlowSteps: 128,
      urlSelectionMode: "user-provided",
      mayAddNetworkHosts: true,
      mayDelegateOwnAdmission: true,
      mayCreateReviewer: true,
      mayChangeUrlSelection: true,
      mayProposeSysmlRevision: true,
    })
  ) field("policy", name, value);
  add("contract", "readWebPageContract", "ItemUsage", "catalog", [
    "contract-type",
  ]);
  field("contract", "kind", "read_web_page");
  field("contract", "module", "default({url,html}) => {title,text}");
  field(
    "contract",
    "acceptanceCriteria",
    "Read body text\nPreserve source evidence",
  );
  const snapshot: ModelSnapshot = {
    rootId: "root",
    elements,
    connectors: [{
      id: "forward",
      metaclass: "BindingConnectorAsUsage",
      ownerId: "system",
      name: "",
      ends: [{
        chain: [{ id: "builder", name: "builder" }, {
          id: "mandate-feature",
          name: "mandate",
        }],
      }, { chain: [{ id: "mandate", name: "builderMandate" }] }],
    }, {
      id: "inverse",
      metaclass: "BindingConnectorAsUsage",
      ownerId: "system",
      name: "",
      ends: [{
        chain: [{ id: "mandate", name: "builderMandate" }, {
          id: "holder-feature",
          name: "holder",
        }],
      }, { chain: [{ id: "builder", name: "builder" }] }],
    }],
    invocations: [],
    patternIds: [],
  };
  const identity: ModelIdentity = {
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    builderId: "builder",
    catalogId: "catalog",
  };
  const bindContract = (candidate = "candidate", contract = "contract") => {
    snapshot.connectors.push({
      id: `${candidate}-contract-binding`,
      name: "",
      metaclass: "BindingConnectorAsUsage",
      ownerId: candidate,
      ends: [
        { chain: [{ id: "contract-feature", name: "contract" }] },
        {
          chain: ["system", "catalog", contract].map((id) => ({
            id,
            name: id,
          })),
        },
      ],
    });
  };
  return { snapshot, literals, identity, field, add, bindContract };
}
Deno.test("native authority and capability contracts compile independently of host snapshots", () => {
  const f = fixture();
  let native = compileNativeAuthority(f.snapshot, f.literals, f.identity);
  assert(
    native.configuration.id === "native-config" &&
      native.configuration.network!.allowedHosts.length === 0,
  );
  assert(native.builderMandate.mayPropose.join(",") === "read_web_page");
  assert(native.policy.maxAgentDecisions === 7);
  assert(native.contracts[0]!.acceptanceCriteria[0] === "Read body text");
  assert(native.contracts[0]!.nativeId === "contract");
  assert(
    native.sourceIds.includes("conversation") &&
      native.sourceIds.includes("policy"),
  );
  f.literals.find((v) => v.name === "mayAdmit")!.value = "true";
  f.literals.find((v) => v.name === "admissionMode")!.value = "builder";
  native = compileNativeAuthority(f.snapshot, f.literals, f.identity);
  assert(native.configuration.builder.admissionAuthority === "builder");
  assert(native.configuration.changes.length === 0);
});
Deno.test("native operator endpoint metadata compiles only when complete (B11)", () => {
  const f = fixture();
  f.field("system", "operatorName", "Designer");
  f.field(
    "system",
    "operatorInstruction",
    "Design and evolve this system with the person, and create operators to handle Requests.",
  );
  f.field("system", "primaryContact", true);
  f.field("system", "humanInputEnabled", true);
  const native = compileNativeAuthority(f.snapshot, f.literals, f.identity);
  assert(native.operator?.name === "Designer");
  assert(native.operator?.primary === true);
  assert(native.operator?.humanInput === true);
  const g = fixture();
  g.field("system", "operatorName", "Designer");
  rejects(
    () => compileNativeAuthority(g.snapshot, g.literals, g.identity),
    "Incomplete native operator endpoint metadata",
  );
});
Deno.test("native mismatched scalar type, literal identity, ambiguity, and contradictory rights reject", () => {
  for (
    const mutate of [(f: ReturnType<typeof fixture>) => {
      f.literals.find((v) => v.name === "mayAdmit")!.kind = "LiteralString";
    }, (f: ReturnType<typeof fixture>) => {
      f.literals.find((v) => v.name === "maxAgentDecisions")!.typeNames = [
        "Custom::Integer",
      ];
    }, (f: ReturnType<typeof fixture>) => {
      f.literals.find((v) => v.name === "networkHosts")!.attributeId =
        "foreign";
    }, (f: ReturnType<typeof fixture>) => {
      f.literals.push({ ...f.literals[0]! });
    }]
  ) {
    const f = fixture();
    mutate(f);
    rejects(
      () => compileNativeAuthority(f.snapshot, f.literals, f.identity),
      "native",
    );
  }
  const f = fixture();
  f.literals.find((v) => v.name === "mayAdmit")!.value = "true";
  rejects(
    () => compileNativeAuthority(f.snapshot, f.literals, f.identity),
    "Contradictory",
  );
});
Deno.test("native holder bindings, proposal contract coverage, and unsupported active powers fail closed", () => {
  const f = fixture();
  f.snapshot.connectors.pop();
  rejects(
    () => compileNativeAuthority(f.snapshot, f.literals, f.identity),
    "holder binding",
  );
  const g = fixture();
  g.literals.find((v) => v.name === "mayProposeReadWebPageOutline")!.value =
    "true";
  rejects(
    () => compileNativeAuthority(g.snapshot, g.literals, g.identity),
    "lacks capability contract",
  );
  const h = fixture();
  h.literals.find((v) => v.name === "mayCreateAgents")!.value = "true";
  rejects(
    () => compileNativeAuthority(h.snapshot, h.literals, h.identity),
    "Unsupported native authority",
  );
});
Deno.test("catalog is separately verified and excluded from authority source identities", async () => {
  const f = fixture(),
    before = compileNativeAuthority(f.snapshot, f.literals, f.identity);
  f.add("candidate", "candidate_1", "PartUsage", "catalog", ["candidate-type"]);
  for (
    const [name, value] of Object.entries({
      candidateId: "c1",
      name: "Page Reader",
      kind: "read_web_page",
      digest: "a".repeat(64),
      status: "active",
    })
  ) f.field("candidate", name, value);
  f.bindContract();
  const after = compileNativeAuthority(f.snapshot, f.literals, f.identity);
  assert(after.capabilities[0]!.status === "active");
  assert(after.capabilities[0]!.contractId === "contract");
  assert(
    after.capabilities[0]!.sourceIds.includes("candidate-contract-binding"),
  );
  assert(!after.sourceIds.includes("candidate-contract-binding"));
  assert(JSON.stringify(before.sourceIds) === JSON.stringify(after.sourceIds));
  assert(
    await executionDigest(before.configuration) ===
      await executionDigest(after.configuration),
  );
  f.literals.find((v) => v.owner === "candidate" && v.name === "digest")!
    .value = "wrong";
  rejects(
    () => compileNativeAuthority(f.snapshot, f.literals, f.identity),
    "catalog entry",
  );
});
Deno.test("new native candidates are active without a status literal; legacy stages remain readable", () => {
  const f = fixture();
  f.add("candidate", "candidate_1", "PartUsage", "catalog", ["candidate-type"]);
  for (
    const [name, value] of Object.entries({
      candidateId: "c1",
      name: "Page Reader",
      kind: "read_web_page",
      digest: "a".repeat(64),
    })
  ) f.field("candidate", name, value);
  f.bindContract();
  const activated = compileNativeAuthority(f.snapshot, f.literals, f.identity);
  assert(activated.capabilities[0]!.status === "active");
  f.field("candidate", "status", "reviewing");
  const legacy = compileNativeAuthority(f.snapshot, f.literals, f.identity);
  assert(legacy.capabilities[0]!.status === "reviewing");
});
Deno.test("native integer policy rejects string substitution and noncanonical numeric encodings", () => {
  const f = fixture();
  f.literals.find((v) => v.name === "maxAgentDecisions")!.kind =
    "LiteralString";
  rejects(
    () => compileNativeAuthority(f.snapshot, f.literals, f.identity),
    "typed native literal",
  );
  const g = fixture();
  g.literals.find((v) => v.name === "maxAgentDecisions")!.value = "7.0";
  rejects(
    () => compileNativeAuthority(g.snapshot, g.literals, g.identity),
    "Integer",
  );
});

import { compileExecutableModel } from "./execution-model.ts";
import type {
  FlowProjection,
  FlowProjectionEdge,
  FlowProjectionNode,
} from "../../../../../domain/model/execution/flow.ts";
function executableFixture() {
  const f = fixture();
  const nodes: FlowProjectionNode[] = [], edges: FlowProjectionEdge[] = [];
  const source = (id: string) => ({ file: "native.sysml", line: id });
  f.add("reply-type", "ReplyOrClarify", "ActionDefinition", "pkg");
  nodes.push({
    id: "reply-type",
    nativeId: "reply-type",
    label: "ReplyOrClarify",
    metaclass: "ActionDefinition",
    symbol: "ASEConversation::ReplyOrClarify",
    source: source("reply-type"),
  });
  for (
    const [name, typeName] of [["conversation", "ConversationCase"], [
      "promotion",
      "CapabilityPromotion",
    ]]
  ) {
    if (name !== "conversation") {
      f.add(`${name}-type`, typeName, "ActionDefinition", "pkg");
      f.add(name, name, "PerformActionUsage", "system", [`${name}-type`]);
    }
    nodes.push({
      id: name,
      nativeId: name,
      label: name,
      metaclass: "PerformActionUsage",
      source: source(name),
    });
    for (
      const [suffix, label, symbol] of [
        ["start", "start", "Actions::Action::start"],
        ["reply", "reply", undefined],
        ["done", "done", "Actions::Action::done"],
      ] as const
    ) {
      const id = `${name}-${suffix}`;
      nodes.push({
        id,
        nativeId: id,
        label,
        metaclass: "ActionUsage",
        parentId: name,
        symbol,
        source: source(id),
      });
    }
    for (const [from, to] of [["start", "reply"], ["reply", "done"]]) {
      const id = `${name}-${from}-${to}`;
      edges.push({
        id,
        nativeId: id,
        source: `${name}-${from}`,
        target: `${name}-${to}`,
        kind: "succession",
        metaclass: "SuccessionAsUsage",
        sourceEvidence: source(id),
      });
    }
    edges.push({
      id: `${name}-typing`,
      source: `${name}-reply`,
      target: "reply-type",
      kind: "typing",
    });
    f.snapshot.connectors.push({
      id: `${name}-allocation`,
      name: "",
      metaclass: "AllocationUsage",
      ownerId: "system",
      ends: [{
        chain: [{ id: name, name }, { id: `${name}-reply`, name: "reply" }],
      }, { chain: [{ id: "builder", name: "builder" }] }],
    });
  }
  return { ...f, graph: { nodes, edges } as FlowProjection };
}

function scheduledFlowFixture() {
  const f = executableFixture();
  f.add("scheduled", "scheduled", "PerformActionUsage", "system", [
    "conversation-type",
  ]);
  const rename = (id: string) =>
    id.replace(/^conversation(?=-|$)/, "scheduled");
  f.graph.nodes = [
    ...f.graph.nodes,
    ...f.graph.nodes.filter((node) =>
      node.id === "conversation" || node.parentId === "conversation"
    ).map((node) => ({
      ...structuredClone(node),
      id: rename(node.id),
      nativeId: rename(node.nativeId!),
      ...(node.parentId ? { parentId: rename(node.parentId) } : {}),
    })),
  ];
  f.graph.edges = [
    ...f.graph.edges,
    ...f.graph.edges.filter((edge) => edge.source.startsWith("conversation-"))
      .map((edge) => ({
        ...structuredClone(edge),
        id: rename(edge.id),
        ...(edge.nativeId ? { nativeId: rename(edge.nativeId) } : {}),
        source: rename(edge.source),
        target: rename(edge.target),
      })),
  ];
  const allocation = structuredClone(
    f.snapshot.connectors.find((connector) =>
      connector.id === "conversation-allocation"
    )!,
  );
  allocation.id = "scheduled-allocation";
  for (const end of allocation.ends) {
    for (const segment of end.chain) segment.id = rename(segment.id);
  }
  f.snapshot.connectors.push(allocation);
  const type: NativeCaseType = {
    id: "job-type",
    name: "Scheduled summary",
    type: "job",
    envelope: "deterministic",
    behaviorId: "scheduled",
    ownerId: "builder",
    schedule: { kind: "daily-at", hour: 9, minute: 0 },
    sourceIds: ["job-type"],
  };
  return { ...f, type };
}

Deno.test("scheduled native behaviors compile their own allocated flows without changing legacy encodings", async () => {
  const f = scheduledFlowFixture();
  const base = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
  );
  const implicitConversation = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
    [{ ...f.type, behaviorId: "conversation" }],
  );
  assert(!Object.hasOwn(base, "caseFlows"));
  deepStrictEqual(base, implicitConversation);
  const model = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
    [f.type],
  );
  const flow = model.caseFlows!.scheduled;
  assert(flow.rootNativeId === "scheduled");
  assert(
    flow.nodes.find((node) => node.name === "reply")!.performerId === "builder",
  );
  assert(
    flow.nodes.find((node) => node.name === "reply")!.allocationId ===
      "scheduled-allocation",
  );
  assert(model.version.sourceIds.includes("scheduled-reply"));
  assert(model.version.digest !== base.version.digest);
  deepStrictEqual(model.flows, base.flows);
  const duplicate = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
    [f.type, { ...f.type, id: "another-job" }],
  );
  deepStrictEqual(duplicate, model);
});

Deno.test("scheduled native flows reject missing ambiguous and foreign allocations with structured errors", async () => {
  for (
    const alter of [
      (f: ReturnType<typeof scheduledFlowFixture>) => {
        f.snapshot.connectors = f.snapshot.connectors.filter((connector) =>
          connector.id !== "scheduled-allocation"
        );
      },
      (f: ReturnType<typeof scheduledFlowFixture>) => {
        f.snapshot.connectors.push({
          ...structuredClone(
            f.snapshot.connectors.find((connector) =>
              connector.id === "scheduled-allocation"
            )!,
          ),
          id: "duplicate-allocation",
        });
      },
      (f: ReturnType<typeof scheduledFlowFixture>) => {
        f.snapshot.connectors.find((connector) =>
          connector.id === "scheduled-allocation"
        )!.ends[1].chain[0].id = "catalog";
      },
      (f: ReturnType<typeof scheduledFlowFixture>) => {
        f.type.behaviorId = "missing-behavior";
      },
    ]
  ) {
    const f = scheduledFlowFixture();
    alter(f);
    await assertRejects(
      () =>
        compileExecutableModel(f.snapshot, f.graph, f.literals, f.identity, [
          f.type,
        ]),
      (error) =>
        error instanceof CaseError && error.code === "INVALID_CASE" &&
        error.context?.caseTypeId === "job-type" &&
        error.context.behaviorId === f.type.behaviorId && !!error.recovery,
    );
  }
});

Deno.test("scheduled native flows cannot execute promotion primitives", async () => {
  const f = scheduledFlowFixture();
  f.graph.nodes = [...f.graph.nodes, {
    id: "propose-type",
    nativeId: "propose-type",
    label: "ProposeCandidate",
    metaclass: "ActionDefinition",
    symbol: "ASEPrototype::ProposeCandidate",
    source: { file: "native.sysml", line: 1 },
  }];
  f.graph.edges.find((edge) => edge.id === "scheduled-typing")!.target =
    "propose-type";
  await assertRejects(
    () =>
      compileExecutableModel(f.snapshot, f.graph, f.literals, f.identity, [
        f.type,
      ]),
    (error) =>
      error instanceof CaseError && error.code === "INVALID_CASE" &&
      /conversation primitives/.test(error.message),
  );
});

Deno.test("a scheduled declaration for an unsupported owner is refused instead of remaining inert", async () => {
  const f = scheduledFlowFixture();
  f.type.ownerId = "reviewer";
  await assertRejects(
    () =>
      compileExecutableModel(f.snapshot, f.graph, f.literals, f.identity, [
        f.type,
      ]),
    (error) =>
      error instanceof CaseError && error.code === "INVALID_CASE" &&
      error.context?.caseTypeId === f.type.id &&
      error.context.ownerId === "reviewer" &&
      !!error.recovery,
  );
});
Deno.test("executable version includes exact native flows and policy while excluding catalog stage and view metadata", async () => {
  const f = executableFixture();
  const before = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
  );
  // Captured with the unchanged HEAD compiler before authority schema 2.
  assert(
    before.version.digest ===
      "770370b3aea845d60e3d40cc16e1ce2b7a2c5f2d2229c0d2fec7a19144d8c741",
  );
  assert(before.ownerAuthority?.ownerSource === "implicit-legacy");
  assert(before.version.authoritySchema === undefined);
  assert(
    before.flows.conversation.nodes.find((n) => n.name === "reply")!
      .performerId === "builder",
  );
  assert(before.version.sourceIds.includes("conversation-allocation"));
  f.add("candidate", "candidate1", "PartUsage", "catalog", ["candidate-type"]);
  for (
    const [name, value] of Object.entries({
      candidateId: "candidate1",
      name: "Page reader",
      kind: "read_web_page",
      digest: "a".repeat(64),
      status: "proposed",
    })
  ) f.field("candidate", name, value);
  f.bindContract();
  f.graph.nodes[0]!.source = {
    file: "native.sysml",
    line: 999,
    quote: "moved after view-only section",
  };
  const after = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
  );
  assert(before.version.digest === after.version.digest);
  assert(after.catalog.length === 1);
  f.literals.find((v) => v.name === "maxAgentDecisions")!.value = "8";
  const revised = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
  );
  assert(revised.version.digest !== before.version.digest);
});
Deno.test("executable native reallocation to an unsupported actor fails closed", async () => {
  const f = executableFixture();
  f.snapshot.connectors.find((c) => c.id === "conversation-allocation")!
    .ends[1]!.chain[0]!.id = "catalog";
  try {
    await compileExecutableModel(f.snapshot, f.graph, f.literals, f.identity);
  } catch (e) {
    assert(e instanceof Error && e.message.includes("performer"));
    return;
  }
  throw new Error("Expected unsupported allocation rejection");
});

Deno.test("native policy requires the actual typed conversation owner and rejects legacy placement", () => {
  for (
    const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.elements.find((e) => e.id === "policy")!.ownerId = "system";
      },
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.elements.find((e) => e.id === "conversation")!.typeIds = [
          "builder-type",
        ];
      },
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.elements.find((e) => e.id === "conversation")!.metaclass =
          "PartUsage";
      },
      (f: ReturnType<typeof fixture>) => {
        f.add("old-policy", "executionPolicy", "ItemUsage", "system", [
          "policy-type",
        ]);
      },
    ]
  ) {
    const f = fixture();
    mutate(f);
    rejects(
      () => compileNativeAuthority(f.snapshot, f.literals, f.identity),
      "native",
    );
  }
});

Deno.test("native candidate contract references reject missing, ambiguous, foreign, wrong-kind and mistyped bindings", () => {
  const candidateFixture = () => {
    const f = fixture();
    f.add("candidate", "candidate_1", "PartUsage", "catalog", [
      "candidate-type",
    ]);
    for (
      const [name, value] of Object.entries({
        candidateId: "c1",
        name: "Reader",
        kind: "read_web_page",
        digest: "a".repeat(64),
        status: "proposed",
      })
    ) f.field("candidate", name, value);
    f.bindContract();
    return f;
  };
  for (
    const mutate of [
      (f: ReturnType<typeof candidateFixture>) => {
        f.snapshot.connectors.pop();
      },
      (f: ReturnType<typeof candidateFixture>) => {
        f.snapshot.connectors.push({
          ...structuredClone(f.snapshot.connectors.at(-1)!),
          id: "duplicate-binding",
        });
      },
      (f: ReturnType<typeof candidateFixture>) => {
        f.snapshot.connectors.at(-1)!.ends[1]!.chain[1]!.id = "foreign-catalog";
      },
      (f: ReturnType<typeof candidateFixture>) => {
        f.snapshot.connectors.at(-1)!.ends[1]!.chain[2]!.id = "builder";
      },
      (f: ReturnType<typeof candidateFixture>) => {
        f.literals.find((v) => v.owner === "candidate" && v.name === "kind")!
          .value = "read_web_page_outline";
      },
      (f: ReturnType<typeof candidateFixture>) => {
        f.snapshot.elements.find((e) => e.id === "contract-feature")!.typeIds =
          ["mandate-type"];
      },
      (f: ReturnType<typeof candidateFixture>) => {
        f.snapshot.elements.find((e) => e.id === "contract-feature")!
          .isReference = false;
      },
      (f: ReturnType<typeof candidateFixture>) => {
        f.snapshot.elements.find((e) => e.id === "contract")!.ownerId =
          "system";
      },
      (f: ReturnType<typeof candidateFixture>) => {
        f.snapshot.connectors.at(-1)!.ownerId = "catalog";
      },
    ]
  ) {
    const f = candidateFixture();
    mutate(f);
    rejects(
      () => compileNativeAuthority(f.snapshot, f.literals, f.identity),
      "native",
    );
  }
});

Deno.test("native contract identity and policy placement participate in executable evidence", async () => {
  const f = executableFixture();
  const before = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
  );
  const contract = f.snapshot.elements.find((e) => e.id === "contract")!;
  contract.id = "revised-contract";
  for (const e of f.snapshot.elements.filter((e) => e.ownerId === "contract")) {
    e.ownerId = contract.id;
  }
  for (const v of f.literals.filter((v) => v.owner === "contract")) {
    v.owner = contract.id;
  }
  const after = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
  );
  assert(after.contracts[0]!.nativeId === "revised-contract");
  assert(after.version.digest !== before.version.digest);
  assert(
    after.version.sourceIds.includes("conversation") &&
      after.version.sourceIds.includes("policy"),
  );
  assert(
    after.version.sourceIds.includes("revised-contract") &&
      !after.version.sourceIds.includes("contract"),
  );
});

Deno.test("modeled-owner primary advertises operator authority only with source proposal capability", async () => {
  const f = executableFixture();
  for (
    const [id, name, metaclass] of [
      ["owner-operator-type", "ASECore::Operator", "PartDefinition"],
      ["human-type", "ASECore::HumanOperator", "PartDefinition"],
      ["owner-mandate-type", "ASEAuthority::Mandate", "ItemDefinition"],
      ["root-type", "ASEAuthority::RootAuthority", "PartDefinition"],
      ["grant-type", "ASEAuthority::RootGrant", "PartDefinition"],
    ]
  ) f.add(id!, name!, metaclass!, "pkg");
  f.snapshot.elements.find((e) => e.id === "human-type")!.generalIds = [
    "owner-operator-type",
  ];
  f.add("owner-holder", "holder", "PartUsage", "owner-mandate-type", [
    "owner-operator-type",
  ]);
  f.add("owner-issuer", "issuer", "PartUsage", "grant-type", ["root-type"]);
  for (const id of ["owner-holder", "owner-issuer"]) {
    f.snapshot.elements.find((e) => e.id === id)!.isReference = true;
  }
  f.add("owner", "owner", "PartUsage", "system", ["human-type"]);
  f.add("owner-mandate", "ownerMandate", "ItemUsage", "owner", [
    "owner-mandate-type",
  ]);
  f.add("owner-root", "rootAuthority", "PartUsage", "owner-mandate", [
    "root-type",
  ]);
  f.add("owner-grant", "rootGrant", "PartUsage", "owner-mandate", [
    "grant-type",
  ]);
  f.field("owner-mandate", "id", "owner");
  f.field("owner-mandate", "revision", 1);
  f.field("owner-root", "id", "root");
  f.field("owner-grant", "id", "root-grant");
  for (
    const [id, ownerId, left, right] of [
      ["owner-holder-binding", "system", [
        "owner",
        "owner-mandate",
        "owner-holder",
      ], ["owner"]],
      [
        "owner-issuer-binding",
        "owner-mandate",
        ["owner-grant", "owner-issuer"],
        ["owner-root"],
      ],
    ] as const
  ) {
    f.snapshot.connectors.push({
      id,
      ownerId,
      name: "",
      metaclass: "BindingConnectorAsUsage",
      ends: [left, right].map((chain) => ({
        chain: chain.map((id) => ({ id, name: id })),
      })),
    });
  }
  for (const allowed of [true, false]) {
    f.literals.find((l) => l.name === "mayProposeSysmlRevision")!.value =
      String(allowed);
    const model = await compileExecutableModel(
      f.snapshot,
      f.graph,
      f.literals,
      f.identity,
    );
    assert(model.ownerAuthority?.ownerSource === "modeled");
    assert(
      model.mandate.supportedChanges.some((change) =>
        change.requestedRights === "operatorAuthority"
      ) === allowed,
    );
    assert(
      !model.mandate.supportedChanges.some((change) =>
        change.requestedRights === "toolAdmission"
      ),
      "A legacy model without the native definition cannot request tool admission grants",
    );
  }
});

Deno.test("the primary designer is the modeled contact, or the default designer when no system declares one", () => {
  const operator = (primary: boolean) => ({
    name: "Operator",
    instruction: "Answer",
    primary,
    humanInput: true,
  });
  const contact = (value: string): NativeLiteral => ({
    owner: "other",
    name: "primaryContact",
    attributeId: "attribute",
    literalId: "literal",
    kind: "LiteralBoolean",
    value,
    typeIds: [],
    typeNames: [],
  });
  const designer = "ASELiveBuilder::liveBuilder";
  assert(isPrimaryDesigner({ operator: operator(true) }, "Other::system", []));
  assert(!isPrimaryDesigner({ operator: operator(false) }, designer, []));
  assert(isPrimaryDesigner({}, designer, []));
  assert(isPrimaryDesigner({}, undefined, []));
  assert(!isPrimaryDesigner({}, "Other::system", []));
  assert(isPrimaryDesigner({}, designer, [contact("false")]));
  assert(!isPrimaryDesigner({}, designer, [contact("true")]));
});

function operatorCommandFixture(factory = false) {
  const f = executableFixture();
  const flowName = factory ? "operatorFlowTemplate" : "conversation";
  f.add("private-template", "PrivateConversationV2", "ActionDefinition", "pkg");
  f.snapshot.elements.find((element) => element.id === "private-template")!
    .qualifiedName = "Private::PrivateConversationV2";
  f.field("private-template", "executionProfile", "operator-command-v1");
  f.field("private-template", "templateRevision", 2);
  if (factory) {
    f.add(flowName, flowName, "PerformActionUsage", "system", [
      "private-template",
    ]);
    f.field("system", "operatorFlowTemplateRevision", 2);
    f.graph.nodes = [...f.graph.nodes, {
      id: flowName,
      nativeId: flowName,
      label: flowName,
      metaclass: "PerformActionUsage",
      source: { file: "private.sysml", line: 1 },
    }];
  } else {
    f.snapshot.elements.find((element) => element.id === "conversation")!
      .typeIds = ["private-template"];
    f.graph.nodes = f.graph.nodes.filter((node) =>
      node.parentId !== "conversation"
    );
    f.graph.edges = f.graph.edges.filter((edge) =>
      !edge.source.startsWith("conversation-")
    );
    f.snapshot.connectors = f.snapshot.connectors.filter((connector) =>
      connector.id !== "conversation-allocation"
    );
  }
  f.add("gate-type", "CatalogAdmissionGate", "PartDefinition", "pkg");
  f.add("gate", "admissionGate", "PartUsage", "system", ["gate-type"]);
  const source = { file: "private.sysml", line: 1 };
  const nodes = [...f.graph.nodes], edges = [...f.graph.edges];
  const add = (
    name: string,
    metaclass: string,
    type?: string,
    output?: string,
  ) => {
    const id = `${flowName}-${name}`;
    nodes.push({
      id,
      nativeId: id,
      label: name,
      metaclass,
      parentId: flowName,
      source,
      ...(name === "start" ? { symbol: "Actions::Action::start" } : {}),
    });
    if (type) {
      const typeId = `${type}-type`;
      f.add(typeId, type, "ActionDefinition", "pkg");
      f.snapshot.elements.find((element) => element.id === typeId)!
        .qualifiedName = `AssemblyConversation::${type}`;
      nodes.push({
        id: typeId,
        nativeId: typeId,
        label: type,
        metaclass: "ActionDefinition",
        symbol: `AssemblyConversation::${type}`,
        source,
      });
      edges.push({
        id: `${id}-typing`,
        source: id,
        target: typeId,
        kind: "typing",
      });
      if (!factory) {
        f.snapshot.connectors.push({
          id: `${id}-allocate`,
          name: "",
          metaclass: "AllocationUsage",
          ownerId: "system",
          ends: [{ chain: [{ id: flowName, name: flowName }, { id, name }] }, {
            chain: [{
              id: type === "ChooseNextMove" ? "builder" : "gate",
              name: "performer",
            }],
          }],
        });
      }
    }
    if (output) {
      nodes.push({
        id: `${id}-${output}`,
        nativeId: `${id}-${output}`,
        label: output,
        metaclass: "ItemUsage",
        parentId: id,
        declaredDirection: "out",
        source,
      });
    }
    return id;
  };
  add("start", "ActionUsage");
  const consultId = add(
    "consult",
    "ActionUsage",
    "ConsultDeclaredModelSource",
    "consultation",
  );
  f.field(
    consultId,
    "consultationRequest",
    JSON.stringify({ operation: "read_source", path: "conversation.sysml" }),
  );
  add("consultationOutcome", "DecisionNode");
  add("choose", "ActionUsage", "ChooseNextMove", "choice");
  add("choiceOutcome", "DecisionNode");
  add("command", "ActionUsage", "ExecuteOperatorCommand", "outcome");
  add("wait", "ActionUsage", "AwaitCaseInput");
  for (
    const [from, to, guard] of [
      ["start", "consult"],
      ["consult", "consultationOutcome"],
      ["consultationOutcome", "choose", "consult.consultation.succeeded"],
      ["consultationOutcome", "wait", "else"],
      ["choose", "choiceOutcome"],
      ["choiceOutcome", "wait", 'choose.choice.kind == "reply"'],
      ["choiceOutcome", "command", "else"],
      ["command", "consult"],
      ["wait", "consult"],
    ]
  ) {
    edges.push({
      id: `${flowName}-${from}-${to}`,
      nativeId: `${flowName}-${from}-${to}`,
      source: `${flowName}-${from}`,
      target: `${flowName}-${to}`,
      kind: "succession",
      metaclass: "SuccessionAsUsage",
      sourceEvidence: source,
      ...(guard
        ? { guard, guardIds: [`${flowName}-${from}-${to}-guard`] }
        : {}),
    });
  }
  f.graph = { nodes, edges };
  return { ...f, flowName };
}

Deno.test("compiler capture exposes the exact legacy digest input without aliasing or changing historical encoding", async () => {
  const f = executableFixture();
  let captured: Record<string, unknown> | undefined;
  const model = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
    [],
    (value) => {
      captured = value;
    },
  );
  assert(captured);
  assert(await executionDigest(captured) === model.version.digest);
  assert(
    model.version.digest ===
      "770370b3aea845d60e3d40cc16e1ce2b7a2c5f2d2229c0d2fec7a19144d8c741",
  );
  assert(
    Array.isArray(captured.allocations) && Array.isArray(captured.sourceIds),
  );
  (captured.sourceIds as string[]).push("mutated-copy");
  assert(!model.version.sourceIds.includes("mutated-copy"));
});

Deno.test("private occurrence-selected flow executes a fresh consultation per decision and takes explicit failure branch", async () => {
  const f = operatorCommandFixture();
  const model = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
  );
  assert(model.flows.conversation.executionProfile === "operator-command-v1");
  let decisions = 0;
  const calls: string[] = [];
  await executeFlow(model.flows.conversation, {}, (node) => {
    calls.push(node.mechanism!);
    if (node.mechanism === "consult_declared_source") {
      return { outputs: { consultation: { succeeded: true } } };
    }
    if (node.mechanism === "choose_move") {
      return {
        outputs: { choice: { kind: decisions++ ? "reply" : "open_request" } },
      };
    }
    if (node.mechanism === "execute_operator_command") {
      return { outputs: { outcome: { succeeded: true } } };
    }
    return { suspend: true };
  });
  deepStrictEqual(calls, [
    "consult_declared_source",
    "choose_move",
    "execute_operator_command",
    "consult_declared_source",
    "choose_move",
    "await_input",
  ]);
  const failed: string[] = [];
  await executeFlow(model.flows.conversation, {}, (node) => {
    failed.push(node.mechanism!);
    return node.mechanism === "consult_declared_source"
      ? { outputs: { consultation: { succeeded: false } } }
      : { suspend: true };
  });
  deepStrictEqual(failed, ["consult_declared_source", "await_input"]);
  assert(
    f.snapshot.elements.find((element) => element.id === "conversation-type")!
      .name === "ConversationCase",
  );
});

Deno.test("immutable group profile has its own pin and permits a decision loop without repeated consultation", async () => {
  const f = operatorCommandFixture();
  const scalar = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
  );
  const profile = f.literals.find((literal) =>
    literal.name === "executionProfile"
  )!;
  profile.value = "operator-command-immutable-group-v1";
  const group = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
  );
  assert(
    group.flows.conversation.executionProfile ===
      "operator-command-immutable-group-v1",
  );
  assert(group.version.digest !== scalar.version.digest);
  assert(group.version.sourceIds.includes(profile.attributeId));
  assert(group.version.sourceIds.includes(profile.literalId));
  const actions: string[] = [];
  await executeFlow(group.flows.conversation, {}, (node) => {
    actions.push(node.mechanism!);
    return node.mechanism === "consult_declared_source"
      ? { outputs: { consultation: { succeeded: false } } }
      : { suspend: true };
  });
  deepStrictEqual(actions, ["consult_declared_source", "await_input"]);
  f.graph.edges.find((edge) => edge.id === "conversation-command-consult")!
    .target = "conversation-choose";
  const optional = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
  );
  assert(optional.version.digest !== group.version.digest);
  assert(
    optional.flows.conversation.edges.some((edge) =>
      edge.source === "conversation-command" &&
      edge.target === "conversation-choose"
    ),
  );
});

Deno.test("command submission guard changes the compiled pin and routes both profiles", async () => {
  for (
    const profile of [
      "operator-command-v1",
      "operator-command-immutable-group-v1",
    ]
  ) {
    const f = operatorCommandFixture();
    f.literals.find((literal) => literal.name === "executionProfile")!.value =
      profile;
    const before = await compileExecutableModel(
      f.snapshot,
      f.graph,
      f.literals,
      f.identity,
    );
    const command = f.graph.nodes.find((node) =>
      node.id === "conversation-command"
    )!;
    const output = f.graph.nodes.find((node) =>
      node.id === "conversation-command-outcome"
    )!;
    f.graph.nodes = [...f.graph.nodes, {
      ...output,
      id: "conversation-command-submission",
      nativeId: "conversation-command-submission",
      label: "submission",
    }];
    const decision = f.graph.nodes.find((node) =>
      node.id === "conversation-choiceOutcome"
    )!;
    f.graph.nodes = [...f.graph.nodes, {
      ...decision,
      id: "conversation-commandOutcome",
      nativeId: "conversation-commandOutcome",
      label: "commandOutcome",
    }];
    const previous = f.graph.edges.find((edge) =>
      edge.id === "conversation-command-consult"
    )!;
    previous.target = "conversation-commandOutcome";
    f.graph.edges = [...f.graph.edges, {
      ...previous,
      id: "command-wait",
      nativeId: "command-wait",
      source: "conversation-commandOutcome",
      target: "conversation-wait",
      guard: "command.submission.awaitingInput",
      guardIds: ["command-wait-guard"],
    }, {
      ...previous,
      id: "command-continue",
      nativeId: "command-continue",
      source: "conversation-commandOutcome",
      target: "conversation-consult",
      guard: "else",
      guardIds: ["command-continue-guard"],
    }];
    const after = await compileExecutableModel(
      f.snapshot,
      f.graph,
      f.literals,
      f.identity,
    );
    assert(after.version.digest !== before.version.digest);
    assert(command);
    for (const awaitingInput of [true, false]) {
      const visited: string[] = [];
      let decisions = 0;
      await executeFlow(after.flows.conversation, {}, (node) => {
        visited.push(node.mechanism!);
        if (node.mechanism === "consult_declared_source") {
          return { outputs: { consultation: { succeeded: true } } };
        }
        if (node.mechanism === "choose_move") {
          return {
            outputs: {
              choice: { kind: decisions++ ? "reply" : "open_request" },
            },
          };
        }
        if (node.mechanism === "execute_operator_command") {
          return { outputs: { outcome: {}, submission: { awaitingInput } } };
        }
        if (node.mechanism === "await_input") return { suspend: true };
        throw new Error(`Unexpected native mechanism ${node.mechanism}`);
      });
      assert(
        visited.filter((name) => name === "choose_move").length ===
          (awaitingInput ? 1 : 2),
      );
      assert(visited.at(-1) === "await_input");
    }
  }
});

Deno.test("a future operator template guard changes its own digest without changing revision", async () => {
  const f = operatorCommandFixture(true);
  const before = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
  );
  const output = f.graph.nodes.find((node) =>
    node.id === "operatorFlowTemplate-command-outcome"
  )!;
  const decision = f.graph.nodes.find((node) =>
    node.id === "operatorFlowTemplate-choiceOutcome"
  )!;
  f.graph.nodes = [...f.graph.nodes, {
    ...output,
    id: "operatorFlowTemplate-command-submission",
    nativeId: "operatorFlowTemplate-command-submission",
    label: "submission",
  }, {
    ...decision,
    id: "operatorFlowTemplate-commandOutcome",
    nativeId: "operatorFlowTemplate-commandOutcome",
    label: "commandOutcome",
  }];
  const previous = f.graph.edges.find((edge) =>
    edge.id === "operatorFlowTemplate-command-consult"
  )!;
  previous.target = "operatorFlowTemplate-commandOutcome";
  f.graph.edges = [...f.graph.edges, {
    ...previous,
    id: "template-command-wait",
    nativeId: "template-command-wait",
    source: "operatorFlowTemplate-commandOutcome",
    target: "operatorFlowTemplate-wait",
    guard: "command.submission.awaitingInput",
    guardIds: ["template-command-wait-guard"],
  }, {
    ...previous,
    id: "template-command-continue",
    nativeId: "template-command-continue",
    source: "operatorFlowTemplate-commandOutcome",
    target: "operatorFlowTemplate-consult",
    guard: "else",
    guardIds: ["template-command-continue-guard"],
  }];
  const after = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
  );
  assert(before.operatorFlowTemplate && after.operatorFlowTemplate);
  assert(
    after.operatorFlowTemplate.revision ===
      before.operatorFlowTemplate.revision,
  );
  assert(
    after.operatorFlowTemplate.digest !== before.operatorFlowTemplate.digest,
  );
  assert(after.version.digest !== before.version.digest);
});

Deno.test("private profiles reject missing consultation outcome branches, spoofed primitive types and unsupported reads", async () => {
  const reasons = [
    /explicit native success and failure branches/,
    /Unsupported native executable type/,
    /Unsupported native consultation request/,
  ];
  let index = 0;
  for (
    const mutate of [
      (f: ReturnType<typeof operatorCommandFixture>) => {
        f.graph.edges.find((edge) =>
          edge.id === "conversation-consultationOutcome-wait"
        )!.guard = "consult.consultation.succeeded";
      },
      (f: ReturnType<typeof operatorCommandFixture>) => {
        f.graph.nodes.find((node) => node.id === "ChooseNextMove-type")!
          .symbol = "Private::ChooseNextMove";
      },
      (f: ReturnType<typeof operatorCommandFixture>) => {
        f.literals.find((literal) => literal.name === "consultationRequest")!
          .value = JSON.stringify({ operation: "query", expression: "unsafe" });
      },
    ]
  ) {
    const f = operatorCommandFixture();
    mutate(f);
    await assertRejects(
      () => compileExecutableModel(f.snapshot, f.graph, f.literals, f.identity),
      reasons[index++],
    );
  }
});

Deno.test("creator-owned future template hashes its selected graph while retaining the creator's active flow", async () => {
  const legacy = executableFixture();
  const previous = await compileExecutableModel(
    legacy.snapshot,
    legacy.graph,
    legacy.literals,
    legacy.identity,
  );
  const f = operatorCommandFixture(true);
  const selected = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
  );
  deepStrictEqual(selected.flows, previous.flows);
  assert(
    selected.operatorFlowTemplate?.qualifiedName ===
      "Private::PrivateConversationV2",
  );
  assert(selected.operatorFlowTemplate.revision === 2);
  assert(selected.operatorFlowTemplate.digest.length === 64);
  f.literals.find((literal) => literal.name === "consultationRequest")!.value =
    JSON.stringify({ operation: "read_source", path: "authority.sysml" });
  const updated = await compileExecutableModel(
    f.snapshot,
    f.graph,
    f.literals,
    f.identity,
  );
  assert(
    updated.operatorFlowTemplate!.digest !==
      selected.operatorFlowTemplate.digest,
  );
  deepStrictEqual(updated.flows, selected.flows);
  f.literals.find((literal) => literal.name === "operatorFlowTemplateRevision")!
    .value = "3";
  await assertRejects(
    () => compileExecutableModel(f.snapshot, f.graph, f.literals, f.identity),
    /revision mismatch/,
  );
});

Deno.test("a private ConversationCase homonym cannot select the historical unprofiled execution route", async () => {
  const f = executableFixture();
  f.snapshot.elements.find((element) => element.id === "conversation-type")!
    .qualifiedName = "Private::ConversationCase";
  await assertRejects(
    () => compileExecutableModel(f.snapshot, f.graph, f.literals, f.identity),
    /explicit supported execution profile/,
  );
  f.add(
    "historical-conversation",
    "ConversationCase",
    "ActionDefinition",
    "pkg",
  );
  f.snapshot.elements.find((element) =>
    element.id === "historical-conversation"
  )!.qualifiedName = "AssemblyConversation::ConversationCase";
  await assertRejects(
    () => compileExecutableModel(f.snapshot, f.graph, f.literals, f.identity),
    /explicit supported execution profile/,
  );
});

Deno.test("the historical flow selection requires one exact native library identity", async () => {
  const f = executableFixture();
  f.add(
    "duplicate-conversation",
    "ConversationCase",
    "ActionDefinition",
    "pkg",
  );
  f.snapshot.elements.find((element) =>
    element.id === "duplicate-conversation"
  )!.qualifiedName = "ASEConversation::ConversationCase";
  await assertRejects(
    () => compileExecutableModel(f.snapshot, f.graph, f.literals, f.identity),
    /explicit supported execution profile/,
  );
});

Deno.test("model rights compile only compatible explicit grants and preserve legacy digest encoding", async () => {
  const legacy = executableFixture();
  const previous = await compileExecutableModel(
    legacy.snapshot,
    legacy.graph,
    legacy.literals,
    legacy.identity,
  );
  assert(!Object.hasOwn(previous.policy, "mayConsultModel"));
  for (const read of [false, true]) {
    for (const revision of [false, true]) {
      const f = executableFixture();
      f.field("policy", "mayConsultModel", read);
      f.literals.find((literal) => literal.name === "mayProposeSysmlRevision")!
        .value = String(revision);
      if (!read && revision) {
        await assertRejects(
          () =>
            compileExecutableModel(f.snapshot, f.graph, f.literals, f.identity),
          {
            code: "MODEL_READ_POLICY_INVALID",
            context: { field: "mayConsultModel" },
            recovery: /read|consult/i,
          },
        );
        continue;
      }
      const current = await compileExecutableModel(
        f.snapshot,
        f.graph,
        f.literals,
        f.identity,
      );
      deepStrictEqual(current.policy.mayConsultModel, read);
      deepStrictEqual(current.policy.mayProposeSysmlRevision, revision);
      assert(current.version.sourceIds.includes("policy-mayConsultModel"));
      assert(
        current.version.sourceIds.includes("policy-mayConsultModel-literal"),
      );
      assert(current.version.digest !== previous.version.digest);
    }
  }
});

Deno.test("optional native model Booleans detect instance, type and literal declarations symmetrically", () => {
  for (const field of ["mayConsultModel", "mayProposeSysmlRevision"] as const) {
    for (
      const corrupt of [
        "missing-literal",
        "missing-attribute",
        "type-only",
        "string",
        "invalid-boolean",
      ]
    ) {
      const f = fixture();
      if (field === "mayConsultModel") f.field("policy", field, true);
      const literal = f.literals.find((entry) => entry.name === field)!;
      const attribute = f.snapshot.elements.find((entry) =>
        entry.id === literal.attributeId
      )!;
      if (corrupt === "missing-literal") {
        f.literals.splice(f.literals.indexOf(literal), 1);
      }
      if (corrupt === "missing-attribute") {
        f.snapshot.elements.splice(f.snapshot.elements.indexOf(attribute), 1);
      }
      if (corrupt === "type-only") {
        attribute.ownerId = "policy-type";
        literal.owner = "policy-type";
      }
      if (corrupt === "string") literal.kind = "LiteralString";
      if (corrupt === "invalid-boolean") literal.value = "yes";
      assertThrows(
        () => compileNativeAuthority(f.snapshot, f.literals, f.identity),
        {
          code: field === "mayConsultModel"
            ? "MODEL_READ_POLICY_INVALID"
            : "MODEL_REVISION_POLICY_INVALID",
          context: { field },
          recovery: /Boolean/,
        },
      );
    }
  }
});

Deno.test("a missing native revision field is a coded refusal, not an implicit grant", () => {
  const f = fixture();
  f.snapshot.elements = f.snapshot.elements.filter((entry) =>
    entry.name !== "mayProposeSysmlRevision"
  );
  f.literals.splice(
    0,
    f.literals.length,
    ...f.literals.filter((entry) => entry.name !== "mayProposeSysmlRevision"),
  );
  assertThrows(
    () => compileNativeAuthority(f.snapshot, f.literals, f.identity),
    {
      code: "MODEL_REVISION_POLICY_INVALID",
      context: { field: "mayProposeSysmlRevision" },
      recovery: /Boolean/,
    },
  );
});
