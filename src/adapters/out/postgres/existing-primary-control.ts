import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { RequestSpaceError } from "../../../domain/work/request-spaces.ts";
import { Prisma, type PrismaClient } from "./client.ts";
import { PostgresPrimarySpaceControlSource } from "./primary-space-control-source.ts";
import { decodePostgresRuntimeState } from "./runtime-state-snapshot.ts";
import {
  assertPostgresRuntimeScope,
  type PostgresSystemScope,
} from "./scope.ts";

/** Reopen existing canonical authority only. No registration/upsert, runtime,
 * store, source compiler, history repair, credential or admission is created. */
export async function existingPrimaryControl(
  client: PrismaClient,
  scope: PostgresSystemScope,
  primaryOperatorId: string,
): Promise<PostgresPrimarySpaceControlSource> {
  const runtimeScope = {
    ...scope,
    executionSpaceId: "main",
    operatorId: primaryOperatorId,
  };
  assertPostgresRuntimeScope(runtimeScope);
  const denied = () =>
    new RequestSpaceError(
      "FORBIDDEN",
      "An existing exact PRIMARY with current modeled control is required.",
    );
  const nativeSystemId = await client.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
    const main = await tx.executionSpace.findUnique({
      where: {
        projectId_systemId_executionSpaceId: {
          ...scope,
          executionSpaceId: "main",
        },
      },
    });
    const operator = await tx.operatorRuntime.findUnique({
      where: { projectId_systemId_executionSpaceId_operatorId: runtimeScope },
    });
    const row = await tx.runtimeState.findFirst({ where: runtimeScope });
    if (
      !main || main.lifecycle !== "active" ||
      main.parentExecutionSpaceId !== null ||
      main.caseId !== null || !operator || !row
    ) throw denied();
    const state = decodePostgresRuntimeState(row);
    const model = state.executionModel;
    if (
      !model || model.identity.projectId !== scope.projectId ||
      model.identity.builderId !== primaryOperatorId ||
      typeof model.identity.systemId !== "string" ||
      !model.identity.systemId.trim() ||
      canonical(state.model) !== canonical(model.identity)
    ) throw denied();
    return model.identity.systemId;
  }, { isolationLevel: "RepeatableRead" });
  const primary = new PostgresPrimarySpaceControlSource(client, {
    scope,
    primaryOperatorId,
    sourceSystemNativeId: nativeSystemId,
  });
  // This reopens CURRENT canonical source and applies the shared source decoder.
  // A changed identity, absent policy or malformed retained source never falls
  // back to a locator/role/HEAD. Issuance captures it once more atomically.
  if (!await primary.read()) throw denied();
  return primary;
}
