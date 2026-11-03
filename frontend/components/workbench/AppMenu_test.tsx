import { equal, ok } from "node:assert/strict";
import { h, options, render } from "preact";
import { act } from "preact/test-utils";
import { renderToString } from "preact-render-to-string";
import { AppMenu } from "./AppMenu.tsx";

/** Run the production component's hooks and handlers without a browser DOM. */
async function withMenu(
  exercise: (menu: {
    open(): Promise<void>;
    showAbout(): Promise<void>;
    aboutVisible(): boolean;
    done(): Promise<void>;
    expanded(): boolean;
    focusOut(inside: boolean): Promise<void>;
    escape(): Promise<KeyboardEvent>;
    focused(): string;
  }) => Promise<void>,
) {
  const documentBefore = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const nodeBefore = Object.getOwnPropertyDescriptor(globalThis, "Node");
  let focused = "";
  class MenuNode extends EventTarget {
    constructor(readonly name: string) {
      super();
    }
    focus() {
      focused = this.name;
    }
  }
  const trigger = new MenuNode("trigger");
  const item = new MenuNode("item");
  const done = new MenuNode("done");
  const outside = new MenuNode("conversation");
  const area = Object.assign(new MenuNode("menu"), {
    contains: (node: unknown) =>
      node === trigger || node === item || node === done,
    querySelector: (selector: string) =>
      selector.startsWith(".app-about") ? done : item,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: new EventTarget(),
  });
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: MenuNode,
  });
  const root = {} as HTMLElement;
  const jsxOptions = options as typeof options & {
    attr?: (name: string, value: unknown) => string | void;
  };
  let attributes: { name: string; value: unknown }[] = [];
  let markup = "";
  function Probe() {
    attributes = [];
    const previous = jsxOptions.attr;
    // The production JSX is precompiled: capture its real event/ref attributes
    // before serialization, rather than duplicating the component's behavior.
    jsxOptions.attr = (name, value) => {
      attributes.push({ name, value });
      if (name === "ref" && value && typeof value === "object") {
        const target = attributes.filter((entry) =>
          entry.name === "ref"
        ).length;
        (value as { current: unknown }).current = target === 1 ? area : trigger;
      }
      return previous?.(name, value);
    };
    try {
      markup = renderToString(AppMenu({ systemName: "Test", version: "1" }));
    } finally {
      jsxOptions.attr = previous;
    }
    return null;
  }
  function handler(name: string) {
    return attributes.find((entry) => entry.name === name.toLowerCase())
      ?.value as
        | ((event: Event) => void)
        | undefined;
  }
  try {
    await act(() => render(h(Probe, {}), root));
    await exercise({
      open: () =>
        act(() => {
          handler("onClick")?.(new Event("click"));
        }),
      showAbout: () =>
        act(() => {
          const click = attributes.filter((entry) =>
            entry.name === "onclick"
          )[1]
            ?.value as (event: Event) => void;
          click(new Event("click"));
          // Chromium blurs a focused button when the menu replaces it.
          // Model that real DOM event only if the action kept the item focused.
          if (focused === "item") {
            const event = new Event("focusout");
            Object.defineProperty(event, "relatedTarget", { value: null });
            handler("onFocusOut")?.(event);
          }
        }),
      aboutVisible: () => markup.includes('aria-label="About Assembly"'),
      done: () =>
        act(() => {
          const click = attributes.filter((entry) =>
            entry.name === "onclick"
          )[1]
            ?.value as (event: Event) => void;
          click(new Event("click"));
        }),
      expanded: () =>
        attributes.find((entry) => entry.name === "aria-expanded")?.value ===
          "true",
      focusOut: (inside) =>
        act(() => {
          const target = inside ? trigger : outside;
          target.focus();
          const event = new Event("focusout");
          Object.defineProperty(event, "relatedTarget", { value: target });
          handler("onFocusOut")?.(event);
        }),
      escape: async () => {
        const event = new Event("keydown", { cancelable: true });
        Object.defineProperty(event, "key", { value: "Escape" });
        await act(() => handler("onKeyDown")?.(event));
        return event as KeyboardEvent;
      },
      focused: () => focused,
    });
  } finally {
    await act(() => render(null, root));
    for (
      const [name, descriptor] of [
        ["document", documentBefore],
        ["Node", nodeBefore],
      ] as const
    ) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

Deno.test("Assembly menu closes when Tab moves focus to the conversation", async () => {
  await withMenu(async (menu) => {
    await menu.open();
    equal(menu.expanded(), true);
    equal(menu.focused(), "item");
    await menu.focusOut(false);
    equal(menu.expanded(), false, "the menu must close on focus leaving it");
    equal(
      menu.focused(),
      "conversation",
      "Tab must keep its destination focus",
    );
  });
});

Deno.test("Assembly menu keeps internal focus and claims Escape before the conversation", async () => {
  await withMenu(async (menu) => {
    await menu.open();
    await menu.focusOut(true);
    equal(menu.expanded(), true);
    const event = await menu.escape();
    equal(menu.expanded(), false);
    ok(
      event.defaultPrevented,
      "the workbench must leave the conversation open",
    );
    equal(menu.focused(), "trigger");
  });
});

Deno.test("About stays open when its focused menu action is replaced, and Done returns focus", async () => {
  await withMenu(async (menu) => {
    await menu.open();
    await menu.showAbout();
    equal(menu.aboutVisible(), true);
    equal(menu.expanded(), false);
    equal(menu.focused(), "done");
    await menu.done();
    equal(menu.aboutVisible(), false);
    equal(menu.focused(), "trigger");
  });
});

Deno.test("About handles Escape and lets Tab leave without taking the destination focus", async () => {
  await withMenu(async (menu) => {
    await menu.open();
    await menu.showAbout();
    const event = await menu.escape();
    equal(menu.aboutVisible(), false);
    ok(event.defaultPrevented);
    equal(menu.focused(), "trigger");
    await menu.open();
    await menu.showAbout();
    await menu.focusOut(true);
    equal(menu.aboutVisible(), true);
    await menu.focusOut(false);
    equal(menu.aboutVisible(), false);
    equal(menu.focused(), "conversation");
  });
});
