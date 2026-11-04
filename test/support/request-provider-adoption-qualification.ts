/** Controlled interleaving only: real current-resource service, Request execution
 * reader, controls and PostgreSQL aggregate remain the source of every fact. */
import { CurrentProviderResources } from "../../src/application/telemetry/current-provider-resources.ts";
import { PostgresProviderResourceReader } from "../../src/adapters/out/postgres/provider-resource-reader.ts";
import type { PrismaClient } from "../../src/adapters/out/postgres/client.ts";
import type { ProviderCallHostScope } from "../../src/application/telemetry/provider-call.ts";
import type { RequestCaseExecutionReader } from "../../src/application/work/request-spaces/conversations.ts";
import type { SpaceControlPort } from "../../src/application/work/request-spaces/ports.ts";
import type { ClockPort } from "../../src/application/work/runtime/ports.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, release: resolve };
}
async function bounded<T>(
  promise: Promise<T>,
  milliseconds = 60_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Provider qualification gate timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
export function startPausedCurrentRead(options: {
  client: PrismaClient;
  scope: ProviderCallHostScope;
  cases: RequestCaseExecutionReader;
  control: SpaceControlPort;
  secret: string;
  caseId: string;
  expectedVersion: string;
  clock: ClockPort;
}) {
  const reader = new PostgresProviderResourceReader(options.client);
  const entered = gate(), proceed = gate();
  const stats = {
    readerCalls: 0,
    observedCalls: null as number | null,
    executionCalls: 0,
    authenticateCalls: 0,
    revalidateCalls: 0,
  };
  const service = new CurrentProviderResources({
    scope: options.scope,
    mainExecutionSpaceId: "main",
    main: () => null,
    cases: {
      requestKpis: (secret, caseId) =>
        options.cases.requestKpis(secret, caseId),
      execution(secret, caseId) {
        stats.executionCalls++;
        return options.cases.execution(secret, caseId);
      },
    },
    control: {
      authenticateSession(secret) {
        stats.authenticateCalls++;
        return options.control.authenticateSession(secret);
      },
      revalidate(controller) {
        stats.revalidateCalls++;
        return options.control.revalidate(controller);
      },
    },
    reader: {
      async read(query) {
        stats.readerCalls++;
        if (stats.readerCalls !== 1) {
          throw new Error("Unexpected provider aggregate retry");
        }
        const aggregate = await reader.read(query);
        stats.observedCalls = aggregate.calls;
        entered.release();
        await bounded(proceed.promise);
        return aggregate;
      },
    },
    clock: options.clock,
  });
  const result = service.read(options.secret, {
    caseId: options.caseId,
    expectedVersion: options.expectedVersion,
  });
  // Mark rejection handled immediately while preserving its original value to caller.
  const settled = result.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
  const aggregated = bounded(Promise.race([
    entered.promise,
    settled.then((outcome) => {
      if (outcome.status === "rejected") throw outcome.reason;
      throw new Error("Read finished before pause");
    }),
  ]));
  // The gate itself may reject before its consumer awaits it.
  void aggregated.catch(() => {});
  return {
    aggregated,
    release: proceed.release,
    result,
    stats,
    async settle() {
      proceed.release();
      return await bounded(settled);
    },
  };
}
