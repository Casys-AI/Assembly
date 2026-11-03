import type {
  WorkResultContract,
  WorkResultVerification,
} from "../policies/verified-effect-closure.ts";
import type {
  BehaviorInvocationRequest,
  BehaviorInvocationResult,
} from "../execution/modeled-behavior.ts";
import type { BehaviorModelVersion } from "../../shared-kernel/behavior-model-version.ts";

/** Transport and host resource ceiling, not permission to invoke a behavior. */
export const MAX_WORK_TASKS = 32;

export interface WorkTaskDraft {
  id: string;
  behaviorId: string;
  input: Record<string, unknown>;
  dependsOn: string[];
}

export interface AdmittedWorkTask {
  caseId?: string;
  id: string;
  dependsOn: string[];
  resourceId: string;
  inputDigest: string;
  invocation: BehaviorInvocationRequest;
  resultContract?: WorkResultContract;
  observationInvocation?: BehaviorInvocationRequest;
  observationInputDigest?: string;
}

export type WorkTaskState =
  | "pending"
  | "running"
  | "completed"
  | "waiting"
  | "failed"
  | "blocked"
  | "interrupted";

/** Technical attempts retain previous waiting/error receipts during reconciliation. */
interface WorkTaskAttempt {
  startedAt: string;
  returnedAt?: string;
  state: "running" | "completed" | "waiting" | "failed" | "interrupted";
  receipt?: BehaviorInvocationResult;
  error?: { code: string; message: string };
}

export interface WorkTaskRecord extends AdmittedWorkTask {
  state: WorkTaskState;
  resultVerification?: WorkResultVerification;
  startedAt?: string;
  completedAt?: string;
  receipt?: BehaviorInvocationResult;
  error?: { code: string; message: string };
  attempts?: WorkTaskAttempt[];
}

type WorkPlanStatus =
  | "admitted"
  | "running"
  | "completed"
  | "waiting"
  | "failed"
  | "interrupted";

/** The planning exposure that originally admitted this plan and its correlation. */
export interface WorkPlanOrigin {
  behaviorId: string;
  targetNativeId: string;
  invocationId: string;
}

export interface WorkPlanRecord {
  id: string;
  caseId?: string;
  callerId: string;
  modelVersion: BehaviorModelVersion;
  /** Missing on older records; it cannot be reconstructed as authority later. */
  origin?: WorkPlanOrigin;
  requestDigest: string;
  revision: number;
  status: WorkPlanStatus;
  tasks: WorkTaskRecord[];
  createdAt: string;
  updatedAt: string;
}

/** A legacy admission may acquire only its caller's explicitly migrated dossier. */
export function hasLegacyWorkPlanCase(
  plan: Pick<WorkPlanRecord, "caseId" | "callerId"> & {
    tasks: readonly AdmittedWorkTask[];
  },
): boolean {
  return plan.caseId !== undefined && plan.tasks.length > 0 &&
    plan.tasks.every((task) => {
      const context = task.invocation.caseContext;
      return !!context?.record && context.caseId === plan.caseId &&
        context.record.id === plan.caseId &&
        context.record.owner === plan.callerId &&
        context.record.migratedFrom === "legacy-dossier";
    });
}

/** Correlation is stored separately from the historical admission encoding. */
export function workPlanAdmissionTasks(
  tasks: readonly AdmittedWorkTask[],
): AdmittedWorkTask[] {
  const invocationIdentity = (request: BehaviorInvocationRequest) => {
    const { caseId: _caseId, caseContext: _caseContext, ...identity } = request;
    return request.designerContext
      ? {
        ...identity,
        designerContext: {
          scopeId: request.designerContext.scopeId,
          ownerId: request.designerContext.ownerId,
        },
      }
      : identity;
  };
  return tasks.map((task) => {
    const { caseId: _caseId, ...identity } = task;
    return {
      ...identity,
      invocation: invocationIdentity(task.invocation),
      ...(task.observationInvocation
        ? {
          observationInvocation: invocationIdentity(task.observationInvocation),
        }
        : {}),
    };
  });
}

function requirePlan(value: unknown, message: string): asserts value {
  if (!value) throw new Error("Invalid work plan: " + message);
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= 128;
}

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Representation and dependency checks run before any target is invoked. */
export function parseWorkTasks(value: unknown): WorkTaskDraft[] {
  requirePlan(Array.isArray(value), "tasks must be an array");
  requirePlan(
    value.length > 0 && value.length <= MAX_WORK_TASKS,
    `expected 1 to ${MAX_WORK_TASKS} tasks`,
  );
  const fields = new Set(["id", "behaviorId", "input", "dependsOn"]);
  const tasks = value.map((item, index): WorkTaskDraft => {
    requirePlan(record(item), `task ${index} must be an object`);
    requirePlan(
      Object.keys(item).length === fields.size &&
        Object.keys(item).every((field) => fields.has(field)),
      `task ${index} has missing or undeclared fields`,
    );
    requirePlan(identity(item.id), `task ${index} has an invalid id`);
    requirePlan(
      identity(item.behaviorId),
      `task ${item.id} has no behavior id`,
    );
    requirePlan(record(item.input), `task ${item.id} input must be an object`);
    requirePlan(
      Array.isArray(item.dependsOn) && item.dependsOn.every(identity),
      `task ${item.id} dependencies must be identities`,
    );
    return {
      id: item.id,
      behaviorId: item.behaviorId,
      input: structuredClone(item.input),
      dependsOn: [...item.dependsOn],
    };
  });
  validateWorkGraph(tasks);
  return tasks;
}

/** Validate the whole closed graph, including dependencies declared later. */
export function validateWorkGraph(
  tasks: readonly { id: string; dependsOn: readonly string[] }[],
): void {
  requirePlan(
    Array.isArray(tasks) && tasks.length > 0 && tasks.length <= MAX_WORK_TASKS,
    `expected 1 to ${MAX_WORK_TASKS} tasks`,
  );
  const byId = new Map<string, typeof tasks[number]>();
  for (const task of tasks) {
    requirePlan(identity(task.id), "invalid task identity");
    requirePlan(!byId.has(task.id), `duplicate task ${task.id}`);
    requirePlan(
      Array.isArray(task.dependsOn) && task.dependsOn.every(identity),
      `task ${task.id} dependencies must be identities`,
    );
    requirePlan(
      new Set(task.dependsOn).size === task.dependsOn.length,
      `task ${task.id} has duplicate dependencies`,
    );
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      requirePlan(dependency !== task.id, `task ${task.id} depends on itself`);
      requirePlan(byId.has(dependency), `unknown dependency ${dependency}`);
    }
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    requirePlan(!visiting.has(id), `dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

/** Ready order is declaration order; completion, not dispatch, satisfies a dependency. */
export function readyWorkTasks(
  tasks: readonly WorkTaskRecord[],
): WorkTaskRecord[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.filter((task) =>
    task.state === "pending" &&
    task.dependsOn.every((id) => workTaskSatisfied(byId.get(id)))
  );
}

/** Return immediate dependents; the executor can propagate blocked states to a fixed point. */
export function blockedWorkTasks(
  tasks: readonly WorkTaskRecord[],
): WorkTaskRecord[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.filter((task) =>
    task.state === "pending" && task.dependsOn.some((id) => {
      const state = byId.get(id)?.state;
      return !workTaskSatisfied(byId.get(id)) &&
        (state === "failed" || state === "blocked" ||
          state === "interrupted");
    })
  );
}

export function workTaskSatisfied(task: WorkTaskRecord | undefined): boolean {
  if (!task) return false;
  if (task.resultContract) {
    return ["completed", "interrupted"].includes(task.state) &&
      task.resultVerification?.status === "verified";
  }
  return task.state === "completed";
}
