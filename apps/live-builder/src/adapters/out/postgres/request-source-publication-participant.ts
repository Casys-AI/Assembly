import {
  isSessionlessRequestAuthority,
  requestWriteAuthorityPrior,
} from "../../../application/model/source-admission/request-delegated-authority.ts";
import { assertRequestSpaceBirth } from "../../../application/work/runtime/initialization.ts";
import { requestSpaceSeed } from "../../work/request-space-runtime.ts";
import { PostgresRequestExecutionBindingReader } from "./request-execution-binding.ts";
import type { PostgresRequestPublicationParticipant } from "../../model/repository/writing/postgres-write-queue.ts";
import type { RequestSourcePublicationContext } from "../../../application/model/publication/ports/out/request-source-publication.port.ts";
import {
  modelWriteDossierDigestV2,
  parseModelWriteDossierV2,
} from "../../../application/model/publication/write-command-v2.ts";
import {
  parseRequestSourceAdmission,
  requestNetworkAdmissionEvidence,
  type RequestSourceAdmission,
  requestSourceAdmissionDigest,
} from "../../../application/model/source-admission/request-source-admission.ts";
import { assertRequestNetworkChange } from "../../../domain/governance/records/request-network-change.ts";
import {
  assertRequestTeamChange,
  requestChangeEffect,
} from "../../../domain/governance/records/request-change.ts";
import { RequestSpaceError } from "../../../domain/work/request-spaces.ts";
import { isOpenCase } from "../../../domain/work/entities/cases.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { sameOwnerAuthorityIdentity } from "../../../domain/governance/authority.ts";
import { RequestSpaceModel } from "../../../application/work/request-spaces/request-space-model.ts";
import { postgresQualifiedTable, Prisma, type PrismaClient } from "./client.ts";
import { PostgresSpaceCredentials } from "./request-space-control-store.ts";
import { PostgresPrimarySpaceControlSource } from "./primary-space-control-source.ts";
import {
  decodePostgresOpening,
  type PostgresOpeningRow,
} from "./request-space-store.ts";
import { PostgresRequestSourceAdmissionStore } from "./request-source-admission-store.ts";
import { decodePostgresRuntimeState } from "./runtime-state-snapshot.ts";

type Tx = Prisma.TransactionClient;
const refused = () =>
  new RequestSpaceError(
    "ADMISSION_REFUSED",
    "The Request source publication is unavailable.",
  );

/** Historical exact proof for the adoption adapter. Read the durable queue
 * dossier in the caller's transaction; receipt/body fields alone grant nothing. */
export async function readRequestNetworkSourceAdmissionProof(
  tx: Tx,
  receipt: {
    readonly revision: number;
    readonly manifestDigest: string;
    readonly payload: RequestSourceAdmission;
  },
  client: PrismaClient,
) {
  return await readRequestChangeProof(tx, receipt, client, "network");
}

/** The same durable proof for one team creation (4.8e E4). */
export async function readRequestTeamSourceAdmissionProof(
  tx: Tx,
  receipt: {
    readonly revision: number;
    readonly manifestDigest: string;
    readonly payload: RequestSourceAdmission;
  },
  client: PrismaClient,
) {
  return await readRequestChangeProof(tx, receipt, client, "team-member");
}

async function readRequestChangeProof(
  tx: Tx,
  receipt: {
    readonly revision: number;
    readonly manifestDigest: string;
    readonly payload: RequestSourceAdmission;
  },
  client: PrismaClient,
  effect: "network" | "team-member",
) {
  receipt = structuredClone(receipt);
  const payload = await parseRequestSourceAdmission(receipt.payload);
  if (
    !Number.isSafeInteger(receipt.revision) || receipt.revision < 2 ||
    await requestSourceAdmissionDigest(payload) !== receipt.manifestDigest ||
    payload.command.kind !== "approved-change"
  ) throw refused();
  const manifest = await tx.spaceManifest.findUnique({
    where: {
      projectId_systemId_executionSpaceId_revision: {
        ...payload.destination.host,
        executionSpaceId: payload.destination.executionSpaceId,
        revision: BigInt(receipt.revision),
      },
    },
  });
  if (
    !manifest || manifest.kind !== "source-admission" ||
    manifest.digest !== receipt.manifestDigest ||
    manifest.payload !== canonical(payload)
  ) throw refused();
  // Intent columns and manifests are immutable, but publication state/version
  // and queue-row deletion are not. Keep this exact durable row stable through
  // the caller's adoption commit, using its configured schema rather than public.
  const locked = await tx.$queryRaw<Array<{ command_id: string }>>(Prisma.sql`
    SELECT command_id FROM ${
    postgresQualifiedTable(client, "ModelWriteCommand")
  }
    WHERE project_id = ${payload.destination.host.projectId}
      AND system_id = ${payload.destination.host.systemId}
      AND repository_id = ${payload.command.repositoryId}
      AND command_id = ${payload.command.commandId}
    FOR SHARE
  `);
  if (locked.length !== 1) throw refused();
  const row = await tx.modelWriteCommand.findUnique({
    where: {
      projectId_systemId_repositoryId_commandId: {
        ...payload.destination.host,
        repositoryId: payload.command.repositoryId,
        commandId: payload.command.commandId,
      },
    },
  });
  if (
    !row || row.state !== "published" ||
    row.publishedVersion !== payload.result.source.version ||
    row.commandDigest !== payload.commandDigest ||
    row.dossierDigest !== payload.dossierDigest ||
    row.commandJson !== canonical(payload.command)
  ) throw refused();
  const evidence = await requestNetworkAdmissionEvidence(
    payload,
    JSON.parse(row.dossierJson),
  );
  if (row.dossierJson !== canonical(evidence.dossier)) throw refused();
  const change = evidence.dossier.decision.change;
  if (requestChangeEffect(change) !== effect) throw refused();
  if (effect === "team-member") assertRequestTeamChange(change);
  else assertRequestNetworkChange(change);
  return {
    changeId: change.id,
    proposalIntentDigest: evidence.proposalIntentDigest,
    approvedChangeDigest: evidence.approvedChangeDigest,
    addedHosts: effect === "network" && change.requestedRights &&
        "addNetworkHosts" in change.requestedRights
      ? structuredClone(change.requestedRights.addNetworkHosts)
      : [],
    sourceAdmission: {
      revision: receipt.revision,
      manifestDigest: receipt.manifestDigest,
      commandId: payload.command.commandId,
      publicationReceiptDigest: payload.publication.receiptDigest,
      resultVersion: payload.result.source.version,
    },
  };
}

/** SQL participant, reachable only through the trusted queue/Git facade. A
 * well-shaped context does not itself attest a past Git effect or grant rights. */
export class PostgresRequestSourcePublicationParticipant
  implements PostgresRequestPublicationParticipant {
  private readonly credentials: PostgresSpaceCredentials;
  private readonly admissions: PostgresRequestSourceAdmissionStore;
  constructor(
    private readonly client: PrismaClient,
    private readonly primary: PostgresPrimarySpaceControlSource,
  ) {
    primary.assertClient(client);
    this.credentials = new PostgresSpaceCredentials(client, primary);
    this.admissions = new PostgresRequestSourceAdmissionStore(client);
  }
  private async context(
    input: RequestSourcePublicationContext,
  ): Promise<RequestSourcePublicationContext> {
    const owned = structuredClone(input);
    const dossier = await parseModelWriteDossierV2(owned.dossier);
    const admission = await parseRequestSourceAdmission(owned.admission);
    if (
      (dossier.command.kind !== "accept-proposal" &&
        dossier.command.kind !== "approved-change") ||
      (dossier.command.kind === "accept-proposal" &&
        dossier.operations.kind !== "whole-files") ||
      canonical(dossier.command) !== canonical(admission.command) ||
      canonical(dossier.authority) !== canonical(admission.authority) ||
      await modelWriteDossierDigestV2(dossier) !== admission.dossierDigest ||
      canonical(admission.destination.host) !==
        canonical(this.primary.binding.scope)
    ) throw refused();
    if (dossier.command.kind === "approved-change") {
      await requestNetworkAdmissionEvidence(admission, dossier);
    }
    return { dossier, admission };
  }
  /** Called after the queue and OS writer fence; locks the exact Opening. */
  private async opening(tx: Tx, context: RequestSourcePublicationContext) {
    const d = context.admission.destination;
    const rows = await tx.$queryRaw<PostgresOpeningRow[]>(
      Prisma.sql`SELECT * FROM ${
        postgresQualifiedTable(this.client, "SpaceOpening")
      }
      WHERE "projectId"=${d.host.projectId} AND "systemId"=${d.host.systemId} AND "id"=${d.openingId} FOR UPDATE`,
    );
    if (rows.length !== 1) throw refused();
    const opening = decodePostgresOpening(rows[0]);
    const authority = context.admission.authority;
    if (
      // A delegated decision is owned by no session (4.8c A1).
      !isSessionlessRequestAuthority(authority) &&
        (opening.ownerId !==
            authority.acceptance.principal.controller.ownerId ||
          opening.ownerId !==
            authority.proposal.principal.controller.ownerId) ||
      opening.caseId !== d.caseId ||
      opening.executionSpaceId !== d.executionSpaceId ||
      opening.branchId !== d.branchId || !opening.base ||
      opening.baseDigest !== context.admission.openingBaseDigest
    ) throw refused();
    return opening;
  }
  async assertNewLocked(
    tx: Tx,
    input: RequestSourcePublicationContext,
  ): Promise<void> {
    const context = await this.context(input);
    const authority = context.admission.authority;
    const prior = requestWriteAuthorityPrior(authority);
    // The person's session must be current at the new effect; the MO's
    // decision stands once recorded, as revalidated then (4.8c A2).
    if (!isSessionlessRequestAuthority(authority)) {
      await this.credentials.assertCurrentController(
        tx,
        authority.acceptance.principal.controller,
        authority.acceptance.principal.sessionRevision,
      );
    }
    const opening = await this.opening(tx, context);
    if (
      !opening.base ||
      !["runtime-ready", "admitted", "dispatched"].includes(opening.phase)
    ) throw refused();
    const s = opening.scope, executionSpaceId = opening.executionSpaceId;
    const spaces = await tx.$queryRaw<
      Array<
        {
          caseId: string | null;
          parentExecutionSpaceId: string | null;
          lifecycle: string;
          closedAt: Date | null;
        }
      >
    >(Prisma.sql`
      SELECT "caseId", "parentExecutionSpaceId", "lifecycle", "closedAt" FROM ${
      postgresQualifiedTable(this.client, "ExecutionSpace")
    }
      WHERE "projectId"=${s.projectId} AND "systemId"=${s.systemId} AND "executionSpaceId"=${executionSpaceId} FOR SHARE`);
    if (
      spaces.length !== 1 || spaces[0].caseId !== opening.caseId ||
      spaces[0].parentExecutionSpaceId !== "main" ||
      spaces[0].lifecycle !== "active" || spaces[0].closedAt !== null
    ) throw refused();
    const requester = isSessionlessRequestAuthority(authority)
      ? authority.requester
      : undefined;
    const operatorId = requester?.operatorId ??
      opening.base.requestOwner.operatorId;
    const member = operatorId !== opening.base.requestOwner.operatorId;
    const runtimeScope = { ...s, executionSpaceId, operatorId };
    const parents = await tx.$queryRaw<Array<{ operatorId: string }>>(
      Prisma.sql`SELECT "operatorId" FROM ${
        postgresQualifiedTable(this.client, "OperatorRuntime")
      }
      WHERE "projectId"=${s.projectId} AND "systemId"=${s.systemId} AND "executionSpaceId"=${executionSpaceId} AND "operatorId"=${operatorId} FOR SHARE`,
    );
    if (parents.length !== 1) throw refused();
    const row = await tx.runtimeState.findFirst({ where: runtimeScope });
    if (!row) throw refused();
    const state = decodePostgresRuntimeState(row), model = state.executionModel;
    if (
      !model || model.version.authoritySchema !== 2 || !model.ownerAuthority ||
      !sameOwnerAuthorityIdentity(
        model.ownerAuthority,
        isSessionlessRequestAuthority(authority)
          ? authority.exercise
          : authority.acceptance.principal.priorOwner,
      )
    ) throw refused();
    if (context.dossier.command.kind === "approved-change") {
      const evidence = await requestNetworkAdmissionEvidence(
        context.admission,
        context.dossier,
      );
      const change = evidence.dossier.decision.change;
      const decision = state.requestNetworkDecisions?.[change.id];
      const stored = state.configuration?.changes.filter((entry) =>
        entry.id === change.id
      );
      if (
        opening.phase !== "dispatched" || !opening.admissionId ||
        !decision || decision.verdict !== "approve" ||
        decision.openingId !== opening.id ||
        decision.caseId !== opening.caseId ||
        decision.executionSpaceId !== opening.executionSpaceId ||
        decision.commandId !== context.admission.command.commandId ||
        decision.proposalIntentDigest !== evidence.proposalIntentDigest ||
        !Number.isSafeInteger(decision.expectedRevision) ||
        decision.expectedRevision < 0 ||
        decision.configurationRevision !== change.baseRevision ||
        stored?.length !== 1 || canonical(stored[0]) !== canonical(change) ||
        model.version.digest !== prior.version.digest ||
        model.version.repositoryVersion !== prior.version.repositoryVersion ||
        isSessionlessRequestAuthority(authority) &&
          decision.authority?.digest !==
            context.admission.command.authorityRef.digest
      ) throw refused();
    }
    const chain = await this.admissions.readAdmittedSource(tx, opening);
    const preAdmission = opening.phase === "runtime-ready" &&
      !opening.admissionId;
    let ownerState = state;
    if (preAdmission) {
      if (member) throw refused();
      if (
        chain.execution.adoptions.length !== 0 ||
        chain.execution.softwareAdoptions.length !== 0 ||
        chain.execution.pin.adoption !== null ||
        chain.execution.pin.source.version !==
          opening.base.manifest.source!.sourceVersion ||
        chain.execution.pin.modelDigest !== model.version.digest ||
        state.events.some((event) =>
          event.kind === "model-version-admission-authorized" ||
          event.kind === "model-version-admitted" ||
          !!event.modelAdoptionAuthorization || !!event.effectiveModelUpdate
        )
      ) throw refused();
      new RequestSpaceModel({ base: opening.base, model });
      assertRequestSpaceBirth(state, requestSpaceSeed(opening), model);
    } else {
      const bindings = new PostgresRequestExecutionBindingReader(
        this.client,
        opening.scope,
        this.admissions,
      );
      const executionBinding = await bindings.readInTransaction(
        tx,
        opening,
        requester,
      );
      if (canonical(executionBinding.state) !== canonical(state)) {
        throw refused();
      }
      new RequestSpaceModel({
        base: opening.base,
        model,
        ...(member
          ? {
            teamPin: {
              modelDigest: executionBinding.pin.modelDigest,
              repositoryVersion: executionBinding.pin.source.version,
            },
          }
          : { executionPin: executionBinding.pin }),
      });
      if (member) {
        ownerState = (await bindings.readInTransaction(tx, opening)).state;
      }
    }
    if (
      !ownerState.cases?.some((entry) =>
        entry.id === opening.caseId && isOpenCase(entry)
      )
    ) throw refused();
    const lastHuman = chain.receipts.findLast((entry) =>
        entry.payload.result.model.identity.builderId === operatorId
      ),
      lastSoftware = chain.softwareReceipts.findLast((entry) =>
        entry.payload.result.targets.some((target) =>
          target.operatorId === operatorId
        )
      );
    const previous =
      lastSoftware && (!lastHuman || lastSoftware.revision > lastHuman.revision)
        ? lastSoftware.payload.result.targets.find((target) =>
          target.operatorId === operatorId
        )
        : lastHuman?.payload.result.model ??
          { identity: model.identity, digest: model.version.digest };
    if (
      canonical(chain.head) !== canonical(context.admission.predecessor) ||
      !previous ||
      canonical(previous.identity) !== canonical(prior.identity) ||
      previous.digest !== prior.version.digest ||
      !member &&
        prior.version.repositoryVersion !== chain.head.source.version ||
      prior.identity.builderId !== operatorId
    ) throw refused();
  }
  /** Existing credential SHARE locks remain held; check database time again at
   * the last point before Git. No new authority or lock is introduced. */
  async assertExpiryLocked(
    tx: Tx,
    input: RequestSourcePublicationContext,
  ): Promise<void> {
    const context = await this.context(input),
      authority = context.admission.authority,
      s = this.primary.binding.scope;
    if (isSessionlessRequestAuthority(authority)) {
      // No session: the opening's admission still bounds the effect in time.
      const d = context.admission.destination;
      const admitted = await tx.$queryRaw<Array<{ ok: boolean }>>(
        Prisma.sql`SELECT EXISTS (
        SELECT 1 FROM ${postgresQualifiedTable(this.client, "SpaceOpening")} o
        JOIN ${
          postgresQualifiedTable(this.client, "SpaceExecutionAdmission")
        } a ON a."projectId"=o."projectId" AND a."systemId"=o."systemId" AND a."id"=o."admissionId"
        WHERE o."projectId"=${d.host.projectId} AND o."systemId"=${d.host.systemId} AND o."id"=${d.openingId}
          AND a."status"='active' AND a."expiresAt">clock_timestamp()
      ) AS "ok"`,
      );
      if (!admitted[0]?.ok) throw refused();
      return;
    }
    const p = authority.acceptance.principal;
    const rows = await tx.$queryRaw<Array<{ ok: boolean }>>(
      Prisma.sql`SELECT EXISTS (
      SELECT 1 FROM ${
        postgresQualifiedTable(this.client, "SpaceControlCredential")
      } c
      JOIN ${
        postgresQualifiedTable(this.client, "SpaceControlCredential")
      } x ON x."parentCapabilityId"=c."id"
      WHERE c."projectId"=${s.projectId} AND c."systemId"=${s.systemId} AND c."id"=${p.controller.capabilityId}
        AND c."ownerId"=${p.controller.ownerId} AND c."kind"='capability' AND c."parentCapabilityId" IS NULL
        AND c."revision"=${p.controller.capabilityRevision} AND c."status"='active'
        AND c."authorityJson"=${canonical(p.controller.authority)}
        AND x."projectId"=c."projectId" AND x."systemId"=c."systemId" AND x."ownerId"=c."ownerId"
        AND x."id"=${p.controller.sessionId} AND x."kind"='session' AND x."revision"=${p.sessionRevision}
        AND x."status"='active' AND x."authorityJson"=c."authorityJson"
        AND LEAST(c."expiresAt",x."expiresAt")>clock_timestamp()
    ) AS "ok"`,
    );
    if (!rows[0]?.ok) throw refused();
  }
  /** D3 must have verified the immutable Git proof. Recovery intentionally does
   * not inspect today's credentials, Case status, or runtime lifecycle. */
  async appendLocked(
    tx: Tx,
    input: RequestSourcePublicationContext,
  ): Promise<void> {
    const context = await this.context(input);
    const opening = await this.opening(tx, context);
    await this.admissions.compareAndAppend(tx, opening, context.admission);
  }
}
