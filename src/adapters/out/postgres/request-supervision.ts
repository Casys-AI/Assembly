import type { SupervisionObservationPort } from "../../../application/work/request-spaces/supervision.ts";
import type { ScopedOperatorRef } from "../../../domain/governance/authority.ts";
import type { OpeningRecord } from "../../../domain/work/request-spaces.ts";
import type { PostgresRequestExecutionBindingReader } from "./request-execution-binding.ts";
import { Prisma, type PrismaClient } from "./client.ts";
import { assertPostgresRuntimeScope } from "./scope.ts";
import { decodePostgresRuntimeState } from "./runtime-state-snapshot.ts";
import { sameVerifiedRuntimeSnapshot } from "./runtime-snapshot-codec.ts";
import { decodeHistorical } from "./system-state-store.ts";

/** Persisted observations only: no runtime registry/factory, open store or
 * activation dependency. The Main locator is fixed by host registration. */
export class PostgresRequestSupervisionObservations
  implements SupervisionObservationPort {
  readonly mainActor: ScopedOperatorRef;
  constructor(
    private readonly client: PrismaClient,
    registeredMain: ScopedOperatorRef,
    private readonly bindings: Pick<
      PostgresRequestExecutionBindingReader,
      "readInTransaction"
    >,
  ) {
    assertPostgresRuntimeScope(registeredMain);
    if (registeredMain.executionSpaceId !== "main") {
      throw new Error("Expected the registered Main scope");
    }
    this.mainActor = Object.freeze({ ...registeredMain });
  }
  async main() {
    const scope = this.mainActor;
    return await this.client.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
      const space = await tx.executionSpace.findUnique({
        where: {
          projectId_systemId_executionSpaceId: {
            projectId: scope.projectId,
            systemId: scope.systemId,
            executionSpaceId: "main",
          },
        },
      });
      if (
        !space || space.parentExecutionSpaceId !== null ||
        space.caseId !== null ||
        space.lifecycle !== "active" || space.closedAt !== null
      ) throw new Error("Main observation unavailable");
      const current = await tx.runtimeState.findFirst({ where: scope });
      const latest = await tx.runtimeRevision.findFirst({
        where: scope,
        orderBy: { revision: "desc" },
      });
      if (!current) {
        if (latest) throw new Error("Main history has no current state");
        return null;
      }
      const state = decodePostgresRuntimeState(current);
      if (
        !latest || latest.runtimeStateId !== state.id ||
        decodeHistorical(latest).revision !== state.revision ||
        !sameVerifiedRuntimeSnapshot(latest.payload, current.payload)
      ) {
        throw new Error("Main current state and history disagree");
      }
      return structuredClone(state);
    }, { isolationLevel: "RepeatableRead" });
  }
  async request(opening: OpeningRecord) {
    const snapshot = structuredClone(opening);
    if (
      snapshot.scope.projectId !== this.mainActor.projectId ||
      snapshot.scope.systemId !== this.mainActor.systemId ||
      snapshot.executionSpaceId === "main"
    ) {
      throw new Error("Request observation outside registered host");
    }
    return await this.client.$transaction(async (tx) => {
      // The existing binding verifier may take SHARE locks when checking a
      // historical receipt. It performs no writes and cannot run in READ ONLY.
      const binding = await this.bindings.readInTransaction(tx, snapshot);
      const space = await tx.executionSpace.findUnique({
        where: {
          projectId_systemId_executionSpaceId: {
            ...snapshot.scope,
            executionSpaceId: snapshot.executionSpaceId,
          },
        },
      });
      if (!space || space.caseId !== snapshot.caseId) {
        throw new Error("Request space observation unavailable");
      }
      return { binding, parentExecutionSpaceId: space.parentExecutionSpaceId };
    }, { isolationLevel: "RepeatableRead" });
  }
  /** Admitted team members' persisted states, verified like the BO's own:
   * current row and latest history must agree, digest per admitted index.
   * A member failing that check is absent from the result. */
  async team(opening: OpeningRecord) {
    const snapshot = structuredClone(opening);
    if (
      snapshot.scope.projectId !== this.mainActor.projectId ||
      snapshot.scope.systemId !== this.mainActor.systemId ||
      snapshot.executionSpaceId === "main" || !snapshot.base
    ) {
      throw new Error("Request observation outside registered host");
    }
    return await this.client.$transaction(async (tx) => {
      const binding = await this.bindings.readInTransaction(tx, snapshot);
      const { operatorIds, modelDigests } = binding.admission.permissions;
      const states = [];
      for (let index = 1; index < operatorIds.length; index++) {
        const scope = {
          ...snapshot.scope,
          executionSpaceId: snapshot.executionSpaceId,
          operatorId: operatorIds[index]!,
        };
        const current = await tx.runtimeState.findFirst({ where: scope });
        const latest = await tx.runtimeRevision.findFirst({
          where: scope,
          orderBy: { revision: "desc" },
        });
        // Only verified states are returned: supervision lists every member
        // its observed admission names, and one absent here as unavailable.
        if (!current || !latest) continue;
        const state = decodePostgresRuntimeState(current);
        if (
          latest.runtimeStateId !== state.id ||
          decodeHistorical(latest).revision !== state.revision ||
          !sameVerifiedRuntimeSnapshot(latest.payload, current.payload) ||
          state.executionModel?.identity.builderId !== operatorIds[index] ||
          state.executionModel.version.digest !== modelDigests[index]
        ) continue;
        states.push(structuredClone(state));
      }
      return states;
    }, { isolationLevel: "RepeatableRead" });
  }
}
