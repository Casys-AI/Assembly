import assert from "node:assert/strict";
import { createModelGraphHandler, type ModelGraphSnapshot } from "./graph.ts";

function fixture() {
  const calls: Array<string | number> = [];
  const current: ModelGraphSnapshot = {
    graph: { nodes: [], edges: [] },
    version: "current",
    projectionDigest: "c".repeat(64),
    error: null,
    history: null,
  };
  const handler = createModelGraphHandler({
    current: () => {
      calls.push("current");
      return current;
    },
    source(version) {
      calls.push(version);
      return Promise.resolve({
        ...current,
        version: "source",
        history: { modelVersion: version },
      });
    },
    recorded(revision) {
      calls.push(revision);
      return Promise.resolve(
        revision === 3
          ? { ...current, history: { revision, recordedAt: "recorded" } }
          : null,
      );
    },
  });
  const get = (path: string, method = "GET") =>
    handler(new Request(`http://atelier.test${path}`, { method }));
  return { calls, get, current };
}

Deno.test("graph reads distinguish current, immutable source and recorded application revision", async () => {
  const { calls, get, current } = fixture();
  const present = await get("/api/model-graph");
  assert.equal(present?.headers.get("cache-control"), "no-store");
  assert.deepEqual(await present?.json(), current);
  const source = await get("/api/model-graph?modelVersion=commit%3Aabc_123");
  assert.deepEqual((await source?.json()).history, {
    modelVersion: "commit:abc_123",
  });
  const recorded = await get("/api/model-graph?revision=3");
  assert.deepEqual((await recorded?.json()).history, {
    revision: 3,
    recordedAt: "recorded",
  });
  assert.equal((await get("/api/model-graph?revision=4"))?.status, 404);
  assert.deepEqual(calls, ["current", "commit:abc_123", 3, 4]);
});

Deno.test("ambiguous and malformed graph selections fail before reading any model", async () => {
  const { get, calls } = fixture();
  for (
    const query of [
      "revision=1&modelVersion=branch:a",
      "revision=1&revision=2",
      "modelVersion=commit:a&modelVersion=commit:b",
      "unknown=1",
      "revision=",
      "revision=01",
      "revision=-1",
      "revision=1.5",
      "revision=9007199254740992",
      "modelVersion=",
      "modelVersion=branch:../../other",
      "modelVersion=abc",
    ]
  ) assert.equal((await get(`/api/model-graph?${query}`))?.status, 400, query);
  assert.deepEqual(calls, []);
});

Deno.test("graph adapter owns no UI routes or write operations", async () => {
  const { get, calls } = fixture();
  assert.equal(await get("/model"), null);
  assert.equal(await get("/api/model-events"), null);
  const response = await get("/api/model-graph", "POST");
  assert.equal(response?.status, 405);
  assert.equal(response?.headers.get("allow"), "GET");
  assert.deepEqual(calls, []);
});
