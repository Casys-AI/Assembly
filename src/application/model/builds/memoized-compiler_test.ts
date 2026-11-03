// deno-lint-ignore-file require-await -- Port doubles reply in memory.
import assert from "node:assert/strict";
import type { CompiledModel } from "../../../domain/model/records/compiled-model.ts";
import type { ModelSources as Sources } from "../../../domain/model/value-objects/sources.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import { MemoizedModelCompiler } from "./memoized-compiler.ts";

const hex = (char: string) => char.repeat(64);
const recipe = {
  toolkit: { version: "1.0.0", bundleDigest: hex("b") },
  format: "full-json-v1",
  normalizerVersion: 1,
  irVersion: "1",
  artifactSchema: 1,
  engineVersion: "engine-1",
};

function counting() {
  const calls = { compile: 0, recipe: 0 };
  let failures = 0;
  return {
    calls,
    failNext() {
      failures++;
    },
    async compile(sources: Sources): Promise<CompiledModel> {
      calls.compile++;
      if (failures > 0) {
        failures--;
        throw new Error("compiler unavailable");
      }
      return {
        sources: structuredClone(sources),
        elements: [{ "@id": "el-1", "@type": "PartUsage" }],
        documents: [],
        sourceDigest: await modelSourceDigest(sources),
        semanticDigest: hex("c"),
        provenanceDigest: hex("d"),
        sourceHashes: {},
        engineVersion: "engine-1",
      };
    },
    async recipe() {
      calls.recipe++;
      return structuredClone(recipe);
    },
  };
}

Deno.test("one real compilation per exact (S, R); hits are isolated copies", async () => {
  const inner = counting();
  const memo = new MemoizedModelCompiler(inner);
  const sources = { "core.sysml": "package Sys;" };
  const first = await memo.compile(sources);
  first.elements.push({ "@id": "mutated", "@type": "PartUsage" });
  const second = await memo.compile({ ...sources });
  assert.equal(inner.calls.compile, 1);
  assert.equal(second.elements.length, 1);
  assert.equal(memo.stats().compilations, 1);
  assert.equal(memo.stats().hits, 1);

  await memo.compile({ "core.sysml": "package Other;" });
  assert.equal(inner.calls.compile, 2);
  // The recipe is pinned: read once however many compilations follow.
  assert.equal(inner.calls.recipe, 1);
});

Deno.test("concurrent compilations of one candidate coalesce; failures are not pinned", async () => {
  const inner = counting();
  const memo = new MemoizedModelCompiler(inner);
  const sources = { "core.sysml": "package Sys;" };
  const [left, right] = await Promise.all([
    memo.compile(sources),
    memo.compile(sources),
  ]);
  assert.equal(inner.calls.compile, 1);
  assert.deepStrictEqual(left, right);

  memo.clear();
  inner.failNext();
  await assert.rejects(() => memo.compile(sources), /unavailable/);
  await memo.compile(sources);
  assert.equal(memo.stats().entries, 1);
});

Deno.test("the pin is bounded by entries with LRU eviction", async () => {
  const inner = counting();
  const memo = new MemoizedModelCompiler(inner, { maxEntries: 2 });
  await memo.compile({ "a.sysml": "package A;" });
  await memo.compile({ "b.sysml": "package B;" });
  await memo.compile({ "c.sysml": "package C;" });
  assert.equal(memo.stats().entries, 2);
  await memo.compile({ "a.sysml": "package A;" });
  assert.equal(inner.calls.compile, 4);
});
