import {
  assertScopedSoftwareAdmissionEvidence,
  parseScopedSoftwareSourceAdmission,
  scopedSoftwareSourceAdmissionDigest,
  type ScopedSoftwareSourceAdmissionV2,
} from "../../../application/model/source-admission/scoped-software-source-admission.ts";
import { parseScopedSoftwareWriteDossier } from "../../../application/model/publication/scoped-software-write.ts";
import {
  parseScopedSoftwareDossier,
  type ScopedSoftwareEvolutionDossierV2,
} from "../../../application/model/evolution/scoped-software-dossier.ts";
import type { ScopedSoftwareSourcePublicationContext } from "../../../application/model/publication/ports/out/scoped-software-source-publication.port.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { RequestSpaceError } from "../../../domain/work/request-spaces/scope.ts";
import { postgresQualifiedTable, Prisma, type PrismaClient } from "./client.ts";
import {
  decodePostgresOpening,
  type PostgresOpeningRow,
} from "./request-space-store.ts";
import { PostgresRequestSourceAdmissionStore } from "./request-source-admission-store.ts";

type Tx = Prisma.TransactionClient;
/** Must re-read prior admitted authority, all three native grants and ordinary
 * source-edit rights while the host's runtime reservations remain held. */
export interface ScopedSoftwareCurrentPublicationAuthority {
  /** Acquire PRIMARY before native/control locks; this does not itself grant authority. */
  lockPrimary(tx: Tx): Promise<void>;
  assertAdmissionLocked(
    tx: Tx,
    evolution: ScopedSoftwareEvolutionDossierV2,
  ): Promise<void>;
  prepareCurrent(evolution: ScopedSoftwareEvolutionDossierV2): Promise<object>;
  assertCurrentPreparedLocked(
    tx: Tx,
    evolution: ScopedSoftwareEvolutionDossierV2,
    token: object,
  ): Promise<void>;
}
const refused = () =>
  new RequestSpaceError(
    "ADMISSION_REFUSED",
    "Scoped software source publication is unavailable",
  );

/** Transactional durable source/queue join for adoption. Git anchors must be
 * verified separately by the trusted Git facade before publication is settled. */
export async function readScopedSoftwareSourceAdmissionProof(
  tx: Tx,
  client: PrismaClient,
  input: {
    revision: number;
    manifestDigest: string;
    payload: ScopedSoftwareSourceAdmissionV2;
  },
) {
  const receipt = structuredClone(input),
    admission = await parseScopedSoftwareSourceAdmission(receipt.payload),
    d = admission.destination;
  if (
    !Number.isSafeInteger(receipt.revision) || receipt.revision < 2 ||
    await scopedSoftwareSourceAdmissionDigest(admission) !==
      receipt.manifestDigest
  ) throw refused();
  const manifest = await tx.spaceManifest.findUnique({
    where: {
      projectId_systemId_executionSpaceId_revision: {
        ...d.host,
        executionSpaceId: d.executionSpaceId,
        revision: BigInt(receipt.revision),
      },
    },
  });
  if (
    !manifest || manifest.kind !== "source-admission" ||
    manifest.digest !== receipt.manifestDigest ||
    manifest.payload !== canonical(admission)
  ) throw refused();
  const locked = await tx.$queryRaw<Array<{ command_id: string }>>(
    Prisma.sql`SELECT command_id FROM ${
      postgresQualifiedTable(client, "ModelWriteCommand")
    }
    WHERE project_id=${d.host.projectId} AND system_id=${d.host.systemId} AND repository_id=${admission.command.repositoryId} AND command_id=${admission.command.commandId} FOR SHARE`,
  );
  if (locked.length !== 1) throw refused();
  const row = await tx.modelWriteCommand.findUnique({
    where: {
      projectId_systemId_repositoryId_commandId: {
        ...d.host,
        repositoryId: admission.command.repositoryId,
        commandId: admission.command.commandId,
      },
    },
  });
  if (
    !row || row.state !== "published" ||
    row.publishedVersion !== admission.result.source.version ||
    row.commandDigest !== admission.commandDigest ||
    row.dossierDigest !== admission.writeDossierDigest ||
    row.commandJson !== canonical(admission.command)
  ) throw refused();
  const dossier = await parseScopedSoftwareWriteDossier(
    JSON.parse(row.dossierJson),
  );
  if (row.dossierJson !== canonical(dossier)) throw refused();
  const evolutions = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM ${
      postgresQualifiedTable(client, "EvolutionDossier")
    }
    WHERE "projectId"=${d.host.projectId} AND "systemId"=${d.host.systemId} AND "id"=${admission.evolutionDossierId} FOR SHARE`,
  );
  if (evolutions.length !== 1) throw refused();
  const evolutionRow = await tx.evolutionDossier.findUnique({
    where: {
      projectId_systemId_id: { ...d.host, id: admission.evolutionDossierId },
    },
  });
  if (
    !evolutionRow || evolutionRow.kind !== "software-evolution-scoped-v2" ||
    evolutionRow.executionSpaceId !== d.executionSpaceId ||
    evolutionRow.repositoryId !== d.repositoryId
  ) throw refused();
  const evolution = await parseScopedSoftwareDossier(
    JSON.parse(evolutionRow.payload),
  );
  if (
    evolutionRow.payload !== canonical(evolution) ||
    evolutionRow.status !== evolution.status
  ) throw refused();
  await assertScopedSoftwareAdmissionEvidence(admission, dossier, evolution);
  return {
    admission,
    dossier,
    evolution,
    revision: receipt.revision,
    manifestDigest: receipt.manifestDigest,
  };
}

/** W3 calls these methods only under its queue fence. The Git facade must
 * independently verify exact software anchors before historical settlement. */
export class PostgresScopedSoftwareSourcePublicationParticipant {
  private readonly admissions: PostgresRequestSourceAdmissionStore;
  constructor(
    private readonly client: PrismaClient,
    private readonly authority: ScopedSoftwareCurrentPublicationAuthority,
  ) {
    this.admissions = new PostgresRequestSourceAdmissionStore(client);
  }
  private async evidence(
    tx: Tx,
    input: ScopedSoftwareSourcePublicationContext,
  ) {
    const context = structuredClone(input);
    const d = context.admission.destination,
      id = context.admission.evolutionDossierId;
    const rows = await tx.$queryRaw<
      Array<
        {
          kind: string;
          targetScopeKey: string;
          executionSpaceId: string | null;
          repositoryId: string;
          status: string;
          payload: string;
        }
      >
    >(Prisma
      .sql`SELECT "kind","targetScopeKey","executionSpaceId","repositoryId","status","payload" FROM ${
      postgresQualifiedTable(this.client, "EvolutionDossier")
    }
      WHERE "projectId"=${d.host.projectId} AND "systemId"=${d.host.systemId} AND "id"=${id} FOR SHARE`);
    const row = rows[0];
    if (
      rows.length !== 1 || row.kind !== "software-evolution-scoped-v2" ||
      row.targetScopeKey !== `request:${d.executionSpaceId}` ||
      row.executionSpaceId !== d.executionSpaceId ||
      row.repositoryId !== d.repositoryId
    ) throw refused();
    const evolution = await parseScopedSoftwareDossier(JSON.parse(row.payload));
    if (
      row.payload !== canonical(evolution) || row.status !== evolution.status ||
      canonical(context.evolution) !== row.payload
    ) throw refused();
    const admission = await assertScopedSoftwareAdmissionEvidence(
      context.admission,
      context.dossier,
      evolution,
    );
    const openings = await tx.$queryRaw<PostgresOpeningRow[]>(
      Prisma.sql`SELECT * FROM ${
        postgresQualifiedTable(this.client, "SpaceOpening")
      }
      WHERE "projectId"=${d.host.projectId} AND "systemId"=${d.host.systemId} AND "id"=${d.openingId} FOR UPDATE`,
    );
    if (openings.length !== 1) throw refused();
    const opening = decodePostgresOpening(openings[0]);
    if (
      opening.caseId !== d.caseId ||
      opening.executionSpaceId !== d.executionSpaceId ||
      opening.branchId !== d.branchId ||
      opening.baseDigest !== admission.openingBaseDigest
    ) throw refused();
    return { context, evolution, opening };
  }
  prepareCurrent(
    input: ScopedSoftwareSourcePublicationContext,
  ): Promise<object> {
    return this.authority.prepareCurrent(input.evolution);
  }
  async assertNewLocked(
    tx: Tx,
    input: ScopedSoftwareSourcePublicationContext,
    token: object,
  ): Promise<void> {
    await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '250ms'`);
    // Native membership precedes capability/admission locks. Acquire PRIMARY
    // first, then let the current authority take its existing native locks;
    // the canonical admission guard subsequently reuses the held PRIMARY.
    await this.authority.lockPrimary(tx);
    await this.authority.assertCurrentPreparedLocked(
      tx,
      input.evolution,
      token,
    );
    await this.authority.assertAdmissionLocked(tx, input.evolution);
    const { context, evolution, opening } = await this.evidence(tx, input);
    if (
      evolution.status !== "publishing" ||
      !["admitted", "dispatched"].includes(opening.phase)
    ) throw refused();
    const d = evolution.scope.destination;
    const barriers = await tx.$queryRaw<
      Array<
        {
          operatorId: string;
          dossierId: string;
          executionSpaceId: string | null;
        }
      >
    >(Prisma.sql`SELECT "operatorId","dossierId","executionSpaceId" FROM ${
      postgresQualifiedTable(this.client, "EvolutionTargetBarrier")
    }
      WHERE "projectId"=${d.host.projectId} AND "systemId"=${d.host.systemId} AND "repositoryId"=${d.repositoryId} AND "targetScopeKey"=${`request:${d.executionSpaceId}`} AND "dossierId"=${evolution.id} FOR SHARE`);
    if (
      barriers.length !== evolution.scope.targets.length ||
      evolution.scope.targets.some((t) =>
        !barriers.some((b) =>
          b.operatorId === t.target.operatorId &&
          b.dossierId === evolution.id &&
          b.executionSpaceId === d.executionSpaceId
        )
      )
    ) throw refused();
    const chain = await this.admissions.readAdmittedSource(tx, opening);
    if (canonical(chain.head) !== canonical(context.admission.predecessor)) {
      throw refused();
    }
  }
  /** Repeat the host's current-rights check immediately before the Git effect. */
  async assertExpiryLocked(
    tx: Tx,
    input: ScopedSoftwareSourcePublicationContext,
    token: object,
  ): Promise<void> {
    const { evolution } = await this.evidence(tx, input);
    if (evolution.status !== "publishing") throw refused();
    await this.authority.assertCurrentPreparedLocked(tx, evolution, token);
    await this.authority.assertAdmissionLocked(tx, evolution);
  }
  /** The caller must already have verified the exact committed Git proof; old
   * credentials are deliberately not rechecked during historical settlement. */
  async appendLocked(
    tx: Tx,
    input: ScopedSoftwareSourcePublicationContext,
  ): Promise<void> {
    const { context, opening } = await this.evidence(tx, input);
    await this.admissions.compareAndAppendSoftware(
      tx,
      opening,
      context.admission,
    );
  }
  /** Read-only verification for recovery without a lease; no D2 backfill. */
  async verifyHistoricalLocked(
    tx: Tx,
    input: ScopedSoftwareSourcePublicationContext,
  ): Promise<void> {
    const { context, opening } = await this.evidence(tx, input);
    const chain = await this.admissions.readAdmittedSource(tx, opening);
    const receipt = chain.softwareReceipts.find((entry) =>
      entry.payload.command.commandId === context.dossier.command.commandId
    );
    if (
      !receipt || canonical(receipt.payload) !== canonical(context.admission)
    ) throw refused();
    await readScopedSoftwareSourceAdmissionProof(tx, this.client, receipt);
  }
}
