import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import assert from "node:assert/strict";
import {
  projectSourceGraph,
  sourceLiterals,
  sourceSnapshot,
} from "../../src/adapters/model/projections/graph/source.ts";
import type { ModelIdentity } from "../../src/domain/work/dialogue.ts";

type Raw = Record<string, unknown>;
const ref = (id: string) => ({ "@id": id });
const raw = (
  id: string,
  metaclass: string,
  name: string,
  owner?: string,
  extra: Raw = {},
): Raw => ({
  "@id": id,
  "@type": metaclass,
  ...(name ? { declaredName: name } : {}),
  ...(owner ? { owner: ref(owner) } : {}),
  ...extra,
});
const identity: ModelIdentity = {
  projectId: "repo",
  editingContextId: "repo",
  rootId: "repository-root",
  systemId: "system",
  catalogId: "catalog",
  builderId: "builder",
};

function fixture(): Raw[] {
  return [
    raw("file-root", "Namespace", ""),
    raw("pkg", "Package", "AssemblyLiveBuilder", "file-root"),
    raw("system", "PartUsage", "system", "pkg"),
    raw("flow-def", "ActionDefinition", "Flow", "pkg"),
    raw("flow", "PerformActionUsage", "flow", "system", {
      type: [ref("flow-def")],
    }),
    raw("source", "ActionUsage", "source", "flow-def"),
    raw("target", "ActionUsage", "target", "flow-def"),
    raw("decision", "DecisionNode", "choice", "flow-def"),
    raw("source-result", "ItemUsage", "result", "source"),
    raw("field", "ItemUsage", "input", "flow-def"),
    raw("passed", "AttributeUsage", "passed", "field"),
    raw("source-chain", "Feature", "", "flow-def", {
      chainingFeature: [ref("source"), ref("source-result")],
    }),
    raw("binding", "BindingConnectorAsUsage", "", "flow-def", {
      connectorEnd: [ref("left"), ref("right")],
    }),
    raw("left", "ReferenceUsage", "", "binding", {
      ownedReferenceSubsetting: ref("left-subset"),
    }),
    raw("right", "ReferenceUsage", "", "binding", {
      ownedReferenceSubsetting: ref("right-subset"),
    }),
    raw("left-subset", "ReferenceSubsetting", "", "left", {
      target: [ref("source-chain")],
    }),
    raw("right-subset", "ReferenceSubsetting", "", "right", {
      referencedFeature: ref("field"),
      target: [ref("field")],
    }),
    raw("event-type", "ItemDefinition", "Requested", "pkg"),
    raw("trigger", "AcceptActionUsage", "", "transition", {
      payloadParameter: ref("payload"),
    }),
    raw("payload", "ReferenceUsage", "", "trigger", {
      type: [ref("event-type")],
    }),
    raw("field-ref", "FeatureReferenceExpression", "", "guard", {
      referent: ref("field"),
    }),
    raw("guard", "FeatureChainExpression", "", "transition", {
      argument: [ref("field-ref")],
      targetFeature: ref("passed"),
    }),
    raw("transition", "TransitionUsage", "requested", "flow-def", {
      source: ref("decision"),
      target: ref("target"),
      guardExpression: [ref("guard")],
      triggerAction: [ref("trigger")],
      succession: ref("internal-succession"),
    }),
    raw("internal-succession", "SuccessionAsUsage", "", "transition", {
      sourceFeature: ref("decision"),
      targetFeature: [ref("target")],
    }),
    raw("assertion", "AssertConstraintUsage", "gate", "flow-def", {
      ownedMembership: [ref("assertion-result")],
    }),
    raw("assertion-result", "ResultExpressionMembership", "", "assertion", {
      memberElement: ref("guard"),
    }),
    raw("view", "ViewUsage", "Selected", "pkg", {
      ownedImport: [ref("exposure")],
    }),
    raw("exposure", "MembershipExpose", "", "view", {
      importedMembership: ref("exposed-member"),
      isImportAll: true,
    }),
    raw("exposed-member", "FeatureMembership", "", "pkg", {
      memberElement: ref("exposed-chain"),
    }),
    raw("exposed-chain", "Feature", "", "pkg", {
      chainingFeature: [ref("system"), ref("flow"), ref("source")],
    }),
  ];
}

Deno.test("Toolkit preserves connector direction, chains, guards, event identities and assertion AST", () => {
  const graph = projectSourceGraph(fixture(), identity);
  const binding = graph.edges.find((edge) => edge.nativeId === "binding");
  assert(binding);
  assert.deepEqual(binding.sourceFeaturePath, ["source", "source-result"]);
  assert.deepEqual(binding.targetFeaturePath, ["field"]);
  const transition = graph.edges.find((edge) => edge.nativeId === "transition");
  assert(transition);
  assert.equal(transition.guard, "input.passed");
  assert.equal(transition.event, "Requested");
  assert.deepEqual(transition.triggerIds, ["trigger"]);
  assert.deepEqual(transition.eventTypeIds, ["event-type"]);
  assert(!graph.edges.some((edge) => edge.nativeId === "internal-succession"));
  const constraint = graph.nodes.find((node) => node.nativeId === "assertion");
  assert.equal(constraint?.expression, "input.passed");
  for (
    const sourceId of [
      "assertion",
      "assertion-result",
      "guard",
      "field-ref",
      "field",
      "passed",
    ]
  ) assert(constraint?.expressionSourceIds?.includes(sourceId));
  assert.deepEqual(graph.diagnostics, []);
});

Deno.test("Toolkit exposes qualified native chains without selecting another occurrence", () => {
  const graph = projectSourceGraph(fixture(), identity);
  const member = graph.views[0].members[0];
  assert.equal(member.resolution, "resolved");
  assert.deepEqual(member.featurePath, ["system", "flow", "source"]);
  assert.equal(member.targetNativeId, "source");
  assert.deepEqual(member.graphNodeIds, ["use:system/flow/source"]);
});

Deno.test("Toolkit reports a shared exposure as ambiguous without guessing a context", () => {
  const elements = fixture();
  elements.push(
    raw("other-flow", "PerformActionUsage", "other", "system", {
      type: [ref("flow-def")],
    }),
  );
  elements.find((element) => element["@id"] === "exposed-member")!
    .memberElement = ref("source");
  const graph = projectSourceGraph(elements, identity);
  assert.equal(graph.views[0].members[0].resolution, "ambiguous");
  assert.deepEqual(graph.views[0].members[0].graphNodeIds, []);
  assert(
    graph.diagnostics.some((diagnostic) => diagnostic.includes("ambiguous")),
  );
});

Deno.test("Toolkit unsupported expression is diagnosed instead of fabricating guard text", () => {
  const elements = fixture();
  elements.find((element) => element["@id"] === "guard")!["@type"] =
    "UnknownExpression";
  const graph = projectSourceGraph(elements, identity);
  assert.equal(
    graph.edges.find((edge) => edge.nativeId === "transition")?.guard,
    undefined,
  );
  assert.equal(
    graph.nodes.find((node) => node.nativeId === "assertion")?.expression,
    undefined,
  );
  assert(
    graph.diagnostics.some((diagnostic) =>
      diagnostic.includes("Guard expression not rendered")
    ),
  );
  assert(
    graph.diagnostics.some((diagnostic) =>
      diagnostic.includes("Unsupported native constraint expression")
    ),
  );
});

Deno.test("Toolkit resolves unnamed redefined literals and scalar types from native references", () => {
  const elements = [
    raw("file-root", "Namespace", ""),
    raw("pkg", "Package", "AssemblyLiveBuilder", "file-root"),
    raw("scalar", "DataType", "Boolean", undefined, {
      qualifiedName: "ScalarValues::Boolean",
    }),
    raw("definition", "ItemDefinition", "Settings", "pkg"),
    raw("declared", "AttributeUsage", "enabled", "definition", {
      type: [ref("scalar")],
    }),
    raw("instance", "ItemUsage", "settings", "pkg", {
      type: [ref("definition")],
    }),
    raw("redefined", "AttributeUsage", "", "instance", {
      redefines: ref("declared"),
    }),
    raw("feature-value", "FeatureValue", "", "redefined", {
      featureWithValue: ref("redefined"),
      value: ref("literal"),
    }),
    raw("literal", "LiteralBoolean", "", "feature-value", { value: false }),
  ];
  const snapshot = sourceSnapshot(elements, identity.rootId);
  assert.equal(
    snapshot.elements.find((element) => element.id === "pkg")?.ownerId,
    identity.rootId,
  );
  const attribute = snapshot.elements.find((element) =>
    element.id === "redefined"
  );
  assert.equal(attribute?.name, "enabled");
  assert.deepEqual(attribute?.typeIds, ["scalar"]);
  assert.deepEqual(attribute?.redefinedIds, ["declared"]);
  assert.deepEqual(sourceLiterals(elements), [{
    owner: "instance",
    name: "enabled",
    attributeId: "redefined",
    literalId: "literal",
    kind: "LiteralBoolean",
    value: "false",
    typeIds: ["scalar"],
    typeNames: ["ScalarValues::Boolean"],
  }]);
});

Deno.test("Toolkit preserves a native state-entry membership without inventing an ActionUsage", () => {
  const elements = fixture();
  elements.push(
    raw("life", "StateDefinition", "Life", "pkg"),
    raw("proposed", "StateUsage", "proposed", "life"),
    raw("lifecycle", "ExhibitStateUsage", "lifecycle", "system", {
      type: [ref("life")],
    }),
    raw("entry", "StateSubactionMembership", "", "life", {
      kind: "entry",
      "sysx:subactionKind": "entry",
    }),
    raw("entry-succession", "SuccessionAsUsage", "", "life", {
      "sysx:sourceMember": ref("entry"),
      targetFeature: [ref("proposed")],
    }),
  );
  const graph = projectSourceGraph(elements, identity);
  const entry = graph.nodes.find((node) => node.nativeId === "entry");
  assert(entry);
  assert.equal(entry.metaclass, "StateSubactionMembership");
  assert.equal(entry.stateRole, "initial");
  assert.equal(entry.id, "use:system/lifecycle/entry");
  assert(
    graph.scopes.find((scope) => scope.id === "all")?.nodeIds.includes(
      entry.id,
    ),
  );
  const edge = graph.edges.find((edge) => edge.nativeId === "entry-succession");
  assert.equal(edge?.source, entry.id);
  assert.equal(
    graph.nodes.find((node) => node.id === edge?.target)?.nativeId,
    "proposed",
  );
  assert(
    !graph.diagnostics.some((diagnostic) =>
      diagnostic.includes("entry-succession")
    ),
  );
});

Deno.test("Toolkit conjugated port preserves its native original and reverses payload direction", () => {
  const elements = fixture();
  elements.push(
    raw("port-def", "PortDefinition", "Port", "pkg"),
    raw("payload-item", "ItemUsage", "data", "port-def", { direction: "out" }),
    raw("conjugate", "ConjugatedPortDefinition", "~Port", "port-def"),
    raw("port", "PortUsage", "inputPort", "system", {
      type: [ref("conjugate")],
    }),
  );
  const graph = projectSourceGraph(elements, identity);
  const port = graph.nodes.find((node) => node.nativeId === "port");
  assert.equal(port?.conjugated, true);
  const payload = graph.nodes.find((node) =>
    node.nativeId === "payload-item" && node.parentId === port?.id
  );
  assert.equal(payload?.declaredDirection, "out");
  assert.equal(payload?.effectiveDirection, "in");
  assert.deepEqual(payload?.directionConjugationIds, ["conjugate"]);
});

Deno.test("Toolkit broken endpoint and duplicate identities fail visibly", () => {
  const elements = fixture();
  elements.find((element) => element["@id"] === "left-subset")!.target = [
    ref("missing"),
  ];
  const graph = projectSourceGraph(elements, identity);
  assert(!graph.edges.some((edge) => edge.nativeId === "binding"));
  assert(
    graph.diagnostics.some((diagnostic) => diagnostic.includes("binding")),
  );
  assert.throws(
    () => projectSourceGraph([...elements, elements[0]], identity),
    /duplicate element identities/,
  );
});

Deno.test("unexhibited native lifecycle definitions retain states, inherited members and exact transition ends", () => {
  const elements = [
    raw("pkg", "Package", "Library"),
    raw("base", "StateDefinition", "CandidateLifecycle", "pkg"),
    raw("derived", "StateDefinition", "AdmissionCandidateLifecycle", "pkg", {
      ownedSpecialization: [ref("specialization")],
    }),
    raw("specialization", "Subclassification", "", "derived", {
      general: [ref("base")],
    }),
    raw("entry", "StateSubactionMembership", "", "base", { kind: "entry" }),
    raw("proposed", "StateUsage", "proposed", "base"),
    raw("active", "StateUsage", "active", "base"),
    raw("start", "SuccessionAsUsage", "", "base", {
      sourceFeature: ref("entry"),
      targetFeature: ref("proposed"),
    }),
    raw("activate", "TransitionUsage", "activate", "base", {
      source: ref("proposed"),
      target: ref("active"),
      succession: ref("internal"),
    }),
    raw("internal", "SuccessionAsUsage", "", "activate", {
      sourceFeature: ref("proposed"),
      targetFeature: ref("active"),
    }),
    raw("admitted", "StateUsage", "admitted", "derived"),
    raw("admit", "TransitionUsage", "admit", "derived", {
      source: ref("active"),
      target: ref("admitted"),
    }),
  ];
  const graph = projectSourceGraph(elements, identity);
  assert.equal(graph.nodes.filter((node) => node.role === "usage").length, 0);
  for (const root of ["base", "derived"]) {
    const states = graph.nodes.filter((node) =>
      node.parentId === `def:${root}`
    );
    assert(states.some((node) => node.nativeId === "proposed"));
    assert(states.some((node) => node.nativeId === "active"));
    const entry = states.find((node) => node.nativeId === "entry")!;
    assert.equal(entry.stateRole, "initial");
    for (const node of states) {
      assert.equal(node.role, "definition");
      assert.equal(node.prototype, true);
      assert.equal(node.observedState, false);
      assert.equal(node.source.line, node.nativeId);
    }
    const transitions = graph.edges.filter((edge) =>
      edge.id.startsWith(`definition-relation:${root}/`)
    );
    assert.equal(
      transitions.filter((edge) => edge.nativeId === "internal").length,
      0,
    );
    const transition = transitions.find((edge) =>
      edge.nativeId === "activate"
    )!;
    assert.equal(
      graph.nodes.find((node) => node.id === transition.source)?.nativeId,
      "proposed",
    );
    assert.equal(
      graph.nodes.find((node) => node.id === transition.target)?.nativeId,
      "active",
    );
    assert(
      transitions.some((edge) =>
        edge.nativeId === "start" && edge.source === entry.id
      ),
    );
  }
  const inherited = graph.nodes.find((node) =>
    node.parentId === "def:derived" && node.nativeId === "active"
  )!;
  assert.equal(inherited.inheritedFromDefinitionId, "base");
  assert.equal(inherited.origin, "typed-projection");
  assert(
    graph.edges.some((edge) =>
      edge.nativeId === "admit" && edge.target === "def-member:derived/admitted"
    ),
  );
});

Deno.test({
  name:
    "real normalized empty-catalog model keeps executable digest with definition scaffold",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const { ToolkitCompiler } = await import(
      "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts"
    );
    const { compileExecutableModel } = await import(
      "../../src/adapters/out/sysml-toolkit/compilation-policies/work/execution-model.ts"
    );
    const { sourceModelIdentity } = await import(
      "../../src/adapters/model/sources/source-model.ts"
    );
    const { loadInitialSources } = await import(
      "../../src/adapters/out/filesystem/initial-model-sources.ts"
    );
    const compiled = await new ToolkitCompiler({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    }).compile(await loadInitialSources(undefined, { information: false }));
    const identity = sourceModelIdentity({
      ...compiled,
      version: "read-only-scaffold-proof",
    }, "git:202176a3-9e87-5191-87c2-22c5747f6034");
    const graph = projectSourceGraph(compiled.elements, identity);
    const prototypeIds = new Set(
      graph.nodes.filter((node) => node.id.startsWith("def-member:")).map((
        node,
      ) => node.id),
    );
    const before = {
      ...graph,
      nodes: graph.nodes.filter((node) => !prototypeIds.has(node.id)),
      edges: graph.edges.filter((edge) =>
        !prototypeIds.has(edge.source) && !prototypeIds.has(edge.target)
      ),
    };
    const snapshot = sourceSnapshot(compiled.elements, identity.rootId);
    const literals = sourceLiterals(compiled.elements);
    const baseline = await compileExecutableModel(
      snapshot,
      before,
      literals,
      identity,
    );
    const enhanced = await compileExecutableModel(
      snapshot,
      graph,
      literals,
      identity,
    );
    assert.equal(baseline.version.digest, enhanced.version.digest);
    assert.equal(enhanced.catalog.length, 0);
    assert(
      graph.nodes.filter((node) => node.metaclass === "StateDefinition")
        .length >= 2,
    );
    assert(prototypeIds.size > 0);
    assert(
      graph.edges.some((edge) =>
        edge.kind === "transition" && prototypeIds.has(edge.source)
      ),
    );
    assert(
      graph.nodes.filter((node) => prototypeIds.has(node.id)).every((node) =>
        node.role === "definition" && node.observedState === false
      ),
    );
    console.log(JSON.stringify({
      before: { nodes: before.nodes.length, edges: before.edges.length },
      after: { nodes: graph.nodes.length, edges: graph.edges.length },
      scaffoldMembers: prototypeIds.size,
      catalog: enhanced.catalog.length,
      digest: enhanced.version.digest,
    }));
  },
});

Deno.test("catalog contract references keep native bindings and conversation owns its execution policy", () => {
  const elements = [
    raw("pkg", "Package", "AssemblyLiveBuilder"),
    raw("system", "PartUsage", "liveBuilder", "pkg"),
    raw("catalog", "PartUsage", "catalog", "system"),
    raw("tool-def", "PartDefinition", "ToolCandidate", "pkg"),
    raw("contract-def", "ItemDefinition", "CapabilityContract", "pkg"),
    raw("contract-ref", "ItemUsage", "contract", "tool-def", {
      type: [ref("contract-def")],
      isReference: true,
    }),
    raw("tool", "PartUsage", "readWebPage", "catalog", {
      type: [ref("tool-def")],
    }),
    raw("contract", "ItemUsage", "readWebPageContract", "catalog", {
      type: [ref("contract-def")],
    }),
    raw("tool-contract-chain", "Feature", "", "system", {
      chainingFeature: [ref("catalog"), ref("tool"), ref("contract-ref")],
    }),
    raw("catalog-contract-chain", "Feature", "", "system", {
      chainingFeature: [ref("catalog"), ref("contract")],
    }),
    raw("contract-binding", "BindingConnectorAsUsage", "", "system", {
      sourceFeature: ref("tool-contract-chain"),
      targetFeature: [ref("catalog-contract-chain")],
    }),
    raw("case-def", "ActionDefinition", "ConversationCase", "pkg"),
    raw("conversation", "PerformActionUsage", "conversation", "system", {
      type: [ref("case-def")],
    }),
    raw("policy-def", "ItemDefinition", "ExecutionPolicy", "pkg"),
    raw("policy", "ItemUsage", "executionPolicy", "conversation", {
      type: [ref("policy-def")],
    }),
  ];
  const graph = projectSourceGraph(elements, identity);
  const usage = (nativeId: string) =>
    graph.nodes.find((n) => n.nativeId === nativeId && n.role === "usage")!;
  const catalog = usage("catalog"),
    tool = usage("tool"),
    contract = usage("contract"),
    reference = usage("contract-ref"),
    conversation = usage("conversation"),
    policy = usage("policy");
  assert.equal(tool.parentId, catalog.id);
  assert.equal(contract.parentId, catalog.id);
  assert.equal(reference.parentId, tool.id);
  assert.equal(reference.isReference, true);
  assert.equal(policy.parentId, conversation.id);
  assert.equal(conversation.metaclass, "PerformActionUsage");
  const binding = graph.edges.find((e) => e.nativeId === "contract-binding");
  assert(binding);
  assert.equal(binding.source, reference.id);
  assert.equal(binding.target, contract.id);
  assert.deepEqual(binding.sourceFeaturePath, [
    "catalog",
    "tool",
    "contract-ref",
  ]);
  assert.deepEqual(binding.targetFeaturePath, ["catalog", "contract"]);
  assert.deepEqual(graph.diagnostics, []);
});

Deno.test("Toolkit assertion roots resolve through native ownedMembership when membership.owner is null", () => {
  const elements = fixture();
  const membership = elements.find((e) => e["@id"] === "assertion-result")!;
  membership.owner = null;
  membership.membershipOwningNamespace = ref("assertion");
  const graph = projectSourceGraph(elements, identity);
  const assertion = graph.nodes.find((n) => n.nativeId === "assertion");
  assert.equal(assertion?.expression, "input.passed");
  assert.deepEqual(graph.diagnostics, []);
  membership.memberElement = ref("missing-expression");
  const broken = projectSourceGraph(elements, identity);
  assert(
    broken.diagnostics.some((d) =>
      d.includes("Unsupported native constraint expression")
    ),
  );
});
