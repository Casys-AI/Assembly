import { options, type VNode } from "preact";

/**
 * The keys a component was drawn with while `draw` ran. Whether a box is drawn
 * anew between two choices (its focus, its place on the page) is the key it is
 * given, and rendering to a string has no other handle on it.
 */
export function keysGiven(component: unknown, draw: () => unknown): unknown[] {
  const keys: unknown[] = [];
  const before = options.vnode;
  options.vnode = (vnode: VNode) => {
    if (vnode.type === component) keys.push(vnode.key);
    before?.(vnode);
  };
  try {
    draw();
  } finally {
    options.vnode = before;
  }
  return keys;
}
