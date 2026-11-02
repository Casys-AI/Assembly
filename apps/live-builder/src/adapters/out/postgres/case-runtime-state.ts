import { Prisma, type PrismaClient } from "./client.ts";
import { publicPostgresFailure } from "./errors.ts";
import {
  assertPostgresRuntimeScope,
  type PostgresSystemScope,
} from "./scope.ts";
import { decodePostgresRuntimeState } from "./runtime-state-snapshot.ts";
import { sameVerifiedRuntimeSnapshot } from "./runtime-snapshot-codec.ts";
import { decodeHistorical } from "./system-state-store.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";

/** Retained Case state is read in one read-only snapshot, with no store opening. */
export async function readCaseRuntimeState(
  client: Pick<PrismaClient, "$transaction">,
  hostScope: PostgresSystemScope,
  executionSpaceId: string,
  caseId: string,
  operatorId: string,
): Promise<SystemRuntimeState | null> {
  if (executionSpaceId === "main" || !caseId.trim() || caseId.includes("\0")) {
    throw new Error("Case runtime is unavailable");
  }
  const scope = { ...hostScope, executionSpaceId, operatorId };
  assertPostgresRuntimeScope(scope);
  return await client.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
    const space = await tx.executionSpace.findUnique({
      where: {
        projectId_systemId_executionSpaceId: { ...hostScope, executionSpaceId },
      },
    });
    if (
      !space || space.caseId !== caseId ||
      space.parentExecutionSpaceId !== "main" ||
      !["active", "closed"].includes(space.lifecycle) ||
      (space.lifecycle === "active") !== (space.closedAt === null)
    ) {
      throw new Error("Case runtime is unavailable");
    }
    const current = await tx.runtimeState.findFirst({ where: scope });
    const latest = await tx.runtimeRevision.findFirst({
      where: scope,
      orderBy: { revision: "desc" },
    });
    if (!current) {
      if (latest) throw new Error("Revision history has no current Case state");
      return null;
    }
    const state = decodePostgresRuntimeState(current);
    // Independent Request births are never legacy stores. Missing or divergent
    // history refuses; this reader never repairs it through a startup path.
    if (
      !latest || decodeHistorical(latest).revision !== state.revision ||
      latest.runtimeStateId !== state.id ||
      !sameVerifiedRuntimeSnapshot(latest.payload, current.payload)
    ) {
      throw new Error("Current Case state and revision history disagree");
    }
    return structuredClone(state);
  }, { isolationLevel: "RepeatableRead" }).catch((error) => {
    throw publicPostgresFailure(error) ?? error;
  });
}
