import { type ReadonlySignal, signal } from "@preact/signals";
import {
  type PreferenceStorage,
  readBrowserPreference,
} from "../browser/preferences.ts";

/**
 * How the viewer likes the System pages told: in the model's words made
 * readable, or in SysML's own (keywords and types). A preference of the
 * person looking, kept in this browser as a convenience and never a state the
 * pages depend on: without storage the choice lasts for the page, and a page
 * drawn on the server, or before the choice is read, is the readable one.
 */

export const VIEW_MODES = ["readable", "sysml"] as const;
export type ViewMode = typeof VIEW_MODES[number];

/** Where the choice is kept. */
export const VIEW_MODE_KEY = "assembly:view:mode";
export const LEGACY_VIEW_MODE_KEY = "ase:view:mode";

/** The part of the browser's storage the preferences use. */
export type PrefsStorage = PreferenceStorage;

export interface ViewPrefs {
  readonly mode: ReadonlySignal<ViewMode>;
  /** Reads the choice saved in this browser; call it once the page is shown. */
  restore(): void;
  /** Changes the mode now and saves it, when the browser lets it. */
  set(mode: ViewMode): void;
}

export function createViewPrefs(
  /** The storage, looked up at each use: it may not exist, or refuse. */
  storage: () => PrefsStorage = () => localStorage,
): ViewPrefs {
  const mode = signal<ViewMode>("readable");
  return {
    mode,
    restore() {
      try {
        const saved = readBrowserPreference(
          storage,
          VIEW_MODE_KEY,
          LEGACY_VIEW_MODE_KEY,
        );
        const known = VIEW_MODES.find((entry) => entry === saved);
        if (known) mode.value = known;
      } catch {
        // Private windows and blocked storage: the readable view it is.
      }
    },
    set(next) {
      mode.value = next;
      try {
        storage().setItem(VIEW_MODE_KEY, next);
      } catch {
        // The choice lasts for this page only.
      }
    },
  };
}

/** The viewer's preferences, shared by every page of the app. */
export const viewPrefs: ViewPrefs = createViewPrefs();
