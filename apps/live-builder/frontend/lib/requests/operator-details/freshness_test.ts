import { equal } from "node:assert/strict";
import { watchRequestOperatorDetailsFreshness } from "./freshness.ts";

Deno.test("Request detail freshness shares visible fifteen-second checks without starving slow reads", () => {
  const callbacks: Record<string, () => void> = {}, stops: string[] = [];
  let visible = true, pending = false, reads = 0;
  const stop = watchRequestOperatorDetailsFreshness(
    () => {
      reads++;
      pending = true;
    },
    () => pending,
    {
      visible: () => visible,
      interval(callback, ms) {
        equal(ms, 15_000);
        callbacks.interval = callback;
        return () => {
          stops.push("interval");
        };
      },
      focus(callback) {
        callbacks.focus = callback;
        return () => {
          stops.push("focus");
        };
      },
      visibility(callback) {
        callbacks.visibility = callback;
        return () => {
          stops.push("visibility");
        };
      },
    },
  );
  callbacks.interval();
  equal(reads, 1);
  callbacks.focus();
  callbacks.interval();
  callbacks.visibility();
  equal(reads, 1);
  pending = false;
  visible = false;
  callbacks.interval();
  callbacks.focus();
  equal(reads, 1);
  visible = true;
  callbacks.visibility();
  equal(reads, 2);
  stop();
  pending = false;
  callbacks.interval();
  callbacks.focus();
  equal(reads, 2);
  equal(stops.sort().join(), "focus,interval,visibility");
});
