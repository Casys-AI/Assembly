import { signal } from "@preact/signals";
import type { AgentConversation } from "../../../src/application/work/operators/conversation-types.ts";
import { messageCaseId } from "./cases.ts";
import { readBrowserPreference } from "../browser/preferences.ts";

/**
 * The latest activity of each Case the viewer did not write: what an agent,
 * a tool or the host added. ISO times, so they compare as strings.
 */
export function caseActivity(
  conversations: readonly AgentConversation[],
): Readonly<Record<string, string>> {
  const latest: Record<string, string> = {};
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      const caseId = messageCaseId(message);
      if (!caseId || message.role === "user") continue;
      if (!latest[caseId] || latest[caseId] < message.at) {
        latest[caseId] = message.at;
      }
    }
  }
  return latest;
}

/**
 * What the viewer has already seen of each Case, per system: the time of the
 * latest activity shown to them. Storage is a convenience, as for pins. When a
 * system has nothing stored yet, the activity already there counts as seen, so
 * only what happens afterwards lights a Case.
 */
export function createCaseSeen() {
  const seen = signal<Readonly<Record<string, string>>>({});
  // Nothing lights a Case before the viewer's record is known.
  const ready = signal(false);
  let key: string | null = null;
  let fresh = false;
  function save() {
    try {
      if (key) localStorage.setItem(key, JSON.stringify(seen.peek()));
    } catch {
      // Private windows and blocked storage keep this for the page only.
    }
  }
  function load(systemId: string | null | undefined) {
    const next = systemId ? `assembly:seen:${systemId}` : null;
    if (next === key) return;
    key = next;
    let stored: unknown = null;
    try {
      const raw = key
        ? readBrowserPreference(() => localStorage, key, `ase:seen:${systemId}`)
        : null;
      stored = raw === null ? null : JSON.parse(raw);
    } catch {
      stored = null;
    }
    fresh = stored === null;
    ready.value = Boolean(key) && !fresh;
    seen.value = stored && typeof stored === "object" && !Array.isArray(stored)
      ? Object.fromEntries(
        Object.entries(stored).filter((entry): entry is [string, string] =>
          typeof entry[1] === "string"
        ),
      )
      : {};
  }
  /** On a system's first load, everything already there is seen. */
  function baseline(activity: Readonly<Record<string, string>>) {
    if (!fresh || !key) return;
    fresh = false;
    seen.value = { ...activity, ...seen.peek() };
    ready.value = true;
    save();
  }
  function mark(caseId: string, at: string | undefined) {
    const known = seen.peek()[caseId];
    if (!at || (known && known >= at)) return;
    seen.value = { ...seen.peek(), [caseId]: at };
    save();
  }
  function unseen(caseId: string, at: string | undefined): boolean {
    if (!ready.value) return false;
    const known = seen.value[caseId];
    return Boolean(at) && (!known || known < at!);
  }
  return { seen, load, baseline, mark, unseen };
}
export type CaseSeen = ReturnType<typeof createCaseSeen>;
