/** pg-boss is the delivery queue. Contribution rows are immutable business
 * acceptance receipts, never a second claim/retry/lease implementation. */
import { fromPrisma, type PgBoss, type WorkHandler } from "pg-boss";
import type {
  OperatorDeliveryReceipt,
  OperatorExecutionCommandOrigin,
  OperatorExecutionDelivery,
  OperatorExecutionDispatchPort,
} from "../../../application/work/operators/execution.ts";
import type { NativeExecutionIdentity } from "../../../application/work/runtime/execution.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import { MAX_ACTIVE_AGENTS } from "../../../domain/work/records/conversations.ts";
import { assertNoOpenImmutableConsultationGroups } from "./immutable-consultation-ledger.ts";
import { terminalAcceptedTransport } from "../../../application/work/operators/operator-dispatch-terminal.ts";
import {
  PostgresNativeExecutionLedger,
  type PostgresOperatorJob,
} from "./postgres-ledger.ts";
import {
  currentPostgresExecutionTransaction,
  withPostgresExecutionTransaction,
} from "../../out/postgres/execution-transaction.ts";

export const OPERATOR_WORKERS = {
  main: 1,
  ordinary: MAX_ACTIVE_AGENTS,
} as const;

interface SharedOperatorDispatchState {
  accepting: boolean;
  handlers: Set<Promise<unknown>>;
  primaryOperatorId?: string;
}
export interface ResolvedOperatorScope {
  projectId: string;
  systemId: string;
  executionSpaceId: string;
  caseId?: string;
}
export class PostgresOperatorDispatch implements OperatorExecutionDispatchPort {
  #started = false;
  readonly shared: SharedOperatorDispatchState;
  constructor(
    readonly ledger: PostgresNativeExecutionLedger,
    readonly boss: PgBoss,
    shared?: SharedOperatorDispatchState,
    options: { primaryOperatorId?: string } = {},
  ) {
    this.shared = shared ?? {
      accepting: true,
      handlers: new Set(),
      primaryOperatorId: options.primaryOperatorId,
    };
  }
  #priority(scope: ResolvedOperatorScope, delivery: OperatorExecutionDelivery) {
    return scope.executionSpaceId === "main" &&
        delivery.identity.operatorId === this.shared.primaryOperatorId
      ? 1
      : 0;
  }
  async setup(
    options: { expireInSeconds?: number; heartbeatSeconds?: number } = {},
  ) {
    await this.boss.createQueue(this.ledger.options.queueName, {
      policy: "key_strict_fifo",
      retryLimit: 3,
      retryDelay: 1,
      expireInSeconds: options.expireInSeconds ?? 900,
      heartbeatSeconds: options.heartbeatSeconds ?? 30,
    });
  }
  async enqueue(
    delivery: OperatorExecutionDelivery,
  ): Promise<OperatorDeliveryReceipt> {
    if (
      !delivery.id?.trim() || !delivery.identity?.operatorId ||
      !delivery.identity.invocationKey || !delivery.modelPin.modelDigest ||
      !["contribution", "continuation", "notification", "command", "schedule"]
        .includes(delivery.kind)
    ) throw new Error("Incomplete authenticated operator delivery");
    if (
      !["request", "designer"].includes(delivery.identity.scope.kind) ||
      !delivery.identity.scope.scopeId ||
      !["conversation", "promotion"].includes(delivery.identity.purpose) ||
      delivery.identity.purpose === "promotion" && !delivery.identity.subjectId
    ) throw new Error("Invalid native execution identity");
    if (
      delivery.identity.scope.kind === "request"
        ? !delivery.identity.scope.rootRequestId
        : !delivery.identity.scope.ownerId
    ) {
      throw new Error(
        "Operator delivery requires an explicit authenticated conversation scope",
      );
    }
    const context = currentPostgresExecutionTransaction();
    if (!context?.transaction) {
      return await this.ledger.client.$transaction(async (transaction) =>
        await withPostgresExecutionTransaction({
          client: this.ledger.client,
          transaction,
          ...(context?.fence ? { fence: context.fence } : {}),
        }, () => this.enqueue(delivery))
      );
    }
    if (context.client !== this.ledger.client) {
      throw new Error("Operator enqueue transaction client mismatch");
    }
    const query = fromPrisma(context.transaction).executeSql;
    await context.fence?.(query);
    const scope = this.ledger.scope(delivery.identity);
    const scopeValues = [
      scope.projectId,
      scope.systemId,
      scope.executionSpaceId,
      scope.operatorId,
    ];
    const digest = await executionDigest(delivery),
      identityJson = canonical(delivery.identity),
      payload = canonical(delivery);
    const previous = (await query(
      `SELECT c."digest",c."jobId",c."status",c."threadId" FROM ${
        this.ledger.table("ExecutionContribution")
      } c JOIN ${
        this.ledger.table("OperatorExecution")
      } e USING ("projectId","systemId","executionSpaceId","operatorId","threadId") WHERE c."projectId"=$1 AND c."systemId"=$2 AND c."executionSpaceId"=$3 AND c."operatorId"=$4 AND e."identityJson"=$5 AND c."contributionId"=$6`,
      [...scopeValues, identityJson, delivery.id],
    )).rows[0];
    if (previous) {
      if (previous.digest !== digest || !previous.jobId) {
        throw new Error(
          "Operator contribution ID has different accepted content",
        );
      }
      return {
        id: delivery.id,
        threadId: String(previous.threadId),
        jobId: String(previous.jobId),
        status: previous.status as OperatorDeliveryReceipt["status"],
      };
    }
    const { threadId, row: thread } = await this.ledger.resolveThread(
      query,
      delivery.identity,
      delivery.modelPin,
    );
    const values = [...scopeValues, threadId];
    let selectedModelPin: OperatorExecutionDelivery["modelPin"] | undefined;
    if (thread.currentRunId) {
      const selected = (await query(
        `SELECT "pinJson" FROM ${
          this.ledger.table("ExecutionRun")
        } WHERE "projectId"=$1 AND "systemId"=$2 AND "executionSpaceId"=$3 AND "operatorId"=$4 AND "threadId"=$5 AND "runId"=$6`,
        [...values, thread.currentRunId],
      )).rows[0];
      if (typeof selected?.pinJson === "string") {
        const pin = JSON.parse(selected.pinJson);
        selectedModelPin = {
          modelDigest: pin.version.digest,
          repositoryVersion: pin.version.repositoryVersion,
        };
      }
    } else if (typeof thread.authorizedPinJson === "string") {
      selectedModelPin = JSON.parse(thread.authorizedPinJson);
    }
    // Recheck after acquiring the binding/thread lock: concurrent retries of one
    // accepted input must still create one canonical receipt and one queue job.
    const raced = (await query(
      `SELECT c."digest",c."jobId",c."status",c."threadId" FROM ${
        this.ledger.table("ExecutionContribution")
      } c JOIN ${
        this.ledger.table("OperatorExecution")
      } e USING ("projectId","systemId","executionSpaceId","operatorId","threadId") WHERE c."projectId"=$1 AND c."systemId"=$2 AND c."executionSpaceId"=$3 AND c."operatorId"=$4 AND e."identityJson"=$5 AND c."contributionId"=$6`,
      [...scopeValues, identityJson, delivery.id],
    )).rows[0];
    if (raced) {
      if (raced.digest !== digest || !raced.jobId) {
        throw new Error(
          "Operator contribution ID has different accepted content",
        );
      }
      return {
        id: delivery.id,
        threadId: String(raced.threadId),
        jobId: String(raced.jobId),
        status: raced.status as OperatorDeliveryReceipt["status"],
      };
    }
    if (!this.shared.accepting) {
      throw new Error("Operator delivery acceptance is stopping");
    }
    if (
      !selectedModelPin ||
      canonical(selectedModelPin) !== canonical(delivery.modelPin)
    ) {
      throw new Error(
        "Operator delivery does not match the selected authorized execution pin",
      );
    }
    // Exact receipt replay precedes fresh admission. Acquire current control and
    // admission before the parent, in the final transition's same lock order.
    if (
      scope.executionSpaceId !== "main" &&
      !this.ledger.options.acceptDeliveryInTransaction
    ) {
      throw new Error(
        "Request delivery acceptance requires current execution admission",
      );
    }
    const acceptance = {
      identity: delivery.identity,
      scope,
      modelPin: delivery.modelPin,
    };
    await this.ledger.options.acceptDeliveryInTransaction?.(
      context.transaction,
      { ...acceptance, phase: "before-share" },
    );
    // SHARE excludes adoption's non-key UPDATE even for a new subject binding.
    const parents = await query(
      `SELECT "operatorId" FROM ${this.ledger.table("OperatorRuntime")}
       WHERE "projectId"=$1 AND "systemId"=$2 AND "executionSpaceId"=$3 AND "operatorId"=$4 FOR SHARE`,
      scopeValues,
    );
    if (parents.rows.length !== 1) {
      throw new Error("Operator runtime scope is unavailable");
    }
    // Re-read the nonlocking barrier while holding SHARE. The callback must
    // revalidate only the same already-locked control/admission identities.
    await this.ledger.options.acceptDeliveryInTransaction?.(
      context.transaction,
      { ...acceptance, phase: "after-share" },
    );
    const jobId = crypto.randomUUID();
    // The persistent SystemRuntime owns mutable business state. Serialize its
    // deliveries across conversation threads; parked native waits release it.
    const singletonKey = await executionDigest(scope);
    const payloadEnvelope: PostgresOperatorJob = {
      runtimeScope: this.ledger.options.scope,
      threadId,
      delivery,
    };
    const sent = await this.boss.send(
      this.ledger.options.queueName,
      payloadEnvelope,
      {
        id: jobId,
        singletonKey,
        priority: this.#priority(scope, delivery),
        db: fromPrisma(context.transaction),
      },
    );
    if (sent !== jobId) {
      throw new Error("Operator contribution was not enqueued");
    }
    await query(
      `INSERT INTO ${
        this.ledger.table("ExecutionContribution")
      } ("projectId","systemId","executionSpaceId","operatorId","threadId","contributionId","digest","kind","originJson","payloadJson","jobId","status","acceptedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',clock_timestamp())`,
      [
        ...values,
        delivery.id,
        digest,
        delivery.kind,
        canonical({ delivery }),
        payload,
        jobId,
      ],
    );
    await context.fence?.(query);
    return { id: delivery.id, threadId, jobId, status: "queued" };
  }
  async inspect(
    identity: NativeExecutionIdentity,
    contributionId: string,
  ): Promise<OperatorDeliveryReceipt | null> {
    const scope = this.ledger.scope(identity);
    const rows = await this.ledger.client.$queryRawUnsafe<
      {
        threadId: string;
        jobId: string;
        status: OperatorDeliveryReceipt["status"];
      }[]
    >(
      `SELECT c."threadId",c."jobId",c."status" FROM ${
        this.ledger.table("ExecutionContribution")
      } c JOIN ${
        this.ledger.table("OperatorExecution")
      } e USING ("projectId","systemId","executionSpaceId","operatorId","threadId") WHERE c."projectId"=$1 AND c."systemId"=$2 AND c."executionSpaceId"=$3 AND c."operatorId"=$4 AND e."identityJson"=$5 AND c."contributionId"=$6`,
      scope.projectId,
      scope.systemId,
      scope.executionSpaceId,
      scope.operatorId,
      canonical(identity),
      contributionId,
    );
    return rows[0]
      ? {
        id: contributionId,
        threadId: rows[0].threadId,
        jobId: rows[0].jobId,
        status: rows[0].status,
      }
      : null;
  }
  async start(
    handler: (
      delivery: OperatorExecutionDelivery,
      scope?: ResolvedOperatorScope,
    ) => Promise<void>,
    resolve?: (
      job: PostgresOperatorJob,
    ) => Promise<
      { ledger: PostgresNativeExecutionLedger; scope: ResolvedOperatorScope }
    >,
    requestSettled?: (
      delivery: OperatorExecutionDelivery,
      scope: ResolvedOperatorScope,
    ) => void,
  ) {
    if (this.#started) throw new Error("Operator workers already started");
    this.#started = true;
    const handle: WorkHandler<PostgresOperatorJob> = async ([job]) => {
      const running = (async () => {
        job.signal.throwIfAborted();
        const resolved = resolve
          ? await resolve(job.data)
          : { ledger: this.ledger, scope: this.ledger.options.scope };
        job.signal.throwIfAborted();
        const ledger = resolved.ledger;
        await ledger.withClaim(job, async () => {
          job.signal.throwIfAborted();
          const delivery = job.data.delivery;
          const scope = ledger.scope(delivery.identity),
            threadId = job.data.threadId;
          const keys = [
            scope.projectId,
            scope.systemId,
            scope.executionSpaceId,
            scope.operatorId,
            threadId,
            delivery.id,
          ];
          const where =
            `"projectId"=$1 AND "systemId"=$2 AND "executionSpaceId"=$3 AND "operatorId"=$4 AND "threadId"=$5 AND "contributionId"=$6`;
          const alreadyCompleted = await ledger.client.$transaction(
            async (tx) => {
              const query = fromPrisma(tx).executeSql;
              await ledger.lockClaim(query, job);
              const row = (await query(
                `SELECT "digest","jobId","status" FROM ${
                  ledger.table("ExecutionContribution")
                } WHERE ${where} FOR UPDATE`,
                keys,
              )).rows[0];
              if (
                !row || row.digest !== await executionDigest(delivery) ||
                row.jobId !== job.id
              ) {
                throw new Error(
                  "Claim does not match an accepted immutable operator contribution",
                );
              }
              if (row.status === "completed") return true;
              if (row.status === "uncertain") {
                throw new Error("OPERATOR_CONTRIBUTION_UNKNOWN");
              }
              await query(
                `UPDATE ${
                  ledger.table("ExecutionContribution")
                } SET "status"='running' WHERE ${where}`,
                keys,
              );
              return false;
            },
          );
          if (alreadyCompleted) return;
          try {
            await handler(structuredClone(delivery), resolved.scope);
            job.signal.throwIfAborted();
            // A returned handler cannot release a contribution while its group
            // is missing canonical publication, even if every read has finished.
            await ledger.client.$transaction(async (tx) => {
              const query = fromPrisma(tx).executeSql;
              await ledger.lockClaim(query, job);
              await assertNoOpenImmutableConsultationGroups(
                query,
                ledger.table("ImmutableConsultationGroup"),
                keys.slice(0, 5),
              );
              await query(
                `UPDATE ${
                  ledger.table("ExecutionContribution")
                } SET "status"='completed',"completedAt"=COALESCE("completedAt",clock_timestamp()) WHERE ${where}`,
                keys,
              );
              await ledger.lockClaim(query, job);
            });
          } catch (error) {
            await ledger.client.$transaction(async (tx) => {
              const query = fromPrisma(tx).executeSql;
              await ledger.lockClaim(query, job);
              const unknown = await query(
                `SELECT "effectKey" FROM ${
                  ledger.table("ExecutionEffect")
                } WHERE "projectId"=$1 AND "systemId"=$2 AND "executionSpaceId"=$3 AND "operatorId"=$4 AND "threadId"=$5 AND "status"<>'completed' LIMIT 1`,
                keys.slice(0, 5),
              );
              await query(
                `UPDATE ${
                  ledger.table("ExecutionContribution")
                } SET "status"=$7 WHERE ${where} AND "status"<>'completed'`,
                // An unpublished group whose reads all settled can retry its
                // join. Only an actual unsettled effect requires reconciliation.
                [...keys, unknown.rows.length ? "uncertain" : "failed"],
              );
            }).catch(() => {});
            throw error;
          }
        });
        if (requestSettled && resolved.scope.executionSpaceId !== "main") {
          // The owner handler and its canonical contribution are now settled,
          // outside withClaim. Retirement also requires the PUBLIC job attempt
          // to stop being active. Never substitute the unfenced job ID here.
          const completion = await this.boss.complete(
            this.ledger.options.queueName,
            job,
            { contributionId: job.data.delivery.id },
          );
          if (!("affected" in completion) || completion.affected !== 1) {
            throw new Error(
              "The Request completion attempt fence was lost before its settlement notification",
            );
          }
          // pg-boss supports self-settlement. From this point there must be no
          // business write, claim/signal check or awaited work before returning.
          // The host callback is synchronous, schedule-only, and contains its
          // diagnostic failures; normal pg-boss auto-complete becomes a no-op.
          requestSettled(structuredClone(job.data.delivery), resolved.scope);
        }
      })();
      this.shared.handlers.add(running);
      try {
        await running;
        return { contributionId: job.data.delivery.id };
      } finally {
        this.shared.handlers.delete(running);
      }
    };
    const workerOptions = {
      batchSize: 1,
      pollingIntervalSeconds: 0.5,
      heartbeatRefreshSeconds: 5,
    };
    await this.boss.work<PostgresOperatorJob>(this.ledger.options.queueName, {
      ...workerOptions,
      localConcurrency: OPERATOR_WORKERS.main,
      minPriority: 1,
    }, handle);
    await this.boss.work<PostgresOperatorJob>(this.ledger.options.queueName, {
      ...workerOptions,
      localConcurrency: OPERATOR_WORKERS.ordinary,
      maxPriority: 0,
    }, handle);
  }
  stopAccepting(): void {
    this.shared.accepting = false;
  }
  assertSourceEffect(origin: OperatorExecutionCommandOrigin): Promise<void> {
    return this.ledger.assertCommandOrigin(origin);
  }
  async inspectAccepted(
    operatorId: string,
    id: string,
  ): Promise<
    | { receipt: OperatorDeliveryReceipt; delivery: OperatorExecutionDelivery }
    | null
  > {
    const scope = this.ledger.scope({ operatorId });
    const rows = await this.ledger.client.$queryRawUnsafe<
      {
        threadId: string;
        payloadJson: string;
        digest: string;
        jobId: string;
        status: OperatorDeliveryReceipt["status"];
      }[]
    >(
      `SELECT "threadId","payloadJson","digest","jobId","status" FROM ${
        this.ledger.table("ExecutionContribution")
      } WHERE "projectId"=$1 AND "systemId"=$2 AND "executionSpaceId"=$3 AND "operatorId"=$4 AND "contributionId"=$5 AND "kind" IN ('command','schedule','contribution','continuation','notification') LIMIT 2`,
      scope.projectId,
      scope.systemId,
      scope.executionSpaceId,
      scope.operatorId,
      id,
    );
    if (!rows.length) return null;
    if (rows.length !== 1) {
      throw new Error("Accepted operator delivery ID is ambiguous");
    }
    const row = rows[0],
      delivery = JSON.parse(row.payloadJson) as OperatorExecutionDelivery;
    if (
      delivery.id !== id || delivery.identity.operatorId !== operatorId ||
      !row.jobId || row.digest !== await executionDigest(delivery)
    ) throw new Error("Accepted operator delivery receipt is corrupt");
    return {
      receipt: {
        id,
        threadId: row.threadId,
        jobId: row.jobId,
        status: row.status,
      },
      delivery,
    };
  }
  async inspectTerminalAccepted(operatorId: string, id: string) {
    const accepted = await this.inspectAccepted(operatorId, id);
    if (!accepted) return null;
    const job = await this.boss.getJobById<PostgresOperatorJob>(
      this.ledger.options.queueName,
      accepted.receipt.jobId,
    );
    const terminal = terminalAcceptedTransport(accepted, job);
    if (!terminal) return null;
    const executions = await this.ledger.inspect(operatorId);
    if (
      executions.some((snapshot) =>
        canonical(snapshot.identity.scope) ===
          canonical(accepted.delivery.identity.scope) &&
        (snapshot.status === "uncertain" ||
          snapshot.unsettledEffects.length > 0 ||
          (snapshot.openImmutableConsultationGroups?.length ?? 0) > 0)
      )
    ) return null;
    return { ...accepted, terminal };
  }
  async drain(timeoutMs = 10_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.shared.handlers]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() =>
            reject(
              new Error(
                "Owned operator handlers did not drain before shutdown deadline",
              ),
            ), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async stop() {
    if (!this.#started) return;
    this.#started = false;
    await this.boss.offWork(this.ledger.options.queueName, { wait: true });
  }
}
