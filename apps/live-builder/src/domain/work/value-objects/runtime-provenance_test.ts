import { deepStrictEqual, equal, notEqual } from "node:assert/strict";
import { executionDigest, sha256 } from "../../primitives/execution-digest.ts";
import {
  type RuntimeProvenance,
  runtimeProvenanceRecord,
  unknownRuntimeProvenance,
} from "./runtime-provenance.ts";

function fixture(): RuntimeProvenance {
  return {
    schemaVersion: 1,
    ase: { commit: "a".repeat(40), dirty: false },
    deno: "2.9.7",
    toolkit: { version: "0.10.10", digest: "b".repeat(64) },
    agents: {
      provider: "claude",
      model: "claude-configured-model",
      effort: "high",
      decisionMaxTokens: 8192,
    },
  };
}

Deno.test("runtime provenance has a canonical SHA-256 independent of key insertion order", async () => {
  const value = fixture();
  const reordered: RuntimeProvenance = {
    agents: {
      model: value.agents.model,
      provider: value.agents.provider,
      decisionMaxTokens: 8192,
      effort: "high",
    },
    toolkit: { digest: value.toolkit.digest, version: value.toolkit.version },
    deno: value.deno,
    ase: { dirty: false, commit: value.ase.commit },
    schemaVersion: 1,
  };
  const record = await runtimeProvenanceRecord(value);
  deepStrictEqual(await runtimeProvenanceRecord(reordered), record);
  equal(
    record.digest,
    "3a3118c1da73433d0bee2d33f4a94a1b3c294daf5baade20977b7a18dc6ea300",
  );
  value.ase.commit = "mutated-after-recording";
  equal(record.provenance.ase.commit, "a".repeat(40));
});

Deno.test("every deployment identity field contributes to runtime provenance", async () => {
  const original = await runtimeProvenanceRecord(fixture());
  const changes: Array<(value: RuntimeProvenance) => void> = [
    (value) => value.ase.commit = "c".repeat(40),
    (value) => value.ase.dirty = true,
    (value) => value.deno = "2.9.8",
    (value) => value.toolkit.version = "0.10.11",
    (value) => value.toolkit.digest = "d".repeat(64),
    (value) => value.agents.provider = "muse",
    (value) => value.agents.model = "another-exact-model",
    (value) => value.agents.effort = "medium",
    (value) => value.agents.decisionMaxTokens = 4096,
  ];
  for (const change of changes) {
    const value = fixture();
    change(value);
    notEqual((await runtimeProvenanceRecord(value)).digest, original.digest);
  }
});

Deno.test("provenance completeness and its reasons are digested without changing historical records", async () => {
  const legacy = await runtimeProvenanceRecord(fixture());
  equal(legacy.provenance.complete, undefined);
  equal(legacy.provenance.incompleteReasons, undefined);
  const complete = await runtimeProvenanceRecord({
    ...fixture(),
    complete: true,
    incompleteReasons: [],
  });
  const value: RuntimeProvenance = {
    ...fixture(),
    complete: false,
    incompleteReasons: ["agent-model-unresolved"],
  };
  const incomplete = await runtimeProvenanceRecord(value);
  notEqual(legacy.digest, complete.digest);
  notEqual(complete.digest, incomplete.digest);
  notEqual(
    incomplete.digest,
    (await runtimeProvenanceRecord({ ...value, complete: true })).digest,
  );
  notEqual(
    incomplete.digest,
    (await runtimeProvenanceRecord({ ...value, incompleteReasons: [] })).digest,
  );
  value.incompleteReasons!.length = 0;
  deepStrictEqual(incomplete.provenance.incompleteReasons, [
    "agent-model-unresolved",
  ]);
});

Deno.test("provenance records project only public fields and represent missing data explicitly", async () => {
  const clean = fixture();
  const contaminated = {
    ...clean,
    apiKey: "must-not-be-recorded",
    agents: { ...clean.agents, apiKey: "also-secret" },
    ase: { ...clean.ase, environment: { TOKEN: "secret" } },
  };
  deepStrictEqual(
    await runtimeProvenanceRecord(contaminated),
    await runtimeProvenanceRecord(clean),
  );
  const unknown = await runtimeProvenanceRecord(unknownRuntimeProvenance());
  equal(unknown.provenance.ase.commit, "unknown");
  equal(unknown.provenance.ase.dirty, "unknown");
  equal(unknown.provenance.agents.model, "unknown");
});

Deno.test("shared SHA-256 preserves the historical execution digest encoding", async () => {
  equal(
    await sha256("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  equal(
    await executionDigest({ b: null, a: [3, { z: 1, y: 2 }] }),
    "575a97ede5a52786c1385ddd58d8da6d14bf7c1271dbf64f129e52d4f36a3c23",
  );
});
