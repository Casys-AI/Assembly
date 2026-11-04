import type {
  ElementRecord,
  ModelSnapshot,
} from "../../src/domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../src/domain/shared-kernel/model-identity.ts";
import type { NativeLiteral } from "../../src/domain/model/records/native-literal.ts";
import type {
  FlowProjection,
  FlowProjectionEdge,
  FlowProjectionNode,
} from "../../src/domain/model/execution/flow.ts";

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
  return { snapshot, literals, identity, field, add };
}
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
  return { ...f, graph: { nodes, edges } satisfies FlowProjection };
}

export const localeIdentifiers = [
  "aa",
  "z",
  "ä",
  "ø",
  "I",
  "i",
  "ı",
  "İ",
  "A",
  "_",
];

export function localeExecutableFixture() {
  const f = executableFixture();
  for (const name of ["conversation", "promotion"]) {
    const reply = f.graph.nodes.find((node) => node.id === `${name}-reply`)!;
    f.graph.nodes = f.graph.nodes.filter((node) => node !== reply);
    f.graph.edges = f.graph.edges.filter((edge) =>
      !edge.source.startsWith(`${name}-`)
    );
    f.snapshot.connectors = f.snapshot.connectors.filter((connector) =>
      connector.id !== `${name}-allocation`
    );
    let previous = `${name}-start`;
    for (const [index, token] of localeIdentifiers.entries()) {
      const id = `${name}-${token}`;
      f.graph.nodes.push({ ...reply, id, nativeId: id, label: `step${index}` });
      f.graph.edges.push({
        id: `${id}-typing`,
        source: id,
        target: "reply-type",
        kind: "typing",
      });
      f.graph.edges.push({
        id: `${id}-edge`,
        nativeId: `${id}-edge`,
        source: previous,
        target: id,
        kind: "succession",
        metaclass: "SuccessionAsUsage",
        sourceEvidence: { file: "native.sysml", line: id },
      });
      f.snapshot.connectors.push({
        id: `${id}-allocation`,
        name: "",
        metaclass: "AllocationUsage",
        ownerId: "system",
        ends: [{ chain: [{ id: name, name }, { id, name: `step${index}` }] }, {
          chain: [{ id: "builder", name: "builder" }],
        }],
      });
      previous = id;
    }
    f.graph.edges.push({
      id: `${name}-done-edge`,
      nativeId: `${name}-done-edge`,
      source: previous,
      target: `${name}-done`,
      kind: "succession",
      metaclass: "SuccessionAsUsage",
      sourceEvidence: { file: "native.sysml", line: "done" },
    });
    const first = `${name}-${localeIdentifiers[0]}`;
    const second = `${name}-${localeIdentifiers[1]}`;
    for (const [index, token] of localeIdentifiers.entries()) {
      const output = `${first}-${token}-out`, input = `${second}-${token}-in`;
      for (
        const [id, parentId, direction] of [[output, first, "out"], [
          input,
          second,
          "in",
        ]] as const
      ) {
        f.graph.nodes.push({
          id,
          nativeId: id,
          parentId,
          label: `value${index}`,
          metaclass: "ReferenceUsage",
          declaredDirection: direction,
          source: { file: "native.sysml", line: id },
        });
      }
      f.graph.nodes.push({
        id: `${first}-${token}-assert`,
        nativeId: `${first}-${token}-assert`,
        parentId: first,
        label: `check${index}`,
        metaclass: "AssertConstraintUsage",
        expression: `value${index} == value${index}`,
        source: { file: "native.sysml", line: token },
      });
      f.graph.edges.push({
        id: `${name}-${token}-binding`,
        nativeId: `${name}-${token}-binding`,
        source: output,
        target: input,
        kind: "binding",
        sourceFeaturePath: [first, output],
        targetFeaturePath: [second, input],
        sourceEvidence: { file: "native.sysml", line: token },
      });
    }
  }
  return f;
}
