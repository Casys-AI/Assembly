import { equal } from "node:assert/strict";
import { createSequenceInteractionGuard } from "./interaction.ts";

Deno.test("programmatic resize frames cannot take control and stale callbacks cannot clear a newer guard", () => {
  const callbacks = new Map<number, () => void>();
  const allCallbacks = new Map<number, () => void>();
  let next = 0, suppressed = false, userCount = 0;
  const guard = createSequenceInteractionGuard(
    (callback) => {
      callbacks.set(++next, callback);
      allCallbacks.set(next, callback);
      return next;
    },
    (id) => callbacks.delete(id),
    (value) => suppressed = value,
    () => userCount++,
  );
  guard.programmatic();
  equal(suppressed, true);
  guard.programmatic();
  equal(callbacks.size, 1);
  allCallbacks.get(1)!();
  equal(suppressed, true);
  const latest = callbacks.get(2)!;
  callbacks.delete(2);
  latest();
  equal(suppressed, false);
  equal(userCount, 0);
  guard.programmatic();
  guard.user();
  equal(suppressed, false);
  equal(userCount, 1);
  allCallbacks.get(3)!();
  equal(userCount, 1);
  guard.programmatic();
  guard.dispose();
  equal(suppressed, false);
  equal(callbacks.size, 0);
  allCallbacks.get(4)!();
  guard.programmatic();
  guard.user();
  equal(userCount, 1);
});
