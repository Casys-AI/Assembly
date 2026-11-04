import { postgresExecutionTransaction } from "./execution-transaction.ts";
import { postgresQualifiedTable, Prisma, type PrismaClient } from "./client.ts";
import { WorkBudgetService } from "../../../application/work/budget/service.ts";
import type { WorkBudgetAdoptInput } from "../../../application/work/budget/commands/inputs.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import { evolutionBudgetScopes } from "../../../application/work/runtime/evolution.ts";
import {
  projectEvolutionBudgets,
  retainedBudgetPolicy,
} from "../../../application/work/runtime/evolution-budget-projection.ts";
import { caseBudgetPolicy } from "../../../application/work/cases/runtime.ts";
import type { BehaviorSettingsBudgetScope } from "../../../application/work/runtime/behavior-settings-validation.ts";
import type { SystemRuntimeState } from "../../../application/work/runtime/state.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import { postgresBigInt, postgresSafeInteger } from "./numbers.ts";
import {
  assertPostgresRuntimeScope,
  type PostgresRuntimeScope,
} from "./scope.ts";
import type { WorkBudgetStorePort } from "../../../application/work/budget/ports.ts";
import {
  budgetIdentity,
  budgetState,
  WorkBudgetError,
  type WorkBudgetPolicy,
  type WorkBudgetRecord,
} from "../../../domain/work/policies/budget.ts";
export const MAX_WORK_BUDGET_PAYLOAD_BYTES = 32 * 1024 * 1024;
function invalid(): never {
  throw new WorkBudgetError("invalid", "Invalid stored work budget");
}
function decode(
  payload: unknown,
  revision: unknown,
  scopeId: string,
): WorkBudgetRecord {
  if (
    typeof payload !== "string" ||
    new TextEncoder().encode(payload).length > MAX_WORK_BUDGET_PAYLOAD_BYTES
  ) invalid();
  let record: WorkBudgetRecord;
  let storedRevision: unknown;
  try {
    storedRevision = typeof revision === "bigint"
      ? postgresSafeInteger(revision)
      : revision;
    record = JSON.parse(payload);
    budgetState(record);
  } catch {
    invalid();
  }
  if (record.scopeId !== scopeId || record.revision !== storedRevision) {
    invalid();
  }
  for (const event of record.events) {
    if (
      event.kind === "policy" &&
      (!event.modelVersion || !budgetIdentity(event.modelVersion.digest) ||
        (event.modelVersion.repositoryVersion !== undefined &&
          !budgetIdentity(event.modelVersion.repositoryVersion)))
    ) invalid();
  }

  return record;
}
/** Scoped budget journal with database CAS across services and pool connections. */
export class PostgresWorkBudgetStore implements WorkBudgetStorePort {
  #closed = false;
  readonly #scope: PostgresRuntimeScope;
  readonly #evolutionPackets = new WeakMap<
    object,
    {
      before: Map<string, WorkBudgetRecord | null>;
      after: Map<string, WorkBudgetRecord | null>;
      digests: Map<string, string | null>;
    }
  >();
  readonly #evolutionLocks = new WeakMap<
    object,
    { tx: Prisma.TransactionClient; packet: object }
  >();

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
    if (this.#closed) {
      throw new WorkBudgetError("invalid", "Budget store closed");
    }
  }

  async #read(
    client: PrismaClient | Prisma.TransactionClient,
    scopeId: string,
  ): Promise<WorkBudgetRecord | null> {
    const row = await client.workBudget.findUnique({
      where: {
        projectId_systemId_executionSpaceId_operatorId_scopeId: {
          ...this.#scope,
          scopeId,
        },
      },
    });
    return row ? decode(row.payload, row.revision, scopeId) : null;
  }

  async load(scopeId: string): Promise<WorkBudgetRecord | null> {
    if (!budgetIdentity(scopeId)) invalid();
    this.#assertOpen();
    return await this.#read(this.client, scopeId);
  }

  /** Source publication must assess actual retained ledgers, not cached
   * projections in the runtime. The caller holds the target reservation and
   * uses this result only within its existing transaction and cutoff. */
  async projectEvolutionBudgetsInTransaction(
    tx: Prisma.TransactionClient,
    stateInput: SystemRuntimeState,
    policyFor?: (
      scope: BehaviorSettingsBudgetScope,
    ) => readonly WorkBudgetPolicy[],
    candidateInput?: ExecutableModel,
  ) {
    this.#assertOpen();
    const state = structuredClone(stateInput);
    if (
      state.executionModel?.identity.builderId !== this.#scope.operatorId ||
      this.#scope.executionSpaceId !== "main" &&
        state.id !==
          `request:${this.#scope.executionSpaceId}:${this.#scope.operatorId}`
    ) invalid();
    const ids = [
      ...new Set(evolutionBudgetScopes(state).map((scope) => scope.scopeId)),
    ].sort();
    if (ids.length > 256 || ids.some((id) => !budgetIdentity(id))) invalid();
    for (const id of ids) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "scopeId" FROM ${
          postgresQualifiedTable(this.client, "WorkBudget")
        }
        WHERE "projectId"=${this.#scope.projectId} AND "systemId"=${this.#scope.systemId}
        AND "executionSpaceId"=${this.#scope.executionSpaceId} AND "operatorId"=${this.#scope.operatorId}
        AND "scopeId"=${id} FOR UPDATE NOWAIT`,
      );
    }
    const readOnly = new WorkBudgetService({
      load: (id) => this.#read(tx, id),
      save: () =>
        Promise.reject(
          new WorkBudgetError(
            "invalid",
            "Publication budget projection is read only",
          ),
        ),
    });
    const projection = await projectEvolutionBudgets(
      state,
      readOnly,
      policyFor,
    );
    if (candidateInput) {
      const candidate = structuredClone(candidateInput);
      if (candidate.identity.builderId !== this.#scope.operatorId) invalid();
      const copies = new Map<string, WorkBudgetRecord | null>();
      for (const id of ids) copies.set(id, await this.#read(tx, id));
      const detached = new WorkBudgetService({
        // deno-lint-ignore require-await -- Preserve the asynchronous port's rejection semantics.
        load: async (id) => structuredClone(copies.get(id) ?? null),
        // deno-lint-ignore require-await -- CAS conflicts must reject asynchronously through the port.
        save: async (record, expected) => {
          if ((copies.get(record.scopeId)?.revision ?? null) !== expected) {
            throw new WorkBudgetError("conflict", "Projected budget changed");
          }
          copies.set(record.scopeId, structuredClone(record));
        },
      });
      for (const scope of evolutionBudgetScopes(state)) {
        if (scope.ownerId !== this.#scope.operatorId || scope.pending) continue;
        const previousPolicy = retainedBudgetPolicy(state, scope);
        const current = copies.get(scope.scopeId);
        const active = current?.events.findLast((event) =>
          event.kind === "policy" || event.kind === "reserve" ||
          event.kind === "refused"
        );
        if (
          current &&
          (!active || !("policy" in active) ||
            canonical(active.policy) !== canonical(previousPolicy ?? null))
        ) {
          throw new WorkBudgetError(
            "conflict",
            "Retained budget policy differs from the previous execution model",
          );
        }
        await detached.adopt({
          scopeId: scope.scopeId,
          ownerId: scope.ownerId,
          previousPolicy,
          policy: scope.designer
            ? candidate.workBudgetPolicy
            : caseBudgetPolicy(candidate, scope.caseTypeId, scope.ceiling),
          modelVersion: candidate.version,
        });
      }
    }
    return projection;
  }

  /** Reuse the existing policy transition logic on detached ledger copies.
   * Neither the packet nor its projected service is authority to commit. */
  async prepareEvolutionBatch(
    scopeIds: readonly string[],
    inputs: readonly WorkBudgetAdoptInput[],
  ) {
    this.#assertOpen();
    const ids = [...new Set(scopeIds)].sort();
    if (
      ids.length !== scopeIds.length || ids.length > 256 ||
      ids.some((id) => !budgetIdentity(id)) ||
      inputs.some((input) => !ids.includes(input.scopeId)) ||
      new Set(inputs.map((input) => input.scopeId)).size !== inputs.length
    ) invalid();
    const before = new Map<string, WorkBudgetRecord | null>();
    for (const id of ids) before.set(id, await this.#read(this.client, id));
    const digests = new Map<string, string | null>();
    for (const [id, record] of before) {
      digests.set(id, record ? await executionDigest(record) : null);
    }
    const after = structuredClone(before);
    const service = new WorkBudgetService({
      // deno-lint-ignore require-await -- Preserve the asynchronous port's rejection semantics.
      load: async (id) => structuredClone(after.get(id) ?? null),
      // deno-lint-ignore require-await -- CAS conflicts must reject asynchronously through the port.
      save: async (record, expected) => {
        if ((after.get(record.scopeId)?.revision ?? null) !== expected) {
          throw new WorkBudgetError("conflict", "Prepared budget changed");
        }
        after.set(record.scopeId, structuredClone(record));
      },
    });
    for (const input of inputs) {
      const current = before.get(input.scopeId);
      if (current && budgetState(current).view.reserved !== 0) {
        throw new WorkBudgetError(
          "conflict",
          "Unsettled budget reservation blocks adoption",
        );
      }
      const active = current?.events.findLast((event) =>
        event.kind === "policy" || event.kind === "reserve" ||
        event.kind === "refused"
      );
      if (
        current &&
        (!active || !("policy" in active) ||
          canonical(active.policy) !== canonical(input.previousPolicy ?? null))
      ) {
        throw new WorkBudgetError(
          "conflict",
          "Retained budget policy differs from the previous execution model",
        );
      }
      await service.adopt(structuredClone(input));
    }
    const packet = Object.freeze({});
    this.#evolutionPackets.set(packet, { before, after, digests });
    return { packet, projected: service };
  }

  /** Locks every captured row in stable scope order, then checks exact prior
   * bytes/revisions. Missing rows can only be created through the same CAS. */
  async lockEvolutionBatchInTransaction(
    tx: Prisma.TransactionClient,
    packet: object,
  ): Promise<object> {
    const data = this.#evolutionPackets.get(packet);
    if (!data) invalid();
    for (const id of data.before.keys()) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "scopeId" FROM ${
          postgresQualifiedTable(this.client, "WorkBudget")
        } WHERE "projectId"=${this.#scope.projectId} AND "systemId"=${this.#scope.systemId} AND "executionSpaceId"=${this.#scope.executionSpaceId} AND "operatorId"=${this.#scope.operatorId} AND "scopeId"=${id} FOR UPDATE NOWAIT`,
      );
      const actual = await this.#read(tx, id);
      if (
        canonical(actual) !== canonical(data.before.get(id)) ||
        (actual ? await executionDigest(actual) : null) !== data.digests.get(id)
      ) throw new WorkBudgetError("conflict", "Budget changed before adoption");
    }
    const token = Object.freeze({});
    this.#evolutionLocks.set(token, { tx, packet });
    return token;
  }

  async saveEvolutionBatchLocked(
    tx: Prisma.TransactionClient,
    packet: object,
    token: object,
  ): Promise<void> {
    const data = this.#evolutionPackets.get(packet),
      lock = this.#evolutionLocks.get(token);
    if (!data || !lock || lock.tx !== tx || lock.packet !== packet) invalid();
    this.#evolutionLocks.delete(token);
    for (const [id, previous] of data.before) {
      const next = data.after.get(id) ?? null;
      if (canonical(previous) === canonical(next)) continue;
      if (
        !next || next.revision !== (previous?.revision ?? 0) + 1 || previous &&
          (previous.ownerId !== next.ownerId ||
            canonical(previous.events) !== canonical(next.events.slice(0, -1)))
      ) invalid();
      const payload = JSON.stringify(next);
      decode(payload, next.revision, id);
      if (previous) {
        const update = await tx.workBudget.updateMany({
          where: {
            ...this.#scope,
            scopeId: id,
            revision: postgresBigInt(previous.revision),
          },
          data: { revision: postgresBigInt(next.revision), payload },
        });
        if (update.count !== 1) {
          throw new WorkBudgetError(
            "conflict",
            "Budget changed during adoption",
          );
        }
      } else {
        await tx.workBudget.create({
          data: {
            ...this.#scope,
            scopeId: id,
            revision: postgresBigInt(next.revision),
            payload,
          },
        });
      }
    }
  }

  async save(
    record: WorkBudgetRecord,
    expectedRevision: number | null,
  ): Promise<void> {
    const payload = JSON.stringify(record);
    const next = decode(payload, record.revision, record.scopeId);
    if (
      expectedRevision !== null &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    ) invalid();
    if (next.revision !== (expectedRevision ?? 0) + 1) invalid();
    this.#assertOpen();
    try {
      await postgresExecutionTransaction(this.client, async (transaction) => {
        const current = await this.#read(transaction, next.scopeId);
        if ((current?.revision ?? null) !== expectedRevision) {
          throw new WorkBudgetError("conflict", "Budget revision changed");
        }
        if (
          current && (current.ownerId !== next.ownerId ||
            JSON.stringify(current.events) !==
              JSON.stringify(next.events.slice(0, -1)))
        ) {
          throw new WorkBudgetError("conflict", "Budget history changed");
        }
        if (current) {
          const updated = await transaction.workBudget.updateMany({
            where: {
              ...this.#scope,
              scopeId: next.scopeId,
              revision: postgresBigInt(expectedRevision!),
            },
            data: { revision: postgresBigInt(next.revision), payload },
          });
          if (updated.count !== 1) {
            throw new WorkBudgetError("conflict", "Budget revision changed");
          }
        } else {
          await transaction.workBudget.create({
            data: {
              ...this.#scope,
              scopeId: next.scopeId,
              revision: postgresBigInt(next.revision),
              payload,
            },
          });
        }
      });
    } catch (error) {
      if (
        error && typeof error === "object" && "code" in error &&
        ["P2002", "P2034"].includes(String(error.code))
      ) {
        throw new WorkBudgetError("conflict", "Budget revision changed");
      }
      throw error;
    }
  }

  // Each adapter can be retired independently; only the host disconnects the pool.
  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}
