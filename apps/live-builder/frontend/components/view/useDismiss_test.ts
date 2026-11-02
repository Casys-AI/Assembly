import { deepStrictEqual, equal } from "node:assert/strict";
import type { RefObject } from "preact";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { useDismiss } from "./useDismiss.ts";

type Listener = (event: Record<string, unknown>) => void;

/** A disclosure that says what is done to it, and a document that keeps its listeners. */
function stage() {
  const log: string[] = [];
  const onMenu = new Map<string, Listener>();
  const onDocument = new Map<string, Listener>();
  const inside = { name: "inside link" };
  const outside = { name: "elsewhere" };
  const summary = { focus: () => log.push("summary focused") };
  const firstLink = { focus: () => log.push("first link focused") };
  const menu = {
    open: true,
    contains: (node: unknown) => node === inside,
    querySelector: (selector: string) =>
      selector === "summary" ? summary : selector === "a" ? firstLink : null,
    addEventListener: (type: string, listener: Listener) =>
      void onMenu.set(type, listener),
    removeEventListener: (type: string) => void onMenu.delete(type),
  };
  return { log, onMenu, onDocument, inside, outside, menu };
}

/** Shows a probe that dismisses `menu`, with the document's listeners kept. */
async function shown(model: ReturnType<typeof stage>) {
  const probe = probeRoot();
  const document = globalThis.document as unknown as Record<string, unknown>;
  document.addEventListener = (type: string, listener: Listener) =>
    void model.onDocument.set(type, listener);
  document.removeEventListener = (type: string) =>
    void model.onDocument.delete(type);
  function Probe() {
    useDismiss(
      { current: model.menu } as unknown as RefObject<HTMLDetailsElement>,
    );
    return null;
  }
  await probe.show(Probe, {});
  return probe;
}

const key = (over: Record<string, unknown> = {}) => {
  let prevented = 0;
  return {
    event: {
      key: "Escape",
      isComposing: false,
      preventDefault: () => prevented++,
      ...over,
    },
    prevented: () => prevented,
  };
};

Deno.test("a press outside the menu closes it; a press inside does not", async () => {
  const model = stage();
  const probe = await shown(model);
  try {
    model.onDocument.get("pointerdown")!({ target: model.inside });
    equal(model.menu.open, true);
    model.onDocument.get("pointerdown")!({ target: model.outside });
    equal(model.menu.open, false);
  } finally {
    await probe.restore();
  }
});

Deno.test("Escape closes the menu, takes the key and gives the focus back to the menu's name", async () => {
  const model = stage();
  const probe = await shown(model);
  try {
    const pressed = key();
    model.onMenu.get("keydown")!(pressed.event);
    equal(model.menu.open, false);
    equal(
      pressed.prevented(),
      1,
      "the key is taken: nothing under the menu also closes",
    );
    deepStrictEqual(model.log, ["summary focused"]);
  } finally {
    await probe.restore();
  }
});

Deno.test("Escape on a menu that is closed, another key, or composing text, is left alone", async () => {
  const model = stage();
  const probe = await shown(model);
  try {
    for (const over of [{ key: "Enter" }, { isComposing: true }]) {
      const pressed = key(over);
      model.onMenu.get("keydown")!(pressed.event);
      equal(pressed.prevented(), 0, JSON.stringify(over));
    }
    equal(model.menu.open, true);
    model.menu.open = false;
    const pressed = key();
    model.onMenu.get("keydown")!(pressed.event);
    equal(pressed.prevented(), 0, "a closed menu does not take the key");
    deepStrictEqual(model.log, []);
  } finally {
    await probe.restore();
  }
});

Deno.test("choosing a link closes the menu; clicking its padding does not", async () => {
  const model = stage();
  const probe = await shown(model);
  try {
    model.onMenu.get("click")!({ target: { closest: () => null } });
    equal(model.menu.open, true);
    model.onMenu.get("click")!({
      target: { closest: (tag: string) => tag === "a" ? {} : null },
    });
    equal(model.menu.open, false);
  } finally {
    await probe.restore();
  }
});

Deno.test("opening the menu puts the focus on its first link, so Escape reaches it; closing it does not", async () => {
  const model = stage();
  const probe = await shown(model);
  try {
    model.onMenu.get("toggle")!({});
    deepStrictEqual(model.log, ["first link focused"]);
    model.menu.open = false;
    model.onMenu.get("toggle")!({});
    deepStrictEqual(model.log, ["first link focused"]);
  } finally {
    await probe.restore();
  }
});

Deno.test("the listeners go when the menu does", async () => {
  const model = stage();
  const probe = await shown(model);
  equal(model.onMenu.size, 3);
  equal(model.onDocument.size, 1);
  await probe.restore();
  equal(model.onMenu.size, 0);
  equal(model.onDocument.size, 0);
});
