import { PostgresPrimarySpaceControlSource } from "./primary-space-control-source.ts";
import { createPostgresClient, Prisma, type PrismaClient } from "./client.ts";
import {
  type PostgresClientConfiguration,
  postgresClientConfiguration,
} from "./config.ts";
import {
  assertPostgresRuntimeScope,
  assertPostgresSystemScope,
  type PostgresRuntimeScope,
  type PostgresSystemScope,
} from "./scope.ts";
import { PostgresSystemStateStore } from "./system-state-store.ts";
import { PostgresGovernedMemoryStore } from "./memory-store.ts";
import { PostgresContextSkillsStore } from "./skill-store.ts";
import { PostgresWorkPlanStore } from "./plan-store.ts";
import { PostgresWorkBudgetStore } from "./budget-store.ts";
import { PostgresCaseNumberAllocator } from "./case-number-allocator.ts";
import { decodePostgresRuntimeState } from "./runtime-state-snapshot.ts";
import { readCaseRuntimeState } from "./case-runtime-state.ts";
import type { SystemRuntimeState } from "../../../application/work/runtime/state.ts";

import { publicPostgresFailure, safeStoragePort } from "./errors.ts";
export { publicPostgresFailure, safeStoragePort } from "./errors.ts";

export interface OperatorStorage {
  readonly scope: PostgresRuntimeScope;
  readonly state: PostgresSystemStateStore;
  readonly memory: PostgresGovernedMemoryStore;
  readonly skills: PostgresContextSkillsStore;
  readonly plans: PostgresWorkPlanStore;
  readonly budget: PostgresWorkBudgetStore;
}

/** A host-bound storage view; possession conveys no execution authority. */
export interface CaseSpaceStorage {
  readonly executionSpaceId: string;
  readonly caseId: string;
  operator(operatorId: string): Promise<OperatorStorage>;
}

/** One host owns the operational pool. Scope creation grants no modeled rights. */
export class PostgresHostStorage {
  readonly client: PrismaClient;
  readonly #operators = new Map<string, Promise<OperatorStorage>>();
  #scope?: PostgresSystemScope;
  #closing?: Promise<void>;
  #caseNumbers?: PostgresCaseNumberAllocator;
  #primaryControl?: PostgresPrimarySpaceControlSource;
  readonly executionSpaceId = "main";
  constructor(configuration: string | PostgresClientConfiguration | undefined) {
    this.client = createPostgresClient(
      typeof configuration === "object"
        ? configuration
        : postgresClientConfiguration(configuration),
    );
  }
  get scope(): PostgresSystemScope {
    if (!this.#scope) {
      throw new Error("PostgreSQL host system is not registered");
    }
    return this.#scope;
  }
  async registerSystem(scope: PostgresSystemScope): Promise<void> {
    if (this.#closing) throw new Error("PostgreSQL host storage is closing");
    assertPostgresSystemScope(scope);
    if (
      this.#scope &&
      (this.#scope.projectId !== scope.projectId ||
        this.#scope.systemId !== scope.systemId)
    ) {
      throw new Error("PostgreSQL host system scope cannot change");
    }
    // Select the immutable identity before yielding; concurrent registration
    // cannot create a different system on this host-owned handle.
    this.#scope = Object.freeze({ ...scope });
    await this.client.$transaction(async (tx) => {
      await tx.project.upsert({
        where: { projectId: scope.projectId },
        create: { projectId: scope.projectId },
        update: {},
      });
      await tx.assemblySystem.upsert({
        where: { projectId_systemId: scope },
        create: { ...scope },
        update: {},
      });
      const space = { ...scope, executionSpaceId: this.executionSpaceId };
      const existing = await tx.executionSpace.upsert({
        where: { projectId_systemId_executionSpaceId: space },
        create: space,
        update: {},
      });
      if (
        existing.lifecycle !== "active" ||
        existing.parentExecutionSpaceId !== null || existing.caseId !== null
      ) {
        throw new Error("The host execution space is not an active main space");
      }
    }).catch((error) => {
      throw publicPostgresFailure(error) ?? error;
    });
  }
  get sourceScopeId(): string {
    return this.scope.systemId;
  }
  async registerRepository(
    repositoryId: string,
    sourceScopeId: string,
  ): Promise<void> {
    if (this.#closing) throw new Error("PostgreSQL host storage is closing");
    if (!repositoryId.trim() || !sourceScopeId.trim()) {
      throw new Error("Invalid source repository scope");
    }
    const key = { ...this.scope, repositoryId };
    await this.client.$transaction(async (tx) => {
      await tx.sourceRepository.createMany({
        data: [{ ...key, sourceScopeId }],
        skipDuplicates: true,
      });
      const existing = await tx.sourceRepository.findUniqueOrThrow({
        where: { projectId_systemId_repositoryId: key },
      });
      if (existing.sourceScopeId !== sourceScopeId) {
        throw new Error("Source repository scope changed");
      }
    }).catch((error) => {
      throw publicPostgresFailure(error) ?? error;
    });
  }
  /** Read canonical PRIMARY evidence before opening a store. No runtime, state
   * or historical baseline is created by this host-bound lookup. */
  async readPrimaryRuntimeState(
    operatorId: string,
  ): Promise<SystemRuntimeState | null> {
    if (this.#closing) throw new Error("PostgreSQL host storage is closing");
    const scope = {
      ...this.scope,
      executionSpaceId: this.executionSpaceId,
      operatorId,
    };
    assertPostgresRuntimeScope(scope);
    return await this.client.$transaction(async (tx) => {
      // Both absence checks must describe one snapshot, even if the first
      // canonical save commits between them. This lookup cannot write/backfill.
      await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
      const current = await tx.runtimeState.findFirst({ where: scope });
      if (current) return decodePostgresRuntimeState(current);
      if (
        await tx.runtimeRevision.findFirst({
          where: scope,
          select: { revision: true },
        })
      ) {
        throw new Error("Revision history has no current PRIMARY state");
      }
      return null;
    }, { isolationLevel: "RepeatableRead" }).catch((error) => {
      throw publicPostgresFailure(error) ?? error;
    });
  }
  /** Pure read; unlike caseSpace().operator(), this never creates/backfills a store. */
  async readCaseRuntimeState(
    executionSpaceId: string,
    caseId: string,
    operatorId: string,
  ): Promise<SystemRuntimeState | null> {
    if (this.#closing) throw new Error("PostgreSQL host storage is closing");
    return await readCaseRuntimeState(
      this.client,
      this.scope,
      executionSpaceId,
      caseId,
      operatorId,
    );
  }
  /** Composition-only, before opening any store. Host/native IDs stay distinct. */
  bindPrimarySpaceControl(
    binding: { primaryOperatorId: string; sourceSystemNativeId: string },
  ): PostgresPrimarySpaceControlSource {
    if (this.#closing || this.#operators.size) {
      throw new Error("PRIMARY control must be bound before opening stores");
    }
    if (this.#primaryControl) {
      if (
        this.#primaryControl.runtimeScope.operatorId !==
          binding.primaryOperatorId ||
        this.#primaryControl.binding.sourceSystemNativeId !==
          binding.sourceSystemNativeId
      ) throw new Error("PRIMARY control binding cannot change");
      return this.#primaryControl;
    }
    return this.#primaryControl = new PostgresPrimarySpaceControlSource(
      this.client,
      { scope: this.scope, ...binding },
    );
  }
  get primarySpaceControl(): PostgresPrimarySpaceControlSource {
    if (!this.#primaryControl) {
      throw new Error("PRIMARY control is not configured");
    }
    return this.#primaryControl;
  }
  operator(operatorId: string): Promise<OperatorStorage> {
    return this.#operator(this.executionSpaceId, operatorId);
  }
  /** Bind only an existing active Case space in this registered host system.
   * No Case, space, admission, or capability is created by this storage view. */
  async caseSpace(
    executionSpaceId: string,
    caseId: string,
  ): Promise<CaseSpaceStorage> {
    if (
      !executionSpaceId.trim() || executionSpaceId.includes("\0") ||
      executionSpaceId === this.executionSpaceId || !caseId.trim() ||
      caseId.includes("\0")
    ) {
      throw new Error("Invalid Case execution space");
    }
    await this.#validateCaseSpace(executionSpaceId, caseId);
    return Object.freeze({
      executionSpaceId,
      caseId,
      operator: async (operatorId: string) => {
        // A cached store is not evidence that its space is still active.
        await this.#validateCaseSpace(executionSpaceId, caseId);
        return await this.#operator(executionSpaceId, operatorId, caseId);
      },
    });
  }
  async #validateCaseSpace(
    executionSpaceId: string,
    caseId: string,
  ): Promise<void> {
    if (this.#closing) throw new Error("PostgreSQL host storage is closing");
    const scope = this.scope;
    await this.client.$transaction(async (tx) => {
      // UPDATE takes the row lock shared with lifecycle changes. Never upsert a space.
      const locked = await tx.executionSpace.updateMany({
        where: {
          ...scope,
          executionSpaceId,
          caseId,
          parentExecutionSpaceId: this.executionSpaceId,
          lifecycle: "active",
        },
        data: { executionSpaceId },
      });
      if (locked.count !== 1) {
        throw new Error("Case execution space is unavailable");
      }
    }).catch((error) => {
      throw publicPostgresFailure(error) ?? error;
    });
  }
  #operator(
    executionSpaceId: string,
    operatorId: string,
    caseId?: string,
  ): Promise<OperatorStorage> {
    if (this.#closing) {
      return Promise.reject(new Error("PostgreSQL host storage is closing"));
    }
    const key = JSON.stringify([executionSpaceId, operatorId]);
    let pending = this.#operators.get(key);
    if (!pending) {
      pending = this.#openOperator(executionSpaceId, operatorId, caseId).catch(
        (error) => {
          throw publicPostgresFailure(error) ?? error;
        },
      );
      this.#operators.set(key, pending);
      void pending.catch(() => {
        if (this.#operators.get(key) === pending) this.#operators.delete(key);
      });
    }
    return pending;
  }
  async #openOperator(
    executionSpaceId: string,
    operatorId: string,
    caseId?: string,
  ): Promise<OperatorStorage> {
    if (!operatorId.trim() || operatorId.includes("\0")) {
      throw new Error("Invalid operator identity");
    }
    const scope = Object.freeze({
      ...this.scope,
      executionSpaceId,
      operatorId,
    });
    await this.client.$transaction(async (tx) => {
      const locked = await tx.executionSpace.updateMany({
        where: {
          projectId: scope.projectId,
          systemId: scope.systemId,
          executionSpaceId: scope.executionSpaceId,
          ...(caseId === undefined ? {} : {
            caseId,
            parentExecutionSpaceId: this.executionSpaceId,
            lifecycle: "active",
          }),
        },
        data: { executionSpaceId: scope.executionSpaceId },
      });
      if (locked.count !== 1) {
        throw new Error(
          caseId === undefined
            ? "PostgreSQL execution space does not exist"
            : "Case execution space is unavailable",
        );
      }
      // The execution-space lock is held through creation of its operator row.
      await tx.operatorRuntime.upsert({
        where: { projectId_systemId_executionSpaceId_operatorId: scope },
        create: scope,
        update: {},
      });
    });
    return {
      scope,
      state: safeStoragePort(
        await PostgresSystemStateStore.open(
          this.client,
          scope,
          this.#primaryControl,
        ),
      ),
      memory: safeStoragePort(
        new PostgresGovernedMemoryStore(this.client, scope),
      ),
      skills: safeStoragePort(
        new PostgresContextSkillsStore(this.client, scope),
      ),
      plans: safeStoragePort(new PostgresWorkPlanStore(this.client, scope)),
      budget: safeStoragePort(new PostgresWorkBudgetStore(this.client, scope)),
    };
  }
  caseNumbers(): PostgresCaseNumberAllocator {
    if (this.#closing) throw new Error("PostgreSQL host storage is closing");
    return this.#caseNumbers ??= safeStoragePort(
      new PostgresCaseNumberAllocator(this.client, this.scope),
    );
  }
  /** Call only after all runtime, job and model-writer owners have drained. */
  close(): Promise<void> {
    return this.#closing ??= (async () => {
      const failures: unknown[] = [];
      for (const pending of this.#operators.values()) {
        try {
          const stores = await pending;
          for (
            const store of [
              stores.state,
              stores.memory,
              stores.skills,
              stores.plans,
              stores.budget,
            ]
          ) {
            try {
              await store.close();
            } catch (error) {
              failures.push(error);
            }
          }
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await this.#caseNumbers?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.client.$disconnect();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(failures, "PostgreSQL host shutdown failed");
      }
    })();
  }
}
