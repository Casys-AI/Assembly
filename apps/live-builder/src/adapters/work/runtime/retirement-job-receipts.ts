import { isPlainRecord as object } from "../../../domain/primitives/is-plain-record.ts";
import {
  postgresQualifiedTable,
  Prisma,
  type PrismaClient,
} from "../../out/postgres/client.ts";
import type { PostgresSystemScope } from "../../out/postgres/scope.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";

/** Lookup is pg-boss's public API using the caller's Prisma transaction. */
export type RetirementJobLookup = (
  tx: Prisma.TransactionClient,
  jobId: string,
) => Promise<
  readonly { id: string; name: string; state: string; data: unknown }[]
>;

const text = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim() && !value.includes("\0");

/** Proves no owner handler can run, rather than locking pg-boss's internal
 * state. An active retry of a completed owner receipt returns without a handler.
 * A nested native receipt can complete earlier and is NOT this owner receipt. */
export async function lockRetirementJobReceipts(input: {
  tx: Prisma.TransactionClient;
  client: PrismaClient;
  scope: PostgresSystemScope & { executionSpaceId: string };
  queueName: string;
  jobIds: readonly string[];
  lookup?: RetirementJobLookup;
}): Promise<void> {
  const ids = [...new Set(input.jobIds)].sort();
  if (ids.length > 256 || ids.some((id) => !text(id))) {
    throw new Error("Invalid retirement job set");
  }
  if (!ids.length) return;
  if (!input.lookup) {
    throw new Error("Retirement requires its public job lookup");
  }
  const owners = [];
  // Complete API/cache reads before taking any receipt or native locks.
  for (const id of ids) {
    const jobs = structuredClone(await input.lookup(input.tx, id));
    if (
      jobs.length !== 1 || jobs[0].id !== id || jobs[0].name !== input.queueName
    ) {
      throw new Error("Retirement job is missing or foreign");
    }
    // Terminal native refusal can complete its receipt before its handler
    // returns. Preserve the legacy active-job refusal as well as our row fence.
    if (
      !["created", "retry", "completed", "failed", "cancelled"].includes(
        jobs[0].state,
      )
    ) {
      throw new Error("Live or unknown native claim blocks retirement");
    }
    const data = jobs[0].data;
    if (
      !object(data) ||
      canonical(data.runtimeScope) !== canonical(input.scope) ||
      !text(data.threadId) || !object(data.delivery) ||
      !text(data.delivery.id) ||
      !object(data.delivery.identity) ||
      !text(data.delivery.identity.operatorId)
    ) {
      throw new Error("Retirement job owner is unavailable");
    }
    const operatorId = data.delivery.identity.operatorId;
    const contributionId = data.delivery.id;
    const identity = data.delivery.identity;
    const delivery = data.delivery;
    const key = [
      input.scope.projectId,
      input.scope.systemId,
      input.scope.executionSpaceId,
      operatorId,
      data.threadId,
      contributionId,
    ] as const;
    owners.push({
      key,
      jobId: id,
      delivery,
      identity,
      digest: await executionDigest(delivery),
    });
  }
  owners.sort((a, b) =>
    canonical(a.key) < canonical(b.key)
      ? -1
      : canonical(a.key) > canonical(b.key)
      ? 1
      : 0
  );
  const keys = owners.map((owner) => canonical(owner.key));
  if (new Set(keys).size !== keys.length) {
    throw new Error("Retirement job owners collide");
  }
  for (const owner of owners) {
    const [
      projectId,
      systemId,
      executionSpaceId,
      operatorId,
      threadId,
      contributionId,
    ] = owner.key;
    const rows = await input.tx.$queryRaw<
      Array<{
        jobId: string | null;
        status: string;
        digest: string;
        payloadJson: string;
        originJson: string;
        identityJson: string;
      }>
    >(Prisma.sql`
      SELECT c."jobId",c."status",c."digest",c."payloadJson",c."originJson",e."identityJson"
      FROM ${postgresQualifiedTable(input.client, "ExecutionContribution")} c
      JOIN ${postgresQualifiedTable(input.client, "OperatorExecution")} e
      USING ("projectId","systemId","executionSpaceId","operatorId","threadId")
      WHERE c."projectId"=${projectId} AND c."systemId"=${systemId}
        AND c."executionSpaceId"=${executionSpaceId} AND c."operatorId"=${operatorId}
        AND c."threadId"=${threadId} AND c."contributionId"=${contributionId}
      FOR UPDATE OF c NOWAIT
    `);
    const row = rows[0];
    if (
      rows.length !== 1 || row.status !== "completed" ||
      row.jobId !== owner.jobId ||
      row.digest !== owner.digest ||
      row.payloadJson !== canonical(owner.delivery) ||
      row.originJson !== canonical({ delivery: owner.delivery }) ||
      row.identityJson !== canonical(owner.identity)
    ) {
      throw new Error(
        "The exact completed retirement job owner is unavailable",
      );
    }
  }
}
