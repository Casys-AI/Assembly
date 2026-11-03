import { options, type VNode } from "preact";
import { renderToString } from "preact-render-to-string";

const plainClick = {
  button: 0,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
};

/**
 * Renders a page and hands back the click handlers of its links, found by
 * their `id` or, without one, their `class`: links are not precompiled, so
 * their handlers are read as the page creates them.
 */
export function renderLinks(node: VNode) {
  const handlers = new Map<string, (event: unknown) => void>();
  const previous = options.vnode;
  options.vnode = (vnode) => {
    const props = vnode.props as Record<string, unknown>;
    // The JSX transform lowercases the event name.
    const onClick = props.onclick ?? props.onClick;
    if (vnode.type === "a" && typeof onClick === "function") {
      handlers.set(
        String(props.id ?? props.class),
        onClick as (event: unknown) => void,
      );
    }
    previous?.(vnode);
  };
  let html: string;
  try {
    html = renderToString(node);
  } finally {
    options.vnode = previous;
  }
  return {
    html,
    /** Clicks the link as a plain click, or with the given modifiers. */
    click(link: string, modifiers: Partial<typeof plainClick> = {}) {
      const handler = handlers.get(link);
      if (!handler) throw new Error(`no clickable "${link}" link`);
      handler({ ...plainClick, ...modifiers });
    },
  };
}
