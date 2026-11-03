import {
  parseVersionedModelWriteCommand,
  parseVersionedModelWriteDossier,
  type VersionedModelWriteDossier,
} from "../../../../application/model/publication/write-command-v2.ts";
import type { ModelRevision } from "../../../../domain/model/records/revision.ts";
import type { RequestSourcePublicationContext } from "../../../../application/model/publication/ports/out/request-source-publication.port.ts";
import { parseRequestSourcePublicationContext } from "../../../../application/model/publication/request-source-context.ts";
import type { ScopedSoftwareSourcePublicationContext } from "../../../../application/model/publication/ports/out/scoped-software-source-publication.port.ts";
import { parseScopedSoftwareSourcePublicationContext } from "../../../../application/model/publication/scoped-software-source-context.ts";
import {
  versionedWriteCommandDigest,
  versionedWriteDossierDigest,
} from "../../../../application/model/publication/versioned-dossier.ts";
import type { RepositoryWriterLock } from "../../../out/git/writer-lock.ts";
import { canonical } from "../../../../domain/primitives/canonical-json.ts";
import type {
  AcquiredWrite,
  EnqueueOutcome,
  ModelWriteQueueEntry,
  ModelWriteQueuePort,
  ModelWriteQueueState,
  SettleOutcome,
  WriteLease,
} from "../../../../application/model/publication/ports/out/model-write-queue.port.ts";
import { ModelWriteQueueError } from "../../../../application/model/publication/write-queue.ts";
import {
  postgresQualifiedTable,
  Prisma,
  type PrismaClient,
} from "../../../out/postgres/client.ts";
import {
  postgresBigInt,
  postgresSafeInteger,
} from "../../../out/postgres/numbers.ts";
import {
  assertPostgresSystemScope,
  type PostgresSystemScope,
} from "../../../out/postgres/scope.ts";

/** Durable W4 queue. A host-resolved writer.lock spans queue acquisition and
 * Git publication in one authoritative repository environment. PostgreSQL and
 * Git have no shared atomic commit; the existing Git command anchors recover
 * a publication whose database transaction did not settle. */

const DEFAULT_MAX_PENDING_PER_REPOSITORY = 64;
const MAX_DOSSIER_BYTES = 32 * 1_048_576;

interface PostgresModelWriteQueueOptions {
  /** Host-owned client from createPostgresClient; never closed here. */
  readonly client: PrismaClient;
  /** Host-resolved PG-1 scope owning SourceRepository rows. */
  readonly scope: PostgresSystemScope;
  /** Trusted host mapping from repository identity to the Git writer's lock. */
  readonly writerLock: (repositoryId: string) => Promise<RepositoryWriterLock>;
  readonly maxPendingPerRepository?: number;
  readonly now?: () => Date;
  /** Adapter-only typed SQL participant. Application ports expose no tx. */
  readonly requestPublication?: PostgresRequestPublicationParticipant;
  readonly scopedSoftwarePublication?:
    PostgresScopedSoftwarePublicationParticipant;
}

interface Row {
  seq: bigint;
  command_id: string;
  command_digest: string;
  dossier_digest: string;
  command_json: string;
  dossier_json: string;
  state: string;
  enqueued_at: Date;
  updated_at: Date;
  attempts: bigint;
  owner: string | null;
  fence: bigint;
  lease_expires_at: Date | null;
  published_version: string | null;
  last_error_json: string | null;
}

/** Infrastructure-only: must verify current D1/open/A0 under locks for new
 * effects, and append only already Git-attested immutable D2 for recovery. */
export interface PostgresRequestPublicationParticipant {
  assertNewLocked(
    tx: Prisma.TransactionClient,
    context: RequestSourcePublicationContext,
  ): Promise<void>;
  assertExpiryLocked(
    tx: Prisma.TransactionClient,
    context: RequestSourcePublicationContext,
  ): Promise<void>;
  appendLocked(
    tx: Prisma.TransactionClient,
    context: RequestSourcePublicationContext,
  ): Promise<void>;
}
export interface PostgresScopedSoftwarePublicationParticipant {
  prepareCurrent(
    context: ScopedSoftwareSourcePublicationContext,
  ): Promise<object>;
  assertNewLocked(
    tx: Prisma.TransactionClient,
    context: ScopedSoftwareSourcePublicationContext,
    token: object,
  ): Promise<void>;
  assertExpiryLocked(
    tx: Prisma.TransactionClient,
    context: ScopedSoftwareSourcePublicationContext,
    token: object,
  ): Promise<void>;
  appendLocked(
    tx: Prisma.TransactionClient,
    context: ScopedSoftwareSourcePublicationContext,
  ): Promise<void>;
}

type Tx = Prisma.TransactionClient;

const PENDING_STATES = [
  "queued",
  "preparing",
  "prepared",
  "publishing",
  "retryable",
] as const;
const ACTIVE_STATES = ["preparing", "prepared", "publishing"] as const;
const KNOWN_STATES: readonly string[] = [
  ...PENDING_STATES,
  "published",
  "needs-decision",
  "refused",
];

const COLUMNS = `seq, command_id, command_digest, dossier_digest, command_json,
   dossier_json, state, enqueued_at, updated_at, attempts, owner, fence,
   lease_expires_at, published_version, last_error_json`;

function queueError(
  code: ModelWriteQueueError["code"],
  context: ModelWriteQueueError["context"],
  message: string,
): ModelWriteQueueError {
  return new ModelWriteQueueError(code, context, message);
}

function iso(value: Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function entryOf(row: Row): ModelWriteQueueEntry {
  if (!KNOWN_STATES.includes(row.state)) {
    throw new Error("stored write-queue state is unknown");
  }
  return {
    command: parseVersionedModelWriteCommand(JSON.parse(row.command_json)),
    commandDigest: row.command_digest,
    dossierDigest: row.dossier_digest,
    state: row.state as ModelWriteQueueState,
    enqueuedAt: iso(row.enqueued_at),
    updatedAt: iso(row.updated_at),
    attempts: postgresSafeInteger(row.attempts),
    ...(row.owner !== null ? { owner: row.owner } : {}),
    fence: postgresSafeInteger(row.fence),
    ...(row.lease_expires_at !== null
      ? { leaseExpiresAt: iso(row.lease_expires_at) }
      : {}),
    ...(row.published_version !== null
      ? { publishedVersion: row.published_version }
      : {}),
    ...(row.last_error_json !== null
      ? { lastError: JSON.parse(row.last_error_json) }
      : {}),
  };
}

export function requestSqlUnavailable(error: unknown): boolean {
  if (
    !(error instanceof Error) || !("code" in error) ||
    typeof error.code !== "string"
  ) return false;
  if (
    ["P1001", "P1002", "P1008", "P1017", "P2024", "P2034"].includes(error.code)
  ) return true;
  const metadata =
    "meta" in error && error.meta && typeof error.meta === "object"
      ? error.meta as Record<string, unknown>
      : undefined;
  if (error.code === "P2028") {
    return typeof metadata?.error === "string" &&
      (metadata.error.includes("expired transaction") ||
        metadata.error.includes(
          "Unable to start a transaction in the given time",
        ));
  }
  let state = error.code === "P2010" ? metadata?.code : error.code;
  if (error.code === "P2010" && state === undefined) {
    // Observed adapter-pg P2010 shape: the structured conflict retains its
    // SQLSTATE under DriverAdapterError.cause, not meta.code. Do not infer a
    // conflict from formatted messages or from an unknown driver cause.
    const driver = metadata?.driverAdapterError;
    const detail = driver && typeof driver === "object"
      ? driver as Record<string, unknown>
      : undefined;
    const cause = detail?.cause && typeof detail.cause === "object"
      ? detail.cause as Record<string, unknown>
      : undefined;
    if (
      detail?.name === "DriverAdapterError" &&
      cause?.kind === "TransactionWriteConflict" &&
      cause.originalCode === "40001"
    ) state = "40001";
  }
  return typeof state === "string" && (/^08[A-Z0-9]{3}$/.test(state) ||
    ["40001", "40P01", "53300", "57P01", "57P02", "57P03", "57014"].includes(
      state,
    ));
}

export class PostgresModelWriteQueue implements ModelWriteQueuePort {
  readonly #client: PrismaClient;
  readonly #scope: PostgresSystemScope;
  readonly #maxPending: number;
  readonly #now: () => Date;
  readonly #commands: Prisma.Sql;
  readonly #heads: Prisma.Sql;
  readonly #writerLock: PostgresModelWriteQueueOptions["writerLock"];
  readonly #requestPublication?: PostgresRequestPublicationParticipant;
  readonly #scopedSoftwarePublication?:
    PostgresScopedSoftwarePublicationParticipant;

  constructor(options: PostgresModelWriteQueueOptions) {
    assertPostgresSystemScope(options.scope);
    this.#scope = options.scope;
    this.#writerLock = options.writerLock;
    this.#requestPublication = options.requestPublication;
    this.#scopedSoftwarePublication = options.scopedSoftwarePublication;
    this.#client = options.client;
    // Identifiers are fixed literals resolved through the PG-1 host helper;
    // an unregistered client fails here, never via public-schema fallback.
    this.#commands = postgresQualifiedTable(
      options.client,
      "ModelWriteCommand",
    );
    this.#heads = postgresQualifiedTable(
      options.client,
      "ModelWriteRepositoryHead",
    );
    this.#maxPending = options.maxPendingPerRepository ??
      DEFAULT_MAX_PENDING_PER_REPOSITORY;
    if (!Number.isSafeInteger(this.#maxPending) || this.#maxPending < 1) {
      throw queueError("WRITE_QUEUE_INVALID", {
        reason: "per-repository pending bound must be a positive safe integer",
      }, "Invalid write-queue pending bound");
    }
    this.#now = options.now ?? (() => new Date());
  }

  #assertDossierScope(dossier: VersionedModelWriteDossier): void {
    if (
      dossier.v === 2 &&
      (dossier.command.destination.host.projectId !== this.#scope.projectId ||
        dossier.command.destination.host.systemId !== this.#scope.systemId ||
        dossier.command.destination.repositoryId !==
          dossier.command.repositoryId)
    ) {
      throw queueError("WRITE_QUEUE_INVALID", {
        repositoryId: dossier.command.repositoryId,
        commandId: dossier.command.commandId,
        reason: "Request destination differs from the queue host",
      }, "Request destination differs from the queue host");
    }
    const decision = dossier.decision;
    if (
      "kind" in decision && decision.kind === "retain-artifact-source" &&
      (decision.target.projectId !== this.#scope.projectId ||
        decision.target.systemId !== this.#scope.systemId)
    ) {
      throw queueError("WRITE_QUEUE_INVALID", {
        repositoryId: dossier.command.repositoryId,
        commandId: dossier.command.commandId,
        reason: "Source publication target differs from the queue host scope",
      }, "Source publication target differs from the queue host scope");
    }
  }

  #assertRepositoryId(repositoryId: string): void {
    if (
      typeof repositoryId !== "string" || !repositoryId.trim() ||
      repositoryId.includes("\0")
    ) {
      throw queueError("WRITE_QUEUE_INVALID", {
        reason: "repositoryId is required",
      }, "Write-queue repositoryId is required");
    }
  }

  #expiresAt(leaseMs: number): Date {
    return new Date(this.#now().getTime() + leaseMs);
  }

  /** Map storage failures to the port's retryable error. Never includes
   * connection strings; Prisma query logging stays off in the PG-1 client. */
  async #wrap<T>(
    context: { repositoryId?: string; commandId?: string },
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ModelWriteQueueError) throw error;
      throw queueError("WRITE_QUEUE_UNAVAILABLE", {
        ...context,
        reason: error instanceof Error ? error.message : String(error),
      }, "PostgreSQL write queue is unavailable");
    }
  }

  async #row(
    db: PrismaClient | Tx,
    repositoryId: string,
    commandId: string,
  ): Promise<Row | undefined> {
    const rows = await db.$queryRaw<Row[]>(
      Prisma.sql`SELECT ${Prisma.raw(COLUMNS)} FROM ${this.#commands}
        WHERE project_id = ${this.#scope.projectId}
          AND system_id = ${this.#scope.systemId}
          AND repository_id = ${repositoryId} AND command_id = ${commandId}`,
    );
    return rows[0];
  }

  /** Serialize enqueue/acquire per repository on its head row. Upserts the
   * head row; the SourceRepository FK rejects unknown repositories. */
  async #lockHead(tx: Tx, repositoryId: string): Promise<void> {
    await tx.$executeRaw(
      Prisma.sql`INSERT INTO ${this.#heads}
          (project_id, system_id, repository_id, next_seq)
        VALUES (${this.#scope.projectId}, ${this.#scope.systemId},
          ${repositoryId}, 1)
        ON CONFLICT (project_id, system_id, repository_id) DO NOTHING`,
    );
    const locked = await tx.$queryRaw<{ next_seq: bigint }[]>(
      Prisma.sql`SELECT next_seq FROM ${this.#heads}
        WHERE project_id = ${this.#scope.projectId}
          AND system_id = ${this.#scope.systemId}
          AND repository_id = ${repositoryId} FOR UPDATE`,
    );
    if (locked.length !== 1) {
      throw queueError("WRITE_QUEUE_UNAVAILABLE", {
        repositoryId,
        reason: "repository head row is missing after upsert",
      }, "PostgreSQL write queue is unavailable");
    }
  }

  async enqueue(input: VersionedModelWriteDossier): Promise<EnqueueOutcome> {
    // Capture before any digest await; no mutable caller object reaches SQL.
    const captured = structuredClone(input);
    const { repositoryId, commandId } = captured.command;
    this.#assertRepositoryId(repositoryId);
    let dossier: VersionedModelWriteDossier;
    try {
      dossier = await parseVersionedModelWriteDossier(captured);
      this.#assertDossierScope(dossier);
    } catch (error) {
      throw queueError("WRITE_QUEUE_INVALID", {
        repositoryId,
        commandId,
        reason: error instanceof Error ? error.message : String(error),
      }, "Write dossier failed domain admission");
    }
    const dossierJson = canonical(dossier);
    if (new TextEncoder().encode(dossierJson).length > MAX_DOSSIER_BYTES) {
      throw queueError("WRITE_QUEUE_INVALID", {
        repositoryId,
        commandId,
        reason: "dossier-too-large",
      }, "Write dossier exceeds the queue size bound");
    }
    const commandDigest = await versionedWriteCommandDigest(dossier.command);
    const dossierDigest = await versionedWriteDossierDigest(dossier);
    const commandJson = canonical(dossier.command);
    return this.#wrap(
      { repositoryId, commandId },
      () =>
        this.#client.$transaction(async (tx): Promise<EnqueueOutcome> => {
          await this.#lockHead(tx, repositoryId);
          const existing = await this.#row(tx, repositoryId, commandId);
          if (existing) {
            // BOTH digests must match for a duplicate; a forged dossier under
            // a known commandId conflicts even if the command matches.
            if (
              existing.command_digest !== commandDigest ||
              existing.dossier_digest !== dossierDigest
            ) {
              throw queueError("WRITE_QUEUE_CONFLICT", {
                repositoryId,
                commandId,
                reason: "commandId already queued with a different digest",
              }, "commandId already queued with a different digest");
            }
            return { status: "duplicate", entry: entryOf(existing) };
          }
          const pending = await tx.$queryRaw<{ n: bigint }[]>(
            Prisma.sql`SELECT COUNT(*) AS n FROM ${this.#commands}
            WHERE project_id = ${this.#scope.projectId}
              AND system_id = ${this.#scope.systemId}
              AND repository_id = ${repositoryId}
              AND state IN (${Prisma.join([...PENDING_STATES])})`,
          );
          if (pending[0].n >= BigInt(this.#maxPending)) {
            throw queueError("WRITE_QUEUE_FULL", {
              repositoryId,
              commandId,
              reason: "per-repository pending bound reached",
            }, "Write queue pending bound reached for this repository");
          }
          const seqRows = await tx.$queryRaw<{ seq: bigint }[]>(
            Prisma.sql`UPDATE ${this.#heads}
            SET next_seq = next_seq + 1
            WHERE project_id = ${this.#scope.projectId}
              AND system_id = ${this.#scope.systemId}
              AND repository_id = ${repositoryId}
            RETURNING next_seq - 1 AS seq`,
          );
          const now = this.#now();
          await tx.$executeRaw(
            Prisma.sql`INSERT INTO ${this.#commands}
              (project_id, system_id, repository_id, command_id, seq,
               command_digest, dossier_digest, command_json, dossier_json,
               state, enqueued_at, updated_at, attempts, fence)
            VALUES (${this.#scope.projectId}, ${this.#scope.systemId},
              ${repositoryId}, ${commandId}, ${seqRows[0].seq},
              ${commandDigest}, ${dossierDigest}, ${commandJson},
              ${dossierJson}, 'queued', ${now}, ${now}, 0, 0)`,
          );
          return {
            status: "queued",
            entry: entryOf((await this.#row(tx, repositoryId, commandId))!),
          };
        }),
    );
  }

  async acquire(
    repositoryId: string,
    owner: string,
    leaseMs: number,
  ): Promise<AcquiredWrite | null> {
    this.#assertRepositoryId(repositoryId);
    if (!owner || !Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw queueError("WRITE_QUEUE_INVALID", {
        repositoryId,
        reason: "owner and a positive lease are required",
      }, "Queue acquisition requires an owner and a positive lease");
    }
    return await this.#wrap(
      { repositoryId },
      async () =>
        (await this.#writerLock(repositoryId)).runExclusive(() =>
          this.#client.$transaction(
            async (tx): Promise<AcquiredWrite | null> => {
              await this.#lockHead(tx, repositoryId);
              const now = this.#now();
              const busy = await tx.$queryRaw<{ n: bigint }[]>(
                Prisma.sql`SELECT COUNT(*) AS n FROM ${this.#commands}
            WHERE project_id = ${this.#scope.projectId}
              AND system_id = ${this.#scope.systemId}
              AND repository_id = ${repositoryId}
              AND state IN (${Prisma.join([...ACTIVE_STATES])})
              AND lease_expires_at > ${now}`,
              );
              if (busy[0].n > 0n) return null;
              // Oldest unfinished command stays FIFO head even when its preparing
              // lease just expired; a queued-only scan would let later commands
              // overtake it between recoverExpired calls (as in the SQLite queue).
              const heads = await tx.$queryRaw<Row[]>(
                Prisma.sql`SELECT ${Prisma.raw(COLUMNS)} FROM ${this.#commands}
            WHERE project_id = ${this.#scope.projectId}
              AND system_id = ${this.#scope.systemId}
              AND repository_id = ${repositoryId}
              AND state IN (${Prisma.join([...PENDING_STATES])})
            ORDER BY seq ASC LIMIT 1`,
              );
              const head = heads[0];
              if (!head) return null;
              const expiresAt = this.#expiresAt(leaseMs);
              const updated = await tx.$executeRaw(
                Prisma.sql`UPDATE ${this.#commands}
            SET state = 'preparing', owner = ${owner}, fence = fence + 1,
                lease_expires_at = ${expiresAt}, updated_at = ${now}
            WHERE project_id = ${this.#scope.projectId}
              AND system_id = ${this.#scope.systemId}
              AND repository_id = ${repositoryId}
              AND command_id = ${head.command_id}
              AND (state IN ('queued', 'retryable') OR
                   (state IN ('preparing', 'prepared', 'publishing') AND
                    lease_expires_at <= ${now}))`,
              );
              if (updated !== 1) return null;
              const row = (await this.#row(tx, repositoryId, head.command_id))!;
              let dossier: VersionedModelWriteDossier;
              try {
                dossier = await parseVersionedModelWriteDossier(
                  JSON.parse(row.dossier_json),
                );
                this.#assertDossierScope(dossier);
                if (
                  canonical(dossier) !== row.dossier_json ||
                  canonical(dossier.command) !== row.command_json ||
                  await versionedWriteCommandDigest(dossier.command) !==
                    row.command_digest ||
                  await versionedWriteDossierDigest(dossier) !==
                    row.dossier_digest
                ) throw new Error("stored dossier bytes are not canonical");
              } catch (error) {
                // Thrown inside the transaction: the claim above rolls back.
                throw queueError("WRITE_QUEUE_UNAVAILABLE", {
                  repositoryId,
                  commandId: head.command_id,
                  reason: error instanceof Error
                    ? error.message
                    : String(error),
                }, "Stored write dossier is unreadable");
              }
              return {
                entry: entryOf(row),
                dossier,
                lease: {
                  repositoryId,
                  commandId: head.command_id,
                  owner,
                  fence: postgresSafeInteger(row.fence),
                  expiresAt: expiresAt.toISOString(),
                },
              };
            },
          )
        ),
    );
  }

  /** Single fenced UPDATE: scope + identity + current owner + fence +
   * still-unexpired lease must all hold, else WRITE_FENCE_LOST. */
  async #fencedUpdate(
    lease: WriteLease,
    setClause: Prisma.Sql,
  ): Promise<void> {
    const now = this.#now();
    const changed = await this.#client.$executeRaw(
      Prisma.sql`UPDATE ${this.#commands}
        SET ${setClause}, updated_at = GREATEST(updated_at, ${now})
        WHERE project_id = ${this.#scope.projectId}
          AND system_id = ${this.#scope.systemId}
          AND repository_id = ${lease.repositoryId}
          AND command_id = ${lease.commandId}
          AND owner = ${lease.owner}
          AND fence = ${postgresBigInt(lease.fence)}
          AND lease_expires_at > ${now}`,
    );
    if (changed !== 1) {
      throw queueError("WRITE_FENCE_LOST", {
        repositoryId: lease.repositoryId,
        commandId: lease.commandId,
        reason: "lease owner or fence no longer current",
      }, "Write queue lease was lost");
    }
  }

  async heartbeat(lease: WriteLease, leaseMs: number): Promise<void> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw queueError("WRITE_QUEUE_INVALID", {
        repositoryId: lease.repositoryId,
        commandId: lease.commandId,
        reason: "positive lease duration required",
      }, "Queue heartbeat requires a positive lease duration");
    }
    return await this.#wrap(lease, () =>
      this.#fencedUpdate(
        lease,
        Prisma.sql`lease_expires_at = GREATEST(lease_expires_at, ${
          this.#expiresAt(leaseMs)
        })`,
      ));
  }

  transition(lease: WriteLease, to: "prepared" | "publishing"): Promise<void> {
    return this.#wrap(lease, async () => {
      const now = this.#now();
      const changed = await this.#client.$executeRaw(
        Prisma.sql`UPDATE ${this.#commands}
          SET state = ${to}, updated_at = ${now}
          WHERE project_id = ${this.#scope.projectId}
            AND system_id = ${this.#scope.systemId}
            AND repository_id = ${lease.repositoryId}
            AND command_id = ${lease.commandId}
            AND owner = ${lease.owner}
            AND fence = ${postgresBigInt(lease.fence)}
            AND lease_expires_at > ${now}`,
      );
      if (changed !== 1) {
        throw queueError("WRITE_FENCE_LOST", {
          repositoryId: lease.repositoryId,
          commandId: lease.commandId,
          reason: "lease owner or fence no longer current",
        }, "Write queue lease was lost");
      }
    });
  }

  settle(lease: WriteLease, outcome: SettleOutcome): Promise<void> {
    return this.#wrap(lease, () => {
      if (outcome.status === "published") {
        return this.#fencedUpdate(
          lease,
          Prisma.sql`state = 'published',
            published_version = ${outcome.version},
            owner = NULL, lease_expires_at = NULL`,
        );
      }
      if (outcome.status === "retryable") {
        return this.#fencedUpdate(
          lease,
          Prisma.sql`state = 'retryable', attempts = attempts + 1,
            last_error_json = ${canonical(outcome.error)},
            owner = NULL, lease_expires_at = NULL`,
        );
      }
      return this.#fencedUpdate(
        lease,
        Prisma.sql`state = ${outcome.status},
          last_error_json = ${canonical(outcome.error)},
          owner = NULL, lease_expires_at = NULL`,
      );
    });
  }

  /** Called inside Git #exclusive: proof is required, never reacquire the
   * same OS lock here. Keep it held until the effect finishes even if SQL
   * disconnect/timeout rejects its transaction before the callback resolves. */
  guardPublication<T>(
    lease: WriteLease,
    leaseMs: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#guardPublication(lease, leaseMs, operation);
  }
  async guardRequestPublication(
    lease: WriteLease,
    leaseMs: number,
    input: RequestSourcePublicationContext,
    gitEffect: () => Promise<ModelRevision>,
  ): Promise<ModelRevision> {
    const context = await parseRequestSourcePublicationContext(input);
    this.#assertRequestContext(lease, context);
    try {
      return await this.#guardPublication(lease, leaseMs, gitEffect, {
        mode: "new",
        family: "human",
        context,
      });
    } catch (error) {
      this.#requestSqlFailure(lease, error);
    }
  }
  async reconcileRequestPublication(
    lease: WriteLease,
    leaseMs: number,
    input: RequestSourcePublicationContext,
  ): Promise<void> {
    const context = await parseRequestSourcePublicationContext(input);
    this.#assertRequestContext(lease, context);
    try {
      await this.#guardPublication(lease, leaseMs, () => Promise.resolve(), {
        mode: "historical",
        family: "human",
        context,
      });
    } catch (error) {
      this.#requestSqlFailure(lease, error);
    }
  }
  #requestSqlFailure(lease: WriteLease, error: unknown): never {
    if (requestSqlUnavailable(error)) {
      throw queueError("WRITE_QUEUE_UNAVAILABLE", {
        repositoryId: lease.repositoryId,
        commandId: lease.commandId,
        reason: "Request SQL connection/timeout/serialization unavailable",
      }, "Request publication SQL is temporarily unavailable");
    }
    throw error;
  }
  async guardScopedSoftwarePublication(
    lease: WriteLease,
    leaseMs: number,
    input: ScopedSoftwareSourcePublicationContext,
    gitEffect: () => Promise<ModelRevision>,
  ): Promise<ModelRevision> {
    const context = await parseScopedSoftwareSourcePublicationContext(input);
    this.#assertScopedSoftwareContext(lease, context);
    try {
      return await this.#guardPublication(lease, leaseMs, gitEffect, {
        mode: "new",
        family: "software",
        context,
      });
    } catch (error) {
      this.#requestSqlFailure(lease, error);
    }
  }
  async reconcileScopedSoftwarePublication(
    lease: WriteLease,
    leaseMs: number,
    input: ScopedSoftwareSourcePublicationContext,
  ): Promise<void> {
    const context = await parseScopedSoftwareSourcePublicationContext(input);
    this.#assertScopedSoftwareContext(lease, context);
    try {
      await this.#guardPublication(lease, leaseMs, () => Promise.resolve(), {
        mode: "historical",
        family: "software",
        context,
      });
    } catch (error) {
      this.#requestSqlFailure(lease, error);
    }
  }
  #assertScopedSoftwareContext(
    lease: WriteLease,
    context: ScopedSoftwareSourcePublicationContext,
  ): void {
    this.#assertDossierScope(context.dossier);
    if (
      !this.#scopedSoftwarePublication ||
      context.dossier.command.repositoryId !== lease.repositoryId ||
      context.dossier.command.commandId !== lease.commandId
    ) {
      throw queueError("WRITE_QUEUE_INVALID", {
        repositoryId: lease.repositoryId,
        commandId: lease.commandId,
        reason:
          "Scoped software publication requires its typed SQL participant",
      }, "Scoped software publication requires its typed SQL participant");
    }
  }
  #assertRequestContext(
    lease: WriteLease,
    context: RequestSourcePublicationContext,
  ): void {
    this.#assertDossierScope(context.dossier);
    if (
      !this.#requestPublication ||
      context.dossier.command.repositoryId !== lease.repositoryId ||
      context.dossier.command.commandId !== lease.commandId
    ) {
      throw queueError("WRITE_QUEUE_INVALID", {
        repositoryId: lease.repositoryId,
        commandId: lease.commandId,
        reason: "Request publication requires the exact typed SQL participant",
      }, "Request publication requires the exact typed SQL participant");
    }
  }
  async #guardPublication<T>(
    lease: WriteLease,
    leaseMs: number,
    operation: () => Promise<T>,
    request?: {
      mode: "new" | "historical";
      family: "human";
      context: RequestSourcePublicationContext;
    } | {
      mode: "new" | "historical";
      family: "software";
      context: ScopedSoftwareSourcePublicationContext;
    },
  ): Promise<T> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw queueError("WRITE_QUEUE_INVALID", {
        repositoryId: lease.repositoryId,
        commandId: lease.commandId,
        reason: "positive lease duration required",
      }, "Publication guard requires a positive lease duration");
    }
    let callbackFailure: { error: unknown } | undefined;
    try {
      return await this.#wrap(lease, async () => {
        const writerLock = await this.#writerLock(lease.repositoryId);
        writerLock.assertHeld();
        const preparedAuthority =
          request?.mode === "new" && request.family === "software"
            ? await this.#scopedSoftwarePublication!.prepareCurrent(
              request.context,
            )
            : undefined;
        writerLock.assertHeld();
        let effectCompletion: Promise<void> | undefined;
        let acceptingEffect = true;
        try {
          return await this.#client.$transaction(async (tx) => {
            await this.#lockHead(tx, lease.repositoryId);
            const rows = await tx.$queryRaw<Row[]>(
              Prisma.sql`SELECT ${Prisma.raw(COLUMNS)} FROM ${this.#commands}
              WHERE project_id = ${this.#scope.projectId}
                AND system_id = ${this.#scope.systemId}
                AND repository_id = ${lease.repositoryId}
                AND command_id = ${lease.commandId} FOR UPDATE`,
            );
            const row = rows[0];
            if (
              !row || row.owner !== lease.owner ||
              row.fence !== postgresBigInt(lease.fence) ||
              row.state !== "publishing" || !row.lease_expires_at ||
              row.lease_expires_at.getTime() <= this.#now().getTime()
            ) {
              throw queueError("WRITE_FENCE_LOST", {
                repositoryId: lease.repositoryId,
                commandId: lease.commandId,
                reason: "publishing lease is no longer current",
              }, "Write queue publication fence was lost");
            }
            if (
              request &&
              (row.command_digest !== request.context.admission.commandDigest ||
                row.dossier_digest !==
                  (request.family === "human"
                    ? request.context.admission.dossierDigest
                    : request.context.admission.writeDossierDigest) ||
                row.dossier_json !== canonical(request.context.dossier))
            ) {
              throw queueError(
                "WRITE_QUEUE_CONFLICT",
                {
                  repositoryId: lease.repositoryId,
                  commandId: lease.commandId,
                  reason:
                    "Prepared Request proof differs from the locked queued dossier",
                },
                "Prepared Request proof differs from the locked queued dossier",
              );
            }
            const effect = Promise.resolve().then(async () => {
              // An adapter can reject an expired/disconnected transaction before
              // its async body resumes. Such a late body may never start Git.
              if (!acceptingEffect) {
                throw new Error("Publication guard has ended");
              }
              writerLock.assertHeld();
              try {
                if (request?.mode === "new") {
                  if (request.family === "human") {
                    await this.#requestPublication!.assertNewLocked(
                      tx,
                      request.context,
                    );
                    await this.#requestPublication!.assertExpiryLocked(
                      tx,
                      request.context,
                    );
                  } else {
                    await this.#scopedSoftwarePublication!.assertNewLocked(
                      tx,
                      request.context,
                      preparedAuthority!,
                    );
                    await this.#scopedSoftwarePublication!.assertExpiryLocked(
                      tx,
                      request.context,
                      preparedAuthority!,
                    );
                  }
                  // SQL may reject while the async participant is suspended.
                  // Recheck before starting Git, retaining original late-body rule.
                  if (!acceptingEffect) {
                    throw new Error("Publication guard has ended");
                  }
                  writerLock.assertHeld();
                }
                const result = await operation();
                if (request?.mode === "new") {
                  const published = result as ModelRevision;
                  if (
                    published?.version !==
                      request.context.admission.result.source.version ||
                    published.sourceDigest !==
                      request.context.admission.result.sourceDigest
                  ) {
                    throw queueError("WRITE_QUEUE_CONFLICT", {
                      repositoryId: lease.repositoryId,
                      commandId: lease.commandId,
                      reason: "Git effect returned a different Request result",
                    }, "Git effect returned a different Request result");
                  }
                }
                if (request) {
                  if (request.family === "human") {
                    await this.#requestPublication!.appendLocked(
                      tx,
                      request.context,
                    );
                  } else {
                    await this.#scopedSoftwarePublication!.appendLocked(
                      tx,
                      request.context,
                    );
                  }
                }
                return result;
              } catch (error) {
                callbackFailure = { error };
                throw error;
              }
            });
            // Attach both outcomes immediately so an early SQL rejection never
            // leaves an unhandled callback rejection or releases the OS lock.
            effectCompletion = effect.then(() => {}, () => {});
            const result = await effect;
            const renewed = await tx.$executeRaw(
              Prisma.sql`UPDATE ${this.#commands}
              SET lease_expires_at = ${this.#expiresAt(leaseMs)},
                  updated_at = ${this.#now()}
              WHERE project_id = ${this.#scope.projectId}
                AND system_id = ${this.#scope.systemId}
                AND repository_id = ${lease.repositoryId}
                AND command_id = ${lease.commandId}
                AND owner = ${lease.owner}
                AND fence = ${postgresBigInt(lease.fence)}
                AND state = 'publishing'`,
            );
            // Expiry is deliberately not rechecked: the OS and row locks kept
            // this exact owner exclusive during a slow CAS past its deadline.
            if (renewed !== 1) {
              throw queueError("WRITE_FENCE_LOST", {
                repositoryId: lease.repositoryId,
                commandId: lease.commandId,
                reason: "publishing lease changed during guarded publication",
              }, "Write queue publication fence was lost");
            }
            return result;
          });
        } finally {
          acceptingEffect = false;
          await effectCompletion;
        }
      });
    } catch (error) {
      // Git conflicts/authorization errors keep their existing semantics;
      // only database/interlock failures become queue availability errors.
      if (callbackFailure) throw callbackFailure.error;
      throw error;
    }
  }

  async get(
    repositoryId: string,
    commandId: string,
  ): Promise<ModelWriteQueueEntry | null> {
    this.#assertRepositoryId(repositoryId);
    return await this.#wrap({ repositoryId, commandId }, async () => {
      const row = await this.#row(this.#client, repositoryId, commandId);
      return row ? entryOf(row) : null;
    });
  }

  async getDossier(
    repositoryId: string,
    commandId: string,
  ): Promise<VersionedModelWriteDossier | null> {
    this.#assertRepositoryId(repositoryId);
    const row = await this.#wrap(
      { repositoryId, commandId },
      () => this.#row(this.#client, repositoryId, commandId),
    );
    if (!row) return null;
    let dossier: VersionedModelWriteDossier;
    try {
      // Parse afresh rather than exposing mutable queue storage to callers.
      dossier = await parseVersionedModelWriteDossier(
        JSON.parse(row.dossier_json),
      );
      this.#assertDossierScope(dossier);
      const commandDigest = await versionedWriteCommandDigest(dossier.command);
      const dossierDigest = await versionedWriteDossierDigest(dossier);
      if (
        dossier.command.repositoryId !== repositoryId ||
        dossier.command.commandId !== commandId ||
        canonical(dossier.command) !== row.command_json ||
        canonical(dossier) !== row.dossier_json ||
        commandDigest !== row.command_digest ||
        dossierDigest !== row.dossier_digest
      ) throw new Error("stored dossier digest or identity differs from row");
    } catch (error) {
      throw queueError("WRITE_QUEUE_UNAVAILABLE", {
        repositoryId,
        commandId,
        reason: error instanceof Error ? error.message : String(error),
      }, "Stored write dossier is invalid");
    }
    return dossier;
  }

  async list(repositoryId: string): Promise<ModelWriteQueueEntry[]> {
    this.#assertRepositoryId(repositoryId);
    return await this.#wrap({ repositoryId }, async () => {
      const rows = await this.#client.$queryRaw<Row[]>(
        Prisma.sql`SELECT ${Prisma.raw(COLUMNS)} FROM ${this.#commands}
          WHERE project_id = ${this.#scope.projectId}
            AND system_id = ${this.#scope.systemId}
            AND repository_id = ${repositoryId} ORDER BY seq ASC`,
      );
      return rows.map(entryOf);
    });
  }

  /** Recovery also takes the repository OS lock: after SQL connection loss
   * it must not clear ownership while the Git callback still runs. */
  recoverExpired(): Promise<number> {
    return this.#wrap({}, async () => {
      const repositories = await this.#client.$queryRaw<
        { repository_id: string }[]
      >(
        Prisma.sql`SELECT DISTINCT repository_id FROM ${this.#commands}
          WHERE project_id = ${this.#scope.projectId}
            AND system_id = ${this.#scope.systemId}
            AND state IN (${Prisma.join([...ACTIVE_STATES])})
            AND lease_expires_at <= ${this.#now()}`,
      );
      let changed = 0;
      for (const { repository_id: repositoryId } of repositories) {
        changed += await (await this.#writerLock(repositoryId)).runExclusive(
          () =>
            this.#client.$transaction(async (tx) => {
              await this.#lockHead(tx, repositoryId);
              const now = this.#now();
              return await tx.$executeRaw(
                Prisma.sql`UPDATE ${this.#commands}
                SET state = 'retryable', owner = NULL, updated_at = ${now}
                WHERE project_id = ${this.#scope.projectId}
                  AND system_id = ${this.#scope.systemId}
                  AND repository_id = ${repositoryId}
                  AND state IN (${Prisma.join([...ACTIVE_STATES])})
                  AND lease_expires_at <= ${now}`,
              );
            }),
        );
      }
      return changed;
    });
  }
}
