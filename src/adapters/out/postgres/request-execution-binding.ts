import { scopedOperator } from "../../../domain/governance/policies/delegation-scope.ts";
import { sameScopedOperator } from "../../../domain/governance/operator-authority.ts";
import { type ScopedOperatorRef } from "../../../domain/governance/authority.ts";
import { requestExecutionPinFor } from "../../../application/model/evolution/request-execution-pin.ts";
import { requestSpaceSeed } from "../../work/request-space-runtime.ts";
import {
  assertRequestTeamPublicationBase,
  parseRequestOwnerAdoptionDossier,
  requestCreationPolicyCompatibility,
  requestInstructionCompatibility,
  requestNetworkCompatibility,
  requestTeamCompatibility,
} from "../../../application/model/evolution/request-adoption-invariants.ts";
import { requestWriteAuthorityPrior } from "../../../application/model/source-admission/request-delegated-authority.ts";
import {
  readRequestCreationPolicySourceAdmissionProof,
  readRequestNetworkSourceAdmissionProof,
  readRequestTeamSourceAdmissionProof,
} from "./request-source-publication-participant.ts";
import { canonicalDigest } from "../../../domain/primitives/execution-digest.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  retainedToolAdmissionId,
  retainedToolDescriptors,
  retainedToolResourceId,
} from "../../../domain/work/retained-tool-dependencies.ts";
import {
  assertRequestSpaceBirth,
  assertRequestSpaceBirthIdentity,
} from "../../../application/work/runtime/initialization.ts";
import type {
  RequestExecutionBinding,
  RequestExecutionBindingPort,
} from "../../../application/model/evolution/request-adoption-ports.ts";
import { RequestAdoptionError } from "../../../application/model/evolution/request-adoption-ports.ts";
import {
  type OpeningRecord,
  requestSpaceDigest,
} from "../../../domain/work/request-spaces.ts";
import type { PostgresSystemScope } from "./scope.ts";
import {
  assertPostgresRuntimeScope,
  assertPostgresSystemScope,
} from "./scope.ts";
import { Prisma, type PrismaClient } from "./client.ts";
import { decodePostgresRuntimeState } from "./runtime-state-snapshot.ts";
import { sameVerifiedRuntimeSnapshot } from "./runtime-snapshot-codec.ts";
import { decodeHistorical } from "./system-state-store.ts";
import { decodeSpaceExecutionAdmission } from "./request-space-control-store.ts";
import {
  type AdmittedSourceChain,
  PostgresRequestSourceAdmissionStore,
} from "./request-source-admission-store.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import { parseScopedSoftwareDossier } from "../../../application/model/evolution/scoped-software-dossier.ts";
import { readScopedSoftwareSourceAdmissionProof } from "./scoped-software-source-publication-participant.ts";

function unavailable(context: Record<string, unknown> = {}): never {
  throw new RequestAdoptionError(
    "UNAVAILABLE",
    "The exact Request execution binding is unavailable.",
    {
      context,
      recovery:
        "Restore the exact Request opening, admission, runtime and verified execution journal before retrying.",
    },
  );
}

/** Current pin, latest history, journal and admission from ONE snapshot. This
 * read owns no runtime/store lifecycle and never initializes/backfills/repairs. */
export class PostgresRequestExecutionBindingReader
  implements RequestExecutionBindingPort {
  readonly #scope: PostgresSystemScope;
  constructor(
    private readonly client: PrismaClient,
    scope: PostgresSystemScope,
    private readonly journal: PostgresRequestSourceAdmissionStore,
  ) {
    assertPostgresSystemScope(scope);
    this.#scope = Object.freeze({ ...scope });
  }
  async read(
    opening: OpeningRecord,
    requester?: ScopedOperatorRef,
  ): Promise<RequestExecutionBinding> {
    const snapshot = structuredClone(opening);
    return await this.client.$transaction(async (tx) => {
      // The historical network receipt reader takes a SHARE lock; this
      // transaction performs no writes but PostgreSQL read-only mode forbids it.
      return await this.readInTransaction(tx, snapshot, requester);
    }, { isolationLevel: "RepeatableRead" });
  }
  /** The exact member, its BO and the admitted chain from one read snapshot.
   * The journal is folded once inside this transaction, never retained between
   * calls or accepted from a caller as execution evidence. */
  async readSourceContext(
    opening: OpeningRecord,
    requester: ScopedOperatorRef,
  ): Promise<{
    binding: RequestExecutionBinding;
    ownerState: SystemRuntimeState;
    chain: AdmittedSourceChain;
  }> {
    const snapshot = structuredClone(opening),
      selected = structuredClone(requester);
    return await this.client.$transaction(async (tx) => {
      let pending: Promise<AdmittedSourceChain> | undefined;
      const readChain = (record: OpeningRecord) =>
        pending ??= this.journal.readAdmittedSource(tx, record);
      const binding = await this.#readInTransaction(
        tx,
        snapshot,
        selected,
        readChain,
      );
      const owner =
        selected.operatorId === snapshot.base!.requestOwner.operatorId
          ? binding
          : await this.#readInTransaction(tx, snapshot, undefined, readChain);
      const chain = await readChain(snapshot);
      return structuredClone({ binding, ownerState: owner.state, chain });
    }, { isolationLevel: "RepeatableRead" });
  }
  async readOperatorInTransaction(
    tx: Prisma.TransactionClient,
    opening: OpeningRecord,
    operatorId: string,
  ): Promise<RequestExecutionBinding> {
    if (operatorId === opening.base?.requestOwner.operatorId) {
      return this.readInTransaction(tx, opening);
    }
    const row = await tx.runtimeState.findFirst({
      where: {
        ...this.#scope,
        executionSpaceId: opening.executionSpaceId,
        operatorId,
      },
    });
    const model = row && decodePostgresRuntimeState(row).executionModel;
    if (!model) unavailable();
    return this.readInTransaction(
      tx,
      opening,
      scopedOperator({
        ...model.identity,
        executionSpaceId: opening.executionSpaceId,
      }, operatorId),
    );
  }
  /** Admission may already include a newborn whose runtime has not yet been
   * initialized. Only a journal-proved birth with no execution history may be
   * absent here; ordinary execution reads remain strict. Missing parent states
   * supply no creation receipts to the team verifier. */
  async readInitializedOperatorInTransaction(
    tx: Prisma.TransactionClient,
    opening: OpeningRecord,
    operatorId: string,
  ): Promise<RequestExecutionBinding | null> {
    const ownerId = opening.base?.requestOwner.operatorId;
    if (!ownerId) {
      unavailable({
        caseId: opening.caseId,
        operatorId,
        reason: "missing Request owner",
      });
    }
    if (operatorId === ownerId) return this.readInTransaction(tx, opening);
    const scope = {
      ...this.#scope,
      executionSpaceId: opening.executionSpaceId,
      operatorId,
    };
    const row = await tx.runtimeState.findFirst({ where: scope });
    if (row) return this.readOperatorInTransaction(tx, opening, operatorId);
    const owner = await this.readInTransaction(tx, opening);
    const chain = await this.journal.readAdmittedSource(tx, opening);
    const pin = requestExecutionPinFor(ownerId, chain.execution, operatorId);
    const index = owner.admission.permissions.operatorIds.indexOf(operatorId);
    if (
      index < 1 || pin.adoption ||
      owner.admission.permissions.modelDigests[index] !== pin.modelDigest ||
      await tx.runtimeRevision.findFirst({ where: scope })
    ) {
      unavailable({
        caseId: opening.caseId,
        operatorId,
        reason: "missing member runtime is not an uninitialized admitted birth",
      });
    }
    return null;
  }
  async readInTransaction(
    tx: Prisma.TransactionClient,
    input: OpeningRecord,
    requester?: ScopedOperatorRef,
  ): Promise<RequestExecutionBinding> {
    return await this.#readInTransaction(
      tx,
      input,
      requester,
      (opening) => this.journal.readAdmittedSource(tx, opening),
    );
  }
  async #readInTransaction(
    tx: Prisma.TransactionClient,
    input: OpeningRecord,
    requester: ScopedOperatorRef | undefined,
    readChain: (opening: OpeningRecord) => Promise<AdmittedSourceChain>,
  ): Promise<RequestExecutionBinding> {
    const opening = structuredClone(input), base = opening.base;
    if (
      canonical(opening.scope) !== canonical(this.#scope) || !base ||
      !opening.baseDigest || opening.executionSpaceId === "main" ||
      !opening.admissionId ||
      await requestSpaceDigest(base) !== opening.baseDigest
    ) unavailable();
    const ownerId = base.requestOwner.operatorId;
    const operatorId = requester?.operatorId ?? ownerId;
    const isOwner = operatorId === ownerId;
    const scope = {
      ...this.#scope,
      executionSpaceId: opening.executionSpaceId,
      operatorId,
    };
    assertPostgresRuntimeScope(scope);
    const persisted = await tx.spaceOpening.findUnique({
      where: {
        projectId_systemId_executionSpaceId: {
          ...this.#scope,
          executionSpaceId: opening.executionSpaceId,
        },
      },
    });
    const space = await tx.executionSpace.findUnique({
      where: {
        projectId_systemId_executionSpaceId: {
          ...this.#scope,
          executionSpaceId: opening.executionSpaceId,
        },
      },
    });
    if (
      !persisted || persisted.id !== opening.id ||
      persisted.caseId !== opening.caseId ||
      persisted.ownerId !== opening.ownerId ||
      persisted.branchId !== opening.branchId ||
      persisted.admissionId !== opening.admissionId ||
      persisted.baseDigest !== opening.baseDigest ||
      persisted.baseJson !== canonical(base) ||
      persisted.commandDigest !== opening.commandDigest ||
      persisted.commandJson !== canonical(opening.command) || !space ||
      space.caseId !== opening.caseId ||
      space.parentExecutionSpaceId !== "main" ||
      !["active", "closed"].includes(space.lifecycle) ||
      (space.lifecycle === "active") !== (space.closedAt === null)
    ) unavailable();
    const current = await tx.runtimeState.findFirst({ where: scope }),
      latest = await tx.runtimeRevision.findFirst({
        where: scope,
        orderBy: { revision: "desc" },
      });
    if (!current || !latest) unavailable();
    const state = decodePostgresRuntimeState(current),
      history = decodeHistorical(latest);
    if (
      history.revision !== state.revision ||
      latest.runtimeStateId !== state.id ||
      !sameVerifiedRuntimeSnapshot(latest.payload, current.payload)
    ) unavailable();
    const model = state.executionModel;
    if (
      !model || model.identity.builderId !== operatorId ||
      requester &&
        !sameScopedOperator(
          requester,
          scopedOperator({
            ...model.identity,
            executionSpaceId: opening.executionSpaceId,
          }, operatorId),
        )
    ) unavailable();
    const chain = await readChain(opening),
      pin = requestExecutionPinFor(ownerId, chain.execution, operatorId);
    const admissionRow = await tx.spaceExecutionAdmission.findFirst({
      where: { ...this.#scope, id: opening.admissionId },
    });
    if (!admissionRow) unavailable();
    const admission = decodeSpaceExecutionAdmission(admissionRow);
    const resources = admission.permissions.resourceIds;
    if (!Array.isArray(resources)) unavailable();
    if (resources.length) {
      const expected = await Promise.all(
        retainedToolDescriptors(opening, admission.id).map(
          retainedToolResourceId,
        ),
      );
      if (
        admission.id !==
          await retainedToolAdmissionId(opening.scope, opening.id) ||
        canonical(resources) !== canonical(expected)
      ) unavailable();
    }
    if (
      admission.openingId !== opening.id ||
      admission.executionSpaceId !== opening.executionSpaceId ||
      admission.ownerId !== opening.ownerId ||
      admission.baseDigest !== opening.baseDigest ||
      // The BO heads the admitted set; further entries are its branch team,
      // one digest per operator, all read from the same current admission.
      admission.permissions.operatorIds[0] !== ownerId ||
      !admission.permissions.operatorIds.includes(operatorId) ||
      new Set(admission.permissions.operatorIds).size !==
        admission.permissions.operatorIds.length ||
      admission.permissions.modelDigests.length !==
        admission.permissions.operatorIds.length ||
      canonical(admission.permissions.acts) !== canonical(["conversation"]) ||
      admission.permissions
          .modelDigests[
            admission.permissions.operatorIds.indexOf(operatorId)
          ] !== pin.modelDigest ||
      admission.permissions.sourceVersion !==
        chain.execution.pin.source.version ||
      model.version.digest !== pin.modelDigest ||
      model.version.repositoryVersion !== pin.source.version
    ) unavailable();
    if (isOwner) {
      const birthCase = state.cases?.find((entry) =>
        entry.id === opening.caseId
      );
      const birthOwner = base.manifest.operators.find((entry) =>
        entry.operatorId === operatorId
      );
      if (
        !birthCase || !birthOwner || birthCase.owner !== operatorId ||
        birthCase.modelPin?.digest !== birthOwner.modelDigest ||
        birthCase.modelPin?.repositoryVersion !==
          base.manifest.source!.sourceVersion
      ) unavailable();
      // The one birth seed of a Request runtime, opener included (4.8d D3).
      const seed = requestSpaceSeed({ ...opening, base });
      assertRequestSpaceBirthIdentity(state, seed, {
        operatorId,
        modelDigest: birthOwner.modelDigest,
        repositoryVersion: base.manifest.source!.sourceVersion,
      });
    } else if (
      state.id !== `request:${opening.executionSpaceId}:${operatorId}` ||
      model.operatorTeam?.requestId !== opening.caseId ||
      model.operatorTeam.requestOwnerId !== ownerId
    ) unavailable();
    if (!pin.adoption) {
      if (isOwner) {
        assertRequestSpaceBirth(
          state,
          requestSpaceSeed({ ...opening, base }),
          model,
        );
      }
    } else {
      const software = chain.execution.softwareAdoptions.find((entry) =>
        entry.manifest.dossierId === pin.adoption!.commandId &&
        entry.manifest.committedRuntimeRevision ===
          pin.adoption!.committedRuntimeRevision
      );
      if (software) {
        const m = software.manifest;
        const digest = await canonicalDigest({
          commandId: m.dossierId,
          committedRuntimeRevision: m.committedRuntimeRevision,
          journalRevision: software.journalRevision,
          journalDigest: software.manifestDigest,
          recordedAt: software.recordedAt,
        });
        const source = chain.softwareReceipts.find((item) =>
          item.revision === m.sourceAdmission.revision &&
          item.manifestDigest === m.sourceAdmission.manifestDigest
        );
        const row = await tx.evolutionDossier.findUnique({
          where: { projectId_systemId_id: { ...this.#scope, id: m.dossierId } },
        });
        if (
          digest !== pin.adoption.receiptDigest || !source || !row ||
          row.kind !== "software-evolution-scoped-v2" ||
          row.executionSpaceId !== opening.executionSpaceId ||
          row.targetScopeKey !== `request:${opening.executionSpaceId}` ||
          state.revision < m.committedRuntimeRevision ||
          admission.revision < m.admissionRevision
        ) unavailable();
        const dossier = await parseScopedSoftwareDossier(
          JSON.parse(row.payload),
        );
        const receipt = dossier.adoptions.find((item) =>
          item.operatorId === operatorId
        );
        if (
          canonical(dossier) !== row.payload || dossier.status !== row.status ||
          dossier.intentDigest !== m.intentDigest ||
          dossier.proposal.digest !== m.proposalDigest || !receipt ||
          receipt.previousDigest !== m.boundary.previousPin.modelDigest ||
          receipt.candidateDigest !== pin.modelDigest ||
          receipt.version !== pin.source.version ||
          (receipt as { manifestDigest?: string }).manifestDigest !==
            software.manifestDigest ||
          canonical(dossier.adoptionAuthorization) !==
            canonical(m.adoptionAuthorization)
        ) unavailable();
        await readScopedSoftwareSourceAdmissionProof(tx, this.client, source);
        const committed = await tx.runtimeRevision.findFirst({
          where: { ...scope, revision: BigInt(m.committedRuntimeRevision) },
        });
        const authorized = await tx.runtimeRevision.findFirst({
          where: { ...scope, revision: BigInt(m.authorizationRuntimeRevision) },
        });
        if (!committed || !authorized) unavailable();
        const adopted = decodeHistorical(committed),
          previous = decodeHistorical(authorized);
        if (
          adopted.id !== state.id || previous.id !== state.id ||
          adopted.executionModel?.version.digest !== pin.modelDigest ||
          adopted.executionModel.version.repositoryVersion !==
            pin.source.version ||
          previous.executionModel?.version.digest !==
            m.boundary.previousPin.modelDigest ||
          previous.executionModel.version.repositoryVersion !==
            m.boundary.previousPin.source.version ||
          previous.events.filter((event) =>
              event.kind === "model-version-admission-authorized" &&
              event.modelAdoptionAuthorization?.softwareEvolution?.dossierId ===
                dossier.id &&
              canonical(
                  event.modelAdoptionAuthorization.softwareEvolution.exercise,
                ) === canonical(dossier.adoptionAuthorization)
            ).length !== 1 ||
          adopted.events.filter((event) =>
              event.effectiveModelUpdate?.dossierId === dossier.id &&
              event.effectiveModelUpdate.caseId === opening.caseId &&
              event.effectiveModelUpdate.to.digest === pin.modelDigest &&
              event.effectiveModelUpdate.activatedAt === receipt.effectiveAt
            ).length !== 1
        ) unavailable();
      } else {
        // A later conversation revision is allowed; the exact committed adoption
        // revision remains immutable proof of the R0 -> R1 transition.
        const last = chain.execution.adoptions.findLast((entry) =>
          entry.manifest.intent.target.operatorId === operatorId
        );
        if (
          !last || last.receipt.receiptDigest !== pin.adoption.receiptDigest ||
          last.receipt.commandId !== pin.adoption.commandId ||
          state.revision < last.manifest.committedRuntimeRevision
        ) unavailable();
        const committed = await tx.runtimeRevision.findFirst({
          where: {
            ...scope,
            revision: BigInt(last.manifest.committedRuntimeRevision),
          },
        });
        const authorized = await tx.runtimeRevision.findFirst({
          where: {
            ...scope,
            revision: BigInt(last.manifest.authorizationRuntimeRevision),
          },
        });
        if (
          !committed || !authorized || committed.runtimeStateId !== state.id ||
          authorized.runtimeStateId !== state.id
        ) unavailable();
        const adopted = decodePostgresRuntimeState(committed),
          previous = decodePostgresRuntimeState(authorized);
        if (
          canonical(adopted.executionModel) !==
            canonical(last.manifest.intent.candidate.model) ||
          previous.executionModel?.version.digest !==
            last.manifest.intent.previous.pin.modelDigest ||
          previous.executionModel?.version.repositoryVersion !==
            last.manifest.intent.previous.pin.source.version ||
          adopted.revision !== last.manifest.committedRuntimeRevision ||
          previous.revision !== last.manifest.authorizationRuntimeRevision ||
          admission.revision < last.manifest.admissionRevision ||
          admission.capabilityId !==
            last.manifest.intent.previous.admission.capabilityId ||
          admission.capabilityRevision !==
            last.manifest.intent.previous.admission.capabilityRevision ||
          admission.createdAt !==
            last.manifest.intent.previous.admission.createdAt ||
          admission.expiresAt !==
            last.manifest.intent.previous.admission.expiresAt
        ) unavailable();
        if (!previous.executionModel) unavailable();
        const network = last.manifest.intent.network;
        if (network) {
          const change = previous.configuration?.changes.find((entry) =>
            entry.id === network.changeId
          );
          const receipt = chain.receipts.find((entry) =>
            entry.revision === network.sourceAdmission.revision
          );
          if (
            !change || !receipt ||
            await canonicalDigest(change) !== network.approvedChangeDigest ||
            canonical({
                kind: "request-network-host-adoption/v1",
                ...await readRequestNetworkSourceAdmissionProof(
                  tx,
                  receipt,
                  this.client,
                ),
              }) !== canonical(network) ||
            await requestNetworkCompatibility(
                previous.executionModel,
                last.manifest.intent.candidate.model,
                change,
              ) !== last.manifest.intent.candidate.compatibilityDigest
          ) unavailable();
        } else if (last.manifest.intent.creationPolicy) {
          const proof = last.manifest.intent.creationPolicy;
          const change = previous.configuration?.changes.find((entry) =>
            entry.id === proof.changeId
          );
          const receipt = chain.receipts.find((entry) =>
            entry.revision === proof.sourceAdmission.revision
          );
          if (
            !change || !receipt ||
            await canonicalDigest(change) !== proof.approvedChangeDigest ||
            canonical({
                kind: "request-creation-policy-adoption/v1",
                ...await readRequestCreationPolicySourceAdmissionProof(
                  tx,
                  receipt,
                  this.client,
                ),
              }) !== canonical(proof) ||
            await requestCreationPolicyCompatibility(
                previous.executionModel,
                last.manifest.intent.candidate.model,
                change,
              ) !==
              last.manifest.intent.candidate.compatibilityDigest
          ) unavailable();
        } else if (last.manifest.intent.team) {
          // A team creation (4.8e E4): the same proof, the creator-side delta.
          const team = last.manifest.intent.team;
          const change = previous.configuration?.changes.find((entry) =>
            entry.id === team.changeId
          );
          const receipt = chain.receipts.find((entry) =>
            entry.revision === team.sourceAdmission.revision
          );
          const proof = receipt
            ? await readRequestTeamSourceAdmissionProof(
              tx,
              receipt,
              this.client,
            )
            : undefined;
          if (receipt) {
            assertRequestTeamPublicationBase(
              team.publicationBase,
              receipt.payload.predecessor.source.version,
              requestWriteAuthorityPrior(receipt.payload.authority),
            );
          }
          const {
            childSystemId: _child,
            team: _members,
            publicationBase: _publicationBase,
            ...published
          } = team;
          if (
            !change || !proof ||
            await canonicalDigest(change) !== team.approvedChangeDigest ||
            canonical({
                kind: "request-team-creation-adoption/v1",
                changeId: proof.changeId,
                proposalIntentDigest: proof.proposalIntentDigest,
                approvedChangeDigest: proof.approvedChangeDigest,
                sourceAdmission: proof.sourceAdmission,
              }) !== canonical(published) ||
            await requestTeamCompatibility(
                previous.executionModel,
                last.manifest.intent.candidate.model,
                change,
                team.publicationBase,
              ) !== last.manifest.intent.candidate.compatibilityDigest
          ) unavailable();
        } else if (
          await requestInstructionCompatibility(
            previous.executionModel,
            last.manifest.intent.candidate.model,
          ) !== last.manifest.intent.candidate.compatibilityDigest
        ) unavailable();
        const authorization = previous.events.filter((event) =>
          event.kind === "model-version-admission-authorized" &&
          event.modelAdoptionAuthorization?.target.version.digest ===
            pin.modelDigest &&
          event.modelAdoptionAuthorization?.target.version.repositoryVersion ===
            pin.source.version &&
          canonical(event.authorityExercise) ===
            canonical(last.manifest.intent.decision.exercise)
        );
        const effective = adopted.events.filter((event) =>
          event.effectiveModelUpdate?.dossierId === last.manifest.commandId &&
          event.effectiveModelUpdate.caseId === opening.caseId &&
          event.effectiveModelUpdate.to.digest === pin.modelDigest &&
          event.effectiveModelUpdate.to.repositoryVersion === pin.source.version
        );
        const admitted = adopted.events.filter((event) =>
          event.kind === "model-version-admitted" &&
          event.caseId === opening.caseId &&
          canonical(event.authorityExercise) ===
            canonical(last.manifest.intent.decision.exercise)
        );
        if (
          authorization.length !== 1 || effective.length !== 1 ||
          admitted.length !== 1
        ) unavailable();
        const dossier = await tx.evolutionDossier.findUnique({
          where: {
            projectId_systemId_id: {
              ...this.#scope,
              id: last.manifest.commandId,
            },
          },
        });
        if (
          !dossier || dossier.kind !== "request-owner-adoption-v2" ||
          dossier.status !== "adopted" ||
          dossier.targetScopeKey !== `request:${opening.executionSpaceId}` ||
          dossier.executionSpaceId !== opening.executionSpaceId
        ) unavailable();
        const payload = await parseRequestOwnerAdoptionDossier(
          JSON.parse(dossier.payload),
        );
        if (
          canonical(payload.receipt) !== canonical(last.receipt) ||
          canonical(payload.intent) !== canonical(last.manifest.intent) ||
          canonical(payload) !== dossier.payload
        ) unavailable();
      }
    }
    return structuredClone({ state, pin, admission });
  }
}
