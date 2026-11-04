import { CaseError } from "../../../domain/work/errors/case.ts";
import {
  type CaseClosureEvidence,
  type CaseKind,
  closeCase,
  isOpenCase,
  MAX_CASE_OBJECTIVE_CHARS,
  openCase,
} from "../../../domain/work/entities/cases.ts";
import { truncateText } from "../context/separation.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { WorkBudgetPolicy } from "../../../domain/work/policies/budget.ts";
import type { CaseExecutionContext } from "../../../domain/work/execution/modeled-behavior.ts";
import {
  type DesignerExecutionContext,
  validDesignerContext,
} from "../../../domain/work/execution/case-context.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import { caseTypesForModel } from "../../../domain/work/records/case-types.ts";
import type { ClockPort } from "../runtime/ports.ts";
import { candidateIsPending } from "../candidates/case-candidates.ts";
import {
  candidateCaseInvocation,
  invocationInput,
  invocationKey,
  isInitializationAdmission,
} from "../operators/journal.ts";

/** A typed ceiling narrows the admitted legacy budget, or supplies its own policy.
 * No executable model bytes are changed by this runtime interpretation.
 */
export function caseBudgetPolicy(
  model: ExecutableModel,
  caseTypeId?: string,
  ceiling?: number,
): WorkBudgetPolicy | undefined {
  const selected = caseTypesForModel(model).find((entry) =>
    caseTypeId ? entry.id === caseTypeId : entry.type === "request" &&
      entry.ownerId === model.identity.builderId &&
      entry.behaviorId === model.flows.conversation.rootNativeId
  );
  const legacy = model.workBudgetPolicy;
  const limit = ceiling === undefined
    ? selected?.maxInvocations
    : Math.min(ceiling, selected?.maxInvocations ?? ceiling);
  if (limit === undefined) return legacy;
  return legacy ? { ...legacy, limit: Math.min(legacy.limit, limit) } : {
    id: `${selected?.id ?? caseTypeId}:invocations`,
    revision: 1,
    unit: "agent-invocation",
    limit,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
  };
}

export function localRequestCase(
  state: Pick<SystemRuntimeState, "cases" | "caseInvocation">,
) {
  const selected = currentCase(state);
  return selected?.type === "request" &&
      selected.openedFrom.origin !== "initialization"
    ? selected
    : undefined;
}

/** Only an explicit local, open Request can receive a human continuation. */
export function humanRequestCase(state: SystemRuntimeState, caseId: string) {
  const agentId = state.executionModel!.identity.builderId;
  const context = { caseId, agentId };
  const recovery =
    "Select an open Request owned by this agent or send newConversation: true.";
  const record = state.cases?.find((item) => item.id === caseId);
  if (!record) {
    throw new CaseError("CASE_NOT_FOUND", "Unknown Request", context, recovery);
  }
  if (record.owner !== agentId) {
    throw new CaseError(
      "CASE_NOT_OWNED",
      "Request belongs to another agent",
      context,
      recovery,
    );
  }
  if (
    record.type !== "request" || record.openedFrom.origin === "initialization"
  ) {
    throw new CaseError(
      "INVALID_CASE",
      "Human messages require a conversation Request",
      context,
      recovery,
    );
  }
  if (!isOpenCase(record)) {
    throw new CaseError("CASE_CLOSED", "Request is closed", context, recovery);
  }
  return record;
}

/** Untagged legacy messages belong to the designer, including after migration. */
export function caseMessages(state: SystemRuntimeState) {
  const caseId = caseExecutionContext(state)?.caseId;
  if (caseId) {
    return state.messages.filter((message) => message.caseId === caseId);
  }
  const designer = designerExecutionContext(state);
  if (!designer) return [];
  return state.messages.filter((message) =>
    message.caseId === undefined &&
    (message.designerScopeId === designer.scopeId ||
      state.caseInvocation?.kind === "designer" &&
        message.designerScopeId === undefined)
  );
}

/** Absence of a Case never implies a designer invocation. */
export function designerExecutionContext(
  state: Pick<
    SystemRuntimeState,
    "designer" | "caseInvocation" | "executionModel"
  >,
): DesignerExecutionContext | undefined {
  const invocation = state.caseInvocation;
  if (invocation?.kind === "delegated-designer") {
    const work = invocation.work;
    return validDesignerContext(work?.designerContext) &&
        work.caseId === undefined && work.caseContext === undefined
      ? structuredClone(work.designerContext)
      : undefined;
  }
  if (
    invocation?.kind !== "designer" || !state.designer ||
    invocation.scopeId !== state.designer.scopeId || !state.executionModel
  ) return undefined;
  return {
    scopeId: state.designer.scopeId,
    ownerId: state.executionModel.identity.builderId,
    ...(state.executionModel.workBudgetPolicy
      ? { policy: structuredClone(state.executionModel.workBudgetPolicy) }
      : {}),
  };
}

/** The design conversation's scope, known before the person speaks: a
 * registered Main is reachable at once and its first designer turn persists
 * this exact scope, so a notice addressed to it never waits for that turn. */
export function designerScopeId(
  state: Pick<SystemRuntimeState, "id" | "designer">,
): string {
  return state.designer?.scopeId ?? `${state.id}:designer`;
}

export function selectDesignerInvocation(state: SystemRuntimeState): void {
  const fresh = state.designer === undefined;
  const policy = state.executionModel?.workBudgetPolicy;
  if (!fresh && policy && !state.designer?.budget) {
    throw new CaseError(
      "CASE_SCOPE_MISSING",
      "The designer's durable budget binding is missing",
      { conversationId: state.id },
      "Restore the designer's original budget binding before resuming.",
    );
  }
  state.designer ??= { scopeId: designerScopeId(state) };
  selectCaseInvocation(state, {
    kind: "designer",
    scopeId: state.designer.scopeId,
  });
  if (fresh && policy) {
    state.designer.budget = {
      budgetId: policy.id,
      scopeId: state.designer.scopeId,
    };
    state.caseBudgetPending = true;
  }
  if (state.designer.budget) {
    state.workBudgetBinding = structuredClone(state.designer.budget);
  }
}

function requireRequest(type: CaseKind): void {
  if (type !== "request") {
    throw new CaseError(
      "INVALID_CASE_ACTION",
      "Scheduled Cases are created by model adoption",
      { type },
      "Propose a native CaseType and admit its model revision.",
    );
  }
}

export function currentCase(
  state: Pick<SystemRuntimeState, "cases" | "caseInvocation">,
) {
  const invocation = state.caseInvocation;
  return invocation?.kind === "local"
    ? state.cases?.find((record) =>
      record.id === invocation.caseId && isOpenCase(record)
    )
    : undefined;
}

export function delegatedCaseContext(
  state: Pick<SystemRuntimeState, "caseInvocation">,
) {
  return state.caseInvocation?.kind === "delegated"
    ? state.caseInvocation.work.caseContext
    : undefined;
}

export function caseExecutionContext(
  state: Pick<
    SystemRuntimeState,
    "cases" | "caseInvocation" | "executionModel"
  >,
): CaseExecutionContext | undefined {
  const delegated = delegatedCaseContext(state);
  if (delegated) return structuredClone(delegated);
  const record = currentCase(state);
  if (!record) return undefined;
  const policy = state.executionModel &&
    caseBudgetPolicy(
      state.executionModel,
      record.caseTypeId,
      record.scheduling?.maxInvocations,
    );
  return {
    caseId: record.id,
    number: record.number,
    modelPin: structuredClone(record.modelPin),
    record: structuredClone(record),
    ...(record.budget && policy
      ? {
        budget: {
          scopeId: record.budget.scopeId,
          ownerId: record.owner,
          policy: structuredClone(policy),
        },
      }
      : {}),
  };
}

const continuationFields = [
  "activeInputMessageId",
  "conversationCursor",
  "conversationContext",
  "conversationFlow",
  "budgetSuspension",
  "budgetPromotionCandidateId",
  "workBudget",
  "workBudgetBinding",
  "caseBudgetPending",
  "activeBatchCall",
  "error",
  "lastToolFailure",
] as const;

/** Select exact work atomically; parked data never includes authority or configuration. */
export function selectCaseInvocation(
  state: SystemRuntimeState,
  invocation: NonNullable<SystemRuntimeState["caseInvocation"]>,
): void {
  const key = invocationKey(invocation);
  if (!state.caseInvocation || invocationKey(state.caseInvocation) !== key) {
    if (state.caseInvocation) {
      const previous = {
        invocation: structuredClone(state.caseInvocation),
        inputMessageId: invocationInput(state)?.id,
        messageCount: state.messages.length,
      };
      for (const field of continuationFields) {
        if (state[field] !== undefined) {
          Object.assign(previous, { [field]: structuredClone(state[field]) });
        }
      }
      (state.invocationContinuations ??= {})[
        invocationKey(state.caseInvocation)
      ] = previous;
    }
    for (const field of continuationFields) delete state[field];
    const saved = state.invocationContinuations?.[key];
    if (saved && invocationKey(saved.invocation) === key) {
      for (const field of continuationFields) {
        if (saved[field] !== undefined) {
          Object.assign(state, { [field]: structuredClone(saved[field]) });
        }
      }
    }
  }
  state.caseInvocation = structuredClone(invocation);
  if (invocation.kind === "local") {
    const record = currentCase(state);
    if (record?.budget) {
      state.workBudgetBinding = structuredClone(record.budget);
    }
  } else if (invocation.kind === "designer" && state.designer?.budget) {
    state.workBudgetBinding = structuredClone(state.designer.budget);
  }
}

export function createRequestCase(
  state: SystemRuntimeState,
  input: {
    objective: string;
    taskSourceInputs?:
      import("../../../domain/work/task-source-input.ts").TaskSourceInputCapture[];
    messageId?: string;
    type?: CaseKind;
    openedBy?: string;
    origin?: "initialization";
    caseTypeId?: string;
    openedFrom?:
      import("../../../domain/work/entities/cases.ts").Case["openedFrom"];
    id?: string;
  },
  clock: ClockPort,
  number?: number,
): string {
  const type = input.type ?? "request";
  requireRequest(type);
  const model = state.executionModel;
  if (!model) {
    throw new CaseError(
      "INVALID_CASE",
      "A Case requires an admitted execution model",
    );
  }
  const selected = caseTypesForModel(model).find((entry) =>
    (input.caseTypeId === undefined || entry.id === input.caseTypeId) &&
    entry.type === type &&
    entry.ownerId === model.identity.builderId &&
    entry.behaviorId === model.flows.conversation.rootNativeId
  );
  if (!selected) {
    throw new CaseError(
      "NOT_SUPPORTED_YET",
      "No Request Case type is declared for this operator",
    );
  }
  if (!Number.isSafeInteger(number) || number! < 1) {
    throw new CaseError(
      "INVALID_CASE",
      "A durable system Case number is required",
    );
  }
  const id = input.id ?? `${state.id}:case:${number}`;
  // An imported legacy dossier alone retains its historical reservation scope.
  const legacyDossier = state.cases === undefined;
  const legacyBinding = legacyDossier ? state.workBudgetBinding : undefined;
  const policy = caseBudgetPolicy(model, selected.id);
  const record = openCase({
    ...(input.taskSourceInputs?.length
      ? {
        taskSourceInputs: input.taskSourceInputs.map((source) => ({
          ...structuredClone(source),
          rootRequestId: id,
        })),
      }
      : {}),
    id,
    number: number!,
    type,
    caseTypeId: selected.id,
    // The objective only labels the Case; the complete request text
    // stays in its journal message (openedFrom.messageId).
    objective: input.objective.trim(),
    owner: model.identity.builderId,
    openedBy: input.openedBy ?? model.identity.builderId,
    openedFrom: {
      conversationId: state.id,
      ...input.openedFrom,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
    },
    modelPin: {
      digest: model.version.digest,
      ...(model.version.repositoryVersion
        ? { repositoryVersion: model.version.repositoryVersion }
        : {}),
    },
    ...(legacyBinding
      ? { budget: structuredClone(legacyBinding) }
      : policy
      ? { budget: { budgetId: policy.id, scopeId: id } }
      : {}),
    createdAt: clock.now(),
  });
  (state.cases ??= []).push(record);
  if (legacyDossier) {
    // Naming an existing dossier must not erase its suspended native execution.
    state.caseInvocation = { kind: "local", caseId: id };
    if (record.budget) state.workBudgetBinding = structuredClone(record.budget);
  } else selectCaseInvocation(state, { kind: "local", caseId: id });
  if (policy && !legacyBinding) state.caseBudgetPending = true;
  return id;
}

/** Explicit Request input creates a Case unless it names its exact conversation. */
export function selectHumanRequestCase(
  state: SystemRuntimeState,
  input: { objective: string; messageId: string; caseId?: string },
  clock: ClockPort,
  number?: number,
): string {
  if (input.caseId !== undefined) {
    const record = humanRequestCase(state, input.caseId);
    selectCaseInvocation(state, { kind: "local", caseId: record.id });
    record.status = "open";
    return record.id;
  }
  // Human text is bounded here; an operator objective stays identical to its source.
  return createRequestCase(
    state,
    {
      ...input,
      objective: truncateText(input.objective.trim(), MAX_CASE_OBJECTIVE_CHARS),
    },
    clock,
    number,
  );
}

/** Allocation is supplied by the shared durable system allocator before this CAS. */
export function ensureRequestCase(
  state: SystemRuntimeState,
  input: {
    objective: string;
    messageId?: string;
    type?: CaseKind;
    openedBy?: string;
  },
  clock: ClockPort,
  number?: number,
): void {
  requireRequest(input.type ?? "request");
  const existing = localRequestCase(state);
  if (existing) {
    selectCaseInvocation(state, { kind: "local", caseId: existing.id });
    existing.status = "open";
    return;
  }
  createRequestCase(
    state,
    {
      ...input,
      objective: truncateText(input.objective.trim(), MAX_CASE_OBJECTIVE_CHARS),
    },
    clock,
    number,
  );
}

export function openInitializationCase(
  state: SystemRuntimeState,
  clock: ClockPort,
  number: number,
): string {
  return createRequestCase(
    state,
    {
      objective: "Prepare the initial tools",
      openedBy: state.model!.systemId,
      origin: "initialization",
    },
    clock,
    number,
  );
}

/** Consult the execution ledger, where registered groups exist before any
 * canonical batch publication receipt has been written. */
export async function assertCaseHasNoOpenImmutableGroups(
  execution: import("../native-execution/contract.ts").NativeExecutionPort,
  operatorId: string,
  caseId: string,
): Promise<void> {
  const executions = await execution.inspect(operatorId);
  if (
    executions.some((entry) =>
      entry.identity.scope.kind === "request" &&
      entry.identity.scope.scopeId === caseId &&
      entry.openImmutableConsultationGroups?.length
    )
  ) {
    throw new CaseError(
      "CASE_BUSY",
      "An immutable consultation group still awaits publication",
      { caseId },
      "Join the exact pending receipts or abandon the Case.",
    );
  }
}

export function closeCaseById(
  state: SystemRuntimeState,
  id: string,
  outcome: "done" | "abandoned",
  clock: ClockPort,
  evidence?: CaseClosureEvidence,
): void {
  const index = state.cases?.findIndex((record) => record.id === id) ?? -1;
  if (index < 0) throw new CaseError("NOT_FOUND", "Unknown Case");
  if (
    outcome === "done" &&
    state.conversationBatches?.some((batch) =>
      batch.caseId === id && batch.immutableGroup &&
      !batch.immutableGroup.publication
    )
  ) {
    throw new CaseError(
      "CASE_BUSY",
      "An immutable consultation group still awaits publication",
      { caseId: id },
      "Join the exact pending receipts or abandon the Case.",
    );
  }
  const pending =
    state.configuration?.changes.filter((change) =>
      change.caseId === id && change.status === "pending"
    ) ?? [];
  if (outcome === "done" && pending.length) {
    throw new CaseError(
      "CASE_BUSY",
      "A change still requires an explicit decision",
      { caseId: id },
      "Decide the pending change or abandon the Case.",
    );
  }
  const closed = closeCase(
    state.cases![index],
    outcome,
    clock.now(),
    evidence,
  );
  if (outcome === "abandoned") {
    for (const change of pending) {
      change.status = "refused";
      change.decidedAt = clock.now();
      delete change.authority;
      delete change.authorityExercise;
    }
  }
  state.cases![index] = closed;
  for (const change of state.configuration?.changes ?? []) {
    if (change.caseId !== id || !state.changeWorkContinuations?.[change.id]) {
      continue;
    }
    delete state.changeWorkContinuations[change.id];
    if (state.changeDecisionContinuations) {
      delete state.changeDecisionContinuations[change.id];
    }
  }
  for (
    const [key, saved] of Object.entries(state.invocationContinuations ?? {})
  ) {
    const invocation = saved.invocation;
    if (
      invocation.kind === "local" && invocation.caseId === id ||
      invocation.kind === "delegated" && invocation.work.caseId === id
    ) {
      delete state.invocationContinuations![key];
    }
  }
  // A closed Case retains its exact receipts but cannot dispatch queued work.
  for (const batch of state.conversationBatches ?? []) {
    if (batch.caseId !== id) continue;
    for (const call of batch.calls) {
      if (call.status !== "queued" && call.status !== "started") continue;
      const unknown = call.status === "started" && call.effectStarted;
      call.status = unknown ? "unknown" : "cancelled";
      call.result = {
        status: unknown ? "unknown" : "cancelled",
        code: unknown ? "BATCH_EFFECT_UNKNOWN" : "CASE_CLOSED",
        details: unknown
          ? "The Case closed after an effect started without a durable result."
          : "The Case closed before this member completed.",
      };
    }
  }
  if (
    caseExecutionContext(state)?.caseId !== id &&
    !(state.caseInvocation?.kind === "local" &&
      state.caseInvocation.caseId === id)
  ) return;
  delete state.activeInputMessageId;
  delete state.caseInvocation;
  delete state.workBudgetBinding;
  delete state.workBudget;
  delete state.caseBudgetPending;
  delete state.conversationCursor;
  delete state.conversationContext;
  delete state.conversationFlow;
  delete state.budgetSuspension;
  delete state.budgetPromotionCandidateId;
  delete state.activeBatchCall;
}

export function closeCurrentCase(
  state: SystemRuntimeState,
  outcome: "done" | "abandoned",
  clock: ClockPort,
): void {
  const record = currentCase(state);
  if (!record) throw new CaseError("NOT_FOUND", "No current Case");
  closeCaseById(state, record.id, outcome, clock);
}

function hasPendingContinuation(state: SystemRuntimeState): boolean {
  return !!(state.conversationCursor || state.budgetSuspension ||
    state.budgetPromotionCandidateId ||
    state.candidates.some(candidateIsPending));
}

/** Shared by allocation and migration, including pre-Cases delegated work. */
export function legacyPendingDossier(state: SystemRuntimeState): boolean {
  return state.cases === undefined && !delegatedCaseContext(state) &&
    !designerExecutionContext(state) &&
    (state.messages.some((message) => message.work) ||
      hasPendingContinuation(state));
}

/** Refuse corrupt resumptions before any budget lookup or agent invocation. */
export function assertContinuationCases(state: SystemRuntimeState): void {
  for (const candidate of state.candidates.filter(candidateIsPending)) {
    if (
      !candidateCaseInvocation(state, candidate) &&
      !isInitializationAdmission(state, candidate)
    ) {
      throw new CaseError(
        "CASE_SCOPE_MISSING",
        "A pending candidate has no resumable Case",
        {
          conversationId: state.id,
          candidateId: candidate.id,
          caseId: candidate.caseId!,
        },
        "Restore the candidate's original open Case or explicitly abandon its dossier before resuming.",
      );
    }
  }
  if (
    (state.conversationCursor || state.budgetSuspension ||
      state.budgetPromotionCandidateId) &&
    !caseExecutionContext(state) &&
    !designerExecutionContext(state)
  ) {
    throw new CaseError(
      "CASE_SCOPE_MISSING",
      "A pending continuation has no explicit designer or Case scope",
      { conversationId: state.id },
      "Reload the original pre-Cases dossier through initialize() to migrate it; do not attach the continuation to a new Case.",
    );
  }
}

/** Pre-Cases state is promoted without rewriting its journal or budget ledger. */
export function migrateCases(
  state: SystemRuntimeState,
  clock: ClockPort,
  number?: number,
): void {
  if (state.cases !== undefined) return;
  if (!legacyPendingDossier(state)) {
    state.cases = [];
    if (
      !state.caseInvocation &&
      (state.messages.length > 0 || state.workBudgetBinding)
    ) {
      // A known historical ledger follows its conversation without new credit.
      // If an admitted policy has lost its binding, initialization must suspend;
      // do not manufacture a fresh binding for an already-existing conversation.
      state.designer ??= {
        scopeId: state.workBudgetBinding?.scopeId ?? `${state.id}:designer`,
        ...(state.workBudgetBinding
          ? { budget: structuredClone(state.workBudgetBinding) }
          : {}),
      };
      selectCaseInvocation(state, {
        kind: "designer",
        scopeId: state.designer.scopeId,
      });
    }
    return;
  }
  const first = state.messages.find((message) => message.role === "user") ??
    state.messages.findLast((message) => message.work);
  if (state.executionModel?.workBudgetPolicy && !state.workBudgetBinding) {
    throw new CaseError(
      "CASE_SCOPE_MISSING",
      "The legacy dossier's admitted budget binding is missing",
      { conversationId: state.id },
      "Restore the dossier's original budget binding before migrating its continuation.",
    );
  }
  ensureRequestCase(
    state,
    {
      objective: first?.text || "Reprise du dossier",
      messageId: first?.id,
      ...(first?.work ? { openedBy: first.work.callerId } : {}),
    },
    clock,
    number,
  );
  const record = currentCase(state)!;
  record.status = "waiting";
  record.migratedFrom = "legacy-dossier";
  for (const candidate of state.candidates) {
    candidate.caseId ??= record.id;
  }
}
