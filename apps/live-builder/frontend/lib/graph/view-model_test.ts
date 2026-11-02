import { nativeFlowScopes } from "./projection.ts";
import { defaultDiagramOptions, DiagramModel } from "./view-model.ts";
import type { NativeModelView as NativeView } from "./types.ts";
import { flowFixture } from "../../test/support/flow-fixture.ts";
import {
  mandateFixture as fixture,
  type ViewNode,
} from "../../test/support/mandate-fixture.ts";
function assert(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}
Deno.test("ConversationCase becomes the default by native type while explicit selection persists", () => {
  const f = flowFixture(), all = nativeFlowScopes(f.nodes, f.edges);
  let available = all.filter((entry) => entry.scope.id === f.promotion.id);
  const options = defaultDiagramOptions();
  const selection = {
    current: () =>
      new DiagramModel({
        nodes: f.nodes.filter((node) =>
          !all.some((scope) => scope.scope.id === node.id) ||
          available.some((scope) => scope.scope.id === node.id)
        ),
        edges: f.edges,
      }, options).flowScope,
    choose(id: string) {
      options.flowScopeId = id;
      return this.current();
    },
  };
  assert(
    selection.current()?.scope.id === f.promotion.id,
    "Initial native flow unavailable",
  );
  available = all;
  assert(
    selection.current()?.scope.id === f.conversation.id,
    "ConversationCase native type was not preferred when it arrived",
  );
  assert(
    selection.choose(f.promotion.id)?.scope.id === f.promotion.id,
    "Promotion cannot be explicitly selected",
  );
  assert(
    selection.current()?.scope.id === f.promotion.id,
    "Explicit user selection was overwritten",
  );
  available = all.filter((entry) => entry.scope.id !== f.promotion.id);
  assert(
    selection.current()?.scope.id === f.conversation.id,
    "Removed scope left selection stuck",
  );
});
Deno.test("General keeps allocated outputs only while their producing action is visible", () => {
  const f = fixture();
  const choose: ViewNode = {
    ...f.action,
    id: "use:chooseNextMove",
    nativeId: "native-choose",
    label: "chooseNextMove",
  };
  const candidate: ViewNode = {
    id: "out:candidate",
    nativeId: "native-candidate",
    role: "usage",
    category: "item",
    parentId: f.action.id,
    declaredDirection: "out",
  };
  const choice: ViewNode = {
    ...candidate,
    id: "out:choice",
    nativeId: "native-choice",
    label: "choice:NextMove",
    parentId: choose.id,
  };
  f.nodes.push(choose, candidate, choice);
  f.edges.push(
    {
      id: "allocated:choose",
      source: choose.id,
      target: f.holder.id,
      kind: "allocation",
    },
    {
      id: "owns:candidate",
      source: f.action.id,
      target: candidate.id,
      kind: "owns",
    },
    {
      id: "allocated:choose",
      source: choose.id,
      target: choice.id,
      kind: "owns",
    },
  );
  const before = JSON.stringify(f);
  const selectedIds = [f.holder.id, f.action.id];
  const group: NativeView = {
    id: "view:operator",
    nativeId: "operator",
    label: "operator",
    members: [{ resolution: "resolved", graphNodeIds: selectedIds }],
  };
  const overview: NativeView = {
    id: "view:overview",
    nativeId: "overview",
    label: "overview",
    members: [{ resolution: "resolved", nestedViewId: group.id }],
  };
  const options = { ...defaultDiagramOptions(), view: "general" as const };
  let planned = true;
  const nodesForView = () =>
    new DiagramModel({ ...f, views: planned ? [group, overview] : [] }, options)
      .visibleNodes;
  const shown = () => nodesForView().map((node) => node.id).sort().join(",");
  assert(
    shown() === [f.holder.id, f.action.id, candidate.id].sort().join(","),
    "An unexposed action left its output orphaned in General",
  );
  selectedIds.push(choose.id);
  assert(
    nodesForView().includes(choose) && nodesForView().includes(choice),
    "Exposing the producer did not restore its native output",
  );
  selectedIds.splice(selectedIds.indexOf(choose.id), 1);
  assert(
    !nodesForView().includes(choose) && !nodesForView().includes(choice),
    "Removing the producer exposure left its output visible",
  );
  options.showAllocated = false;
  assert(
    shown() === f.holder.id,
    "Allocated content survived its display toggle",
  );
  options.showAllocated = true;
  planned = false;
  assert(
    nodesForView().includes(candidate) && nodesForView().includes(choice),
    "Without native views, allocated actions lost their outputs",
  );
  assert(
    JSON.stringify(f) === before,
    "General mutated native ownership or allocations",
  );
});

Deno.test("General nests native frames while preserving native owners and unjudged exposed actions", () => {
  const part = (id: string, parentId?: string): ViewNode => ({
    id,
    nativeId: `native-${id}`,
    label: id,
    parentId,
    role: "usage",
    category: "part",
    kind: "part-usage",
  });
  const nodes = [
    part("system"),
    part("context", "system"),
    part("skills", "context"),
    part("policy", "skills"),
    part("memory", "system"),
    {
      id: "install",
      nativeId: "native-install",
      role: "usage",
      category: "action",
      kind: "perform-action-usage",
      parentId: "skills",
    },
    {
      id: "result",
      role: "usage",
      category: "item",
      kind: "item-usage",
      parentId: "install",
      declaredDirection: "out",
    },
  ];
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
  const expose = (...ids: string[]) => ({
    resolution: "resolved",
    graphNodeIds: ids,
  });
  const views = [
    view("overview", [nested("context"), nested("memory")]),
    view("context", [expose("context"), nested("skills")]),
    view("skills", [expose("skills", "policy", "install")]),
    view("memory", [expose("memory")]),
  ];
  const graph = { nodes, views, edges: [] };
  const before = JSON.stringify(graph);
  const options = { ...defaultDiagramOptions(), view: "general" as const };
  const elements = new DiagramModel(graph, options).elements;
  const data = new Map(
    elements.map((element) => [element.data.id, element.data]),
  );
  assert(
    elements.length === data.size,
    "An exposed node or frame was duplicated",
  );
  assert(
    data.get("view:skills")?.parent === "view:context",
    "Skills frame was not nested in Context",
  );
  assert(
    data.get("skills")?.parent === "view:skills" &&
      data.get("skills")?.nativeParent === "context",
    "Physical owner in another view overrode explicit membership",
  );
  assert(
    data.get("policy")?.parent === "skills" &&
      data.get("policy")?.nativeParent === "skills",
    "Same-view native containment was lost",
  );
  assert(
    data.has("install") && data.has("result"),
    "Native exposed operation or its output required a fabricated judgment allocation",
  );
  assert(
    data.get("install")?.nativeParent === "skills",
    "Action native ownership was lost",
  );
  assert(
    elements.filter((element) => element.data.isNativeView).every((element) =>
      !String(element.classes).includes("mandate-scope")
    ),
    "Information frame fabricated mandate evidence",
  );
  options.showAllocated = false;
  assert(
    !new DiagramModel(graph, options).visibleNodes.some((node) =>
      node.id === "install" || node.id === "result"
    ),
    "Operation display toggle was ignored",
  );
  assert(JSON.stringify(graph) === before, "Presentation rewrote native facts");
});

function behaviorAccessGraph() {
  const part = (id: string, parentId?: string) => ({
    id,
    label: id,
    role: "usage",
    category: "part",
    kind: "part-usage",
    parentId,
  });
  const nodes = [
    part("system"),
    part("builder", "system"),
    { ...part("access", "system"), label: "installAccess" },
    part("caller", "access"),
    {
      id: "input",
      label: "input",
      role: "usage",
      category: "item",
      kind: "item-usage",
      parentId: "access",
    },
    {
      id: "target",
      label: "target",
      role: "usage",
      category: "action",
      kind: "action-usage",
      parentId: "access",
    },
    {
      id: "def:access",
      label: "BehaviorAccess",
      role: "definition",
      category: "part",
      kind: "part-definition",
    },
    {
      id: "def:operator",
      label: "SoftwareOperator",
      role: "definition",
      category: "part",
      kind: "part-definition",
    },
    {
      id: "def:request",
      label: "LoadSkillRequest",
      role: "definition",
      category: "item",
      kind: "item-definition",
    },
  ];
  const edges = [
    {
      id: "type:access",
      source: "access",
      target: "def:access",
      kind: "typing",
    },
    {
      id: "type:caller",
      source: "caller",
      target: "def:operator",
      kind: "typing",
    },
    {
      id: "type:input",
      source: "input",
      target: "def:request",
      kind: "typing",
    },
    { id: "owns:access", source: "system", target: "access", kind: "owns" },
    { id: "owns:caller", source: "access", target: "caller", kind: "owns" },
    { id: "owns:input", source: "access", target: "input", kind: "owns" },
    { id: "bind:caller", source: "caller", target: "builder", kind: "binding" },
  ];
  return { nodes, edges };
}

Deno.test("interconnection and general factor BehaviorAccess into a single leaf chip", () => {
  const graph = behaviorAccessGraph();
  const before = JSON.stringify(graph);
  for (const view of ["interconnection", "general"] as const) {
    const model = new DiagramModel(graph, {
      ...defaultDiagramOptions(),
      view,
    });
    const ids = model.visibleNodes.map((node) => node.id);
    assert(ids.includes("access"), `${view} lost the BehaviorAccess itself`);
    assert(
      !ids.includes("caller") && !ids.includes("input") &&
        !ids.includes("target"),
      `${view} still projects BehaviorAccess children: ${ids.join(",")}`,
    );
    const elements = model.elements;
    const data = new Map(
      elements.map((element) => [element.data.id, element.data]),
    );
    assert(
      data.get("access")?.parent === "system",
      `${view} BehaviorAccess lost its native parent`,
    );
    assert(
      ![...data.values()].some((entry) => entry.parent === "access"),
      `${view} BehaviorAccess is not a leaf`,
    );
    assert(
      elements.some((element) =>
        element.data.id === "access" &&
        String(element.classes).includes("behavior-access")
      ),
      `${view} BehaviorAccess leaf lost its chip class`,
    );
    const projected = model.edges.find((edge) => edge.id === "bind:caller");
    assert(
      projected?.source === "access" && projected?.target === "builder",
      `${view} caller binding was not re-anchored on the BehaviorAccess`,
    );
    assert(
      elements.some((element) =>
        element.data.id === "e:bind:caller" &&
        element.data.source === "access" && element.data.target === "builder"
      ),
      `${view} re-anchored binding is not rendered`,
    );
    // The native graph is untouched: the inspector still reaches children.
    assert(
      model.map.has("caller") && model.map.has("input") &&
        model.nodes.some((node) => node.id === "caller"),
      `${view} factorisation removed children from the native model`,
    );
  }
  assert(
    JSON.stringify(graph) === before,
    "Factorisation mutated native facts",
  );
});

Deno.test("BehaviorAccess factorisation leaves action-flow projections untouched", () => {
  const graph = {
    nodes: [
      {
        id: "system",
        label: "system",
        role: "usage",
        category: "part",
        kind: "part-usage",
      },
      {
        id: "scope",
        label: "scope",
        role: "usage",
        category: "action",
        kind: "perform-action-usage",
        parentId: "system",
      },
      {
        id: "access",
        label: "installAccess",
        role: "usage",
        category: "part",
        kind: "part-usage",
        parentId: "scope",
      },
      {
        id: "target",
        label: "target",
        role: "usage",
        category: "action",
        kind: "action-usage",
        parentId: "access",
      },
      {
        id: "step",
        label: "step",
        role: "usage",
        category: "action",
        kind: "action-usage",
        parentId: "scope",
      },
      {
        id: "def:case",
        label: "ConversationCase",
        role: "definition",
        category: "action",
        kind: "action-definition",
      },
      {
        id: "def:access",
        label: "BehaviorAccess",
        role: "definition",
        category: "part",
        kind: "part-definition",
      },
    ],
    edges: [
      { id: "type:case", source: "scope", target: "def:case", kind: "typing" },
      {
        id: "type:access",
        source: "access",
        target: "def:access",
        kind: "typing",
      },
      {
        id: "flow:target",
        source: "target",
        target: "step",
        kind: "succession",
      },
    ],
  };
  const model = new DiagramModel(graph, {
    ...defaultDiagramOptions(),
    view: "action-flow",
  });
  const ids = model.visibleNodes.map((node) => node.id);
  assert(
    ids.includes("target") && ids.includes("step"),
    `action-flow lost its native steps to factorisation: ${ids.join(",")}`,
  );
});

Deno.test("General retains a frame with only nested content and leaves ambiguous membership unparented", () => {
  const nodes = [
    { id: "owner", role: "usage", category: "part", kind: "part-usage" },
    {
      id: "policy",
      parentId: "owner",
      role: "usage",
      category: "part",
      kind: "part-usage",
    },
  ];
  const views: NativeView[] = [
    {
      id: "view:root",
      nativeId: "root",
      label: "Root",
      members: [{ resolution: "resolved", nestedViewId: "view:context" }],
    },
    {
      id: "view:context",
      nativeId: "context",
      label: "Context",
      members: [{ resolution: "resolved", nestedViewId: "view:skills" }],
    },
    {
      id: "view:skills",
      nativeId: "skills",
      label: "Skills",
      members: [{ resolution: "resolved", graphNodeIds: ["owner", "policy"] }],
    },
  ];
  const elements = () =>
    new DiagramModel({ nodes, edges: [], views }, {
      ...defaultDiagramOptions(),
      view: "general",
    }).elements;
  assert(
    elements().some((element) => element.data.id === "view:context"),
    "A frame containing only another frame disappeared",
  );
  views[1].members.push({ resolution: "resolved", graphNodeIds: ["policy"] });
  const policy =
    elements().find((element) => element.data.id === "policy")!.data;
  assert(
    policy.parent === undefined && policy.nativeParent === "owner",
    "Physical containment silently resolved an ambiguous view membership",
  );
});
