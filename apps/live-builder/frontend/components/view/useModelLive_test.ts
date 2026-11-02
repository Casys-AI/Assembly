import { deepStrictEqual, equal } from "node:assert/strict";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import type { ModelFollower, ModelLive } from "../../lib/model/live.ts";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { modelFeed } from "../../test/support/model-feed.ts";
import { useModelLive } from "./useModelLive.ts";

const HEAD = `commit:${"a".repeat(40)}`;
const NEXT = `commit:${"b".repeat(40)}`;

/** A component that follows the model through Preact's real hooks. */
async function withProbe(
  run: (probe: {
    show(read: ModelFollower, live: ModelLive): Promise<void>;
    hide(): Promise<void>;
    redraw(): Promise<void>;
  }) => Promise<void>,
) {
  const root = probeRoot();
  let redraw: () => void = () => {};
  function Probe(props: { read: ModelFollower; live: ModelLive }) {
    const [, setPass] = useState(0);
    redraw = () => setPass((pass) => pass + 1);
    useModelLive(props.read, props.live);
    return null;
  }
  try {
    await run({
      show: (read, live) => root.show(Probe, { read, live }),
      hide: root.unmount,
      redraw: () => act(() => redraw()),
    });
  } finally {
    await root.restore();
  }
}

Deno.test("a component follows the model from when it mounts to when it goes, however often it is drawn", async () => {
  const { live, tell } = modelFeed();
  const heads: string[] = [];
  const read: ModelFollower = (head) => {
    heads.push(head.version);
  };
  await withProbe(async ({ show, hide, redraw }) => {
    await show(read, live);
    await redraw();
    await show(read, live);
    tell(HEAD);
    tell(NEXT);
    deepStrictEqual(
      heads,
      [HEAD, NEXT],
      "told once, however often it is drawn",
    );
    await hide();
    tell(HEAD);
    equal(heads.length, 2, "a component that is gone is told nothing");
  });
});

Deno.test("the shell hands a new function at every pass: the latest is the one called, and it does not follow again", async () => {
  const { live, tell } = modelFeed();
  const calls: string[] = [];
  await withProbe(async ({ show }) => {
    await show(() => calls.push("first"), live);
    await show(() => calls.push("second"), live);
    await show(() => calls.push("third"), live);
    tell(HEAD);
    deepStrictEqual(calls, ["third"]);
  });
});
