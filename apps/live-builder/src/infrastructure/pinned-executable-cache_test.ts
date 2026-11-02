import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { PinnedExecutableCache } from "./pinned-executable-cache.ts";

Deno.test("pinned executable cache isolates results, verifies every caller and evicts failed loads", async () => {
  const cache = new PinnedExecutableCache<{ owner: string; data: number[] }>(2);
  let loads = 0;
  const load = () => {
    loads++;
    return Promise.resolve({ owner: "one", data: [1] });
  };
  const verify = (value: { owner: string }) => {
    if (value.owner !== "one") throw new Error("foreign identity");
  };
  const first = await cache.read("one", load, verify);
  first.data.push(2);
  deepStrictEqual((await cache.read("one", load, verify)).data, [1]);
  equal(loads, 1);
  await rejects(() =>
    cache.read("one", load, () => {
      throw new Error("foreign identity");
    }), /foreign identity/);
  equal(loads, 1);
  let attempts = 0;
  const retry = () => {
    attempts++;
    return attempts === 1 ? Promise.reject(new Error("load failed")) : load();
  };
  await rejects(() => cache.read("two", retry, verify), /load failed/);
  await cache.read("two", retry, verify);
  equal(attempts, 2);
  await cache.read("three", load, verify);
  await cache.read("one", load, verify);
  equal(loads, 4);
});

Deno.test("pinned executable cache retains at most sixteen immutable pins", async () => {
  const cache = new PinnedExecutableCache<number>(16);
  let loads = 0;
  const load = () => Promise.resolve(++loads);
  for (let pin = 0; pin < 16; pin++) {
    await cache.read(String(pin), load, () => {});
  }
  equal(await cache.read("0", load, () => {}), 1);
  await cache.read("16", load, () => {});
  equal(await cache.read("0", load, () => {}), 18);
});
