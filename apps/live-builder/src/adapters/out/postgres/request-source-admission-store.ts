import { requestExecutionPinFor } from "../../../application/model/evolution/request-execution-pin.ts";
import {
  isSessionlessRequestAuthority,
  requestWriteAuthorityPrior,
} from "../../../application/model/source-admission/request-delegated-authority.ts";
import {
  parseRequestAdoptionManifest,
  requestAdoptionOwnerId,
  requestAdoptionReceiptDigest,
} from "../../../application/model/evolution/request-adoption-invariants.ts";
import type {
  RequestAdoptionManifest,
  RequestAdoptionReceipt,
  RequestExecutionPin,
} from "../../../application/model/evolution/request-adoption-ports.ts";
import {
  parseScopedSoftwareAdoptionManifest,
  type ScopedSoftwareAdoptionManifestV2,
} from "../../../application/model/evolution/scoped-software-adoption.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import type { ModelIdentity } from "../../../domain/work/dialogue.ts";
import {
  assertRequestReleaseAdmissionReference,
  type RequestReleaseAdmissionReference,
  type SavedOperatorManifest,
} from "../../../domain/work/saved-systems.ts";
import type { VerifiedRequestReleaseSource } from "../../../domain/work/request-release-origin.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { parseModelRevisionRef } from "../../../domain/model/value-objects/element-ref.ts";
import {
  assertBaseForChoice,
  assertOpeningBase,
  type OpeningRecord,
  recordedOpeningCommand,
  requestSpaceDigest,
  RequestSpaceError,
} from "../../../domain/work/request-spaces.ts";
import {
  parseRequestSourceAdmission,
  type RequestSourceAdmission,
  requestSourceAdmissionDigest,
} from "../../../application/model/source-admission/request-source-admission.ts";
import {
  parseScopedSoftwareSourceAdmission,
  scopedSoftwareSourceAdmissionDigest,
  type ScopedSoftwareSourceAdmissionV2,
} from "../../../application/model/source-admission/scoped-software-source-admission.ts";
import { postgresQualifiedTable, Prisma, type PrismaClient } from "./client.ts";

type Tx = Prisma.TransactionClient;
export interface AdmittedSourceReceipt {
  readonly revision: number;
  readonly manifestDigest: string;
  readonly payload: RequestSourceAdmission;
  readonly recordedAt: string;
}
export interface AdmittedSourceHead {
  readonly revision: number;
  readonly manifestDigest: string;
  readonly source: { readonly repositoryId: string; readonly version: string };
  readonly sourceDigest: string;
}
export interface AdmittedSourceChain {
  readonly baseline: AdmittedSourceHead;
  readonly head: AdmittedSourceHead;
  readonly receipts: readonly AdmittedSourceReceipt[];
  readonly softwareReceipts: readonly {
    readonly revision: number;
    readonly manifestDigest: string;
    readonly payload: ScopedSoftwareSourceAdmissionV2;
    readonly recordedAt: string;
  }[];
  /** Latest any-kind ordinal is the append cursor, never a renumbered source head. */
  readonly cursor: { readonly revision: number; readonly digest: string };
  readonly execution: {
    readonly pin: RequestExecutionPin;
    readonly adoptions: readonly {
      readonly manifest: RequestAdoptionManifest;
      readonly receipt: RequestAdoptionReceipt;
    }[];
    readonly softwareAdoptions: readonly {
      readonly manifest: ScopedSoftwareAdoptionManifestV2;
      readonly journalRevision: number;
      readonly manifestDigest: string;
      readonly recordedAt: string;
    }[];
  };
}
const unavailable = () =>
  new RequestSpaceError(
    "UNAVAILABLE",
    "The admitted Request source history is unavailable.",
  );
const conflict = () =>
  new RequestSpaceError(
    "OPENING_CONFLICT",
    "The Request source admission changed.",
  );
const headEquals = (a: AdmittedSourceHead, b: AdmittedSourceHead) =>
  canonical(a) === canonical(b);
/** Project only public source facts from an already verified immutable fold.
 * Original journal ordinals remain distinct from array positions and cursor. */
export function requestReleaseSourceEvidence(
  opening: OpeningRecord,
  chain: AdmittedSourceChain,
  reference: RequestReleaseAdmissionReference,
): VerifiedRequestReleaseSource {
  try {
    assertRequestReleaseAdmissionReference(reference);
  } catch {
    throw unavailable();
  }
  const receipt = chain.receipts.find((entry) =>
    entry.revision === reference.revision &&
    entry.manifestDigest === reference.manifestDigest
  );
  const software = chain.softwareReceipts.find((entry) =>
    entry.revision === reference.revision &&
    entry.manifestDigest === reference.manifestDigest
  );
  if (
    (!receipt && !software) || !opening.baseDigest ||
    canonical(reference) !== canonical({
        format: "request-release-admission/v1",
        openingId: opening.id,
        openingBaseDigest: opening.baseDigest,
        revision: reference.revision,
        manifestDigest: reference.manifestDigest,
      })
  ) throw unavailable();
  const result = receipt?.payload.result ?? software!.payload.result;
  const { source, sourceDigest, build } = result;
  const model = receipt?.payload.result.model ??
    software?.payload.result.targets.find((target) =>
      target.operatorId === opening.base?.requestOwner.operatorId
    );
  if (!model) throw unavailable();
  return structuredClone({
    requestAdmission: reference,
    source,
    sourceDigest,
    build,
    model: { identity: model.identity, digest: model.digest },
  });
}
function belongs(
  payload: RequestSourceAdmission,
  opening: OpeningRecord,
): boolean {
  const target = payload.destination;
  return target.openingId === opening.id && target.caseId === opening.caseId &&
    target.executionSpaceId === opening.executionSpaceId &&
    target.branchId === opening.branchId &&
    target.host.projectId === opening.scope.projectId &&
    target.host.systemId === opening.scope.systemId &&
    payload.openingBaseDigest === opening.baseDigest &&
    // A delegated decision is owned by no session; its destination is enough.
    (isSessionlessRequestAuthority(payload.authority) ||
      payload.authority.proposal.principal.controller.ownerId ===
            opening.ownerId &&
        payload.authority.acceptance.principal.controller.ownerId ===
          opening.ownerId);
}
/** The first source receipt cannot invent native identity already retained in
 * B0. Later receipts continue the full admitted identity from their predecessor. */
function matchesPriorIdentity(
  identity: ModelIdentity,
  baselineOwner: SavedOperatorManifest,
  previous?: ModelIdentity,
): boolean {
  return previous !== undefined
    ? canonical(identity) === canonical(previous)
    : (baselineOwner.nativeSystemId === undefined ||
      identity.systemId === baselineOwner.nativeSystemId) &&
      (baselineOwner.systemQualifiedName === undefined ||
        identity.systemQualifiedName === baselineOwner.systemQualifiedName);
}
type OpeningEvidence = {
  baseJson: string | null;
  baseDigest: string | null;
  commandJson: string;
  commandDigest: string;
  ownerId: string;
  caseId: string;
  executionSpaceId: string;
  branchId: string;
};
function matchesStored(
  row: OpeningEvidence | undefined,
  opening: OpeningRecord,
): boolean {
  return !!row && row.ownerId === opening.ownerId &&
    row.caseId === opening.caseId &&
    row.executionSpaceId === opening.executionSpaceId &&
    row.branchId === opening.branchId &&
    row.baseDigest === opening.baseDigest && !!opening.base &&
    row.baseJson === canonical(opening.base) &&
    row.commandDigest === opening.commandDigest &&
    row.commandJson === canonical(opening.command);
}
function revision(value: bigint): number {
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw unavailable();
  }
  return Number(value);
}

/** Bound to the existing host client only for its qualified table identifier.
 * Both operations use the caller's transaction, with no nested transaction or Git I/O. */
export class PostgresRequestSourceAdmissionStore {
  constructor(private readonly client: PrismaClient) {}

  /** Caller supplies a coherent read transaction; this method acquires no write locks. */
  async readAdmittedSource(
    tx: Tx,
    inputOpening: OpeningRecord,
  ): Promise<AdmittedSourceChain> {
    const opening = structuredClone(inputOpening);
    const persisted = await tx.$queryRaw<OpeningEvidence[]>(
      Prisma
        .sql`SELECT "baseJson","baseDigest","commandJson","commandDigest","ownerId","caseId","executionSpaceId","branchId" FROM ${
        postgresQualifiedTable(this.client, "SpaceOpening")
      }
        WHERE "projectId"=${opening.scope.projectId} AND "systemId"=${opening.scope.systemId} AND "id"=${opening.id}`,
    );
    if (!matchesStored(persisted[0], opening)) throw unavailable();
    const base = opening.base;
    if (
      !base || !opening.baseDigest || !base.manifest.source ||
      base.manifest.origin.projectId !== opening.scope.projectId ||
      base.manifest.origin.systemId !== opening.scope.systemId ||
      !/^[a-f0-9]{64}$/.test(base.manifest.source.sourceDigest) ||
      await requestSpaceDigest(base) !== opening.baseDigest ||
      await requestSpaceDigest(base.manifest) !== base.manifestDigest
    ) throw unavailable();
    assertOpeningBase(base);
    assertBaseForChoice(base, opening.command.source);
    if (
      await requestSpaceDigest({
        scope: opening.scope,
        ownerId: opening.ownerId,
        command: recordedOpeningCommand(opening.command),
      }) !== opening.commandDigest
    ) throw unavailable();
    const rows = await tx.spaceManifest.findMany({
      where: { ...opening.scope, executionSpaceId: opening.executionSpaceId },
      orderBy: { revision: "asc" },
    });
    const first = rows[0];
    if (
      !first || first.revision !== 1n || first.kind !== "baseline" ||
      first.digest !== base.manifestDigest ||
      first.payload !== canonical(base.manifest)
    ) throw unavailable();
    const baseline: AdmittedSourceHead = {
      revision: 1,
      manifestDigest: first.digest,
      source: parseModelRevisionRef({
        repositoryId: base.manifest.source.repositoryId,
        version: base.manifest.source.sourceVersion,
      }),
      sourceDigest: base.manifest.source.sourceDigest,
    };
    let head = baseline;
    const owner = base.manifest.operators.filter((operator) =>
      operator.operatorId === base.requestOwner.operatorId
    );
    if (owner.length !== 1 || !/^[a-f0-9]{64}$/.test(owner[0].modelDigest)) {
      throw unavailable();
    }
    let priorModel: {
      digest: string;
      identity?: ModelIdentity;
      builderId: string;
    } = {
      digest: owner[0].modelDigest,
      builderId: base.requestOwner.operatorId,
    };
    const receipts: AdmittedSourceReceipt[] = [];
    const softwareReceipts: Array<
      {
        revision: number;
        manifestDigest: string;
        payload: ScopedSoftwareSourceAdmissionV2;
        recordedAt: string;
      }
    > = [];
    let cursor = { revision: 1, digest: first.digest };
    let executionPin: RequestExecutionPin = {
      source: parseModelRevisionRef(baseline.source),
      modelDigest: owner[0].modelDigest,
      sourceAdmission: {
        revision: baseline.revision,
        manifestDigest: baseline.manifestDigest,
      },
      adoption: null,
    };
    const adoptions: Array<
      { manifest: RequestAdoptionManifest; receipt: RequestAdoptionReceipt }
    > = [];
    const softwareAdoptions: Array<
      {
        manifest: ScopedSoftwareAdoptionManifestV2;
        journalRevision: number;
        manifestDigest: string;
        recordedAt: string;
      }
    > = [];
    const memberPrior = new Map<
      string,
      {
        digest: string;
        identity?: ModelIdentity;
        builderId: string;
        systemId: string;
      }
    >();
    const ids = new Set<string>();
    const softwareAdoptionIds = new Set<string>();
    for (const row of rows.slice(1)) {
      const n = revision(row.revision);
      if (
        n !== cursor.revision + 1 || !(row.recordedAt instanceof Date) ||
        !Number.isFinite(row.recordedAt.getTime())
      ) throw unavailable();
      if (row.kind === "runtime-adoption") {
        const rawManifest = JSON.parse(row.payload);
        if (rawManifest?.format === "request-software-runtime-adoption/v2") {
          let manifest: ScopedSoftwareAdoptionManifestV2;
          try {
            manifest = parseScopedSoftwareAdoptionManifest(rawManifest);
          } catch {
            throw unavailable();
          }
          const source = softwareReceipts.find((receipt) =>
            receipt.revision === manifest.sourceAdmission?.revision &&
            receipt.manifestDigest === manifest.sourceAdmission.manifestDigest
          );
          const target = source?.payload.result.targets.find((entry) =>
            entry.operatorId === manifest.target?.operatorId
          );
          if (
            row.payload !== canonical(manifest) ||
            await sha256(row.payload) !== row.digest ||
            canonical(manifest.predecessor) !== canonical(cursor) ||
            canonical(manifest.boundary.previousPin) !==
              canonical(executionPin) ||
            manifest.target.projectId !== opening.scope.projectId ||
            manifest.target.systemId !== opening.scope.systemId ||
            manifest.target.executionSpaceId !== opening.executionSpaceId ||
            manifest.target.operatorId !== base.requestOwner.operatorId ||
            !source || source.revision !== head.revision || !target ||
            manifest.dossierId !== source.payload.evolutionDossierId ||
            manifest.intentDigest !== source.payload.evolutionIntentDigest ||
            manifest.proposalDigest !== source.payload.proposalDigest ||
            manifest.adoptionAuthorization?.act !== "adopt" ||
            manifest.adoptionAuthorization.proposalDigest !==
              manifest.proposalDigest ||
            softwareAdoptionIds.has(manifest.dossierId)
          ) throw unavailable();
          softwareAdoptionIds.add(manifest.dossierId);
          const recordedAt = row.recordedAt.toISOString();
          const fields = {
            commandId: manifest.dossierId,
            committedRuntimeRevision: manifest.committedRuntimeRevision,
            journalRevision: n,
            journalDigest: row.digest,
            recordedAt,
          };
          executionPin = {
            source: parseModelRevisionRef(head.source),
            modelDigest: target.digest,
            sourceAdmission: {
              revision: head.revision,
              manifestDigest: head.manifestDigest,
            },
            adoption: {
              commandId: manifest.dossierId,
              receiptDigest: await requestAdoptionReceiptDigest(fields),
              committedRuntimeRevision: manifest.committedRuntimeRevision,
            },
          };
          softwareAdoptions.push({
            manifest,
            journalRevision: n,
            manifestDigest: row.digest,
            recordedAt,
          });
          cursor = { revision: n, digest: row.digest };
          continue;
        }
        const manifest = await parseRequestAdoptionManifest(
          rawManifest,
        );
        const target = manifest.intent.target;
        const sourceReceipt = receipts.find((receipt) =>
          receipt.revision === head.revision
        );
        if (
          row.payload !== canonical(manifest) ||
          await sha256(row.payload) !== row.digest ||
          manifest.predecessor.revision !== cursor.revision ||
          manifest.predecessor.digest !== cursor.digest ||
          canonical(manifest.sourceHead) !==
            canonical({
              revision: head.revision,
              manifestDigest: head.manifestDigest,
            }) ||
          canonical(manifest.intent.previous.pin) !==
            canonical(
              requestExecutionPinFor(base.requestOwner.operatorId, {
                pin: executionPin,
                adoptions,
              }, target.operatorId),
            ) ||
          canonical(manifest.intent.candidate.source) !==
            canonical(head.source) ||
          manifest.intent.candidate.sourceDigest !== head.sourceDigest ||
          !sourceReceipt ||
          canonical(manifest.intent.candidate.build) !==
            canonical(sourceReceipt.payload.result.build) ||
          manifest.intent.candidate.model.version.digest !==
            sourceReceipt.payload.result.model.digest ||
          canonical(manifest.intent.candidate.model.identity) !==
            canonical(sourceReceipt.payload.result.model.identity) ||
          target.openingId !== opening.id || target.caseId !== opening.caseId ||
          target.executionSpaceId !== opening.executionSpaceId ||
          target.branchId !== opening.branchId ||
          !([base.requestOwner.operatorId, ...memberPrior.keys()].includes(
            target.operatorId,
          )) ||
          target.repositoryId !== head.source.repositoryId ||
          canonical(target.host) !== canonical(opening.scope) ||
          manifest.intent.openingBaseDigest !== opening.baseDigest ||
          requestAdoptionOwnerId(manifest.intent) !== opening.ownerId ||
          ids.has(manifest.commandId)
        ) throw unavailable();
        ids.add(manifest.commandId);
        const receiptFields = {
          commandId: manifest.commandId,
          committedRuntimeRevision: manifest.committedRuntimeRevision,
          journalRevision: n,
          journalDigest: row.digest,
          recordedAt: row.recordedAt.toISOString(),
        };
        const receipt = {
          ...receiptFields,
          receiptDigest: await requestAdoptionReceiptDigest(receiptFields),
        };
        adoptions.push({ manifest, receipt });
        for (const member of manifest.intent.team?.team ?? []) {
          if (!memberPrior.has(member.operatorId)) {
            memberPrior.set(member.operatorId, {
              digest: member.modelDigest,
              builderId: member.operatorId,
              systemId: manifest.intent.team!.childSystemId,
            });
          }
        }
        if (target.operatorId === base.requestOwner.operatorId) {
          executionPin = {
            source: parseModelRevisionRef(head.source),
            modelDigest: manifest.intent.candidate.model.version.digest,
            sourceAdmission: {
              revision: head.revision,
              manifestDigest: head.manifestDigest,
            },
            adoption: {
              commandId: manifest.commandId,
              receiptDigest: receipt.receiptDigest,
              committedRuntimeRevision: manifest.committedRuntimeRevision,
            },
          };
        }
        cursor = { revision: n, digest: row.digest };
        continue;
      }
      if (row.kind !== "source-admission") throw unavailable();
      const rawPayload = JSON.parse(row.payload);
      if (rawPayload?.format === "request-software-source-admission/v2") {
        const payload = await parseScopedSoftwareSourceAdmission(rawPayload);
        const destination = payload.destination;
        const target = payload.result.targets.find((entry) =>
          entry.operatorId === base.requestOwner.operatorId
        );
        if (
          row.payload !== canonical(payload) ||
          await scopedSoftwareSourceAdmissionDigest(payload) !== row.digest ||
          !headEquals(payload.predecessor, head) ||
          destination.openingId !== opening.id ||
          destination.caseId !== opening.caseId ||
          destination.executionSpaceId !== opening.executionSpaceId ||
          destination.branchId !== opening.branchId ||
          canonical(destination.host) !== canonical(opening.scope) ||
          payload.openingBaseDigest !== opening.baseDigest ||
          payload.result.targets.length !== 1 || !target ||
          !matchesPriorIdentity(
            target.identity,
            owner[0],
            priorModel.identity,
          ) ||
          target.identity.builderId !== priorModel.builderId ||
          ids.has(payload.command.commandId)
        ) throw unavailable();
        ids.add(payload.command.commandId);
        softwareReceipts.push({
          revision: n,
          manifestDigest: row.digest,
          payload,
          recordedAt: row.recordedAt.toISOString(),
        });
        head = {
          revision: n,
          manifestDigest: row.digest,
          source: payload.result.source,
          sourceDigest: payload.result.sourceDigest,
        };
        cursor = { revision: n, digest: row.digest };
        priorModel = {
          digest: target.digest,
          identity: target.identity,
          builderId: target.identity.builderId,
        };
        continue;
      }
      const payload = await parseRequestSourceAdmission(
        rawPayload,
      );
      const subject = requestWriteAuthorityPrior(payload.authority);
      const subjectPrior =
        subject.identity.builderId === base.requestOwner.operatorId
          ? priorModel
          : memberPrior.get(subject.identity.builderId);
      if (!subjectPrior) throw unavailable();
      if (
        row.payload !== canonical(payload) ||
        await requestSourceAdmissionDigest(payload) !== row.digest ||
        !headEquals(payload.predecessor, head) || !belongs(payload, opening) ||
        requestWriteAuthorityPrior(payload.authority).version.digest !==
          subjectPrior.digest ||
        requestWriteAuthorityPrior(payload.authority).identity.builderId !==
          subjectPrior.builderId ||
        !(subjectPrior === priorModel
          ? matchesPriorIdentity(
            subject.identity,
            owner[0],
            priorModel.identity,
          )
          : subjectPrior.identity
          ? canonical(subject.identity) === canonical(subjectPrior.identity)
          : subject.identity.systemId ===
            memberPrior.get(subject.identity.builderId)?.systemId) ||
        ids.has(payload.command.commandId)
      ) throw unavailable();
      ids.add(payload.command.commandId);
      if (
        !(row.recordedAt instanceof Date) ||
        !Number.isFinite(row.recordedAt.getTime())
      ) throw unavailable();
      receipts.push({
        revision: n,
        manifestDigest: row.digest,
        payload,
        recordedAt: row.recordedAt.toISOString(),
      });
      head = {
        revision: n,
        manifestDigest: row.digest,
        source: payload.result.source,
        sourceDigest: payload.result.sourceDigest,
      };
      cursor = { revision: n, digest: row.digest };
      const updated = {
        digest: payload.result.model.digest,
        identity: payload.result.model.identity,
        builderId: payload.result.model.identity.builderId,
      };
      if (subjectPrior === priorModel) priorModel = updated;
      else {memberPrior.set(updated.builderId, {
          ...updated,
          systemId: updated.identity.systemId,
        });}
    }
    return structuredClone({
      baseline,
      head,
      receipts,
      softwareReceipts,
      cursor,
      execution: { pin: executionPin, adoptions, softwareAdoptions },
    });
  }

  /** Lock opening before chain read and revision allocation. The outer W3 guard
   * must follow its established lock order before calling this participant. */
  async compareAndAppend(
    tx: Tx,
    inputOpening: OpeningRecord,
    input: RequestSourceAdmission,
  ): Promise<AdmittedSourceReceipt> {
    const opening = structuredClone(inputOpening);
    const payload = await parseRequestSourceAdmission(input);
    const rows = await tx.$queryRaw<OpeningEvidence[]>(
      Prisma
        .sql`SELECT "baseJson","baseDigest","commandJson","commandDigest","ownerId","caseId","executionSpaceId","branchId" FROM ${
        postgresQualifiedTable(this.client, "SpaceOpening")
      }
        WHERE "projectId"=${opening.scope.projectId} AND "systemId"=${opening.scope.systemId} AND "id"=${opening.id} FOR UPDATE`,
    );
    const locked = rows[0];
    if (!matchesStored(locked, opening)) throw conflict();
    if (!belongs(payload, opening)) throw conflict();
    const chain = await this.readAdmittedSource(tx, opening);
    const existing = chain.receipts.find((entry) =>
      entry.payload.command.commandId === payload.command.commandId
    );
    if (existing) {
      if (canonical(existing.payload) !== canonical(payload)) throw conflict();
      return existing;
    }
    if (
      chain.softwareReceipts.some((entry) =>
        entry.payload.command.commandId === payload.command.commandId
      )
    ) throw conflict();
    const subject = requestWriteAuthorityPrior(payload.authority);
    if (subject.identity.builderId !== opening.base!.requestOwner.operatorId) {
      const pin = requestExecutionPinFor(
        opening.base!.requestOwner.operatorId,
        chain.execution,
        subject.identity.builderId,
      );
      const previous = chain.receipts.findLast((entry) =>
        entry.payload.result.model.identity.builderId ===
          subject.identity.builderId
      )?.payload.result.model;
      const birth = chain.execution.adoptions.find((entry) =>
        entry.manifest.intent.team?.team.some((member) =>
          member.operatorId === subject.identity.builderId
        )
      );
      if (
        !headEquals(chain.head, payload.predecessor) ||
        !isSessionlessRequestAuthority(payload.authority) ||
        subject.version.repositoryVersion !== pin.source.version ||
        subject.version.digest !== (previous?.digest ?? pin.modelDigest) ||
        (previous
          ? canonical(previous.identity) !== canonical(subject.identity)
          : birth?.manifest.intent.team?.childSystemId !==
            subject.identity.systemId)
      ) throw conflict();
    } else {
      const lastHuman = chain.receipts.findLast((entry) =>
          entry.payload.result.model.identity.builderId ===
            opening.base!.requestOwner.operatorId
        ),
        lastSoftware = chain.softwareReceipts.at(-1);
      const previous = lastSoftware &&
          (!lastHuman || lastSoftware.revision > lastHuman.revision)
        ? lastSoftware.payload.result.targets.find((entry) =>
          entry.operatorId === opening.base!.requestOwner.operatorId
        )
        : lastHuman?.payload.result.model;
      const baselineOwner = opening.base!.manifest.operators.find((operator) =>
        operator.operatorId === opening.base!.requestOwner.operatorId
      );
      if (!baselineOwner) throw conflict();
      const expectedModelDigest = previous?.digest ?? baselineOwner.modelDigest;
      if (
        !headEquals(chain.head, payload.predecessor) ||
        requestWriteAuthorityPrior(payload.authority).version.digest !==
          expectedModelDigest ||
        requestWriteAuthorityPrior(payload.authority).identity.builderId !==
          opening.base!.requestOwner.operatorId ||
        !matchesPriorIdentity(
          requestWriteAuthorityPrior(payload.authority).identity,
          baselineOwner,
          previous?.identity,
        )
      ) throw conflict();
    }
    const n = chain.cursor.revision + 1;
    if (!Number.isSafeInteger(n)) throw conflict();
    const digest = await requestSourceAdmissionDigest(payload);
    const inserted = await tx.$queryRaw<Array<{ recordedAt: Date }>>(
      Prisma.sql`INSERT INTO ${
        postgresQualifiedTable(this.client, "SpaceManifest")
      }
        ("projectId", "systemId", "executionSpaceId", "revision", "kind", "digest", "payload", "recordedAt")
        VALUES (${opening.scope.projectId}, ${opening.scope.systemId}, ${opening.executionSpaceId}, ${
        BigInt(n)
      },
          'source-admission', ${digest}, ${
        canonical(payload)
      }, clock_timestamp()) RETURNING "recordedAt"`,
    );
    const recordedAt = inserted[0]?.recordedAt;
    if (
      !(recordedAt instanceof Date) || !Number.isFinite(recordedAt.getTime())
    ) throw unavailable();
    return {
      revision: n,
      manifestDigest: digest,
      payload: structuredClone(payload),
      recordedAt: recordedAt.toISOString(),
    };
  }

  /** Caller holds the queue fence and has verified the exact Git proof and
   * software authority. This method only performs the D2 history CAS. */
  async compareAndAppendSoftware(
    tx: Tx,
    inputOpening: OpeningRecord,
    input: ScopedSoftwareSourceAdmissionV2,
  ): Promise<
    {
      revision: number;
      manifestDigest: string;
      payload: ScopedSoftwareSourceAdmissionV2;
      recordedAt: string;
    }
  > {
    const opening = structuredClone(inputOpening);
    const payload = await parseScopedSoftwareSourceAdmission(input);
    const rows = await tx.$queryRaw<OpeningEvidence[]>(
      Prisma
        .sql`SELECT "baseJson","baseDigest","commandJson","commandDigest","ownerId","caseId","executionSpaceId","branchId" FROM ${
        postgresQualifiedTable(this.client, "SpaceOpening")
      }
      WHERE "projectId"=${opening.scope.projectId} AND "systemId"=${opening.scope.systemId} AND "id"=${opening.id} FOR UPDATE`,
    );
    if (!matchesStored(rows[0], opening)) throw conflict();
    const d = payload.destination;
    if (
      d.openingId !== opening.id || d.caseId !== opening.caseId ||
      d.executionSpaceId !== opening.executionSpaceId ||
      d.branchId !== opening.branchId ||
      canonical(d.host) !== canonical(opening.scope) ||
      payload.openingBaseDigest !== opening.baseDigest
    ) throw conflict();
    const chain = await this.readAdmittedSource(tx, opening);
    const existing = chain.softwareReceipts.find((entry) =>
      entry.payload.command.commandId === payload.command.commandId
    );
    if (existing) {
      if (canonical(existing.payload) !== canonical(payload)) throw conflict();
      return existing;
    }
    if (
      chain.receipts.some((entry) =>
        entry.payload.command.commandId === payload.command.commandId
      ) || !headEquals(chain.head, payload.predecessor)
    ) throw conflict();
    const owner = opening.base!.manifest.operators.find((entry) =>
      entry.operatorId === opening.base!.requestOwner.operatorId
    );
    const target = payload.result.targets[0];
    const humanPrior = chain.receipts.at(-1),
      softwarePrior = chain.softwareReceipts.at(-1);
    const previous = softwarePrior &&
        (!humanPrior || softwarePrior.revision > humanPrior.revision)
      ? softwarePrior.payload.result.targets.find((entry) =>
        entry.operatorId === opening.base!.requestOwner.operatorId
      )?.identity
      : humanPrior?.payload.result.model.identity;
    if (
      !owner || payload.result.targets.length !== 1 || !target ||
      target.operatorId !== owner.operatorId ||
      !matchesPriorIdentity(target.identity, owner, previous)
    ) throw conflict();
    const n = chain.cursor.revision + 1;
    if (!Number.isSafeInteger(n)) throw conflict();
    const digest = await scopedSoftwareSourceAdmissionDigest(payload);
    const inserted = await tx.$queryRaw<Array<{ recordedAt: Date }>>(
      Prisma.sql`INSERT INTO ${
        postgresQualifiedTable(this.client, "SpaceManifest")
      }
      ("projectId","systemId","executionSpaceId","revision","kind","digest","payload","recordedAt") VALUES (${opening.scope.projectId},${opening.scope.systemId},${opening.executionSpaceId},${
        BigInt(n)
      },'source-admission',${digest},${
        canonical(payload)
      },clock_timestamp()) RETURNING "recordedAt"`,
    );
    const recordedAt = inserted[0]?.recordedAt;
    if (
      !(recordedAt instanceof Date) || !Number.isFinite(recordedAt.getTime())
    ) throw unavailable();
    return {
      revision: n,
      manifestDigest: digest,
      payload,
      recordedAt: recordedAt.toISOString(),
    };
  }

  readonly #preparedSoftwareAdoptions = new WeakMap<
    object,
    {
      openingId: string;
      executionSpaceId: string;
      manifest: ScopedSoftwareAdoptionManifestV2;
      payload: string;
      digest: string;
    }
  >();

  async prepareSoftwareAdoptionAppend(
    opening: OpeningRecord,
    input: ScopedSoftwareAdoptionManifestV2,
  ): Promise<object> {
    const manifest = parseScopedSoftwareAdoptionManifest(input);
    if (
      manifest.target.projectId !== opening.scope.projectId ||
      manifest.target.systemId !== opening.scope.systemId ||
      manifest.target.executionSpaceId !== opening.executionSpaceId ||
      manifest.target.operatorId !== opening.base?.requestOwner.operatorId
    ) throw conflict();
    const payload = canonical(manifest),
      digest = await sha256(payload),
      packet = Object.freeze({});
    this.#preparedSoftwareAdoptions.set(packet, {
      openingId: opening.id,
      executionSpaceId: opening.executionSpaceId,
      manifest,
      payload,
      digest,
    });
    return packet;
  }

  /** Caller owns the final runtime reservation and Opening lock and verifies
   * native authority and the exact runtime transition in this transaction. */
  async appendSoftwareAdoptionPreparedLocked(
    tx: Tx,
    opening: OpeningRecord,
    token: object,
  ): Promise<
    { journalRevision: number; manifestDigest: string; recordedAt: string }
  > {
    const packet = this.#preparedSoftwareAdoptions.get(token);
    if (
      !packet || packet.openingId !== opening.id ||
      packet.executionSpaceId !== opening.executionSpaceId
    ) throw conflict();
    const chain = await this.readAdmittedSource(tx, opening),
      manifest = packet.manifest;
    const existing = chain.execution.softwareAdoptions.find((entry) =>
      entry.manifest.dossierId === manifest.dossierId
    );
    if (existing) {
      if (canonical(existing.manifest) !== packet.payload) throw conflict();
      return {
        journalRevision: existing.journalRevision,
        manifestDigest: existing.manifestDigest,
        recordedAt: existing.recordedAt,
      };
    }
    const source = chain.softwareReceipts.find((entry) =>
      entry.revision === manifest.sourceAdmission.revision &&
      entry.manifestDigest === manifest.sourceAdmission.manifestDigest
    );
    if (
      !source || source.revision !== chain.head.revision ||
      source.payload.evolutionDossierId !== manifest.dossierId ||
      source.payload.evolutionIntentDigest !== manifest.intentDigest ||
      source.payload.proposalDigest !== manifest.proposalDigest ||
      !source.payload.result.targets.some((target) =>
        target.operatorId === manifest.target.operatorId
      ) ||
      canonical(manifest.predecessor) !== canonical(chain.cursor) ||
      canonical(manifest.boundary.previousPin) !==
        canonical(chain.execution.pin) ||
      manifest.adoptionAuthorization.act !== "adopt" ||
      manifest.adoptionAuthorization.proposalDigest !== manifest.proposalDigest
    ) throw conflict();
    const n = chain.cursor.revision + 1;
    if (!Number.isSafeInteger(n)) throw conflict();
    const rows = await tx.$queryRaw<Array<{ recordedAt: Date }>>(
      Prisma.sql`INSERT INTO ${
        postgresQualifiedTable(this.client, "SpaceManifest")
      }
      ("projectId","systemId","executionSpaceId","revision","kind","digest","payload","recordedAt") VALUES (${opening.scope.projectId},${opening.scope.systemId},${opening.executionSpaceId},${
        BigInt(n)
      },'runtime-adoption',${packet.digest},${packet.payload},clock_timestamp()) RETURNING "recordedAt"`,
    );
    const at = rows[0]?.recordedAt;
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
      throw unavailable();
    }
    return {
      journalRevision: n,
      manifestDigest: packet.digest,
      recordedAt: at.toISOString(),
    };
  }

  readonly #preparedAdoptions = new WeakMap<
    object,
    {
      openingId: string;
      executionSpaceId: string;
      manifest: RequestAdoptionManifest;
      payload: string;
      digest: string;
    }
  >();
  async prepareAdoptionAppend(
    opening: OpeningRecord,
    input: RequestAdoptionManifest,
  ): Promise<object> {
    const manifest = await parseRequestAdoptionManifest(input),
      target = manifest.intent.target;
    if (
      target.openingId !== opening.id ||
      target.executionSpaceId !== opening.executionSpaceId ||
      target.caseId !== opening.caseId ||
      canonical(target.host) !== canonical(opening.scope)
    ) throw conflict();
    const payload = canonical(manifest),
      digest = await sha256(payload),
      packet = Object.freeze({});
    this.#preparedAdoptions.set(packet, {
      openingId: opening.id,
      executionSpaceId: opening.executionSpaceId,
      manifest,
      payload,
      digest,
    });
    return packet;
  }

  /** Outer protocol already holds Opening UPDATE in native-before-parent order.
   * No nested transaction, new locks, compiler, source/Git I/O or notifications. */
  async appendAdoptionPreparedLocked(
    tx: Tx,
    opening: OpeningRecord,
    token: object,
  ): Promise<RequestAdoptionReceipt> {
    const packet = this.#preparedAdoptions.get(token);
    if (
      !packet || packet.openingId !== opening.id ||
      packet.executionSpaceId !== opening.executionSpaceId
    ) throw conflict();
    const chain = await this.readAdmittedSource(tx, opening),
      manifest = packet.manifest;
    const existing = chain.execution.adoptions.find((entry) =>
      entry.manifest.commandId === manifest.commandId
    );
    if (existing) {
      if (canonical(existing.manifest) !== packet.payload) throw conflict();
      return structuredClone(existing.receipt);
    }
    if (
      canonical(manifest.predecessor) !== canonical(chain.cursor) ||
      canonical(manifest.intent.previous.pin) !==
        canonical(
          requestExecutionPinFor(
            opening.base!.requestOwner.operatorId,
            chain.execution,
            manifest.intent.target.operatorId,
          ),
        ) ||
      canonical(manifest.sourceHead) !==
        canonical({
          revision: chain.head.revision,
          manifestDigest: chain.head.manifestDigest,
        }) ||
      canonical(manifest.intent.candidate.source) !==
        canonical(chain.head.source) ||
      manifest.intent.candidate.sourceDigest !== chain.head.sourceDigest
    ) throw conflict();
    const n = chain.cursor.revision + 1;
    if (!Number.isSafeInteger(n)) throw conflict();
    const rows = await tx.$queryRaw<Array<{ recordedAt: Date }>>(
      Prisma.sql`INSERT INTO ${
        postgresQualifiedTable(this.client, "SpaceManifest")
      } ("projectId","systemId","executionSpaceId","revision","kind","digest","payload","recordedAt") VALUES (${opening.scope.projectId},${opening.scope.systemId},${opening.executionSpaceId},${
        BigInt(n)
      },'runtime-adoption',${packet.digest},${packet.payload},clock_timestamp()) RETURNING "recordedAt"`,
    );
    const at = rows[0]?.recordedAt;
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
      throw unavailable();
    }
    const fields = {
      commandId: manifest.commandId,
      committedRuntimeRevision: manifest.committedRuntimeRevision,
      journalRevision: n,
      journalDigest: packet.digest,
      recordedAt: at.toISOString(),
    };
    return {
      ...fields,
      receiptDigest: await requestAdoptionReceiptDigest(fields),
    };
  }
}
