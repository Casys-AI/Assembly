import {
  ProviderResourceAggregation,
  type ProviderResourceQuery,
  type ProviderResourceReader,
  type ProviderResourceReadout,
} from "../../../application/telemetry/provider-resource-readout.ts";
import { postgresQualifiedTable, Prisma, type PrismaClient } from "./client.ts";
import { decodeProviderCall } from "./provider-call-codec.ts";

const PAGE_SIZE = 500;
const READ_DEADLINE_MS = 10_000;

export class ProviderResourceReadError extends Error {
  readonly code = "PROVIDER_RESOURCE_READ_FAILED";
  constructor() {
    super("Provider resource readout is unavailable");
    this.name = "ProviderResourceReadError";
  }
}

/** Complete retained evidence under trusted scope, independent of capped list().
 * No execution authority is granted; the caller must resolve/authorize selection. */
export class PostgresProviderResourceReader implements ProviderResourceReader {
  constructor(private readonly client: PrismaClient) {}

  async read(query: ProviderResourceQuery): Promise<ProviderResourceReadout> {
    const aggregate = new ProviderResourceAggregation(query);
    // Capture from the copied allowlist, never caller-mutable query fields.
    const selection = aggregate.selection;
    const scope = {
      projectId: selection.projectId,
      systemId: selection.systemId,
      executionSpaceId: selection.executionSpaceId,
    };
    try {
      const table = postgresQualifiedTable(
        this.client,
        "ProviderCallObservation",
      );
      return await this.client.$transaction(async (transaction) => {
        await transaction.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
        await transaction.$executeRaw(
          Prisma.sql`SET LOCAL statement_timeout = '10000ms'`,
        );
        const clock = await transaction.$queryRaw<Array<{ readAt: Date }>>(
          Prisma.sql`SELECT transaction_timestamp() AS "readAt"`,
        );
        if (clock.length !== 1 || !(clock[0]!.readAt instanceof Date)) {
          throw new Error("Invalid read snapshot time");
        }
        const readAt = clock[0]!.readAt.toISOString();
        let cursor: string | null = null;
        while (true) {
          const after: Prisma.Sql = cursor === null
            ? Prisma.empty
            : Prisma.sql`AND "observationId" > ${cursor}`;
          const rows: Array<{ observationId: string; payload: string }> =
            await transaction.$queryRaw<
              Array<{ observationId: string; payload: string }>
            >(Prisma.sql`
            SELECT "observationId", "payload" FROM ${table}
            WHERE "projectId" = ${scope.projectId}
              AND "systemId" = ${scope.systemId}
              AND "executionSpaceId" = ${scope.executionSpaceId}
              ${after}
            ORDER BY "observationId" ASC LIMIT ${PAGE_SIZE}
          `);
          for (const row of rows) {
            // Decode every scope row before Request or Main-pin/cutoff selection.
            // Corruption never disappears through JSON predicates or NULL sums.
            aggregate.add(
              decodeProviderCall(scope, row.observationId, row.payload),
            );
          }
          if (rows.length < PAGE_SIZE) return aggregate.finish(readAt);
          cursor = rows[rows.length - 1]!.observationId;
        }
      }, {
        isolationLevel: "RepeatableRead",
        maxWait: 5_000,
        timeout: READ_DEADLINE_MS,
      });
    } catch {
      // No partially accumulated result, SQL, payload or private error escapes.
      throw new ProviderResourceReadError();
    }
  }
}
