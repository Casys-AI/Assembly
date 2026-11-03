import { deepStrictEqual } from "node:assert/strict";
import type { RefObject } from "preact";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { useReturnFocus } from "./useReturnFocus.ts";

/** An element that says when it is given the focus. */
function element(name: string, log: string[], connected = true) {
  return { name, isConnected: connected, focus: () => log.push(name) };
}

/**
 * A detail opened from `card` (the element with the focus), then closed with
 * the focus where `then` says. Returns who was given the focus by closing it.
 */
async function closed(
  options: {
    opened: "card" | "body";
    then: "inside" | "card" | "elsewhere";
    cardConnected?: boolean;
  },
): Promise<string[]> {
  const log: string[] = [];
  const probe = probeRoot();
  const document = globalThis.document as unknown as Record<string, unknown>;
  const body = element("body", log);
  const card = element("card", log, options.cardConnected);
  const cross = element("cross", log);
  const elsewhere = element("elsewhere", log);
  const area = { contains: (node: unknown) => node === cross };
  document.body = body;
  document.activeElement = options.opened === "card" ? card : body;
  function Probe() {
    useReturnFocus({ current: area } as unknown as RefObject<HTMLElement>);
    return null;
  }
  try {
    await probe.show(Probe, {});
    document.activeElement = {
      inside: cross,
      card,
      elsewhere,
    }[options.then];
    await probe.unmount();
  } finally {
    await probe.restore();
  }
  return log;
}

Deno.test("a detail closed with the focus inside it gives the focus back to the element it was opened from", async () => {
  deepStrictEqual(await closed({ opened: "card", then: "inside" }), ["card"]);
});

Deno.test("the focus is left where it is when it was not in the detail", async () => {
  // Still on the card: it is where it should be.
  deepStrictEqual(await closed({ opened: "card", then: "card" }), []);
  // Moved on to something else: not taken back.
  deepStrictEqual(await closed({ opened: "card", then: "elsewhere" }), []);
});

Deno.test("a detail opened with nothing focused, or from an element that has gone, has nowhere to give the focus back to", async () => {
  deepStrictEqual(await closed({ opened: "body", then: "inside" }), []);
  deepStrictEqual(
    await closed({ opened: "card", then: "inside", cardConnected: false }),
    [],
  );
});
