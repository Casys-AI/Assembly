/** Small database execution-fence context. No workflow/graph implementation is
 * imported by canonical stores. Each canonical write still owns its COMMIT. */
import { AsyncLocalStorage } from "node:async_hooks";
import { fromPrisma } from "pg-boss";
import type { Prisma, PrismaClient } from "./client.ts";

export type ExecutionSql = (
  text: string,
  values?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;
export interface PostgresExecutionTransaction {
  client: PrismaClient;
  /** Queue metadata only. Canonical stores must never join this transaction. */
  transaction?: Prisma.TransactionClient;
  fence?: (query: ExecutionSql) => Promise<void>;
  session?: { threadId: string; runId: string };
}
export interface PostgresExecutionTransactionOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  maxWait?: number;
  timeout?: number;
}
const context = new AsyncLocalStorage<PostgresExecutionTransaction>();
export const currentPostgresExecutionTransaction = () => context.getStore();

export async function postgresExecutionTransaction<T>(
  client: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: PostgresExecutionTransactionOptions,
): Promise<T> {
  const execution = context.getStore();
  if (execution && execution.client !== client) {
    throw new Error("Execution transaction uses a different PostgreSQL client");
  }
  if (execution?.transaction) {
    throw new Error(
      "Canonical business writes cannot join an uncommitted queue acceptance",
    );
  }
  return await client.$transaction(async (tx) => {
    await execution?.fence?.(fromPrisma(tx).executeSql);
    const result = await operation(tx);
    await execution?.fence?.(fromPrisma(tx).executeSql);
    return result;
  }, options);
}

export async function withPostgresExecutionTransaction<T>(
  execution: PostgresExecutionTransaction,
  operation: () => Promise<T>,
): Promise<T> {
  return await context.run(execution, operation);
}
