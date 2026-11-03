import { equal, rejects } from "node:assert/strict";
import { tagMutationBudget } from "./tag-mutation-budget.ts";

Deno.test("tag mutation budget includes transaction acquisition and guard time before allowing native work", async () => {
  let time = 0, calls = 0;
  const run = tagMutationBudget(() => time);
  time = 10_000;
  await rejects(() =>
    run(() => {
      calls++;
      return Promise.resolve();
    }), /unavailable/);
  equal(calls, 0);
});

Deno.test("tag mutation budget rejects exhausted completion margin after native settlement", async () => {
  let time = 0, settled = false;
  const run = tagMutationBudget(() => time);
  await rejects(() =>
    run((signal) => {
      equal(signal.aborted, false);
      time = 12_000;
      settled = true;
      return Promise.resolve();
    }), /unavailable/);
  equal(settled, true);
});

Deno.test("tag mutation cancellation waits for the operation to settle rather than racing authority release", async () => {
  let settled = false;
  const run = tagMutationBudget();
  await rejects(() =>
    run((signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          queueMicrotask(() => {
            settled = true;
            resolve();
          });
        }, { once: true });
      })
    ), /unavailable/);
  equal(settled, true);
});
