import type { OperatorStorage } from "./host-storage.ts";
import assert from "node:assert/strict";
import { PostgresScopedSoftwareAdoptionTransition } from "./scoped-software-adoption-transition.ts";
import type { ScopedSoftwareAdoptionPort } from "../../../application/model/evolution/ports.ts";

type Input = Parameters<
  ScopedSoftwareAdoptionPort<OperatorStorage>["adopt"]
>[0];
type Receipt = Awaited<
  ReturnType<ScopedSoftwareAdoptionPort<OperatorStorage>["adopt"]>
>;
type Options = ConstructorParameters<
  typeof PostgresScopedSoftwareAdoptionTransition
>[0];

Deno.test("software adoption holds the repository lock through commit and releases it before restore", async () => {
  let locked = false;
  const events: string[] = [];
  const expected = { committed: true } as unknown as Receipt;
  const opening = { id: "opening" };
  const input = {
    dossier: { id: "dossier" },
    runtime: { opening },
  } as unknown as Input;
  const transition = new PostgresScopedSoftwareAdoptionTransition({
    async withRepositoryLock<T>(operation: () => Promise<T>): Promise<T> {
      assert.equal(locked, false);
      locked = true;
      events.push("lock");
      try {
        return await operation();
      } finally {
        locked = false;
        events.push("unlock");
      }
    },
    restore(value: Input["runtime"]["opening"]) {
      assert.equal(locked, false);
      assert.equal(value, opening);
      events.push("restore");
      return Promise.resolve();
    },
    failed() {
      throw new Error("unexpected refresh failure");
    },
  } as unknown as Options);
  // Isolate the lock boundary; the PG integration witness exercises the real
  // transaction and authority checks rather than duplicating them here.
  Object.defineProperty(transition, "adoptLocked", {
    value: () => {
      assert.equal(locked, true);
      events.push("commit");
      return Promise.resolve(expected);
    },
  });
  assert.equal(await transition.adopt(input), expected);
  assert.deepEqual(events, ["lock", "commit", "unlock", "restore"]);
});
