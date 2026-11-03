import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { localSources, runSourceCommand } from "./command.ts";
import { canActOnRead } from "../../conversations/proposals.ts";

Deno.test("an Evolution change is in flight for everyone and advances the generation before any reread", async () => {
  const sources = localSources();
  const seen: string[] = [];
  await runSourceCommand(sources, {
    operation: () => {
      seen.push(`operation in flight=${sources.inFlight.value}`);
      return Promise.resolve();
    },
    reread: () => {
      seen.push(`reread generation=${sources.generation.value}`);
      return Promise.resolve();
    },
    changed: () => {
      seen.push("changed");
    },
  });
  deepStrictEqual(seen, [
    "operation in flight=true",
    "reread generation=1",
    "changed",
  ]);
  equal(sources.inFlight.value, false);
});

Deno.test("a refused Evolution change advances nothing and settles", async () => {
  const sources = localSources();
  await rejects(
    runSourceCommand(sources, {
      operation: () => Promise.reject(new Error("409")),
      reread: () => Promise.resolve(),
      changed: () => {},
    }),
  );
  equal(sources.generation.value, 0);
  equal(sources.inFlight.value, false);
});

Deno.test("every panel acts only on a settled, error-free read of the current generation", () => {
  const read = {
    canWrite: true,
    pending: false,
    generation: 3,
    readGeneration: 3,
    loading: false,
    error: "",
  };
  equal(canActOnRead(read), true);
  equal(canActOnRead({ ...read, readGeneration: 2 }), false);
  equal(canActOnRead({ ...read, readGeneration: null }), false);
  equal(canActOnRead({ ...read, loading: true }), false);
  equal(canActOnRead({ ...read, error: "Relecture impossible" }), false);
  equal(canActOnRead({ ...read, pending: true }), false);
  equal(canActOnRead({ ...read, canWrite: false }), false);
});
