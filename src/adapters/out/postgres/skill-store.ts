import { isPlainRecord as object } from "../../../domain/primitives/is-plain-record.ts";
import { hasOnlyKeys as keys } from "../../../domain/primitives/closed-record.ts";
import { postgresExecutionTransaction } from "./execution-transaction.ts";
import type { PrismaClient } from "./client.ts";
import { postgresQualifiedTable, Prisma } from "./client.ts";
import { postgresBigInt, postgresSafeInteger } from "./numbers.ts";
import {
  assertPostgresRuntimeScope,
  type PostgresRuntimeScope,
} from "./scope.ts";
import type { SkillStorePort } from "../../../application/skills/ports.ts";
import {
  assertNetworkImpactEvidenceBudget,
  type BoundedNetworkImpactEvidenceInput,
  type BoundedNetworkImpactEvidenceRead,
  emptyNetworkImpactEvidenceRead,
} from "../../../application/model/impact/evidence-sources.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  skillContentDigest,
  skillDigest,
  SkillError,
  skillIdentity,
} from "../../../domain/skills/context-skills.ts";
import type {
  SkillCatalogRecord,
} from "../../../domain/skills/records/catalog.ts";
import type { SkillRecord } from "../../../domain/skills/entities/skill.ts";
import { validateSourceBindingReference } from "../../../domain/work/artifacts/source-reference.ts";

/** Technical storage limits fail explicitly and never trim instruction text. */
export const MAX_SKILL_STORE_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const MAX_SKILL_STORE_OPERATIONS = 4096;

function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
function noControls(value: string): boolean {
  return Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
}
function version(value: unknown): boolean {
  return object(value) && keys(value, ["digest", "repositoryVersion"]) &&
    skillIdentity(value.digest) && skillIdentity(value.repositoryVersion);
}
function https(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.hash && (!url.port || url.port === "443");
  } catch {
    return false;
  }
}
function invalid(): never {
  throw new Error("Invalid stored context-skills representation");
}
function immutable(record: SkillRecord) {
  const { loaded: _loaded, loadedAt: _at, loadedBy: _version, ...fixed } =
    record;
  return fixed;
}

/** Decode the complete owner aggregate and reconstruct its load state from its
 * immutable operation log. No stored field supplies application authority. */
async function assertCatalog(value: unknown): Promise<SkillCatalogRecord> {
  if (
    !object(value) ||
    !keys(value, ["ownerId", "revision", "skills", "operations"]) ||
    !skillIdentity(value.ownerId) || !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 || !Array.isArray(value.skills) ||
    value.skills.length < 1 || value.skills.length > 128 ||
    !Array.isArray(value.operations) || value.operations.length < 1 ||
    value.operations.length > MAX_SKILL_STORE_OPERATIONS ||
    value.revision !== value.operations.length
  ) invalid();
  const skillMap = new Map<string, SkillRecord>();
  for (const raw of value.skills) {
    if (
      !object(raw) ||
      !keys(raw, [
        "id",
        "name",
        "description",
        "digest",
        "byteLength",
        "content",
        "source",
        "installedAt",
        "loaded",
      ], ["loadedAt", "loadedBy", "sourceBinding"]) ||
      !skillIdentity(raw.id) || skillMap.has(raw.id) ||
      typeof raw.name !== "string" || !raw.name.trim() ||
      raw.name.length > 200 ||
      typeof raw.description !== "string" || raw.description.length > 1000 ||
      !skillDigest(raw.digest) || typeof raw.content !== "string" ||
      !raw.content.trim() || raw.content.includes("\u0000") ||
      new TextEncoder().encode(raw.content).length > 1_048_576 ||
      raw.byteLength !== new TextEncoder().encode(raw.content).length ||
      await skillContentDigest(raw.content) !== raw.digest ||
      !timestamp(raw.installedAt) || typeof raw.loaded !== "boolean" ||
      (raw.loaded
        ? !timestamp(raw.loadedAt) || !version(raw.loadedBy)
        : Object.hasOwn(raw, "loadedAt") || Object.hasOwn(raw, "loadedBy")) ||
      !object(raw.source) ||
      !keys(raw.source, ["kind", "location", "acquiredAt", "modelVersion"], [
        "requestedUrl",
        "finalUrl",
      ]) ||
      typeof raw.source.location !== "string" || !raw.source.location.trim() ||
      raw.source.location.length > 8192 ||
      !noControls(raw.source.location) ||
      !timestamp(raw.source.acquiredAt) ||
      !version(raw.source.modelVersion) ||
      (raw.source.kind === "https"
        ? !https(raw.source.requestedUrl) || !https(raw.source.finalUrl) ||
          raw.source.location !== raw.source.requestedUrl
        : raw.source.kind !== "bundled" ||
          Object.hasOwn(raw.source, "requestedUrl") ||
          Object.hasOwn(raw.source, "finalUrl"))
    ) invalid();
    if (raw.sourceBinding !== undefined) {
      try {
        validateSourceBindingReference(raw.sourceBinding);
      } catch {
        invalid();
      }
      if (
        raw.sourceBinding.ownerId !== value.ownerId ||
        raw.sourceBinding.localArtifactId !== raw.id ||
        raw.sourceBinding.reference.kind !== "skill-document" ||
        raw.sourceBinding.reference.contentDigest !== raw.digest
      ) invalid();
    }
    skillMap.set(raw.id, raw as unknown as SkillRecord);
  }
  const installed = new Set<string>();
  const invocations = new Set<string>();
  const loadState = new Map<string, { at: string; modelVersion: unknown }>();
  for (const [index, operation] of value.operations.entries()) {
    if (
      !object(operation) || !keys(operation, [
        "kind",
        "skillId",
        "skillDigest",
        "callerId",
        "behaviorId",
        "invocationId",
        "requestDigest",
        "policyId",
        "modelVersion",
        "at",
        "revision",
      ], ["initiallyLoaded"]) ||
      !["install", "load", "unload"].includes(String(operation.kind)) ||
      !skillIdentity(operation.skillId) ||
      !skillDigest(operation.skillDigest) ||
      operation.callerId !== value.ownerId ||
      !skillIdentity(operation.behaviorId) ||
      !skillIdentity(operation.invocationId) ||
      !skillDigest(operation.requestDigest) ||
      !skillIdentity(operation.policyId) || !version(operation.modelVersion) ||
      !timestamp(operation.at) || operation.revision !== index + 1 ||
      (Object.hasOwn(operation, "initiallyLoaded") &&
        (operation.kind !== "install" ||
          typeof operation.initiallyLoaded !== "boolean"))
    ) invalid();
    const record = skillMap.get(operation.skillId);
    const invocation = canonical([operation.callerId, operation.invocationId]);
    if (
      !record || record.digest !== operation.skillDigest ||
      invocations.has(invocation)
    ) invalid();
    invocations.add(invocation);
    if (operation.kind === "install") {
      if (!installed.has(record.id)) {
        if (
          operation.at !== record.installedAt ||
          canonical(operation.modelVersion) !==
            canonical(record.source.modelVersion) ||
          (record.sourceBinding !== undefined &&
            record.sourceBinding.invocationId !== operation.invocationId)
        ) invalid();
        installed.add(record.id);
        if (operation.initiallyLoaded) {
          if (record.source.kind !== "bundled") invalid();
          loadState.set(record.id, {
            at: operation.at,
            modelVersion: operation.modelVersion,
          });
        }
      } else if (Object.hasOwn(operation, "initiallyLoaded")) {
        invalid();
      }
    } else {
      if (!installed.has(record.id)) invalid();
      if (operation.kind === "load") {
        loadState.set(record.id, {
          at: operation.at,
          modelVersion: operation.modelVersion,
        });
      } else loadState.delete(record.id);
    }
  }
  for (const record of skillMap.values()) {
    const loaded = loadState.get(record.id);
    if (
      !installed.has(record.id) || record.loaded !== !!loaded ||
      (loaded &&
        (record.loadedAt !== loaded.at ||
          canonical(record.loadedBy) !== canonical(loaded.modelVersion)))
    ) invalid();
  }
  return value as unknown as SkillCatalogRecord;
}

/** Complete scoped catalogs and their invocation ledger commit atomically. */
export class PostgresContextSkillsStore implements SkillStorePort {
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
      if (this.#closed) throw new Error("Context-skills store is closed");
      return await operation();
    });
    this.#tail = work.then(() => {}, () => {});
    return work;
  }

  async #read(
    database: PrismaClient | Prisma.TransactionClient,
    ownerId: string,
  ): Promise<SkillCatalogRecord | null> {
    const row = await database.skillCatalog.findUnique({
      where: {
        projectId_systemId_executionSpaceId_operatorId_ownerId: {
          ...this.#scope,
          ownerId,
        },
      },
    });
    if (!row) return null;
    if (
      typeof row.payload !== "string" ||
      new TextEncoder().encode(row.payload).length >
        MAX_SKILL_STORE_PAYLOAD_BYTES
    ) invalid();
    let value: unknown;
    try {
      value = JSON.parse(row.payload);
    } catch {
      invalid();
    }
    const catalog = await assertCatalog(value);
    if (
      catalog.ownerId !== ownerId ||
      catalog.revision !== postgresSafeInteger(row.revision)
    ) invalid();
    return catalog;
  }

  async load(ownerId: string): Promise<SkillCatalogRecord | null> {
    if (!skillIdentity(ownerId)) invalid();
    return await this.#exclusive(() => this.#read(this.client, ownerId));
  }

  /** Read metadata before materializing bounded payload bytes, from one MVCC
   * snapshot. Cancellation is observed between bounded database statements. */
  async readNetworkImpactEvidence(
    input: BoundedNetworkImpactEvidenceInput & { ownerId: string },
  ): Promise<BoundedNetworkImpactEvidenceRead> {
    assertNetworkImpactEvidenceBudget(input);
    if (!skillIdentity(input.ownerId)) invalid();
    const budget = { ...input };
    return await this.#exclusive(async () => {
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
      const table = postgresQualifiedTable(this.client, "SkillCatalog");
      try {
        return await this.client.$transaction(async (transaction) => {
          // Prisma exposes no per-statement AbortSignal. Bound this transaction's
          // statements without cancelling another consumer of the shared pool.
          await transaction.$executeRaw`SET LOCAL statement_timeout = '5s'`;
          if (!checkpoint()) return result;
          const rows = await transaction.$queryRaw<
            Array<{ revision: bigint; bytes: bigint }>
          >(Prisma.sql`
            SELECT revision, octet_length(payload)::bigint AS bytes
            FROM ${table}
            WHERE "projectId" = ${this.#scope.projectId}
              AND "systemId" = ${this.#scope.systemId}
              AND "executionSpaceId" = ${this.#scope.executionSpaceId}
              AND "operatorId" = ${this.#scope.operatorId}
              AND "ownerId" = ${budget.ownerId}
          `);
          if (!checkpoint()) return result;
          const row = rows[0];
          if (!row) {
            issue(
              "EVIDENCE_SOURCE_EMPTY",
              "The owner has no persisted skill catalog.",
            );
            return result;
          }
          const revision = postgresSafeInteger(row.revision);
          result.revisionBounds = { from: revision, to: revision };
          result.snapshotsRead = 1;
          const bytes = postgresSafeInteger(row.bytes);
          if (bytes > budget.maxPayloadBytes) {
            issue(
              "EVIDENCE_PAYLOAD_LIMIT",
              "The skill catalog exceeds the payload budget.",
            );
            return result;
          }
          if (bytes > budget.maxTotalBytes) {
            issue(
              "EVIDENCE_BYTE_LIMIT",
              "The total evidence byte budget was reached.",
            );
            return result;
          }
          const payload = (await transaction.skillCatalog.findFirst({
            where: {
              ...this.#scope,
              ownerId: budget.ownerId,
              revision: row.revision,
            },
            select: { payload: true },
          }))?.payload;
          if (!checkpoint()) return result;
          if (typeof payload !== "string") {
            issue(
              "EVIDENCE_PAYLOAD_INVALID",
              "The skill catalog payload is unavailable.",
            );
            return result;
          }
          result.bytesRead = bytes;
          result.snapshots.push({ revision, payload });
          return result;
        }, { isolationLevel: "RepeatableRead" });
      } catch (error) {
        if (!checkpoint()) return result;
        throw error;
      }
    });
  }

  async save(
    record: SkillCatalogRecord,
    expectedRevision: number | null,
  ): Promise<void> {
    const payload = JSON.stringify(record);
    if (
      typeof payload !== "string" ||
      new TextEncoder().encode(payload).length > MAX_SKILL_STORE_PAYLOAD_BYTES
    ) throw new Error("Context-skills payload exceeds 16 MiB");
    const captured: unknown = JSON.parse(payload);
    if (
      expectedRevision !== null &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    ) throw new Error("Invalid expected context-skills revision");
    await this.#exclusive(async () => {
      const next = await assertCatalog(captured);
      if (
        next.revision !== (expectedRevision === null ? 1 : expectedRevision + 1)
      ) throw new Error("Invalid expected context-skills revision");
      try {
        await postgresExecutionTransaction(this.client, async (transaction) => {
          const current = await this.#read(transaction, next.ownerId);
          if ((current?.revision ?? null) !== expectedRevision) {
            throw new SkillError("conflict", "stored catalog revision changed");
          }
          if (current) {
            if (
              canonical(next.operations.slice(0, -1)) !==
                canonical(current.operations)
            ) throw new SkillError("conflict", "stored skill history changed");
            for (const previous of current.skills) {
              const following = next.skills.find((skill) =>
                skill.id === previous.id
              );
              if (
                !following ||
                canonical(immutable(following)) !==
                  canonical(immutable(previous))
              ) {
                throw new SkillError(
                  "conflict",
                  "installed skill content or provenance changed",
                );
              }
            }
          }
          const operation = next.operations.at(-1)!;
          const prior = current?.skills.find((skill) =>
            skill.id === operation.skillId
          );
          const target = next.skills.find((skill) =>
            skill.id === operation.skillId
          )!;
          if (
            next.skills.length !==
              (current?.skills.length ?? 0) + (prior ? 0 : 1) ||
            (!prior &&
              (operation.kind !== "install" ||
                target.loaded !== (operation.initiallyLoaded === true))) ||
            (operation.kind === "install" && prior &&
              canonical(target) !== canonical(prior)) ||
            current?.skills.some((skill) =>
              skill.id !== operation.skillId &&
              canonical(skill) !==
                canonical(next.skills.find((entry) => entry.id === skill.id))
            )
          ) {
            throw new SkillError(
              "conflict",
              "operation changed unrelated skill state",
            );
          }

          const invocationKey = {
            ...this.#scope,
            ownerId: next.ownerId,
            callerId: operation.callerId,
            invocationId: operation.invocationId,
          };
          const reserved = await transaction.skillInvocation.findUnique({
            where: {
              projectId_systemId_executionSpaceId_operatorId_ownerId_callerId_invocationId:
                invocationKey,
            },
          });
          if (reserved) {
            throw new SkillError(
              "conflict",
              "native skill invocation was already committed",
            );
          }
          await transaction.skillInvocation.create({
            data: {
              ...invocationKey,
              skillId: operation.skillId,
              requestDigest: operation.requestDigest,
              kind: operation.kind,
            },
          });
          const key = { ...this.#scope, ownerId: next.ownerId };
          const data = { revision: postgresBigInt(next.revision), payload };
          if (current) {
            const changed = await transaction.skillCatalog.updateMany({
              where: { ...key, revision: postgresBigInt(expectedRevision!) },
              data,
            });
            if (changed.count !== 1) {
              throw new SkillError(
                "conflict",
                "stored catalog revision changed",
              );
            }
          } else {
            await transaction.skillCatalog.create({
              data: { ...key, ...data },
            });
          }
        }, { isolationLevel: "Serializable" });
      } catch (error) {
        if (
          object(error) && (error.code === "P2002" || error.code === "P2034")
        ) {
          throw new SkillError(
            "conflict",
            "stored catalog or invocation changed",
          );
        }
        throw error;
      }
    });
  }

  /** Drain this handle only; the host closes the shared client once. */
  close(): Promise<void> {
    const work = this.#tail.then(() => {
      this.#closed = true;
    });
    this.#tail = work;
    return work;
  }
}
