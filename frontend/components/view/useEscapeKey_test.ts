import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { useEscapeKey } from "./useEscapeKey.ts";

function key(over: Record<string, unknown> = {}) {
  let prevented = 0;
  return {
    event: {
      key: "Escape",
      defaultPrevented: false,
      isComposing: false,
      target: { tagName: "A" },
      preventDefault: () => prevented++,
      ...over,
    },
    prevented: () => prevented,
  };
}

Deno.test("Escape calls the function, claims the key, and stops when the page leaves", async () => {
  const probe = probeRoot();
  const registered = probe.windowListeners();
  const calls: string[] = [];
  function Probe(props: { name: string }) {
    useEscapeKey(() => calls.push(props.name));
    return null;
  }
  try {
    await probe.show(Probe, { name: "first" });
    equal(registered.length, 1);
    equal(registered[0].type, "keydown");
    // Not captured, and on the window: it comes after the elements and the
    // document of the layers the shell opened over the page, which take the key.
    ok(!registered[0].capture);
    const pressed = key();
    registered[0].listener(pressed.event);
    deepStrictEqual(calls, ["first"]);
    equal(pressed.prevented(), 1);
    // The function is the latest one: no listener is added for a new render.
    await probe.show(Probe, { name: "second" });
    equal(registered.length, 1);
    registered[0].listener(key().event);
    deepStrictEqual(calls, ["first", "second"]);
    await probe.unmount();
    equal(registered.length, 0, "removed with the page");
  } finally {
    await probe.restore();
  }
});

Deno.test("Escape is left alone when it is not for the page: another key, one already handled, composing text, or typing in a field", async () => {
  const probe = probeRoot();
  const registered = probe.windowListeners();
  let calls = 0;
  function Probe() {
    useEscapeKey(() => calls++);
    return null;
  }
  try {
    await probe.show(Probe, {});
    const ignored = [
      { key: "Enter" },
      { key: "a" },
      { defaultPrevented: true },
      { isComposing: true },
      { target: { tagName: "INPUT" } },
      { target: { tagName: "TEXTAREA" } },
      { target: { tagName: "SELECT" } },
      { target: { tagName: "DIV", isContentEditable: true } },
    ];
    for (const over of ignored) {
      const pressed = key(over);
      registered[0].listener(pressed.event);
      equal(pressed.prevented(), 0, JSON.stringify(over));
    }
    equal(calls, 0);
    // A key that lands on the page itself, or on nothing, is for it.
    for (const target of [null, { tagName: "BODY" }, { tagName: "A" }]) {
      registered[0].listener(key({ target }).event);
    }
    equal(calls, 3);
    ok(registered.length === 1);
  } finally {
    await probe.restore();
  }
});

Deno.test("a layer opened over the page takes the key first: the window sees it handled and the page stays", async () => {
  const probe = probeRoot();
  const registered = probe.windowListeners();
  let calls = 0;
  function Probe() {
    useEscapeKey(() => calls++);
    return null;
  }
  // The key goes through what is under the focus, then reaches the window; an
  // element that takes it calls preventDefault, as the shell's menus do.
  const pressed = (layers: ((event: Record<string, unknown>) => void)[]) => {
    const event: Record<string, unknown> = {
      key: "Escape",
      defaultPrevented: false,
      isComposing: false,
      target: { tagName: "BUTTON" },
      preventDefault() {
        event.defaultPrevented = true;
      },
    };
    for (const layer of [...layers, registered[0].listener]) layer(event);
  };
  try {
    await probe.show(Probe, {});
    pressed([(event) => (event.preventDefault as () => void)()]);
    equal(calls, 0, "the menu closed, not the detail");
    pressed([]);
    equal(calls, 1, "a key nothing took closes the detail");
  } finally {
    await probe.restore();
  }
});
