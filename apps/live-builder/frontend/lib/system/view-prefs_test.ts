import { deepStrictEqual, equal } from "node:assert/strict";
import {
  createViewPrefs,
  LEGACY_VIEW_MODE_KEY,
  type PrefsStorage,
  VIEW_MODE_KEY,
} from "./view-prefs.ts";

/** A browser's storage that keeps what it is given. */
function memory(initial: Record<string, string> = {}) {
  const kept = new Map(Object.entries(initial));
  const storage: PrefsStorage = {
    getItem: (key) => kept.get(key) ?? null,
    setItem: (key, value) => void kept.set(key, value),
  };
  return { storage, kept };
}

Deno.test("the page starts readable, whatever was chosen before, until the choice is read", () => {
  const { storage } = memory({ [VIEW_MODE_KEY]: "sysml" });
  const prefs = createViewPrefs(() => storage);
  equal(prefs.mode.value, "readable");
  prefs.restore();
  equal(prefs.mode.value, "sysml");
});

Deno.test("a choice is kept in this browser, and the next page reads it", () => {
  const { storage, kept } = memory();
  const first = createViewPrefs(() => storage);
  first.set("sysml");
  equal(first.mode.value, "sysml");
  deepStrictEqual([...kept], [[VIEW_MODE_KEY, "sysml"]]);
  const next = createViewPrefs(() => storage);
  next.restore();
  equal(next.mode.value, "sysml");
  next.set("readable");
  equal(next.mode.value, "readable");
  equal(kept.get(VIEW_MODE_KEY), "readable");
});

Deno.test("the legacy view mode is copied and retained; a current choice wins", () => {
  const { storage, kept } = memory({ [LEGACY_VIEW_MODE_KEY]: "sysml" });
  const prefs = createViewPrefs(() => storage);
  prefs.restore();
  equal(prefs.mode.value, "sysml");
  equal(kept.get(LEGACY_VIEW_MODE_KEY), "sysml");
  equal(kept.get(VIEW_MODE_KEY), "sysml");
  prefs.set("readable");
  const next = createViewPrefs(() => storage);
  next.restore();
  equal(next.mode.value, "readable");
  equal(kept.get(LEGACY_VIEW_MODE_KEY), "sysml");
});

Deno.test("what is saved and is not a mode is no choice", () => {
  for (const saved of ["", "SysML", "xml", "null", " sysml", "readable "]) {
    const { storage } = memory({ [VIEW_MODE_KEY]: saved });
    const prefs = createViewPrefs(() => storage);
    prefs.restore();
    equal(prefs.mode.value, "readable", JSON.stringify(saved));
  }
  const { storage } = memory();
  const prefs = createViewPrefs(() => storage);
  prefs.restore();
  equal(prefs.mode.value, "readable");
});

Deno.test("without storage the choice lasts for the page: reading and writing refuse without a word", () => {
  const refusing = (): PrefsStorage => {
    throw new DOMException("blocked", "SecurityError");
  };
  const prefs = createViewPrefs(refusing);
  prefs.restore();
  equal(prefs.mode.value, "readable");
  prefs.set("sysml");
  equal(prefs.mode.value, "sysml");
  // Storage that exists but refuses to be read or written.
  const full: PrefsStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new DOMException("full", "QuotaExceededError");
    },
  };
  const other = createViewPrefs(() => full);
  other.restore();
  other.set("sysml");
  equal(other.mode.value, "sysml");
  other.set("readable");
  equal(other.mode.value, "readable");
});
