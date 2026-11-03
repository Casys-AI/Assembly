import { errorMessage } from "../../../domain/primitives/error-message.ts";
import {
  compareWorkResult,
  validateResolvedWorkResultContract,
} from "../../../domain/work/policies/verified-effect-closure.ts";
/**
 * APE 2.5 Closed-Catalog Planning: dispatch an admitted plan through its catalog.
 * Construction tasks extend the book's read-plan scope; each effect retains its admission.
 * APE 3.4 Verified-Effect Closure additionally gates explicitly required results
 * through correlated readback, independently of technical task completion.
 */
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import type {
  BehaviorInvocationRequest,
  BehaviorInvocationResult,
} from "../../../domain/work/execution/modeled-behavior.ts";
import {
  blockedWorkTasks,
  hasLegacyWorkPlanCase,
  readyWorkTasks,
  validateWorkGraph,
  workPlanAdmissionTasks,
  type WorkPlanRecord,
  type WorkTaskRecord,
  workTaskSatisfied,
} from "../../../domain/work/entities/plans.ts";
import type { WorkPlanExecution } from "./commands/inputs.ts";
import type { WorkPlanExecutionPorts } from "./ports.ts";

const MAX_RECEIPT_BYTES = 262_144;
const MAX_RECONCILIATIONS = 8;

/** Tuple encoding prevents task identities containing separators from colliding. */
export function workTaskInvocationId(planId: string, taskId: string): string {
  return "work-task:" + JSON.stringify([planId, taskId]);
}

function requireExecution(value: unknown, message: string): asserts value {
  if (!value) throw new Error("Invalid work execution: " + message);
}
function messageOf(error: unknown): string {
  return errorMessage(error).slice(0, 450);
}

/** Schedule already admitted native calls; commercial or other domain choices
 * never belong here. Session resources are reserved before the first await. */
export class WorkPlanExecutor {
  readonly #active = new Map<
    string,
    { digest: string; caseId?: string; promise: Promise<WorkPlanRecord> }
  >();
  readonly #resources = new Map<
    string,
    { done: Promise<void>; release(): void }
  >();
  constructor(readonly ports: WorkPlanExecutionPorts) {}

  async read(id: string): Promise<WorkPlanRecord | null> {
    const record = await this.ports.store.load(id);
    return record ? structuredClone(record) : null;
  }

  async execute(
    request: WorkPlanExecution,
    options: { resume?: boolean } = {},
  ): Promise<WorkPlanRecord> {
    const input = structuredClone(request);
    validateWorkGraph(input.tasks);
    requireExecution(
      typeof input.id === "string" && input.id.trim() && input.id.length <= 240,
      "missing plan identity",
    );
    requireExecution(input.callerId?.trim(), "missing caller identity");
    requireExecution(
      input.caseId === undefined ||
        typeof input.caseId === "string" && input.caseId.trim().length > 0,
      "invalid case identity",
    );
    requireExecution(
      input.modelVersion?.digest && input.modelVersion.repositoryVersion,
      "missing admitted model identity",
    );
    if (input.origin) {
      requireExecution(
        typeof input.origin.behaviorId === "string" &&
          input.origin.behaviorId.trim() &&
          typeof input.origin.targetNativeId === "string" &&
          input.origin.targetNativeId.trim() &&
          input.origin.invocationId === input.id,
        "planning origin has inconsistent provenance",
      );
    }
    const concurrency = input.maxConcurrency ?? 2;
    requireExecution(
      Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 8,
      "concurrency must be an integer between 1 and 8",
    );
    for (const task of input.tasks) {
      const invocation = task.invocation;
      requireExecution(
        task.caseId === input.caseId && invocation.caseId === input.caseId &&
          (!invocation.caseContext ||
            invocation.caseContext.caseId === input.caseId),
        `task ${task.id} has inconsistent case correlation`,
      );
      if (task.resultContract) {
        validateResolvedWorkResultContract(
          task.resultContract,
          invocation.input,
        );
        if (task.resultContract.input) {
          requireExecution(
            task.resultContract.input.typeId ===
                invocation.behavior.inputTypeId &&
              canonical(task.resultContract.input.schema) ===
                canonical(invocation.behavior.inputSchema),
            `task ${task.id} binding does not use the exact admitted work input type`,
          );
        }

        const read = task.observationInvocation;
        requireExecution(
          this.ports.observeTarget && read && task.observationInputDigest &&
            task.resultContract.callerNativeId === input.callerId &&
            task.resultContract.workBehaviorId === invocation.behavior.id &&
            read.behavior.id === task.resultContract.observationBehaviorId &&
            read.callerId === input.callerId &&
            read.behavior.callerNativeId === input.callerId &&
            read.invocationId === invocation.invocationId + ":observe" &&
            read.caseId === input.caseId &&
            canonical(read.caseContext) === canonical(invocation.caseContext) &&
            canonical(read.designerContext) ===
              canonical(invocation.designerContext) &&
            canonical(read.modelVersion) === canonical(input.modelVersion) &&
            canonical(read.input) ===
              canonical({
                ...(task.resultContract.query?.values ?? {}),
                workInvocationId: invocation.invocationId,
                workBehaviorId: invocation.behavior.id,
                workInputDigest: task.inputDigest,
              }) &&
            await executionDigest(read.input) === task.observationInputDigest,
          `task ${task.id} has no admitted result observation`,
        );
      }

      requireExecution(
        task.resourceId?.trim() && task.inputDigest?.trim() &&
          invocation?.callerId === input.callerId &&
          invocation.behavior.callerNativeId === input.callerId &&
          invocation.invocationId === workTaskInvocationId(input.id, task.id) &&
          canonical(invocation.modelVersion) === canonical(input.modelVersion),
        `task ${task.id} has inconsistent admitted provenance`,
      );
      requireExecution(
        await executionDigest(invocation.input) === task.inputDigest,
        `task ${task.id} changed after its input admission`,
      );
    }
    const digest = await executionDigest({
      callerId: input.callerId,
      modelVersion: input.modelVersion,
      ...(input.origin ? { origin: input.origin } : {}),
      tasks: workPlanAdmissionTasks(input.tasks),
    });
    const active = this.#active.get(input.id);
    if (active) {
      requireExecution(
        active.digest === digest && active.caseId === input.caseId,
        "plan identity already in use",
      );
      return structuredClone(await active.promise);
    }
    const running = this.#run(
      input,
      digest,
      concurrency,
      options.resume === true,
    )
      .finally(() => this.#active.delete(input.id));
    this.#active.set(input.id, {
      digest,
      caseId: input.caseId,
      promise: running,
    });
    return structuredClone(await running);
  }

  async #run(
    input: WorkPlanExecution,
    digest: string,
    concurrency: number,
    resume: boolean,
  ): Promise<WorkPlanRecord> {
    const clock = this.ports.now ?? (() => new Date().toISOString());
    let record = await this.ports.store.load(input.id);
    if (record) {
      requireExecution(
        record.requestDigest === digest && record.callerId === input.callerId &&
          (record.caseId === undefined || record.caseId === input.caseId),
        "persisted plan identity has different content",
      );
      requireExecution(
        record.caseId !== undefined || input.caseId === undefined ||
          hasLegacyWorkPlanCase(input),
        "a legacy plan can only bind to its caller's migrated dossier Case",
      );
      record = structuredClone(record);
    } else {
      const at = clock();
      record = {
        id: input.id,
        ...(input.caseId ? { caseId: input.caseId } : {}),
        callerId: input.callerId,
        modelVersion: structuredClone(input.modelVersion),
        ...(input.origin ? { origin: structuredClone(input.origin) } : {}),
        requestDigest: digest,
        revision: 0,
        status: "admitted",
        tasks: input.tasks.map((task) => ({
          ...structuredClone(task),
          state: "pending",
          ...(task.resultContract
            ? {
              resultVerification: {
                status: "pending",
                attempts: 0,
                observations: [],
              },
            }
            : {}),
        })),
        createdAt: at,
        updatedAt: at,
      };
      await this.ports.store.save(structuredClone(record), null);
    }
    let fatal: unknown;
    let writes = Promise.resolve();
    const update = (change: (next: WorkPlanRecord) => void): Promise<void> => {
      const pending = writes.then(async () => {
        if (fatal) throw fatal;
        const next = structuredClone(record!);
        change(next);
        next.revision = record!.revision + 1;
        next.updatedAt = clock();
        await this.ports.store.save(next, record!.revision);
        record = next;
      }).catch((error) => {
        fatal = error;
        throw error;
      });
      // Observe failure without permitting another transition to outrun it.
      writes = pending.catch(() => {});
      return pending;
    };
    if (record.caseId === undefined && input.caseId) {
      // Bind a legacy plan once, without changing its admitted request digest.
      await update((next) => {
        next.caseId = input.caseId;
        for (const task of next.tasks) {
          const admitted = input.tasks.find((entry) => entry.id === task.id)!;
          task.caseId = input.caseId;
          task.invocation = structuredClone(admitted.invocation);
          if (admitted.observationInvocation) {
            task.observationInvocation = structuredClone(
              admitted.observationInvocation,
            );
          }
        }
      });
    }
    if (record.tasks.some((task) => task.state === "running")) {
      await update((next) => {
        next.status = "interrupted";
        for (
          const task of next.tasks.filter((task) => task.state === "running")
        ) {
          task.state = "interrupted";
          task.error = {
            code: "OUTCOME_UNCONFIRMED",
            message:
              "The previous process stopped before recording a target receipt.",
          };
          const attempt = task.attempts?.at(-1);
          if (attempt?.state === "running") {
            attempt.state = "interrupted";
            attempt.error = structuredClone(task.error);
            attempt.returnedAt = clock();
          }
        }
      });
    }
    if (
      record.status === "completed" || record.status === "failed" &&
        !record.tasks.some((task) =>
          ["waiting", "interrupted", "pending"].includes(task.state)
        )
    ) return record;
    if (["waiting", "interrupted"].includes(record.status) && !resume) {
      return record;
    }
    if (resume) {
      await update((next) => {
        for (const task of next.tasks) {
          if (
            ["waiting", "interrupted", "blocked"].includes(task.state) &&
            !(task.resultContract && task.state === "interrupted")
          ) {
            requireExecution(
              (task.attempts?.length ?? 0) < MAX_RECONCILIATIONS,
              `task ${task.id} exceeded its reconciliation bound`,
            );
            task.state = "pending";
            delete task.error;
            delete task.completedAt;
          }
        }
      });
    }
    await update((next) => next.status = "running");
    const active = new Map<string, Promise<void>>();
    const finishTask = async (
      id: string,
      state: "completed" | "waiting" | "failed" | "interrupted",
      receipt?: BehaviorInvocationResult,
      error?: WorkTaskRecord["error"],
    ) => {
      await update((next) => {
        const task = next.tasks.find((task) => task.id === id)!;
        task.state = state;
        if (receipt) task.receipt = structuredClone(receipt);
        if (error) task.error = structuredClone(error);
        else delete task.error;
        const at = clock();
        if (state === "completed" || state === "failed") task.completedAt = at;
        const attempt = task.attempts!.at(-1)!;
        attempt.state = state;
        attempt.returnedAt = at;
        if (receipt) attempt.receipt = structuredClone(receipt);
        if (error) attempt.error = structuredClone(error);
      });
    };
    const observeTask = async (id: string) => {
      const before = record!.tasks.find((task) => task.id === id)!;
      if (
        !before.resultContract ||
        before.resultVerification?.status === "verified"
      ) return;
      if (
        (before.resultVerification?.attempts ?? 0) >=
          before.resultContract.maxObservations
      ) {
        await update((next) => {
          next.tasks.find((t) => t.id === id)!.resultVerification!.status =
            "exhausted";
        });
        return;
      }
      await update((next) => {
        const task = next.tasks.find((t) => t.id === id)!;
        const verification = task.resultVerification ??= {
          status: "pending",
          attempts: 0,
          observations: [],
        };
        verification.attempts++;
        verification.status = "pending";
      });
      const task = record!.tasks.find((t) => t.id === id)!;
      let receipt: BehaviorInvocationResult | undefined;
      let status: "verified" | "unknown" | "contradicted" | "exhausted" =
        "unknown";
      let error: string | undefined;
      try {
        receipt = await this.ports.observeTarget!(
          structuredClone(task.observationInvocation!),
        );
        this.#checkReceipt(task.observationInvocation!, receipt);
        const outcome = compareWorkResult(
          task.resultContract!,
          receipt.result,
          {
            callerId: input.callerId,
            workInvocationId: task.invocation.invocationId,
            workBehaviorId: task.invocation.behavior.id,
            workInputDigest: task.inputDigest,
            modelVersion: input.modelVersion,
          },
        );
        status = outcome === "verified"
          ? "verified"
          : outcome === "contradicted"
          ? "contradicted"
          : "unknown";
      } catch (failure) {
        error = messageOf(failure);
      }
      await update((next) => {
        const current = next.tasks.find((t) => t.id === id)!;
        const verification = current.resultVerification!;
        verification.status = status === "verified"
          ? status
          : verification.attempts >= current.resultContract!.maxObservations
          ? "exhausted"
          : status;
        verification.observations.push({
          at: clock(),
          status,
          ...(receipt ? { receipt: structuredClone(receipt) } : {}),
          ...(error ? { error } : {}),
        });
      });
    };
    // Explicit continuation observes completed or uncertain effects without reissuing them.
    if (resume) {
      for (const task of record.tasks) {
        if (
          task.resultContract &&
          ["completed", "interrupted"].includes(task.state)
        ) await observeTask(task.id);
      }
    }
    const runTask = async (id: string) => {
      await update((next) => {
        const task = next.tasks.find((task) => task.id === id)!;
        const at = clock();
        task.state = "running";
        task.startedAt = at;
        (task.attempts ??= []).push({ startedAt: at, state: "running" });
      });
      const task = record!.tasks.find((task) => task.id === id)!;
      let receipt: BehaviorInvocationResult;
      try {
        receipt = await this.ports.invokeTarget(
          structuredClone(task.invocation),
        );
      } catch (error) {
        await finishTask(id, "interrupted", undefined, {
          code: "TARGET_OUTCOME_UNCONFIRMED",
          message: messageOf(error),
        });
        return;
      }
      try {
        this.#checkReceipt(task.invocation, receipt);
        const completion = this.ports.completion?.(receipt) ?? "completed";
        requireExecution(
          ["completed", "waiting", "failed"].includes(completion),
          "unknown target completion envelope",
        );
        await finishTask(
          id,
          completion,
          receipt,
          completion === "failed"
            ? {
              code: "TARGET_REPORTED_FAILURE",
              message:
                "The target reported failure; inspect its recorded receipt.",
            }
            : undefined,
        );
        if (completion === "completed" && task.resultContract) {
          await observeTask(id);
        }
      } catch (error) {
        if (fatal) throw fatal;
        await finishTask(id, "interrupted", undefined, {
          code: "TARGET_RECEIPT_UNCONFIRMED",
          message: messageOf(error),
        });
      }
    };
    const propagateBlocked = async () => {
      while (blockedWorkTasks(record!.tasks).length) {
        await update((next) => {
          for (const task of blockedWorkTasks(next.tasks)) {
            task.state = "blocked";
            task.error = {
              code: "DEPENDENCY_UNAVAILABLE",
              message: "A prerequisite failed or has no confirmed outcome.",
            };
          }
        });
      }
    };
    try {
      for (;;) {
        await propagateBlocked();
        for (const task of readyWorkTasks(record.tasks)) {
          if (active.size >= concurrency) break;
          if (active.has(task.id) || this.#resources.has(task.resourceId)) {
            continue;
          }
          let release!: () => void;
          const done = new Promise<void>((resolve) => release = resolve);
          this.#resources.set(task.resourceId, { done, release });
          const pending = runTask(task.id).finally(() => {
            active.delete(task.id);
            this.#resources.delete(task.resourceId);
            release();
          });
          // A failed CAS is observed by the scheduling barrier below.
          pending.catch(() => {});
          active.set(task.id, pending);
        }
        if (!active.size) {
          const occupied = readyWorkTasks(record.tasks).map((task) =>
            this.#resources.get(task.resourceId)?.done
          ).filter((value): value is Promise<void> => Boolean(value));
          if (occupied.length) {
            await Promise.race(occupied);
            continue;
          }
          break;
        }
        await Promise.race(active.values());
      }
    } catch (error) {
      await Promise.allSettled(active.values());
      throw error;
    }
    if (fatal) throw fatal;
    await update((next) => {
      next.status = next.tasks.every(workTaskSatisfied)
        ? "completed"
        : next.tasks.some((task) => task.state === "interrupted")
        ? "interrupted"
        : next.tasks.some((task) => task.state === "waiting")
        ? "waiting"
        : next.tasks.some((task) =>
            task.state === "failed" || task.state === "blocked"
          )
        ? "failed"
        : "waiting";
    });
    return record;
  }

  #checkReceipt(
    request: BehaviorInvocationRequest,
    receipt: BehaviorInvocationResult,
  ) {
    requireExecution(
      receipt && receipt.behaviorId === request.behavior.id &&
        (receipt.caseId === undefined || receipt.caseId === request.caseId) &&
        receipt.invocationId === request.invocationId &&
        receipt.targetNativeId === request.behavior.targetNativeId &&
        canonical(receipt.modelVersion) === canonical(request.modelVersion),
      "target receipt does not match the admitted invocation",
    );
    if (request.caseId) receipt.caseId = request.caseId;
    const serialized = JSON.stringify(receipt);
    requireExecution(
      new TextEncoder().encode(serialized).length <= MAX_RECEIPT_BYTES,
      "target receipt exceeds the recording bound; no completion is asserted",
    );
  }
}
