import assert from "node:assert/strict";
import { createModelViewsHandler } from "./model-views-http.ts";
import type {
  ModelView,
} from "../domain/model-views.ts";

const view: ModelView = {
  id: "structure:Demo::system",
  title: "system",
  kind: "interconnection",
  group: "structure",
  element: "Demo::system",
  nodes: 1,
  edges: 0,
  diagram: {
    nodes: [{ id: "n1", kind: "block", label: "system : System", rows: [] }],
    edges: [],
  },
};

function setup(options: { fail?: Error; missing?: string } = {}) {
  const calls: Record<string, string>[] = [];
  const handler = createModelViewsHandler(
    {
      current: () =>
        Promise.resolve({ version: "commit:aaa", sources: { "a.sysml": "a" } }),
      at: (version) => {
        if (version === options.missing) {
          return Promise.reject(
            Object.assign(new Error("missing"), { code: "NOT_FOUND" }),
          );
        }
        return Promise.resolve({ version, sources: { "b.sysml": "b" } });
      },
    },
    {
      views: (sources) => {
        calls.push(sources);
        return options.fail ? Promise.reject(options.fail) : Promise.resolve(
          { toolkit: "0.10.10", views: [view], problems: [] },
        );
      },
    },
  );
  const get = async (path: string, method = "GET") => {
    const response = await handler(
      new Request(`http://localhost${path}`, { method }),
    );
    return response && { status: response.status, body: await response.json() };
  };
  return { get, calls };
}

Deno.test("model views list summaries of the current admitted revision", async () => {
  const { get, calls } = setup();
  const result = await get("/api/model-views");
  assert.equal(result?.status, 200);
  assert.equal(result?.body.version, "commit:aaa");
  assert.deepEqual(result?.body.views, [{
    id: view.id,
    title: "system",
    kind: "interconnection",
    group: "structure",
    element: "Demo::system",
    nodes: 1,
    edges: 0,
  }]);
  assert.deepEqual(result?.body.problems, []);
  assert.deepEqual(calls, [{ "a.sysml": "a" }]);
});

Deno.test("model views serve one diagram and project each commit once", async () => {
  const { get, calls } = setup();
  const path = `/api/model-views/diagram?view=${
    encodeURIComponent(view.id)
  }&modelVersion=commit:bbb`;
  const first = await get(path);
  const second = await get(path);
  assert.equal(first?.status, 200);
  assert.deepEqual(first?.body.view.diagram, view.diagram);
  assert.equal(second?.body.version, "commit:bbb");
  assert.equal(calls.length, 1);
});

Deno.test("model views reject malformed requests with machine-readable errors", async () => {
  const { get } = setup();
  assert.equal(await get("/api/model-graph"), null);
  const cases: [string, string, number, string][] = [
    ["/api/model-views", "POST", 405, "METHOD_NOT_ALLOWED"],
    ["/api/model-views?revision=1", "GET", 400, "INVALID_REQUEST"],
    ["/api/model-views?modelVersion=main", "GET", 400, "INVALID_REQUEST"],
    ["/api/model-views/diagram", "GET", 400, "INVALID_REQUEST"],
    ["/api/model-views/diagram?view=nope", "GET", 404, "VIEW_NOT_FOUND"],
  ];
  for (const [path, method, status, code] of cases) {
    const result = await get(path, method);
    assert.equal(result?.status, status, path);
    assert.equal(result?.body.code, code, path);
    assert.equal(typeof result?.body.recovery, "string", path);
  }
});

Deno.test("model views report a missing version distinctly from a projection failure", async () => {
  const missing = setup({ missing: "commit:gone" });
  const gone = await missing.get("/api/model-views?modelVersion=commit:gone");
  assert.equal(gone?.status, 404);
  assert.equal(gone?.body.code, "VERSION_NOT_FOUND");

  const broken = setup({ fail: new Error("trap") });
  const first = await broken.get("/api/model-views");
  assert.equal(first?.status, 503);
  assert.equal(first?.body.code, "VIEWS_UNAVAILABLE");
  assert.equal(first?.body.recovery, "retry");
  await broken.get("/api/model-views");
  // A failed projection is not cached: the retry reaches the Toolkit again.
  assert.equal(broken.calls.length, 2);
});

