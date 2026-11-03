import { equal, rejects } from "node:assert/strict";
import { replaceGlobals, withGlobals } from "./globals.ts";
import { settle } from "./settle.ts";

Deno.test("withGlobals puts back what it replaced and removes what was not there, even when the work fails", async () => {
  const realFetch = globalThis.fetch;
  const stub = (() => Promise.resolve(new Response("stub"))) as typeof fetch;
  const seen = await withGlobals({ fetch: stub, assemblyProbe: 1 }, () => {
    equal(globalThis.fetch, stub);
    return Reflect.get(globalThis, "assemblyProbe");
  });
  equal(seen, 1);
  equal(globalThis.fetch, realFetch);
  equal("assemblyProbe" in globalThis, false);
  await rejects(
    withGlobals({ fetch: stub }, () => Promise.reject(new Error("boom"))),
    /boom/,
  );
  equal(globalThis.fetch, realFetch);
});

Deno.test("replaceGlobals hands back the restore for a fixture to call", () => {
  const restore = replaceGlobals({ assemblyProbe: "x" });
  equal(Reflect.get(globalThis, "assemblyProbe"), "x");
  restore();
  equal("assemblyProbe" in globalThis, false);
});

Deno.test("settle lets chained promises and zero-delay timers finish", async () => {
  let done = false;
  Promise.resolve().then(() => new Promise((resolve) => setTimeout(resolve, 0)))
    .then(() => Promise.resolve()).then(() => done = true);
  await settle(3);
  equal(done, true);
});
