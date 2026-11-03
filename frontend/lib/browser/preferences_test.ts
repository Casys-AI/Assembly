import { deepStrictEqual, equal } from "node:assert/strict";
import {
  LEGACY_NATIVE_GRAPH_OPTIONS_KEY,
  LEGACY_SEQUENCE_ORIGIN_KEY,
  NATIVE_GRAPH_OPTIONS_KEY,
  type PreferenceStorage,
  readBrowserPreference,
  SEQUENCE_ORIGIN_KEY,
} from "./preferences.ts";

Deno.test("native graph and sequence preferences copy legacy bytes without removing them", () => {
  for (
    const [key, legacyKey, value] of [
      [
        NATIVE_GRAPH_OPTIONS_KEY,
        LEGACY_NATIVE_GRAPH_OPTIONS_KEY,
        '{ "view": "sequence", "sequenceId": "native:unchanged" }',
      ],
      [SEQUENCE_ORIGIN_KEY, LEGACY_SEQUENCE_ORIGIN_KEY, "observed"],
    ]
  ) {
    const entries = new Map([[legacyKey, value]]);
    const storage: PreferenceStorage = {
      getItem: (name) => entries.get(name) ?? null,
      setItem: (name, saved) => void entries.set(name, saved),
    };
    equal(readBrowserPreference(() => storage, key, legacyKey), value);
    deepStrictEqual([...entries], [[legacyKey, value], [key, value]]);
  }
});

Deno.test("a defined current browser preference wins, including an empty value", () => {
  for (const current of ["", "native", "unrecognized"]) {
    const entries = new Map([
      [SEQUENCE_ORIGIN_KEY, current],
      [LEGACY_SEQUENCE_ORIGIN_KEY, "observed"],
    ]);
    const storage: PreferenceStorage = {
      getItem: (name) => entries.get(name) ?? null,
      setItem: () => {
        throw new Error("must not overwrite an existing preference");
      },
    };
    equal(
      readBrowserPreference(
        () => storage,
        SEQUENCE_ORIGIN_KEY,
        LEGACY_SEQUENCE_ORIGIN_KEY,
      ),
      current,
    );
    equal(entries.get(LEGACY_SEQUENCE_ORIGIN_KEY), "observed");
  }
});

Deno.test("read-only browser storage can supply a legacy preference", () => {
  const storage: PreferenceStorage = {
    getItem: (key) => key === LEGACY_SEQUENCE_ORIGIN_KEY ? "native" : null,
    setItem: () => {
      throw new DOMException("full", "QuotaExceededError");
    },
  };
  equal(
    readBrowserPreference(
      () => storage,
      SEQUENCE_ORIGIN_KEY,
      LEGACY_SEQUENCE_ORIGIN_KEY,
    ),
    "native",
  );
});

Deno.test("missing and blocked browser storage leave the caller its default", () => {
  const unavailable = () => {
    throw new DOMException("blocked", "SecurityError");
  };
  equal(readBrowserPreference(unavailable, "assembly:key", "ase:key"), null);
  const blocked: PreferenceStorage = {
    getItem: unavailable,
    setItem: unavailable,
  };
  equal(readBrowserPreference(() => blocked, "assembly:key", "ase:key"), null);
  const empty: PreferenceStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("nothing should be written");
    },
  };
  equal(readBrowserPreference(() => empty, "assembly:key", "ase:key"), null);
});
