import type { OpeningStorePort } from "../../../application/work/request-spaces/ports.ts";
import type { SupervisionOpeningStorePort } from "../../../application/work/request-spaces/supervision.ts";
import {
  assertBaseForChoice,
  assertOpeningBase,
  OPENING_PHASES,
  type OpeningRecord,
} from "../../../domain/work/request-spaces/opening.ts";
import {
  requestSpaceDigest,
  RequestSpaceError,
  type RequestSpaceScope,
} from "../../../domain/work/request-spaces/scope.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { postgresQualifiedTable, Prisma, type PrismaClient } from "./client.ts";
import { postgresSafeInteger } from "./numbers.ts";
import { assertPostgresSystemScope } from "./scope.ts";

type Row = {
  id: string;
  projectId: string;
  systemId: string;
  ownerId: string;
  commandJson: string;
  commandDigest: string;
  caseId: string;
  caseNumber: bigint;
  executionSpaceId: string;
  branchId: string;
  initialContributionId: string;
  baseJson: string | null;
  baseDigest: string | null;
  phase: OpeningRecord["phase"];
  admissionId: string | null;
  revision: number;
  issuesJson: string;
  createdAt: Date;
};
export function decodeRequestSpaceOpening(
  row: Omit<Row, "phase"> & { phase: string },
): OpeningRecord {
  if (!OPENING_PHASES.includes(row.phase as OpeningRecord["phase"])) {
    throw new RequestSpaceError(
      "UNAVAILABLE",
      "The Request opening phase is invalid.",
    );
  }
  return {
    id: row.id,
    scope: { projectId: row.projectId, systemId: row.systemId },
    ownerId: row.ownerId,
    command: JSON.parse(row.commandJson),
    commandDigest: row.commandDigest,
    caseId: row.caseId,
    caseNumber: postgresSafeInteger(row.caseNumber),
    executionSpaceId: row.executionSpaceId,
    branchId: row.branchId,
    initialContributionId: row.initialContributionId,
    base: row.baseJson ? JSON.parse(row.baseJson) : null,
    baseDigest: row.baseDigest,
    phase: row.phase as OpeningRecord["phase"],
    admissionId: row.admissionId,
    revision: row.revision,
    issues: JSON.parse(row.issuesJson),
    createdAt: row.createdAt.toISOString(),
  };
}
const conflict = () =>
  new RequestSpaceError(
    "OPENING_CONFLICT",
    "The opening identity or exact command differs.",
  );
export class PostgresRequestSpaceStore
  implements OpeningStorePort, SupervisionOpeningStorePort {
  private readonly scope: RequestSpaceScope;
  constructor(
    private readonly client: PrismaClient,
    scope: RequestSpaceScope,
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {
    assertPostgresSystemScope(scope);
    this.scope = Object.freeze({ ...scope });
  }
  private table() {
    return postgresQualifiedTable(this.client, "SpaceOpening");
  }
  private async row(
    tx: Prisma.TransactionClient | PrismaClient,
    id: string,
    lock = false,
  ): Promise<Row | null> {
    const rows = await tx.$queryRaw<Row[]>(
      Prisma
        .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "id"=${id} ${
        lock ? Prisma.sql`FOR UPDATE` : Prisma.empty
      }`,
    );
    return rows[0] ?? null;
  }
  async begin(
    input: Parameters<OpeningStorePort["begin"]>[0],
  ): Promise<OpeningRecord> {
    if (
      input.commandDigest !==
        await requestSpaceDigest({
          scope: this.scope,
          ownerId: input.ownerId,
          command: input.command,
        })
    ) throw conflict();
    return await this.client.$transaction(async (tx) => {
      // Serialize a command key without taking a parent FK lock. Distinct keys
      // keep their own identities; the existing CaseSequence serializes numbers.
      const key = canonical({
        ...this.scope,
        ownerId: input.ownerId,
        openingKey: input.command.openingKey,
      });
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
      );
      const existing = await tx.$queryRaw<Row[]>(
        Prisma
          .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "ownerId"=${input.ownerId} AND "openingKey"=${input.command.openingKey}`,
      );
      if (existing[0]) {
        if (existing[0].commandDigest !== input.commandDigest) throw conflict();
        return decodeRequestSpaceOpening(existing[0]);
      }
      // Same system-wide sequence and allocation transition as
      // PostgresCaseNumberAllocator. No second counter or per-space sequence.
      await tx.caseSequence.createMany({
        data: [{ ...this.scope, lastNumber: 0n }],
        skipDuplicates: true,
      });
      const advanced = await tx.caseSequence.updateMany({
        where: {
          ...this.scope,
          lastNumber: { gte: 0n, lt: BigInt(Number.MAX_SAFE_INTEGER) },
        },
        data: { lastNumber: { increment: 1n } },
      });
      if (advanced.count !== 1) {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "The Case number sequence is unavailable.",
        );
      }
      const sequence = await tx.caseSequence.findUniqueOrThrow({
        where: { projectId_systemId: this.scope },
      });
      const caseNumber = postgresSafeInteger(sequence.lastNumber);
      const id = this.id(),
        caseId = this.id(),
        executionSpaceId = this.id(),
        branchId = this.id(),
        contribution = this.id();
      await tx.caseIdentity.create({
        data: { ...this.scope, caseId, number: sequence.lastNumber },
      });
      // ExecutionSpace lifecycle is active/closed only. Active identifies an
      // available scope, not permission to execute; SpaceOpening.phase and the
      // separate admission keep provisioning inert until ROOT connects dispatch.
      await tx.executionSpace.create({
        data: {
          ...this.scope,
          executionSpaceId,
          caseId,
          parentExecutionSpaceId: "main",
          lifecycle: "active",
        },
      });
      const rows = await tx.$queryRaw<Row[]>(
        Prisma
          .sql`INSERT INTO ${this.table()} ("id","projectId","systemId","ownerId","openingKey","commandDigest","commandJson","caseId","caseNumber","executionSpaceId","branchId","initialContributionId") VALUES (${id},${this.scope.projectId},${this.scope.systemId},${input.ownerId},${input.command.openingKey},${input.commandDigest},${
          canonical(input.command)
        },${caseId},${
          BigInt(caseNumber)
        },${executionSpaceId},${branchId},${contribution}) RETURNING *`,
      );
      return decodeRequestSpaceOpening(rows[0]);
    });
  }
  async selectBase(
    input: Parameters<OpeningStorePort["selectBase"]>[0],
  ): Promise<OpeningRecord> {
    assertOpeningBase(input.base);
    if (
      await requestSpaceDigest(input.base) !== input.baseDigest ||
      await requestSpaceDigest(input.base.manifest) !==
        input.base.manifestDigest
    ) throw conflict();
    return await this.client.$transaction(async (tx) => {
      const row = await this.row(tx, input.id, true);
      if (!row || row.ownerId !== input.ownerId) throw conflict();
      if (
        row.baseJson !== null || row.revision !== input.expectedRevision ||
        row.phase !== "allocated"
      ) return decodeRequestSpaceOpening(row);
      assertBaseForChoice(input.base, JSON.parse(row.commandJson).source);
      if (
        input.base.manifest.origin.projectId !== this.scope.projectId ||
        input.base.manifest.origin.systemId !== this.scope.systemId
      ) throw conflict();
      const existing = await tx.spaceManifest.findUnique({
        where: {
          projectId_systemId_executionSpaceId_revision: {
            ...this.scope,
            executionSpaceId: row.executionSpaceId,
            revision: 1n,
          },
        },
      });
      if (
        existing &&
        (existing.kind !== "baseline" ||
          existing.digest !== input.base.manifestDigest ||
          existing.payload !== canonical(input.base.manifest))
      ) throw conflict();
      await tx.spaceManifest.createMany({
        data: [{
          ...this.scope,
          executionSpaceId: row.executionSpaceId,
          revision: 1n,
          kind: "baseline",
          digest: input.base.manifestDigest,
          payload: canonical(input.base.manifest),
        }],
        skipDuplicates: true,
      });
      const rows = await tx.$queryRaw<Row[]>(
        Prisma.sql`UPDATE ${this.table()} SET "baseJson"=${
          canonical(input.base)
        },"baseDigest"=${input.baseDigest},"phase"='source-selected',"issuesJson"='[]',"revision"="revision"+1 WHERE "id"=${row.id} AND "revision"=${input.expectedRevision} RETURNING *`,
      );
      if (!rows[0]) throw conflict();
      return decodeRequestSpaceOpening(rows[0]);
    });
  }
  async advance(
    input: Parameters<OpeningStorePort["advance"]>[0],
  ): Promise<OpeningRecord> {
    if (
      OPENING_PHASES.indexOf(input.to) !==
        OPENING_PHASES.indexOf(input.from) + 1
    ) throw conflict();
    return await this.client.$transaction(async (tx) => {
      const row = await this.row(tx, input.id, true);
      if (!row || row.ownerId !== input.ownerId) throw conflict();
      if (row.revision !== input.expectedRevision || row.phase !== input.from) {
        return decodeRequestSpaceOpening(row);
      }
      const admissionId = input.admissionId ?? row.admissionId;
      if (input.to === "admitted") {
        const admissions = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM ${
            postgresQualifiedTable(this.client, "SpaceExecutionAdmission")
          } WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "executionSpaceId"=${row.executionSpaceId} AND "openingId"=${row.id} AND "ownerId"=${row.ownerId} AND "id"=${admissionId} AND "status"='active'`,
        );
        if (!admissions[0]) {
          throw new RequestSpaceError(
            "ADMISSION_REFUSED",
            "The exact space admission is unavailable.",
          );
        }
        const space = await tx.executionSpace.findUnique({
          where: {
            projectId_systemId_executionSpaceId: {
              ...this.scope,
              executionSpaceId: row.executionSpaceId,
            },
          },
        });
        if (
          !space || space.caseId !== row.caseId ||
          space.lifecycle !== "active" || space.closedAt !== null
        ) {
          throw new RequestSpaceError(
            "ADMISSION_REFUSED",
            "The Request execution space is closed or unavailable.",
          );
        }
        // Admission changes no lifecycle state and never reopens a closed space.
      }
      const rows = await tx.$queryRaw<Row[]>(
        Prisma
          .sql`UPDATE ${this.table()} SET "phase"=${input.to},"admissionId"=${admissionId},"issuesJson"='[]',"revision"="revision"+1 WHERE "id"=${row.id} AND "revision"=${input.expectedRevision} RETURNING *`,
      );
      if (!rows[0]) throw conflict();
      return decodeRequestSpaceOpening(rows[0]);
    });
  }
  async issue(
    input: Parameters<OpeningStorePort["issue"]>[0],
  ): Promise<OpeningRecord> {
    if (!/^[A-Z_]{1,64}$/.test(input.code)) throw conflict();
    const rows = await this.client.$queryRaw<Row[]>(
      Prisma.sql`UPDATE ${this.table()} SET "issuesJson"=${
        JSON.stringify([input.code])
      },"revision"="revision"+1 WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "ownerId"=${input.ownerId} AND "id"=${input.id} AND "revision"=${input.expectedRevision} AND "phase"<>'dispatched' RETURNING *`,
    );
    if (rows[0]) return decodeRequestSpaceOpening(rows[0]);
    const row = await this.row(this.client, input.id);
    if (!row || row.ownerId !== input.ownerId) throw conflict();
    return decodeRequestSpaceOpening(row);
  }
  async get(id: string): Promise<OpeningRecord | null> {
    const row = await this.row(this.client, id);
    return row ? decodeRequestSpaceOpening(row) : null;
  }
  /** Host-scoped owner listing; read authorization is checked by the application. */
  async forOwner(ownerId: string): Promise<OpeningRecord[]> {
    const rows = await this.client.$queryRaw<Row[]>(
      Prisma
        .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "ownerId"=${ownerId} AND "phase" IN ('runtime-ready','admitted','dispatched') ORDER BY "createdAt" DESC, "caseNumber" DESC`,
    );
    return rows.map(decodeRequestSpaceOpening);
  }
  /** Bounded keyset discovery for operational supervision, within the fixed
   * host + authenticated owner. Case numbers are immutable and system-unique. */
  async pageForOwner(
    ownerId: string,
    query: { limit: number; beforeCaseNumber?: number },
  ): Promise<OpeningRecord[]> {
    if (
      !Number.isSafeInteger(query.limit) || query.limit < 1 ||
      query.limit > 51 ||
      (query.beforeCaseNumber !== undefined &&
        (!Number.isSafeInteger(query.beforeCaseNumber) ||
          query.beforeCaseNumber < 1))
    ) {
      throw new RequestSpaceError(
        "INVALID_COMMAND",
        "A bounded opening page is required.",
      );
    }
    const rows = await this.client.$queryRaw<Row[]>(
      Prisma
        .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "ownerId"=${ownerId} AND "phase" IN ('runtime-ready','admitted','dispatched') ${
        query.beforeCaseNumber === undefined
          ? Prisma.empty
          : Prisma.sql`AND "caseNumber" < ${BigInt(query.beforeCaseNumber)}`
      } ORDER BY "caseNumber" DESC LIMIT ${query.limit}`,
    );
    return rows.map(decodeRequestSpaceOpening);
  }
  /** Host-scoped Cases of admitted Requests, for authority replay only. */
  async openCaseIds(): Promise<string[]> {
    const rows = await this.client.$queryRaw<Array<{ caseId: string }>>(
      Prisma
        .sql`SELECT "caseId" FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "phase" IN ('admitted','dispatched') AND "caseId" IS NOT NULL ORDER BY "caseNumber" ASC`,
    );
    return rows.map((row) => row.caseId);
  }
  async forCase(caseId: string): Promise<OpeningRecord | null> {
    const rows = await this.client.$queryRaw<Row[]>(
      Prisma
        .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "caseId"=${caseId}`,
    );
    return rows[0] ? decodeRequestSpaceOpening(rows[0]) : null;
  }
}

/** Shared by transactional Request publication; no initialization or I/O. */
export { decodeRequestSpaceOpening as decodePostgresOpening };
export type { Row as PostgresOpeningRow };
