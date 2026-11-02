import { equal } from "node:assert/strict";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import type { ModelLive } from "../../lib/model/live.ts";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { modelFeed } from "../../test/support/model-feed.ts";
import { useRefreshOnOpen } from "./useRefreshOnOpen.ts";

/** Preact's real hooks through a probe that draws nothing (no DOM needed). */
async function withProbe(
  run: (probe: {
    show(refresh: () => void, live?: ModelLive): Promise<void>;
    hide(): Promise<void>;
    redraw(): Promise<void>;
  }) => Promise<void>,
) {
  const root = probeRoot();
  let redraw: () => void = () => {};
  function Probe({ refresh, live }: { refresh: () => void; live?: ModelLive }) {
    const [, setPass] = useState(0);
    redraw = () => setPass((pass) => pass + 1);
    useRefreshOnOpen(refresh, live);
    return null;
  }
  try {
    await run({
      show: (refresh, live) => root.show(Probe, { refresh, live }),
      hide: root.unmount,
      redraw: () => act(() => redraw()),
    });
  } finally {
    await root.restore();
  }
}

Deno.test("opening the place reads once, however often the page is drawn or handed a new function", async () => {
  let reads = 0;
  await withProbe(async ({ show, redraw }) => {
    await show(() => reads++);
    equal(reads, 1);
    // A read changes what the page draws, and the shell hands a new closure at
    // every pass: neither may read again.
    await redraw();
    await show(() => reads++);
    await show(() => reads++);
    await redraw();
    equal(reads, 1);
  });
});

Deno.test("closing the place and opening it again reads again", async () => {
  const reads: string[] = [];
  await withProbe(async ({ show, hide }) => {
    await show(() => reads.push("first"));
    await hide();
    equal(reads.length, 1);
    await show(() => reads.push("second"));
    // The read that runs is the one the opening was given.
    equal(reads.join(), "first,second");
  });
});

Deno.test("the host's word that the model moved reads the decisions again: a proposal made, an adoption, the head advanced", async () => {
  const { live, tell } = modelFeed();
  const HEAD = `commit:${"a".repeat(40)}`;
  const reads: string[] = [];
  await withProbe(async ({ show, redraw, hide }) => {
    await show(() => reads.push("read"), live);
    equal(reads.length, 1, "opening");
    tell(HEAD);
    equal(reads.length, 2, "the host says where it stands");
    tell(HEAD);
    equal(reads.length, 2, "the same word is not news");
    tell(HEAD, { pending: 1, digest: "journal-1" });
    equal(reads.length, 3, "an agent proposed a change");
    await redraw();
    await show(() => reads.push("read"), live);
    tell(HEAD, { pending: 0, digest: "journal-2" });
    equal(reads.length, 4, "drawn again, it follows once");
    await hide();
    tell(HEAD, { pending: 2, digest: "journal-3" });
    equal(reads.length, 4, "a place that is closed reads nothing");
  });
});
