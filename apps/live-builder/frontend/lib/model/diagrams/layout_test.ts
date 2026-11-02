import assert from "node:assert/strict";
import type { ModelDiagram } from "../../../../src/domain/model/records/diagram-views.ts";
import {
  buildDiagram,
  defaultFolds,
  type ElkNode,
  header,
  sceneOf,
  typeLabel,
} from "./layout.ts";

const measure = (text: string) => text.length * 6.5;
const block = (id: string, parent?: string, name = id) => ({
  id,
  kind: "block",
  name,
  stereo: "part",
  nodeKind: "usage",
  rows: [],
  ...(parent ? { parent } : {}),
});
const port = (id: string, parent: string) => ({
  id,
  kind: "port",
  name: id,
  typeName: "P",
  stereo: "port",
  parent,
  rows: [],
});

const structure: ModelDiagram = {
  nodes: [
    block("sys"),
    block("a", "sys"),
    port("a~out", "a"),
    block("b", "sys"),
    block("b1", "b"),
    port("b1~in", "b1"),
    block("b2", "b"),
    port("b2~in", "b2"),
  ],
  edges: [
    { kind: "connect", source: "a~out", target: "b1~in" },
    { kind: "connect", source: "a~out", target: "b2~in" },
    { kind: "binding", source: "b1", target: "b" },
  ],
};

const flow: ModelDiagram = {
  nodes: [
    {
      id: "F",
      kind: "state",
      name: "F",
      stereo: "action def",
      nodeKind: "def",
      rows: [],
    },
    {
      id: "work",
      kind: "state",
      name: "work",
      stereo: "action",
      nodeKind: "usage",
      parent: "F",
      rows: [],
    },
    {
      id: "check",
      kind: "control",
      name: "check",
      stereo: "choice",
      parent: "F",
      rows: [],
    },
    {
      id: "done",
      kind: "state",
      name: "done",
      stereo: "action",
      nodeKind: "usage",
      parent: "F",
      rows: [],
    },
    // The Toolkit lists the initial pseudo-state last.
    {
      id: "F~initial",
      kind: "pseudo",
      name: "",
      stereo: "initial",
      parent: "F",
      rows: [],
    },
  ],
  edges: [
    { kind: "succession", source: "F~initial", target: "work" },
    { kind: "succession", source: "work", target: "check" },
    { kind: "succession", source: "check", target: "done", guard: "ok" },
    { kind: "succession", source: "check", target: "work", guard: "else" },
  ],
};

Deno.test("interconnection views open folded below the top block", () => {
  assert.deepEqual([...defaultFolds("interconnection", structure)], ["b"]);
  assert.deepEqual([...defaultFolds("action", flow)], []);
});

Deno.test("a folded block keeps its ports and stands for its hidden contents", () => {
  const model = buildDiagram("interconnection", structure, {
    folded: new Set(["b"]),
    hiddenKinds: new Set(),
  }, measure);
  const sys = model.graph.children![0];
  const b = sys.children!.find((c) => c.id === "b")!;
  assert.equal(b.children!.length, 0);
  assert.equal(model.nodes.get("b")!.folded, 2);
  assert.equal(sys.children!.find((c) => c.id === "a")!.ports![0].id, "a~out");
  // Both connections now reach the folded block: one line, counted.
  assert.equal(sys.edges!.length, 1);
  assert.deepEqual(sys.edges![0].targets, ["b"]);
  const info = model.edges.get(sys.edges![0].id)!;
  assert.equal(info.members.length, 2);
  assert.deepEqual(info.lines, ["×2"]);
});

Deno.test("unfolded edges reach ports, and an edge to an enclosing block uses an inner port", () => {
  const model = buildDiagram("interconnection", structure, {
    folded: new Set(),
    hiddenKinds: new Set(),
  }, measure);
  const sys = model.graph.children![0];
  assert.deepEqual(
    sys.edges!.map((e) => [e.sources[0], e.targets[0]]),
    [["a~out", "b1~in"], ["a~out", "b2~in"]],
  );
  const b = sys.children!.find((c) => c.id === "b")!;
  assert.deepEqual(b.edges!.map((e) => e.targets[0]), ["b~inner"]);
  assert.equal(model.ports.get("b~inner")?.implicit, true);
  // Nested graphs repeat the view's layered settings.
  assert.equal(b.layoutOptions!["elk.direction"], "RIGHT");
});

Deno.test("hidden relationship kinds leave the picture", () => {
  const model = buildDiagram("interconnection", structure, {
    folded: new Set(),
    hiddenKinds: new Set(["binding"]),
  }, measure);
  const b = model.graph.children![0].children!.find((c) => c.id === "b")!;
  assert.equal(b.edges!.length, 0);
  assert.equal(model.ports.has("b~inner"), false);
});

Deno.test("behaviour views rank nodes in flow order and label guards", () => {
  const model = buildDiagram("action", flow, {
    folded: new Set(),
    hiddenKinds: new Set(),
  }, measure);
  const frame = model.graph.children![0];
  assert.deepEqual(frame.children!.map((c) => c.id), [
    "F~initial",
    "work",
    "check",
    "done",
  ]);
  const guards = [...model.edges.values()].filter((e) => e.guard).map((e) =>
    e.lines.join(" ")
  );
  assert.deepEqual(guards.sort(), ["[else]", "[ok]"]);
});

Deno.test("scene coordinates are absolute for shapes and edge sections", () => {
  const model = buildDiagram("interconnection", structure, {
    folded: new Set(["b"]),
    hiddenKinds: new Set(),
  }, measure);
  const edgeId = model.graph.children![0].edges![0].id;
  const laid: ElkNode = {
    id: "root",
    width: 400,
    height: 200,
    children: [{
      id: "sys",
      x: 10,
      y: 20,
      width: 380,
      height: 160,
      children: [
        {
          id: "a",
          x: 5,
          y: 40,
          width: 100,
          height: 40,
          ports: [{ id: "a~out", x: 94, y: 14, width: 11, height: 11 }],
        },
        { id: "b", x: 200, y: 40, width: 120, height: 40 },
      ],
      edges: [{
        id: edgeId,
        sources: ["a~out"],
        targets: ["b"],
        container: "sys",
        sections: [{
          startPoint: { x: 110, y: 60 },
          endPoint: { x: 200, y: 60 },
        }],
      }],
    }],
  };
  const scene = sceneOf(model, laid);
  const a = scene.nodes.find((n) => n.id === "a")!;
  assert.deepEqual([a.x, a.y], [15, 60]);
  assert.deepEqual(
    [scene.ports[0].x, scene.ports[0].y],
    [109, 74],
  );
  assert.deepEqual(scene.edges[0].paths[0], [{ x: 120, y: 80 }, {
    x: 210,
    y: 80,
  }]);
});

Deno.test("ELK lays a behaviour flow out from its initial node downwards", async () => {
  // The production loader is browser-only; supply the browser discriminator
  // because Deno's `self` otherwise makes ELK mistake this process for a worker.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    value: {},
    configurable: true,
  });
  try {
    const { layoutDiagram } = await import("./elk.ts");
    const model = buildDiagram("action", flow, {
      folded: new Set(),
      hiddenKinds: new Set(),
    }, measure);
    const scene = sceneOf(model, await layoutDiagram(model.graph));
    const y = (id: string) => scene.nodes.find((n) => n.id === id)!.y;
    assert.ok(y("F~initial") < y("work"));
    assert.ok(y("work") < y("check"));
    assert.ok(y("check") < y("done"));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

Deno.test("names containing colon-like text stay intact and typing uses its own field", () => {
  const node = { ...block("q"), name: "quoted : name", typeName: "ActualType" };
  const measured = header(node, measure);
  assert.equal(measured.name, "quoted : name");
  assert.equal(measured.type, ": ActualType");
  assert.equal(node.typeName, "ActualType");
  assert.equal(typeLabel(block("untyped")), "");
  assert.equal(measured.width, measure(node.name) + measure(" : ActualType"));
});

Deno.test("ELK preserves a declared self-transition as a routed loop", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    value: {},
    configurable: true,
  });
  try {
    const { layoutDiagram } = await import("./elk.ts");
    const model = buildDiagram(
      "state",
      {
        nodes: [{ id: "waiting", name: "waiting", kind: "state", rows: [] }],
        edges: [{
          source: "waiting",
          target: "waiting",
          kind: "transition",
          label: "retry",
        }],
      },
      { folded: new Set(), hiddenKinds: new Set() },
      measure,
    );
    assert.equal(model.edges.size, 1);
    assert.deepEqual([...model.edges.values()][0].lines, ["retry"]);
    const scene = sceneOf(model, await layoutDiagram(model.graph));
    assert.equal(scene.edges.length, 1);
    const loop = scene.edges[0];
    assert.equal(loop.source, "waiting");
    assert.equal(loop.target, "waiting");
    assert.ok(
      loop.paths.some((path) => path.length >= 4),
      "a loop needs routed bends",
    );
    const node = scene.nodes[0];
    assert.ok(
      loop.paths.flat().some((point) =>
        point.x < node.x || point.x > node.x + node.w || point.y < node.y ||
        point.y > node.y + node.h
      ),
      "the loop must extend outside the state",
    );
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

Deno.test("folding still removes distinct endpoints hidden inside the same block", () => {
  const model = buildDiagram(
    "interconnection",
    {
      nodes: [block("root"), block("a", "root"), block("b", "root")],
      edges: [{ source: "a", target: "b", kind: "connection" }],
    },
    { folded: new Set(["root"]), hiddenKinds: new Set() },
    measure,
  );
  assert.equal(model.edges.size, 0);
});
