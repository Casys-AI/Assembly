import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { WeightedLruCache } from "./weighted-lru.ts";

Deno.test("weighted LRU evicts least recently used entries by bytes", () => {
  const cache = new WeightedLruCache<string>({ maxBytes: 10 });
  equal(cache.set("a", "12345", 5), true);
  equal(cache.set("b", "1234", 4), true);
  equal(cache.get("a"), "12345"); // refresh a; b is now oldest
  equal(cache.set("c", "123456", 6), true); // evicts b (4), still over: evicts nothing else? 5+6>10
  equal(cache.has("b"), false);
  // 5 (a) + 6 (c) = 11 > 10, so a must also go for c to fit.
  equal(cache.has("a"), false);
  equal(cache.get("c"), "123456");
  deepStrictEqual(cache.stats(), { entries: 1, bytes: 6, maxBytes: 10 });
});

Deno.test("weighted LRU refresh order decides the victim", () => {
  const cache = new WeightedLruCache<string>({ maxBytes: 9 });
  cache.set("a", "v", 4);
  cache.set("b", "v", 4);
  cache.get("a");
  cache.set("c", "v", 4); // evicts b only
  deepStrictEqual(cache.keys(), ["a", "c"]);
  equal(cache.peek("b"), undefined);
  // peek does not refresh: a stays oldest.
  cache.peek("a");
  cache.set("d", "v", 4);
  deepStrictEqual(cache.keys(), ["c", "d"]);
});

Deno.test("weighted LRU refuses an oversize entry without emptying itself", () => {
  const cache = new WeightedLruCache<string>({ maxBytes: 4 });
  cache.set("a", "v", 4);
  equal(cache.set("big", "v", 5), false);
  equal(cache.get("a"), "v");
  equal(cache.has("big"), false);
  deepStrictEqual(cache.stats(), { entries: 1, bytes: 4, maxBytes: 4 });
});

Deno.test("weighted LRU reweights on replace and weighs bytes by default", () => {
  const cache = new WeightedLruCache<Uint8Array>({ maxBytes: 6 });
  cache.set("a", new Uint8Array(6));
  cache.set("a", new Uint8Array(2));
  deepStrictEqual(cache.stats(), { entries: 1, bytes: 2, maxBytes: 6 });
  cache.set("b", new Uint8Array(4));
  deepStrictEqual(cache.stats().bytes, 6);
  equal(cache.delete("a"), true);
  equal(cache.delete("a"), false);
  cache.clear();
  deepStrictEqual(cache.stats(), { entries: 0, bytes: 0, maxBytes: 6 });
});

Deno.test("weighted LRU validates capacity and weights", () => {
  throws(() => new WeightedLruCache({ maxBytes: 0 }), RangeError);
  const cache = new WeightedLruCache<string>({ maxBytes: 4 });
  throws(() => cache.set("a", "v", -1), RangeError);
  throws(() => cache.set("a", "v", 1.5), RangeError);
});

Deno.test("empty values and explicit zero weights consume capacity", () => {
  const cache = new WeightedLruCache<Uint8Array>({ maxBytes: 4 });
  for (let i = 0; i < 20; i++) {
    cache.set(String(i), new Uint8Array(), i % 2 ? 0 : undefined);
  }
  deepStrictEqual(cache.stats(), { entries: 4, bytes: 4, maxBytes: 4 });
  deepStrictEqual(cache.keys(), ["16", "17", "18", "19"]);
  cache.set("19", new Uint8Array(), 0);
  equal(cache.stats().bytes, 4);
});

Deno.test("LRU entry limit independently bounds metadata for small values", () => {
  const cache = new WeightedLruCache<string>({ maxBytes: 100, maxEntries: 2 });
  cache.set("a", "", 1);
  cache.set("b", "", 1);
  cache.get("a");
  cache.set("c", "", 1);
  deepStrictEqual(cache.keys(), ["a", "c"]);
  equal(cache.stats().bytes, 2);
  throws(
    () => new WeightedLruCache({ maxBytes: 10, maxEntries: 0 }),
    RangeError,
  );
  const defaults = new WeightedLruCache<Uint8Array>({ maxBytes: 1_000_000 });
  for (let i = 0; i <= 10_000; i++) defaults.set(String(i), new Uint8Array());
  equal(defaults.stats().entries, 10_000);
});
