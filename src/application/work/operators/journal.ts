import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { isOpenCase } from "../../../domain/work/entities/cases.ts";
import { CaseError } from "../../../domain/work/errors/case.ts";
import type {
  ArtifactEvidence,
  Event,
  Message,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import type { Candidate } from "../../../domain/work/candidates.ts";
import type {
  PendingChange,
} from "../../../domain/governance/records/pending-change.ts";
import type {
  OperatorWorkAdmission,
  OperatorWorkResult,
} from "./conversations.ts";
import type {
  CaseInvocation,
  OperatorWorkReceipt,
} from "../../../domain/work/execution/case-context.ts";

export type OperatorWorkMessage = Message & { work: OperatorWorkReceipt };
export interface OperatorWorkMessageRange {
  start: number;
  end: number;
}
export type OperatorWorkCompletion = Event & {
  work: {
    caseId?: string;
    callerId: string;
    correlationId: string;
    fingerprint: string;
    status: OperatorWorkResult["status"];
    messageCount: number;
    /** Only these contribution segments belong to this work, including after a decision. */
    messageRanges?: OperatorWorkMessageRange[];
    /** Exact suspended native continuation; absent for terminal contributions. */
    continuation?: string;
    candidateIds: string[];
    artifacts?: ArtifactEvidence[];
    revision: number;
    modelVersion: OperatorWorkResult["modelVersion"];
    error?: string;
  };
};

/** What a settled control hands back: the resumed work and its completion.
 * The control journals the completion, then wakes the caller unless waiting. */
export interface SettledOperatorWork {
  receipt: OperatorWorkReceipt;
  completion: OperatorWorkCompletion;
}

export type OperatorWorkContinuationStart = Event & {
  work: Pick<
    OperatorWorkReceipt,
    "caseId" | "callerId" | "correlationId" | "fingerprint"
  >;
};

/** An exact retry observes its former outcome, even after the process restarts. */
export function operatorWorkFingerprint(
  agentId: string,
  text: string,
  correlationId: string,
  proof: OperatorWorkAdmission,
  legacyMainBehaviorId?: string,
): string {
  return canonical({
    agentId,
    text: text.trim(),
    correlationId,
    callerId: proof.callerId,
    invocationId: proof.invocationId,
    ...(proof.kind === "mainOrder"
      ? legacyMainBehaviorId !== undefined
        ? { behaviorId: legacyMainBehaviorId }
        : {}
      : { behaviorId: proof.behavior.id }),
    targetNativeId: proof.kind === "mainOrder"
      ? proof.targetNativeId
      : proof.behavior.targetNativeId,
    modelVersion: proof.modelVersion,
    ...(proof.mainOrder ? { mainOrder: proof.mainOrder } : {}),
    ...(proof.designerContext
      ? {
        designerScope: {
          scopeId: proof.designerContext.scopeId,
          ownerId: proof.designerContext.ownerId,
        },
      }
      : {}),
  });
}

export function workReceipt(message: Message): OperatorWorkReceipt | undefined {
  return (message as Partial<OperatorWorkMessage>).work;
}

/** A Request may hold several independent delegated contributions. */
export function invocationKey(invocation: CaseInvocation): string {
  switch (invocation.kind) {
    case "local":
      return canonical(["local", invocation.caseId]);
    case "designer":
      return canonical(["designer", invocation.scopeId]);
    case "delegated":
    case "delegated-designer":
      return canonical([
        invocation.kind,
        invocation.work.caseId ?? invocation.work.designerContext?.scopeId,
        invocation.work.callerId,
        invocation.work.correlationId,
        invocation.work.fingerprint,
      ]);
  }
}

/** Exact host-created local input, including Main-opened objectives and resumptions. */
export function isLocalRequestInput(
  state: SystemRuntimeState,
  message: Message,
  caseId: string,
): boolean {
  if (message.caseId !== caseId || workReceipt(message)) return false;
  if (message.role === "user") return true;
  const record = state.cases?.find((entry) =>
    entry.id === caseId &&
    entry.owner === state.executionModel?.identity.builderId
  );
  if (
    !record || message.role !== "tool" ||
    (!record.openedFrom.openingId && !record.openedFrom.changeId)
  ) return false;
  // A branch opening by Main is a tool input whose exact contribution ID is
  // recorded in this runtime's immutable Case birth, not a synthetic objective.
  if (
    record.openedFrom.openingId &&
    record.openedFrom.conversationId === state.id &&
    record.openedFrom.messageId === message.id
  ) return true;
  if (message.id === `${caseId}:objective`) {
    return message.text.trim() === record.objective;
  }
  return state.requestResumptions?.some((receipt) =>
    receipt.caseId === caseId &&
    message.id === `${caseId}:resume:${receipt.resumeId}` &&
    message.text === receipt.instruction &&
    receipt.openedBy === record.openedBy &&
    receipt.conversationId === record.openedFrom.conversationId &&
    receipt.designerScopeId === record.openedFrom.designerScopeId
  ) ?? false;
}

export function invocationInput(
  state: SystemRuntimeState,
  invocation = state.caseInvocation,
): Message | undefined {
  if (!invocation) return undefined;
  const matches = (message: Message) => {
    const work = workReceipt(message);
    if (
      invocation.kind === "delegated" ||
      invocation.kind === "delegated-designer"
    ) {
      return !work && message.role === "user" &&
          (invocation.kind === "delegated"
            ? message.caseId === invocation.work.caseId
            : message.designerScopeId ===
              invocation.work.designerContext.scopeId) ||
        work?.callerId === invocation.work.callerId &&
          work.correlationId === invocation.work.correlationId &&
          work.fingerprint === invocation.work.fingerprint &&
          work.caseId === invocation.work.caseId;
    }
    return invocation.kind === "local"
      ? isLocalRequestInput(state, message, invocation.caseId)
      : message.role === "user" && !work && message.caseId === undefined &&
        (message.designerScopeId === invocation.scopeId ||
          message.designerScopeId === undefined);
  };
  const selected = state.caseInvocation &&
      invocationKey(state.caseInvocation) === invocationKey(invocation)
    ? state.activeInputMessageId
    : undefined;
  const retained = selected ??
    state.invocationContinuations?.[invocationKey(invocation)]?.inputMessageId;
  // A woken notice is a designer input only as the exact selected input of
  // its own durable turn, never the latest message of the conversation.
  const wokenNotice = (message: Message) =>
    invocation.kind === "designer" && message.noticeWake === true &&
    message.role === "tool" && !!message.operatorNotice &&
    message.caseId === undefined &&
    message.designerScopeId === invocation.scopeId;
  return retained
    ? state.messages.find((message) =>
      message.id === retained && (matches(message) || wokenNotice(message))
    )
    : state.messages.findLast(matches);
}

function candidateWork(
  state: SystemRuntimeState,
  candidate: Candidate,
): {
  receipt?: OperatorWorkReceipt;
  ambiguous: boolean;
  unassociated: boolean;
} {
  let scopedReceipts = 0;
  const legacyCase = state.cases?.find((record) =>
    record.id === candidate.caseId && record.migratedFrom === "legacy-dossier"
  );
  const receipts = state.messages.flatMap((message) => {
    const receipt = workReceipt(message);
    if (
      !receipt ||
      receipt.caseId !== candidate.caseId &&
        !(legacyCase && receipt.caseId === undefined &&
          receipt.designerContext === undefined) ||
      receipt.designerContext?.scopeId !== candidate.designerScopeId
    ) return [];
    if (receipt.caseId === candidate.caseId) scopedReceipts++;
    const exact = state.events.some((event) => {
      const work = (event as Partial<OperatorWorkCompletion>).work;
      return work?.callerId === receipt.callerId &&
        work.correlationId === receipt.correlationId &&
        work.fingerprint === receipt.fingerprint &&
        work.caseId === receipt.caseId &&
        work.candidateIds?.includes(candidate.id);
    }) ||
      candidate.admissionContinuation?.work?.receipt.fingerprint ===
            receipt.fingerprint &&
        candidate.admissionContinuation.work.receipt.callerId ===
          receipt.callerId &&
        candidate.admissionContinuation.work.receipt.correlationId ===
          receipt.correlationId;
    return exact ? [receipt] : [];
  });
  const unique = [
    ...new Map(receipts.map((receipt) => [canonical(receipt), receipt]))
      .values(),
  ];
  return {
    receipt: unique.length === 1 ? unique[0] : undefined,
    ambiguous: unique.length > 1,
    unassociated: scopedReceipts > 0 && unique.length === 0,
  };
}

/** Ownership is persisted once, never inferred from an event or current input. */
export function candidateCaseId(
  state: SystemRuntimeState,
  candidateId: string,
): string | undefined {
  return state.candidates.find((candidate) => candidate.id === candidateId)
    ?.caseId;
}

export function requireCandidateCaseId(
  state: SystemRuntimeState,
  candidate: Candidate,
): string {
  if (candidate.caseId) return candidate.caseId;
  throw new CaseError(
    "CASE_SCOPE_MISSING",
    "The candidate has no persisted Case ownership",
    { conversationId: state.id, candidateId: candidate.id },
    "Reload the original pre-Cases dossier through initialize() to migrate it before deciding this candidate.",
  );
}

/** A source-selected candidate may receive a later explicit human decision.
 * Its closed preparation is provenance, not an active invocation or authority. */
export function isInitializationAdmission(
  state: SystemRuntimeState,
  candidate: Candidate,
): boolean {
  if (!candidate.initialToolSeed) return false;
  const ownerCase = candidateCaseId(state, candidate.id);
  return state.cases?.some((record) =>
    record.id === ownerCase && record.openedFrom.origin === "initialization" &&
    record.status.startsWith("closed-")
  ) ?? false;
}

/** Candidate provenance selects its invocation, independently of the last input. */
export function candidateCaseInvocation(
  state: SystemRuntimeState,
  candidate: Candidate,
): CaseInvocation | undefined {
  // Ownership validation precedes all receipt/event lookup, including legacy receipts.
  if (candidate.designerScopeId === undefined) {
    requireCandidateCaseId(state, candidate);
  } else if (candidate.caseId !== undefined) return undefined;
  if (
    candidate.stage === "failed" &&
    (candidate.errorCode === "CASE_ABANDONED" ||
      candidate.error === "Case abandoned")
  ) return undefined;
  const recorded = candidateWork(state, candidate);
  if (recorded.ambiguous || recorded.unassociated) return undefined;
  if (recorded.receipt) {
    const work = recorded.receipt;
    const legacyCase = state.cases?.find((record) =>
      record.id === candidate.caseId && record.migratedFrom === "legacy-dossier"
    );
    if (
      legacyCase && work.caseId === undefined &&
      work.designerContext === undefined
    ) {
      return isOpenCase(legacyCase)
        ? { kind: "local", caseId: legacyCase.id }
        : undefined;
    }
    const invocation: CaseInvocation | undefined = work.designerContext
      ? {
        kind: "delegated-designer",
        work: { ...work, designerContext: work.designerContext },
      }
      : work.caseContext && work.caseContext.caseId === candidate.caseId &&
          work.caseId === candidate.caseId
      ? { kind: "delegated", work: { ...work, caseContext: work.caseContext } }
      : undefined;
    if (!invocation) return undefined;
    const local = state.cases?.find((record) => record.id === candidate.caseId);
    if (local && !isOpenCase(local)) return undefined;
    const saved = state.invocationContinuations?.[invocationKey(invocation)]
      ?.invocation;
    const current = state.caseInvocation;
    // The selected/parked invocation carries the latest host-refreshed context.
    if (current && invocationKey(current) === invocationKey(invocation)) {
      return structuredClone(current);
    }
    return structuredClone(saved ?? invocation);
  }
  if (candidate.designerScopeId !== undefined) {
    if (candidate.caseId !== undefined) return undefined;
    if (candidate.designerScopeId === state.designer?.scopeId) {
      return { kind: "designer", scopeId: candidate.designerScopeId };
    }
    const invocation = state.caseInvocation;
    return invocation?.kind === "delegated-designer" &&
        invocation.work.designerContext.scopeId === candidate.designerScopeId
      ? structuredClone(invocation)
      : undefined;
  }
  const ownerCase = requireCandidateCaseId(state, candidate);
  const local = state.cases?.find((record) => record.id === ownerCase);
  if (local) {
    return isOpenCase(local) ? { kind: "local", caseId: local.id } : undefined;
  }
  const invocation = state.caseInvocation;
  return invocation?.kind === "delegated" &&
      invocation.work.caseContext.caseId === ownerCase
    ? structuredClone(invocation)
    : undefined;
}

/** Recorded scope selects the invocation, never the currently selected conversation. */
export function changeCaseInvocation(
  state: SystemRuntimeState,
  change: PendingChange,
): CaseInvocation {
  if (!change.requestedBy || (!!change.caseId === !!change.designerScopeId)) {
    throw new CaseError(
      "CASE_SCOPE_MISSING",
      "The change has no exact recorded origin",
      { changeId: change.id },
      "Restore the proposal's original scope before deciding.",
    );
  }
  if (change.requestedBy !== state.executionModel?.identity.builderId) {
    throw new CaseError(
      "CASE_NOT_OWNED",
      "The change belongs to another operator",
      { changeId: change.id },
      "Use the decision route of the recorded requesting operator.",
    );
  }
  const origin = state.changeWorkContinuations?.[change.id];
  if (origin) {
    const receipt = changeWorkReceipt(state, change);
    if (!receipt) {
      throw new CaseError(
        "CASE_SCOPE_MISSING",
        "The change's exact work origin is unavailable",
        { changeId: change.id },
      );
    }
    const invocation: CaseInvocation = receipt.caseContext
      ? {
        kind: "delegated",
        work: { ...receipt, caseContext: receipt.caseContext },
      }
      : {
        kind: "delegated-designer",
        work: { ...receipt, designerContext: receipt.designerContext! },
      };
    const local = state.cases?.find((record) => record.id === change.caseId);
    if (local && !isOpenCase(local)) {
      throw new CaseError("CASE_CLOSED", "The change's Request is closed", {
        changeId: change.id,
      });
    }
    const current = state.caseInvocation;
    const saved = state.invocationContinuations?.[origin.invocationKey]
      ?.invocation;
    if (saved && invocationKey(saved) !== origin.invocationKey) {
      throw new CaseError(
        "CASE_SCOPE_MISSING",
        "The change's saved invocation does not match its work origin",
        { changeId: change.id },
      );
    }
    return structuredClone(
      current && invocationKey(current) === origin.invocationKey
        ? current
        : saved ?? invocation,
    );
  }
  if (
    change.designerScopeId && change.designerScopeId === state.designer?.scopeId
  ) {
    return { kind: "designer", scopeId: change.designerScopeId };
  }
  const record = state.cases?.find((entry) => entry.id === change.caseId);
  if (record && isOpenCase(record) && record.owner === change.requestedBy) {
    return { kind: "local", caseId: record.id };
  }
  const invocation = state.caseInvocation;
  if (
    !record &&
    (invocation?.kind === "delegated" &&
        invocation.work.caseContext.caseId === change.caseId ||
      invocation?.kind === "delegated-designer" &&
        invocation.work.designerContext.scopeId === change.designerScopeId)
  ) return structuredClone(invocation);
  throw new CaseError(
    "CASE_SCOPE_MISSING",
    "The change's original open scope is unavailable",
    { changeId: change.id },
    "Restore the proposal's original open scope before deciding.",
  );
}

/** A source proposal cannot infer a work correlation from the current inbox or root Case alone. */
export function changeWorkReceipt(
  state: SystemRuntimeState,
  change: PendingChange,
): OperatorWorkReceipt | undefined {
  if (change.requestedBy !== state.executionModel?.identity.builderId) {
    return undefined;
  }
  const origin = state.changeWorkContinuations?.[change.id];
  const input = origin &&
    state.messages.find((message) => message.id === origin.inputMessageId);
  const receipt = input && workReceipt(input);
  if (
    !origin || !receipt || receipt.caseId !== change.caseId ||
    receipt.designerContext?.scopeId !== change.designerScopeId
  ) return undefined;
  const invocation: CaseInvocation | undefined =
    receipt.caseContext && receipt.caseContext.caseId === receipt.caseId
      ? {
        kind: "delegated",
        work: { ...receipt, caseContext: receipt.caseContext },
      }
      : receipt.designerContext && !receipt.caseId && !receipt.caseContext
      ? {
        kind: "delegated-designer",
        work: { ...receipt, designerContext: receipt.designerContext },
      }
      : undefined;
  return invocation && invocationKey(invocation) === origin.invocationKey
    ? structuredClone(receipt)
    : undefined;
}

/** The BO owns its Case; a member carries the exact original Case in its
 * recorded delegated work. Source membership alone never fills a missing
 * contribution origin. Human decision admission retains its own boundary. */
export function hasHostRequestChangeCase(
  current: SystemRuntimeState,
  change: PendingChange,
  input: { caseId: string; openingId: string },
): boolean {
  const model = current.executionModel;
  if (!model) return false;
  // RequestSpaceAuthorityBridge verifies the roster before this origin check.
  const team = model.operatorTeam;
  if (!team) {
    return current.cases?.some((record) =>
      record.id === input.caseId &&
      record.owner === model.identity.builderId &&
      record.openedFrom.openingId === input.openingId && isOpenCase(record)
    ) ?? false;
  }
  const work = changeWorkReceipt(current, change);
  const record = work?.caseContext?.record;
  return !!record &&
    team.parentOperatorId !== model.identity.builderId &&
    !!team.parentOperatorId &&
    team.requestOwnerId !== model.identity.builderId &&
    work?.caseId === input.caseId &&
    work.caseContext?.caseId === input.caseId &&
    record.id === input.caseId && record.owner === team.requestOwnerId &&
    record.openedFrom.openingId === input.openingId && isOpenCase(record) &&
    (!change.teamOrigin ||
      change.teamOrigin.operatorId === team.requestOwnerId &&
        change.teamOrigin.requestId === input.caseId);
}

/** The invocation a decided Request change continues. A member's work
 * origin is immutable; neither a selected inbox nor the BO's local Case can
 * replace a missing receipt. Shared by atomic adoption and wake recovery. */
export function requestChangeInvocation(
  state: SystemRuntimeState,
  changeId: string,
  caseId: string,
  inputMessageId: string,
): CaseInvocation {
  const refuse = (
    code:
      | "CASE_NOT_FOUND"
      | "CASE_CONFLICT"
      | "CASE_NOT_OWNED"
      | "CASE_SCOPE_MISSING",
  ): never => {
    throw new CaseError(
      code,
      "The exact Request change work origin is unavailable",
      { caseId, changeId, inputMessageId },
      "Reload the Request change and its recorded work before retrying.",
    );
  };
  const change = state.configuration?.changes.find((entry) =>
    entry.id === changeId && entry.caseId === caseId
  );
  if (!change) return refuse("CASE_NOT_FOUND");
  const continuation = state.changeWorkContinuations?.[changeId];
  if (continuation && continuation.inputMessageId !== inputMessageId) {
    return refuse("CASE_CONFLICT");
  }
  const work = changeWorkReceipt(state, change);
  if (work?.caseContext) {
    if (!continuation) return refuse("CASE_SCOPE_MISSING");
    const team = state.executionModel?.operatorTeam;
    const record = work.caseContext.record;
    if (
      team &&
      (!record || record.id !== caseId ||
        record.owner !== team.requestOwnerId ||
        !isOpenCase(record))
    ) return refuse("CASE_NOT_OWNED");
    return {
      kind: "delegated",
      work: { ...work, caseContext: work.caseContext },
    };
  }
  if (
    state.executionModel?.operatorTeam ||
    state.changeWorkContinuations?.[changeId] ||
    !state.cases?.some((record) =>
      record.id === caseId &&
      record.owner === state.executionModel?.identity.builderId
    )
  ) return refuse("CASE_SCOPE_MISSING");
  return { kind: "local", caseId };
}

export function recordedWorkCompletion(
  state: SystemRuntimeState,
  receipt: OperatorWorkReceipt,
): OperatorWorkCompletion | undefined {
  return state.events.findLast((event) => {
    const work = (event as Partial<OperatorWorkCompletion>).work;
    return work?.status && work.callerId === receipt.callerId &&
      work.correlationId === receipt.correlationId &&
      work.fingerprint === receipt.fingerprint &&
      work.caseId === receipt.caseId;
  }) as OperatorWorkCompletion | undefined;
}

function latestWorkEvent(
  state: SystemRuntimeState,
  receipt: OperatorWorkReceipt,
) {
  return state.events.findLast((event) => {
    const record = (event as Partial<OperatorWorkCompletion>).work;
    return record?.callerId === receipt.callerId &&
      record.correlationId === receipt.correlationId &&
      record.fingerprint === receipt.fingerprint &&
      record.caseId === receipt.caseId;
  });
}

/** A decision continues the exact persisted contribution, independent of inbox order. */
export function waitingOperatorWork(
  state: SystemRuntimeState,
  candidateId: string,
):
  | { receipt: OperatorWorkReceipt; completion: OperatorWorkCompletion }
  | undefined {
  const candidate = state.candidates.find((value) => value.id === candidateId);
  const invocation = candidate && candidateCaseInvocation(state, candidate);
  const input = invocation && invocationInput(state, invocation);
  const legacyReceipt = !input && candidate && invocation?.kind === "local" &&
      state.cases?.some((record) =>
        record.id === invocation.caseId &&
        record.migratedFrom === "legacy-dossier"
      )
    ? candidateWork(state, candidate).receipt
    : undefined;
  const legacy = legacyReceipt?.caseId === undefined &&
      legacyReceipt?.designerContext === undefined
    ? legacyReceipt
    : undefined;
  const receipt = legacy ?? (input && workReceipt(input));
  if (!receipt) return undefined;
  const completion = latestWorkEvent(state, receipt) as
    | OperatorWorkCompletion
    | undefined;
  if (
    completion?.work.status !== "waiting" || !completion.work.continuation ||
    !completion.work.candidateIds.includes(candidateId)
  ) return undefined;
  return {
    receipt: structuredClone(receipt),
    completion: structuredClone(completion),
  };
}

export function recordedOperatorWork(
  state: SystemRuntimeState,
  agentId: string,
  callerId: string,
  correlationId: string,
):
  | {
    fingerprint: string;
    legacyMainBehaviorId?: string;
    result: OperatorWorkResult;
    /** False when the journalled input has no terminal receipt yet: still
     * running if its accepted delivery is live, interrupted otherwise. */
    settled: boolean;
  }
  | undefined {
  const index = state.messages.findIndex((message) => {
    const receipt = workReceipt(message);
    return receipt?.callerId === callerId &&
      receipt.correlationId === correlationId;
  });
  if (index < 0) return undefined;
  const receipt = workReceipt(state.messages[index]!)!;
  const legacyMainBehavior =
    receipt.mainOrder && receipt.behaviorId !== undefined
      ? { legacyMainBehaviorId: receipt.behaviorId }
      : {};
  const completion = latestWorkEvent(state, receipt) as
    | OperatorWorkCompletion
    | undefined;
  if (!completion?.work.status) {
    return {
      fingerprint: receipt.fingerprint,
      ...legacyMainBehavior,
      settled: false,
      result: {
        ...(receipt.caseId ? { caseId: receipt.caseId } : {}),
        agentId,
        correlationId,
        invocationId: receipt.invocationId,
        status: "failed",
        revision: state.revision,
        modelVersion: {
          digest: state.executionModel!.version.digest,
          repositoryVersion: state.executionModel!.version.repositoryVersion!,
        },
        messages: [],
        candidateIds: [],
        error:
          "Ce travail ne possède pas de reçu de terminaison ; aucune répétition automatique n’est effectuée.",
      },
    };
  }
  const superseded = completion.work.status === "waiting" &&
    state.messages.slice(index + 1).some((message) => {
      const next = workReceipt(message);
      if (message.role !== "user" && !next) return false;
      // Other Requests and other delegated correlations have their own saved continuation.
      if (
        next && (next.caseId !== receipt.caseId ||
          next.designerContext?.scopeId !== receipt.designerContext?.scopeId ||
          next.callerId !== receipt.callerId ||
          next.correlationId !== receipt.correlationId)
      ) return false;
      if (!next) {
        const invocation: CaseInvocation | undefined = receipt.caseContext
          ? {
            kind: "delegated",
            work: { ...receipt, caseContext: receipt.caseContext },
          }
          : receipt.designerContext
          ? {
            kind: "delegated-designer",
            work: { ...receipt, designerContext: receipt.designerContext },
          }
          : undefined;
        if (
          invocation &&
          state.invocationContinuations?.[invocationKey(invocation)]
        ) return false;
        return receipt.caseId
          ? message.caseId === receipt.caseId
          : message.designerScopeId === receipt.designerContext?.scopeId;
      }
      return !next || next.fingerprint !== receipt.fingerprint ||
        next.callerId !== receipt.callerId ||
        next.correlationId !== receipt.correlationId ||
        next.caseId !== receipt.caseId;
    });
  return {
    fingerprint: receipt.fingerprint,
    ...legacyMainBehavior,
    settled: true,
    result: {
      ...(receipt.caseId ? { caseId: receipt.caseId } : {}),
      agentId,
      correlationId,
      invocationId: receipt.invocationId,
      status: superseded ? "failed" : completion.work.status,
      revision: completion.work.revision,
      modelVersion: structuredClone(completion.work.modelVersion),
      // The contributor's model reads are private reading, not its
      // contribution; they stay in its journal, never in the receipt.
      messages: structuredClone(
        (completion.work.messageRanges ?? [{
          start: index,
          end: completion.work.messageCount,
        }]).flatMap(({ start, end }) => state.messages.slice(start, end))
          .filter((message) => message.observation?.kind !== "model-context"),
      ),
      candidateIds: [...completion.work.candidateIds],
      ...(completion.work.artifacts
        ? { artifacts: structuredClone(completion.work.artifacts) }
        : {}),
      ...(superseded
        ? {
          error:
            "Une autre contribution a remplacé la continuation de ce travail ; aucune répétition automatique n’est effectuée.",
        }
        : completion.work.error
        ? { error: completion.work.error }
        : {}),
    },
  };
}
