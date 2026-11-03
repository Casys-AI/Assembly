import { isPlainRecord as object } from "../../../domain/primitives/is-plain-record.ts";
import { postgresExecutionTransaction } from "./execution-transaction.ts";
import {
  compareWorkResult,
  validateResolvedWorkResultContract,
} from "../../../domain/work/policies/verified-effect-closure.ts";
import type { WorkPlanStorePort } from "../../../application/work/plans/ports.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  hasLegacyWorkPlanCase,
  MAX_WORK_TASKS,
  validateWorkGraph,
  workPlanAdmissionTasks,
  type WorkPlanRecord,
} from "../../../domain/work/entities/plans.ts";

const maxPayloadBytes = 16 * 1024 * 1024;
const planStates = new Set([
  "admitted",
  "running",
  "completed",
  "waiting",
  "failed",
  "interrupted",
]);
const taskStates = new Set([
  "pending",
  "running",
  "completed",
  "waiting",
  "failed",
  "blocked",
  "interrupted",
]);

function identity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= 512;
}

function version(value: unknown): boolean {
  return object(value) && identity(value.digest) &&
    identity(value.repositoryVersion);
}

/** Storage representation only; task admission and continuation stay in the application. */
function assertRecord(
  value: unknown,
  allowLegacyRead = false,
): asserts value is WorkPlanRecord {
  if (
    !object(value) || !identity(value.id) || !identity(value.callerId) ||
    value.caseId !== undefined && !identity(value.caseId) ||
    !identity(value.requestDigest) || !version(value.modelVersion) ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
    typeof value.status !== "string" || !planStates.has(value.status) ||
    !identity(value.createdAt) || !identity(value.updatedAt) ||
    !Array.isArray(value.tasks) || value.tasks.length < 1 ||
    value.tasks.length > MAX_WORK_TASKS
  ) throw new Error("Invalid stored work plan");
  if (value.origin !== undefined) {
    if (
      !object(value.origin) ||
      Object.keys(value.origin).length !== 3 ||
      !identity(value.origin.behaviorId) ||
      !identity(value.origin.targetNativeId) ||
      value.origin.invocationId !== value.id
    ) throw new Error("Invalid stored work-plan origin");
  }
  for (const task of value.tasks) {
    if (
      !object(task) || !identity(task.id) || !identity(task.resourceId) ||
      !identity(task.inputDigest) || typeof task.state !== "string" ||
      !taskStates.has(task.state) || !Array.isArray(task.dependsOn) ||
      !task.dependsOn.every(identity) || !object(task.invocation) ||
      !identity(task.invocation.invocationId) ||
      !identity(task.invocation.callerId) ||
      !version(task.invocation.modelVersion) ||
      !object(task.invocation.behavior) ||
      !identity(task.invocation.behavior.id) || !object(task.invocation.input)
    ) throw new Error("Invalid stored work task");
    if (
      task.caseId !== value.caseId || task.invocation.caseId !== value.caseId ||
      task.invocation.caseContext !== undefined &&
        (!object(task.invocation.caseContext) ||
          task.invocation.caseContext.caseId !== value.caseId) ||
      object(task.observationInvocation) &&
        (task.observationInvocation.caseId !== value.caseId ||
          canonical(task.observationInvocation.caseContext) !==
            canonical(task.invocation.caseContext))
    ) throw new Error("Invalid stored work-task case correlation");
    if (task.resultContract !== undefined) {
      // Historical payloads remain inspectable. They cannot be saved or executed
      // under a different completion interpretation without explicit readmission.
      if (
        allowLegacyRead && object(task.resultContract) &&
        task.resultContract.schemaVersion !== "verified-effect-closure/v2"
      ) continue;
      validateResolvedWorkResultContract(
        task
          .resultContract as unknown as import("../../../domain/work/policies/verified-effect-closure.ts").WorkResultContract,
        task.invocation.input,
      );
      const v = task.resultVerification;
      if (
        !object(task.observationInvocation) ||
        !identity(task.observationInputDigest) || !object(v) ||
        !["pending", "verified", "unknown", "contradicted", "exhausted"]
          .includes(String(v.status)) ||
        !Number.isSafeInteger(v.attempts) || (v.attempts as number) < 0 ||
        (v.attempts as number) >
          (task.resultContract as { maxObservations: number })
            .maxObservations ||
        !Array.isArray(v.observations) ||
        v.observations.length > (v.attempts as number) ||
        v.status === "verified" &&
          (!v.observations.length ||
            v.observations.at(-1)?.status !== "verified")
      ) {
        throw new Error("Invalid stored result verification");
      }
      if (v.status === "verified") {
        const typed = task as unknown as WorkPlanRecord["tasks"][number];
        const receipt = typed.resultVerification!.observations.at(-1)
          ?.receipt as
            | import("../../../domain/work/execution/modeled-behavior.ts").BehaviorInvocationResult
            | undefined;
        if (
          !receipt ||
          receipt.invocationId !== typed.observationInvocation!.invocationId ||
          receipt.behaviorId !== typed.observationInvocation!.behavior.id ||
          receipt.targetNativeId !==
            typed.observationInvocation!.behavior.targetNativeId ||
          canonical(receipt.modelVersion) !==
            canonical(typed.observationInvocation!.modelVersion) ||
          compareWorkResult(typed.resultContract!, receipt.result, {
              callerId: value.callerId,
              workInvocationId: typed.invocation.invocationId,
              workBehaviorId: typed.invocation.behavior.id,
              workInputDigest: typed.inputDigest,
              modelVersion: typed.invocation.modelVersion,
            }) !== "verified"
        ) {
          throw new Error(
            "Stored verification has no correlated source evidence",
          );
        }
      }
    } else if (
      task.observationInvocation !== undefined ||
      task.resultVerification !== undefined
    ) {
      throw new Error("Result verification has no admitted contract");
    }
  }
  validateWorkGraph(value.tasks as WorkPlanRecord["tasks"]);
}

import type { Prisma, PrismaClient } from "./client.ts";
import { postgresBigInt, postgresSafeInteger } from "./numbers.ts";
import {
  assertPostgresRuntimeScope,
  type PostgresRuntimeScope,
} from "./scope.ts";

function admittedIdentity(record: WorkPlanRecord): string {
  return canonical({
    callerId: record.callerId,
    modelVersion: record.modelVersion,
    ...(record.origin ? { origin: record.origin } : {}),
    requestDigest: record.requestDigest,
    createdAt: record.createdAt,
    tasks: workPlanAdmissionTasks(record.tasks.map((
      {
        id,
        dependsOn,
        resourceId,
        inputDigest,
        invocation,
        resultContract,
        observationInvocation,
        observationInputDigest,
      },
    ) => ({
      id,
      dependsOn,
      resourceId,
      inputDigest,
      invocation,
      ...(resultContract
        ? { resultContract, observationInvocation, observationInputDigest }
        : {}),
    }))),
  });
}

/** Scoped CAS journal. The host owns and disconnects the shared Prisma pool. */
export class PostgresWorkPlanStore implements WorkPlanStorePort {
  #closed = false;
  readonly #scope: PostgresRuntimeScope;

  constructor(
    private readonly client: PrismaClient,
    scope: PostgresRuntimeScope,
  ) {
    assertPostgresRuntimeScope(scope);
    this.#scope = {
      projectId: scope.projectId,
      systemId: scope.systemId,
      executionSpaceId: scope.executionSpaceId,
      operatorId: scope.operatorId,
    };
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Work-plan store is closed");
  }

  async #read(
    client: PrismaClient | Prisma.TransactionClient,
    id: string,
  ): Promise<WorkPlanRecord | null> {
    const row = await client.workPlan.findUnique({
      where: {
        projectId_systemId_executionSpaceId_operatorId_id: {
          ...this.#scope,
          id,
        },
      },
    });
    if (!row) return null;
    if (
      typeof row.payload !== "string" ||
      new TextEncoder().encode(row.payload).byteLength > maxPayloadBytes
    ) {
      throw new Error("Corrupt work-plan payload");
    }
    const record: unknown = JSON.parse(row.payload);
    assertRecord(record, true);
    if (
      record.id !== id || record.revision !== postgresSafeInteger(row.revision)
    ) {
      throw new Error("Corrupt work-plan identity or revision");
    }
    return record;
  }

  async load(id: string): Promise<WorkPlanRecord | null> {
    if (!identity(id)) throw new Error("Invalid work-plan identity");
    this.#assertOpen();
    return await this.#read(this.client, id);
  }

  async save(
    record: WorkPlanRecord,
    expectedRevision: number | null,
  ): Promise<void> {
    const payload = JSON.stringify(record);
    if (
      typeof payload !== "string" ||
      new TextEncoder().encode(payload).byteLength > maxPayloadBytes
    ) {
      throw new Error("Work-plan payload exceeds 16 MiB");
    }
    // Capture nested caller-owned values before the first asynchronous operation.
    const captured: unknown = JSON.parse(payload);
    assertRecord(captured);
    if (
      expectedRevision !== null &&
        (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) ||
      captured.revision !==
        (expectedRevision === null ? 0 : expectedRevision + 1)
    ) {
      throw new Error("Invalid expected work-plan revision");
    }
    this.#assertOpen();
    try {
      await postgresExecutionTransaction(this.client, async (transaction) => {
        const current = await this.#read(transaction, captured.id);
        if ((current?.revision ?? null) !== expectedRevision) {
          throw new Error("Work-plan revision changed");
        }
        if (
          current && admittedIdentity(current) !== admittedIdentity(captured)
        ) {
          throw new Error("Admitted work-plan identity changed");
        }
        if (
          current?.caseId !== undefined && current.caseId !== captured.caseId
        ) throw new Error("Admitted work-plan case changed");
        if (
          current && current.caseId === undefined &&
          captured.caseId !== undefined &&
          !hasLegacyWorkPlanCase(captured)
        ) {
          throw new Error(
            "A legacy plan can only bind to its caller's migrated dossier Case",
          );
        }
        if (current) {
          for (let index = 0; index < current.tasks.length; index++) {
            const before = current.tasks[index]!.resultVerification;
            const after = captured.tasks[index]!.resultVerification;
            if (!before || !after) {
              continue;
            }
            if (
              after.attempts < before.attempts ||
              after.attempts > before.attempts + 1 ||
              after.observations.length < before.observations.length ||
              after.observations.length > before.observations.length + 1 ||
              canonical(
                  after.observations.slice(0, before.observations.length),
                ) !== canonical(before.observations) ||
              before.status === "verified" &&
                canonical(before) !== canonical(after) ||
              after.status === "verified" && before.status !== "verified" &&
                !(before.status === "pending" &&
                  after.attempts === before.attempts &&
                  after.observations.length === before.observations.length + 1)
            ) {
              throw new Error("Invalid result verification transition");
            }
          }
        }
        if (current === null) {
          if (
            captured.tasks.some((task) =>
              task.resultVerification &&
              (task.resultVerification.attempts !== 0 ||
                task.resultVerification.status !== "pending" ||
                task.resultVerification.observations.length)
            )
          ) {
            throw new Error("New result verification must start pending");
          }

          await transaction.workPlan.create({
            data: {
              ...this.#scope,
              id: captured.id,
              revision: postgresBigInt(captured.revision),
              payload,
            },
          });
        } else {
          const updated = await transaction.workPlan.updateMany({
            where: {
              ...this.#scope,
              id: captured.id,
              revision: postgresBigInt(expectedRevision!),
            },
            data: { revision: postgresBigInt(captured.revision), payload },
          });
          if (updated.count !== 1) {
            throw new Error("Work-plan revision changed");
          }
        }
      });
    } catch (error) {
      if (
        error && typeof error === "object" && "code" in error &&
        ["P2002", "P2034"].includes(String(error.code))
      ) {
        throw new Error("Work-plan revision changed", { cause: error });
      }
      throw error;
    }
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}
