import type { OperatorStorage } from "./host-storage.ts";
import type { RequestSpaceRuntimeOptions } from "../../../application/work/request-spaces/runtime.ts";
import type { ScopedSoftwareAdoptionPort } from "../../../application/model/evolution/ports.ts";
import type { PostgresAdmittedRequestRuntime } from "../native-execution/postgres.ts";
import type { ScopedSoftwareEvolutionDossierV2 } from "../../../application/model/evolution/scoped-software-dossier.ts";
import type { ScopedSoftwareSourceAdmissionV2 } from "../../../application/model/source-admission/scoped-software-source-admission.ts";
import { EvolutionError } from "../../../application/model/evolution/ports.ts";
import {
  emptyNativeEvolutionAwait,
  evolutionBudgetScopes,
} from "../../../application/work/runtime/evolution.ts";
import { caseBudgetPolicy } from "../../../application/work/cases/runtime.ts";
import {
  projectEvolutionBudgets,
  retainedBudgetPolicy,
} from "../../../application/work/runtime/evolution-budget-projection.ts";
import { runtimeRevisionReference } from "../../../application/work/native-execution/contract.ts";
import {
  type ScopedSoftwareAdoptionManifestV2,
  type ScopedSoftwareAdoptionReceiptV2,
} from "../../../application/model/evolution/scoped-software-adoption.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { canonicalDigest } from "../../../domain/primitives/execution-digest.ts";
import type { PostgresEvolutionStore } from "./evolution-store.ts";
import type { PostgresRequestSourceAdmissionStore } from "./request-source-admission-store.ts";
import type { PostgresRequestExecutionBindingReader } from "./request-execution-binding.ts";
import { readScopedSoftwareSourceAdmissionProof } from "./scoped-software-source-publication-participant.ts";
import { postgresQualifiedTable, Prisma, type PrismaClient } from "./client.ts";
import { decodeHistorical } from "./system-state-store.ts";
import {
  parseScopedSoftwareNeverStartedSuccessorContext,
  type ScopedSoftwareNeverStartedSuccessorContext,
} from "../../../application/work/evolution/scoped-software-adoption-successor.ts";

/** Composition must provide real locked native-policy revalidation and Git
 * anchor verification. Neither is inferred from the persisted receipt. */
export class PostgresScopedSoftwareAdoptionTransition
  implements ScopedSoftwareAdoptionPort<OperatorStorage> {
  constructor(
    private readonly options: {
      client: PrismaClient;
      store: PostgresEvolutionStore;
      journal: PostgresRequestSourceAdmissionStore;
      binding: PostgresRequestExecutionBindingReader;
      native: PostgresAdmittedRequestRuntime;
      dependencies: RequestSpaceRuntimeOptions<OperatorStorage>["dependencies"];
      verifyGit(admission: ScopedSoftwareSourceAdmissionV2): Promise<void>;
      withRepositoryLock<T>(operation: () => Promise<T>): Promise<T>;
      lockPrimary(tx: Prisma.TransactionClient): Promise<void>;
      assertAdmissionLocked(
        tx: Prisma.TransactionClient,
        dossier: ScopedSoftwareEvolutionDossierV2,
      ): Promise<void>;
      prepareCurrent(
        dossier: ScopedSoftwareEvolutionDossierV2,
      ): Promise<object>;
      assertCurrentPreparedLocked(
        tx: Prisma.TransactionClient,
        dossier: ScopedSoftwareEvolutionDossierV2,
        token: object,
      ): Promise<void>;
      restore(
        opening: import("../../../domain/work/request-spaces.ts").OpeningRecord,
      ): Promise<void>;
      failed(error: unknown): void;
      now(): string;
    },
  ) {}
  private fail(message: string): never {
    throw new EvolutionError("EVOLUTION_ADOPTION_MISMATCH", message);
  }

  async inspect(
    input: Parameters<
      ScopedSoftwareAdoptionPort<OperatorStorage>["inspect"]
    >[0],
  ): Promise<ScopedSoftwareAdoptionReceiptV2 | null> {
    const { dossier, target, publication, runtime } = input;
    const chain = await this.options.client.$transaction(
      (tx) => this.options.journal.readAdmittedSource(tx, runtime.opening),
      { isolationLevel: "RepeatableRead" },
    );
    const found = chain.execution.softwareAdoptions.find((entry) =>
      entry.manifest.dossierId === dossier.id &&
      entry.manifest.target.operatorId === target.operatorId
    );
    if (!found) return null;
    const source = chain.softwareReceipts.find((item) =>
      item.revision === found.manifest.sourceAdmission.revision &&
      item.manifestDigest === found.manifest.sourceAdmission.manifestDigest
    );
    const recorded = dossier.adoptions.find((item) =>
      item.operatorId === target.operatorId
    ) as ScopedSoftwareAdoptionReceiptV2 | undefined;
    if (
      !source || !recorded ||
      recorded.manifestDigest !== found.manifestDigest ||
      recorded.journalRevision !== found.journalRevision ||
      found.manifest.intentDigest !== dossier.intentDigest ||
      found.manifest.proposalDigest !== dossier.proposal.digest ||
      recorded.version !== publication.version
    ) this.fail("Historical scoped adoption evidence differs");
    await this.options.verifyGit(source.payload);
    await this.options.client.$transaction(async (tx) => {
      await readScopedSoftwareSourceAdmissionProof(
        tx,
        this.options.client,
        source,
      );
      const history = await tx.runtimeRevision.findFirst({
        where: {
          ...runtime.opening.scope,
          executionSpaceId: runtime.opening.executionSpaceId,
          operatorId: target.operatorId,
          revision: BigInt(found.manifest.committedRuntimeRevision),
        },
      });
      if (!history) this.fail("Historical runtime receipt is absent");
      const state = decodeHistorical(history);
      if (
        state.executionModel?.version.digest !== target.candidateDigest ||
        state.executionModel.version.repositoryVersion !==
          publication.version ||
        state.events.filter((event) =>
            event.effectiveModelUpdate?.dossierId === dossier.id &&
            event.effectiveModelUpdate.caseId === runtime.opening.caseId &&
            event.effectiveModelUpdate.to.digest === target.candidateDigest &&
            event.effectiveModelUpdate.activatedAt === recorded.effectiveAt
          ).length !== 1
      ) this.fail("Historical runtime adoption differs");
    }, { isolationLevel: "RepeatableRead" });
    return structuredClone(recorded);
  }

  async adopt(
    input: Parameters<ScopedSoftwareAdoptionPort<OperatorStorage>["adopt"]>[0],
  ): Promise<ScopedSoftwareAdoptionReceiptV2> {
    const receipt = await this.options.withRepositoryLock(() =>
      this.adoptLocked(input)
    );
    try {
      await this.options.restore(input.runtime.opening);
    } catch (error) {
      // The durable commit cannot be undone by a failed runtime refresh.
      try {
        this.options.failed(
          new Error(
            `Software evolution ${input.dossier.id} committed, but its runtime could not be restored`,
            { cause: error },
          ),
        );
      } catch { /* A diagnostic sink cannot undo a committed adoption. */ }
    }
    return receipt;
  }

  private async adoptLocked(
    input: Parameters<ScopedSoftwareAdoptionPort<OperatorStorage>["adopt"]>[0],
  ): Promise<ScopedSoftwareAdoptionReceiptV2> {
    const { dossier, target, publication, runtime, candidate, boundary } =
      input;
    const opening = runtime.opening;
    const state = await runtime.runtime.readPersistedState();
    if (
      !state || canonical(state) !== canonical(runtime.runtime.snapshot) ||
      state.revision !== boundary.previousRuntimeRevision ||
      await canonicalDigest({
          state,
          nativeSnapshots: boundary.nativeSnapshots,
        }) !== boundary.checkpointDigest
    ) this.fail("Final boundary drifted");
    if (!state.executionModel) this.fail("Previous execution model is missing");
    const budgetScopes = evolutionBudgetScopes(state);
    const budgetIds = [...new Set(budgetScopes.map((scope) => scope.scopeId))];
    const budgetInputs = budgetScopes.filter((scope) =>
      scope.ownerId === target.operatorId && !scope.pending
    ).map((scope) => ({
      scopeId: scope.scopeId,
      ownerId: scope.ownerId,
      previousPolicy: retainedBudgetPolicy(state, scope),
      policy: scope.designer
        ? candidate.workBudgetPolicy
        : caseBudgetPolicy(candidate, scope.caseTypeId, scope.ceiling),
      modelVersion: candidate.version,
    }));
    const budget = await runtime.stores.budget.prepareEvolutionBatch(
      budgetIds,
      budgetInputs,
    );
    const initial = await this.options.client.$transaction(async (tx) => ({
      binding: await this.options.binding.readInTransaction(tx, opening),
      chain: await this.options.journal.readAdmittedSource(tx, opening),
    }), { isolationLevel: "RepeatableRead" });
    if (
      canonical(initial.binding.state) !== canonical(state) ||
      canonical(initial.binding.pin) !== canonical(boundary.previousPin)
    ) this.fail("Final execution pin changed");
    const source = initial.chain.softwareReceipts.find((item) =>
      item.payload.evolutionDossierId === dossier.id &&
      item.payload.proposalDigest === dossier.proposal.digest &&
      item.payload.result.source.version === publication.version
    );
    if (
      !source || source.revision !== initial.chain.head.revision ||
      source.manifestDigest !== initial.chain.head.manifestDigest
    ) this.fail("Exact software source admission missing");
    if (
      !("sourceAdmission" in publication) ||
      canonical(publication.sourceAdmission) !==
        canonical({
          revision: source.revision,
          manifestDigest: source.manifestDigest,
        })
    ) this.fail("Publication lacks exact software D2 receipt");
    await this.options.verifyGit(source.payload);
    const at = this.options.now();
    // Match human adoption's detached candidate preparation. These dependencies
    // describe the future state only; no live admission or runtime is replaced.
    const prospective = { current: structuredClone(state) };
    prospective.current.executionModel = structuredClone(candidate);
    prospective.current.model = structuredClone(candidate.identity);
    const dependencies = this.options.dependencies(
      runtime.stores,
      candidate,
      () => prospective.current,
    );
    const states = await runtime.runtime.prepareSoftwareEvolutionStates({
      dossier,
      target,
      publication:
        publication as import("../../../application/model/evolution/scoped-software-adoption.ts").ScopedSoftwarePublicationV2,
      candidate,
      boundary,
      at,
      information: {
        hasConsultModel: Boolean(dependencies.information?.consultModel),
        modelTools: dependencies.information?.modelTools?.(candidate),
      },
    });
    prospective.current = states.adopted;
    const projected = await projectEvolutionBudgets(
      states.adopted,
      budget.projected,
    );
    if (projected.reserved.length) {
      this.fail("Unsettled budget reservation blocks adoption");
    }
    states.adopted = projected.state;
    if (
      states.authorization.revision !== state.revision + 1 ||
      states.adopted.revision !== state.revision + 2 ||
      canonical(states.authorization.executionModel) !==
        canonical(state.executionModel) ||
      canonical(states.adopted.executionModel) !== canonical(candidate)
    ) this.fail("Invalid final state sequence");
    const authorizationPacket = runtime.stores.state.prepareSave(
      states.authorization,
      state.revision,
    );
    const adoptedPacket = runtime.stores.state.prepareSave(
      states.adopted,
      states.authorization.revision,
    );
    const scoped = await this.options.native.forCaseSpace(
      opening.executionSpaceId,
      opening.caseId,
    );
    const selected = boundary.nativeSnapshots.filter((snapshot) =>
      emptyNativeEvolutionAwait(state, snapshot)
    );
    let prior: ScopedSoftwareNeverStartedSuccessorContext | undefined;
    let priorSource: typeof source | undefined;
    if (boundary.previousPin.adoption) {
      const previous = boundary.previousPin.adoption;
      const software = initial.chain.execution.softwareAdoptions.find((item) =>
        item.manifest.dossierId === previous.commandId &&
        item.manifest.committedRuntimeRevision ===
          previous.committedRuntimeRevision
      );
      const human = initial.chain.execution.adoptions.find((item) =>
        item.receipt.commandId === previous.commandId &&
        item.receipt.receiptDigest === previous.receiptDigest
      );
      if (software && human || !software && !human) {
        this.fail("Prior execution lineage is ambiguous");
      }
      if (software) {
        priorSource = initial.chain.softwareReceipts.find((item) =>
          item.revision === software.manifest.sourceAdmission.revision &&
          item.manifestDigest ===
            software.manifest.sourceAdmission.manifestDigest
        );
        if (!priorSource) {
          this.fail("Prior software source admission is unavailable");
        }
        await this.options.verifyGit(priorSource.payload);
        prior = await parseScopedSoftwareNeverStartedSuccessorContext({
          currentPin: boundary.previousPin,
          previous: {
            kind: "software",
            ...software,
            source: priorSource.payload,
          },
        });
      } else {
        prior = await parseScopedSoftwareNeverStartedSuccessorContext({
          currentPin: boundary.previousPin,
          previous: {
            kind: "human",
            manifest: human!.manifest,
            receipt: human!.receipt,
          },
        });
      }
    }
    const nativePacket = await scoped.ledger
      .prepareScopedSoftwareRetirementBatch(
        selected,
        {
          kind: "software-evolution-scoped-adoption",
          dossierId: dossier.id,
          intentDigest: dossier.intentDigest,
          proposalDigest: dossier.proposal.digest,
          businessRevision: runtimeRevisionReference(states.authorization),
          authorizationEventId: states.authorizationEventId,
          adoptionAuthorization: dossier.adoptionAuthorization!,
        },
        candidate,
        prior,
      );
    await input.revalidate();
    const preparedAuthority = await this.options.prepareCurrent(dossier);
    const receipt = await this.options.client.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '250ms'`);
      // PRIMARY SHARE precedes native locks safely only while every native
      // retirement lock uses NOWAIT. The timeout bounds unrelated SQL waits.
      await this.options.lockPrimary(tx);
      const nativeLock = await scoped.ledger.lockRetirementInTransaction(
        tx,
        nativePacket,
      );
      await this.options.assertAdmissionLocked(tx, dossier);
      const dossierLock = await this.options.store
        .lockScopedDossierInTransaction(tx, dossier);
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM ${
          postgresQualifiedTable(this.options.client, "SpaceControlCredential")
        } WHERE "projectId"=${opening.scope.projectId} AND "systemId"=${opening.scope.systemId} AND "id"=${initial.binding.admission.capabilityId} FOR SHARE NOWAIT`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM ${
          postgresQualifiedTable(this.options.client, "SpaceOpening")
        } WHERE "projectId"=${opening.scope.projectId} AND "systemId"=${opening.scope.systemId} AND "id"=${opening.id} FOR UPDATE NOWAIT`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "executionSpaceId" FROM ${
          postgresQualifiedTable(this.options.client, "ExecutionSpace")
        } WHERE "projectId"=${opening.scope.projectId} AND "systemId"=${opening.scope.systemId} AND "executionSpaceId"=${opening.executionSpaceId} FOR SHARE NOWAIT`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM ${
          postgresQualifiedTable(this.options.client, "SpaceExecutionAdmission")
        } WHERE "projectId"=${opening.scope.projectId} AND "systemId"=${opening.scope.systemId} AND "id"=${initial.binding.admission.id} FOR UPDATE NOWAIT`,
      );
      const budgetLock = await runtime.stores.budget
        .lockEvolutionBatchInTransaction(tx, budget.packet);
      const stateLock = await runtime.stores.state.lockMutationInTransaction(
        tx,
      );
      const binding = await this.options.binding.readInTransaction(tx, opening);
      const chain = await this.options.journal.readAdmittedSource(tx, opening);
      if (
        canonical(binding) !== canonical(initial.binding) ||
        canonical(chain.cursor) !== canonical(initial.chain.cursor) ||
        canonical(chain.execution.pin) !== canonical(boundary.previousPin)
      ) this.fail("Locked boundary changed");
      await readScopedSoftwareSourceAdmissionProof(
        tx,
        this.options.client,
        source,
      );
      if (priorSource) {
        await readScopedSoftwareSourceAdmissionProof(
          tx,
          this.options.client,
          priorSource,
        );
      }
      await scoped.ledger.assertRetirementPreparedLocked(
        tx,
        nativePacket,
        nativeLock,
      );
      await this.options.assertCurrentPreparedLocked(
        tx,
        dossier,
        preparedAuthority,
      );
      const cutoff = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma
          .sql`WITH cutoff AS MATERIALIZED (SELECT clock_timestamp() AS at) SELECT a."id" FROM cutoff, ${
          postgresQualifiedTable(this.options.client, "SpaceExecutionAdmission")
        } a, ${
          postgresQualifiedTable(this.options.client, "SpaceControlCredential")
        } c, ${
          postgresQualifiedTable(this.options.client, "ExecutionSpace")
        } s, ${
          postgresQualifiedTable(this.options.client, "SpaceOpening")
        } o WHERE a."projectId"=${opening.scope.projectId} AND a."systemId"=${opening.scope.systemId} AND a."id"=${binding.admission.id} AND a."revision"=${binding.admission.revision} AND a."status"='active' AND a."expiresAt">cutoff.at AND c."projectId"=a."projectId" AND c."systemId"=a."systemId" AND c."id"=a."capabilityId" AND c."revision"=a."capabilityRevision" AND c."kind"='capability' AND c."status"='active' AND s."projectId"=a."projectId" AND s."systemId"=a."systemId" AND s."executionSpaceId"=a."executionSpaceId" AND s."caseId"=${opening.caseId} AND s."parentExecutionSpaceId"='main' AND s."lifecycle"='active' AND s."closedAt" IS NULL AND o."projectId"=a."projectId" AND o."systemId"=a."systemId" AND o."id"=a."openingId" AND o."phase"='dispatched'`,
      );
      if (cutoff.length !== 1) this.fail("Execution admission expired");
      await runtime.stores.state.savePreparedInTransaction(
        tx,
        authorizationPacket,
        stateLock,
      );
      await runtime.stores.budget.saveEvolutionBatchLocked(
        tx,
        budget.packet,
        budgetLock,
      );
      const nativeRetirement = await scoped.ledger.retirePreparedLocked(
        tx,
        nativePacket,
        nativeLock,
      );
      await runtime.stores.state.savePreparedInTransaction(
        tx,
        adoptedPacket,
        stateLock,
      );
      const manifest: ScopedSoftwareAdoptionManifestV2 = {
        format: "request-software-runtime-adoption/v2",
        dossierId: dossier.id,
        intentDigest: dossier.intentDigest,
        proposalDigest: dossier.proposal.digest,
        target: boundary.target,
        sourceAdmission: {
          revision: source.revision,
          manifestDigest: source.manifestDigest,
        },
        boundary,
        adoptionAuthorization: dossier.adoptionAuthorization!,
        predecessor: chain.cursor,
        authorizationRuntimeRevision: states.authorization.revision,
        committedRuntimeRevision: states.adopted.revision,
        admissionRevision: binding.admission.revision + 1,
        nativeRetirement,
      };
      const journalPacket = await this.options.journal
        .prepareSoftwareAdoptionAppend(opening, manifest);
      const journal = await this.options.journal
        .appendSoftwareAdoptionPreparedLocked(tx, opening, journalPacket);
      const permissions = {
        ...binding.admission.permissions,
        sourceVersion: publication.version,
        modelDigests: [target.candidateDigest],
      };
      const advance = await tx.spaceExecutionAdmission.updateMany({
        where: {
          ...opening.scope,
          id: binding.admission.id,
          openingId: opening.id,
          executionSpaceId: opening.executionSpaceId,
          revision: binding.admission.revision,
          status: "active",
          capabilityId: binding.admission.capabilityId,
          capabilityRevision: binding.admission.capabilityRevision,
        },
        data: {
          revision: binding.admission.revision + 1,
          permissionsJson: canonical(permissions),
        },
      });
      if (advance.count !== 1) this.fail("Admission pin changed");
      const receipt: ScopedSoftwareAdoptionReceiptV2 = {
        operatorId: target.operatorId,
        previousDigest: target.previousDigest,
        candidateDigest: target.candidateDigest,
        version: publication.version,
        proposalDigest: dossier.proposal.digest,
        effectiveAt: at,
        target: boundary.target,
        manifestDigest: journal.manifestDigest,
        journalRevision: journal.journalRevision,
        authorizationRuntimeRevision: states.authorization.revision,
        committedRuntimeRevision: states.adopted.revision,
      };
      const adoptions = [...dossier.adoptions, receipt];
      const next: ScopedSoftwareEvolutionDossierV2 = {
        ...dossier,
        revision: dossier.revision + 1,
        updatedAt: journal.recordedAt,
        status: adoptions.length === dossier.proposal.targets.length
          ? "adopted"
          : "published-awaiting-adoption",
        adoptions,
        blockers: [],
      };
      const packet = await this.options.store.prepareScopedAdoptionSwap(
        dossier,
        next,
        manifest,
        receipt,
      );
      await this.options.store.completeScopedAdoptionLocked(
        tx,
        packet,
        dossierLock,
      );
      return receipt;
    }, { isolationLevel: "ReadCommitted", maxWait: 500, timeout: 5000 });
    return receipt;
  }
}
