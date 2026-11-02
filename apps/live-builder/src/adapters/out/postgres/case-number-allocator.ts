import { postgresExecutionTransaction } from "./execution-transaction.ts";
import type { CaseNumberPort } from "../../../application/work/cases/ports/out/case-number.port.ts";
import type { PrismaClient } from "./client.ts";
import { postgresSafeInteger } from "./numbers.ts";
import {
  assertPostgresSystemScope,
  type PostgresSystemScope,
} from "./scope.ts";

/** Committed system sequence shared across all execution spaces and operators.
 * Gaps after interrupted Case creation are intentional; numbers are never reused.
 */
export class PostgresCaseNumberAllocator implements CaseNumberPort {
  #closed = false;
  readonly #scope: PostgresSystemScope;

  constructor(
    private readonly client: PrismaClient,
    scope: PostgresSystemScope,
  ) {
    assertPostgresSystemScope(scope);
    this.#scope = { projectId: scope.projectId, systemId: scope.systemId };
  }

  async allocate(): Promise<number> {
    if (this.#closed) throw new Error("Case number allocator is closed");
    return await postgresExecutionTransaction(
      this.client,
      async (transaction) => {
        // Native ON CONFLICT handles simultaneous first allocations safely.
        await transaction.caseSequence.createMany({
          data: [{ ...this.#scope, lastNumber: 0n }],
          skipDuplicates: true,
        });
        const updated = await transaction.caseSequence.updateMany({
          where: {
            ...this.#scope,
            lastNumber: { gte: 0n, lt: BigInt(Number.MAX_SAFE_INTEGER) },
          },
          data: { lastNumber: { increment: 1n } },
        });
        if (updated.count !== 1) {
          throw new Error("Case number sequence exhausted or invalid");
        }
        // The update holds the row lock until this transaction commits.
        const sequence = await transaction.caseSequence.findUniqueOrThrow({
          where: { projectId_systemId: this.#scope },
        });
        const next = postgresSafeInteger(sequence.lastNumber);
        if (next < 1) {
          throw new Error("Case number sequence exhausted or invalid");
        }
        return next;
      },
    );
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}
