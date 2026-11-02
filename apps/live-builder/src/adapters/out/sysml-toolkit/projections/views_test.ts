import { NativeToolkitPanicError } from "../runtime/native-addon.ts";
import assert from "node:assert/strict";
import {
  projectToolkitViewDiagram,
  projectToolkitViewList,
  projectToolkitViewPlantuml,
  ToolkitViewApiUnavailableError,
} from "./views.ts";
import type { ToolkitSession } from "../runtime/loader.ts";

interface ShapeNodeFixture {
  id: string;
  name: string;
  qualifiedName: string;
  metaclass: string;
  owner: number;
}

const NODES: ShapeNodeFixture[] = [
  {
    id: "p",
    name: "Demo",
    qualifiedName: "Demo",
    metaclass: "Package",
    owner: -1,
  },
  {
    id: "s",
    name: "system",
    qualifiedName: "Demo::system",
    metaclass: "PartUsage",
    owner: 0,
  },
  {
    id: "b",
    name: "Broken",
    qualifiedName: "Demo::broken",
    metaclass: "PartUsage",
    owner: 0,
  },
  {
    id: "a",
    name: "Run",
    qualifiedName: "Demo::Run",
    metaclass: "ActionDefinition",
    owner: 0,
  },
  {
    id: "t",
    name: "Life",
    qualifiedName: "Demo::Life",
    metaclass: "StateDefinition",
    owner: 0,
  },
  {
    id: "v",
    name: "Overview",
    qualifiedName: "Demo::Overview",
    metaclass: "ViewUsage",
    owner: 0,
  },
  // Non-candidates (owned by `system`, not by a package): graph-only nodes
  // exercising declared names that contain the label separator.
  {
    id: "ab",
    name: "a : b",
    qualifiedName: "Demo::system::'a : b'",
    metaclass: "PartUsage",
    owner: 1,
  },
  {
    id: "ef",
    name: "e : f",
    qualifiedName: "Demo::system::'e : f'",
    metaclass: "PartUsage",
    owner: 1,
  },
  {
    id: "g",
    name: "g",
    qualifiedName: "Demo::system::g",
    metaclass: "PartUsage",
    owner: 1,
  },
  {
    id: "flag",
    name: "flag",
    qualifiedName: "Demo::system::flag",
    metaclass: "AttributeUsage",
    owner: 1,
  },
  {
    id: "eng",
    name: "engine",
    qualifiedName: "Demo::system::engine",
    metaclass: "PartUsage",
    owner: 1,
  },
];

const TYPINGS: Record<string, string[]> = {
  s: ["System"],
  ab: ["Plain"],
  ef: [],
  g: ["Plain"],
  flag: ["Boolean"],
};

function graphFor(options: Record<string, unknown>) {
  if (options.element === "Demo::broken") throw new Error("cannot project");
  if (options.view === "interconnection") {
    return {
      nodes: [
        { id: "s", kind: "part", label: "system : System", rows: [] },
        { id: "ab", kind: "part", label: "a : b : Plain", rows: [] },
        { id: "ef", kind: "part", label: "e : f", rows: [] },
        { id: "anon", kind: "part", label: ": Plain", rows: [] },
        { id: "g", kind: "part", label: "g : Plain [2]", rows: [] },
        {
          id: "flag",
          kind: "attribute",
          label: "flag : Boolean = true",
          rows: [],
        },
        { id: "eng", kind: "part", label: "engine", rows: [] },
        { id: "uuid~initial", kind: "part", label: "initial", rows: [] },
      ],
      edges: [],
    };
  }
  if (options.view === "action") {
    return {
      nodes: [{ id: "a", kind: "action", label: "Run", rows: [] }],
      edges: [{ id: "e1", kind: "succession", source: "a", target: "a" }],
    };
  }
  if (options.view === "state") {
    return {
      nodes: [{ id: "t", kind: "state", label: "Life", rows: [] }],
      edges: [{ id: "e1", kind: "transition", source: "t", target: "t" }],
    };
  }
  // tree: package root or declared roots
  return {
    nodes: [
      { id: "p", kind: "package", label: "Demo", rows: [] },
      { id: "s", kind: "part", label: "system : System", rows: [] },
    ],
    edges: [],
  };
}

function fixture(opts: {
  truncated?: boolean;
  graph?: typeof graphFor;
  graphTrapElement?: string;
  exposed?: Array<{ qualifiedName: string }>;
} = {}) {
  const freed: string[] = [];
  const makeElement = (key: string) => ({
    key,
    free() {
      freed.push(key);
    },
  });
  const session = {
    free() {},
    check: () => "[]",
    query: () => "[]",
    resolve: () => undefined,
    elementById: (id: string) =>
      id in TYPINGS || id === "p" || id === "a" || id === "t" ||
        id === "v" || id === "eng"
        ? makeElement(id)
        : undefined,
    name: (element: { key: string }) =>
      element.key.startsWith("type:") ? element.key.slice(5) : element.key,
    qualifiedName: (element: { key: string }) =>
      element.key.startsWith("type:")
        ? `Demo::${element.key.slice(5)}`
        : element.key,
    elementId: () => "id",
    referenceSpelling: () => undefined,
    metaclass: () => "Package",
    isLibraryElement: () => false,
    owner: () => undefined,
    typings: (element: { key: string }) =>
      (TYPINGS[element.key] ?? []).map((type) => makeElement(`type:${type}`)),
    rows: () => "[]",
    memberSource: () => "",
    memberExtent: () => undefined,
    references: () => "[]",
    units: () => "[]",
    checkEdit: () => "{}",
    edit: () => "{}",
    outline: () =>
      JSON.stringify({
        shape: { nodes: NODES, truncated: opts.truncated ?? false },
      }),
    toGraph: (options?: string | null) => {
      const parsed = JSON.parse(options ?? "{}") as Record<string, unknown>;
      if (opts.graphTrapElement && parsed.element === opts.graphTrapElement) {
        throw new NativeToolkitPanicError("candidate graph unreachable");
      }
      return JSON.stringify((opts.graph ?? graphFor)(parsed));
    },
    viewInfo: () =>
      JSON.stringify({
        exposed: opts.exposed ?? [
          { qualifiedName: "Demo" },
          { qualifiedName: "Demo" },
        ],
      }),
  } as unknown as ToolkitSession;
  return { session, freed };
}

Deno.test("view list enumerates groups, splits name/typeName and omits unprojectable views with a coded diagnostic", () => {
  const { session } = fixture();
  const { summaries, diagnostics } = projectToolkitViewList(session);
  assert.deepEqual(
    summaries.map((s) => s.id),
    [
      "structure:Demo::system",
      "behavior:Demo::Run",
      "state:Demo::Life",
      "declared:Demo::Overview",
      "definitions:Demo",
    ],
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "VIEW_UNPROJECTABLE");
  assert.equal(diagnostics[0].severity, "warning");
  assert.equal(diagnostics[0].context.element, "Demo::broken");

  const diagram = projectToolkitViewDiagram(fixture().session, summaries[0]);
  assert.equal(diagram.nodes[0].name, "system");
  assert.equal(diagram.nodes[0].typeName, "System");
  assert.equal("label" in diagram.nodes[0], false);
});

Deno.test("node names come from outline shape and types from typings, never from splitting the label", () => {
  const { session, freed } = fixture();
  const { summaries } = projectToolkitViewList(session);
  const diagram = projectToolkitViewDiagram(session, summaries[0]);
  const byId = new Map(diagram.nodes.map((node) => [node.id, node]));
  // `part 'a : b' : Plain;` — quoted name containing the separator.
  assert.equal(byId.get("ab")?.name, "a : b");
  assert.equal(byId.get("ab")?.typeName, "Plain");
  // `part 'e : f';` — quoted name, no typing: no fabricated type.
  assert.equal(byId.get("ef")?.name, "e : f");
  assert.equal(byId.get("ef")?.typeName, undefined);
  // `part : Plain;` — anonymous: no shape entry, raw label, no type.
  assert.equal(byId.get("anon")?.name, ": Plain");
  assert.equal(byId.get("anon")?.typeName, undefined);
  // `part g : Plain [2];` — multiplicity is not part of the type name.
  assert.equal(byId.get("g")?.name, "g");
  assert.equal(byId.get("g")?.typeName, "Plain");
  // Attribute with a default value: type carries no `= value`.
  assert.equal(byId.get("flag")?.name, "flag");
  assert.equal(byId.get("flag")?.typeName, "Boolean");
  // Unresolved pseudo-node: raw label, no fabricated type.
  assert.equal(byId.get("uuid~initial")?.name, "initial");
  assert.equal(byId.get("uuid~initial")?.typeName, undefined);
  for (const node of diagram.nodes) {
    assert.ok(!node.typeName?.includes("="), node.id);
    assert.ok(!node.typeName?.includes("["), node.id);
  }
  // Every acquired element (node elements and their typings) was freed.
  assert.ok(freed.includes("s"), "node element freed");
  assert.ok(freed.includes("type:System"), "typing element freed");
  assert.ok(freed.includes("type:Plain"), "typing element freed");
});

Deno.test("a native panic from one candidate graph rethrows instead of omitting the view", () => {
  const { session } = fixture({ graphTrapElement: "Demo::system" });
  assert.throws(
    () => projectToolkitViewList(session),
    (error: unknown) => error instanceof NativeToolkitPanicError,
  );
});

Deno.test("a declared view exposing nothing is omitted with a VIEW_EMPTY warning", () => {
  const { session } = fixture({ exposed: [] });
  const { summaries, diagnostics } = projectToolkitViewList(session);
  assert.equal(
    summaries.some((s) => s.group === "declared"),
    false,
  );
  const empty = diagnostics.find((d) => d.code === "VIEW_EMPTY");
  assert.ok(empty, "VIEW_EMPTY diagnostic present");
  assert.equal(empty.severity, "warning");
  assert.equal(empty.context.element, "Demo::Overview");
});

Deno.test("view list returns action graphs as-is without supplemented decision edges", () => {
  const { session } = fixture();
  const { summaries } = projectToolkitViewList(session);
  const behavior = summaries.find((s) => s.group === "behavior")!;
  const diagram = projectToolkitViewDiagram(fixture().session, behavior);
  assert.equal(diagram.edges.length, 1);
  assert.equal("supplemented" in diagram.edges[0], false);
  // Served edges are exactly the raw toGraph edges (deep equality).
  assert.deepEqual(diagram.edges, [{
    id: "e1",
    kind: "succession",
    source: "a",
    target: "a",
  }]);
});

Deno.test("view projector refuses a session without the view API and reports truncation", () => {
  const { session: bare } = fixture();
  delete (bare as unknown as Record<string, unknown>).toGraph;
  assert.throws(
    () => projectToolkitViewList(bare),
    (error: unknown) =>
      error instanceof ToolkitViewApiUnavailableError &&
      error.code === "TOOLKIT_VIEW_API_UNAVAILABLE" &&
      error.context.missing.includes("toGraph"),
  );
  const { diagnostics } = projectToolkitViewList(
    fixture({ truncated: true }).session,
  );
  assert.ok(
    diagnostics.some((d) =>
      d.code === "SHAPE_TRUNCATED" && d.severity === "error"
    ),
  );
});

Deno.test("PlantUML selects the same standard elements and declared roots as graphs", () => {
  const { session } = fixture();
  const { summaries } = projectToolkitViewList(session);
  const options: unknown[] = [];
  session.toPlantuml = (value) => {
    options.push(JSON.parse(value!));
    return "@startuml\n@enduml";
  };
  session.toGraph = () => {
    throw new Error("export must not project a graph");
  };
  for (const view of summaries) {
    assert.match(projectToolkitViewPlantuml(session, view), /^@startuml/);
    assert.deepEqual(
      options.at(-1),
      view.group === "declared"
        ? { view: "tree", roots: ["Demo"] }
        : { view: view.kind, element: view.element },
    );
  }
  const declared = summaries.find((view) => view.group === "declared")!;
  session.viewInfo = () => JSON.stringify({ exposed: [] });
  const count = options.length;
  assert.throws(
    () => projectToolkitViewPlantuml(session, declared),
    /exposes no elements/,
  );
  assert.equal(options.length, count);
  delete session.toPlantuml;
  assert.throws(
    () => projectToolkitViewPlantuml(session, summaries[0]),
    (error: unknown) =>
      error instanceof ToolkitViewApiUnavailableError &&
      error.context.missing.includes("toPlantuml"),
  );
});

Deno.test("synthetic inherited ports resolve semantic names through native qname and keep graph identity", () => {
  const id = "usage-id~port-id";
  const qname = "Demo::Builder::proposals";
  const raw = {
    id,
    qname,
    kind: "port",
    label: "proposals : CandidatePort",
    parent: "usage-id",
    rows: [],
  };
  const { session } = fixture({ graph: () => ({ nodes: [raw], edges: [] }) });
  const resolvedNames: string[] = [];
  const released: string[] = [];
  session.resolve = (name) => {
    resolvedNames.push(name);
    return name === qname
      ? {
        key: "proposals",
        free() {
          released.push("port");
        },
      }
      : undefined;
  };
  session.typings = () => [{
    key: "type:CandidatePort",
    free() {
      released.push("type");
    },
  }];
  const projected = projectToolkitViewDiagram(session, {
    id: "structure:Demo::system",
    title: "system",
    group: "structure",
    kind: "interconnection",
    element: "Demo::system",
    nodes: 1,
    edges: 0,
  });
  assert.deepEqual(projected.nodes[0], {
    id,
    qname,
    kind: "port",
    name: "proposals",
    typeName: "CandidatePort",
    parent: "usage-id",
    rows: [],
  });
  assert.deepEqual(resolvedNames, [qname]);
  assert.deepEqual(released, ["type", "port"]);
});

Deno.test("overlapping declared roots deduplicate identical native nodes in list and diagram counts", () => {
  const { session } = fixture({
    exposed: [{ qualifiedName: "Demo" }, { qualifiedName: "Demo::system" }],
    graph: (options) => {
      const graph = graphFor(options);
      return "roots" in options
        ? { ...graph, nodes: [...graph.nodes, structuredClone(graph.nodes[1])] }
        : graph;
    },
  });
  const { summaries } = projectToolkitViewList(session);
  const summary = summaries.find((view) => view.group === "declared")!;
  assert.ok(summary);
  assert.equal(summary.nodes, 2);
  const diagram = projectToolkitViewDiagram(session, summary);
  assert.deepEqual(diagram.nodes.map((node) => node.id), ["p", "s"]);
  assert.equal(diagram.nodes.length, summary.nodes);
});

Deno.test("overlapping roots with conflicting node metadata fail instead of silently overwriting", () => {
  const { session } = fixture({
    graph: (options) => {
      const graph = graphFor(options);
      return "roots" in options
        ? {
          ...graph,
          nodes: [...graph.nodes, {
            ...graph.nodes[1],
            file: "conflict.sysml",
          }],
        }
        : graph;
    },
  });
  const { summaries, diagnostics } = projectToolkitViewList(session);
  assert.ok(!summaries.some((view) => view.group === "declared"));
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.code === "VIEW_UNPROJECTABLE" &&
      diagnostic.context.group === "declared" &&
      diagnostic.context.message.includes("node s with conflicting metadata")
    ),
  );
  assert.throws(() =>
    projectToolkitViewDiagram(session, {
      id: "declared:Demo::Overview",
      title: "Overview",
      group: "declared",
      kind: "tree",
      element: "Demo::Overview",
      nodes: 2,
      edges: 0,
    }), (error: unknown) =>
    error instanceof Error && "code" in error &&
    error.code === "TOOLKIT_VIEW_NODE_CONFLICT");
});
