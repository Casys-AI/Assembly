import { ok } from "node:assert/strict";
import { options, type VNode } from "preact";
import { renderToString } from "preact-render-to-string";

/**
 * Renders a node and hands back its markup and a way to press its buttons by
 * their label. The production JSX is precompiled: each `onClick` is captured as
 * the page creates it and tied to its button by a marker in the markup. Handlers
 * are handed out template by template, before those of the components nested in
 * it, so their order is not the order of the buttons: the marker is what ties
 * them. Links are `renderLinks` (links.ts). A page whose hooks a probe runs is
 * given as the function that creates it, called while handlers are captured.
 */
export function press(node: VNode | (() => VNode)) {
  const clicks: (() => void)[] = [];
  let input: ((event: unknown) => unknown) | undefined;
  let change: ((event: unknown) => unknown) | undefined;
  let submit: ((event: unknown) => unknown) | undefined;
  const previous = options.attr;
  options.attr = (name, value) => {
    if (name === "onclick" && typeof value === "function") {
      clicks.push(value as () => void);
      return `data-press="${clicks.length - 1}"`;
    }
    // A form has one field and one submit here: the first of each is its own.
    if (name === "oninput" && typeof value === "function") {
      input ??= value as typeof input;
    }
    if (name === "onchange" && typeof value === "function") {
      change ??= value as typeof change;
    }
    if (name === "onsubmit" && typeof value === "function") {
      submit ??= value as typeof submit;
    }
    return previous?.(name, value);
  };
  let marked: string;
  try {
    marked = renderToString(typeof node === "function" ? node() : node);
  } finally {
    options.attr = previous;
  }
  const buttons = [...marked.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .map(([, attributes, inner]) => ({
      label: /aria-label="([^"]+)"/.exec(attributes)?.[1] ??
        inner.replace(/<[^>]+>/g, "").trim(),
      handler: /data-press="(\d+)"/.exec(attributes)?.[1],
    }));
  return {
    html: marked.replace(/\s?data-press="\d+"/g, ""),
    labels: buttons.map((button) => button.label),
    /** The first `onInput` handler: call it with the event the field sends. */
    input,
    /** The first `onChange` handler: a menu's, called with the event it sends. */
    change,
    /** The first `onSubmit` handler: call it with the event the form sends. */
    submit,
    /** How many `onClick` handlers the node handed out. */
    handlers: clicks.length,
    /** Calls every handler, whatever its label. */
    clickAll() {
      for (const click of clicks) click();
    },
    /** Presses the first button whose label starts with `label`. */
    click(label: string) {
      const button = buttons.find((entry) => entry.label.startsWith(label));
      ok(button, `no "${label}" button in ${buttons.map((b) => b.label)}`);
      ok(button.handler !== undefined, `"${label}" does nothing when pressed`);
      clicks[Number(button.handler)]();
    },
  };
}
