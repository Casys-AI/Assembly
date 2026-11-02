import { useEffect, useRef } from "preact/hooks";

/** A field the person is typing in: Escape there belongs to the field. */
function isEditing(target: EventTarget | null): boolean {
  const element = target as
    | { tagName?: string; isContentEditable?: boolean }
    | null;
  return Boolean(element?.isContentEditable) ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(element?.tagName ?? "");
}

/**
 * Calls `onEscape` when Escape reaches the window unhandled: the page's own
 * layer is the lowest one. Whatever the shell opened over it (a menu, a pile of
 * Requests, the conversation, a side panel) takes the key first and marks it
 * handled, so one press closes one layer and a press nothing took closes this.
 * Left alone: a key already handled, one that composes text, and one pressed
 * in a field. The shell orders its own layers (islands/Workbench.tsx); this
 * hook does not join them, so a detail never outranks one of theirs.
 */
export function useEscapeKey(onEscape: () => void): void {
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" || event.defaultPrevented ||
        event.isComposing || isEditing(event.target)
      ) return;
      event.preventDefault();
      latest.current();
    };
    // The window comes last in the bubbling of a key, after the elements and
    // the document, whatever the order in which their listeners were added.
    globalThis.addEventListener("keydown", press);
    return () => globalThis.removeEventListener("keydown", press);
  }, []);
}
