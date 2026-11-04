import assert from "node:assert/strict";
import { createFrontendDispatcher, loadFreshFrontend } from "./frontend.ts";

Deno.test("Fresh dispatch owns only application views and its assets, keeping API and graph handlers separate", async () => {
  const calls: string[] = [];
  const dispatch = createFrontendDispatcher({
    fetch(request) {
      calls.push(new URL(request.url).pathname);
      return new Response("ui", {
        headers: { "cache-control": "public, max-age=31536000" },
      });
    },
  });
  for (
    const path of [
      "/",
      "/chat",
      "/tools",
      "/system",
      "/model",
      "/revisions?commit=branch:x",
      "/decide",
      "/activity",
    ]
  ) {
    const response = await dispatch(new Request(`http://localhost${path}`));
    assert.equal(await response?.text(), "ui");
    assert.equal(response?.headers.get("cache-control"), "no-store");
  }
  const asset = await dispatch(
    new Request("http://localhost/assets/client-entry.js"),
  );
  assert.equal(asset?.headers.get("cache-control"), "public, max-age=31536000");
  for (
    const path of [
      "/api/state",
      "/api/decisions",
      "/api/model-revisions",
      "/api/events",
      "/state",
      "/events",
      "/graph?revision=1",
      "/refunds",
      "/health",
      "/vendor/cytoscape.min.js",
    ]
  ) {
    assert.equal(await dispatch(new Request(`http://localhost${path}`)), null);
  }
  assert.equal(calls.length, 9);
});

Deno.test("Fresh loader imports only the compiled handler", async () => {
  const imports: string[] = [];
  const dispatch = await loadFreshFrontend({
    entry: new URL("file:///build/_fresh/server.js"),
    importModule(url) {
      imports.push(url);
      return Promise.resolve({
        default: { fetch: () => new Response("compiled") },
      });
    },
  });
  assert.deepEqual(imports, ["file:///build/_fresh/server.js"]);
  assert.equal(
    await (await dispatch(new Request("http://localhost/")))?.text(),
    "compiled",
  );
});

Deno.test("a missing or invalid Fresh build fails before backend initialization", async () => {
  await assert.rejects(
    () =>
      loadFreshFrontend({
        importModule: () => Promise.reject(new Error("missing")),
      }),
    /deno task ui:build/,
  );
  await assert.rejects(
    () => loadFreshFrontend({ importModule: () => Promise.resolve({}) }),
    /does not export a request handler/,
  );
});
