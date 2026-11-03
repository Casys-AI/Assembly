import { equal, match, ok } from "node:assert/strict";
import { h, options, render } from "preact";
import { act } from "preact/test-utils";
import { renderToString } from "preact-render-to-string";
import { linkedBoard } from "../../test/support/board-fixture.ts";
import { SystemElementSearch } from "./SystemElementSearch.tsx";

Deno.test("search keyboard opens outside editable fields, closes with Escape and cleans up", async () => {
  const beforeDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const beforeElement = Object.getOwnPropertyDescriptor(globalThis, "Element");
  const oldAdd = globalThis.addEventListener;
  const oldRemove = globalThis.removeEventListener;
  class Target {
    constructor(readonly editable: boolean) {}
    closest() {
      return this.editable ? this : null;
    }
  }
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {},
  });
  Object.defineProperty(globalThis, "Element", {
    configurable: true,
    value: Target,
  });
  let listener: ((event: KeyboardEvent) => void) | undefined;
  globalThis.addEventListener = ((_type: string, fn: EventListener) => {
    listener = fn as (event: KeyboardEvent) => void;
  }) as typeof globalThis.addEventListener;
  globalThis.removeEventListener = ((_type: string, fn: EventListener) => {
    if (listener === fn) listener = undefined;
  }) as typeof globalThis.removeEventListener;
  const root = {} as HTMLElement;
  let markup = "";
  const jsx = options as typeof options & {
    attr?: (name: string, value: unknown) => string | void;
  };
  let input:
    | ((event: { currentTarget: { value: string } }) => void)
    | undefined;
  let panelKey: ((event: KeyboardEvent) => void) | undefined;
  function Probe() {
    const previous = jsx.attr;
    jsx.attr = (name, value) => {
      if (name === "oninput") input = value as typeof input;
      if (name === "onkeydown") panelKey = value as typeof panelKey;
      return previous?.(name, value);
    };
    try {
      markup = renderToString(
        SystemElementSearch({ board: linkedBoard(), locationSearch: "" })!,
      );
    } finally {
      jsx.attr = previous;
    }
    return null;
  }
  const key = async (value: string, editable = false) => {
    let prevented = false;
    const event = {
      key: value,
      target: new Target(editable),
      preventDefault() {
        prevented = true;
      },
    } as unknown as KeyboardEvent;
    await act(() => listener?.(event));
    return prevented;
  };
  try {
    await act(() => render(h(Probe, {}), root));
    equal(await key("/", true), false);
    equal(markup.includes('role="search"'), false);
    equal(await key("/"), true);
    match(markup, /role="search"/);
    ok(input);
    await act(() => input?.({ currentTarget: { value: "no such element" } }));
    match(markup, /No match/);
    equal(await key("Escape"), false);
    equal(markup.includes('role="search"'), true);
    let stopped = false;
    await act(() =>
      panelKey?.({
        key: "Escape",
        preventDefault() {},
        stopPropagation() {
          stopped = true;
        },
      } as KeyboardEvent)
    );
    equal(stopped, true);
    equal(markup.includes('role="search"'), false);
    await act(() => render(null, root));
    equal(listener, undefined);
  } finally {
    await act(() => render(null, root));
    globalThis.addEventListener = oldAdd;
    globalThis.removeEventListener = oldRemove;
    if (beforeDocument) {
      Object.defineProperty(globalThis, "document", beforeDocument);
    } else Reflect.deleteProperty(globalThis, "document");
    if (beforeElement) {
      Object.defineProperty(globalThis, "Element", beforeElement);
    } else Reflect.deleteProperty(globalThis, "Element");
  }
});
