import {
  normalizeProviderCallObservation,
  type ProviderCallHostScope,
  type ProviderCallObservation,
  type ProviderCallObservationStore,
  type ProviderCallScope,
} from "../../../application/telemetry/provider-call.ts";
import { postgresQualifiedTable, Prisma, type PrismaClient } from "./client.ts";
import {
  assertProviderCallScope,
  decodeProviderCall,
  encodeProviderCall,
} from "./provider-call-codec.ts";

const MAX_LIST = 500;

export class ProviderCallConflictError extends Error {
  readonly code = "PROVIDER_CALL_CONFLICT";
  constructor() {
    super("Provider call observation identity conflict");
    this.name = "ProviderCallConflictError";
  }
}

/** Direct client only: every append owns its bounded, independent transaction. */
export class PostgresProviderCallStore implements ProviderCallObservationStore {
  constructor(private readonly client: PrismaClient) {}

  async append(
    host: ProviderCallHostScope,
    observation: ProviderCallObservation,
  ): Promise<"inserted" | "duplicate"> {
    const payload = encodeProviderCall(host, observation);
    const normalized = normalizeProviderCallObservation(JSON.parse(payload));
    const spaceId = normalized.correlation.executionScope?.executionSpaceId ??
      null;
    const table = postgresQualifiedTable(
      this.client,
      "ProviderCallObservation",
    );
    return await this.client.$transaction(async (transaction) => {
      const inserted = await transaction.$executeRaw(Prisma.sql`
        INSERT INTO ${table} ("projectId", "systemId", "observationId", "executionSpaceId", "payload")
        VALUES (${host.projectId}, ${host.systemId}, ${normalized.observationId}, ${spaceId}, ${payload})
        ON CONFLICT ("projectId", "systemId", "observationId") DO NOTHING
      `);
      if (inserted === 1) return "inserted";
      const rows = await transaction.$queryRaw<Array<{ payload: string }>>(
        Prisma.sql`
        SELECT "payload" FROM ${table}
        WHERE "projectId" = ${host.projectId} AND "systemId" = ${host.systemId}
          AND "observationId" = ${normalized.observationId}
      `,
      );
      if (rows.length !== 1 || rows[0]!.payload !== payload) {
        throw new ProviderCallConflictError();
      }
      return "duplicate";
    }, { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 });
  }

  async list(
    scope: ProviderCallScope,
    limit = MAX_LIST,
  ): Promise<readonly ProviderCallObservation[]> {
    assertProviderCallScope(scope);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST) {
      throw new Error("Invalid provider call list limit");
    }
    const table = postgresQualifiedTable(
      this.client,
      "ProviderCallObservation",
    );
    const rows = await this.client.$queryRaw<
      Array<{ observationId: string; payload: string }>
    >(Prisma.sql`
      SELECT "observationId", "payload" FROM ${table}
      WHERE "projectId" = ${scope.projectId} AND "systemId" = ${scope.systemId}
        AND "executionSpaceId" IS NOT DISTINCT FROM ${scope.executionSpaceId}
      ORDER BY "observationId" ASC LIMIT ${limit}
    `);
    return rows.map((row) =>
      decodeProviderCall(scope, row.observationId, row.payload)
    );
  }
}
