import { isSha256Hex } from "../../primitives/execution-digest.ts";
import type { EditTarget, HostEdit, IntroducedMember } from "./host-edit.ts";
import {
  ModelRefError,
  type ModelRevisionRef,
  parseModelRevisionRef,
} from "../value-objects/element-ref.ts";
import { invalid, type ModelWriteCommandError } from "./write-command-error.ts";

function editTargetOf(edit: HostEdit): EditTarget {
  return edit.op === "insertMember" ? edit.owner : edit.target;
}

/** One element incarnation in a revision: identity plus its exact member
 * preimage digest (`EditTarget.preimage`, sha256 of the member source text).
 * A deleted-then-recreated element with different text is another incarnation;
 * qualified name and metaclass are preconditions, never identity substitutes. */
export interface ElementIncarnationRef {
  readonly nativeId: string;
  readonly qualifiedName: string;
  readonly metaclass: string;
  readonly preimageDigest: string;
  readonly ownerNativeId?: string;
}

/** One ordered, durable host operation with the incarnations it depends on
 * and produces. The edit itself carries the exact target preimage. */
export interface OperationJournalEntry {
  readonly seq: number;
  readonly edit: HostEdit;
  /** Target (or insert owner) as resolved against the journal chain. */
  readonly target: ElementIncarnationRef;
  /** Creations introduced by this operation (insertMember). Their native ids
   * are those of the approved candidate; on another base they stay journal-local. */
  readonly introduced?: readonly ElementIncarnationRef[];
  /** The removed incarnation (remove). */
  readonly removed?: ElementIncarnationRef;
}

/** M1b: the closed, ordered journal captured at preparation time. Replay uses
 * this payload exactly; templates are never regenerated after a crash. */
export interface ModelOperationJournal {
  readonly v: 1;
  readonly base: ModelRevisionRef;
  readonly baseSourceDigest: string;
  readonly entries: readonly OperationJournalEntry[];
  /** Cumulative toolkit id renames, order preserved: [before, after]. */
  readonly idMap: readonly (readonly [string, string])[];
}

/** Explicit whole-files variant: full file texts with per-file base preimages.
 * Replayable only file-by-file under controlled merge and revalidation. */
interface WholeFileOperation {
  readonly path: string;
  /** sha256 of the base file text; null when the file is absent in the base. */
  readonly baseDigest: string | null;
  /** Complete new file text; null deletes the file. */
  readonly text: string | null;
}
export interface WholeFilesOperations {
  readonly v: 1;
  readonly base: ModelRevisionRef;
  readonly baseSourceDigest: string;
  readonly files: readonly WholeFileOperation[];
}

/** Host writer bound (see adapters/host-source-writer applyEdits). */
const MAX_JOURNAL_OPERATIONS = 32;
/** Mirrors the domain source budgets without importing storage concerns. */
const MAX_WHOLE_FILES = 64;

export function requireText(
  value: unknown,
  path: string,
  limit: number,
  code: ModelWriteCommandError["code"] = "WRITE_COMMAND_INVALID",
): string {
  if (typeof value !== "string" || !value || value.length > limit) {
    invalid(code, `Expected 1–${limit} characters`, path);
  }
  return value as string;
}

export function requireDigest(
  value: unknown,
  path: string,
  code: ModelWriteCommandError["code"] = "WRITE_COMMAND_INVALID",
): string {
  if (!isSha256Hex(value)) {
    invalid(code, "Expected 64 lowercase hex characters", path);
  }
  return value as string;
}

export function parseRevisionRef(
  value: unknown,
  path: string,
  code: ModelWriteCommandError["code"] = "WRITE_COMMAND_INVALID",
): ModelRevisionRef {
  try {
    return parseModelRevisionRef(value);
  } catch (error) {
    if (error instanceof ModelRefError) {
      invalid(
        code,
        error.context.reason,
        error.context.path ? `${path}.${error.context.path}` : path,
      );
    }
    throw error;
  }
}

function assertRevisionRef(
  value: ModelRevisionRef,
  path: string,
  code: ModelWriteCommandError["code"],
): void {
  parseRevisionRef(value, path, code);
}

function incarnationOf(edit: HostEdit): ElementIncarnationRef {
  const target = editTargetOf(edit);
  return {
    nativeId: target.id,
    qualifiedName: target.qualifiedName,
    metaclass: target.metaclass,
    preimageDigest: target.preimage,
    ...(target.ownerId !== undefined ? { ownerNativeId: target.ownerId } : {}),
  };
}

/** Build the closed M1b journal from durable edits resolved on the approved
 * base (as produced by the host writer) plus the toolkit id renames and the
 * candidate-resolved identities of introduced members. `introducedIds` maps an
 * introduced qualified name to its candidate native id and preimage digest;
 * without it the introduced incarnation records name/metaclass only and keeps
 * an empty native id marked by an empty digest — callers that can resolve the
 * candidate must supply it. */
export function buildOperationJournal(input: {
  base: ModelRevisionRef;
  baseSourceDigest: string;
  edits: readonly HostEdit[];
  idMap?: readonly (readonly [string, string])[];
  introducedIds?: ReadonlyMap<
    string,
    { nativeId: string; preimageDigest: string }
  >;
}): ModelOperationJournal {
  requireDigest(
    input.baseSourceDigest,
    "baseSourceDigest",
    "WRITE_JOURNAL_INVALID",
  );
  if (
    !Array.isArray(input.edits) || input.edits.length < 1 ||
    input.edits.length > MAX_JOURNAL_OPERATIONS
  ) {
    invalid(
      "WRITE_JOURNAL_INVALID",
      `Expected 1–${MAX_JOURNAL_OPERATIONS} journal operations`,
      "edits",
    );
  }
  const entries: OperationJournalEntry[] = input.edits.map((edit, seq) => {
    const target = incarnationOf(edit);
    const introduced = edit.op === "insertMember"
      ? (edit.introduced ?? []).map((member: IntroducedMember) => {
        const resolved = input.introducedIds?.get(member.qualifiedName);
        return {
          nativeId: resolved?.nativeId ?? "",
          qualifiedName: member.qualifiedName,
          metaclass: member.metaclass,
          preimageDigest: resolved?.preimageDigest ?? "",
        };
      })
      : undefined;
    return {
      seq,
      edit: structuredClone(edit),
      target,
      ...(introduced !== undefined ? { introduced } : {}),
      ...(edit.op === "remove" ? { removed: target } : {}),
    };
  });
  const journal: ModelOperationJournal = {
    v: 1,
    base: { ...input.base },
    baseSourceDigest: input.baseSourceDigest,
    entries,
    idMap: (input.idMap ?? []).map(([from, to]) =>
      [from, to] as readonly [string, string]
    ),
  };
  assertOperationJournal(journal);
  return journal;
}

function assertIncarnation(
  value: ElementIncarnationRef,
  path: string,
  { allowUnresolved = false }: { allowUnresolved?: boolean } = {},
): void {
  requireText(
    value.qualifiedName,
    `${path}.qualifiedName`,
    4096,
    "WRITE_JOURNAL_INVALID",
  );
  requireText(
    value.metaclass,
    `${path}.metaclass`,
    256,
    "WRITE_JOURNAL_INVALID",
  );
  if (allowUnresolved && value.nativeId === "" && value.preimageDigest === "") {
    return;
  }
  requireText(value.nativeId, `${path}.nativeId`, 512, "WRITE_JOURNAL_INVALID");
  requireDigest(
    value.preimageDigest,
    `${path}.preimageDigest`,
    "WRITE_JOURNAL_INVALID",
  );
}

/** Structural admission of a journal read back from durable storage. */
export function assertOperationJournal(journal: ModelOperationJournal): void {
  if (journal.v !== 1) invalid("WRITE_JOURNAL_INVALID", "Bad version", "v");
  assertRevisionRef(journal.base, "base", "WRITE_JOURNAL_INVALID");
  requireDigest(
    journal.baseSourceDigest,
    "baseSourceDigest",
    "WRITE_JOURNAL_INVALID",
  );
  if (
    !Array.isArray(journal.entries) || journal.entries.length < 1 ||
    journal.entries.length > MAX_JOURNAL_OPERATIONS
  ) {
    invalid(
      "WRITE_JOURNAL_INVALID",
      "Expected ordered journal entries",
      "entries",
    );
  }
  for (const [index, entry] of journal.entries.entries()) {
    const path = `entries[${index}]`;
    if (entry.seq !== index) {
      invalid(
        "WRITE_JOURNAL_INVALID",
        "Journal entries must be ordered and contiguous",
        path,
      );
    }
    assertIncarnation(entry.target, `${path}.target`);
    const editTarget = editTargetOf(entry.edit);
    if (
      editTarget.id !== entry.target.nativeId ||
      editTarget.preimage !== entry.target.preimageDigest
    ) {
      invalid(
        "WRITE_JOURNAL_INVALID",
        "Journal target differs from the durable edit preimage",
        path,
      );
    }
    for (
      const [memberIndex, member] of (entry.introduced ?? []).entries()
    ) {
      assertIncarnation(member, `${path}.introduced[${memberIndex}]`, {
        allowUnresolved: true,
      });
    }
    if (entry.edit.op === "remove") {
      if (!entry.removed || entry.removed.nativeId !== entry.target.nativeId) {
        invalid(
          "WRITE_JOURNAL_INVALID",
          "Removal must record its incarnation",
          path,
        );
      }
    } else if (entry.removed !== undefined) {
      invalid(
        "WRITE_JOURNAL_INVALID",
        "Only a removal records a removed incarnation",
        path,
      );
    }
  }
  for (const [index, pair] of journal.idMap.entries()) {
    if (
      !Array.isArray(pair) || pair.length !== 2 ||
      typeof pair[0] !== "string" || !pair[0] ||
      typeof pair[1] !== "string" || !pair[1]
    ) {
      invalid(
        "WRITE_JOURNAL_INVALID",
        "Expected id rename pairs",
        `idMap[${index}]`,
      );
    }
  }
}

export function assertWholeFilesOperations(files: WholeFilesOperations): void {
  if (files.v !== 1) invalid("WRITE_JOURNAL_INVALID", "Bad version", "v");
  assertRevisionRef(files.base, "base", "WRITE_JOURNAL_INVALID");
  requireDigest(
    files.baseSourceDigest,
    "baseSourceDigest",
    "WRITE_JOURNAL_INVALID",
  );
  if (
    !Array.isArray(files.files) || files.files.length < 1 ||
    files.files.length > MAX_WHOLE_FILES
  ) {
    invalid("WRITE_JOURNAL_INVALID", "Expected whole-file operations", "files");
  }
  const paths = new Set<string>();
  for (const [index, file] of files.files.entries()) {
    const path = `files[${index}]`;
    requireText(file.path, `${path}.path`, 512, "WRITE_JOURNAL_INVALID");
    if (paths.has(file.path)) {
      invalid("WRITE_JOURNAL_INVALID", "Duplicate whole-file path", path);
    }
    paths.add(file.path);
    if (file.baseDigest !== null) {
      requireDigest(
        file.baseDigest,
        `${path}.baseDigest`,
        "WRITE_JOURNAL_INVALID",
      );
    }
    if (file.text !== null && typeof file.text !== "string") {
      invalid(
        "WRITE_JOURNAL_INVALID",
        "Expected file text or null",
        `${path}.text`,
      );
    }
  }
}
