import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import {
  type NativeChangeApprovalWait,
  type NativeDeclaredConsultationRefusal,
  nativeExecutionIdentity,
  type NativeExecutionSnapshot,
} from "../native-execution/contract.ts";
/** Durable boundary evidence, independent of the currently selected Request. */
import type {
  EvolutionAdoptionReceipt,
  EvolutionBlocker,
  EvolutionCheckpoint,
  EvolutionDossier,
  EvolutionPublication,
  EvolutionTarget,
} from "../../model/evolution/ports.ts";
import { EvolutionError } from "../../model/evolution/ports.ts";
import type { InvocationContinuation, SystemRuntimeState } from "./state.ts";
import {
  hasHostRequestChangeCase,
  invocationInput,
  invocationKey,
  isLocalRequestInput,
  type OperatorWorkCompletion,
  workReceipt,
} from "../operators/journal.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { decidedByNetworkAuthority } from "../../../domain/governance/records/request-network-change.ts";
import {
  decidedByTeamAuthority,
  requestChangeEffect,
  requestChangeProposalDigest,
} from "../../../domain/governance/records/request-change.ts";
import type { BehaviorSettingsBudgetScope } from "./behavior-settings-validation.ts";

/** Host-created Request objectives and resume instructions are tool messages.
 * Only their exact durable dispatch/continuation receipts make them inputs. */
export function evolutionInvocationInput(
  state: SystemRuntimeState,
  invocation: InvocationContinuation["invocation"],
) {
  const ordinary = invocationInput(state, invocation);
  if (invocation.kind !== "local") return ordinary;
  const record = state.cases?.find((record) => record.id === invocation.caseId);
  return state.messages.findLast((message) => {
    if (message === ordinary && message.role === "user") return true;
    if (
      message.role !== "tool" ||
      !isLocalRequestInput(state, message, invocation.caseId)
    ) return false;
    const receipt = state.requestResumptions?.find((entry) =>
      message.id === `${invocation.caseId}:resume:${entry.resumeId}`
    );
    return receipt
      ? receipt.status === "completed" &&
        receipt.outcome?.caseId === invocation.caseId &&
        receipt.outcome.operatorId === record?.owner
      : !!record?.firstRequestDispatched && !record.firstRequestDispatch;
  });
}

export interface EvolutionInputSettlement {
  invocationKey: string;
  inputMessageId: string;
}
/** A host-captured exact continuation, never another Case's global wait state. */
export function evolutionHumanSettlement(
  state: SystemRuntimeState,
  caseId?: string,
  newConversation?: true,
  executions: readonly NativeExecutionSnapshot[] = [],
): EvolutionInputSettlement | undefined {
  if (newConversation) return undefined;
  const invocation = caseId
    ? { kind: "local" as const, caseId }
    : state.designer
    ? { kind: "designer" as const, scopeId: state.designer.scopeId }
    : undefined;
  if (!invocation) return undefined;
  const key = invocationKey(invocation);
  const saved =
    state.caseInvocation && invocationKey(state.caseInvocation) === key
      ? state
      : state.invocationContinuations?.[key];
  const native = executions.find((execution) =>
    execution.identity.invocationKey === key &&
    execution.status === "waiting" && execution.waits.length > 0
  );
  if (!saved || !saved.conversationCursor && !native) return undefined;
  const input = evolutionInvocationInput(state, invocation);
  if (
    !input ||
    saved === state && state.caseInvocation &&
      invocationKey(state.caseInvocation) !== key
  ) return undefined;
  const scopeMatches = (entry: { caseId?: string; designerScopeId?: string }) =>
    invocation.kind === "local"
      ? entry.caseId === invocation.caseId
      : !entry.caseId && entry.designerScopeId === invocation.scopeId;
  const pendingChange = state.configuration?.changes.some((change) =>
    change.status === "pending" && scopeMatches(change) &&
    change.baseModelDigest === state.executionModel?.version.digest
  );
  const pendingCandidate = state.candidates.some((candidate) =>
    scopeMatches(candidate) &&
    candidate.admissionContinuation?.inputMessageId === input.id &&
    candidate.admissionContinuation.modelDigest ===
      state.executionModel?.version.digest
  );
  if (!saved.budgetSuspension && !pendingChange && !pendingCandidate) {
    return undefined;
  }
  return { invocationKey: key, inputMessageId: input.id };
}

function terminalReceipt(
  state: SystemRuntimeState,
  invocation: InvocationContinuation["invocation"],
): boolean {
  const input = evolutionInvocationInput(state, invocation);
  if (!input) return false;
  if (
    invocation.kind === "delegated" || invocation.kind === "delegated-designer"
  ) {
    const work = invocation.work;
    const latest = state.events.findLast((event) => {
      const receipt = (event as Partial<OperatorWorkCompletion>).work;
      return receipt?.callerId === work.callerId &&
        receipt.correlationId === work.correlationId &&
        receipt.fingerprint === work.fingerprint;
    }) as OperatorWorkCompletion | undefined;
    return latest?.work.status === "completed";
  }
  const start = state.messages.indexOf(input);
  const key = invocationKey(invocation);
  const parked = !state.caseInvocation ||
    invocationKey(state.caseInvocation) !== key;
  const end = parked
    ? state.invocationContinuations?.[key]?.messageCount
    : undefined;
  // A parked invocation cannot claim a reply emitted by work that began after
  // its journal boundary. New runtime writes explicitly scope designer replies.
  return state.messages.slice(start + 1, end).some((message) =>
    message.role === "assistant" &&
    (invocation.kind === "local"
      ? message.caseId === invocation.caseId
      : message.designerScopeId === invocation.scopeId ||
        !message.caseId && !message.designerScopeId)
  );
}

/** Only completed contributions at a plain input boundary may retire a cursor. */
export function emptyEvolutionAwait(
  state: SystemRuntimeState,
  saved: Pick<
    InvocationContinuation,
    | "conversationCursor"
    | "conversationFlow"
    | "budgetSuspension"
    | "activeBatchCall"
    | "error"
    | "lastToolFailure"
    | "invocation"
  >,
): boolean {
  return !!saved.conversationCursor && !saved.budgetSuspension &&
    !saved.activeBatchCall && !saved.error && !saved.lastToolFailure &&
    saved.conversationFlow?.nodes.find((node) =>
        node.id === saved.conversationCursor!.nodeId
      )?.mechanism === "await_input" &&
    terminalReceipt(state, saved.invocation);
}

function evaluateEvolutionCheckpoint(
  state: SystemRuntimeState,
  executions: readonly NativeExecutionSnapshot[] = [],
  historicalModels: readonly ExecutableModel[] = [],
  exactNetworkWait?: NativeChangeApprovalWait,
  networkThreadId?: string,
): EvolutionCheckpoint {
  const blockers: EvolutionBlocker[] = [];
  const add = (code: string, detail: string) =>
    blockers.push({
      code,
      operatorId: state.executionModel?.identity.builderId,
      detail,
    });
  if (state.busy) {
    add("EVOLUTION_RUNTIME_BUSY", "An operator contribution is still running");
  }
  if (state.budgetSuspension || state.workBudget?.reserved) {
    add(
      "EVOLUTION_BUDGET_UNSETTLED",
      "A budget attempt is suspended or reserved",
    );
  }
  if (
    Object.values(state.pendingContributions ?? {}).some((receipt) =>
      receipt.status === "pending"
    )
  ) {
    add(
      "EVOLUTION_CONTRIBUTION_PENDING",
      "Outgoing contributions retain their exact admitted contract",
    );
  }
  if (state.scheduledExecution) {
    add("EVOLUTION_SCHEDULED_EXECUTION", "A scheduled execution remains open");
  }
  if (
    Object.entries(state.changeWorkContinuations ?? {}).some(([id, saved]) => {
      const change = state.configuration?.changes.find((change) =>
        change.id === id
      );
      return saved.attempt ||
        state.changeDecisionContinuations?.[id] !== "resumed" &&
          id !== exactNetworkWait?.changeId ||
        !change ||
        change.status === "pending" ||
        change.publication && !change.publication.completed;
    }) ||
    Object.entries(state.changeDecisionContinuations ?? {}).some((
      [id, value],
    ) => value !== "resumed" && id !== exactNetworkWait?.changeId)
  ) {
    add(
      "EVOLUTION_CHANGE_CONTINUATION",
      "A change continuation remains unsettled",
    );
  }
  if (
    state.configuration?.changes.some((change) =>
      change.status === "pending" ||
      change.publication && !change.publication.completed
    )
  ) add("EVOLUTION_PENDING_CHANGE", "A change awaits decision or publication");
  if (
    state.candidates.some((candidate) =>
      candidate.promotionCursor || candidate.admissionContinuation ||
      ["proposed", "testing", "reviewing", "awaiting-admission", "activating"]
        .includes(candidate.stage) ||
      candidate.activationModelDigest && candidate.stage !== "active"
    )
  ) {
    add(
      "EVOLUTION_CANDIDATE_UNSETTLED",
      "A candidate, promotion or activation remains unsettled",
    );
  }
  if (
    state.conversationBatches?.some((batch) =>
      batch.immutableGroup && !batch.immutableGroup.publication ||
      batch.calls.some((call) =>
        !["completed", "cancelled"].includes(call.status)
      )
    )
  ) add("EVOLUTION_BATCH_UNSETTLED", "A batch call is unfinished or uncertain");
  if (
    state.requestResumptions?.some((receipt) => receipt.status === "started") ||
    state.cases?.some((record) => record.firstRequestDispatch)
  ) {
    add(
      "EVOLUTION_DISPATCH_UNSETTLED",
      "A Request dispatch has no terminal receipt",
    );
  }
  for (const message of state.messages) {
    const work = workReceipt(message);
    if (!work) continue;
    const invocation = work.designerContext
      ? {
        kind: "delegated-designer" as const,
        work: { ...work, designerContext: work.designerContext },
      }
      : work.caseContext
      ? {
        kind: "delegated" as const,
        work: { ...work, caseContext: work.caseContext },
      }
      : undefined;
    if (
      !invocation || !terminalReceipt(state, invocation) &&
        !(message.id === exactNetworkWait?.inputMessageId &&
          invocationKey(invocation) === exactNetworkWait.identity.invocationKey)
    ) {
      add(
        "EVOLUTION_CONTRIBUTION_UNSETTLED",
        `Contribution ${work.correlationId} has no completed durable receipt`,
      );
    }
  }
  const continuations = Object.entries(state.invocationContinuations ?? {});
  if (state.conversationCursor && state.caseInvocation) {
    continuations.push([invocationKey(state.caseInvocation), {
      ...state,
      invocation: state.caseInvocation,
    }]);
  }
  if (state.conversationCursor && !state.caseInvocation) {
    add(
      "EVOLUTION_ORPHAN_CURSOR",
      "An active cursor has no exact invocation identity",
    );
  }
  for (const [key, saved] of continuations) {
    if (
      !saved.conversationCursor &&
      (saved.conversationFlow ||
        saved.conversationContext &&
          Object.keys(saved.conversationContext).length)
    ) {
      add(
        "EVOLUTION_ORPHAN_CONTINUATION",
        `Retained invocation ${key} has execution data without a cursor`,
      );
    }
    if (
      saved.budgetSuspension || saved.workBudget?.reserved ||
      saved.activeBatchCall ||
      saved.conversationCursor && !emptyEvolutionAwait(state, saved) &&
        invocationKey(saved.invocation) !==
          exactNetworkWait?.identity.invocationKey
    ) {
      add(
        "EVOLUTION_SAVED_CONTINUATION",
        `Retained invocation ${key} still depends on the old model`,
      );
    }
  }
  for (const execution of executions) {
    if (
      execution.identity.operatorId !==
        state.executionModel?.identity.builderId ||
      execution.unsettledEffects.length ||
      execution.openImmutableConsultationGroups?.length ||
      (execution.pendingContributions ?? []).some((id) => {
        const receipt = state.pendingContributions?.[id];
        return !receipt || receipt.status === "pending" ||
          !receipt.completionId;
      }) ||
      ["running", "failed", "uncertain", "advancing"].includes(
        execution.status,
      ) ||
      execution.status === "waiting" &&
        !emptyNativeEvolutionAwait(
          state,
          execution,
          nativeEvolutionModel(state, execution, historicalModels),
        ) &&
        (!exactNetworkWait || execution.threadId !== networkThreadId ||
          canonical(execution.localState?.changeApprovalWait ?? null) !==
            canonical(exactNetworkWait))
    ) {
      add(
        "EVOLUTION_NATIVE_EXECUTION_UNSETTLED",
        `Native execution ${execution.threadId} still depends on its exact admitted model`,
      );
    }
  }
  return { safe: blockers.length === 0, blockers };
}

export function evolutionCheckpoint(
  state: SystemRuntimeState,
  executions: readonly NativeExecutionSnapshot[] = [],
  historicalModels: readonly ExecutableModel[] = [],
): EvolutionCheckpoint {
  return evaluateEvolutionCheckpoint(state, executions, historicalModels);
}

/** Readiness only. The SQL transaction must still verify the completed effect,
 * durable checkpoint, human decision and publication under its own locks. */
export async function evolutionNetworkCheckpoint(
  state: SystemRuntimeState,
  executions: readonly NativeExecutionSnapshot[],
  changeId: string,
  caseId: string,
  historicalModels: readonly ExecutableModel[] = [],
): Promise<EvolutionCheckpoint> {
  const change = state.configuration?.changes.find((entry) =>
    entry.id === changeId
  );
  // The approved Request change of either effect (4.8e E4): a network
  // request or a team creation, each decided by its own authorities.
  if (
    !change || change.status !== "approved" || !state.executionModel ||
    !(requestChangeEffect(change) === "team-member"
      ? decidedByTeamAuthority(change)
      : decidedByNetworkAuthority(change))
  ) return evolutionCheckpoint(state, executions, historicalModels);
  let digest: string;
  try {
    digest = await requestChangeProposalDigest(change);
  } catch {
    return evolutionCheckpoint(state, executions, historicalModels);
  }
  const decision = state.requestNetworkDecisions?.[changeId];
  if (
    !decision || decision.verdict !== "approve" || decision.caseId !== caseId ||
    decision.commandId !== changeId ||
    decision.proposalIntentDigest !== digest ||
    decision.configurationRevision !==
      state.executionModel.configuration.revision ||
    change.baseModelDigest !== state.executionModel.version.digest ||
    change.diff?.base.repositoryVersion !==
          state.executionModel.version.repositoryVersion &&
      // A member's unchanged model may retain R while its team publication
      // uses A. The exact native wait remains on R; atomic adoption proves A.
      !(requestChangeEffect(change) === "team-member" &&
        state.executionModel.operatorTeam &&
        change.diff?.base.modelDigest ===
          state.executionModel.version.digest) ||
    !hasHostRequestChangeCase(state, change, {
      caseId,
      openingId: decision.openingId,
    }) ||
    state.id !==
      `request:${decision.executionSpaceId}:${state.executionModel.identity.builderId}`
  ) {
    return evolutionCheckpoint(state, executions, historicalModels);
  }
  const matches = executions.flatMap((execution) => {
    const wait = exactNativeChangeApprovalWait(
      state,
      execution,
      state.executionModel!,
      { changeId, caseId, proposalIntentDigest: digest },
    );
    return wait ? [{ wait, threadId: execution.threadId }] : [];
  });
  if (matches.length !== 1) {
    return evolutionCheckpoint(state, executions, historicalModels);
  }
  return evaluateEvolutionCheckpoint(
    state,
    executions,
    historicalModels,
    matches[0].wait,
    matches[0].threadId,
  );
}

/** Only the actual declared-action outcome projected by the native adapter can
 * replace an assistant reply. SQL retirement also matches its complete snapshot
 * to the accepted native run before using this business-boundary predicate. */
function declaredConsultationRefusalReceipt(
  state: SystemRuntimeState,
  execution: NativeExecutionSnapshot,
  invocation: InvocationContinuation["invocation"],
  model: ExecutableModel,
): boolean {
  const value = execution.localState?.declaredConsultationRefusal;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as NativeDeclaredConsultationRefusal;
  const input = evolutionInvocationInput(state, invocation);
  const selectedInputId = state.caseInvocation &&
      invocationKey(state.caseInvocation) === execution.identity.invocationKey
    ? state.activeInputMessageId
    : state.invocationContinuations?.[execution.identity.invocationKey]
      ?.inputMessageId;
  if (
    !input || !execution.checkpointId || receipt.version !== 1 ||
    selectedInputId !== undefined &&
      selectedInputId !== receipt.inputMessageId ||
    receipt.contributionId !== execution.contributionId ||
    receipt.inputMessageId !== input.id ||
    receipt.inputMessageId !== execution.identity.subjectId ||
    typeof receipt.repositoryVersion !== "string" ||
    !receipt.repositoryVersion.length ||
    receipt.modelDigest !== execution.modelDigest ||
    receipt.repositoryVersion !== execution.repositoryVersion ||
    receipt.repositoryVersion !==
      model.version.repositoryVersion ||
    receipt.flowRootId !== execution.flowRootId ||
    canonical(receipt.identity) !== canonical(execution.identity) ||
    typeof receipt.effectKey !== "string" ||
    !/^native-effect:[0-9a-f]{64}$/.test(receipt.effectKey) ||
    typeof receipt.code !== "string" || !receipt.code.length ||
    receipt.code.length > 128
  ) return false;
  const flow = [
    model.flows.conversation,
    ...Object.values(model.caseFlows ?? {}),
  ].find((candidate) =>
    candidate.rootNativeId === execution.flowRootId &&
    candidate.rootOccurrenceId === receipt.flowOccurrenceId
  );
  if (
    !flow?.nodes.some((node) =>
      node.id === receipt.nodeId && node.nativeId === receipt.actionId &&
      node.mechanism === "consult_declared_source"
    ) || !flow.nodes.some((node) =>
      node.id === execution.waits[0]?.nodeId && node.mechanism === "await_input"
    )
  ) return false;
  try {
    return canonical(
      nativeExecutionIdentity(
        {
          ...state,
          caseInvocation: invocation,
          activeInputMessageId: input.id,
        },
        "conversation",
        input.id,
      ),
    ) === canonical(execution.identity);
  } catch {
    return false;
  }
}

/** Historical models are evidence of a source pin, never adoption authority. */
export function nativeEvolutionModel(
  state: SystemRuntimeState,
  execution: NativeExecutionSnapshot,
  historicalModels: readonly ExecutableModel[] = [],
): ExecutableModel | undefined {
  return [state.executionModel, ...historicalModels].find((model) =>
    model?.identity.builderId === state.executionModel?.identity.builderId &&
    model?.version.digest === execution.modelDigest &&
    model?.version.repositoryVersion === execution.repositoryVersion
  );
}

/** A delegated reply belongs only to its completed contribution's recorded
 * segments. Another contribution may have run between those segments. */
function delegatedTerminalMessages(
  state: SystemRuntimeState,
  execution: NativeExecutionSnapshot,
  invocation: Extract<
    InvocationContinuation["invocation"],
    { kind: "delegated" | "delegated-designer" }
  >,
  inputIndex: number,
) {
  const work = invocation.work;
  const input = workReceipt(state.messages[inputIndex]);
  if (
    !input || input.callerId !== work.callerId ||
    input.correlationId !== work.correlationId ||
    input.fingerprint !== work.fingerprint ||
    input.invocationId !== work.invocationId ||
    input.targetNativeId !== work.targetNativeId || input.caseId !== work.caseId
  ) return undefined;
  const events = state.events.filter((event) => {
    const receipt = (event as Partial<OperatorWorkCompletion>).work;
    return receipt?.callerId === work.callerId &&
      receipt.correlationId === work.correlationId &&
      receipt.fingerprint === work.fingerprint &&
      receipt.caseId === work.caseId;
  }) as OperatorWorkCompletion[];
  const completed = events.at(-1)?.work;
  if (
    !completed || completed.status !== "completed" || completed.error ||
    completed.continuation ||
    completed.modelVersion.digest !== execution.modelDigest ||
    completed.modelVersion.repositoryVersion !== execution.repositoryVersion ||
    !Number.isSafeInteger(completed.messageCount) ||
    completed.messageCount > state.messages.length ||
    !completed.messageRanges?.length
  ) return undefined;
  const evidence = (receipt: OperatorWorkCompletion["work"]) =>
    canonical({
      messageCount: receipt.messageCount,
      messageRanges: receipt.messageRanges ?? null,
      modelVersion: receipt.modelVersion,
    });
  if (
    events.some((event) =>
      event.work.status === "completed" &&
      evidence(event.work) !== evidence(completed)
    )
  ) return undefined;
  let previousEnd = -1;
  for (const range of completed.messageRanges) {
    if (
      !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
      range.start < 0 || range.start < previousEnd ||
      range.end <= range.start || range.end > completed.messageCount
    ) return undefined;
    previousEnd = range.end;
  }
  if (
    !completed.messageRanges.some((range) =>
      range.start <= inputIndex && inputIndex < range.end
    )
  ) return undefined;
  const messages = completed.messageRanges.flatMap(({ start, end }) =>
    state.messages.slice(start, end)
  );
  if (
    messages.some((message) => {
      const receipt = workReceipt(message);
      return receipt &&
        (receipt.callerId !== work.callerId ||
          receipt.correlationId !== work.correlationId ||
          receipt.fingerprint !== work.fingerprint ||
          receipt.caseId !== work.caseId);
    })
  ) return undefined;
  return messages;
}

/** Exact framework wait plus a canonical terminal receipt under its source pin.
 * A caller may supply an independently loaded immutable historical model. The
 * current admitted model is never replaced by that evidence. */
export function emptyNativeEvolutionAwait(
  state: SystemRuntimeState,
  execution: NativeExecutionSnapshot,
  sourceModel: ExecutableModel | undefined = state.executionModel,
): boolean {
  if (
    !sourceModel || !execution.checkpointId || !execution.contributionId ||
    execution.status !== "waiting" || execution.unsettledEffects.length ||
    execution.openImmutableConsultationGroups?.length ||
    (execution.pendingContributions ?? []).some((id) =>
      state.pendingContributions?.[id]?.status === "pending" ||
      !state.pendingContributions?.[id]?.completionId
    ) ||
    execution.identity.purpose !== "conversation" ||
    execution.waits.length !== 1 ||
    execution.waits[0].kind !== "input" ||
    execution.waits[0].mechanism !== "await_input" ||
    execution.identity.operatorId !==
      state.executionModel?.identity.builderId ||
    sourceModel.identity.builderId !== execution.identity.operatorId ||
    execution.modelDigest !== sourceModel.version.digest ||
    execution.repositoryVersion !== sourceModel.version.repositoryVersion ||
    sourceModel.version.digest !== state.executionModel.version.digest &&
      !execution.repositoryVersion
  ) return false;
  const invocation = state.caseInvocation &&
      invocationKey(state.caseInvocation) === execution.identity.invocationKey
    ? state.caseInvocation
    : state.invocationContinuations?.[execution.identity.invocationKey]
      ?.invocation;
  if (!invocation || !execution.identity.subjectId) return false;
  const inputIndex = state.messages.findIndex((message) =>
    message.id === execution.identity.subjectId
  );
  if (inputIndex < 0) return false;
  // A completed old input cannot borrow the reply from a later input in the
  // same Request/designer. Keep current pending/error/budget journals intact.
  let end = state.messages.length;
  for (let index = inputIndex + 1; index < state.messages.length; index++) {
    const message = state.messages[index];
    if (message.role !== "user" && message.role !== "tool") continue;
    const input = evolutionInvocationInput({
      ...state,
      caseInvocation: invocation,
      activeInputMessageId: message.id,
      messages: state.messages.slice(0, index + 1),
    }, invocation);
    if (input?.id === message.id) {
      end = index;
      break;
    }
  }
  const selected = {
    ...state,
    caseInvocation: invocation,
    activeInputMessageId: execution.identity.subjectId,
    messages: state.messages.slice(0, end),
  };
  if (
    evolutionInvocationInput(selected, invocation)?.id !==
      execution.identity.subjectId
  ) return false;
  try {
    if (
      canonical(
        nativeExecutionIdentity(
          selected,
          "conversation",
          execution.identity.subjectId,
        ),
      ) !== canonical(execution.identity)
    ) return false;
  } catch {
    return false;
  }
  const flow = [
    sourceModel.flows.conversation,
    ...Object.values(sourceModel.caseFlows ?? {}),
  ].find((flow) =>
    flow.rootNativeId === execution.flowRootId &&
    flow.nodes.some((node) =>
      node.id === execution.waits[0].nodeId && node.mechanism === "await_input"
    )
  );
  if (!flow) return false;
  const messages =
    invocation.kind === "delegated" || invocation.kind === "delegated-designer"
      ? delegatedTerminalMessages(state, execution, invocation, inputIndex)
      : selected.messages.slice(inputIndex + 1);
  if (!messages) return false;
  // runTurn persists the actual chosen reply DTO, not a text cache. Its
  // original input may predate an authorized candidate/mandate pin advance.
  const reply = execution.localState?.reply;
  const replyText =
    reply && typeof reply === "object" && !Array.isArray(reply) &&
      "kind" in reply && reply.kind === "reply" && "text" in reply &&
      typeof reply.text === "string"
      ? reply.text
      : undefined;
  const replied = replyText !== undefined &&
    terminalReceipt(selected, invocation) &&
    messages.some((message) =>
      message.role === "assistant" && message.text === replyText &&
      (invocation.kind === "local" || invocation.kind === "delegated"
        ? message.caseId ===
          (invocation.kind === "local"
            ? invocation.caseId
            : invocation.work.caseId)
        : message.designerScopeId ===
          (invocation.kind === "designer"
            ? invocation.scopeId
            : invocation.work.designerContext.scopeId))
    );
  const refusalState =
    sourceModel.version.digest === state.executionModel?.version.digest &&
      sourceModel.version.repositoryVersion ===
        state.executionModel.version.repositoryVersion
      ? state
      : selected;
  if (
    !replied &&
    !declaredConsultationRefusalReceipt(
      refusalState,
      execution,
      invocation,
      sourceModel,
    )
  ) return false;
  const saved = state.caseInvocation &&
      invocationKey(state.caseInvocation) === execution.identity.invocationKey
    ? state
    : state.invocationContinuations?.[execution.identity.invocationKey];
  return !saved?.budgetSuspension && !saved?.workBudget?.reserved &&
    !saved?.activeBatchCall && !saved?.error && !saved?.lastToolFailure;
}

/** This is distinct from an empty wait: the exact completed proposal effect
 * must be verified again by the SQL retirement transaction. */
export function exactNativeChangeApprovalWait(
  state: SystemRuntimeState,
  execution: NativeExecutionSnapshot,
  model: ExecutableModel,
  expected: { changeId: string; proposalIntentDigest: string; caseId: string },
): NativeChangeApprovalWait | undefined {
  const wait = execution.localState?.changeApprovalWait as
    | NativeChangeApprovalWait
    | undefined;
  if (
    !wait || wait.version !== 1 ||
    execution.status !== "waiting" || !execution.checkpointId ||
    execution.waits.length !== 1 || execution.waits[0].kind !== "input" ||
    execution.waits[0].mechanism !== "await_input" ||
    execution.unsettledEffects.length ||
    execution.openImmutableConsultationGroups?.length ||
    execution.pendingContributions.length ||
    execution.identity.purpose !== "conversation" ||
    execution.identity.scope.kind !== "request" ||
    execution.identity.scope.scopeId !== expected.caseId ||
    execution.identity.scope.rootRequestId !== expected.caseId ||
    wait.changeId !== expected.changeId ||
    wait.proposalIntentDigest !== expected.proposalIntentDigest ||
    !/^[a-f0-9]{64}$/.test(wait.proposalIntentDigest) ||
    !/^native-effect:[a-f0-9]{64}$/.test(wait.effectKey) ||
    canonical(wait.identity) !== canonical(execution.identity) ||
    wait.contributionId !== execution.contributionId ||
    wait.inputMessageId !== execution.identity.subjectId ||
    wait.modelDigest !== execution.modelDigest ||
    wait.repositoryVersion !== execution.repositoryVersion ||
    wait.modelDigest !== model.version.digest ||
    wait.repositoryVersion !== model.version.repositoryVersion ||
    wait.flowRootId !== execution.flowRootId ||
    execution.identity.operatorId !== model.identity.builderId
  ) return undefined;
  const flow = [
    model.flows.conversation,
    ...Object.values(model.caseFlows ?? {}),
  ].find((item) =>
    item.rootNativeId === wait.flowRootId &&
    item.rootOccurrenceId === wait.flowOccurrenceId
  );
  if (
    !flow?.nodes.some((node) =>
      node.id === wait.nodeId && node.nativeId === wait.actionId &&
      node.mechanism === "submit_proposal"
    ) ||
    !flow.nodes.some((node) =>
      node.id === execution.waits[0].nodeId && node.mechanism === "await_input"
    ) ||
    !state.configuration?.changes.some((change) =>
      change.id === expected.changeId && change.caseId === expected.caseId &&
      change.requestedBy === model.identity.builderId
    )
  ) return undefined;
  const invocation = state.caseInvocation &&
      invocationKey(state.caseInvocation) === execution.identity.invocationKey
    ? state.caseInvocation
    : state.invocationContinuations?.[execution.identity.invocationKey]
      ?.invocation;
  if (
    !invocation ||
    evolutionInvocationInput(state, invocation)?.id !== wait.inputMessageId
  ) return undefined;
  try {
    if (
      canonical(
        nativeExecutionIdentity(
          {
            ...state,
            caseInvocation: invocation,
            activeInputMessageId: wait.inputMessageId,
          },
          "conversation",
          wait.inputMessageId,
        ),
      ) !== canonical(execution.identity)
    ) return undefined;
  } catch {
    return undefined;
  }
  return structuredClone(wait);
}

/** Persist the old cursor reference before native adoption can replace a flow. */
export function retireEvolutionAwaits(
  state: SystemRuntimeState,
  dossierId: string,
  at: string,
  executions: readonly NativeExecutionSnapshot[] = [],
  historicalModels: readonly ExecutableModel[] = [],
): void {
  for (const execution of executions) {
    if (
      !emptyNativeEvolutionAwait(
        state,
        execution,
        nativeEvolutionModel(state, execution, historicalModels),
      )
    ) continue;
    const id =
      `evolution-native-retirement:${dossierId}:${execution.threadId}:${execution.checkpointId}`;
    if (!state.events.some((event) => event.id === id)) {
      state.events.push({
        id,
        at,
        kind: "evolution-empty-await-retired",
        label: canonical({
          dossierId,
          threadId: execution.threadId,
          checkpointId: execution.checkpointId,
          contributionId: execution.contributionId,
          inputMessageId: execution.identity.subjectId,
          repositoryVersion: execution.repositoryVersion,
          invocation: execution.identity.invocationKey,
          scope: execution.identity.scope,
          modelDigest: execution.modelDigest,
          flow: execution.flowRootId,
        }),
      });
    }
  }
  const retire = (
    key: string,
    saved: Pick<
      InvocationContinuation,
      | "conversationCursor"
      | "conversationFlow"
      | "conversationContext"
      | "budgetSuspension"
      | "activeBatchCall"
      | "error"
      | "lastToolFailure"
      | "invocation"
    >,
  ) => {
    if (!emptyEvolutionAwait(state, saved)) return;
    state.events.push({
      id: `evolution-retirement:${
        canonical([dossierId, key, state.revision, state.events.length])
      }`,
      at,
      kind: "evolution-empty-await-retired",
      label: canonical({
        dossierId,
        invocation: key,
        inputMessageId: evolutionInvocationInput(state, saved.invocation)?.id,
        cursor: saved.conversationCursor,
        flow: saved.conversationFlow?.rootNativeId,
        modelDigest: state.executionModel?.version.digest,
      }),
    });
    delete saved.conversationCursor;
    delete saved.conversationContext;
    delete saved.conversationFlow;
  };
  for (
    const [key, saved] of Object.entries(state.invocationContinuations ?? {})
  ) retire(key, saved);
  if (state.caseInvocation) {
    const selected = { ...state, invocation: state.caseInvocation };
    retire(invocationKey(state.caseInvocation), selected);
    state.conversationCursor = selected.conversationCursor;
    state.conversationContext = selected.conversationContext;
    state.conversationFlow = selected.conversationFlow;
  }
}

export function inspectEvolutionAdoption(
  state: SystemRuntimeState,
  dossier: EvolutionDossier,
  target: EvolutionTarget,
  publication: EvolutionPublication,
): EvolutionAdoptionReceipt | null {
  const event = state.events.find((event) => {
    const update = event.effectiveModelUpdate;
    return update?.dossierId === dossier.id &&
      update.operatorId === target.operatorId &&
      update.from.digest === target.previousDigest &&
      update.to.digest === target.candidateDigest &&
      update.to.repositoryVersion === publication.version &&
      update.actorId === dossier.adoptionAuthorization?.operatorNativeId;
  });
  if (!event?.effectiveModelUpdate) return null;
  if (state.executionModel?.version.digest !== target.candidateDigest) {
    throw new EvolutionError(
      "EVOLUTION_ADOPTION_DRIFT",
      "Durable adoption receipt conflicts with the runtime pin",
    );
  }
  return {
    ...target,
    version: publication.version,
    proposalDigest: dossier.proposal.digest,
    effectiveAt: event.effectiveModelUpdate.activatedAt,
  };
}

export function evolutionBudgetScopes(
  state: SystemRuntimeState,
): BehaviorSettingsBudgetScope[] {
  const ownerId = state.executionModel!.identity.builderId;
  const scopes: BehaviorSettingsBudgetScope[] = [];
  if (state.designer?.budget) {
    scopes.push({
      scopeId: state.designer.budget.scopeId,
      ownerId,
      designer: true,
    });
  }
  for (const record of state.cases ?? []) {
    if (record.budget) {
      scopes.push({
        scopeId: record.budget.scopeId,
        ownerId: record.owner,
        caseTypeId: record.caseTypeId,
        ceiling: record.scheduling?.maxInvocations,
      });
    }
  }
  const invocations = [
    state.caseInvocation,
    ...Object.values(state.invocationContinuations ?? {}).map((saved) =>
      saved.invocation
    ),
  ];
  for (const invocation of invocations) {
    if (invocation?.kind === "delegated-designer") {
      scopes.push({
        scopeId: invocation.work.designerContext.scopeId,
        ownerId: invocation.work.designerContext.ownerId,
        designer: true,
      });
    }
    if (invocation?.kind === "delegated") {
      const context = invocation.work.caseContext;
      scopes.push({
        scopeId: context.budget?.scopeId ?? context.caseId,
        ownerId: context.budget?.ownerId ?? context.record?.owner ?? ownerId,
        caseTypeId: context.record?.caseTypeId,
        ceiling: context.record?.scheduling?.maxInvocations,
      });
    }
  }
  if (
    state.workBudgetBinding &&
    !scopes.some((scope) => scope.scopeId === state.workBudgetBinding!.scopeId)
  ) {
    scopes.push({
      scopeId: state.workBudgetBinding.scopeId,
      ownerId,
      pending: state.caseBudgetPending,
      designer: state.caseInvocation?.kind === "designer",
    });
  }
  return [
    ...new Map(
      scopes.map((scope) => [canonical([scope.scopeId, scope.ownerId]), scope]),
    ).values(),
  ];
}

/** Capture scope from host runtime state, never from the preparer's JSON map. */
export function captureEvolutionOrigin(
  input: {
    actorId: string;
    origin: import("../../model/evolution/ports.ts").EvolutionOrigin;
  },
  proposal: import("../../model/evolution/ports.ts").EvolutionProposal,
  snapshots: readonly SystemRuntimeState[],
): import("../../model/evolution/ports.ts").EvolutionOrigin {
  const actor = snapshots.find((state) =>
    state.executionModel?.identity.builderId === input.actorId
  );
  if (!actor || input.origin.operatorId !== input.actorId) {
    throw new EvolutionError(
      "EVOLUTION_ORIGIN_MISMATCH",
      "Evolution origin is not the actual preparing operator",
    );
  }
  const scope = (
    state: SystemRuntimeState,
  ): { requestId?: string; designerScopeId?: string } => {
    const invocation = state.caseInvocation;
    if (invocation?.kind === "local") {
      const record = state.cases?.find((record) =>
        record.id === invocation.caseId &&
        record.owner === state.executionModel?.identity.builderId &&
        (record.status === "open" || record.status === "waiting")
      );
      if (!record) {
        throw new EvolutionError(
          "EVOLUTION_ORIGIN_MISMATCH",
          "The current Request has no live host provenance",
        );
      }
      return { requestId: record.id };
    }
    if (invocation?.kind === "delegated") {
      const context = invocation.work.caseContext;
      const owner = snapshots.find((candidate) =>
        candidate.cases?.some((record) =>
          record.id === context.caseId &&
          record.owner === candidate.executionModel?.identity.builderId &&
          (record.status === "open" || record.status === "waiting")
        )
      );
      if (!owner || invocation.work.caseId !== context.caseId) {
        throw new EvolutionError(
          "EVOLUTION_ORIGIN_MISMATCH",
          "The delegated Request has no actual live owner",
        );
      }
      return { requestId: context.caseId };
    }
    if (invocation?.kind === "designer") {
      if (state.designer?.scopeId !== invocation.scopeId) {
        throw new EvolutionError(
          "EVOLUTION_ORIGIN_MISMATCH",
          "The designer scope differs from its host identity",
        );
      }
      return { designerScopeId: invocation.scopeId };
    }
    if (invocation?.kind === "delegated-designer") {
      const context = invocation.work.designerContext;
      if (
        !snapshots.some((owner) =>
          owner.designer?.scopeId === context.scopeId &&
          owner.executionModel?.identity.builderId === context.ownerId
        )
      ) {
        throw new EvolutionError(
          "EVOLUTION_ORIGIN_MISMATCH",
          "The delegated designer has no actual host owner",
        );
      }
      return { designerScopeId: context.scopeId };
    }
    return {};
  };
  const actual = scope(actor);
  if (
    input.origin.requestId !== actual.requestId ||
    input.origin.designerScopeId !== actual.designerScopeId
  ) {
    throw new EvolutionError(
      "EVOLUTION_ORIGIN_MISMATCH",
      "Claimed evolution source scope differs from the actual invocation",
    );
  }
  const targetScopes: NonNullable<
    import("../../model/evolution/ports.ts").EvolutionOrigin["targetScopes"]
  > = [];
  for (const target of proposal.targets) {
    const state = snapshots.find((state) =>
      state.executionModel?.identity.builderId === target.operatorId
    );
    if (!state) continue;
    let targetScope: ReturnType<typeof scope>;
    try {
      targetScope = scope(state);
    } catch {
      continue;
    }
    const sameRequest = !!actual.requestId &&
      targetScope.requestId === actual.requestId;
    const sameDesigner = !!actual.designerScopeId &&
      targetScope.designerScopeId === actual.designerScopeId;
    const team = state.executionModel?.operatorTeam;
    const targetRequest = state.cases?.find((record) =>
      record.id === targetScope.requestId
    );
    const actualTeamRequest = !!actual.requestId &&
      team?.requestId === actual.requestId &&
      team.parentOperatorId === input.actorId &&
      targetRequest?.openedFrom.caseId === actual.requestId &&
      targetRequest.openedFrom.conversationId === actor.id &&
      targetRequest.openedBy === input.actorId;
    if (
      (sameRequest || sameDesigner || actualTeamRequest) &&
      (targetScope.requestId || targetScope.designerScopeId)
    ) targetScopes.push({ operatorId: target.operatorId, ...targetScope });
  }
  return {
    operatorId: input.actorId,
    ...actual,
    ...(targetScopes.length ? { targetScopes } : {}),
  };
}
