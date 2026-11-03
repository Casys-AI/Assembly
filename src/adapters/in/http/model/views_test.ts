import assert from "node:assert/strict";
import {
  ModelViewDiagramService,
  ModelViewListService,
  ModelViewPlantumlService,
} from "../../../../application/model/projections/views.ts";
import type {
  ModelViewDiagramDocument,
  ModelViewList,
  ModelViewSummary,
} from "../../../../domain/model/records/diagram-views.ts";
import { createModelViewsHandler } from "./views.ts";

const VERSION = `commit:${"b".repeat(40)}`;
const MISSING = `commit:${"c".repeat(40)}`;

function summary(id: string): ModelViewSummary {
  const [group, element] = id.split(":");
  return {
    id,
    title: element,
    kind: "interconnection",
    group: group as ModelViewSummary["group"],
    element,
    nodes: 2,
    edges: 0,
  };
}

const SUMMARIES = [
  summary("structure:Demo::system"),
  summary("definitions:Demo"),
];

function document(view: ModelViewSummary): ModelViewDiagramDocument {
  return {
    toolkit: "0.10.10",
    digest: "d".repeat(64),
    view: {
      ...view,
      diagram: {
        nodes: [
          { id: "n1", kind: "part", name: "system", rows: [] },
          { id: "n2", kind: "part", name: "engine", rows: [] },
        ],
        edges: [],
      },
    },
  };
}

function setup(
  options: { fail?: unknown } = {},
) {
  const calls = { list: 0, diagram: 0, plantuml: 0 };
  const lists = new ModelViewListService({
    list(version: string): Promise<ModelViewList> {
      calls.list++;
      if (version === MISSING) {
        return Promise.reject({
          code: "MODEL_VERSION_NOT_FOUND",
          context: { version },
          recovery: "Read an admitted commit.",
        });
      }
      if (options.fail) return Promise.reject(options.fail);
      return Promise.resolve({
        toolkit: "0.10.10",
        views: SUMMARIES,
        diagnostics: [],
        digest: "a".repeat(64),
      });
    },
  });
  const diagrams = new ModelViewDiagramService({
    diagram(
      version: string,
      viewId: string,
    ): Promise<ModelViewDiagramDocument> {
      calls.diagram++;
      const found = SUMMARIES.find((view) => view.id === viewId);
      if (!found) {
        return Promise.reject({
          code: "VIEW_NOT_FOUND",
          context: { version, view: viewId },
          recovery:
            "Re-read GET /api/model/views?version=<commit> and choose an existing view id.",
        });
      }
      return Promise.resolve(document(found));
    },
  });
  const handle = createModelViewsHandler({
    list: lists,
    diagram: diagrams,
    plantuml: new ModelViewPlantumlService({
      plantuml(version, viewId) {
        calls.plantuml++;
        if (options.fail) return Promise.reject(options.fail);
        if (!SUMMARIES.some((view) => view.id === viewId)) {
          return Promise.reject({
            code: "VIEW_NOT_FOUND",
            context: { version, view: viewId },
            recovery: "Choose a known view.",
          });
        }
        return Promise.resolve({
          text: "@startuml\nclass Café\n@enduml\n",
          digest: "e".repeat(64),
        });
      },
    }),
    head: () => Promise.resolve(VERSION),
  });
  const get = (
    path: string,
    init?: { method?: string; headers?: Record<string, string> },
  ) =>
    handle(
      new Request(`http://atelier.test${path}`, {
        method: init?.method ?? "GET",
        headers: init?.headers,
      }),
    );
  return { calls, get };
}

const listPath = (version: string) =>
  `/api/model/views?version=${encodeURIComponent(version)}`;
const diagramPath = (version: string, view: string) =>
  `/api/model/views/diagram?version=${encodeURIComponent(version)}&view=${
    encodeURIComponent(view)
  }`;

Deno.test("views route serves one diagram per view and caches it", async () => {
  const { calls, get } = setup();
  for (const id of SUMMARIES.map((view) => view.id)) {
    const response = await get(diagramPath(VERSION, id));
    assert.equal(response?.status, 200, id);
    const body = await response?.json();
    assert.equal(body.view.id, id);
    assert.ok(Array.isArray(body.view.diagram.nodes));
    assert.ok(Array.isArray(body.view.diagram.edges));
    assert.equal(body.view.nodes, body.view.diagram.nodes.length);
    assert.equal(body.view.edges, body.view.diagram.edges.length);
  }
  assert.equal(calls.diagram, 2);
  await get(diagramPath(VERSION, SUMMARIES[0].id));
  assert.equal(calls.diagram, 2);
});

Deno.test("diagram route answers ETag, immutable caching and 304", async () => {
  const { get } = setup();
  const first = await get(diagramPath(VERSION, SUMMARIES[0].id));
  assert.equal(first?.status, 200);
  const etag = first?.headers.get("etag");
  assert.ok(etag, "diagram ETag present");
  assert.match(
    first?.headers.get("cache-control") ?? "",
    /immutable/,
  );
  const cached = await get(diagramPath(VERSION, SUMMARIES[0].id), {
    headers: { "if-none-match": etag! },
  });
  assert.equal(cached?.status, 304);
  assert.equal(await cached?.text(), "");
});

Deno.test("diagram route rejects missing, empty and extra parameters and other methods", async () => {
  const { calls, get } = setup();
  for (
    const path of [
      `/api/model/views/diagram?version=${VERSION}`,
      `/api/model/views/diagram?view=${encodeURIComponent(SUMMARIES[0].id)}`,
      `/api/model/views/diagram?version=${VERSION}&view=`,
      `/api/model/views/diagram?view=${
        encodeURIComponent(SUMMARIES[0].id)
      }&version=${VERSION}&extra=1`,
      `/api/model/views/diagram?version=commit:abc&view=v`,
    ]
  ) {
    const response = await get(path);
    assert.equal(response?.status, 400, path);
    const body = await response?.json();
    assert.ok(body.code.startsWith("INVALID_"), path);
    assert.ok(body.context && typeof body.context === "object", path);
    assert.ok(typeof body.recovery === "string", path);
    assert.equal(response?.headers.get("cache-control"), "no-store", path);
  }
  const post = await get(diagramPath(VERSION, SUMMARIES[0].id), {
    method: "POST",
  });
  assert.equal(post?.status, 405);
  assert.equal(post?.headers.get("allow"), "GET");
  assert.equal(await get("/api/model/views/other"), null);
  assert.deepEqual(calls, { list: 0, diagram: 0, plantuml: 0 });
});

Deno.test("views route reports an unknown view id distinctly from a missing version", async () => {
  const { get } = setup();
  const unknown = await get(diagramPath(VERSION, "structure:Demo::nope"));
  assert.equal(unknown?.status, 404);
  assert.deepEqual(await unknown?.json(), {
    code: "VIEW_NOT_FOUND",
    context: { version: VERSION, view: "structure:Demo::nope" },
    recovery:
      "Re-read GET /api/model/views?version=<commit> and choose an existing view id.",
  });
  const gone = await get(listPath(MISSING));
  assert.equal(gone?.status, 404);
  assert.equal((await gone?.json()).code, "MODEL_VERSION_NOT_FOUND");
});

const plantumlPath = (version = VERSION, view = SUMMARIES[0].id) =>
  `/api/model/views/plantuml?${new URLSearchParams({ version, view })}`;

Deno.test("PlantUML is plain text, conditional and immutable, and never generated by other routes", async () => {
  const { calls, get } = setup();
  await get(listPath(VERSION));
  await get(diagramPath(VERSION, SUMMARIES[0].id));
  assert.equal(calls.plantuml, 0);
  const first = await get(plantumlPath());
  assert.equal(first?.status, 200);
  assert.equal(first?.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(first?.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    first?.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(await first?.text(), "@startuml\nclass Café\n@enduml\n");
  const etag = first!.headers.get("etag")!;
  for (const condition of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
    const cached = await get(plantumlPath(), {
      headers: { "if-none-match": condition },
    });
    assert.equal(cached?.status, 304);
    assert.equal(await cached?.text(), "");
  }
  assert.equal(calls.plantuml, 1);
});

Deno.test("PlantUML validates strict parameters and method before exporting", async () => {
  const { calls, get } = setup();
  for (
    const query of [
      "",
      "?version=" + VERSION,
      "?view=v",
      `?version=${VERSION}&view=`,
      `?version=${VERSION}&view=v&view=other`,
      `?version=${VERSION}&view=v&extra=1`,
      "?version=main&view=v",
      "?version=commit:abc&view=v",
    ]
  ) {
    const response = await get("/api/model/views/plantuml" + query);
    assert.equal(response?.status, 400, query);
    assert.equal(response?.headers.get("cache-control"), "no-store");
    assert.ok((await response?.json()).code.startsWith("INVALID_"));
  }
  const post = await get(plantumlPath(), { method: "POST" });
  assert.equal(post?.status, 405);
  assert.equal(post?.headers.get("allow"), "GET");
  assert.equal(calls.plantuml, 0);
  const unknown = await get(plantumlPath(VERSION, "unknown"));
  assert.equal(unknown?.status, 404);
  assert.equal((await unknown?.json()).code, "VIEW_NOT_FOUND");
});

Deno.test("PlantUML failures preserve coded JSON errors and retry semantics", async () => {
  const { calls, get } = setup({
    fail: {
      code: "TOOLKIT_TIMEOUT",
      context: { retryAfterMs: 1500 },
      recovery: "Retry later.",
    },
  });
  const response = await get(plantumlPath());
  assert.equal(response?.status, 502);
  assert.equal(response?.headers.get("retry-after"), "2");
  assert.equal(response?.headers.get("cache-control"), "no-store");
  assert.match(response!.headers.get("content-type")!, /application\/json/);
  assert.equal((await response?.json()).code, "TOOLKIT_TIMEOUT");
  await get(plantumlPath());
  assert.equal(calls.plantuml, 2);
});
