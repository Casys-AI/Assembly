import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";

/**
 * Calls `onOutside` when the pointer goes down anywhere outside `area`: the
 * way a menu or a panel that opened over the page lets go. It listens only
 * while `active`, and always calls the latest `onOutside`, so the caller does
 * not have to keep it stable. The one place the rule is written; what else
 * lets a menu go (Escape, choosing a link) stays with the menu.
 */
export function useOutsidePress(
  area: RefObject<Element>,
  onOutside: () => void,
  active = true,
): void {
  const latest = useRef(onOutside);
  latest.current = onOutside;
  useEffect(() => {
    if (!active) return;
    const outside = (event: Event) => {
      if (!area.current?.contains(event.target as Node | null)) {
        latest.current();
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [active, area]);
}
