import { signal } from "@preact/signals";
import { readBrowserPreference } from "../browser/preferences.ts";

/**
 * Cases pinned to the left of the Dock, per system and per viewer. Storage is
 * a convenience: without it, pins simply last for the page's life.
 */
export function createPins() {
  const ids = signal<readonly string[]>([]);
  let key: string | null = null;
  function load(systemId: string | null | undefined) {
    const next = systemId ? `assembly:pins:${systemId}` : null;
    if (next === key) return;
    key = next;
    let stored: unknown = [];
    try {
      stored = key
        ? JSON.parse(
          readBrowserPreference(
            () => localStorage,
            key,
            `ase:pins:${systemId}`,
          ) ?? "[]",
        )
        : [];
    } catch {
      stored = [];
    }
    ids.value = Array.isArray(stored)
      ? stored.filter((id): id is string => typeof id === "string")
      : [];
  }
  function toggle(id: string) {
    ids.value = ids.peek().includes(id)
      ? ids.peek().filter((entry) => entry !== id)
      : [...ids.peek(), id];
    try {
      if (key) localStorage.setItem(key, JSON.stringify(ids.peek()));
    } catch {
      // Private windows and blocked storage keep the pin for this page only.
    }
  }
  return { ids, load, toggle, has: (id: string) => ids.value.includes(id) };
}
export type Pins = ReturnType<typeof createPins>;
