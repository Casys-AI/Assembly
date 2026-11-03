/** Closed, host-authenticated control receipts. Delivery never grants authority. */
import type { CandidateDecisionInput } from "../candidates/decisions.ts";
import type { CandidateDelegatedActor } from "../../../domain/governance/policies/tool-admission-policy.ts";
import type {
  InitialToolsPreparationReference,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import { characterCount } from "../../../domain/primitives/character-count.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  executionDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";
import { OperatorAuthorityError } from "../../../domain/governance/operator-authority.ts";
import type { OperatorCommandOutcome } from "../../../domain/work/records/operator-command-outcome.ts";
import type {
  NativeExecutionIdentity,
  RuntimeRevisionReference,
} from "../runtime/execution.ts";
import type {
  OperatorDeliveryReceipt,
  OperatorExecutionDelivery,
  OperatorExecutionDispatchPort,
} from "./execution.ts";

export interface OperatorCommandOrigin {
  businessRevision: RuntimeRevisionReference;
  /** Actual originating native effect, never a client invented correlation. */
  effectKey: string;
  inputMessageId: string;
  inspectionMessageId?: string;
}

/** A native command action parks only its own exact source contribution. */
export class OperatorCommandPending extends Error {
  constructor(
    readonly receipt: OperatorDeliveryReceipt,
    readonly origin: OperatorCommandOrigin,
  ) {
    super("The target operator command is waiting for its durable worker");
    this.name = "OperatorCommandPending";
  }
}

export type ScheduledCaseTrigger = { kind: "manual" } | {
  kind: "due";
  scheduledAt: string;
};
export type OperatorControlCommand =
  | {
    kind: "prepare-initial-tools";
    preparation: InitialToolsPreparationReference;
  }
  | { kind: "resume-decided-changes"; candidatesOnly: boolean }
  | {
    kind: "resume-candidate-continuation";
    candidateId: string;
    invocationKey: string;
    inputMessageId: string;
    continuationDigest: string;
  }
  | {
    kind: "run-scheduled-case";
    caseId: string;
    trigger: ScheduledCaseTrigger;
  }
  | {
    kind: "decide-candidate";
    input: CandidateDecisionInput;
    delegated?: CandidateDelegatedActor;
  }
  | {
    kind: "decide-change";
    input: {
      changeId: string;
      expectedRevision: number;
      verdict: "approve" | "refuse";
    };
    delegated?: CandidateDelegatedActor;
  }
  | {
    kind: "watch-notification";
    notice: NonNullable<SystemRuntimeState["watchNotifications"]>[number];
  };

export interface AcceptedOperatorCommand {
  id: string;
  identity: NativeExecutionIdentity;
  modelPin: OperatorExecutionDelivery["modelPin"];
  command: OperatorControlCommand;
  origin?: OperatorCommandOrigin;
  /** Immutable host-captured target verdict before durable queue acceptance. */
  decisionBaseline?: {
    format: "operator-command-decision-baseline/v1";
    digest: string;
  };
}

/** Snapshot only the exact command's durable business decision before dispatch.
 * An unchanged historical verdict is not a result of this new command. */
export function commandBusinessDecision(
  state:
    & Pick<SystemRuntimeState, "configuration" | "candidates">
    & Partial<Pick<SystemRuntimeState, "events">>,
  command: OperatorControlCommand,
): string {
  if (command.kind === "decide-change") {
    const change = state.configuration?.changes.find((value) =>
      value.id === command.input.changeId
    );
    return canonical({
      change: change
        ? {
          status: change.status,
          decidedAt: change.decidedAt,
          authorityExercise: change.authorityExercise,
        }
        : null,
      decisionEvents: (state.events ?? []).filter((event) =>
        event.changeId === command.input.changeId &&
        [
          "configuration-change-refused",
          "configuration-change-completed",
          "mandate-revised",
          "reviewer-created",
        ].includes(event.kind)
      ).map((event) => event.id),
    });
  }
  if (command.kind === "decide-candidate") {
    const candidate = state.candidates.find((value) =>
      value.id === command.input.candidateId
    );
    return canonical({
      candidate: candidate
        ? { admissionDecision: candidate.admissionDecision }
        : null,
      decisionEvents: (state.events ?? []).filter((event) =>
        event.candidateId === command.input.candidateId &&
        [
          "admission-decided",
          "delegated-admission-decided",
          "human-admission-decided",
        ].includes(event.kind)
      ).map((event) => event.id),
    });
  }
  return canonical(null);
}

/** A first-acceptance race may reuse only the exact winning target/source
 * intent. Its immutable baseline is deliberately read from the winner. */
export function sameAcceptedCommandIntent(
  left: AcceptedOperatorCommand,
  right: AcceptedOperatorCommand,
): boolean {
  const intent = (value: AcceptedOperatorCommand) => ({
    id: value.id,
    identity: value.identity,
    modelPin: value.modelPin,
    command: value.command,
    origin: value.origin,
  });
  return canonical(intent(left)) === canonical(intent(right));
}

/** Read only an exact canonical command result. Legacy success events retain
 * their historical meaning; a missing/invalid refusal is never inferred. */
export async function recordedCommandOutcome(
  state: Pick<SystemRuntimeState, "events" | "revision">,
  accepted: AcceptedOperatorCommand,
) {
  const matches = state.events.filter((event) =>
    event.id === `operator-command-completed:${accepted.id}`
  );
  if (!matches.length) return undefined;
  if (matches.length !== 1) {
    throw new Error("Ambiguous canonical command result");
  }
  const event = matches[0], outcome = event.operatorCommandOutcome;
  if (!outcome) {
    if (event.kind !== "operator-command-completed") {
      throw new Error("The command has no typed refusal receipt");
    }
    return { event, outcome: undefined };
  }
  const body = record(outcome);
  keys(body, ["format", "acceptedDigest", "revision", "result"]);
  if (
    outcome.format !== "operator-command-outcome/v1" ||
    outcome.acceptedDigest !== await executionDigest(accepted) ||
    !Number.isSafeInteger(outcome.revision) || outcome.revision < 1 ||
    outcome.revision > state.revision
  ) throw new Error("The command result does not match its accepted intent");
  const result = record(outcome.result);
  if (result.status === "succeeded") {
    keys(result, ["status"]);
    if (event.kind !== "operator-command-completed") {
      throw new Error("Invalid command success receipt");
    }
  } else {
    keys(result, ["status", "refusal"]);
    const refusal = record(result.refusal);
    keys(refusal, ["kind", "code", "message", "context", "recovery"]);
    const codes: readonly OperatorAuthorityError["code"][] = [
      "INVALID_AUTHORITY_POLICY",
      "AUTHORITY_POLICY_FORBIDDEN",
      "AUTHORITY_POLICY_STALE",
      "AUTHORITY_REQUEST_STALE",
      "AUTHORITY_OUT_OF_BOUNDS",
      "AUTHORITY_RECEIPT_MISMATCH",
      "INVALID_MODEL_EDIT_GRANT",
      "INVALID_OPERATOR_REQUEST",
      "CHANGE_PREVIEW_MISMATCH",
      "OPERATOR_OPEN_FAILED",
      "OPERATOR_CAPACITY_EXCEEDED",
    ];
    const context = record(refusal.context),
      recovery = record(refusal.recovery);
    keys(recovery, ["action"]);
    if (
      result.status !== "refused" ||
      event.kind !== "operator-command-refused" ||
      refusal.kind !== "operator-authority" ||
      !codes.includes(refusal.code as OperatorAuthorityError["code"]) ||
      typeof refusal.message !== "string" || !refusal.message ||
      recovery.action !== "refuse-and-repropose" ||
      Object.values(context).some((value) =>
        typeof value !== "string" &&
        !(Array.isArray(value) &&
          value.every((item) => typeof item === "string"))
      )
    ) {
      throw new Error("Invalid typed command refusal receipt");
    }
  }
  return { event, outcome: structuredClone(outcome) };
}

export function commandRefusal(
  error: OperatorAuthorityError,
): Extract<OperatorCommandOutcome["result"], { status: "refused" }> {
  return {
    status: "refused",
    refusal: {
      kind: "operator-authority",
      code: error.code,
      message: error.message,
      context: structuredClone(error.context),
      recovery: structuredClone(error.recovery),
    },
  };
}

export function throwCommandRefusal(
  outcome: OperatorCommandOutcome | undefined,
): void {
  if (outcome?.result.status === "refused") {
    const refusal = outcome.result.refusal;
    throw new OperatorAuthorityError(
      refusal.code,
      refusal.message,
      structuredClone(refusal.context),
    );
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed operator control receipt");
  }
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): void {
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) =>
      !required.includes(key) && !optional.includes(key)
    )
  ) {
    throw new Error("Unexpected operator control receipt fields");
  }
}
function text(value: unknown, max = 2048): asserts value is string {
  if (
    typeof value !== "string" || !value.trim() || value.length > max ||
    [...value].some((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  ) throw new Error("Invalid operator control receipt text");
}
function revision(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("Invalid operator control revision");
  }
}
function verdict(value: unknown): void {
  if (value !== "approve" && value !== "refuse") {
    throw new Error("Invalid operator control verdict");
  }
}
function actor(value: unknown): void {
  const v = record(value);
  keys(v, ["actorId", "policyId", "policyRevision"]);
  text(v.actorId);
  text(v.policyId);
  revision(v.policyRevision);
}
function origin(value: unknown): void {
  const v = record(value);
  keys(v, ["businessRevision", "effectKey", "inputMessageId"], [
    "inspectionMessageId",
  ]);
  text(v.effectKey);
  text(v.inputMessageId);
  if (v.inspectionMessageId !== undefined) text(v.inspectionMessageId);
  const reference = record(v.businessRevision);
  keys(reference, ["__assemblyRuntimeRevision"]);
  const ref = record(reference.__assemblyRuntimeRevision);
  keys(ref, ["systemId", "operatorId", "revision", "modelDigest"], [
    "invocationKey",
  ]);
  text(ref.systemId);
  text(ref.operatorId);
  text(ref.modelDigest);
  revision(ref.revision);
  if (ref.invocationKey !== undefined) text(ref.invocationKey, 131072);
}

/** Validate persisted DTOs again at the worker boundary, including unknown keys. */
export function parseAcceptedCommand(
  delivery: OperatorExecutionDelivery,
): AcceptedOperatorCommand | undefined {
  if (delivery.kind !== "command" && delivery.kind !== "schedule") {
    return undefined;
  }
  text(delivery.id);
  text(delivery.modelPin.modelDigest);
  if (delivery.modelPin.repositoryVersion !== undefined) {
    text(delivery.modelPin.repositoryVersion);
  }
  const envelope = record(delivery.payload);
  keys(envelope, ["__assemblyOperatorCommand", "command"], [
    "origin",
    "decisionBaseline",
  ]);
  if (envelope.__assemblyOperatorCommand !== 1) {
    throw new Error("Unsupported operator control receipt version");
  }
  const command = record(envelope.command);
  switch (command.kind) {
    case "prepare-initial-tools": {
      keys(command, ["kind", "preparation"]);
      const preparation = record(command.preparation);
      keys(preparation, ["key", "revision"]);
      text(preparation.key);
      revision(preparation.revision);
      break;
    }
    case "resume-candidate-continuation":
      keys(command, [
        "kind",
        "candidateId",
        "invocationKey",
        "inputMessageId",
        "continuationDigest",
      ]);
      text(command.candidateId);
      text(command.invocationKey);
      text(command.inputMessageId);
      text(command.continuationDigest);
      break;
    case "resume-decided-changes":
      keys(command, ["kind", "candidatesOnly"]);
      if (typeof command.candidatesOnly !== "boolean") {
        throw new Error("Invalid continuation control receipt");
      }
      break;
    case "run-scheduled-case": {
      keys(command, ["kind", "caseId", "trigger"]);
      text(command.caseId);
      const trigger = record(command.trigger);
      if (trigger.kind === "manual") keys(trigger, ["kind"]);
      else if (trigger.kind === "due") {
        keys(trigger, ["kind", "scheduledAt"]);
        text(trigger.scheduledAt);
        if (!Number.isFinite(Date.parse(trigger.scheduledAt))) {
          throw new Error("Invalid scheduled occurrence");
        }
      } else throw new Error("Unknown scheduled trigger");
      break;
    }
    case "decide-candidate": {
      keys(command, ["kind", "input"], ["delegated"]);
      const input = record(command.input);
      keys(input, ["candidateId", "candidateDigest", "verdict", "reason"], [
        "caseId",
      ]);
      text(input.candidateId);
      text(input.candidateDigest);
      verdict(input.verdict);
      if (
        typeof input.reason !== "string" || !input.reason.trim() ||
        input.reason.length > 2000
      ) throw new Error("Invalid admission reason");
      if (input.caseId !== undefined) text(input.caseId);
      if (command.delegated !== undefined && input.caseId === undefined) {
        throw new Error("Delegated admission requires its exact Request");
      }
      break;
    }
    case "decide-change": {
      keys(command, ["kind", "input"], ["delegated"]);
      const input = record(command.input);
      keys(input, ["changeId", "expectedRevision", "verdict"]);
      text(input.changeId);
      revision(input.expectedRevision);
      verdict(input.verdict);
      break;
    }
    case "watch-notification": {
      keys(command, ["kind", "notice"]);
      const notice = record(command.notice);
      keys(notice, ["id", "caseId", "summary", "at"], ["ownerId"]);
      text(notice.id);
      text(notice.caseId);
      text(notice.at);
      if (
        typeof notice.summary !== "string" || !notice.summary.trim() ||
        characterCount(notice.summary) > 4000
      ) throw new Error("Invalid Watch notification summary");
      if (notice.ownerId !== undefined) text(notice.ownerId);
      break;
    }
    default:
      throw new Error("Unsupported operator control command");
  }
  if (
    (delivery.kind === "schedule") !== (command.kind === "run-scheduled-case")
  ) throw new Error("Operator control delivery lane mismatch");
  if (envelope.origin !== undefined) origin(envelope.origin);
  if (command.delegated !== undefined) {
    actor(command.delegated);
    if (envelope.origin === undefined) {
      throw new Error("Delegated decisions require durable source evidence");
    }
    const source = record(
      record(record(envelope.origin).businessRevision)
        .__assemblyRuntimeRevision,
    );
    if (
      !source.invocationKey ||
      source.operatorId !== record(command.delegated).actorId
    ) {
      throw new Error(
        "Delegated actor does not match the durable source scope",
      );
    }
    if (
      command.kind === "decide-candidate" &&
      !record(envelope.origin).inspectionMessageId
    ) {
      throw new Error(
        "Delegated admission requires its durable inspection receipt",
      );
    }
  }
  if ("decisionBaseline" in envelope) {
    const baseline = record(envelope.decisionBaseline);
    keys(baseline, ["format", "digest"]);
    if (
      baseline.format !== "operator-command-decision-baseline/v1" ||
      !isSha256Hex(baseline.digest) ||
      (command.kind !== "decide-change" &&
        command.kind !== "decide-candidate") ||
      command.delegated === undefined || envelope.origin === undefined
    ) {
      throw new Error("Unsupported delegated command decision baseline");
    }
  }
  return structuredClone({
    id: delivery.id,
    identity: delivery.identity,
    modelPin: delivery.modelPin,
    command: command as unknown as OperatorControlCommand,
    ...(envelope.decisionBaseline === undefined ? {} : {
      decisionBaseline: {
        format: "operator-command-decision-baseline/v1" as const,
        digest: record(envelope.decisionBaseline).digest as string,
      },
    }),
    ...(envelope.origin === undefined
      ? {}
      : { origin: envelope.origin as unknown as OperatorCommandOrigin }),
  });
}

export async function enqueueOperatorCommand(
  dispatch: OperatorExecutionDispatchPort,
  accepted: AcceptedOperatorCommand,
): Promise<OperatorDeliveryReceipt> {
  const delivery: OperatorExecutionDelivery = {
    id: accepted.id,
    identity: accepted.identity,
    modelPin: accepted.modelPin,
    kind: accepted.command.kind === "run-scheduled-case"
      ? "schedule"
      : "command",
    payload: {
      __assemblyOperatorCommand: 1,
      command: structuredClone(accepted.command),
      ...(accepted.decisionBaseline === undefined
        ? {}
        : { decisionBaseline: structuredClone(accepted.decisionBaseline) }),
      ...(accepted.origin ? { origin: structuredClone(accepted.origin) } : {}),
    },
  };
  parseAcceptedCommand(delivery);
  return await dispatch.enqueue(delivery);
}

export interface OperatorCommandWorkerHost {
  /** Current target model and host-selected scope must match the accepted pin. */
  assertCurrentScope(
    identity: NativeExecutionIdentity,
    modelPin: OperatorExecutionDelivery["modelPin"],
  ): Promise<void>;
  /** Load immutable source history/effect and recheck the actor's current grant.
   * The copied actor or inspection JSON in a queue payload is never authority. */
  assertDelegatedAuthority(
    command: Extract<
      OperatorControlCommand,
      { kind: "decide-candidate" | "decide-change" }
    >,
    origin: OperatorCommandOrigin,
  ): Promise<void>;
  prepareInitialTools(
    preparation: InitialToolsPreparationReference,
  ): Promise<void>;
  resumeDecidedChanges(options: { candidatesOnly: boolean }): Promise<void>;
  resumeCandidateContinuation?(
    command: Extract<
      OperatorControlCommand,
      { kind: "resume-candidate-continuation" }
    >,
  ): Promise<void>;
  runScheduledCase(
    input: Extract<OperatorControlCommand, { kind: "run-scheduled-case" }>,
  ): Promise<void>;
  decideCandidate(
    input: CandidateDecisionInput,
    delegated?: CandidateDelegatedActor,
  ): Promise<void>;
  decideChange(
    input: Extract<OperatorControlCommand, { kind: "decide-change" }>["input"],
    delegated?: CandidateDelegatedActor,
  ): Promise<void>;
  receiveWatchNotification(
    notice: NonNullable<SystemRuntimeState["watchNotifications"]>[number],
  ): Promise<void>;
}

/** The caller holds this target operator's durable claim and local reservation.
 * Callbacks invoke real application primitives with a claim-bound control host. */
export async function executeAcceptedCommand(
  accepted: AcceptedOperatorCommand,
  host: OperatorCommandWorkerHost,
): Promise<void> {
  await host.assertCurrentScope(accepted.identity, accepted.modelPin);
  const command = accepted.command;
  if (
    (command.kind === "decide-candidate" || command.kind === "decide-change") &&
    command.delegated
  ) {
    if (!accepted.origin) {
      throw new Error("The delegated command has no durable source evidence");
    }
    await host.assertDelegatedAuthority(command, accepted.origin);
  }
  switch (command.kind) {
    case "prepare-initial-tools":
      return await host.prepareInitialTools(command.preparation);
    case "resume-candidate-continuation":
      if (!host.resumeCandidateContinuation) {
        throw new Error("Candidate recovery is unavailable");
      }
      return await host.resumeCandidateContinuation(command);
    case "resume-decided-changes":
      return await host.resumeDecidedChanges({
        candidatesOnly: command.candidatesOnly,
      });
    case "run-scheduled-case":
      return await host.runScheduledCase(command);
    case "decide-candidate":
      return await host.decideCandidate(command.input, command.delegated);
    case "decide-change":
      return await host.decideChange(command.input, command.delegated);
    case "watch-notification":
      return await host.receiveWatchNotification(command.notice);
  }
}
