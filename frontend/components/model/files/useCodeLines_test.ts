import { equal } from "node:assert/strict";
import { probeRoot } from "../../../test/support/hook-probe.ts";
import { MAX_SHOWN_LINES } from "../../../lib/model/sources/files.ts";
import { useCodeLines } from "./useCodeLines.ts";

/**
 * The window of a long file, against Preact's real hooks: what matters is what
 * it keeps from one pass to the next, which a single render cannot show.
 */
const LONG = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`)
  .join("\n");

function mount() {
  const root = probeRoot();
  let first: number | null | undefined;
  let lines = 0;
  function Probe(
    props: { name: string; text: string | null; line: number | null },
  ) {
    const drawn = useCodeLines(props.name, props.text, props.line);
    first = drawn?.first ?? null;
    lines = drawn?.lines.length ?? 0;
    return null;
  }
  return {
    /** Draws the file once more at this address; the first line it draws. */
    async show(name: string, line: number | null, text: string | null = LONG) {
      await root.show(Probe, { name, text, line });
      return first;
    },
    lines: () => lines,
    restore: () => root.restore(),
  };
}

Deno.test("clearing the highlighted line of a long file leaves the window where it was", async () => {
  const run = mount();
  try {
    // The address points far down: the window is centred on the line.
    equal(await run.show("a.sysml", 4000), 3000);
    equal(run.lines(), MAX_SHOWN_LINES);
    // The reader clears the line: the text under them does not change.
    equal(await run.show("a.sysml", null), 3000);
    // Highlighting another line inside the window does not move it either.
    equal(await run.show("a.sysml", 3500), 3000);
    equal(await run.show("a.sysml", null), 3000);
  } finally {
    await run.restore();
  }
});

Deno.test("a line outside the window, or another file, takes the window where the address says", async () => {
  const run = mount();
  try {
    equal(await run.show("a.sysml", 4000), 3000);
    // A line the window does not hold: the window goes to it.
    equal(await run.show("a.sysml", 10), 1);
    equal(await run.show("a.sysml", 4800), 3001);
    // Another file starts from its own address, not from this one's window.
    equal(await run.show("b.sysml", null), 1);
    equal(await run.show("a.sysml", null), 1);
    // The same file at another version is another file too.
    equal(await run.show("a.sysml", 4000), 3000);
    equal(await run.show("v2\na.sysml", null), 1);
  } finally {
    await run.restore();
  }
});

Deno.test("nothing is drawn until the text is read, and a text that gets shorter ends the window with it", async () => {
  const run = mount();
  try {
    equal(await run.show("a.sysml", 4000, null), null);
    equal(run.lines(), 0);
    equal(await run.show("a.sysml", 4000), 3000);
    // The same file, now 2,500 lines: the kept window is cut to fit.
    const shorter = LONG.split("\n").slice(0, 2500).join("\n");
    equal(await run.show("a.sysml", null, shorter), 501);
    equal(run.lines(), MAX_SHOWN_LINES);
  } finally {
    await run.restore();
  }
});
