import {
  type Case,
  type CaseContinuation,
  isOpenCase,
  openCase,
} from "../../../domain/work/entities/cases.ts";
import { CaseError } from "../../../domain/work/errors/case.ts";
import {
  formatCaseSchedule,
  nextCaseOccurrence,
} from "../../../domain/work/value-objects/case-schedule.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { ClockPort } from "../runtime/ports.ts";
import { caseBudgetPolicy, selectCaseInvocation } from "./runtime.ts";
import { characterCount } from "../../../domain/primitives/character-count.ts";
import { errorText, makeEvent } from "../runtime/values.ts";
import type { NativeExecutionContribution } from "../runtime/execution.ts";
import type { ScheduledCaseTrigger } from "../operators/command-delivery.ts";

const continuationKeys = [
  "caseInvocation",
  "activeInputMessageId",
  "conversationCursor",
  "conversationContext",
  "conversationFlow",
  "budgetSuspension",
  "budgetPromotionCandidateId",
  "workBudget",
  "workBudgetBinding",
  "caseBudgetPending",
  "lastToolFailure",
] as const;

function restoreCaseContinuation(state: SystemRuntimeState): void {
  const execution = state.scheduledExecution;
  if (!execution) return;
  for (const key of continuationKeys) delete state[key];
  const previous = execution.previous.caseInvocation;
  if (
    previous?.kind !== "local" ||
    state.cases?.some((record) =>
      record.id === previous.caseId && isOpenCase(record)
    )
  ) {
    Object.assign(state, structuredClone(execution.previous));
  }
  delete state.scheduledExecution;
}

export function missingScheduledTypes(
  state: Pick<SystemRuntimeState, "cases">,
  model: ExecutableModel,
) {
  return (model.caseTypes ?? []).filter((type) =>
    type.type !== "request" && type.schedule &&
    type.ownerId === model.identity.builderId && !state.cases?.some((record) =>
      record.caseTypeId === type.id
    )
  );
}

/** Called only with an admitted native model, never with a source proposal. */
export function materializeScheduledCases(
  state: SystemRuntimeState,
  model: ExecutableModel,
  numbers: number[],
  clock: ClockPort,
): void {
  const types = missingScheduledTypes(state, model);
  if (types.length !== numbers.length) {
    throw new CaseError(
      "CASE_CONFLICT",
      "Scheduled declarations changed during allocation",
    );
  }
  for (const [index, type] of types.entries()) {
    const createdAt = clock.now();
    const nextAt = nextCaseOccurrence(type.schedule!, createdAt);
    const record = openCase({
      id: `${state.id}:case:${numbers[index]}`,
      number: numbers[index],
      type: type.type,
      caseTypeId: type.id,
      objective: type.name,
      owner: type.ownerId,
      openedBy: model.identity.systemId,
      openedFrom: { conversationId: state.id },
      modelPin: {
        digest: model.version.digest,
        ...(model.version.repositoryVersion
          ? { repositoryVersion: model.version.repositoryVersion }
          : {}),
      },
      createdAt,
      scheduling: {
        schedule: type.schedule!,
        behaviorId: type.behaviorId,
        ...(type.maxInvocations === undefined
          ? {}
          : { maxInvocations: type.maxInvocations }),
        nextAt,
      },
      ...(type.type === "job"
        ? {
          job: {
            schedule: formatCaseSchedule(type.schedule!),
            steps: [{
              id: type.behaviorId,
              label: type.name,
              state: "pending" as const,
            }],
            runs: [],
          },
        }
        : {
          watch: { state: "watching" as const, nextWakeAt: nextAt, wakes: [] },
        }),
    }, type);
    record.status = "waiting";
    (state.cases ??= []).push(record);
  }
}

export function scheduledCase(
  state: Pick<SystemRuntimeState, "cases">,
  id: string,
): Case {
  const record = state.cases?.find((item) => item.id === id);
  if (!record) {
    throw new CaseError(
      "NOT_FOUND",
      "Unknown Case",
      { caseId: id },
      "Reload the Cases collection.",
    );
  }
  if (!isOpenCase(record)) {
    throw new CaseError(
      "CASE_CLOSED",
      "Case already closed",
      { caseId: id },
      "Declare a new Case to start new work.",
    );
  }
  if (!record.scheduling) {
    throw new CaseError(
      "INVALID_CASE_ACTION",
      "This action requires a scheduled Case",
      { caseId: id },
      "Select a Job or Watch.",
    );
  }
  return record;
}

export function changeWatchState(
  state: SystemRuntimeState,
  id: string,
  action: "pause" | "resume" | "stop",
  clock: ClockPort,
): void {
  const record = scheduledCase(state, id);
  if (
    !record.watch || record.watch.state === "stopped" ||
    action === "pause" && record.watch.state !== "watching" ||
    action === "resume" && record.watch.state !== "paused"
  ) {
    throw new CaseError(
      "INVALID_CASE_ACTION",
      "Watch transition is not available",
      { caseId: id, action, state: record.watch?.state ?? record.type },
      "Pause a watching Watch, resume a paused Watch, or close a stopped Watch.",
    );
  }
  record.watch.state = action === "pause"
    ? "paused"
    : action === "resume"
    ? "watching"
    : "stopped";
  if (action === "resume") {
    record.scheduling!.nextAt = nextCaseOccurrence(
      record.scheduling!.schedule,
      clock.now(),
      record.createdAt,
    );
    record.watch.nextWakeAt = record.scheduling!.nextAt;
  } else {
    delete record.scheduling!.nextAt;
    delete record.watch.nextWakeAt;
  }
}

/** Reserve and advance before invoking: a crash can never replay a burst. */
export function beginScheduledExecution(
  state: SystemRuntimeState,
  id: string,
  clock: ClockPort,
  acceptedId?: string,
): void {
  const record = scheduledCase(state, id);
  if (state.scheduledExecution) {
    throw new CaseError(
      "CASE_BUSY",
      "A scheduled execution is already running",
      { caseId: id },
      "Wait for the current execution to finish.",
    );
  }
  if (record.watch && record.watch.state !== "watching") {
    throw new CaseError("INVALID_CASE_ACTION", "Watch is not watching", {
      caseId: id,
    }, "Resume the paused Watch first.");
  }
  const previous: CaseContinuation = {};
  for (const key of continuationKeys) {
    if (state[key] !== undefined) {
      Object.assign(previous, { [key]: structuredClone(state[key]) });
    }
  }
  const startedAt = clock.now(),
    executionId = acceptedId ?? crypto.randomUUID();
  record.status = "open";
  state.scheduledExecution = {
    caseId: id,
    id: executionId,
    startedAt,
    previous,
  };
  selectCaseInvocation(state, { kind: "local", caseId: id });
  // Each trigger starts a new invocation budget, including repeated Run now.
  for (const key of continuationKeys) {
    if (key !== "caseInvocation") delete state[key];
  }
  const policy = caseBudgetPolicy(
    state.executionModel!,
    record.caseTypeId,
    record.scheduling?.maxInvocations,
  );
  if (policy) {
    record.budget = {
      budgetId: policy.id,
      scopeId: `${id}:execution:${executionId}`,
    };
    state.workBudgetBinding = structuredClone(record.budget);
    state.caseBudgetPending = true;
  }
  record.scheduling!.nextAt = nextCaseOccurrence(
    record.scheduling!.schedule,
    startedAt,
    record.createdAt,
  );
  if (record.watch) record.watch.nextWakeAt = record.scheduling!.nextAt;
  if (record.job) {
    record.job.runs.push({ id: executionId, startedAt, outcome: "running" });
    record.job.steps.forEach((step) => step.state = "running");
  }
}

export function completeScheduledExecution(
  state: SystemRuntimeState,
  outcome: "done" | "failed" | "abandoned",
  summary?: string,
  watchResult?: { changed: boolean; summary: string },
): void {
  const execution = state.scheduledExecution;
  if (!execution) return;
  const record = state.cases!.find((record) => record.id === execution.caseId)!;
  if (isOpenCase(record)) record.status = "waiting";
  const run = record.job?.runs.find((run) => run.id === execution.id);
  if (run) run.outcome = outcome;
  record.job?.steps.forEach((step) =>
    step.state = outcome === "done" ? "done" : "failed"
  );
  if (record.watch) {
    record.watch.wakes.push({
      at: execution.startedAt,
      changed: outcome === "done" && watchResult?.changed === true,
      summary: outcome === "done"
        ? watchResult!.summary
        : `${outcome}: ${summary ?? "Execution interrupted"}`,
    });
  }
  restoreCaseContinuation(state);
}

interface ScheduledCaseRuntime {
  readonly cases: { cases: Case[] };
  runScheduledCase(id: string, trigger?: ScheduledCaseTrigger): Promise<void>;
}

/** One tick coalesces every missed interval into at most one execution per Case. */
export class CaseScheduler {
  private flight?: Promise<void>;
  constructor(
    private readonly ports: {
      clock: ClockPort;
      runtimes(): readonly ScheduledCaseRuntime[];
    },
  ) {}
  tick(): Promise<void> {
    if (this.flight) return this.flight;
    const task = this.dispatch().finally(() => {
      if (this.flight === task) this.flight = undefined;
    });
    this.flight = task;
    return task;
  }
  private async dispatch() {
    const now = Date.parse(this.ports.clock.now());
    for (const runtime of this.ports.runtimes()) {
      const due = runtime.cases.cases.filter((record) =>
        isOpenCase(record) &&
        record.scheduling?.nextAt &&
        Date.parse(record.scheduling.nextAt) <= now &&
        (!record.watch || record.watch.state === "watching")
      );
      for (const record of due) {
        try {
          await runtime.runScheduledCase(record.id, {
            kind: "due",
            scheduledAt: record.scheduling!.nextAt!,
          });
        } catch (error) {
          if (
            !(error instanceof CaseError) ||
            !["CASE_BUSY", "CASE_CLOSED", "INVALID_CASE_ACTION"].includes(
              error.code,
            )
          ) {
            throw error;
          }
        }
      }
    }
  }
}

/** Worker-only execution of the already admitted scheduled behavior. */
export interface ScheduledExecutionHost {
  readonly state: SystemRuntimeState;
  readonly ports: { clock: ClockPort };
  update(change: (state: SystemRuntimeState) => void): Promise<void>;
  currentModel(): Promise<ExecutableModel>;
  assertEvolutionWorkAdmission(): Promise<void>;
  runTurn(
    onReply: (
      reply: Extract<
        import("../../../domain/work/dialogue.ts").ChatDecision,
        { kind: "reply" }
      >,
    ) => void,
    contribution: NativeExecutionContribution,
  ): Promise<void>;
  flushWatchNotifications(): Promise<void>;
}

/** The durable receipt ID is also the invocation/input identity. A retried due
 * receipt cannot replay an already advanced occurrence or allocate another run. */
export async function executeScheduledCase(
  this: ScheduledExecutionHost,
  input: { id: string; caseId: string; trigger: ScheduledCaseTrigger },
): Promise<void> {
  const record = scheduledCase(this.state, input.caseId);
  if (
    record.job?.runs.some((run) =>
      run.id === input.id && run.outcome !== "running"
    ) ||
    this.state.events.some((event) => event.id === `${input.id}:completed`)
  ) {
    await this.flushWatchNotifications();
    return;
  }
  if (
    input.trigger.kind === "due" &&
    record.scheduling!.nextAt !== input.trigger.scheduledAt &&
    this.state.scheduledExecution?.id !== input.id
  ) return;
  await this.assertEvolutionWorkAdmission();
  await this.update((state) => {
    if (state.scheduledExecution?.id !== input.id) {
      beginScheduledExecution(state, input.caseId, this.ports.clock, input.id);
    }
    if (!state.events.some((event) => event.id === `${input.id}:started`)) {
      state.events.push({
        ...makeEvent("case-execution-started", record.objective),
        id: `${input.id}:started`,
        caseId: input.caseId,
      });
    }
    if (!state.messages.some((message) => message.id === input.id)) {
      state.messages.push({
        id: input.id,
        role: "tool",
        text: record.objective,
        at: this.ports.clock.now(),
        caseId: input.caseId,
      });
    }
    state.activeInputMessageId = input.id;
  });
  let reply:
    | Extract<
      import("../../../domain/work/dialogue.ts").ChatDecision,
      { kind: "reply" }
    >
    | undefined;
  let failure: string | undefined;
  try {
    const model = await this.currentModel();
    if (
      model.identity.builderId !== record.owner ||
      model.flows.conversation.rootNativeId !== record.scheduling!.behaviorId &&
        !model.caseFlows?.[record.scheduling!.behaviorId]
    ) {
      throw new CaseError(
        "CASE_EXECUTION_FAILED",
        "The declared behavior is not an executable behavior of the admitted owner",
        { caseId: input.caseId, behaviorId: record.scheduling!.behaviorId },
        "Declare an executable native behavior with the owner's admitted allocations before scheduling work.",
      );
    }
    await this.runTurn((value) => {
      reply = value;
    }, { id: input.id, kind: "input", inputMessageId: input.id });
    if (!reply || this.state.budgetSuspension) {
      throw new CaseError(
        "CASE_EXECUTION_FAILED",
        this.state.budgetSuspension?.diagnostic ??
          "The behavior produced no final reply",
        { caseId: input.caseId },
        "Review the execution history, budget and pending proposals before the next trigger.",
      );
    }
    if (
      record.watch &&
      (!reply.watchResult || typeof reply.watchResult.changed !== "boolean" ||
        typeof reply.watchResult.summary !== "string" ||
        !reply.watchResult.summary.trim() ||
        characterCount(reply.watchResult.summary) > 4000)
    ) {
      throw new CaseError(
        "CASE_EXECUTION_FAILED",
        "A Watch reply requires watchResult.changed and watchResult.summary",
        { caseId: input.caseId },
        "Return a structured Watch result after consulting the admitted source.",
      );
    }
  } catch (error) {
    failure = errorText(error);
  }
  await this.update((state) => {
    const execution = state.scheduledExecution!;
    if (
      !failure && record.watch && reply!.watchResult!.changed &&
      !state.watchNotifications?.some((notice) =>
        notice.id === `watch:${execution.id}`
      )
    ) {
      (state.watchNotifications ??= []).push({
        id: `watch:${execution.id}`,
        caseId: input.caseId,
        ownerId: record.owner,
        summary: reply!.watchResult!.summary,
        at: this.ports.clock.now(),
      });
    }
    completeScheduledExecution(
      state,
      failure ? "failed" : "done",
      failure,
      reply?.watchResult,
    );
    state.events.push({
      ...makeEvent(
        failure ? "case-execution-failed" : "case-execution-completed",
        failure ?? reply!.text,
      ),
      id: `${input.id}:completed`,
      caseId: input.caseId,
    });
  });
  await this.flushWatchNotifications();
}
