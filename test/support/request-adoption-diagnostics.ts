/** Test-only observation of the real client's transactions. No SQL callback,
 * error, receipt or result is replaced; private database errors stay in owned
 * qualification diagnostics instead of the public HTTP contract. */
import assert from "node:assert/strict";
import {
  postgresQualifiedTable,
  Prisma,
  type PrismaClient,
} from "../../src/adapters/out/postgres/client.ts";
import type { PostgresRuntimeScope } from "../../src/adapters/out/postgres/scope.ts";
import type { RequestAdoptionStatus } from "../../src/application/model/evolution/request-adoption-ports.ts";
import type { PostgresNativeExecutionLedger } from "../../src/adapters/out/native-execution/postgres-ledger.ts";
import type { RequestSpaceRuntime } from "../../src/application/work/request-spaces/runtime.ts";

/** Read only the owned fixture's exact named ref, never a mutable HEAD default. */
export async function readOwnedAdoptionRef(
  projectDir: string,
  ref: string,
): Promise<string> {
  const output = await new Deno.Command("git", {
    args: ["--git-dir", `${projectDir}/.git`, "rev-parse", "--verify", ref],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(output.success, `Missing exact owned witness ref ${ref}`);
  return `commit:${new TextDecoder().decode(output.stdout).trim()}`;
}

export function observeAdoptionTransactions(client: PrismaClient) {
  const original = client.$transaction;
  let sequence = 0;
  const failures: Array<{ sequence: number; error: string }> = [];
  const capture = async <T>(
    label: string,
    action: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      let metadata = "";
      try {
        metadata = JSON.stringify(
          error && typeof error === "object" && "meta" in error
            ? error.meta
            : undefined,
          (_key, value) => typeof value === "bigint" ? String(value) : value,
        ) ?? "";
      } catch { /* The original error remains observable. */ }
      failures.push({
        sequence: ++sequence,
        error: `${label}: ${
          error instanceof Error ? error.stack ?? String(error) : String(error)
        } ${metadata}`.slice(0, 8192),
      });
      if (failures.length > 128) failures.shift();
      throw error;
    }
  };
  client.$transaction = ((...args: unknown[]) =>
    capture(
      "actual client transaction",
      () => Reflect.apply(original, client, args),
    )) as typeof original;
  return {
    capture,
    checkpoint: () => sequence,
    since: (after: number) =>
      failures.filter((entry) => entry.sequence > after),
    restore() {
      client.$transaction = original;
    },
    async report<T>(label: string, action: () => Promise<T>): Promise<T> {
      const before = sequence;
      try {
        return await action();
      } catch (error) {
        throw new Error(
          `${label}: ${String(error)}\nActual transaction failures: ${
            JSON.stringify(
              failures.filter((entry) => entry.sequence > before),
            )
          }`,
          { cause: error },
        );
      }
    },
  };
}

export function observeAdoptionRuntimeReservation(
  runtime: RequestSpaceRuntime,
  diagnostics: ReturnType<typeof observeAdoptionTransactions>,
): () => void {
  const original = runtime.withInstructionAdoptionReservation;
  runtime.withInstructionAdoptionReservation =
    ((...args: unknown[]) =>
      diagnostics.capture(
        "actual runtime withInstructionAdoptionReservation",
        () => Reflect.apply(original, runtime, args),
      )) as typeof original;
  return () => {
    runtime.withInstructionAdoptionReservation = original;
  };
}

export function observeAdoptionNativeBoundary(
  ledger: PostgresNativeExecutionLedger,
  diagnostics: ReturnType<typeof observeAdoptionTransactions>,
): () => void {
  const methods = ledger as unknown as Record<string, unknown>;
  const originals = [
    "prepareRetirementBatch",
    "lockRetirementInTransaction",
    "assertRetirementPreparedLocked",
    "retirePreparedLocked",
  ].map((name) => ({ name, method: methods[name] }));
  for (const { name, method } of originals) {
    assert.equal(typeof method, "function");
    methods[name] = (...args: unknown[]) =>
      diagnostics.capture(
        `actual native ${name}`,
        () =>
          Reflect.apply(
            method as (...args: unknown[]) => Promise<unknown>,
            ledger,
            args,
          ),
      );
  }
  return () => {
    for (const { name, method } of originals) methods[name] = method;
  };
}

export async function actualRequestWorkPending(
  client: PrismaClient,
  scope: PostgresRuntimeScope,
  queue: { queueSchema?: string; queueName: string },
  runtimeBusy: boolean,
): Promise<boolean> {
  if (runtimeBusy) return true;
  if (
    !queue.queueSchema || !/^[a-z_][a-z0-9_]{0,62}$/.test(queue.queueSchema)
  ) {
    throw new Error("Owned fixture queue schema is unavailable");
  }
  const pending = await client.executionContribution.count({
    where: { ...scope, status: { in: ["queued", "running"] } },
  });
  if (pending) return true;
  const jobs = Prisma.raw(`"${queue.queueSchema}".job`);
  const active = await client.$queryRaw<Array<{ active: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM ${jobs} j JOIN ${
    postgresQualifiedTable(client, "ExecutionContribution")
  } c
        ON j.id::text=c."jobId"
      WHERE c."projectId"=${scope.projectId} AND c."systemId"=${scope.systemId}
        AND c."executionSpaceId"=${scope.executionSpaceId} AND c."operatorId"=${scope.operatorId}
        AND j.name=${queue.queueName} AND j.state='active'
    ) AS active`);
  return active[0]?.active === true;
}

/** Only the known adoption wrapper and an exact expired-query cause qualify.
 * A COMMIT error, unknown wrapper, cyclic/deep chain or incomplete metadata
 * proves nothing about a safe precommit retry. */
function expiredAdoptionQuery(input: unknown):
  | { timeoutMs: number; timeTakenMs: number }
  | undefined {
  const seen = new Set<object>();
  let current = input;
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== "object" || seen.has(current)) {
      return undefined;
    }
    seen.add(current);
    const error = current as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      meta?: unknown;
      cause?: unknown;
    };
    if (
      error.name === "RequestAdoptionError" && error.code === "BLOCKED" &&
      error.message ===
        "The original adoption remains armed or unknown. Inspect or resume the same key." &&
      error.cause !== undefined
    ) {
      current = error.cause;
      continue;
    }
    if (
      error.name !== "PrismaClientKnownRequestError" ||
      error.code !== "P2028" ||
      error.cause !== undefined || typeof error.message !== "string" ||
      !error.meta || typeof error.meta !== "object" || Array.isArray(error.meta)
    ) return undefined;
    const meta = error.meta as Record<string, unknown>;
    const timeout = meta.timeout, timeTaken = meta.timeTaken;
    if (
      meta.operation !== "query" || typeof timeout !== "number" ||
      typeof timeTaken !== "number" || !Number.isSafeInteger(timeout) ||
      !Number.isSafeInteger(timeTaken) || timeout <= 0 || timeTaken < timeout
    ) return undefined;
    const expected =
      "Transaction API error: A query cannot be executed on an expired transaction. " +
      `The timeout for this transaction was ${timeout} ms, however ${timeTaken} ms passed since the start of the transaction. ` +
      "Consider increasing the interactive transaction timeout or doing less work in the transaction.";
    const message = error.message.trim().replace(
      /^Invalid `prisma\.\$(?:queryRaw|executeRaw)(?:Unsafe)?\(\)` invocation:\n\n\n/,
      "",
    );
    if (message !== expected) return undefined;
    return { timeoutMs: timeout, timeTakenMs: timeTaken };
  }
  return undefined;
}

/** A prepared return is never evidence that the injected final fault occurred.
 * Retry the original key only for observed work/short locks or the exact local
 * expired-query case below. Unknown/COMMIT errors fail with their cause. */
export async function expectActualAdoptionPrecommitFault(input: {
  prepare(): Promise<RequestAdoptionStatus>;
  resume(): Promise<RequestAdoptionStatus>;
  transientBoundary(): Promise<boolean>;
  diagnostics: ReturnType<typeof observeAdoptionTransactions>;
  faultMessage: string;
  label: string;
}): Promise<void> {
  const end = Date.now() + 30_000;
  let action = input.prepare;
  const observations: unknown[] = [];
  const assertDeadline = () =>
    assert(
      Date.now() < end,
      `${input.label} did not reach injected fault: ${
        JSON.stringify(observations)
      }`,
    );
  for (;;) {
    assertDeadline();
    const before = input.diagnostics.checkpoint();
    let returned: RequestAdoptionStatus | undefined;
    let rejection: unknown;
    try {
      returned = await action();
    } catch (error) {
      rejection = error;
    }
    const failures = input.diagnostics.since(before);
    observations.push({
      returned,
      rejection: rejection && String(rejection),
      failures,
    });
    const expiredQuery = rejection
      ? expiredAdoptionQuery(rejection)
      : undefined;
    if (rejection) {
      if (failures.some((entry) => entry.error.includes(input.faultMessage))) {
        assertDeadline();
        return;
      }
      assert(
        expiredQuery,
        `${input.label} rejected before the required injected fault: ${
          JSON.stringify(observations)
        }`,
      );
      console.info(
        `${input.label}: expired transaction query; same-key resume`,
        {
          attempt: observations.length,
          ...expiredQuery,
        },
      );
    } else {
      console.info(`${input.label} returned ${JSON.stringify(returned)}`);
      assert.equal(
        returned?.status,
        "prepared",
        `${input.label} must reject at the real fault, not return success: ${
          JSON.stringify(observations)
        }`,
      );
      assert(returned);
      assert(returned.blockers.length > 0, JSON.stringify(observations));
    }
    const transientLock = failures.some((entry) =>
      /55P03|lock timeout|could not obtain lock|Live native claim blocks retirement|Prepared native dependencies changed|Native retirement (membership|dependency).*changed/
        .test(entry.error)
    );
    assert(
      expiredQuery || transientLock || await input.transientBoundary(),
      `${input.label} has no proved transient boundary: ${
        JSON.stringify(observations)
      }`,
    );
    assertDeadline();
    await new Promise((resolve) => setTimeout(resolve, 50));
    action = input.resume;
  }
}

/** Successful completion still requires the actual adopted receipt. Explicit
 * same-key retries are restricted to observed work/short-lock boundaries. */
export async function completeActualAdoption(input: {
  start(): Promise<RequestAdoptionStatus>;
  resume(): Promise<RequestAdoptionStatus>;
  transientBoundary(): Promise<boolean>;
  diagnostics: ReturnType<typeof observeAdoptionTransactions>;
  label: string;
}): Promise<RequestAdoptionStatus> {
  const end = Date.now() + 30_000;
  let action = input.start;
  const observations: unknown[] = [];
  for (;;) {
    const before = input.diagnostics.checkpoint();
    let returned: RequestAdoptionStatus | undefined;
    let rejection: unknown;
    try {
      returned = await action();
    } catch (error) {
      rejection = error;
    }
    const failures = input.diagnostics.since(before);
    observations.push({
      returned,
      rejection: rejection && String(rejection),
      failures,
    });
    if (returned?.status === "adopted") {
      assert(returned.receipt, JSON.stringify(observations));
      return returned;
    }
    console.info(
      `${input.label} returned ${JSON.stringify(returned)} ${
        String(rejection ?? "")
      }`,
    );
    const transientLock = failures.some((entry) =>
      /55P03|lock timeout|could not obtain lock|Live native claim blocks retirement|Prepared native dependencies changed|Native retirement (membership|dependency).*changed/
        .test(entry.error)
    );
    assert(
      !rejection || transientLock,
      `${input.label}: ${JSON.stringify(observations)}`,
    );
    assert(
      !returned ||
        returned.status === "prepared" && returned.blockers.length > 0,
      JSON.stringify(observations),
    );
    assert(
      transientLock || await input.transientBoundary(),
      `${input.label} has no proved transient boundary: ${
        JSON.stringify(observations)
      }`,
    );
    assert(
      Date.now() < end,
      `${input.label} did not complete: ${JSON.stringify(observations)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    action = input.resume;
  }
}
