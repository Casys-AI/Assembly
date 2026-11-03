import { deepStrictEqual, equal, ok } from "node:assert/strict";
import cytoscape from "cytoscape";
import {
  diagramViewport,
  diagramViewportVisible,
  GraphController,
  readableFitZoom,
  restoreDiagramViewport,
} from "./controller.ts";
import { defaultDiagramOptions, DiagramModel } from "./view-model.ts";
import { mandateFixture } from "../../test/support/mandate-fixture.ts";
import type { GraphData, NativeModelView } from "./types.ts";

Deno.test("nested native frames pack their exposed operations without changing the preserved viewport", () => {
  const f = mandateFixture();
  const view = (
    nativeId: string,
    members: NativeModelView["members"],
  ): NativeModelView => ({
    id: `view:${nativeId}`,
    nativeId,
    label: nativeId,
    members,
  });
  const nested = (id: string) => ({
    resolution: "resolved",
    nestedViewId: `view:${id}`,
  });
  const expose = (...graphNodeIds: string[]) => ({
    resolution: "resolved",
    graphNodeIds,
  });
  const graph: GraphData = {
    nodes: [
      ...f.nodes,
      ...["install", "recall"].map((id) => ({
        id,
        nativeId: `native-${id}`,
        label: id,
        role: "usage",
        category: "action",
        kind: "perform-action-usage",
      })),
    ],
    edges: f.edges,
    views: [
      view("overview", [
        nested("builder"),
        nested("context"),
        nested("memory"),
      ]),
      view("builder", [expose(f.holder.id, f.action.id)]),
      view("context", [nested("skills")]),
      view("skills", [expose("install")]),
      view("memory", [expose("recall")]),
    ],
  };
  const controller = new GraphController(undefined, () => {}, true),
    cy = controller.cy;
  cy.width = () => 1400;
  cy.height = () => 800;
  const model = new DiagramModel(graph, {
    ...defaultDiagramOptions(),
    view: "general",
  });
  try {
    controller.render(model);
    equal(cy.getElementById("view:skills").parent()[0]?.id(), "view:context");
    const box = (id: string) =>
      cy.getElementById(id).boundingBox({ includeLabels: false });
    const context = box("view:context"),
      skills = box("view:skills"),
      memory = box("view:memory");
    ok(
      context.x1 < skills.x1 && context.x2 > skills.x2 &&
        context.y1 < skills.y1 && context.y2 > skills.y2,
      "Nested frame does not contain its child frame",
    );
    ok(
      context.x2 <= memory.x1 || memory.x2 <= context.x1 ||
        context.y2 <= memory.y1 || memory.y2 <= context.y1,
      "Sibling information frames overlap",
    );
    const install = box("install"), recall = box("recall");
    ok(
      install.x2 <= recall.x1 || recall.x2 <= install.x1 ||
        install.y2 <= recall.y1 || recall.y2 <= install.y1,
      "Exposed operations were left stacked at the origin",
    );
    const positions = new Map(
      cy.nodes(":childless").map((node) => [node.id(), { ...node.position() }]),
    );
    cy.zoom(.43);
    cy.pan({ x: 117, y: -23 });
    controller.render(model, true);
    equal(cy.zoom(), .43);
    deepStrictEqual(cy.pan(), { x: 117, y: -23 });
    for (const [id, position] of positions) {
      deepStrictEqual(cy.getElementById(id).position(), position);
    }
  } finally {
    controller.destroy();
  }
});

Deno.test("diagram refresh preserves user zoom, pan and surviving positions", () => {
  const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    elements: [{ data: { id: "part" }, position: { x: 70, y: 220 } }],
    layout: { name: "preset" },
  });
  cy.width = () => 1414;
  cy.height = () => 810;
  try {
    cy.zoom(.37);
    cy.pan({ x: 29, y: -61 });
    const viewport = diagramViewport(cy, true);
    ok(viewport);
    cy.zoom(1);
    cy.pan({ x: 0, y: 0 });
    cy.getElementById("part").position({ x: 500, y: 500 });
    restoreDiagramViewport(cy, viewport);
    equal(cy.zoom(), .37);
    deepStrictEqual(cy.pan(), { x: 29, y: -61 });
    deepStrictEqual(cy.getElementById("part").position(), { x: 70, y: 220 });
    equal(diagramViewport(cy, false), null);
  } finally {
    cy.destroy();
  }
});

Deno.test("native structural renderer retains catalog contracts, conversation policy and viewport", () => {
  const part = (id: string, parentId?: string) => ({
    id,
    label: id,
    kind: "part-usage",
    category: "part",
    role: "usage",
    parentId,
  });
  const port = (id: string, parentId: string) => ({
    id,
    label: id,
    kind: "port-usage",
    category: "port",
    role: "usage",
    parentId,
  });
  const graph = {
    nodes: [
      part("system"),
      part("builder", "system"),
      part("gate", "system"),
      part("sandbox", "system"),
      part("catalog", "system"),
      part("candidate", "catalog"),
      {
        id: "conversation",
        label: "conversation",
        kind: "perform-action-usage",
        category: "action",
        role: "usage",
        parentId: "system",
        typeName: "ConversationCase",
      },
      {
        id: "behavior-step",
        label: "read",
        kind: "action-usage",
        category: "action",
        role: "usage",
        parentId: "conversation",
      },
      port("out", "builder"),
      port("in", "gate"),
      ...["policy", "contract", "outline", "contract-ref"].map((id) => ({
        id,
        label: id,
        parentId: id === "policy"
          ? "conversation"
          : id === "contract-ref"
          ? "candidate"
          : "catalog",
        isReference: id === "contract-ref",
        role: "usage",
        kind: "item-usage",
        category: "item",
        typeName: id.includes("policy")
          ? "ExecutionPolicy"
          : "CapabilityContract",
      })),
      {
        id: "payload",
        label: "contract fields ".repeat(1000),
        parentId: "out",
        role: "usage",
        kind: "item-usage",
        category: "item",
      },
    ],
    edges: [
      {
        id: "connection",
        kind: "connection",
        source: "out",
        target: "in",
      },
      ...["policy", "contract", "outline", "contract-ref"].map((id) => ({
        id: "owns:" + id,
        source: id === "policy"
          ? "conversation"
          : id === "contract-ref"
          ? "candidate"
          : "catalog",
        target: id,
        kind: "owns",
      })),
      {
        id: "contract-binding",
        nativeId: "native-contract-binding",
        kind: "binding",
        source: "contract-ref",
        target: "contract",
      },
    ],
  };
  const before = JSON.stringify(graph);
  const controller = new GraphController(undefined, () => {}, true),
    cy = controller.cy;
  cy.width = () => 1414;
  cy.height = () => 810;
  const options = {
    ...defaultDiagramOptions(),
    view: "interconnection" as const,
  };
  try {
    controller.render(new DiagramModel(graph, options));
    cy.zoom(.36);
    cy.pan({ x: 707, y: 405 });
    const positions = new Map(
      cy.nodes().toArray().filter((node) => !node.isParent()).map(
        (node) => [node.id(), { ...node.position() }],
      ),
    );
    controller.render(new DiagramModel(graph, options), true);
    equal(cy.zoom(), .36);
    deepStrictEqual(cy.pan(), { x: 707, y: 405 });
    for (const [id, position] of positions) {
      deepStrictEqual(cy.getElementById(id).position(), position);
    }
    const bbox = cy.elements().boundingBox();
    ok(
      bbox.w > 0 && bbox.w < 2500 && bbox.h < 2500,
      `Compound layout ballooned: ${JSON.stringify(bbox)}`,
    );
    equal(cy.getElementById("system").isParent(), true);
    equal(cy.getElementById("payload").length, 0);
    for (const view of ["interconnection", "general"] as const) {
      controller.render(new DiagramModel(graph, { ...options, view }));
      const parents = Object.fromEntries(
        [
          "catalog",
          "candidate",
          "contract",
          "outline",
          "contract-ref",
          "conversation",
          "policy",
        ].map((id) => [id, cy.getElementById(id).parent()[0]?.id()]),
      );
      deepStrictEqual(parents, {
        catalog: "system",
        candidate: "catalog",
        contract: "catalog",
        outline: "catalog",
        "contract-ref": "candidate",
        conversation: "system",
        policy: "conversation",
      });
      equal(cy.getElementById("e:contract-binding").length, 1);
      equal(cy.getElementById("conversation").hasClass("native-context"), true);
      equal(cy.getElementById("conversation").hasClass("part"), false);
      equal(cy.getElementById("behavior-step").length, 0);
      equal(
        cy.nodes().filter((node) => node.id().startsWith("presentation:"))
          .length,
        0,
      );
    }
    equal(
      JSON.stringify(graph),
      before,
      "Presentation modified native evidence",
    );
  } finally {
    controller.destroy();
  }
  equal(cy.destroyed(), true);
  controller.render(new DiagramModel(graph, options));
  equal(cy.destroyed(), true, "Disposed controller was recreated");
});

Deno.test("zero-size native canvas rejects invalid framing and visible fit recovers it", () => {
  let width = 0, height = 0;
  const controller = new GraphController(undefined, () => {}, true),
    cy = controller.cy;
  cy.width = () => width;
  cy.height = () => height;
  cy.add({
    data: { id: "native", label: "native" },
    position: { x: 10000, y: 10000 },
  });
  try {
    equal(diagramViewport(cy, true), null);
    width = 1414;
    height = 810;
    cy.zoom(1);
    cy.pan({ x: 0, y: 0 });
    equal(
      diagramViewport(cy, true),
      null,
      "Offscreen viewport was treated as healthy",
    );
    controller.fit();
    ok(diagramViewportVisible(cy));
    ok(diagramViewport(cy, true));
    const zoom = cy.zoom(), pan = { ...cy.pan() };
    cy.pan({ x: pan.x + 20, y: pan.y + 20 });
    controller.fit();
    equal(cy.zoom(), zoom);
    deepStrictEqual(cy.pan(), pan);
  } finally {
    controller.destroy();
  }
});

Deno.test("dense compound diagrams open at a readable zoom centered on operators", () => {
  const controller = new GraphController(undefined, () => {}, true),
    cy = controller.cy;
  cy.width = () => 400;
  cy.height = () => 300;
  const general = {
    ...defaultDiagramOptions(),
    view: "general" as const,
  };
  try {
    controller.model = new DiagramModel({ nodes: [], edges: [] }, general);
    cy.add([
      {
        data: { id: "operator", label: "operator" },
        classes: "part operator",
        position: { x: 0, y: 0 },
      },
      {
        data: { id: "far", label: "far" },
        classes: "part",
        position: { x: 4000, y: 3000 },
      },
    ]);
    controller.fit();
    equal(cy.zoom(), readableFitZoom("general"));
    ok(diagramViewportVisible(cy));
    controller.model = new DiagramModel(
      { nodes: [], edges: [] },
      defaultDiagramOptions(),
    );
    controller.fit();
    ok(cy.zoom() < readableFitZoom("general"));
    equal(readableFitZoom("action-flow"), 0);
  } finally {
    controller.destroy();
  }
});

Deno.test("structural layouts stay compact, contained and readable without overlaps", () => {
  const part = (id: string, parentId?: string) => ({
    id,
    label: id,
    kind: "part-usage",
    category: "part",
    role: "usage",
    parentId,
  });
  const nodes: ReturnType<typeof part>[] = [part("system")];
  for (let i = 0; i < 10; i++) nodes.push(part(`leaf-${i}`, "system"));
  for (let g = 0; g < 3; g++) {
    nodes.push(part(`group-${g}`, "system"));
    for (let i = 0; i < 4; i++) {
      nodes.push(part(`group-${g}-leaf-${i}`, `group-${g}`));
    }
  }
  const graph = {
    nodes,
    edges: [
      {
        id: "c1",
        kind: "connection",
        source: "leaf-0",
        target: "group-0-leaf-0",
      },
      {
        id: "c2",
        kind: "connection",
        source: "leaf-5",
        target: "group-2-leaf-3",
      },
      {
        id: "c3",
        kind: "connection",
        source: "group-1-leaf-1",
        target: "leaf-9",
      },
    ],
  };
  const controller = new GraphController(undefined, () => {}, true),
    cy = controller.cy;
  cy.width = () => 1400;
  cy.height = () => 800;
  try {
    for (const view of ["interconnection", "general"] as const) {
      controller.render(
        new DiagramModel(graph, {
          ...defaultDiagramOptions(),
          view,
          showAllocated: false,
        }),
      );
      const leaves = cy.nodes(":childless").not(".port");
      let overlaps = 0;
      const boxes = leaves.map((node) =>
        node.boundingBox({ includeLabels: false })
      );
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          if (a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2) {
            overlaps++;
          }
        }
      }
      equal(overlaps, 0, `${view} overlaps leaf parts`);
      leaves.forEach((node) => {
        const parent = node.parent();
        if (!parent.length) return;
        const outer = parent.boundingBox({ includeLabels: false }),
          inner = node.boundingBox({ includeLabels: false });
        ok(
          inner.x1 >= outer.x1 - 2 && inner.x2 <= outer.x2 + 2 &&
            inner.y1 >= outer.y1 - 2 && inner.y2 <= outer.y2 + 2,
          `${view} leaf ${node.id()} escapes its parent`,
        );
      });
      const box = cy.nodes().boundingBox({ includeLabels: false });
      const fitZoom = Math.min(1400 / box.w, 800 / box.h);
      ok(
        fitZoom >= .5,
        `${view} opens unreadable: ${Math.round(box.w)}x${
          Math.round(box.h)
        } zoom=${fitZoom.toFixed(2)}`,
      );
    }
  } finally {
    controller.destroy();
  }
});

Deno.test("readable opening zoom never pushes the graph into a corner", () => {
  const controller = new GraphController(undefined, () => {}, true),
    cy = controller.cy;
  cy.width = () => 1200;
  cy.height = () => 440;
  try {
    controller.model = new DiagramModel({ nodes: [], edges: [] }, {
      ...defaultDiagramOptions(),
      view: "interconnection" as const,
    });
    cy.add([
      {
        data: { id: "operator", label: "operator" },
        classes: "part operator",
        position: { x: 0, y: 0 },
      },
      {
        data: { id: "far", label: "far" },
        classes: "part",
        position: { x: 600, y: 2000 },
      },
    ]);
    controller.fit();
    equal(cy.zoom(), readableFitZoom("interconnection"));
    const rendered = cy.elements().renderedBoundingBox({
      includeLabels: false,
    });
    ok(
      Math.abs((rendered.x1 + rendered.x2) / 2 - 600) < 3,
      `graph not centred horizontally: ${
        Math.round((rendered.x1 + rendered.x2) / 2)
      }`,
    );
    ok(
      rendered.y1 >= -2 && rendered.y1 <= 40,
      `empty margin opened above the graph: y1=${Math.round(rendered.y1)}`,
    );
    ok(diagramViewportVisible(cy));
  } finally {
    controller.destroy();
  }
});

Deno.test("hybrid force-ordered layout renders identical positions twice", () => {
  const part = (id: string, parentId?: string) => ({
    id,
    label: id,
    kind: "part-usage",
    category: "part",
    role: "usage",
    parentId,
  });
  const nodes: ReturnType<typeof part>[] = [part("system")];
  for (let i = 0; i < 6; i++) nodes.push(part(`leaf-${i}`, "system"));
  for (let g = 0; g < 2; g++) {
    nodes.push(part(`group-${g}`, "system"));
    for (let i = 0; i < 3; i++) {
      nodes.push(part(`group-${g}-leaf-${i}`, `group-${g}`));
    }
  }
  const graph = {
    nodes,
    edges: [
      {
        id: "c1",
        kind: "connection",
        source: "leaf-0",
        target: "group-1-leaf-2",
      },
      {
        id: "c2",
        kind: "connection",
        source: "group-0-leaf-0",
        target: "leaf-4",
      },
      {
        id: "c3",
        kind: "connection",
        source: "group-1-leaf-0",
        target: "group-0-leaf-1",
      },
    ],
  };
  const render = () => {
    const controller = new GraphController(undefined, () => {}, true);
    try {
      controller.render(
        new DiagramModel(graph, {
          ...defaultDiagramOptions(),
          view: "interconnection" as const,
        }),
      );
      return controller.cy.nodes(":childless").map((node) => [
        node.id(),
        Math.round(node.position("x") * 1000),
        Math.round(node.position("y") * 1000),
      ]);
    } finally {
      controller.destroy();
    }
  };
  deepStrictEqual(render(), render());
});

Deno.test("general native overview wraps into a readable landscape instead of a tall strip", () => {
  const holder = (id: string) => ({
    id,
    nativeId: `native-${id}`,
    label: id,
    role: "usage",
    category: "part",
    kind: "part-usage",
    parentId: "system",
    operator: {
      nativeId: `native-${id}`,
      roleLabel: "role",
      depictedJudgmentRefs: [0, 1, 2, 3, 4].map((i) => `native-${id}-act-${i}`),
      capabilityBindings: [],
    },
  });
  const nodes: Record<string, unknown>[] = [{
    id: "system",
    label: "system",
    role: "usage",
    category: "part",
    kind: "part-usage",
  }];
  const edges: Record<string, unknown>[] = [];
  for (const op of ["op-a", "op-b"]) {
    nodes.push(holder(op));
    for (let i = 0; i < 5; i++) {
      const action = `${op}-act-${i}`;
      nodes.push({
        id: action,
        nativeId: `native-${action}`,
        label: action,
        role: "usage",
        category: "action",
        kind: "action-usage",
      });
      nodes.push({
        id: `${action}-out`,
        label: "out",
        role: "usage",
        category: "item",
        kind: "item-usage",
        parentId: action,
        declaredDirection: "out",
      });
      edges.push({
        id: `alloc:${action}`,
        kind: "allocation",
        source: action,
        target: op,
      });
      edges.push({
        id: `owns:${action}`,
        kind: "owns",
        source: action,
        target: `${action}-out`,
      });
    }
  }
  for (let i = 0; i < 12; i++) {
    nodes.push({
      id: `neutral-${i}`,
      label: `neutral-${i}`,
      role: "usage",
      category: "part",
      kind: "part-usage",
      parentId: "system",
    });
  }
  const controller = new GraphController(undefined, () => {}, true),
    cy = controller.cy;
  cy.width = () => 1400;
  cy.height = () => 800;
  try {
    const model = new DiagramModel(
      { nodes, edges } as never,
      { ...defaultDiagramOptions(), view: "general" },
    );
    ok(model.allocated.actions.length > 0, "overview fixture has no actions");
    controller.render(model);
    const box = cy.nodes().boundingBox({ includeLabels: false });
    const aspect = box.w / box.h;
    ok(
      aspect >= .5,
      `overview is a tall strip: ${Math.round(box.w)}x${
        Math.round(box.h)
      } aspect=${aspect.toFixed(2)}`,
    );
  } finally {
    controller.destroy();
  }
});

Deno.test("live native projection refresh retains surviving node selection and related edges", () => {
  const controller = new GraphController(undefined, () => {}, true),
    cy = controller.cy;
  cy.width = () => 1200;
  cy.height = () => 800;
  const graph = {
    nodes: [
      { id: "a", label: "a", kind: "part-usage", category: "part" },
      { id: "b", label: "b", kind: "part-usage", category: "part" },
      {
        id: "unrelated",
        label: "unrelated",
        kind: "part-usage",
        category: "part",
      },
    ],
    edges: [{ id: "c", source: "a", target: "b", kind: "connection" }],
  };
  const options = { ...defaultDiagramOptions(), view: "general" as const };
  try {
    controller.render(new DiagramModel(graph, options));
    controller.select("a");
    ok(cy.getElementById("a").selected());
    ok(cy.getElementById("e:c").hasClass("hl"));
    ok(cy.getElementById("unrelated").hasClass("faded"));
    equal(cy.getElementById("b").hasClass("faded"), false);
    controller.clearSelection();
    equal(cy.$(":selected").length, 0);
    equal(cy.elements(".faded").length, 0);
    equal(cy.elements(".hl").length, 0);
    controller.select("a");
    controller.render(
      new DiagramModel({
        ...graph,
        nodes: [...graph.nodes, {
          id: "new",
          label: "new",
          kind: "part-usage",
          category: "part",
        }],
      }, options),
      true,
    );
    ok(
      cy.getElementById("a").selected(),
      "Selected native element was recreated without selection",
    );
    ok(
      cy.getElementById("e:c").hasClass("hl"),
      "Related native edge lost its highlight",
    );
    controller.render(
      new DiagramModel({ nodes: [graph.nodes[1]], edges: [] }, options),
      true,
    );
    equal(
      cy.$(":selected").length,
      0,
      "Removed element retained a stale selection",
    );
    equal(cy.elements(".faded").length, 0);
  } finally {
    controller.destroy();
  }
});

Deno.test("structural views get taxi edges with on-demand labels, behavioral guards stay visible", () => {
  const controller = new GraphController(undefined, () => {}, true),
    cy = controller.cy;
  cy.width = () => 1200;
  cy.height = () => 800;
  const structuralGraph = {
    nodes: [
      {
        id: "a",
        label: "a",
        kind: "part-usage",
        category: "part",
        role: "usage",
      },
      {
        id: "b",
        label: "b",
        kind: "part-usage",
        category: "part",
        role: "usage",
      },
    ],
    edges: [{
      id: "link",
      source: "a",
      target: "b",
      kind: "connection",
      label: "lien métier",
    }],
  };
  try {
    for (const view of ["interconnection", "general"] as const) {
      controller.render(
        new DiagramModel(structuralGraph, { ...defaultDiagramOptions(), view }),
      );
      const edge = cy.getElementById("e:link");
      equal(edge.length, 1, `${view} lost its connection edge`);
      ok(edge.hasClass("structural"), `${view} edge lacks structural class`);
      equal(edge.style("curve-style"), "taxi", `${view} edge is not taxi`);
      ok(edge.data("label"), `${view} edge label data must be retained`);
      equal(edge.style("label"), "", `${view} label must hide by default`);
      controller.select("a");
      ok(edge.hasClass("hl"), `${view} selection did not highlight the edge`);
      equal(
        edge.style("label"),
        edge.data("label"),
        `${view} hl must reveal the label`,
      );
      controller.clearSelection();
      equal(edge.style("label"), "", `${view} label must hide after clear`);
    }
    const flowGraph = {
      nodes: [
        {
          id: "scope",
          label: "scope",
          kind: "perform-action-usage",
          category: "action",
          role: "usage",
        },
        {
          id: "s1",
          label: "s1",
          kind: "action-usage",
          category: "action",
          role: "usage",
          parentId: "scope",
        },
        {
          id: "s2",
          label: "s2",
          kind: "action-usage",
          category: "action",
          role: "usage",
          parentId: "scope",
        },
      ],
      edges: [{
        id: "succ",
        source: "s1",
        target: "s2",
        kind: "succession",
        guard: "ready",
      }],
    };
    controller.render(
      new DiagramModel(flowGraph, {
        ...defaultDiagramOptions(),
        view: "action-flow",
      }),
    );
    const succ = cy.getElementById("e:succ");
    equal(succ.length, 1, "action-flow lost its succession edge");
    equal(succ.hasClass("structural"), false, "succession became structural");
    equal(succ.style("curve-style"), "bezier", "succession lost bezier");
    ok(
      succ.style("label").includes("ready"),
      "behavioral guard must stay visible without selection",
    );
  } finally {
    controller.destroy();
  }
});

Deno.test("normal zoom keeps all displayed items, ports and edges visible without moving or deselecting them", () => {
  const part = (id: string, parentId?: string) => ({
    id,
    label: id,
    kind: "part-usage",
    category: "part",
    role: "usage",
    parentId,
  });
  const item = (id: string, parentId: string) => ({
    id,
    label: id,
    kind: "item-usage",
    category: "item",
    role: "usage",
    parentId,
  });
  const port = (id: string, parentId: string) => ({
    id,
    label: id,
    kind: "port-usage",
    category: "port",
    role: "usage",
    parentId,
  });
  const graph = {
    nodes: [
      part("system"),
      part("builder", "system"),
      part("gate", "system"),
      item("contract", "builder"),
      item("bundle", "builder"),
      part("nested", "bundle"),
      port("out", "builder"),
      port("in", "gate"),
    ],
    edges: [{ id: "link", kind: "connection", source: "out", target: "in" }],
  };
  const controller = new GraphController(undefined, () => {}, true),
    cy = controller.cy;
  cy.width = () => 1400;
  cy.height = () => 800;
  try {
    for (const view of ["interconnection", "general"] as const) {
      const model = new DiagramModel(graph, {
        ...defaultDiagramOptions(),
        view,
      });
      controller.render(model);
      cy.zoom(1);
      equal(cy.getElementById("contract").length, 1, `${view}: no contract`);
      if (view === "interconnection") {
        equal(cy.getElementById("out").length, 1, "missing output port");
        equal(cy.getElementById("e:link").length, 1, "missing connection");
      }
      controller.select("contract");
      const elementIds = cy.elements().map((element) => element.id()).sort();
      const positions = new Map(
        cy.nodes(":childless").map((
          node,
        ) => [node.id(), { ...node.position() }]),
      );
      // Cross both former thresholds and reach the ordinary minimum zoom.
      for (const zoom of [.74, .34, .1, .01, 1]) {
        controller.zoom(zoom / cy.zoom());
        ok(Math.abs(cy.zoom() - zoom) < 1e-9, `${view}: normal zoom changed`);
        deepStrictEqual(
          cy.elements().map((element) => element.id()).sort(),
          elementIds,
        );
        for (const element of cy.elements()) {
          equal(
            element.visible(),
            true,
            `${view}: ${element.id()} hidden at ${zoom}`,
          );
        }
        ok(cy.getElementById("contract").selected(), `${view}: selection lost`);
        // Compound frames may recompute their bounds; leaf layout stays fixed.
        for (const node of cy.nodes(":childless")) {
          deepStrictEqual(
            node.position(),
            positions.get(node.id()),
            `${view}: ${node.id()} moved`,
          );
        }
      }
      cy.zoom(.1);
      controller.render(model, true);
      for (const element of cy.elements()) {
        equal(
          element.visible(),
          true,
          `${view}: ${element.id()} hidden after refresh`,
        );
      }
      ok(
        cy.getElementById("contract").selected(),
        `${view}: selection lost on refresh`,
      );
    }
  } finally {
    controller.destroy();
  }
});
