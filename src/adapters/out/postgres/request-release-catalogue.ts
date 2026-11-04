import type {
  RequestReleaseCataloguePort,
  ScopedSavedSystemRecord,
} from "../../../application/work/saved-systems/request-release-ports.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { RequestSpaceScope } from "../../../domain/work/request-spaces/scope.ts";
import { SavedSystemError } from "../../../domain/work/records/saved-systems.ts";
import { postgresQualifiedTable, Prisma, type PrismaClient } from "./client.ts";
import {
  decodeSavedSystemRow,
  type SavedSystemRow,
} from "./saved-system-store.ts";

type OriginRow = SavedSystemRow & {
  projectId: string;
  systemId: string;
  executionSpaceId: string;
  openingCaseId: string | null;
  openingOwnerId: string | null;
};

/** Read projection over the existing SavedSystem table, not another registry.
 * The actual origin is recovered by a host/owner-scoped join; no browser scope
 * or native operator identifier participates in its authorization. */
export class PostgresRequestReleaseCatalogue
  implements RequestReleaseCataloguePort {
  constructor(
    private readonly client: PrismaClient,
    private readonly host: RequestSpaceScope,
  ) {}

  private decode(row: OriginRow, ownerId: string): ScopedSavedSystemRecord {
    const scope = {
      projectId: row.projectId,
      systemId: row.systemId,
      executionSpaceId: row.executionSpaceId,
    };
    const {
      projectId: _project,
      systemId: _system,
      executionSpaceId: _space,
      openingCaseId: _case,
      openingOwnerId: _owner,
      ...stored
    } = row;
    const record = decodeSavedSystemRow(stored);
    if (
      scope.projectId !== this.host.projectId ||
      scope.systemId !== this.host.systemId ||
      canonical(record.capture.origin) !== canonical(scope) ||
      !record.capture.source ||
      (scope.executionSpaceId === "main"
        ? record.capture.source.branch.kind !== "main"
        : row.openingOwnerId !== ownerId || !row.openingCaseId ||
          record.capture.source.branch.kind !== "case" ||
          record.capture.source.branch.caseId !== row.openingCaseId)
    ) {
      throw new SavedSystemError(
        "UNAVAILABLE",
        "The Release origin is unavailable.",
      );
    }
    return { scope, record };
  }

  async listOwned(
    ownerId: string,
    caseId?: string,
  ): Promise<ScopedSavedSystemRecord[]> {
    const selected = caseId === undefined
      ? Prisma.empty
      : Prisma.sql`AND opening."caseId"=${caseId}`;
    const rows = await this.client.$queryRaw<OriginRow[]>(Prisma.sql`
      SELECT saved.*, opening."caseId" AS "openingCaseId", opening."ownerId" AS "openingOwnerId"
      FROM ${postgresQualifiedTable(this.client, "SavedSystem")} saved
      INNER JOIN ${postgresQualifiedTable(this.client, "SpaceOpening")} opening
        ON opening."projectId"=saved."projectId" AND opening."systemId"=saved."systemId"
        AND opening."executionSpaceId"=saved."executionSpaceId"
      WHERE saved."projectId"=${this.host.projectId} AND saved."systemId"=${this.host.systemId}
        AND saved."executionSpaceId"<>'main' AND opening."ownerId"=${ownerId} ${selected}
      ORDER BY saved."createdAt" DESC, saved."id" DESC LIMIT 100
    `);
    return rows.map((row) => this.decode(row, ownerId));
  }

  async selected(
    ownerId: string,
    id: string,
  ): Promise<ScopedSavedSystemRecord | null> {
    const rows = await this.client.$queryRaw<OriginRow[]>(Prisma.sql`
      SELECT saved.*, opening."caseId" AS "openingCaseId", opening."ownerId" AS "openingOwnerId"
      FROM ${postgresQualifiedTable(this.client, "SavedSystem")} saved
      LEFT JOIN ${postgresQualifiedTable(this.client, "SpaceOpening")} opening
        ON opening."projectId"=saved."projectId" AND opening."systemId"=saved."systemId"
        AND opening."executionSpaceId"=saved."executionSpaceId"
      WHERE saved."projectId"=${this.host.projectId} AND saved."systemId"=${this.host.systemId}
        AND saved."id"=${id}
        AND (saved."executionSpaceId"='main' OR opening."ownerId"=${ownerId})
      LIMIT 1
    `);
    return rows[0] ? this.decode(rows[0], ownerId) : null;
  }
}
