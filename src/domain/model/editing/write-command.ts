import { assertClosedRecord } from "../../primitives/closed-record.ts";
import {
  type ArtifactSource,
  artifactSourceContentDigest,
  assertQueuedArtifactSourcePublication,
  type QueuedArtifactSourcePublication,
} from "../../work/artifacts/source-publication.ts";
import type { EvolutionAuthorityExercise } from "../evolution/policy.ts";
import { canonical } from "../../primitives/canonical-json.ts";
import { canonicalDigest } from "../../primitives/execution-digest.ts";
import { invalid, ModelWriteCommandError } from "./write-command-error.ts";
import {
  assertOperationJournal,
  assertWholeFilesOperations,
  type ModelOperationJournal,
  parseRevisionRef,
  requireDigest,
  requireText,
  type WholeFilesOperations,
} from "./operation-journal.ts";
import {
  type ModelRevisionRef,
  parseModelRevisionRef,
} from "../value-objects/element-ref.ts";
import type { AuthorityExercise } from "../../governance/authority.ts";
import type {
  CandidateActivationPublication,
  ChangePublication,
} from "../publication/change.ts";
import type { Candidate } from "../../work/records/candidates.ts";
import type { PendingChange } from "../../governance/records/pending-change.ts";

/** Serializable write commands (W4) and the M1b operation journal.
 * Pure domain: identities, digests, admission of the durable dossier shape and
 * the replay applicability pre-check. No I/O, no native handle, no generation. */

/** Canonical immutable-commit identity (domain/model/value-objects/element-ref). The
 * persisted JSON shape is unchanged: `{repositoryId, version: "commit:…"}`;
 * boundaries validate it with `parseModelRevisionRef`. */
export type { ModelRevisionRef } from "../value-objects/element-ref.ts";

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
