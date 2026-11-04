import {
  assertReleaseTagSelection,
  type ReleaseTagSelection,
} from "../../../src/domain/work/records/release-tags.ts";
import type { SavedSystemSourceSelection } from "../../../src/domain/work/records/saved-systems.ts";

/** Browser recovery data only. None of these values grants host authority. */
export interface ReleaseSaveCommand {
  saveKey: string;
  name: string;
  purpose: string;
  source: SavedSystemSourceSelection;
  /** Missing only for a previously accepted legacy command. */
  tag?: ReleaseTagSelection;
}
export interface ReleaseSaveHost {
  projectId: string;
  systemId: string;
}
export interface ReleaseSaveIntent {
  format: 1;
  host: ReleaseSaveHost;
  command: ReleaseSaveCommand;
}
export interface ReleaseIntentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface ReleaseSaveRecoveryOptions {
  host?: () => Promise<ReleaseSaveHost>;
  origin?: () => string;
  storage?: () => ReleaseIntentStorage;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string) =>
  Object.keys(v).sort().join(",") === expected;
const identity = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const hostIdentity = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 1024 &&
  v.trim() === v && v !== "*" &&
  // deno-lint-ignore no-control-regex -- Match the opaque host context contract.
  !/[\u0000-\u001f\u007f]/.test(v);
export function releaseSaveHost(v: unknown): v is ReleaseSaveHost {
  return object(v) && keys(v, "projectId,systemId") &&
    hostIdentity(v.projectId) && hostIdentity(v.systemId);
}
export function sameReleaseSource(
  a: SavedSystemSourceSelection,
  b: SavedSystemSourceSelection,
): boolean {
  return a.sourceVersion === b.sourceVersion &&
    a.branch.kind === b.branch.kind &&
    (a.branch.kind === "main" ||
      b.branch.kind === "case" && a.branch.caseId === b.branch.caseId);
}
export function sameReleaseTag(
  a?: ReleaseTagSelection,
  b?: ReleaseTagSelection,
): boolean {
  return a?.mode === b?.mode && a?.name === b?.name;
}
export function validReleaseSaveCommand(v: unknown): v is ReleaseSaveCommand {
  if (
    !object(v) ||
    !(keys(v, "name,purpose,saveKey,source") ||
      keys(v, "name,purpose,saveKey,source,tag")) ||
    !identity(v.saveKey) ||
    typeof v.name !== "string" || !v.name.trim() || v.name !== v.name.trim() ||
    v.name.length > 120 ||
    typeof v.purpose !== "string" || v.purpose !== v.purpose.trim() ||
    v.purpose.length > 2000 ||
    Array.from(v.name + v.purpose).some((c) => {
      const n = c.charCodeAt(0);
      return n <= 8 || n === 11 || n === 12 || n >= 14 && n <= 31;
    }) || !object(v.source) || !keys(v.source, "branch,sourceVersion") ||
    typeof v.source.sourceVersion !== "string" ||
    !/^commit:[a-f0-9]{40}$/.test(v.source.sourceVersion) ||
    !object(v.source.branch)
  ) return false;
  if ("tag" in v) {
    try {
      assertReleaseTagSelection(v.tag);
    } catch {
      return false;
    }
  }
  const b = v.source.branch;
  return b.kind === "main" && keys(b, "kind") ||
    b.kind === "case" && keys(b, "caseId,kind") && identity(b.caseId);
}
function decode(raw: string, host: ReleaseSaveHost): ReleaseSaveIntent {
  if (raw.length > 20_000) {
    throw new Error(
      "The Release creation request is unreadable; it was not replaced.",
    );
  }
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch { /* fail closed below */ }
  if (
    !object(v) || !keys(v, "command,format,host") || v.format !== 1 ||
    !releaseSaveHost(v.host) || v.host.projectId !== host.projectId ||
    v.host.systemId !== host.systemId ||
    !validReleaseSaveCommand(v.command)
  ) {
    throw new Error(
      "The Release creation request is unreadable; it was not replaced.",
    );
  }
  return v as unknown as ReleaseSaveIntent;
}
export async function currentReleaseSaveHost(): Promise<ReleaseSaveHost> {
  const response = await fetch("/api/request-space-openings/context", {
    credentials: "same-origin",
    cache: "no-store",
  });
  const value: unknown = await response.json();
  if (!response.ok || !releaseSaveHost(value)) {
    throw new Error("The Release host identity is unavailable.");
  }
  return value;
}
/** One active slot per host prevents edited fields or branch changes from
 * replacing an uncertain command. Canonical inspected records own acknowledged
 * retry identities; there is no second client registry. */
export function releaseSaveSlot(
  host: ReleaseSaveHost,
  origin: string,
  storage: ReleaseIntentStorage,
) {
  if (!releaseSaveHost(host) || new URL(origin).origin !== origin) {
    throw new Error("The Release host identity is unavailable.");
  }
  const key = `assembly-release-save:${
    JSON.stringify([origin, host.projectId, host.systemId])
  }`;
  function read(at = key) {
    const raw = storage.getItem(at);
    return raw === null ? null : decode(raw, host);
  }
  function same(a: ReleaseSaveIntent, b: ReleaseSaveIntent) {
    return a.command.saveKey === b.command.saveKey &&
      a.command.name === b.command.name &&
      a.command.purpose === b.command.purpose &&
      sameReleaseSource(a.command.source, b.command.source) &&
      sameReleaseTag(a.command.tag, b.command.tag);
  }
  return {
    read,
    write(intent: ReleaseSaveIntent) {
      const raw = JSON.stringify(intent);
      decode(raw, host);
      const previous = read();
      if (previous && !same(previous, intent)) {
        throw new Error(
          "Another Release intention is pending. Reopen its exact source before continuing.",
        );
      }
      storage.setItem(key, raw);
      if (storage.getItem(key) !== raw) {
        throw new Error(
          "The Release intention could not be stored. Nothing was sent.",
        );
      }
    },
    retire(intent: ReleaseSaveIntent) {
      const previous = read();
      if (!previous || !same(previous, intent)) {
        throw new Error(
          "The Release creation request changed; it was not removed.",
        );
      }
      storage.removeItem(key);
      if (storage.getItem(key) !== null) {
        throw new Error("The Release creation request could not be cleared.");
      }
    },
  };
}
