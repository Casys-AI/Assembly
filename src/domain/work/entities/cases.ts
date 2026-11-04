import { validTaskSourceInputs } from "../records/task-source-input.ts";
import { CaseError } from "../errors/case.ts";
import {
  type CaseSchedule,
  formatCaseSchedule,
  validateCaseSchedule,
} from "../value-objects/case-schedule.ts";
import { validDesignerContext } from "../execution/case-context.ts";
/** Work identity is independent of the conversation and conveys no authority. */
export type CaseKind = "request" | "job" | "watch";
export type CaseStatus =
  | "open"
  | "waiting"
  | "closed-done"
  | "closed-abandoned";
export const CASE_VERDICTS = ["accepted", "rejected"] as const;
export type CaseVerdict = typeof CASE_VERDICTS[number];
/** Authenticated person and their judgment; this is not verified success. */
export interface CaseClosureEvidence {
  closedBy: string;
  verdict?: CaseVerdict;
}

export interface JobDetails {
  schedule?: string;
  steps: {
    id: string;
    label: string;
    state: "pending" | "running" | "done" | "failed";
  }[];
  runs: {
    id: string;
    startedAt: string;
    outcome: "done" | "failed" | "running" | "abandoned";
  }[];
}
export interface WatchDetails {
  state: "watching" | "paused" | "stopped";
  nextWakeAt?: string;
  wakes: { at: string; changed: boolean; summary?: string }[];
}
export interface Case {
  /** Exact host-captured URL inputs for this root Request, never execution rights. */
  taskSourceInputs?:
    import("../records/task-source-input.ts").TaskSourceInput[];
  id: string;
  number: number;
  type: CaseKind;
  caseTypeId?: string;
  /** Explicit provenance authorizes a one-time binding of a historical plan. */
  migratedFrom?: "legacy-dossier";
  objective: string;
  owner: string;
  openedBy: string;
  openedFrom: {
    conversationId: string;
    messageId?: string;
    origin?: "initialization";
    changeId?: string;
    /** Independent opening correlation, scoped by its actual opener and origin. */
    openingId?: string;
    caseId?: string;
    designerScopeId?: string;
  };
  /** Immutable birth pin; explicit model adoption remains separately journaled. */
  modelPin: { digest: string; repositoryVersion?: string };
  status: CaseStatus;
  /** Reference into the existing append-only reservation ledger. */
  budget?: { budgetId: string; scopeId: string };
  createdAt: string;
  closedAt?: string;
  closedBy?: string;
  verdict?: CaseVerdict;
  /** Durable first-request delivery; a retry never allocates another Case. */
  firstRequestDispatched?: boolean;
  /** An interrupted opening may resume only its exact durable checkpoint. */
  firstRequestDispatch?: {
    modelDigest: string;
    providerPending: boolean;
    progressed: boolean;
  };
  job?: JobDetails;
  watch?: WatchDetails;
  /** Admitted declaration frozen at creation, separate from runtime authority. */
  scheduling?: {
    schedule: CaseSchedule;
    behaviorId: string;
    maxInvocations?: number;
    nextAt?: string;
  };
}

/**
 * A Case objective is a short label for its request, counted in
 * `String.length`. The complete request text stays in its journal
 * message; a longer objective is truncated with the context marker.
 */
export const MAX_CASE_OBJECTIVE_CHARS = 2_000;

export interface CasesSnapshot {
  systemId: string;
  /** Read-only execution observation; the Case lifecycle remains separate. */
  cases: Array<Case & { initialExecutionOutcome?: "refused" }>;
}

export function isOpenCase(caseRecord: Case): boolean {
  return caseRecord.status === "open" || caseRecord.status === "waiting";
}

export function openCase(
  input: Omit<Case, "status" | "closedAt">,
  admittedType?: import("../records/case-types.ts").NativeCaseType,
): Case {
  const schedule = input.scheduling?.schedule,
    admitted = admittedType?.schedule;
  const sameSchedule = schedule?.kind === "every" && admitted?.kind === "every"
    ? schedule.count === admitted.count && schedule.unit === admitted.unit
    : schedule?.kind === "daily-at" && admitted?.kind === "daily-at" &&
      schedule.hour === admitted.hour && schedule.minute === admitted.minute;
  if (
    input.type !== "request" && (!admittedType ||
      admittedType.id !== input.caseTypeId ||
      admittedType.type !== input.type ||
      admittedType.ownerId !== input.owner || !admittedType.schedule ||
      !input.scheduling ||
      !sameSchedule ||
      admittedType.behaviorId !== input.scheduling?.behaviorId)
  ) {
    throw new CaseError(
      "INVALID_CASE",
      "A scheduled Case requires its admitted native declaration",
      { caseTypeId: input.caseTypeId ?? "", type: input.type },
      "Propose a scheduled CaseType and have its model revision admitted.",
    );
  }
  const caseRecord: Case = { ...structuredClone(input), status: "open" };
  assertCase(caseRecord);
  return caseRecord;
}

export function closeCase(
  caseRecord: Case,
  outcome: "done" | "abandoned",
  at: string,
  evidence?: CaseClosureEvidence,
): Case {
  if (!isOpenCase(caseRecord)) {
    throw new CaseError(
      "CASE_CLOSED",
      `Case #${caseRecord.number} is already closed`,
    );
  }
  if (!["done", "abandoned"].includes(outcome)) {
    throw new CaseError("INVALID_CASE", "Invalid closure outcome");
  }
  const closed: Case = {
    ...structuredClone(caseRecord),
    status: outcome === "done" ? "closed-done" : "closed-abandoned",
    closedAt: at,
    ...(evidence ? structuredClone(evidence) : {}),
  };
  if (closed.scheduling) delete closed.scheduling.nextAt;
  if (closed.watch) {
    closed.watch.state = "stopped";
    delete closed.watch.nextWakeAt;
  }
  assertCase(closed);
  return closed;
}

function assertCase(value: unknown): asserts value is Case {
  const j = value as Case;
  const identity = (v: unknown): v is string =>
    typeof v === "string" && v.trim().length > 0;
  const timestamp = (v: unknown) =>
    identity(v) && Number.isFinite(Date.parse(v));
  if (
    !j || typeof j !== "object" || !identity(j.id) ||
    !Number.isSafeInteger(j.number) || j.number < 1 ||
    !["request", "job", "watch"].includes(j.type) ||
    (j.caseTypeId !== undefined && !identity(j.caseTypeId)) ||
    (j.migratedFrom !== undefined && j.migratedFrom !== "legacy-dossier") ||
    (j.taskSourceInputs !== undefined &&
      (j.type !== "request" ||
        !validTaskSourceInputs(j.taskSourceInputs, j.id))) ||
    !identity(j.objective) || !identity(j.owner) || !identity(j.openedBy) ||
    !identity(j.openedFrom?.conversationId) ||
    (j.openedFrom.messageId !== undefined &&
      !identity(j.openedFrom.messageId)) ||
    (j.openedFrom.openingId !== undefined &&
      (typeof j.openedFrom.openingId !== "string" ||
        !/^[^\s]{1,128}$/.test(j.openedFrom.openingId))) ||
    !identity(j.modelPin?.digest) ||
    (j.modelPin.repositoryVersion !== undefined &&
      !identity(j.modelPin.repositoryVersion)) ||
    !["open", "waiting", "closed-done", "closed-abandoned"].includes(
      j.status,
    ) ||
    (j.firstRequestDispatch !== undefined &&
      (!identity(j.firstRequestDispatch.modelDigest) ||
        typeof j.firstRequestDispatch.providerPending !== "boolean" ||
        typeof j.firstRequestDispatch.progressed !== "boolean")) ||
    (j.closedBy !== undefined && (!identity(j.closedBy) || isOpenCase(j))) ||
    (j.verdict !== undefined &&
      (j.status !== "closed-done" || !j.closedBy ||
        !CASE_VERDICTS.includes(j.verdict))) ||
    !timestamp(j.createdAt) ||
    (isOpenCase(j) ? j.closedAt !== undefined : !timestamp(j.closedAt)) ||
    (j.closedAt !== undefined &&
      Date.parse(j.closedAt) < Date.parse(j.createdAt)) ||
    (j.budget !== undefined &&
      (!identity(j.budget.budgetId) || !identity(j.budget.scopeId)))
  ) {
    throw new CaseError("INVALID_CASE", "Invalid Case record");
  }
  if (j.type !== "request") {
    const schedule = j.scheduling;
    if (schedule) validateCaseSchedule(schedule.schedule);
    if (
      !identity(j.caseTypeId) || !schedule ||
      !identity(schedule.behaviorId) ||
      (schedule.nextAt !== undefined && !timestamp(schedule.nextAt)) ||
      (schedule.maxInvocations !== undefined &&
        (!Number.isSafeInteger(schedule.maxInvocations) ||
          schedule.maxInvocations < 0)) ||
      (j.type === "job" && (!j.job || j.watch !== undefined ||
        j.job.schedule !== formatCaseSchedule(schedule.schedule) ||
        !Array.isArray(j.job.steps) ||
        !j.job.steps.every((step) =>
          identity(step.id) && identity(step.label) &&
          ["pending", "running", "done", "failed"].includes(step.state)
        ) ||
        !Array.isArray(j.job.runs) || !j.job.runs.every((run) =>
          identity(run.id) &&
          timestamp(run.startedAt) &&
          ["done", "failed", "running", "abandoned"].includes(run.outcome)
        ))) ||
      (j.type === "watch" && (!j.watch || j.job !== undefined ||
        !["watching", "paused", "stopped"].includes(j.watch.state) ||
        (j.watch.nextWakeAt !== undefined && !timestamp(j.watch.nextWakeAt)) ||
        !Array.isArray(j.watch.wakes) || !j.watch.wakes.every((wake) =>
          timestamp(wake.at) &&
          typeof wake.changed === "boolean" &&
          (wake.summary === undefined || typeof wake.summary === "string")
        )))
    ) {
      throw new CaseError("INVALID_CASE", "Invalid scheduled Case record");
    }
  }
}

/** Historical state has no Cases; invocation selection is a single discriminated value. */
export function assertCasesState(
  state: {
    cases?: Case[];
    caseInvocation?: import("../execution/case-context.ts").CaseInvocation;
    designer?: {
      scopeId: string;
      budget?: { budgetId: string; scopeId: string };
    };
  },
): void {
  if (
    state.cases === undefined && state.caseInvocation === undefined &&
    state.designer === undefined
  ) return;
  if (!Array.isArray(state.cases)) {
    throw new CaseError("INVALID_CASE", "Invalid cases collection");
  }
  state.cases.forEach(assertCase);
  const identity = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0;
  const invocation = state.caseInvocation;
  if (
    (invocation !== undefined &&
      !["local", "delegated", "designer", "delegated-designer"].includes(
        invocation.kind,
      )) ||
    (state.designer !== undefined && (!identity(state.designer?.scopeId) ||
      state.cases.some((record) =>
        record.id === state.designer!.scopeId ||
        record.budget?.scopeId === state.designer!.scopeId
      ) ||
      state.designer.budget !== undefined &&
        (!identity(state.designer.budget.budgetId) ||
          state.designer.budget.scopeId !== state.designer.scopeId))) ||
    (invocation?.kind === "designer" &&
      (!identity(invocation.scopeId) ||
        invocation.scopeId !== state.designer?.scopeId)) ||
    (invocation?.kind === "delegated-designer" &&
      (!validDesignerContext(invocation.work?.designerContext) ||
        invocation.work.caseId !== undefined ||
        invocation.work.caseContext !== undefined)) ||
    new Set(state.cases.map((j) => j.id)).size !== state.cases.length ||
    new Set(state.cases.map((j) => j.number)).size !== state.cases.length ||
    (invocation?.kind === "local" &&
      !state.cases.some((j) => j.id === invocation.caseId && isOpenCase(j))) ||
    (invocation?.kind === "delegated" &&
      (!invocation.work?.caseContext?.caseId ||
        invocation.work.designerContext !== undefined ||
        invocation.work.caseId !== invocation.work.caseContext.caseId ||
        (invocation.work.caseContext.record !== undefined &&
          invocation.work.caseContext.record.id !==
            invocation.work.caseContext.caseId)))
  ) {
    throw new CaseError(
      "INVALID_CASE",
      "Invalid Case invocation or duplicate identity",
    );
  }
}

/** Explicit Request commands require a verdict for done. */
export function requireCaseClosureVerdict(
  outcome: "done" | "abandoned",
  verdict: CaseVerdict | undefined,
): void {
  if (outcome === "done" && verdict === undefined) {
    throw new CaseError(
      "CASE_VERDICT_REQUIRED",
      "Closing as done requires an explicit accepted or rejected verdict",
      { outcome },
      "Choose accepted or rejected when closing the Request.",
    );
  }
  if (
    verdict !== undefined &&
    outcome !== "done"
  ) {
    throw new CaseError("INVALID_CASE", "Invalid closure verdict");
  }
}
