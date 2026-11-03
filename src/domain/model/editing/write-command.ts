import { assertClosedRecord } from "../../primitives/closed-record.ts";
import {
  type ArtifactSource,
  artifactSourceContentDigest,
  assertQueuedArtifactSourcePublication,
  type QueuedArtifactSourcePublication,
} from "../../work/artifacts/source-publication.ts";
import type { EvolutionAuthorityExercise } from "../evolution/policy.ts";
import { canonical } from "../../primitives/canonical-json.ts";
import {
  canonicalDigest,
  isSha256Hex,
} from "../../primitives/execution-digest.ts";
import type { EditTarget, HostEdit, IntroducedMember } from "./host-edit.ts";

function editTargetOf(edit: HostEdit): EditTarget {
  return edit.op === "insertMember" ? edit.owner : edit.target;
}
import {
  ModelRefError,
  type ModelRevisionRef,
  parseModelRevisionRef,
} from "../value-objects/element-ref.ts";
import { sameSysmlQualifiedName } from "../value-objects/sysml-qualified-name.ts";
import type { AuthorityExercise } from "../../governance/authority.ts";
import type {
  CandidateActivationPublication,
  ChangePublication,
} from "../publication/change.ts";
import type { Candidate } from "../../work/candidates.ts";
import type { PendingChange } from "../../governance/records/pending-change.ts";

/** Serializable write commands (W4) and the M1b operation journal.
 * Pure domain: identities, digests, admission of the durable dossier shape and
 * the replay applicability pre-check. No I/O, no native handle, no generation. */

/** Canonical immutable-commit identity (domain/model/value-objects/element-ref). The
 * persisted JSON shape is unchanged: `{repositoryId, version: "commit:…"}`;
 * boundaries validate it with `parseModelRevisionRef`. */
export type { ModelRevisionRef } from "../value-objects/element-ref.ts";

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
interface OperationJournalEntry {
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

export type ModelWriteOperations =
  | { readonly kind: "host-edits"; readonly journal: ModelOperationJournal }
  | { readonly kind: "whole-files"; readonly files: WholeFilesOperations }
  | {
    readonly kind: "artifact-source";
    readonly source: ArtifactSource;
    readonly base: ModelRevisionRef;
    readonly baseSourceDigest: string;
    readonly scopeId: string;
    readonly contentDigest: string;
  };

type ModelWriteCommandKind =
  | "accept-proposal"
  | "approved-change"
  | "activate-candidate"
  | "retain-artifact-source";

/** Serializable v1 write command. `commandId` is the durable business identity
 * (changeId / proposal id / activation changeId); digests bind the exact
 * operations and decision dossiers stored outside the build cache. */
export interface ModelWriteCommand {
  readonly v: 1;
  readonly repositoryId: string;
  readonly commandId: string;
  readonly kind: ModelWriteCommandKind;
  readonly approvedBase: ModelRevisionRef;
  readonly intentDigest: string;
  readonly operationsRef: { readonly digest: string };
  readonly decisionRef: { readonly id: string; readonly digest: string };
  readonly recipeDigest: string;
}

/** Durable proof captured when the command is built by the application from
 * admitted records. A client never supplies its own receipt. */
export type ModelWriteDecision =
  | {
    readonly kind: "retain-artifact-source";
    readonly publicationId: string;
    readonly target: QueuedArtifactSourcePublication["target"];
    readonly proof: QueuedArtifactSourcePublication["proof"];
    readonly upstream?: QueuedArtifactSourcePublication["upstream"];
  }
  | {
    readonly kind: "approved-change";
    readonly approval: ChangePublication;
    readonly change: PendingChange;
  }
  | {
    readonly kind: "activate-candidate";
    readonly approval: CandidateActivationPublication;
    /** Original tested/admitted candidate, required for new durable activations. */
    readonly candidate?: Candidate;
  }
  | {
    readonly kind: "accept-proposal";
    readonly proposalId: string;
    /** Exact HEAD approved by the acceptance decision. Absent only on old dossiers. */
    readonly expectedVersion?: string;
    readonly baseVersion: string;
    readonly proposalSourceDigest: string;
    readonly proposalVersion: string;
    readonly author: string;
    readonly decisionAuthorityExercise?: AuthorityExercise;
    readonly evolutionDecision?: EvolutionAuthorityExercise;
  };

/** The complete durable unit stored by the write queue, outside the build
 * cache and outside any Case. */
export interface ModelWriteDossier {
  readonly v: 1;
  readonly command: ModelWriteCommand;
  readonly operations: ModelWriteOperations;
  readonly decision: ModelWriteDecision;
}

/** Host writer bound (see adapters/host-source-writer applyEdits). */
const MAX_JOURNAL_OPERATIONS = 32;
/** Mirrors the domain source budgets without importing storage concerns. */
const MAX_WHOLE_FILES = 64;

export class ModelWriteCommandError extends Error {
  readonly recovery: "refuse";
  constructor(
    readonly code:
      | "WRITE_COMMAND_INVALID"
      | "WRITE_JOURNAL_INVALID"
      | "WRITE_DOSSIER_MISMATCH",
    readonly context: { readonly reason: string; readonly path?: string },
    message: string,
  ) {
    super(message);
    this.name = "ModelWriteCommandError";
    this.recovery = "refuse";
  }
}

function invalid(
  code: ModelWriteCommandError["code"],
  reason: string,
  path?: string,
): never {
  throw new ModelWriteCommandError(
    code,
    path ? { reason, path } : { reason },
    path ? `${reason}: ${path}` : reason,
  );
}

function requireText(
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

function requireDigest(
  value: unknown,
  path: string,
  code: ModelWriteCommandError["code"] = "WRITE_COMMAND_INVALID",
): string {
  if (!isSha256Hex(value)) {
    invalid(code, "Expected 64 lowercase hex characters", path);
  }
  return value as string;
}

function record(
  value: unknown,
  path: string,
  code: ModelWriteCommandError["code"],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(code, "Expected an object", path);
  }
  return value as Record<string, unknown>;
}

function closedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  code: ModelWriteCommandError["code"],
): void {
  assertClosedRecord(
    value,
    allowed,
    (key) => invalid(code, `Unexpected field ${key}`, path),
  );
}

function field(value: Record<string, unknown>, path: string): unknown {
  if (!Object.hasOwn(value, path)) {
    invalid("WRITE_COMMAND_INVALID", "Missing field", path);
  }
  return value[path];
}

function parseRevisionRef(
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

const COMMAND_KINDS: readonly string[] = [
  "accept-proposal",
  "approved-change",
  "activate-candidate",
  "retain-artifact-source",
];

/** Strict parse of the v1 command envelope: closed keys, hex digests. */
export function parseModelWriteCommand(value: unknown): ModelWriteCommand {
  const command = record(value, "", "WRITE_COMMAND_INVALID");
  closedKeys(
    command,
    [
      "v",
      "repositoryId",
      "commandId",
      "kind",
      "approvedBase",
      "intentDigest",
      "operationsRef",
      "decisionRef",
      "recipeDigest",
    ],
    "",
    "WRITE_COMMAND_INVALID",
  );
  if (field(command, "v") !== 1) {
    invalid("WRITE_COMMAND_INVALID", "Bad version", "v");
  }
  const kind = field(command, "kind");
  if (typeof kind !== "string" || !COMMAND_KINDS.includes(kind)) {
    invalid("WRITE_COMMAND_INVALID", "Bad kind", "kind");
  }
  const operationsRef = record(
    field(command, "operationsRef"),
    "operationsRef",
    "WRITE_COMMAND_INVALID",
  );
  closedKeys(
    operationsRef,
    ["digest"],
    "operationsRef",
    "WRITE_COMMAND_INVALID",
  );
  const decisionRef = record(
    field(command, "decisionRef"),
    "decisionRef",
    "WRITE_COMMAND_INVALID",
  );
  closedKeys(
    decisionRef,
    ["id", "digest"],
    "decisionRef",
    "WRITE_COMMAND_INVALID",
  );
  return {
    v: 1,
    repositoryId: requireText(
      field(command, "repositoryId"),
      "repositoryId",
      512,
    ),
    commandId: requireText(field(command, "commandId"), "commandId", 512),
    kind: kind as ModelWriteCommandKind,
    approvedBase: parseRevisionRef(
      field(command, "approvedBase"),
      "approvedBase",
    ),
    intentDigest: requireDigest(field(command, "intentDigest"), "intentDigest"),
    operationsRef: {
      digest: requireDigest(
        field(operationsRef, "digest"),
        "operationsRef.digest",
      ),
    },
    decisionRef: {
      id: requireText(field(decisionRef, "id"), "decisionRef.id", 512),
      digest: requireDigest(field(decisionRef, "digest"), "decisionRef.digest"),
    },
    recipeDigest: requireDigest(field(command, "recipeDigest"), "recipeDigest"),
  };
}

/** Intent identity: binds kind, approved base, operations, decision and recipe. */
export async function modelWriteIntentDigest(
  intent: Omit<ModelWriteCommand, "v" | "intentDigest">,
): Promise<string> {
  return await canonicalDigest({
    v: 1,
    repositoryId: intent.repositoryId,
    commandId: intent.commandId,
    kind: intent.kind,
    approvedBase: intent.approvedBase,
    operationsRef: intent.operationsRef,
    decisionRef: intent.decisionRef,
    recipeDigest: intent.recipeDigest,
  });
}

export async function modelWriteCommandDigest(
  command: ModelWriteCommand,
): Promise<string> {
  return await canonicalDigest(command);
}

export async function modelWriteOperationsDigest(
  operations: ModelWriteOperations,
): Promise<string> {
  return await canonicalDigest(operations);
}

export async function modelWriteDecisionDigest(
  decision: ModelWriteDecision,
): Promise<string> {
  return await canonicalDigest(decision);
}

export async function modelWriteDossierDigest(
  dossier: ModelWriteDossier,
): Promise<string> {
  return await canonicalDigest(dossier);
}

export async function operationJournalDigest(
  journal: ModelOperationJournal,
): Promise<string> {
  return await canonicalDigest(journal);
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

/** Full dossier admission: envelope, digests and kind coherence. This is the
 * domain gate every queue/store read-back passes before execution. */
export async function assertModelWriteDossier(
  dossier: ModelWriteDossier,
): Promise<void> {
  if (dossier.v !== 1) {
    invalid("WRITE_DOSSIER_MISMATCH", "Bad dossier version", "v");
  }
  const command = parseModelWriteCommand(dossier.command);
  if (canonical(command) !== canonical(dossier.command)) {
    invalid(
      "WRITE_DOSSIER_MISMATCH",
      "Command envelope is not in canonical v1 form",
    );
  }
  const { intentDigest: _intent, v: _v, ...intent } = command;
  if (await modelWriteIntentDigest(intent) !== command.intentDigest) {
    invalid(
      "WRITE_DOSSIER_MISMATCH",
      "Intent digest differs from the command",
      "intentDigest",
    );
  }
  if (
    await modelWriteOperationsDigest(dossier.operations) !==
      command.operationsRef.digest
  ) {
    invalid(
      "WRITE_DOSSIER_MISMATCH",
      "Operations digest differs from the command",
      "operationsRef",
    );
  }
  if (
    await modelWriteDecisionDigest(dossier.decision) !==
      command.decisionRef.digest
  ) {
    invalid(
      "WRITE_DOSSIER_MISMATCH",
      "Decision digest differs from the command",
      "decisionRef",
    );
  }
  if (dossier.decision.kind !== command.kind) {
    invalid(
      "WRITE_DOSSIER_MISMATCH",
      "Decision kind differs from the command",
      "kind",
    );
  }
  const operationsBase = dossier.operations.kind === "host-edits"
    ? dossier.operations.journal.base
    : dossier.operations.kind === "whole-files"
    ? dossier.operations.files.base
    : dossier.operations.base;
  if (
    operationsBase.repositoryId !== command.approvedBase.repositoryId ||
    operationsBase.version !== command.approvedBase.version ||
    command.approvedBase.repositoryId !== command.repositoryId
  ) {
    invalid(
      "WRITE_DOSSIER_MISMATCH",
      "Operations base differs from the approved base",
      "approvedBase",
    );
  }
  if (dossier.operations.kind === "host-edits") {
    assertOperationJournal(dossier.operations.journal);
  } else if (dossier.operations.kind === "whole-files") {
    assertWholeFilesOperations(dossier.operations.files);
  } else {
    try {
      const publication = artifactSourcePublicationFromDossier(dossier);
      await assertQueuedArtifactSourcePublication(
        publication,
        command.repositoryId,
      );
      requireText(
        dossier.operations.scopeId,
        "operations.scopeId",
        512,
        "WRITE_DOSSIER_MISMATCH",
      );
      requireDigest(
        dossier.operations.contentDigest,
        "operations.contentDigest",
        "WRITE_DOSSIER_MISMATCH",
      );
      if (
        await artifactSourceContentDigest(dossier.operations.source) !==
          dossier.operations.contentDigest
      ) {
        invalid(
          "WRITE_DOSSIER_MISMATCH",
          "Artifact content digest differs from its exact source",
          "operations.contentDigest",
        );
      }
    } catch (error) {
      if (error instanceof ModelWriteCommandError) throw error;
      invalid(
        "WRITE_DOSSIER_MISMATCH",
        "Artifact source intent is invalid or mismatched",
        "operations",
      );
    }
  }
  const decision = dossier.decision;
  if (decision.kind === "approved-change") {
    if (
      decision.approval.changeId !== command.commandId ||
      decision.change.id !== command.commandId ||
      command.decisionRef.id !== command.commandId
    ) {
      invalid(
        "WRITE_DOSSIER_MISMATCH",
        "Approved-change identity differs from the command",
        "decisionRef",
      );
    }
    if (decision.change.status !== "approved") {
      invalid(
        "WRITE_DOSSIER_MISMATCH",
        "Approved-change decision is not approved",
        "decision.change.status",
      );
    }
  } else if (decision.kind === "activate-candidate") {
    if (
      decision.approval.changeId !== command.commandId ||
      command.decisionRef.id !== command.commandId
    ) {
      invalid(
        "WRITE_DOSSIER_MISMATCH",
        "Activation identity differs from the command",
        "decisionRef",
      );
    }
  } else if (decision.kind === "retain-artifact-source") {
    if (
      dossier.operations.kind !== "artifact-source" ||
      decision.publicationId !== command.commandId ||
      command.decisionRef.id !== command.commandId
    ) {
      invalid(
        "WRITE_DOSSIER_MISMATCH",
        "Artifact publication identity differs from the command",
        "decisionRef",
      );
    }
  } else {
    if (
      decision.proposalId !== command.commandId ||
      command.decisionRef.id !== command.commandId ||
      decision.baseVersion !== command.approvedBase.version
    ) {
      invalid(
        "WRITE_DOSSIER_MISMATCH",
        "Proposal identity or base differs from the command",
        "decisionRef",
      );
    }
    if (decision.expectedVersion !== undefined) {
      try {
        parseModelRevisionRef({
          repositoryId: command.repositoryId,
          version: decision.expectedVersion,
        });
      } catch {
        invalid(
          "WRITE_DOSSIER_MISMATCH",
          "Acceptance expectedVersion is not a canonical immutable revision",
          "decision.expectedVersion",
        );
      }
    }
    requireDigest(
      decision.proposalSourceDigest,
      "decision.proposalSourceDigest",
      "WRITE_DOSSIER_MISMATCH",
    );
    requireText(
      decision.proposalVersion,
      "decision.proposalVersion",
      512,
      "WRITE_DOSSIER_MISMATCH",
    );
  }
}

/** Reconstruct exactly the captured request; no latest model, input or
 * authority is inferred from a stored source publication receipt. */
export function artifactSourcePublicationFromDossier(
  dossier: ModelWriteDossier,
): QueuedArtifactSourcePublication {
  const { operations, decision } = dossier;
  if (
    operations.kind !== "artifact-source" ||
    decision.kind !== "retain-artifact-source"
  ) {
    invalid(
      "WRITE_DOSSIER_MISMATCH",
      "Artifact source command requires its exact operations and decision",
      "kind",
    );
  }
  return {
    publicationId: decision.publicationId,
    source: structuredClone(operations.source),
    baseVersion: operations.base.version,
    baseSourceDigest: operations.baseSourceDigest,
    target: structuredClone(decision.target),
    proof: structuredClone(decision.proof),
    ...(decision.upstream
      ? { upstream: structuredClone(decision.upstream) }
      : {}),
  };
}

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
