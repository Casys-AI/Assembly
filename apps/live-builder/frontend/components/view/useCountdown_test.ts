import { equal, ok } from "node:assert/strict";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { useCountdown } from "./useCountdown.ts";

const TICK = 5;
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for what a countdown will reach, as long as a busy machine needs. */
async function until(reached: () => boolean) {
  for (let waited = 0; !reached() && waited < 2000; waited += TICK) {
    await later(TICK);
  }
  ok(reached(), "the countdown did not get there");
}

Deno.test("the wait counts down by the second to none, and stays there", async () => {
  const probe = probeRoot();
  const seen: number[] = [];
  function Probe(props: { seconds?: number; since: object }) {
    const left = useCountdown(props.seconds, props.since, TICK);
    if (seen.at(-1) !== left) seen.push(left);
    return null;
  }
  try {
    const failure = {};
    await probe.show(Probe, { seconds: 3, since: failure });
    equal(seen.at(-1), 3);
    await until(() => seen.at(-1) === 0);
    // It only goes down, from the seconds asked to none, and stops there.
    equal(seen[0], 3);
    ok(seen.every((value, at) => at === 0 || value < seen[at - 1]), `${seen}`);
    await later(TICK * 4);
    equal(seen.at(-1), 0);
  } finally {
    await probe.restore();
  }
});

Deno.test("a new failure starts the wait again, even for the same number of seconds; no wait is no countdown", async () => {
  const probe = probeRoot();
  let left = -1;
  function Probe(props: { seconds?: number; since: object }) {
    left = useCountdown(props.seconds, props.since, TICK);
    return null;
  }
  try {
    await probe.show(Probe, { seconds: 1, since: {} });
    await until(() => left === 0);
    await probe.show(Probe, { seconds: 1, since: {} });
    equal(left, 1, "restarted by the next failure");
    await probe.show(Probe, { seconds: 1, since: {} });
    // Not waiting for anything: nothing to count.
    await probe.show(Probe, { seconds: undefined, since: {} });
    equal(left, 0);
    await probe.show(Probe, { seconds: 0, since: {} });
    equal(left, 0);
  } finally {
    await probe.restore();
  }
});

Deno.test("a countdown that is unmounted stops counting", async () => {
  const probe = probeRoot();
  let renders = 0;
  function Probe() {
    useCountdown(50, "x", TICK);
    renders++;
    return null;
  }
  await probe.show(Probe, {});
  await until(() => renders > 2);
  await probe.unmount();
  const stopped = renders;
  await later(TICK * 6);
  equal(renders, stopped);
  await probe.restore();
});
