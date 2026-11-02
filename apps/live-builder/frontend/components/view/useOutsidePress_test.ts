import { deepStrictEqual, equal } from "node:assert/strict";
import type { RefObject } from "preact";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { useOutsidePress } from "./useOutsidePress.ts";

type Listener = (event: Record<string, unknown>) => void;

/** An area that knows what is inside it, and a document that keeps its listeners. */
function stage() {
  const listeners = new Map<string, Listener>();
  const added: string[] = [];
  const inside = { name: "inside" };
  const outside = { name: "elsewhere" };
  const area = {
    current: { contains: (node: unknown) => node === inside },
  } as unknown as RefObject<Element>;
  const probe = probeRoot();
  const document = globalThis.document as unknown as Record<string, unknown>;
  document.addEventListener = (type: string, listener: Listener) => {
    added.push(type);
    listeners.set(type, listener);
  };
  document.removeEventListener = (type: string) => void listeners.delete(type);
  const props = (over: { onOutside?: () => void; active?: boolean } = {}) => ({
    area,
    onOutside: over.onOutside ?? (() => {}),
    active: over.active ?? true,
  });
  const Probe = (
    options: ReturnType<typeof props>,
  ) => {
    useOutsidePress(options.area, options.onOutside, options.active);
    return null;
  };
  return { probe, listeners, added, inside, outside, props, Probe };
}

Deno.test("a press outside the area calls for it to let go; a press inside does not", async () => {
  const model = stage();
  const calls: string[] = [];
  await model.probe.show(
    model.Probe,
    model.props({ onOutside: () => calls.push("outside") }),
  );
  try {
    model.listeners.get("pointerdown")!({ target: model.inside });
    deepStrictEqual(calls, []);
    model.listeners.get("pointerdown")!({ target: model.outside });
    deepStrictEqual(calls, ["outside"]);
  } finally {
    await model.probe.restore();
  }
});

Deno.test("it listens only while active, and stops when it is not any more", async () => {
  const model = stage();
  await model.probe.show(model.Probe, model.props({ active: false }));
  try {
    equal(model.listeners.size, 0, "a closed menu listens to nothing");
    await model.probe.show(model.Probe, model.props({ active: true }));
    equal(model.listeners.size, 1);
    await model.probe.show(model.Probe, model.props({ active: false }));
    equal(model.listeners.size, 0);
  } finally {
    await model.probe.restore();
  }
});

Deno.test("the latest handler is the one called, without listening again", async () => {
  const model = stage();
  const calls: string[] = [];
  await model.probe.show(
    model.Probe,
    model.props({ onOutside: () => calls.push("first") }),
  );
  try {
    await model.probe.show(
      model.Probe,
      model.props({ onOutside: () => calls.push("second") }),
    );
    model.listeners.get("pointerdown")!({ target: model.outside });
    deepStrictEqual(calls, ["second"]);
    deepStrictEqual(model.added, ["pointerdown"], "one listener, kept");
  } finally {
    await model.probe.restore();
  }
});

Deno.test("the listener goes when the component does", async () => {
  const model = stage();
  await model.probe.show(model.Probe, model.props());
  equal(model.listeners.size, 1);
  await model.probe.restore();
  equal(model.listeners.size, 0);
});
