import { type RefObject } from "preact";
import { useEffect } from "preact/hooks";

/**
 * Gives the focus back to where it was when `area` appeared, when `area` goes
 * away with the focus inside it: closing a detail from the keyboard leaves the
 * person on the element they opened it from, not at the top of the page. Where
 * the focus was is the element focused when the area was shown (nothing to go
 * back to when the page was opened on it, or by a click the browser does not
 * focus). Focus that was already elsewhere is left alone.
 */
export function useReturnFocus(area: RefObject<HTMLElement>): void {
  useEffect(() => {
    const shown = area.current;
    const opener = document.activeElement as HTMLElement | null;
    return () => {
      if (
        !shown || !opener || opener === document.body ||
        typeof opener.focus !== "function" || shown.contains(opener) ||
        !shown.contains(document.activeElement)
      ) return;
      // The effects of a page that goes away run before its elements do.
      if (opener.isConnected !== false) opener.focus();
    };
  }, []);
}
