import assert from "node:assert/strict";
import {
  ModelViewDiagramService,
  ModelViewListService,
} from "../../src/application/model/projections/views.ts";
import type { ModelViewSummary } from "../../src/domain/model/records/diagram-views.ts";
import {
  ToolkitModelViewDiagramReader,
  ToolkitModelViewListReader,
} from "../../src/adapters/model/projections/views/readers.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { loadSysmlToolkit } from "../../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

const VERSION = `commit:${"b".repeat(40)}`;
const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");

function repository(sources: Record<string, string>) {
  return {
    at(version: string) {
      return Promise.resolve({
        version,
        sources,
        elements: [],
        documents: [],
        sourceDigest: "repository digest",
        semanticDigest: "semantic digest",
        provenanceDigest: "provenance digest",
        sourceHashes: {},
        engineVersion: "test",
      });
    },
  };
}

function checkDiagramCoherence(
  view: {
    id: string;
    nodes: number;
    edges: number;
    diagram: {
      nodes: Array<{ id: string }>;
      edges: Array<{ source: string; target: string }>;
    };
  },
) {
  assert.equal(view.nodes, view.diagram.nodes.length, `${view.id}: nodes`);
  assert.equal(view.edges, view.diagram.edges.length, `${view.id}: edges`);
  const nodes = new Set(view.diagram.nodes.map((node) => node.id));
  for (const edge of view.diagram.edges) {
    assert.ok(nodes.has(edge.source), `${view.id}: ${edge.source}`);
    assert.ok(nodes.has(edge.target), `${view.id}: ${edge.target}`);
  }
}

function groupCounts(views: ModelViewSummary[]) {
  const counts: Record<string, number> = {
    structure: 0,
    behavior: 0,
    state: 0,
    declared: 0,
    definitions: 0,
  };
  for (const view of views) counts[view.group]++;
  return counts;
}

async function listFor(sources: Record<string, string>) {
  const tooling = new SysmlToolkitAdapter({ packageDir: packageDir! });
  const lists = new ModelViewListService(
    new ToolkitModelViewListReader(repository(sources), tooling),
  );
  const value = await lists.read(VERSION);
  return { tooling, value };
}

Deno.test({
  name:
    "real Toolkit views list the initial system with definitions trees above one node",
  ignore: !toolkitIntegrationEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { tooling, value } = await listFor(await loadInitialSources());
    // Measured on the real Toolkit (B6): a whole group disappearing fails.
    assert.deepEqual(groupCounts(value.views), {
      structure: 1,
      behavior: 3,
      state: 1,
      declared: 5,
      definitions: 19,
    });
    assert.equal(value.views.length, 29);
    assert.deepEqual(value.diagnostics, []);
    const ids = value.views.map((view) => view.id);
    assert.equal(new Set(ids).size, ids.length);
    const definitions = value.views.filter((view) =>
      view.group === "definitions"
    );
    assert.ok(
      definitions.every((view) => view.nodes > 1),
      "definitions trees keep nodes > 1",
    );
    const diagrams = new ModelViewDiagramService(
      new ToolkitModelViewDiagramReader(
        repository(await loadInitialSources()),
        tooling,
        { read: (_version: string) => Promise.resolve(value) },
      ),
    );
    const allNodes = [];
    for (const summary of value.views) {
      const document = await diagrams.read(VERSION, summary.id);
      checkDiagramCoherence(document.view);
      allNodes.push(...document.view.diagram.nodes);
    }
    // Declared names from the outline shape: no multiplicity suffix, and a
    // type name never carries a default value.
    assert.ok(
      allNodes.some((node) => node.name === "envelopingItem"),
      "envelopingItem is named without its [1] multiplicity",
    );
    assert.ok(
      allNodes.some((node) => node.name === "inter"),
      "inter is named without its [1] multiplicity",
    );
    assert.ok(
      allNodes.every((node) =>
        node.name !== "envelopingItem [1]" && node.name !== "inter [1]"
      ),
      "no node keeps a multiplicity suffix in its name",
    );
    for (const node of allNodes) {
      assert.ok(!node.typeName?.includes("="), node.id);
    }
  },
});

Deno.test({
  name:
    "real Toolkit views list the commercial-watch example with one graph per view",
  ignore: !toolkitIntegrationEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sources = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../fixtures/commercial-watch/sources.json",
          import.meta.url,
        ),
      ),
    ) as Record<string, string>;
    const { tooling, value } = await listFor(sources);
    assert.deepEqual(groupCounts(value.views), {
      structure: 3,
      behavior: 3,
      state: 1,
      declared: 2,
      definitions: 14,
    });
    assert.equal(value.views.length, 23);
    assert.deepEqual(value.diagnostics, []);
    assert.ok(
      value.views.filter((view) => view.group === "definitions").every(
        (view) => view.nodes > 1,
      ),
      "definitions trees keep nodes > 1",
    );
    const diagrams = new ModelViewDiagramService(
      new ToolkitModelViewDiagramReader(
        repository(sources),
        tooling,
        { read: (_version: string) => Promise.resolve(value) },
      ),
    );
    for (const summary of value.views) {
      const document = await diagrams.read(VERSION, summary.id);
      checkDiagramCoherence(document.view);
    }
  },
});

Deno.test({
  name: "real Toolkit action graphs carry no reconstructed decision guards",
  ignore: !toolkitIntegrationEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sources = await loadInitialSources();
    const { tooling, value } = await listFor(sources);
    const behaviors = value.views.filter((view) => view.group === "behavior");
    assert.ok(behaviors.length > 0, "expected behavior views to compare");
    // Name-independent lock: served edges must equal the raw `toGraph`
    // edges exactly. Renaming a reconstructed-guard field, or moving the
    // reconstruction into another module, still fails this comparison.
    const runtime = await loadSysmlToolkit(packageDir!);
    const encoded = JSON.stringify(
      Object.entries(sources).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([name, text]) => ({ name, text })),
    );
    const session = runtime.createSession(encoded);
    try {
      // One representative action view: every behavior diagram travels the
      // same projection path, and the raw session load is the costly part.
      for (const summary of behaviors.slice(0, 1)) {
        const raw = JSON.parse(
          session.toGraph!(
            JSON.stringify({ view: "action", element: summary.element }),
          ),
        ) as { edges: unknown[] };
        const view = await tooling.diagram(sources, summary);
        assert.deepEqual(
          view.diagram.edges,
          raw.edges,
          `${summary.id}: served edges equal raw toGraph edges`,
        );
      }
    } finally {
      session.free();
    }
  },
});

Deno.test({
  name:
    "repeated view reads keep projection call counts constant on one version (compteurs constants, pas une mesure mémoire)",
  ignore: !toolkitIntegrationEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sources = await loadInitialSources();
    const tooling = new SysmlToolkitAdapter({ packageDir: packageDir! });
    let listCalls = 0;
    let diagramCalls = 0;
    const lists = new ModelViewListService(
      new ToolkitModelViewListReader(repository(sources), {
        views(input) {
          listCalls++;
          return tooling.views(input);
        },
      }),
    );
    for (let i = 0; i < 10; i++) await lists.read(VERSION);
    assert.equal(listCalls, 1);
    const value = await lists.read(VERSION);
    assert.ok(value.views.length > 0);
    const head: ModelViewSummary[] = value.views.slice(0, 3);
    const diagrams = new ModelViewDiagramService(
      new ToolkitModelViewDiagramReader(repository(sources), {
        diagram(input, view) {
          diagramCalls++;
          return tooling.diagram(input, view);
        },
      }, lists),
    );
    for (const summary of head) {
      for (let i = 0; i < 5; i++) await diagrams.read(VERSION, summary.id);
    }
    assert.equal(diagramCalls, head.length);
    assert.equal(listCalls, 1);
  },
});

Deno.test("view projector sources never reconstruct guards with a regular expression", async () => {
  // Every B6 view module is scanned, including any future
  // `views-*.ts` a reconstruction could be moved into; the semantic
  // raw-edge comparison above is the name-independent lock.
  const targets: URL[] = [
    new URL("../../src/domain/model/records/diagram-views.ts", import.meta.url),
    new URL(
      "../../src/application/model/projections/views.ts",
      import.meta.url,
    ),
    new URL(
      "../../src/adapters/in/http/model/views.ts",
      import.meta.url,
    ),
    new URL(
      "../../src/adapters/model/projections/views/readers.ts",
      import.meta.url,
    ),
  ];
  for await (
    const entry of Deno.readDir(
      new URL(
        "../../src/adapters/out/sysml-toolkit/projections/",
        import.meta.url,
      ),
    )
  ) {
    if (
      entry.isFile &&
      (entry.name === "views.ts" || entry.name.startsWith("views-")) &&
      entry.name.endsWith(".ts") && !entry.name.endsWith("_test.ts")
    ) {
      targets.push(
        new URL(
          `../../src/adapters/out/sysml-toolkit/projections/${entry.name}`,
          import.meta.url,
        ),
      );
    }
  }
  assert.ok(
    targets.some((url) =>
      url.pathname.endsWith("/sysml-toolkit/projections/views.ts")
    ),
    "projector itself is scanned",
  );
  for (const target of targets) {
    const source = await Deno.readTextFile(target);
    for (
      const forbidden of [
        "RegExp",
        "decisionBranches",
        ".exec(",
        "memberExtent",
        "supplemented",
      ]
    ) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${target.pathname}: ${forbidden}`,
      );
    }
  }
});

Deno.test("diagram reads report an unknown view id with a coded error", async () => {
  const sources = { "empty.sysml": "package Empty;\n" };
  const reader = new ToolkitModelViewDiagramReader(
    repository(sources),
    {
      diagram() {
        throw new Error("must not open a session for an unknown view");
      },
    },
    {
      read: (_version: string) =>
        Promise.resolve({
          toolkit: "t",
          views: [],
          diagnostics: [],
          digest: "0".repeat(64),
        }),
    },
  );
  await assert.rejects(
    () => reader.diagram(VERSION, "structure:Empty::nope"),
    (error: unknown) => {
      const failure = error as {
        code: string;
        context: unknown;
        recovery: string;
      };
      assert.equal(failure.code, "VIEW_NOT_FOUND");
      assert.deepEqual(failure.context, {
        version: VERSION,
        view: "structure:Empty::nope",
      });
      assert.ok(typeof failure.recovery === "string");
      return true;
    },
  );
});

Deno.test({
  name:
    "real Toolkit PlantUML exports each view group through the isolated worker",
  ignore: !toolkitIntegrationEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const models = [
      await loadInitialSources(),
      JSON.parse(
        await Deno.readTextFile(
          new URL(
            "../fixtures/commercial-watch/sources.json",
            import.meta.url,
          ),
        ),
      ) as Record<string, string>,
    ];
    for (const sources of models) {
      const { tooling, value } = await listFor(sources);
      for (
        const group of [
          "structure",
          "behavior",
          "state",
          "declared",
          "definitions",
        ] as const
      ) {
        const summary = value.views.find((view) => view.group === group)!;
        assert.ok(summary, group);
        const exported = await tooling.plantuml(sources, summary);
        assert.match(exported, /^@startuml/, summary.id);
        assert.match(exported, /@enduml/, summary.id);
      }
    }
  },
});

Deno.test({
  name:
    "real Toolkit PlantUML keeps definition and declared exports inside their selected roots",
  ignore: !toolkitIntegrationEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sources = {
      "scoped.sysml": `
      package Selected { part def ExportedMarker; }
      package Unrelated { part def ExcludedMarker; }
      package ExportViews { view SelectedView { expose Selected::*; } }
    `,
    };
    const { tooling, value } = await listFor(sources);
    for (
      const id of ["definitions:Selected", "declared:ExportViews::SelectedView"]
    ) {
      const summary = value.views.find((view) => view.id === id)!;
      assert.ok(summary, id);
      const exported = await tooling.plantuml(sources, summary);
      assert.ok(exported.includes("ExportedMarker"), id);
      assert.ok(!exported.includes("ExcludedMarker"), id);
    }
  },
});
