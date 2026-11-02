import { isPlainRecord as object } from "../../../domain/primitives/is-plain-record.ts";
import { hasOnlyKeys as keys } from "../../../domain/primitives/closed-record.ts";
import { isSha256Hex } from "../../../domain/primitives/execution-digest.ts";
import { postgresExecutionTransaction } from "./execution-transaction.ts";
import type { Prisma, PrismaClient } from "./client.ts";
import { postgresBigInt, postgresSafeInteger } from "./numbers.ts";
import {
  assertPostgresRuntimeScope,
  type PostgresRuntimeScope,
} from "./scope.ts";
import type { MemoryStorePort } from "../../../application/memory/ports/store.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { MemoryRecord } from "../../../domain/memory/entities/memory-record.ts";
import {
  memoryContentDigest,
  MemoryError,
  type MemoryExpectedVersion,
  memoryIdentity,
  validateMemoryContent,
} from "../../../domain/memory/governed-memory-promotion.ts";

/** Technical storage bounds, independent of the admitted model's memory policy. */
export const MAX_MEMORY_STORE_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_MEMORY_STORE_HISTORY_EVENTS = 4096;

const statuses = new Set([
  "candidate",
  "revision-requested",
  "admitted",
  "rejected",
  "withdrawn",
]);
const operationStatuses: Record<string, string> = {
  capture: "candidate",
  revise: "candidate",
  admit: "admitted",
  "request-revision": "revision-requested",
  reject: "rejected",
  withdraw: "withdrawn",
};

function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 &&
    Number.isFinite(Date.parse(value));
}

function digest(value: unknown): value is string {
  return isSha256Hex(value);
}

function version(value: unknown): boolean {
  return object(value) && keys(value, ["digest", "repositoryVersion"]) &&
    memoryIdentity(value.digest) && memoryIdentity(value.repositoryVersion);
}

function content(value: unknown): boolean {
  if (
    !object(value) ||
    !keys(value, ["text", "origin", "scope", "validUntil", "outcome"]) ||
    !object(value.origin) ||
    !keys(value.origin, ["decisionId", "sourceRefs"]) ||
    !object(value.outcome) ||
    !keys(
      value.outcome,
      value.outcome.status === "known"
        ? ["status", "summary", "evidenceRefs"]
        : ["status"],
    ) || !timestamp(value.validUntil)
  ) return false;
  try {
    validateMemoryContent(value as unknown as MemoryRecord["content"]);
    return true;
  } catch {
    return false;
  }
}

function invalid(): never {
  throw new Error("Invalid stored governed-memory representation");
}

/** Validate representation and its content hashes, never caller permissions. */
async function assertRecord(value: unknown): Promise<MemoryRecord> {
  if (
    !object(value) ||
    !keys(value, [
      "id",
      "ownerId",
      "contributorId",
      "revision",
      "digest",
      "content",
      "status",
      "createdAt",
      "updatedAt",
      "history",
    ]) ||
    !memoryIdentity(value.id) || !memoryIdentity(value.ownerId) ||
    !memoryIdentity(value.contributorId) ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 ||
    !digest(value.digest) || !content(value.content) ||
    typeof value.status !== "string" || !statuses.has(value.status) ||
    !timestamp(value.createdAt) || !timestamp(value.updatedAt) ||
    !Array.isArray(value.history) || value.history.length < 1 ||
    value.history.length > MAX_MEMORY_STORE_HISTORY_EVENTS ||
    value.revision !== value.history.length
  ) invalid();
  const seenInvocations = new Set<string>();
  let previous: MemoryRecord["history"][number] | undefined;
  for (const [index, event] of value.history.entries()) {
    if (
      !object(event) ||
      !keys(event, [
        "operation",
        "callerId",
        "behaviorId",
        "invocationId",
        "modelVersion",
        "policyId",
        "requestDigest",
        "at",
        "revision",
        "digest",
        "status",
        "content",
      ], ["reason"]) ||
      typeof event.operation !== "string" ||
      !Object.hasOwn(operationStatuses, event.operation) ||
      operationStatuses[event.operation] !== event.status ||
      !memoryIdentity(event.callerId) || !memoryIdentity(event.behaviorId) ||
      !memoryIdentity(event.invocationId) || !version(event.modelVersion) ||
      !memoryIdentity(event.policyId) || !digest(event.requestDigest) ||
      !timestamp(event.at) || event.revision !== index + 1 ||
      !digest(event.digest) || !content(event.content) ||
      (event.reason !== undefined &&
        (typeof event.reason !== "string" || !event.reason.trim()))
    ) invalid();
    const invocation = canonical([event.callerId, event.invocationId]);
    if (seenInvocations.has(invocation)) invalid();
    seenInvocations.add(invocation);
    if (index === 0) {
      if (
        event.operation !== "capture" ||
        event.callerId !== value.contributorId ||
        event.at !== value.createdAt
      ) invalid();
    } else if (
      event.operation === "capture" ||
      (event.operation !== "revise" &&
        canonical(event.content) !== canonical(previous!.content))
    ) invalid();
    if (
      event.digest !==
        await memoryContentDigest(
          value.ownerId as string,
          event.content as unknown as MemoryRecord["content"],
        )
    ) invalid();
    previous = event as unknown as MemoryRecord["history"][number];
  }
  if (
    previous!.digest !== value.digest || previous!.status !== value.status ||
    previous!.at !== value.updatedAt ||
    canonical(previous!.content) !== canonical(value.content)
  ) invalid();
  return value as unknown as MemoryRecord;
}

/** Scoped aggregate CAS and invocation reservation share one PostgreSQL commit.
 * The host owns the client and establishes the runtime namespace beforehand. */
export class PostgresGovernedMemoryStore implements MemoryStorePort {
  readonly #scope: PostgresRuntimeScope;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    private readonly client: PrismaClient,
    scope: PostgresRuntimeScope,
  ) {
    assertPostgresRuntimeScope(scope);
    this.#scope = Object.freeze({
      projectId: scope.projectId,
      systemId: scope.systemId,
      executionSpaceId: scope.executionSpaceId,
      operatorId: scope.operatorId,
    });
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.#tail.then(async () => {
      if (this.#closed) throw new Error("Governed-memory store is closed");
      return await operation();
    });
    this.#tail = work.then(() => {}, () => {});
    return work;
  }

  async #decode(
    row: { revision: bigint; digest: string; payload: string },
    ownerId: string,
    id: string,
  ): Promise<MemoryRecord> {
    if (
      typeof row.payload !== "string" ||
      new TextEncoder().encode(row.payload).byteLength >
        MAX_MEMORY_STORE_PAYLOAD_BYTES
    ) throw new Error("Corrupt governed-memory payload");
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      throw new Error("Corrupt governed-memory JSON");
    }
    const record = await assertRecord(parsed);
    if (
      record.ownerId !== ownerId || record.id !== id ||
      record.revision !== postgresSafeInteger(row.revision) ||
      record.digest !== row.digest
    ) throw new Error("Corrupt governed-memory identity, revision or digest");
    return record;
  }

  async #read(
    database: PrismaClient | Prisma.TransactionClient,
    ownerId: string,
    id: string,
  ): Promise<MemoryRecord | null> {
    const row = await database.governedMemory.findUnique({
      where: {
        projectId_systemId_executionSpaceId_operatorId_ownerId_id: {
          ...this.#scope,
          ownerId,
          id,
        },
      },
    });
    return row ? await this.#decode(row, ownerId, id) : null;
  }

  async load(ownerId: string, id: string): Promise<MemoryRecord | null> {
    if (!memoryIdentity(ownerId) || !memoryIdentity(id)) invalid();
    return await this.#exclusive(() => this.#read(this.client, ownerId, id));
  }

  async list(ownerId: string): Promise<MemoryRecord[]> {
    if (!memoryIdentity(ownerId)) invalid();
    return await this.#exclusive(async () => {
      const rows = await this.client.governedMemory.findMany({
        where: { ...this.#scope, ownerId },
        orderBy: { id: "asc" },
      });
      const records: MemoryRecord[] = [];
      for (const row of rows) {
        if (!memoryIdentity(row.id)) invalid();
        records.push(await this.#decode(row, ownerId, row.id));
      }
      return records;
    });
  }

  async save(
    record: MemoryRecord,
    expected: MemoryExpectedVersion | null,
  ): Promise<void> {
    const payload = JSON.stringify(record);
    if (
      typeof payload !== "string" ||
      new TextEncoder().encode(payload).byteLength >
        MAX_MEMORY_STORE_PAYLOAD_BYTES
    ) throw new Error("Governed-memory payload exceeds 4 MiB");
    // Snapshot all caller-owned bytes before validation yields or joins a queue.
    const captured: unknown = JSON.parse(payload);
    const expectedVersion = expected === null
      ? null
      : structuredClone(expected);
    if (
      expectedVersion !== null &&
      (!object(expectedVersion) ||
        !keys(expectedVersion, ["revision", "digest"]) ||
        !Number.isSafeInteger(expectedVersion.revision) ||
        expectedVersion.revision < 1 || !digest(expectedVersion.digest))
    ) throw new Error("Invalid expected governed-memory version");
    await this.#exclusive(async () => {
      const next = await assertRecord(captured);
      if (
        next.revision !==
          (expectedVersion === null ? 1 : expectedVersion.revision + 1)
      ) throw new Error("Invalid expected governed-memory revision");
      try {
        await postgresExecutionTransaction(this.client, async (transaction) => {
          const current = await this.#read(transaction, next.ownerId, next.id);
          if (
            expectedVersion === null
              ? current !== null
              : !current || current.revision !== expectedVersion.revision ||
                current.digest !== expectedVersion.digest
          ) {
            throw new MemoryError(
              "conflict",
              "stored revision or digest changed",
            );
          }
          if (
            current && (
              next.contributorId !== current.contributorId ||
              next.createdAt !== current.createdAt ||
              next.history.length !== current.history.length + 1 ||
              canonical(next.history.slice(0, -1)) !==
                canonical(current.history)
            )
          ) throw new MemoryError("conflict", "stored memory history changed");
          for (
            const event of next.history.slice(current?.history.length ?? 0)
          ) {
            const key = {
              ...this.#scope,
              ownerId: next.ownerId,
              callerId: event.callerId,
              invocationId: event.invocationId,
            };
            const reserved = await transaction.memoryInvocation.findUnique({
              where: {
                projectId_systemId_executionSpaceId_operatorId_ownerId_callerId_invocationId:
                  key,
              },
            });
            if (reserved) {
              if (
                reserved.noteId !== next.id ||
                reserved.requestDigest !== event.requestDigest
              ) {
                throw new MemoryError(
                  "conflict",
                  "native invocation already identifies another note or request",
                );
              }
            } else {
              await transaction.memoryInvocation.create({
                data: {
                  ...key,
                  noteId: next.id,
                  requestDigest: event.requestDigest,
                },
              });
            }
          }
          const key = { ...this.#scope, ownerId: next.ownerId, id: next.id };
          const data = {
            revision: postgresBigInt(next.revision),
            digest: next.digest,
            payload,
          };
          if (current) {
            const changed = await transaction.governedMemory.updateMany({
              where: {
                ...key,
                revision: postgresBigInt(expectedVersion!.revision),
                digest: expectedVersion!.digest,
              },
              data,
            });
            if (changed.count !== 1) {
              throw new MemoryError(
                "conflict",
                "stored revision or digest changed",
              );
            }
          } else {
            await transaction.governedMemory.create({
              data: { ...key, ...data },
            });
          }
        }, { isolationLevel: "Serializable" });
      } catch (error) {
        if (
          object(error) && (error.code === "P2002" || error.code === "P2034")
        ) {
          throw new MemoryError(
            "conflict",
            "stored memory or invocation changed",
          );
        }
        throw error;
      }
    });
  }

  /** Drain this handle only; disconnecting the shared pool belongs to the host. */
  close(): Promise<void> {
    const work = this.#tail.then(() => {
      this.#closed = true;
    });
    this.#tail = work;
    return work;
  }
}
