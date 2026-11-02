import { type RefObject } from "preact";
import { useEffect } from "preact/hooks";
import { useOutsidePress } from "./useOutsidePress.ts";

/**
 * Lets a disclosure (`<details>`) go when the person is done with it, as a
 * menu does: a press outside it (`useOutsidePress`), Escape, or the choice of
 * a link in it close it. Opening it puts the focus on its first link, so Escape reaches it first:
 * it is an element the shell's keys pass through before the page's own layer
 * (see `useEscapeKey`), and it takes the key, so one press closes one layer.
 */
export function useDismiss(area: RefObject<HTMLDetailsElement>): void {
  useOutsidePress(area, () => {
    if (area.current?.open) area.current.open = false;
  });
  useEffect(() => {
    const menu = area.current;
    if (!menu) return;
    const close = () => {
      menu.open = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || !menu.open) return;
      event.preventDefault();
      close();
      menu.querySelector<HTMLElement>("summary")?.focus();
    };
    const choose = (event: Event) => {
      if ((event.target as Element | null)?.closest?.("a")) close();
    };
    const opened = () => {
      if (menu.open) menu.querySelector<HTMLElement>("a")?.focus();
    };
    menu.addEventListener("keydown", key);
    menu.addEventListener("click", choose);
    menu.addEventListener("toggle", opened);
    return () => {
      menu.removeEventListener("keydown", key);
      menu.removeEventListener("click", choose);
      menu.removeEventListener("toggle", opened);
    };
  }, []);
}
