import type { PostgresPrimarySpaceControlSource } from "./primary-space-control-source.ts";
import type { StorePort } from "../../../application/work/runtime/ports.ts";
import {
  assertNetworkImpactEvidenceBudget,
  type BoundedNetworkImpactEvidenceInput,
  type BoundedNetworkImpactEvidenceRead,
  emptyNetworkImpactEvidenceRead,
} from "../../../application/model/impact/evidence-sources.ts";
import type {
  ProjectionHistoryPort,
  ProjectionSnapshot,
  StateHistoryPort,
  StateRevision,
} from "../../../application/work/runtime/ports/out/state-history.port.ts";
import type { SystemRuntimeState } from "../../../application/work/runtime/state.ts";
import { CaseError } from "../../../domain/work/errors/case.ts";
import {
  decodeRuntimeSnapshotPayload,
  encodeRuntimeSnapshotPayload,
  RUNTIME_SNAPSHOT_HEADER_CHARS,
  runtimeSnapshotPayloadInfo,
  sameVerifiedRuntimeSnapshot,
} from "./runtime-snapshot-codec.ts";
import { postgresQualifiedTable, Prisma, type PrismaClient } from "./client.ts";
import { postgresBigInt, postgresSafeInteger } from "./numbers.ts";
import { postgresExecutionTransaction } from "./execution-transaction.ts";
import {
  assertPostgresRuntimeScope,
  type PostgresRuntimeScope,
} from "./scope.ts";
import {
  assertRuntimeState,
  decodePostgresRuntimeState,
  runtimeStateSummary,
} from "./runtime-state-snapshot.ts";

type PostgresTransaction = Prisma.TransactionClient;

type RevisionRow = Awaited<
  ReturnType<PrismaClient["runtimeRevision"]["findFirstOrThrow"]>
>;

export function decodeHistorical(row: RevisionRow): SystemRuntimeState {
  const state = decodePostgresRuntimeState(row);
  const fields = runtimeStateSummary(state);
  if (
    row.runtimeStateId !== state.id ||
    postgresSafeInteger(row.catalogRevision) !== state.catalogRevision ||
    postgresSafeInteger(row.eventCount) !== state.events.length ||
    row.modelPayload !==
      (state.model === undefined ? null : JSON.stringify(state.model)) ||
    row.label !== fields.label ||
    postgresSafeInteger(row.agentCount) !== fields.agentCount ||
    postgresSafeInteger(row.activeToolCount) !== fields.activeToolCount ||
    !["commit", "legacy_backfill"].includes(row.origin)
  ) throw new Error("Corrupt historical state metadata");
  return state;
}

/** Canonical business state and accepted history, separate from model projections.
 * The host owns the shared client/pool and must create the runtime scope first. */
export class PostgresSystemStateStore
  implements StorePort, StateHistoryPort, ProjectionHistoryPort {
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private constructor(
    private readonly client: PrismaClient,
    private readonly scope: PostgresRuntimeScope,
    private readonly primaryControl?: PostgresPrimarySpaceControlSource,
  ) {}

  static async open(
    client: PrismaClient,
    scope: PostgresRuntimeScope,
    primaryControl?: PostgresPrimarySpaceControlSource,
  ): Promise<PostgresSystemStateStore> {
    assertPostgresRuntimeScope(scope);
    primaryControl?.assertClient(client);
    // Resolves through the host client metadata; never accepts a second schema.
    postgresQualifiedTable(client, "RuntimeRevision");
    const store = new PostgresSystemStateStore(
      client,
      Object.freeze({ ...scope }),
      primaryControl,
    );
    // Startup integrity checks and any observed legacy baseline commit together;
    // when opened by a worker, baseline writes obey the same execution fence.
    await postgresExecutionTransaction(client, async (tx) => {
      await store.lock(tx);
      const current = await tx.runtimeState.findFirst({ where: store.scope });
      const latest = await tx.runtimeRevision.findFirst({
        where: store.scope,
        orderBy: { revision: "desc" },
      });
      if (!current && latest) {
        throw new Error("Revision history has no current state");
      }
      if (!current) return;
      const state = decodePostgresRuntimeState(current);
      if (!latest) {
        await store.appendRevision(
          tx,
          state,
          current.payload,
          "legacy_backfill",
        );
      } else if (
        decodeHistorical(latest).revision !== state.revision ||
        !sameVerifiedRuntimeSnapshot(latest.payload, current.payload)
      ) throw new Error("Current state and revision history disagree");
    });
    return store;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("PostgreSQL state store is closed");
  }

  private async exclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => release = resolve);
    await previous;
    try {
      this.assertOpen();
      return await work();
    } finally {
      release();
    }
  }

  /** UPDATE takes a PostgreSQL row lock even when its value is unchanged. This
   * stable parent also serializes create-only races before a state row exists. */
  private async lock(tx: PostgresTransaction): Promise<void> {
    const locked = await tx.operatorRuntime.updateMany({
      where: this.scope,
      data: { operatorId: this.scope.operatorId },
    });
    if (locked.count !== 1) {
      throw new Error("PostgreSQL runtime scope does not exist");
    }
  }

  private async appendRevision(
    tx: PostgresTransaction,
    snapshot: SystemRuntimeState,
    payload: string,
    origin: StateRevision["origin"],
  ): Promise<void> {
    const latest = await tx.runtimeRevision.findFirst({
      where: this.scope,
      orderBy: { recordedAt: "desc" },
      select: { recordedAt: true },
    });
    const now = new Date();
    const recordedAt = latest && latest.recordedAt > now
      ? latest.recordedAt
      : now;
    const fields = runtimeStateSummary(snapshot);
    await tx.runtimeRevision.create({
      data: {
        ...this.scope,
        revision: postgresBigInt(snapshot.revision),
        recordedAt,
        runtimeStateId: snapshot.id,
        catalogRevision: postgresBigInt(snapshot.catalogRevision),
        modelPayload: snapshot.model === undefined
          ? null
          : JSON.stringify(snapshot.model),
        eventCount: postgresBigInt(snapshot.events.length),
        origin,
        payload,
        label: fields.label,
        agentCount: postgresBigInt(fields.agentCount),
        activeToolCount: postgresBigInt(fields.activeToolCount),
      },
    });
  }

  async load(): Promise<SystemRuntimeState | null> {
    return await this.exclusive(async () => {
      const row = await this.client.runtimeState.findFirst({
        where: this.scope,
      });
      return row ? decodePostgresRuntimeState(row) : null;
    });
  }

  readonly #preparedSaves = new WeakMap<object, {
    snapshot: SystemRuntimeState;
    payload: string;
    expectedRevision: number | null;
  }>();
  readonly #mutationLocks = new WeakMap<object, PostgresTransaction>();

  /** Snapshot before yielding; packets cannot be reused with another store. */
  prepareSave(
    state: SystemRuntimeState,
    expectedRevision: number | null,
  ): object {
    // Capture the caller's exact domain JSON before yielding, without canonicalizing it.
    const json = JSON.stringify(state);
    const snapshot: unknown = JSON.parse(json);
    assertRuntimeState(snapshot);
    if (
      (expectedRevision !== null &&
        (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) ||
      snapshot.revision !==
        (expectedRevision === null ? 0 : expectedRevision + 1)
    ) throw new Error("Invalid expected state revision");
    const payload = encodeRuntimeSnapshotPayload(json);
    const packet = Object.freeze({});
    this.#preparedSaves.set(packet, { snapshot, payload, expectedRevision });
    return packet;
  }

  /** Caller has acquired every native lock before taking this stable parent. */
  /** Read the committed state under this scope's mutation lock: a concurrent
   * save of this runtime waits for the caller's transaction (4.8c A2). */
  async readLockedInTransaction(
    tx: PostgresTransaction,
  ): Promise<SystemRuntimeState | null> {
    this.assertOpen();
    await this.lock(tx);
    const row = await tx.runtimeState.findFirst({ where: this.scope });
    return row ? decodePostgresRuntimeState(row) : null;
  }

  async lockMutationInTransaction(tx: PostgresTransaction): Promise<object> {
    this.assertOpen();
    await this.lock(tx);
    const token = Object.freeze({});
    this.#mutationLocks.set(token, tx);
    return token;
  }

  /** No transaction, queue, initialization or native lock is acquired here. */
  async savePreparedInTransaction(
    tx: PostgresTransaction,
    packet: object,
    lock: object,
  ): Promise<void> {
    this.assertOpen();
    const prepared = this.#preparedSaves.get(packet);
    if (!prepared || this.#mutationLocks.get(lock) !== tx) {
      throw new Error(
        "State prepared save or transaction lock belongs to another store",
      );
    }
    const { snapshot, payload, expectedRevision } = prepared;
    const row = await tx.runtimeState.findFirst({ where: this.scope });
    const current = row ? decodePostgresRuntimeState(row) : null;
    if ((current?.revision ?? null) !== expectedRevision) {
      throw new Error("State revision changed");
    }
    if (current && current.id !== snapshot.id) {
      throw new Error("State system ID changed");
    }
    if (this.primaryControl?.owns(this.scope)) {
      await this.primaryControl.invalidateChanged(tx, current, snapshot);
    }
    // This owner's stable OperatorRuntime row is already locked. New group
    // registration takes that SAME row before inspecting the owner's Case
    // and inserting its manifest, including delegated contributor groups.
    // Do not lock execution threads here: registrations fence thread first.
    const closing = (snapshot.cases ?? []).filter((record) =>
      record.status === "closed-done" &&
      current?.cases?.find((previous) => previous.id === record.id)
          ?.status !== "closed-done"
    ).map((record) => record.id);
    if (closing.length) {
      const groups = postgresQualifiedTable(
        this.client,
        "ImmutableConsultationGroup",
      );
      const executions = postgresQualifiedTable(
        this.client,
        "OperatorExecution",
      );
      const open = await tx.$queryRaw<Array<{ groupId: string }>>(
        Prisma.sql`
        SELECT g."groupId" FROM ${groups} g JOIN ${executions} e
          USING ("projectId","systemId","executionSpaceId","operatorId","threadId")
        WHERE g."projectId"=${this.scope.projectId} AND g."systemId"=${this.scope.systemId}
          AND g."executionSpaceId"=${this.scope.executionSpaceId}
          AND e."scopeKind"='request' AND e."scopeId" IN (${
          Prisma.join(closing)
        })
          AND g."publicationJson" IS NULL LIMIT 1
      `,
      );
      if (open.length) {
        throw new CaseError(
          "CASE_BUSY",
          "An immutable consultation group still awaits publication",
        );
      }
    }
    if (row) {
      const updated = await tx.runtimeState.updateMany({
        where: {
          ...this.scope,
          revision: postgresBigInt(expectedRevision!),
        },
        data: { revision: postgresBigInt(snapshot.revision), payload },
      });
      if (updated.count !== 1) throw new Error("State revision changed");
    } else {
      await tx.runtimeState.create({
        data: {
          ...this.scope,
          revision: postgresBigInt(snapshot.revision),
          payload,
        },
      });
    }
    await this.appendRevision(tx, snapshot, payload, "commit");
  }

  async save(
    state: SystemRuntimeState,
    expectedRevision: number | null,
  ): Promise<void> {
    const prepared = this.prepareSave(state, expectedRevision);
    await this.exclusive(() =>
      postgresExecutionTransaction(this.client, async (tx) => {
        const lock = await this.lockMutationInTransaction(tx);
        await this.savePreparedInTransaction(tx, prepared, lock);
      })
    );
  }

  async listRevisions(): Promise<StateRevision[]> {
    return await this.exclusive(async () => {
      const rows = await this.client.runtimeRevision.findMany({
        where: this.scope,
        orderBy: { revision: "asc" },
        // History navigation must not materialize every snapshot.
        select: {
          revision: true,
          recordedAt: true,
          runtimeStateId: true,
          catalogRevision: true,
          modelPayload: true,
          eventCount: true,
          origin: true,
          label: true,
          agentCount: true,
          activeToolCount: true,
          projection: { select: { revision: true } },
        },
      });
      return rows.map((row) => {
        if (!["commit", "legacy_backfill"].includes(row.origin)) {
          throw new Error("Corrupt historical state origin");
        }
        return {
          revision: postgresSafeInteger(row.revision),
          recordedAt: row.recordedAt.toISOString(),
          systemId: row.runtimeStateId,
          catalogRevision: postgresSafeInteger(row.catalogRevision),
          ...(row.modelPayload === null
            ? {}
            : { model: JSON.parse(row.modelPayload) }),
          eventCount: postgresSafeInteger(row.eventCount),
          origin: row.origin as StateRevision["origin"],
          label: row.label,
          agentCount: postgresSafeInteger(row.agentCount),
          activeToolCount: postgresSafeInteger(row.activeToolCount),
          hasProjection: row.projection !== null,
        };
      });
    });
  }

  async loadRevision(revision: number): Promise<SystemRuntimeState | null> {
    const value = postgresBigInt(revision);
    return await this.exclusive(async () => {
      const row = await this.client.runtimeRevision.findFirst({
        where: { ...this.scope, revision: value },
      });
      return row ? decodeHistorical(row) : null;
    });
  }

  async loadAt(at: string): Promise<SystemRuntimeState | null> {
    const time = typeof at === "string" ? Date.parse(at) : NaN;
    if (!Number.isFinite(time)) throw new Error("Invalid historical timestamp");
    return await this.exclusive(async () => {
      const row = await this.client.runtimeRevision.findFirst({
        where: { ...this.scope, recordedAt: { lte: new Date(time) } },
        orderBy: [{ recordedAt: "desc" }, { revision: "desc" }],
      });
      return row ? decodeHistorical(row) : null;
    });
  }

  async recordProjection(
    revision: number,
    graph: unknown,
    digest: string,
  ): Promise<void> {
    const value = postgresBigInt(revision);
    if (typeof digest !== "string" || !digest.trim() || digest.length > 256) {
      throw new Error("Invalid projection digest");
    }
    const payload = JSON.stringify(graph);
    if (payload === undefined) throw new Error("Invalid projection payload");
    if (new TextEncoder().encode(payload).byteLength > 10 * 1024 * 1024) {
      throw new Error("Projection payload exceeds 10 MiB");
    }
    await this.exclusive(() =>
      postgresExecutionTransaction(this.client, async (tx) => {
        await this.lock(tx);
        const accepted = await tx.runtimeRevision.findFirst({
          where: { ...this.scope, revision: value },
          select: { revision: true },
        });
        if (!accepted) throw new Error("Projection revision does not exist");
        const existing = await tx.runtimeProjection.findFirst({
          where: { ...this.scope, revision: value },
        });
        if (existing) {
          if (existing.digest !== digest || existing.payload !== payload) {
            throw new Error(
              "Projection snapshot already exists with different content",
            );
          }
          return;
        }
        await tx.runtimeProjection.create({
          data: {
            ...this.scope,
            revision: value,
            digest,
            payload,
            recordedAt: new Date(),
          },
        });
      })
    );
  }

  async loadProjection(revision: number): Promise<ProjectionSnapshot | null> {
    const value = postgresBigInt(revision);
    return await this.exclusive(async () => {
      const row = await this.client.runtimeProjection.findFirst({
        where: { ...this.scope, revision: value },
      });
      return row
        ? {
          revision: postgresSafeInteger(row.revision),
          digest: row.digest,
          recordedAt: row.recordedAt.toISOString(),
          graph: JSON.parse(row.payload),
        }
        : null;
    });
  }

  /** Header/byte inspection happens in PostgreSQL, before any large text is
   * materialized. Cancellation is checked between bounded queries, and never
   * interrupts another adapter's query on the host-owned shared pool. */
  async readNetworkImpactEvidence(
    input: BoundedNetworkImpactEvidenceInput,
  ): Promise<BoundedNetworkImpactEvidenceRead> {
    assertNetworkImpactEvidenceBudget(input);
    const budget = { ...input };
    return await this.exclusive(() =>
      this.client.$transaction(async (tx) => {
        const result = emptyNetworkImpactEvidenceRead();
        const issue = (code: string, message: string) => {
          result.complete = false;
          if (!result.issues.some((entry) => entry.code === code)) {
            result.issues.push({ code, message });
          }
        };
        const checkpoint = () => {
          if (!budget.signal?.aborted) return true;
          issue("EVIDENCE_ABORTED", "The evidence read was interrupted.");
          return false;
        };
        if (!checkpoint()) return result;
        const bounds = await tx.runtimeRevision.aggregate({
          where: this.scope,
          _min: { revision: true },
          _max: { revision: true },
        });
        result.revisionBounds = {
          from: bounds._min.revision === null
            ? null
            : postgresSafeInteger(bounds._min.revision),
          to: bounds._max.revision === null
            ? null
            : postgresSafeInteger(bounds._max.revision),
        };
        if (!checkpoint()) return result;
        const table = postgresQualifiedTable(this.client, "RuntimeRevision");
        const rows = await tx.$queryRaw<
          Array<
            {
              revision: bigint;
              storedBytes: number;
              origin: string;
              header: string;
            }
          >
        >(Prisma.sql`
        SELECT "revision", octet_length("payload") AS "storedBytes", "origin", left("payload", ${RUNTIME_SNAPSHOT_HEADER_CHARS}::integer) AS "header"
        FROM ${table}
        WHERE "projectId" = ${this.scope.projectId} AND "systemId" = ${this.scope.systemId}
          AND "executionSpaceId" = ${this.scope.executionSpaceId} AND "operatorId" = ${this.scope.operatorId}
        ORDER BY "revision" DESC LIMIT ${budget.maxSnapshots + 1}
      `);
        if (rows.length > budget.maxSnapshots) {
          issue(
            "EVIDENCE_SNAPSHOT_LIMIT",
            "Older state history was omitted from the bounded recent snapshot window.",
          );
          rows.length = budget.maxSnapshots;
        }
        rows.reverse();
        if (!rows.length) {
          issue(
            "EVIDENCE_SOURCE_EMPTY",
            "The state history contains no snapshots.",
          );
        }
        for (const row of rows) {
          if (!checkpoint()) break;
          result.snapshotsRead++;
          if (row.origin === "legacy_backfill") {
            issue(
              "LEGACY_HISTORY_MISSING",
              "A legacy baseline does not establish earlier execution history.",
            );
          }
          let bytes: number;
          try {
            bytes = runtimeSnapshotPayloadInfo(row.header, row.storedBytes)
              .decodedBytes;
          } catch {
            issue(
              "EVIDENCE_PAYLOAD_INVALID",
              "A state snapshot encoding is invalid.",
            );
            continue;
          }
          if (bytes > budget.maxPayloadBytes) {
            issue(
              "EVIDENCE_PAYLOAD_LIMIT",
              "A state snapshot exceeds the payload budget.",
            );
            continue;
          }
          if (result.bytesRead + bytes > budget.maxTotalBytes) {
            issue(
              "EVIDENCE_BYTE_LIMIT",
              "The total evidence byte budget was reached.",
            );
            break;
          }
          result.bytesRead += bytes;
          const snapshot = await tx.runtimeRevision.findFirst({
            where: { ...this.scope, revision: row.revision },
            select: { payload: true },
          });
          if (!checkpoint()) break;
          try {
            if (!snapshot) throw new Error("Missing snapshot");
            const json = decodeRuntimeSnapshotPayload(snapshot.payload, bytes);
            result.snapshots.push({
              revision: postgresSafeInteger(row.revision),
              payload: json,
            });
          } catch {
            issue(
              "EVIDENCE_PAYLOAD_INVALID",
              "A state snapshot encoding is invalid.",
            );
          }
        }
        return result;
      }, { isolationLevel: "RepeatableRead" })
    );
  }

  /** Only close this handle. The shared Prisma client belongs to the host. */
  async close(): Promise<void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => release = resolve);
    await previous;
    try {
      this.closed = true;
    } finally {
      release();
    }
  }
}

export default PostgresSystemStateStore;
