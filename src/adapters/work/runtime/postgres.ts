/** Production composition of official PostgreSQL checkpoints and pg-boss.
 * The caller owns Prisma and all domain/business services. No Agent Server or
 * fixture handler is constructed here. Nothing starts during module imports. */
import { Pool } from "pg";
import { createHash } from "node:crypto";
import { fromPrisma, PgBoss } from "pg-boss";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { PrismaClient } from "../../out/postgres/client.ts";
import type { PostgresSystemScope } from "../../out/postgres/scope.ts";
import type { OperatorExecutionDelivery } from "../../../application/work/operators/execution.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import { NativeGraphExecution } from "./conversation.ts";
import {
  type PostgresExecutionLedgerOptions,
  PostgresNativeExecutionLedger,
  type PostgresSpaceEffectStartGuard,
} from "./postgres-ledger.ts";
import {
  OPERATOR_WORKERS,
  PostgresOperatorDispatch,
  type ResolvedOperatorScope,
} from "./operator-dispatch.ts";
import type { PostgresOperatorJob } from "./postgres-ledger.ts";
import {
  errorLogProperties,
  technicalLogger,
} from "../../../infrastructure/logging.ts";

const log = technicalLogger("scheduler");

export interface PostgresQueuePoolCounts {
  max: number;
  total: number;
  idle: number;
  waiting: number;
}
export interface PostgresQueueSqlCall {
  id: number;
  startedAt: string;
  sqlMd5: string;
  frames: string[];
  poolCountsAtStart: PostgresQueuePoolCounts | null;
}
export interface PostgresQueueSqlSnapshot {
  observedAt: string;
  /** Public calls include pool acquisition waits, not just checked-out clients. */
  inFlight: Array<PostgresQueueSqlCall & { elapsedMs: number }>;
  recent: Array<
    PostgresQueueSqlCall & {
      endedAt: string;
      durationMs: number;
      outcome: "fulfilled" | "rejected";
      poolCountsAtEnd: PostgresQueuePoolCounts | null;
    }
  >;
  untrackedInFlight: number;
}
export interface PostgresNativeRuntimeErrorMetadata {
  poolCounts: PostgresQueuePoolCounts | null;
  queueSql?: PostgresQueueSqlSnapshot;
}

function queuePoolCounts(boss: PgBoss): PostgresQueuePoolCounts | null {
  try {
    const counts = boss.getDb().poolCounts?.();
    if (
      counts &&
      [counts.max, counts.total, counts.idle, counts.waiting].every((value) =>
        Number.isSafeInteger(value) && value >= 0
      )
    ) {
      return {
        max: counts.max,
        total: counts.total,
        idle: counts.idle,
        waiting: counts.waiting,
      };
    }
  } catch { /* Diagnostics cannot change queue behavior. */ }
  return null;
}

/** Opt-in correlation at the public SQL seam. Never retains SQL or parameters. */
function observeQueueSql(boss: PgBoss): () => PostgresQueueSqlSnapshot {
  const db = boss.getDb(), executeSql = db.executeSql;
  const limit = 32;
  const inFlight = new Map<
    number,
    { call: PostgresQueueSqlCall; started: number }
  >();
  const recent: PostgresQueueSqlSnapshot["recent"] = [];
  let nextId = 0, untrackedInFlight = 0;
  const begin = (sql: string): number | undefined => {
    if (inFlight.size >= limit) {
      untrackedInFlight++;
      return undefined;
    }
    try {
      const stack = new Error().stack ?? "";
      const frames = [
        "Navigator.#onPoll",
        "ClaimTimer.#run",
        "Manager.touch",
        "Manager.fetch",
        "Manager.complete",
        "Manager.fail",
        ...["navigator", "manager", "boss", "bam", "index"].map((name) =>
          `pg-boss/dist/${name}.js`
        ),
      ].filter((frame) => stack.includes(frame)).slice(0, 6);
      const id = ++nextId;
      inFlight.set(id, {
        started: performance.now(),
        call: {
          id,
          startedAt: new Date().toISOString(),
          // MD5 is a server-query correlation key, never an integrity proof.
          sqlMd5: createHash("md5").update(sql).digest("hex"),
          frames,
          poolCountsAtStart: queuePoolCounts(boss),
        },
      });
      return id;
    } catch {
      untrackedInFlight++;
      return undefined;
    }
  };
  const end = (id: number | undefined, outcome: "fulfilled" | "rejected") => {
    if (id === undefined) {
      untrackedInFlight--;
      return;
    }
    const entry = inFlight.get(id);
    inFlight.delete(id);
    if (!entry) return;
    try {
      if (recent.length >= limit) recent.shift();
      recent.push({
        ...entry.call,
        endedAt: new Date().toISOString(),
        durationMs: Math.max(0, Math.round(performance.now() - entry.started)),
        outcome,
        poolCountsAtEnd: queuePoolCounts(boss),
      });
    } catch {
      /* Diagnostic bookkeeping never replaces a SQL result or error. */
    }
  };
  db.executeSql = function (
    this: typeof db,
    ...args: Parameters<typeof executeSql>
  ): ReturnType<typeof executeSql> {
    const id = begin(args[0]);
    let result: ReturnType<typeof executeSql>;
    try {
      // Reflect.apply also forwards optional runtime arguments beyond IDatabase.
      result = Reflect.apply(executeSql, this, args);
    } catch (error) {
      end(id, "rejected");
      throw error;
    }
    void result.then(() => end(id, "fulfilled"), () => end(id, "rejected"));
    return result;
  };
  return () => ({
    observedAt: new Date().toISOString(),
    inFlight: [...inFlight.values()].map(({ call, started }) => ({
      ...call,
      frames: [...call.frames],
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    })),
    recent: recent.map((call) => ({ ...call, frames: [...call.frames] })),
    untrackedInFlight,
  });
}

interface PostgresNativeRuntimeOptions {
  client: PrismaClient;
  /** Case guards are mandatory on the admitted-Request assembly below. */
  spaceEffectStart?: PostgresSpaceEffectStartGuard;
  acceptDeliveryInTransaction?:
    PostgresExecutionLedgerOptions["acceptDeliveryInTransaction"];
  scope: PostgresSystemScope & { executionSpaceId: string };
  /** Host-only connection material, never a queue/provider/domain payload. */
  connectionString: string;
  queueSchema: string;
  checkpointSchema: string;
  queueName?: string;
  /** Host-authenticated primary operator identity, never provided by a queue payload. */
  primaryOperatorId?: string;
  expireInSeconds?: number;
  heartbeatSeconds?: number;
  /** Scoped software host notification after native/canonical AND public queue
   * settlement. Synchronous scheduling only; not an execution authority port. */
  onRequestContributionSettled?: (
    delivery: OperatorExecutionDelivery,
    scope: ResolvedOperatorScope,
  ) => void;
  /** Host diagnostics only; disabled unless explicitly selected. */
  observeQueueSql?: boolean;
  onError?: (
    error: Error,
    metadata?: PostgresNativeRuntimeErrorMetadata,
  ) => void;
  initialAdmissionFault?: (
    phase:
      | "before-fork"
      | "after-fork"
      | "before-selection"
      | "after-selection",
  ) => void | Promise<void>;
  /** Host verifies durable Case/space binding. This is not execution admission. */
  resolveCaseSpace?: (
    executionSpaceId: string,
  ) => Promise<ResolvedOperatorScope | null>;
}

/** Explicitly initialized before use, started only after real runtime entrypoints
 * are available. The queue pool covers ordinary workers, Main and maintenance;
 * checkpoints and the caller's Prisma pool remain separately bounded. */
export async function createPostgresNativeRuntime(
  options: PostgresNativeRuntimeOptions,
) {
  const runtimeScope = {
    projectId: options.scope.projectId,
    systemId: options.scope.systemId,
    executionSpaceId: options.scope.executionSpaceId,
  };
  if (
    Object.values(runtimeScope).some((value) =>
      typeof value !== "string" || !value.trim() || value.includes("\0")
    )
  ) throw new Error("Invalid PostgreSQL native runtime scope");
  for (const schema of [options.queueSchema, options.checkpointSchema]) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
      throw new Error("Invalid framework PostgreSQL schema");
    }
  }
  if (new Set([options.queueSchema, options.checkpointSchema]).size !== 2) {
    throw new Error("Framework owners require separate PostgreSQL schemas");
  }
  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema: options.queueSchema,
    // Polling workers share the pool; one extra connection serves enqueue and supervision.
    max: OPERATOR_WORKERS.ordinary + OPERATOR_WORKERS.main + 1,
    connectionTimeoutMillis: 5_000,
    schedule: false,
    useListenNotify: false,
    superviseIntervalSeconds: 5,
    monitorIntervalSeconds: 5,
  });
  const queueSqlSnapshot = options.observeQueueSql === true
    ? observeQueueSql(boss)
    : undefined;
  const checkpointPool = new Pool({
    connectionString: options.connectionString,
    max: 2,
    connectionTimeoutMillis: 5_000,
  });
  const setupSaver = new PostgresSaver(checkpointPool, undefined, {
    schema: options.checkpointSchema,
  });
  const queueName = `${options.queueName ?? "assembly-operator"}-${
    (await executionDigest(runtimeScope)).slice(0, 24)
  }`;
  const ledger = new PostgresNativeExecutionLedger({
    client: options.client,
    lookupRetirementJob: (tx, id) =>
      boss.findJobs<PostgresOperatorJob>(queueName, {
        id,
        limit: 1,
        db: fromPrisma(tx),
      }),
    scope: runtimeScope,
    queueName,
    queueSchema: options.queueSchema,
    checkpointPool,
    checkpointSchema: options.checkpointSchema,
    ...(runtimeScope.executionSpaceId !== "main" && options.spaceEffectStart
      ? { spaceEffectStart: options.spaceEffectStart }
      : {}),
    ...(runtimeScope.executionSpaceId !== "main" &&
        options.acceptDeliveryInTransaction
      ? { acceptDeliveryInTransaction: options.acceptDeliveryInTransaction }
      : {}),
    ...(options.initialAdmissionFault
      ? { initialAdmissionFault: options.initialAdmissionFault }
      : {}),
  });
  const dispatch = new PostgresOperatorDispatch(ledger, boss, undefined, {
    primaryOperatorId: options.primaryOperatorId,
  });
  // Runtime always obtains its per-attempt fenced saver from ledger.open(). The
  // constructor's saver exists for official host setup; it is never a fallback.
  const execution = new NativeGraphExecution(undefined, ledger);
  const views = new Map<
    string,
    {
      ledger: PostgresNativeExecutionLedger;
      execution: NativeGraphExecution;
      dispatch: PostgresOperatorDispatch;
    }
  >();
  let closed = false;
  async function resolveCase(
    executionSpaceId: string,
    expectedCaseId?: string,
  ): Promise<ResolvedOperatorScope> {
    if (closed) {
      throw new Error("PostgreSQL native runtime is closing");
    }
    if (
      !executionSpaceId || executionSpaceId === runtimeScope.executionSpaceId ||
      executionSpaceId.includes("\0") || !options.resolveCaseSpace
    ) {
      throw new Error("Case execution space is unavailable");
    }
    const resolved = await options.resolveCaseSpace(executionSpaceId);
    if (closed) {
      throw new Error("PostgreSQL native runtime is closing");
    }
    if (
      !resolved || resolved.projectId !== runtimeScope.projectId ||
      resolved.systemId !== runtimeScope.systemId ||
      resolved.executionSpaceId !== executionSpaceId || !resolved.caseId ||
      (expectedCaseId !== undefined && resolved.caseId !== expectedCaseId)
    ) {
      throw new Error("Case execution space is unavailable");
    }
    return {
      projectId: resolved.projectId,
      systemId: resolved.systemId,
      executionSpaceId,
      caseId: resolved.caseId,
    };
  }
  function requireCaseIdentity(
    identity: OperatorExecutionDelivery["identity"],
    scope: ResolvedOperatorScope,
  ): void {
    if (
      !identity?.operatorId ||
      identity.scope?.kind !== "request" ||
      identity.scope.scopeId !== scope.caseId ||
      identity.scope.rootRequestId !== scope.caseId
    ) {
      throw new Error(
        "Operator identity does not belong to the resolved Case space",
      );
    }
  }
  function view(scope: ResolvedOperatorScope) {
    let found = views.get(scope.executionSpaceId);
    if (!found) {
      const scopedLedger = new PostgresNativeExecutionLedger({
        client: options.client,
        lookupRetirementJob: (tx, id) =>
          boss.findJobs<PostgresOperatorJob>(queueName, {
            id,
            limit: 1,
            db: fromPrisma(tx),
          }),
        scope: {
          projectId: scope.projectId,
          systemId: scope.systemId,
          executionSpaceId: scope.executionSpaceId,
        },
        queueName,
        queueSchema: options.queueSchema,
        checkpointPool,
        checkpointSchema: options.checkpointSchema,
        spaceEffectStart: options.spaceEffectStart,
        acceptDeliveryInTransaction: options.acceptDeliveryInTransaction,
        ...(options.initialAdmissionFault
          ? { initialAdmissionFault: options.initialAdmissionFault }
          : {}),
      });
      found = {
        ledger: scopedLedger,
        execution: new NativeGraphExecution(undefined, scopedLedger),
        dispatch: new PostgresOperatorDispatch(
          scopedLedger,
          boss,
          dispatch.shared,
        ),
      };
      views.set(scope.executionSpaceId, found);
    }
    return found;
  }
  async function resolveJob(job: PostgresOperatorJob) {
    const scope = job?.runtimeScope;
    if (
      !scope || scope.projectId !== runtimeScope.projectId ||
      scope.systemId !== runtimeScope.systemId ||
      typeof scope.executionSpaceId !== "string" || !scope.executionSpaceId
    ) throw new Error("Invalid operator delivery claim scope");
    if (scope.executionSpaceId === runtimeScope.executionSpaceId) {
      return { ledger, scope: runtimeScope };
    }
    const resolved = await resolveCase(scope.executionSpaceId);
    requireCaseIdentity(job.delivery?.identity, resolved);
    return { ledger: view(resolved).ledger, scope: resolved };
  }
  const stop = async (shutdown: { drainTimeoutMs?: number } = {}) => {
    if (closed) return;
    closed = true;
    dispatch.stopAccepting();
    // Abort claims before closing pools; late writes fail their durable fences.
    const failures: unknown[] = [];
    try {
      await boss.stop({ graceful: false });
    } catch (error) {
      failures.push(error);
    }
    try {
      await dispatch.drain(shutdown.drainTimeoutMs ?? 10_000);
    } catch (error) {
      failures.push(error);
    }
    const results = await Promise.allSettled([checkpointPool.end()]);
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        "PostgreSQL native runtime did not close cleanly",
      );
    }
  };
  boss.on("error", (error) => {
    if (options.onError) {
      const metadata: PostgresNativeRuntimeErrorMetadata = {
        poolCounts: queuePoolCounts(boss),
      };
      try {
        if (queueSqlSnapshot) metadata.queueSql = queueSqlSnapshot();
      } catch {
        /* Preserve the original scheduler error if diagnostics fail. */
      }
      options.onError(error, metadata);
    } else log.error("Operator queue:", errorLogProperties(error));
  });
  try {
    await boss.start();
    await dispatch.setup({
      expireInSeconds: options.expireInSeconds,
      heartbeatSeconds: options.heartbeatSeconds,
    });
    await setupSaver.setup();
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
  return {
    execution,
    dispatch,
    ledger,
    assertCommandOrigin: (
      origin: Parameters<
        PostgresNativeExecutionLedger["assertCommandOrigin"]
      >[0],
    ) => ledger.assertCommandOrigin(origin),
    assertArtifactSourceOrigin: (
      publication: Parameters<
        PostgresNativeExecutionLedger["assertArtifactSourceOrigin"]
      >[0],
    ) => ledger.assertArtifactSourceOrigin(publication),
    /** Scoped views have no worker, pool, or shutdown lifecycle of their own. */
    forCaseSpace: async (executionSpaceId: string, caseId: string) => {
      const resolved = await resolveCase(executionSpaceId, caseId);
      const scoped = view(resolved);
      const check = async () => await resolveCase(executionSpaceId, caseId);
      return {
        scope: resolved,
        /** Same scoped ledger, no pool/worker/lifecycle ownership. Atomic Request
         * composition uses only its caller-transaction helpers. */
        ledger: scoped.ledger,
        execution: scoped.execution,
        assertCommandOrigin: async (
          ...args: Parameters<
            PostgresNativeExecutionLedger["assertCommandOrigin"]
          >
        ) => {
          await check();
          return await scoped.ledger.assertCommandOrigin(...args);
        },
        assertArtifactSourceOrigin: async (
          ...args: Parameters<
            PostgresNativeExecutionLedger["assertArtifactSourceOrigin"]
          >
        ) => {
          await check();
          return await scoped.ledger.assertArtifactSourceOrigin(...args);
        },
        dispatch: {
          enqueue: async (delivery: OperatorExecutionDelivery) => {
            requireCaseIdentity(delivery?.identity, await check());
            return await scoped.dispatch.enqueue(delivery);
          },
          inspect: async (
            ...args: Parameters<PostgresOperatorDispatch["inspect"]>
          ) => {
            requireCaseIdentity(args[0], await check());
            return await scoped.dispatch.inspect(...args);
          },
          inspectAccepted: async (
            ...args: Parameters<PostgresOperatorDispatch["inspectAccepted"]>
          ) => {
            await check();
            return await scoped.dispatch.inspectAccepted(...args);
          },
          inspectTerminalAccepted: async (
            ...args: Parameters<
              PostgresOperatorDispatch["inspectTerminalAccepted"]
            >
          ) => {
            await check();
            return await scoped.dispatch.inspectTerminalAccepted(...args);
          },
          assertSourceEffect: async (
            ...args: Parameters<PostgresOperatorDispatch["assertSourceEffect"]>
          ) => {
            await check();
            return await scoped.dispatch.assertSourceEffect(...args);
          },
        },
      };
    },
    start: async (
      handler: (
        delivery: OperatorExecutionDelivery,
        scope?: ResolvedOperatorScope,
      ) => Promise<void>,
    ) => {
      if (closed) throw new Error("PostgreSQL native runtime is closed");
      await dispatch.start(
        handler,
        resolveJob,
        options.onRequestContributionSettled
          ? (delivery, scope) => {
            try {
              options.onRequestContributionSettled!(delivery, scope);
            } catch (error) {
              // Completion is already durable. A failed observer cannot turn it
              // into failed business work; cold dossier recovery remains valid.
              const failure = error instanceof Error
                ? error
                : new Error(String(error));
              try {
                if (options.onError) {
                  options.onError(failure, {
                    poolCounts: queuePoolCounts(boss),
                  });
                } else {log.error(
                    "Request settlement notification failed",
                    errorLogProperties(failure),
                  );}
              } catch { /* Diagnostic sinks cannot undo settled work. */ }
            }
          }
          : undefined,
      );
    },
    stopAccepting: () => dispatch.stopAccepting(),
    drain: (timeoutMs?: number) => dispatch.drain(timeoutMs),
    stop,
  };
}

/** Required assembly for future real Request factories. The base constructor
 * remains the shared transport/native facility; a scoped view alone grants no
 * CAP-3 authority. No product mode or permissive admission is synthesized. */
export interface PostgresAdmittedRequestRuntimeOptions
  extends PostgresNativeRuntimeOptions {
  resolveCaseSpace: NonNullable<
    PostgresNativeRuntimeOptions["resolveCaseSpace"]
  >;
  spaceEffectStart: PostgresSpaceEffectStartGuard;
  acceptDeliveryInTransaction: NonNullable<
    PostgresExecutionLedgerOptions["acceptDeliveryInTransaction"]
  >;
}
const admittedRequestRuntime = Symbol("admitted-request-runtime");
/** Future Request factories require this type, not the transport-only facility. */
export type PostgresAdmittedRequestRuntime =
  & Awaited<ReturnType<typeof createPostgresNativeRuntime>>
  & {
    readonly [admittedRequestRuntime]: true;
  };
export async function createPostgresAdmittedRequestRuntime(
  options: PostgresAdmittedRequestRuntimeOptions,
): Promise<PostgresAdmittedRequestRuntime> {
  if (
    typeof options.resolveCaseSpace !== "function" ||
    typeof options.spaceEffectStart !== "function" ||
    typeof options.acceptDeliveryInTransaction !== "function" ||
    options.scope.executionSpaceId !== "main"
  ) {
    throw new Error(
      "Admitted Request assembly requires host scope resolution and effect-start authority",
    );
  }
  return Object.assign(await createPostgresNativeRuntime(options), {
    [admittedRequestRuntime]: true as const,
  });
}
