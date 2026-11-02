/** Browser preferences remain optional and keep their historical values. */
export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export const NATIVE_GRAPH_OPTIONS_KEY = "assembly-native-sysml-views-v2";
export const LEGACY_NATIVE_GRAPH_OPTIONS_KEY = "ase-native-sysml-views-v2";
export const SEQUENCE_ORIGIN_KEY = "assembly-sequence-feed-origin-v1";
export const LEGACY_SEQUENCE_ORIGIN_KEY = "ase-sequence-feed-origin-v1";

/**
 * Read the current key first, then copy a legacy value only when it is absent.
 * Preserve exact legacy bytes and leave the old entry available to old clients.
 */
export function readBrowserPreference(
  storage: () => PreferenceStorage,
  key: string,
  legacyKey: string,
): string | null {
  try {
    const store = storage();
    const current = store.getItem(key);
    if (current !== null) return current;
    const legacy = store.getItem(legacyKey);
    if (legacy !== null) {
      try {
        store.setItem(key, legacy);
      } catch {
        // A full or read-only store can still supply the preference this time.
      }
    }
    return legacy;
  } catch {
    // SSR, private windows and blocked storage use the caller's default.
    return null;
  }
}
