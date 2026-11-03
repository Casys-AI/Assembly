import {
  allocatedNativeContent,
  behaviorAccessDescendants,
  configuredInvocationLinks,
  documentedMandate,
  flowCycleBreak,
  isBehaviorAccess,
  judgmentOperator,
  mandateScopeForView,
  nativeFlowScopes,
  nativeScaffoldNodes,
  planNativeViews,
} from "./projection.ts";
import type {
  GraphEdge as Edge,
  NativeModelView as NativeView,
} from "./types.ts";
import {
  mandateFixture as fixture,
  type ViewNode,
} from "../../test/support/mandate-fixture.ts";
import { flowFixture } from "../../test/support/flow-fixture.ts";
function assert(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}
Deno.test("BehaviorAccess detection uses typing evidence and factors only strict descendants", () => {
  const nodes = [
    { id: "system", role: "usage", category: "part", kind: "part-usage" },
    {
      id: "access",
      label: "installAccess",
      role: "usage",
      category: "part",
      kind: "part-usage",
      parentId: "system",
    },
    {
      id: "caller",
      label: "caller",
      role: "usage",
      category: "part",
      kind: "part-usage",
      parentId: "access",
    },
    {
      id: "input",
      label: "input",
      role: "usage",
      category: "item",
      kind: "item-usage",
      parentId: "access",
    },
    {
      id: "nested",
      label: "field",
      role: "usage",
      category: "item",
      kind: "item-usage",
      parentId: "input",
    },
    {
      id: "typed",
      label: "typedAccess",
      role: "usage",
      category: "part",
      kind: "part-usage",
      parentId: "system",
      typeName: "ASEInvocations::BehaviorAccess",
    },
    {
      id: "def:access",
      label: "BehaviorAccess",
      role: "definition",
      category: "part",
      kind: "part-definition",
    },
  ];
  const edges = [{
    id: "type:access",
    source: "access",
    target: "def:access",
    kind: "typing",
  }];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  assert(
    isBehaviorAccess(byId.get("access"), nodes, edges),
    "Typing edge to BehaviorAccess was not detected",
  );
  assert(
    isBehaviorAccess(byId.get("typed"), nodes, edges),
    "Qualified typeName BehaviorAccess was not detected",
  );
  assert(
    !isBehaviorAccess(byId.get("def:access"), nodes, edges),
    "BehaviorAccess definition became an access",
  );
  assert(
    !isBehaviorAccess(byId.get("caller"), nodes, edges),
    "Caller child became an access",
  );
  const descendants = behaviorAccessDescendants(nodes, edges);
  assert(
    descendants.get("caller") === "access" &&
      descendants.get("input") === "access" &&
      descendants.get("nested") === "access",
    "Access descendants were not factored transitively",
  );
  assert(
    !descendants.has("access") && !descendants.has("typed") &&
      !descendants.has("system"),
    "Accesses or unrelated parts were factored out",
  );
  assert(
    behaviorAccessDescendants(nodes, []).get("access") === undefined &&
      !isBehaviorAccess(byId.get("access"), nodes, []),
    "Untyped part was detected as BehaviorAccess",
  );
});
Deno.test("operator ochre requires native depicted-judgment allocation", () => {
  const f = fixture();
  assert(
    judgmentOperator(f.holder, f.nodes, f.edges),
    "Proved operator rejected",
  );
  assert(
    !judgmentOperator(f.holder, f.nodes, []),
    "Software metadata alone colored operator",
  );
  const mismatched = { ...f.holder, nativeId: "another-holder" };
  assert(
    !judgmentOperator(mismatched, f.nodes, f.edges),
    "Holder identity mismatch accepted",
  );
  assert(
    !judgmentOperator(f.record, f.nodes, f.edges),
    "Neutral mandate item became an operator",
  );
});
Deno.test("configured mandate requires matching real item and holder", () => {
  const f = fixture();
  const before = JSON.stringify(f);
  assert(
    documentedMandate(f.holder, f.nodes, f.edges),
    "Documented mandate rejected",
  );
  for (
    const override of [
      { holderNativeId: "other-holder" },
      { nativeId: "missing-native-record" },
      { evidenceLevel: "observed" },
      { allowedChoices: [] },
      { sourceRefs: [] },
    ]
  ) {
    const holder = {
      ...f.holder,
      mandate: { ...f.holder.mandate, ...override },
    };
    assert(
      !documentedMandate(holder, f.nodes, f.edges),
      "Incomplete/mismatched mandate was accepted",
    );
  }
  assert(
    !documentedMandate({ ...f.holder, mandate: undefined }, f.nodes, f.edges),
    "Absent mandate was accepted",
  );
  assert(
    JSON.stringify(f) === before,
    "View validation modified native containment/relations",
  );
});
Deno.test("native allocated actions and declared outputs keep physical ownership", () => {
  const f = fixture();
  const reply: ViewNode = {
    id: "use:reply",
    nativeId: "native-reply",
    label: "reply",
    role: "usage",
    category: "action",
    kind: "action-usage",
    parentId: "system",
  };
  const invoke: ViewNode = {
    id: "use:invoke",
    nativeId: "native-invoke",
    label: "invokeRequest",
    role: "usage",
    category: "action",
    kind: "action-usage",
    parentId: "system",
  };
  const output: ViewNode = {
    id: "out:candidate",
    nativeId: "native-output",
    label: "candidate",
    role: "usage",
    category: "item",
    parentId: f.action.id,
    declaredDirection: "out",
  };
  const input: ViewNode = {
    ...output,
    id: "in:candidate",
    nativeId: "native-input",
    declaredDirection: "in",
  };
  f.nodes.push(reply, invoke, output, input);
  f.edges.push({
    id: "allocated:reply",
    source: reply.id,
    target: f.holder.id,
    kind: "allocation",
  }, {
    id: "allocated:invoke",
    source: invoke.id,
    target: f.holder.id,
    kind: "allocation",
  }, {
    id: "owns:output",
    source: f.action.id,
    target: output.id,
    kind: "owns",
  });
  const before = JSON.stringify(f);
  const content = allocatedNativeContent(f.nodes, f.edges, [f.holder.id]);
  assert(
    content.actions.length === 3 && content.outputs.length === 1,
    "Actual native action/output selection failed",
  );
  assert(
    content.outputs[0].parentId === f.action.id &&
      content.owner.get(reply.id) === f.holder.id,
    "Allocation was confused with physical ownership",
  );
  assert(JSON.stringify(f) === before, "Native source ownership mutated");
  assert(
    !content.edges.some((e) => e.kind === "owns" && e.source === f.holder.id),
    "View invented agent ownership of actions",
  );
});
Deno.test("configured invocation links require exact typed allocated request and active right", () => {
  const f = fixture();
  const invoke: ViewNode = {
    id: "use:invoke",
    nativeId: "native-invoke",
    label: "invokeRequest",
    role: "usage",
    category: "action",
    kind: "action-usage",
  };
  const type: ViewNode = {
    id: "def:invoke",
    nativeId: "native-invoke-type",
    label: "RequestToolInvocation",
    role: "definition",
    category: "action",
  };
  const tool: ViewNode = {
    id: "use:tool",
    nativeId: "native-tool",
    label: "Active tool",
    role: "usage",
    category: "part",
    runtimeStage: "active",
  };
  f.nodes.push(invoke, type, tool);
  f.edges.push({
    id: "allocated:invoke",
    source: invoke.id,
    target: f.holder.id,
    kind: "allocation",
  }, {
    id: "allocated:invoke",
    source: invoke.id,
    target: type.id,
    kind: "typing",
  });
  f.holder.operator!.capabilityBindings = [{
    relationship: "may-invoke",
    nativeId: tool.nativeId,
    sourceRefs: ["host capability policy"],
    evidenceLevel: "configured",
  }];
  const links = () =>
    configuredInvocationLinks(
      f.nodes,
      f.edges,
      allocatedNativeContent(f.nodes, f.edges, [f.holder.id]),
    );
  const valid = links();
  assert(
    valid.length === 1 && valid[0].source === invoke.id &&
      valid[0].target === tool.id && valid[0].displayOnly,
    "Specific configured link missing or falsely native",
  );
  invoke.label = "propose";
  assert(links().length === 0, "Permission attached to another action");
  invoke.label = "invokeRequest";
  type.label = "OtherRequest";
  assert(links().length === 0, "Untyped invocation request accepted");
  type.label = "RequestToolInvocation";
  tool.runtimeStage = "testing";
  assert(links().length === 0, "Inactive tool received permission link");
  tool.runtimeStage = "active";
  f.holder.mandate!.holderNativeId = "wrong-holder";
  assert(links().length === 0, "Mismatched mandate received permission link");
});

Deno.test("actual nested native views select membership without changing source ownership", () => {
  const f = fixture();
  const reviewer: ViewNode = {
    id: "use:reviewer",
    nativeId: "native-reviewer",
    label: "reviewer",
    role: "usage",
    category: "part",
    parentId: "physical-system",
  };
  const catalog: ViewNode = {
    id: "use:catalog",
    nativeId: "native-catalog",
    label: "catalog",
    role: "usage",
    category: "part",
    parentId: "physical-system",
  };
  f.nodes.push(reviewer, catalog);
  f.holder.parentId = "physical-system";
  f.action.parentId = "physical-promotion";
  const member = (
    nativeId: string,
    graphNodeIds: string[],
    nestedViewId?: string,
  ) => ({ nativeId, resolution: "resolved", graphNodeIds, nestedViewId });
  const builder: NativeView = {
    id: "view:b",
    nativeId: "b",
    label: "actualBuilderView",
    ownerNativeId: "namespace",
    members: [member("expose:b", [f.holder.id, f.action.id])],
  };
  const review: NativeView = {
    id: "view:r",
    nativeId: "r",
    label: "actualReviewerView",
    ownerNativeId: "namespace",
    members: [member("expose:r", [reviewer.id])],
  };
  const overview: NativeView = {
    id: "view:all",
    nativeId: "all",
    label: "actualOverview",
    ownerNativeId: "namespace",
    members: [
      member("expose:view-b", [], builder.id),
      member("expose:view-r", [], review.id),
      member("expose:catalog", [catalog.id]),
    ],
  };
  const views = [builder, review, overview],
    before = JSON.stringify({ nodes: f.nodes, views });
  const plan = planNativeViews(f.nodes, views);
  assert(
    plan?.overview.id === overview.id && plan.groups.length === 2,
    "Native overview/subview relation not followed",
  );
  const oneGroup = planNativeViews(f.nodes, [
    builder,
    { ...overview, members: [member("expose:view-b", [], builder.id)] },
  ]);
  assert(
    oneGroup?.groups.length === 1 &&
      oneGroup.parentByNode.get(f.holder.id) === builder.id,
    "A normal one-agent system lost its native action view",
  );
  assert(
    plan?.parentByNode.get(f.holder.id) === builder.id &&
      plan.parentByNode.get(f.action.id) === builder.id,
    "Resolved expose membership missing",
  );
  assert(
    plan?.selectedIds.has(catalog.id) && !plan.parentByNode.has(catalog.id),
    "Shared catalog incorrectly put inside operator view",
  );
  assert(
    JSON.stringify({ nodes: f.nodes, views }) === before,
    "Native physical ownership or exposures mutated",
  );
  builder.members.push({
    ...member("bad-expose", [catalog.id]),
    resolution: "ambiguous",
  });
  assert(
    !planNativeViews(f.nodes, views)?.parentByNode.has(catalog.id),
    "Ambiguous exposure was asserted",
  );
  review.members.push(member("shared-expose", [f.action.id]));
  assert(
    !planNativeViews(f.nodes, views)?.parentByNode.has(f.action.id),
    "Shared view membership arbitrarily selected a parent",
  );
  assert(
    planNativeViews(f.nodes, []) === null,
    "Absent native views fabricated a frame",
  );
  const second = { ...overview, id: "view:second", nativeId: "second" };
  assert(
    planNativeViews(f.nodes, [...views, second]) === null,
    "Ambiguous overview selection picked arbitrary view",
  );
});

Deno.test("a native view depicts mandate scope only for its verified exclusive holder and actions", () => {
  const f = fixture();
  const group: { view: NativeView; ids: Set<string> } = {
    view: {
      id: "view:scope",
      nativeId: "scope",
      label: "Selected actions",
      ownerNativeId: "namespace",
      members: [{
        nativeId: "expose",
        resolution: "resolved",
        graphNodeIds: [f.holder.id, f.action.id],
      }],
    },
    ids: new Set([f.holder.id, f.action.id]),
  };
  const plan = {
    parentByNode: new Map([...group.ids].map((id) => [id, group.view.id])),
  };
  const before = JSON.stringify(f);
  assert(
    mandateScopeForView(group, plan, f.nodes, f.edges)?.holder.id ===
      f.holder.id,
    "Verified scope rejected",
  );
  assert(
    !mandateScopeForView(group, plan, f.nodes, []),
    "Allocation-free view became mandate",
  );
  assert(
    !mandateScopeForView(
      group,
      plan,
      f.nodes.map((n) =>
        n.id === f.holder.id ? { ...n, mandate: undefined } : n
      ),
      f.edges,
    ),
    "Undocumented view became mandate",
  );
  assert(
    !mandateScopeForView(group, plan, f.nodes, [...f.edges, {
      id: "allocated:foreign",
      source: f.action.id,
      target: "another-agent",
      kind: "allocation",
    }]),
    "Foreign allocation ignored",
  );
  assert(
    !mandateScopeForView(group, plan, f.nodes, [...f.edges, f.edges[0]!]),
    "Duplicate allocation ignored",
  );
  assert(
    !mandateScopeForView(
      group,
      { parentByNode: new Map([[f.holder.id, group.view.id]]) },
      f.nodes,
      f.edges,
    ),
    "Shared action membership accepted",
  );
  group.view.members[0]!.resolution = "ambiguous";
  assert(
    !mandateScopeForView(group, plan, f.nodes, f.edges),
    "Ambiguous exposure became mandate",
  );
  group.view.members[0]!.resolution = "resolved";
  group.view.members.push(
    {
      nativeId: "nested-exposure",
      resolution: "resolved",
      graphNodeIds: [],
      nestedViewId: "view:another-scope",
    } as NativeView["members"][number],
  );
  assert(
    !mandateScopeForView(group, plan, f.nodes, f.edges),
    "Unvalidated nested scope became part of a mandate",
  );
  assert(
    JSON.stringify(f) === before,
    "Scope rendering modified native model data",
  );
});
Deno.test("nested native frames retain direct membership at any depth without duplicating exposures", () => {
  const nodes = ["context-policy", "skill-policy", "memory-policy"].map((
    id,
  ) => ({ id }));
  const view = (
    nativeId: string,
    members: NativeView["members"],
  ): NativeView => ({
    id: `view:${nativeId}`,
    nativeId,
    label: nativeId,
    members,
  });
  const expose = (id: string) => ({
    resolution: "resolved",
    graphNodeIds: [id],
  });
  const nested = (id: string) => ({
    resolution: "resolved",
    nestedViewId: `view:${id}`,
  });
  const views = [
    view("overview", [nested("context"), nested("memory")]),
    view("context", [
      expose("context-policy"),
      nested("skills"),
      nested("skills"),
    ]),
    view("skills", [expose("skill-policy"), expose("skill-policy")]),
    view("memory", [expose("memory-policy")]),
  ];
  const before = JSON.stringify({ nodes, views });
  const plan = planNativeViews(nodes, views)!;
  assert(
    plan.groups.length === 3,
    "Repeated exposures duplicated native frames",
  );
  assert(
    plan.selectedIds.size === 3,
    "Nested members were omitted or duplicated",
  );
  assert(
    plan.parentByView.get("view:skills") === "view:context",
    "Nested frame lost its parent",
  );
  assert(
    !plan.parentByView.has("view:context"),
    "Overview was fabricated as a frame",
  );
  assert(
    plan.parentByNode.get("skill-policy") === "view:skills",
    "Membership was flattened into an ancestor",
  );
  assert(
    plan.ambiguousIds.length === 0 && plan.ambiguousViewIds.length === 0,
    "Repeated exposure in one view became ambiguity",
  );
  assert(
    JSON.stringify({ nodes, views }) === before,
    "Planning mutated native ownership or exposures",
  );
});
Deno.test("shared subviews and transitive node memberships never choose an arbitrary parent", () => {
  const view = (
    nativeId: string,
    members: NativeView["members"],
  ): NativeView => ({
    id: `view:${nativeId}`,
    nativeId,
    label: nativeId,
    members,
  });
  const nested = (id: string) => ({
    resolution: "resolved",
    nestedViewId: `view:${id}`,
  });
  const expose = (id: string) => ({
    resolution: "resolved",
    graphNodeIds: [id],
  });
  const views = [
    view("overview", [nested("left"), nested("right")]),
    view("left", [nested("shared"), expose("overlap")]),
    view("right", [nested("shared")]),
    view("shared", [expose("overlap"), expose("exclusive")]),
  ];
  const plan = planNativeViews(
    [{ id: "overlap" }, { id: "exclusive" }],
    views,
  )!;
  assert(plan.groups.length === 3, "Shared subview was instantiated twice");
  assert(
    plan.ambiguousViewIds.includes("view:shared") &&
      !plan.parentByView.has("view:shared"),
    "Shared frame was assigned to one branch",
  );
  assert(
    plan.ambiguousIds.includes("overlap") && !plan.parentByNode.has("overlap"),
    "Transitive overlap was assigned to one view",
  );
  assert(
    plan.parentByNode.get("exclusive") === "view:shared",
    "Exclusive membership of a shared frame was lost",
  );
  assert(
    planNativeViews([], [...views, views[1]]) === null,
    "Duplicate native view identities picked arbitrary contents",
  );
});
Deno.test("cyclic native view exposure falls back without constructing cyclic frames", () => {
  const views = [
    {
      id: "view:root",
      nativeId: "root",
      label: "Root",
      members: [{ resolution: "resolved", nestedViewId: "view:a" }],
    },
    {
      id: "view:a",
      nativeId: "a",
      label: "A",
      members: [{ resolution: "resolved", nestedViewId: "view:b" }],
    },
    {
      id: "view:b",
      nativeId: "b",
      label: "B",
      members: [{ resolution: "resolved", nestedViewId: "view:a" }],
    },
  ];
  assert(
    planNativeViews([], views) === null,
    "An accessible cycle produced a compound hierarchy",
  );
  assert(
    planNativeViews([], views.slice(1)) === null,
    "A rootless cycle selected an arbitrary overview",
  );
});
Deno.test("performed behavior scopes use native ancestry and actual successions", () => {
  const f = flowFixture(), before = JSON.stringify(f);
  const scopes = nativeFlowScopes(f.nodes, f.edges);
  const conversation = scopes.find((entry) =>
    entry.scope.id === f.conversation.id
  )!;
  assert(scopes.length === 3, "Native nested performed scope missing");
  assert(
    conversation.typeName === "ConversationCase",
    "Native typing was lost",
  );
  assert(
    conversation.nodes.map((n) => n.id).join(",") === "read,nested-call,wait",
    "Scopes were flattened or state/unscoped actions leaked",
  );
  assert(
    conversation.edges.length === 3 &&
      conversation.edges.some((e) =>
        e.id === "return" && e.guard === "input.available"
      ),
    "Native guarded loop edge lost",
  );
  assert(
    scopes.every((entry) => !entry.edges.some((e) => e.id === "cross-scope")),
    "Cross-scope edge was asserted",
  );
  assert(
    JSON.stringify(f) === before,
    "Scope selection changed native parent IDs or edges",
  );
  assert(
    nativeFlowScopes(f.nodes, f.edges.filter((e) => e.kind === "typing"))
      .length === 0,
    "Missing successions fabricated a flow",
  );
});
Deno.test("cycle breaking is layout-only and preserves every native return edge", () => {
  const edges: Edge[] = [
    { id: "entry", source: "start", target: "read", kind: "succession" },
    { id: "choose", source: "read", target: "choose", kind: "succession" },
    {
      id: "reply",
      source: "choose",
      target: "reply",
      kind: "succession",
      guard: "reply.selected",
    },
    {
      id: "invoke",
      source: "choose",
      target: "invoke",
      kind: "succession",
      guard: "invoke.selected",
    },
    { id: "wait", source: "reply", target: "wait", kind: "succession" },
    { id: "reply-return", source: "wait", target: "read", kind: "succession" },
    { id: "outcome", source: "invoke", target: "observe", kind: "succession" },
    {
      id: "outcome-return",
      source: "observe",
      target: "read",
      kind: "succession",
    },
  ];
  const ids = ["start", "read", "choose", "reply", "wait", "invoke", "observe"];
  const before = JSON.stringify(edges), plan = flowCycleBreak(ids, edges);
  assert(
    plan.feedbackEdgeIds.has("reply-return") &&
      plan.feedbackEdgeIds.has("outcome-return"),
    "Native returns not routed separately",
  );
  assert(
    plan.layoutEdges.length + plan.feedbackEdgeIds.size === edges.length,
    "Layout discarded a native edge",
  );
  assert(
    JSON.stringify(edges) === before,
    "Cycle layout mutated native edge identities/guards",
  );
  const pending = new Set(ids), done = new Set<string>();
  while (pending.size) {
    const ready = [...pending].filter((id) =>
      plan.layoutEdges.filter((e) => e.target === id).every((e) =>
        done.has(e.source)
      )
    );
    assert(ready.length > 0, "Layout-only graph still cyclic");
    for (const id of ready) {
      pending.delete(id);
      done.add(id);
    }
  }
  assert(
    flowCycleBreak(ids, plan.layoutEdges).feedbackEdgeIds.size === 0,
    "Acyclic flow was altered",
  );
});
Deno.test("native definition scaffold remains available before instances and separate after admission", () => {
  const definition = {
    id: "lifecycle",
    kind: "state-definition",
    role: "definition",
  };
  const declared = {
    id: "proposed",
    kind: "state-usage",
    parentId: "lifecycle",
  };
  const requirement = {
    id: "exact",
    kind: "requirement-definition",
    role: "definition",
  };
  const nodes = [definition, declared, requirement];
  const before = JSON.stringify(nodes);
  const initial = nativeScaffoldNodes(nodes, "state-transition", null);
  assert(
    initial.mode === "library" && initial.nodes.length === 2,
    "Definition members must be shown without runtime instances",
  );
  assert(
    nativeScaffoldNodes(nodes, "requirements", null).nodes[0] === requirement,
    "Requirement definition incorrectly hidden",
  );
  const instance = {
    id: "candidate-life",
    kind: "exhibit-state-usage",
    parentId: "candidate",
  };
  const withInstance = [...nodes, instance, {
    id: "candidate-proposed",
    kind: "state-usage",
    parentId: instance.id,
  }];
  const live = nativeScaffoldNodes(withInstance, "state-transition", null);
  assert(
    live.mode === "instances" && live.nodes.length === 2,
    "Library states leaked into live instance",
  );
  assert(
    nativeScaffoldNodes(withInstance, "state-transition", "library").nodes
      .length === 2,
    "Explicit definition view lost once instance exists",
  );
  assert(
    JSON.stringify(nodes) === before &&
      !initial.nodes.some((n: { observedState?: boolean }) => n.observedState),
    "Scaffold fabricated observed state or mutated model",
  );
});
