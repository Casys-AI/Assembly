import { deepStrictEqual, equal, notEqual, ok } from "node:assert/strict";
import {
  digestProjection,
  graphReadSnapshot,
  projectionChanges,
  recordNativeProjection,
} from "./read-snapshot.ts";

const native = () => ({
  nodes: [{ id: "agent", label: "Constructeur" }],
  edges: [],
  sequences: [{ id: "scenario", messages: [] }],
});

Deno.test("journal-only changes retain the native identity and signal activity separately", async () => {
  const graph = native();
  const first = await graphReadSnapshot(graph, [{ id: "m1", text: "Bonjour" }]);
  const second = await graphReadSnapshot(graph, [
    { id: "m1", text: "Bonjour" },
    {
      id: "m2",
      text: "Réponse",
    },
  ]);
  equal(first.projectionDigest, second.projectionDigest);
  equal(first.version, second.version);
  notEqual(first.activityDigest, second.activityDigest);
  deepStrictEqual(projectionChanges(first, second), {
    model: false,
    activity: true,
  });
  deepStrictEqual(projectionChanges(first, first), {
    model: false,
    activity: false,
  });
  deepStrictEqual(projectionChanges(first, first, true), {
    model: true,
    activity: false,
  });
});

Deno.test("new stored projections contain no journal even if their input was enriched", async () => {
  const source = {
    ...native(),
    executionSequences: [{ id: "old-message", text: "Private conversation" }],
  };
  const before = structuredClone(source);
  const observations = [{
    id: "current-message",
    text: "Current conversation",
  }];
  const result = await graphReadSnapshot(source, observations);
  deepStrictEqual(source, before);
  deepStrictEqual(result.nativeGraph, native());
  ok(!Object.hasOwn(result.nativeGraph, "executionSequences"));
  equal(result.projectionDigest, await digestProjection(result.nativeGraph));
  equal(result.projectionDigestScope, "native");
  deepStrictEqual(result.graph.executionSequences, observations);
  observations[0].text = "Mutated after read";
  equal(result.graph.executionSequences[0].text, "Current conversation");
  result.graph.nodes[0].label = "Mutated read view";
  equal(source.nodes[0].label, "Constructeur");
  equal(result.nativeGraph.nodes[0].label, "Constructeur");
});

Deno.test("new persistence writes only the native graph, while an existing legacy revision is never rewritten", async () => {
  const snapshot = await graphReadSnapshot(native(), [{
    id: "private-message",
  }]);
  const writes: Array<{ revision: number; graph: unknown; digest: string }> =
    [];
  const store = {
    loadProjection(revision: number) {
      return Promise.resolve(
        revision === 8 ? { digest: "recorded-legacy" } : null,
      );
    },
    recordProjection(revision: number, graph: unknown, digest: string) {
      writes.push({ revision, graph, digest });
      return Promise.resolve();
    },
  };
  await recordNativeProjection(store, 7, snapshot);
  await recordNativeProjection(store, 8, snapshot);
  equal(writes.length, 1);
  equal(writes[0].revision, 7);
  deepStrictEqual(writes[0].graph, native());
  equal(writes[0].digest, snapshot.projectionDigest);
  ok(!JSON.stringify(writes).includes("private-message"));
});

Deno.test("model changes still change native identity independently of activity", async () => {
  const graph = native();
  const before = await graphReadSnapshot(graph, []);
  graph.nodes[0].label = "Agent renommé par une révision";
  const after = await graphReadSnapshot(graph, []);
  notEqual(before.projectionDigest, after.projectionDigest);
  equal(before.activityDigest, after.activityDigest);
  deepStrictEqual(projectionChanges(before, after), {
    model: true,
    activity: false,
  });
});

Deno.test("historical enrichment preserves the exact recorded digest and its native graph", async () => {
  const graph = native();
  const recordedDigest = await digestProjection(graph);
  const result = await graphReadSnapshot(
    graph,
    [{ id: "historical-message" }],
    recordedDigest,
  );
  equal(result.projectionDigest, recordedDigest);
  equal(result.version, recordedDigest.slice(0, 20));
  equal(result.projectionDigestScope, "native");
  deepStrictEqual(graph, native());
  ok(!Object.hasOwn(graph, "executionSequences"));
});

Deno.test("legacy history keeps its stored mixed digest and declares its scope without rewriting it", async () => {
  const graph = {
    ...native(),
    executionSequences: [{ id: "old", text: "Old capture" }],
  };
  const recordedDigest = await digestProjection(graph);
  const before = structuredClone(graph);
  const result = await graphReadSnapshot(
    graph,
    [{ id: "reconstructed" }],
    recordedDigest,
  );
  equal(result.projectionDigest, recordedDigest);
  equal(result.projectionDigestScope, "legacy-with-activity");
  deepStrictEqual(graph, before);
  deepStrictEqual(result.graph.executionSequences, [{ id: "reconstructed" }]);
  ok(!Object.hasOwn(result.nativeGraph, "executionSequences"));
  notEqual(result.projectionDigest, await digestProjection(result.nativeGraph));
});
