import {
  assertOperationJournal,
  assertWholeFilesOperations,
  type ElementIncarnationRef,
  type ModelOperationJournal,
  type OperationJournalEntry,
  type WholeFilesOperations,
} from "./operation-journal.ts";
import { sameSysmlQualifiedName } from "../value-objects/sysml-qualified-name.ts";

/** Incarnation inventory of an execution base, supplied by an adapter. */
export interface IncarnationInventory {
  readonly incarnations: readonly ElementIncarnationRef[];
  /** Every qualified name present in the base (creation collision checks). */
  readonly qualifiedNames: readonly string[];
}

type JournalReplayBlockCode =
  | "TARGET_MISSING"
  | "INCARNATION_CHANGED"
  | "TARGET_REMOVED"
  | "NAME_COLLISION"
  | "METACLASS_CHANGED";
export interface JournalReplayBlock {
  readonly seq: number;
  readonly code: JournalReplayBlockCode;
  readonly nativeId: string;
  readonly qualifiedName: string;
}
type JournalReplayPlan =
  | { readonly applicable: true; readonly touchesBase: readonly string[] }
  | { readonly applicable: false; readonly block: JournalReplayBlock };

/** Follow an id through the recorded renames to its journal origin. */
function originId(
  id: string,
  idMap: readonly (readonly [string, string])[],
): string {
  let current = id;
  const seen = new Set<string>([current]);
  for (let guard = 0; guard <= idMap.length; guard++) {
    const pair = idMap.find(([, after]) => after === current);
    if (!pair || seen.has(pair[0])) return current;
    current = pair[0];
    seen.add(current);
  }
  return current;
}

/** Pure applicability pre-check of an M1b journal on another base.
 * First touch of a base element requires the exact incarnation (native id and
 * preimage digest); later operations on that element, and operations on
 * journal-introduced elements, form a chain whose exact texts the executor
 * re-verifies. There is never a name-based fallback for a base target. */
export function planJournalReplay(
  journal: ModelOperationJournal,
  inventory: IncarnationInventory,
): JournalReplayPlan {
  assertOperationJournal(journal);
  const byId = new Map(
    inventory.incarnations.map((ref) => [ref.nativeId, ref]),
  );
  const liveNames = new Set(inventory.qualifiedNames);
  const touched = new Set<string>();
  const introducedNames: string[] = [];
  const introducedIds = new Set<string>();
  const removedIds = new Set<string>();
  const touchesBase: string[] = [];
  const block = (
    entry: OperationJournalEntry,
    code: JournalReplayBlockCode,
  ): JournalReplayPlan => ({
    applicable: false,
    block: {
      seq: entry.seq,
      code,
      nativeId: entry.target.nativeId,
      qualifiedName: entry.target.qualifiedName,
    },
  });
  for (const entry of journal.entries) {
    const target = entry.target;
    const origin = originId(target.nativeId, journal.idMap);
    const known = byId.get(origin) ?? byId.get(target.nativeId);
    const introduced = introducedIds.has(target.nativeId) ||
      introducedNames.some((name) =>
        sameSysmlQualifiedName(name, target.qualifiedName)
      );
    if (removedIds.has(origin) && !introduced) {
      return block(entry, "TARGET_REMOVED");
    }
    if (!introduced) {
      if (!known) return block(entry, "TARGET_MISSING");
      if (known.metaclass !== target.metaclass) {
        return block(entry, "METACLASS_CHANGED");
      }
      if (!touched.has(origin)) {
        if (known.preimageDigest !== target.preimageDigest) {
          return block(entry, "INCARNATION_CHANGED");
        }
        touched.add(origin);
        touchesBase.push(origin);
      }
    }
    if (entry.edit.op === "remove") {
      removedIds.add(origin);
      for (const name of [...liveNames]) {
        if (sameSysmlQualifiedName(name, target.qualifiedName)) {
          liveNames.delete(name);
        }
      }
      const introducedIndex = introducedNames.findIndex((name) =>
        sameSysmlQualifiedName(name, target.qualifiedName)
      );
      if (introducedIndex >= 0) introducedNames.splice(introducedIndex, 1);
      introducedIds.delete(target.nativeId);
    }
    for (const member of entry.introduced ?? []) {
      const collides = [...liveNames].some((name) =>
        sameSysmlQualifiedName(name, member.qualifiedName)
      ) || introducedNames.some((name) =>
        sameSysmlQualifiedName(name, member.qualifiedName)
      );
      if (collides) {
        return {
          applicable: false,
          block: {
            seq: entry.seq,
            code: "NAME_COLLISION",
            nativeId: member.nativeId,
            qualifiedName: member.qualifiedName,
          },
        };
      }
      introducedNames.push(member.qualifiedName);
      if (member.nativeId) {
        introducedIds.add(member.nativeId);
      }
    }
  }
  return { applicable: true, touchesBase };
}

interface WholeFilesReplayPlan {
  readonly applicable: boolean;
  /** Paths whose execution-base content no longer matches the recorded preimage. */
  readonly conflicts: readonly string[];
}

/** Per-file preimage check: disjoint concurrent file changes stay applicable,
 * a differently changed target file blocks. `currentDigests` maps a path to
 * the sha256 of its current text; absence means the file does not exist. */
export function planWholeFilesReplay(
  operations: WholeFilesOperations,
  currentDigests: ReadonlyMap<string, string>,
): WholeFilesReplayPlan {
  assertWholeFilesOperations(operations);
  const conflicts: string[] = [];
  for (const file of operations.files) {
    const current = currentDigests.get(file.path) ?? null;
    if (current !== file.baseDigest) conflicts.push(file.path);
  }
  return { applicable: conflicts.length === 0, conflicts };
}
