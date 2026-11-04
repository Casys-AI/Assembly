import { retainedMember } from "../domain/work/request-spaces/branch-team.ts";
import type { ClockPort } from "../application/work/runtime/ports.ts";
import { SystemClock } from "../infrastructure/clock.ts";
import type { ScopedOperatorRef } from "../domain/governance/authority.ts";
import { requestExecutionPinFor } from "../application/model/evolution/request-execution-pin.ts";
import {
  isSessionlessRequestAuthority,
  requestWriteAuthorityPrior,
} from "../application/model/source-admission/request-delegated-authority.ts";
import { readScopedSoftwareSourceAdmissionProof } from "../adapters/out/postgres/scoped-software-source-publication-participant.ts";
import type { GitRequestSourceProofReader } from "../adapters/out/git/repository.ts";
import { assertRequestChangeDossier } from "../application/model/publication/request-change.ts";
import { PostgresRequestExecutionBindingReader } from "../adapters/out/postgres/request-execution-binding.ts";
import { RequestSourceOwnerAuthorization } from "../application/model/source-admission/owner-authorization.ts";
import type {
  RequestSourceProposalLocator,
  RequestSourceRevisionAccessPort,
  RequestSourceStoredProposal,
} from "../application/model/source-admission/revision-ports.ts";
import type {
  RequestSourcePublicationProtocol,
  RequestSourceTarget,
  RequestSourceTargetOptions,
  RequestSourceWriteResolver,
} from "../application/model/publication/ports/out/request-source-publication.port.ts";
import { parseRequestSourcePublicationContext } from "../application/model/publication/request-source-context.ts";
import type { SpaceControlPort } from "../application/work/request-spaces/ports.ts";
import type { PostgresHostStorage } from "../adapters/out/postgres/host-storage.ts";
import { PostgresRequestSpaceStore } from "../adapters/out/postgres/request-space-store.ts";
import {
  type AdmittedSourceHead,
  PostgresRequestSourceAdmissionStore,
} from "../adapters/out/postgres/request-source-admission-store.ts";
import { PostgresRequestSourceOwnerSessions } from "../adapters/out/postgres/request-source-owner-session.ts";
import { PostgresRequestSourcePublicationParticipant } from "../adapters/out/postgres/request-source-publication-participant.ts";
import type { PostgresModelWriteQueue } from "../adapters/out/postgres/model-write-queue.ts";
import {
  type RequestSourceOwnerContextOptions,
  RequestSourceOwnerContexts,
} from "../adapters/out/postgres/request-source-owner-context.ts";
import { Prisma } from "../adapters/out/postgres/client.ts";
import {
  parseRequestSourceOwnerPhaseBinding,
  type RequestSourceOwnerPhaseBinding,
} from "../application/model/source-admission/request-source-owner.ts";
import {
  parseRequestModelWriteDestination,
  type RequestModelWriteDestination,
} from "../domain/model/editing/request-write-destination.ts";
import { parseModelWriteDossierV2 } from "../application/model/publication/write-command-v2.ts";
import { canonical } from "../domain/primitives/canonical-json.ts";
import { type OpeningRecord } from "../domain/work/request-spaces/opening.ts";
import { RequestSpaceError } from "../domain/work/request-spaces/scope.ts";
import { type SpaceController } from "../domain/work/request-spaces/space-control.ts";

export interface RequestSourceAdmissionCompositionOptions {
  readonly storage: Pick<
    PostgresHostStorage,
    "client" | "scope" | "primarySpaceControl" | "readCaseRuntimeState"
  >;
  readonly controls: SpaceControlPort;
  readonly repositoryId: string;
  readonly reader: () => Promise<
    & Awaited<ReturnType<RequestSourceOwnerContextOptions["reader"]>>
    & Pick<GitRequestSourceProofReader, "verifyScopedSoftwareSourceAdmission">
  >;
  /** Both functions are bound to the same stored Git repository by the host. */
  readonly requestSourceTarget: (
    options: RequestSourceTargetOptions,
  ) => RequestSourceTarget;
  readonly readRequestSourceProposal: (
    locator: RequestSourceProposalLocator,
    proposalId: string,
  ) => Promise<RequestSourceStoredProposal | null>;
  readonly queue: Pick<
    PostgresModelWriteQueue,
    "transition" | "guardRequestPublication" | "reconcileRequestPublication"
  >;
  readonly leaseMs: number;
  readonly now?: () => string;
  readonly clock?: ClockPort;
}
function refuse(message: string): never {
  throw new RequestSpaceError("UNAVAILABLE", message);
}
function headSource(head: AdmittedSourceHead) {
  return {
    revision: head.revision,
    source: head.source,
    sourceDigest: head.sourceDigest,
  };
}

/** Explicit ready-PRIMARY host composition. Construct no second queue, writer,
 * pool or worker. The host binds participant/resolver to its existing fail-closed
 * lazy delegates before starting automatic writer recovery. */
export function createRequestSourceAdmissionComposition(
  options: RequestSourceAdmissionCompositionOptions,
) {
  const clock = options.clock ?? new SystemClock();
  const { storage, controls } = options,
    scope = Object.freeze(structuredClone(storage.scope)),
    repositoryId = options.repositoryId;
  if (!Number.isFinite(options.leaseMs) || options.leaseMs <= 0) {
    refuse("A positive Request publication lease is required.");
  }
  const primary = storage.primarySpaceControl;
  primary.assertClient(storage.client);
  if (canonical(primary.binding.scope) !== canonical(scope)) {
    refuse("The Request source PRIMARY belongs to another host.");
  }
  const openings = new PostgresRequestSpaceStore(storage.client, scope);
  const admissions = new PostgresRequestSourceAdmissionStore(storage.client);
  const participant = new PostgresRequestSourcePublicationParticipant(
    storage.client,
    primary,
  );
  const admittedSource = async (input: OpeningRecord) => {
    const opening = structuredClone(input);
    if (
      canonical(opening.scope) !== canonical(scope) ||
      opening.base?.manifest.source?.repositoryId !== repositoryId
    ) refuse("The Request source belongs to another host repository.");
    return await storage.client.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
      return await admissions.readAdmittedSource(tx, opening);
    }, { isolationLevel: "RepeatableRead" });
  };
  const sourceContexts = new RequestSourceOwnerContexts({
    storage,
    openings,
    repositoryId,
    sourceProjectId: `git:${repositoryId}`,
    reader: options.reader,
    readAdmittedSource: admittedSource,
    executionBindings: new PostgresRequestExecutionBindingReader(
      storage.client,
      scope,
      admissions,
    ),
  });
  const authorization = new RequestSourceOwnerAuthorization({
    binding: primary.binding,
    sessions: new PostgresRequestSourceOwnerSessions(
      storage.client,
      controls,
      primary,
    ),
    source: sourceContexts,
    now: options.now ?? (() => clock.now()),
  });

  /** `ownerId` null: a host-internal delegated write (4.8c), owned by no session. */
  async function ownedOpening(
    caseId: string,
    ownerId: string | null,
  ): Promise<OpeningRecord> {
    const opening = await openings.forCase(caseId);
    if (
      !opening?.base || !opening.baseDigest || opening.caseId !== caseId ||
      ownerId !== null && opening.ownerId !== ownerId ||
      canonical(opening.scope) !== canonical(scope) ||
      opening.executionSpaceId === "main" ||
      opening.base.manifest.source?.repositoryId !== repositoryId
    ) refuse("The owned Request source is unavailable.");
    return opening;
  }
  async function visible(): Promise<void> {
    const repository = await storage.client.sourceRepository.findUnique({
      where: {
        projectId_systemId_repositoryId: { ...scope, repositoryId },
      },
    });
    if (!repository || repository.sourceScopeId !== scope.systemId) {
      refuse("The registered Request source is unavailable.");
    }
  }
  /** Historical identity/provenance join only. A software predecessor verifies
   * its immutable queue/D2/Git proof without reviving old grants. No current
   * controller/runtime is required; A0 may precede today's A1. */
  async function joined(
    destination: RequestModelWriteDestination,
    ownerId: string | null,
    prior?: ReturnType<typeof requestWriteAuthorityPrior>,
    requester?: ScopedOperatorRef,
  ) {
    if (
      destination.repositoryId !== repositoryId ||
      canonical(destination.host) !== canonical(scope)
    ) refuse("The Request destination belongs to another host.");
    const opening = await ownedOpening(destination.caseId, ownerId);
    if (
      opening.id !== destination.openingId ||
      opening.executionSpaceId !== destination.executionSpaceId ||
      opening.branchId !== destination.branchId ||
      destination.ref !== `refs/heads/requests/${opening.branchId}`
    ) refuse("The immutable Request destination differs.");
    const chain = await admittedSource(opening);
    const history = [
      chain.baseline,
      ...[...chain.receipts, ...chain.softwareReceipts].map((entry) => ({
        revision: entry.revision,
        manifestDigest: entry.manifestDigest,
        source: entry.payload.result.source,
        sourceDigest: entry.payload.result.sourceDigest,
      })),
    ];
    const predecessors = history.filter((head) =>
      canonical(headSource(head)) ===
        canonical(destination.expectedAdmittedSource)
    );
    if (predecessors.length !== 1) {
      refuse("The exact historical Request predecessor is unavailable.");
    }
    const predecessor = predecessors[0];
    const human = chain.receipts.find((entry) =>
      entry.revision === predecessor.revision &&
      entry.manifestDigest === predecessor.manifestDigest
    );
    const software = chain.softwareReceipts.find((entry) =>
      entry.revision === predecessor.revision &&
      entry.manifestDigest === predecessor.manifestDigest
    );
    if (human && software) {
      refuse("The historical Request source family is ambiguous.");
    }
    if (software) {
      // The software receipt establishes the predecessor only. All new human
      // proposal/acceptance authority remains checked by the existing protocol.
      await storage.client.$transaction(
        (tx) =>
          readScopedSoftwareSourceAdmissionProof(tx, storage.client, software),
        { isolationLevel: "RepeatableRead" },
      );
      const reader = await options.reader();
      if (
        reader.repositoryId !== repositoryId ||
        reader.projectId !== `git:${repositoryId}`
      ) refuse("The software predecessor repository differs.");
      await reader.verifyScopedSoftwareSourceAdmission(software.payload);
    }
    if (
      prior && requester &&
      requester.operatorId !== opening.base!.requestOwner.operatorId
    ) {
      const pin = requestExecutionPinFor(
        {
          ...chain.execution,
          adoptions: chain.execution.adoptions.filter((entry) =>
            entry.manifest.intent.candidate.sourceAdmission.revision <=
              predecessor.revision
          ),
        },
        requester.operatorId,
        opening.base!,
      );
      const previous = chain.receipts.filter((entry) =>
        entry.revision <= predecessor.revision
      ).findLast((entry) =>
        entry.payload.result.model.identity.builderId === requester.operatorId
      )?.payload.result.model;
      const birth = chain.execution.adoptions.find((entry) =>
        entry.manifest.intent.team?.team.some((member) =>
          member.operatorId === requester.operatorId
        )
      );
      const retained = retainedMember(opening.base!, requester.operatorId);
      // RequestSpaceAuthorityBridge verifies the roster before delegated publication.
      const team = prior.operatorTeam;
      if (
        requester.executionSpaceId !== opening.executionSpaceId ||
        requester.projectId !== prior.identity.projectId ||
        requester.systemId !== prior.identity.systemId ||
        requester.operatorId !== prior.identity.builderId ||
        prior.identity.projectId !== `git:${repositoryId}` ||
        prior.version.repositoryVersion !== pin.source.version ||
        prior.version.digest !== pin.modelDigest ||
        !team ||
        team.requestOwnerId !== opening.base!.requestOwner.operatorId ||
        (retained
          ? retained.nativeSystemId !== prior.identity.systemId
          : team.parentOperatorId !==
            birth?.manifest.intent.target.operatorId) ||
        (previous
          ? canonical(previous.identity) !== canonical(prior.identity) ||
            previous.digest !== prior.version.digest
          : retained
          ? retained.modelDigest !== prior.version.digest ||
            retained.repositoryVersion !== prior.version.repositoryVersion
          : birth?.manifest.intent.team?.childSystemId !==
            prior.identity.systemId)
      ) refuse("The captured historical Request member differs.");
    } else if (prior) {
      const ownerId = opening.base!.requestOwner.operatorId;
      const previous = [
        ...chain.receipts.filter((entry) =>
          entry.revision <= predecessor.revision &&
          entry.payload.result.model.identity.builderId === ownerId
        ).map((entry) => ({
          revision: entry.revision,
          model: entry.payload.result.model,
        })),
        ...chain.softwareReceipts.filter((entry) =>
          entry.revision <= predecessor.revision
        ).flatMap((entry) =>
          entry.payload.result.targets.filter((target) =>
            target.operatorId === ownerId
          ).map((model) => ({ revision: entry.revision, model }))
        ),
      ].sort((a, b) => b.revision - a.revision)[0]?.model;
      if (software && !previous) {
        refuse("The software predecessor owner model is unavailable.");
      }
      const owner = opening.base!.manifest.operators.filter((entry) =>
        entry.operatorId === opening.base!.requestOwner.operatorId
      );
      if (
        owner.length !== 1 ||
        prior.version.repositoryVersion !== predecessor.source.version ||
        prior.version.digest !== (previous?.digest ?? owner[0].modelDigest) ||
        prior.identity.projectId !== `git:${repositoryId}` ||
        prior.identity.builderId !== opening.base!.requestOwner.operatorId ||
        (previous
          ? canonical(prior.identity) !== canonical(previous.identity)
          : (owner[0].nativeSystemId !== undefined &&
            prior.identity.systemId !== owner[0].nativeSystemId) ||
            (owner[0].systemQualifiedName !== undefined &&
              prior.identity.systemQualifiedName !==
                owner[0].systemQualifiedName))
      ) refuse("The captured historical Request model differs.");
    }
    return { opening, chain, predecessor };
  }
  function leaseMatches(
    lease: { repositoryId: string; commandId: string },
    command: { repositoryId: string; commandId: string },
  ) {
    if (
      lease.repositoryId !== repositoryId ||
      lease.repositoryId !== command.repositoryId ||
      lease.commandId !== command.commandId
    ) refuse("The Request publication lease differs.");
  }

  const protocol: RequestSourcePublicationProtocol = {
    assertProposal: (binding) => authorization.revalidateProposal(binding),
    async assertNewEffect(value) {
      const dossier = await parseModelWriteDossierV2(value);
      const authority = dossier.authority;
      if (isSessionlessRequestAuthority(authority)) {
        // The host decision was revalidated atomically with its record
        // (4.8c A2); the new effect still needs the same opening, chain
        // and prior.
        if (dossier.command.kind !== "approved-change") {
          refuse("A host decision only approves a Case change.");
        }
        await assertRequestChangeDossier(dossier);
        await joined(
          dossier.command.destination,
          null,
          authority.priorModel,
          authority.requester,
        );
        return;
      }
      await joined(
        dossier.command.destination,
        authority.acceptance.principal.controller.ownerId,
        authority.acceptance.priorModel,
      );
      if (dossier.command.kind === "approved-change") {
        await authorization.revalidateApprovedNetwork(authority, dossier);
      } else {
        await authorization.revalidateAcceptance(
          authority,
          dossier.command.kind,
        );
      }
    },
    async guardNewPublication(lease, input, gitEffect) {
      const context = await parseRequestSourcePublicationContext(input);
      leaseMatches(lease, context.dossier.command);
      return await options.queue.guardRequestPublication(
        lease,
        options.leaseMs,
        context,
        gitEffect,
      );
    },
    async settleHistorical(input, lease) {
      const context = await parseRequestSourcePublicationContext(input),
        authority = context.dossier.authority;
      const binding = await joined(
        context.dossier.command.destination,
        isSessionlessRequestAuthority(authority)
          ? null
          : authority.acceptance.principal.controller.ownerId,
        requestWriteAuthorityPrior(authority),
        isSessionlessRequestAuthority(authority)
          ? authority.requester
          : undefined,
      );
      if (lease) {
        leaseMatches(lease, context.dossier.command);
        await options.queue.transition(lease, "publishing");
        await options.queue.reconcileRequestPublication(
          lease,
          options.leaseMs,
          context,
        );
        return;
      }
      const exact = binding.chain.receipts.filter((entry) =>
        entry.payload.command.commandId === context.dossier.command.commandId
      );
      if (
        exact.length !== 1 ||
        canonical(exact[0].payload) !== canonical(context.admission)
      ) refuse("The exact recorded historical Request receipt is unavailable.");
    },
  };
  const resolver: RequestSourceWriteResolver = {
    async resolve(value) {
      const dossier = await parseModelWriteDossierV2(value);
      if (dossier.command.kind === "approved-change") {
        await assertRequestChangeDossier(dossier);
      } else if (
        dossier.command.kind !== "accept-proposal" ||
        dossier.decision.kind !== "accept-proposal" ||
        dossier.decision.author !== "local-owner" ||
        dossier.operations.kind !== "whole-files"
      ) refuse("The Request source write route is unavailable.");
      const authority = dossier.authority;
      if (
        !isSessionlessRequestAuthority(authority) &&
        authority.proposal.principal.controller.ownerId !==
          authority.acceptance.principal.controller.ownerId
      ) {
        refuse("The Request source owner phases differ.");
      }
      const binding = await joined(
        dossier.command.destination,
        isSessionlessRequestAuthority(authority)
          ? null
          : authority.acceptance.principal.controller.ownerId,
        requestWriteAuthorityPrior(authority),
        isSessionlessRequestAuthority(authority)
          ? authority.requester
          : undefined,
      );
      return await options.requestSourceTarget({
        destination: structuredClone(dossier.command.destination),
        openingBaseDigest: binding.opening.baseDigest!,
        predecessorManifestDigest: binding.predecessor.manifestDigest,
        protocol,
      }).bind(dossier);
    },
  };
  async function targetForProposal(
    value: RequestSourceOwnerPhaseBinding<"proposal">,
  ): Promise<RequestSourceTarget> {
    const binding = parseRequestSourceOwnerPhaseBinding(value, "proposal");
    const joinedSource = await joined(
      binding.destination,
      binding.principal.controller.ownerId,
      binding.priorModel,
    );
    if (
      canonical(headSource(joinedSource.chain.head)) !==
        canonical(binding.destination.expectedAdmittedSource)
    ) refuse("The Request proposal source is no longer current.");
    return options.requestSourceTarget({
      destination: structuredClone(binding.destination),
      openingBaseDigest: joinedSource.opening.baseDigest!,
      predecessorManifestDigest: joinedSource.predecessor.manifestDigest,
      protocol,
    });
  }
  const access: RequestSourceRevisionAccessPort = {
    async authorizeRead(secret, caseId) {
      const controller = structuredClone(
        await controls.authenticateSession(secret),
      );
      await access.revalidateRead(controller, caseId);
      return controller;
    },
    async assertOwnedDestination(input, caseId, value) {
      const controller = structuredClone(input),
        destination = parseRequestModelWriteDestination(value);
      if (destination.caseId !== caseId) {
        refuse("The Request source Case differs.");
      }
      await access.revalidateRead(controller, caseId);
      await joined(destination, controller.ownerId);
    },
    async revalidateRead(input, caseId) {
      const controller = structuredClone(input);
      if (canonical(controller.authority.scope) !== canonical(scope)) {
        refuse("The current read channel belongs to another host.");
      }
      await controls.revalidate(controller);
      await ownedOpening(caseId, controller.ownerId);
      await visible();
    },
  };
  async function readProposal(
    input: SpaceController,
    caseId: string,
    proposalId: string,
  ): Promise<RequestSourceStoredProposal | null> {
    const controller = structuredClone(input);
    await access.revalidateRead(controller, caseId);
    const opening = await ownedOpening(caseId, controller.ownerId);
    // Only this static owned locator exists before the scoped journal read.
    const locator: RequestSourceProposalLocator = {
      v: 1,
      kind: "request",
      repositoryId,
      host: scope,
      openingId: opening.id,
      executionSpaceId: opening.executionSpaceId,
      caseId: opening.caseId,
      branchId: opening.branchId,
      ref: `refs/heads/requests/${opening.branchId}`,
    };
    const stored = structuredClone(
      await options.readRequestSourceProposal(
        structuredClone(locator),
        proposalId,
      ),
    );
    if (!stored) {
      await access.revalidateRead(controller, caseId);
      return null;
    }
    const authority = parseRequestSourceOwnerPhaseBinding(
      stored.authority,
      "proposal",
    );
    const destination = parseRequestModelWriteDestination(stored.destination);
    if (
      stored.record.id !== proposalId ||
      stored.record.author !== "local-owner" ||
      stored.record.baseVersion !==
        destination.expectedAdmittedSource.source.version ||
      canonical(authority.destination) !== canonical(destination) ||
      authority.principal.controller.ownerId !== controller.ownerId
    ) refuse("The stored Request proposal differs.");
    const { expectedAdmittedSource: _historical, ...storedLocator } =
      destination;
    if (canonical(storedLocator) !== canonical(locator)) {
      refuse("The stored proposal belongs to another Request.");
    }
    await joined(destination, controller.ownerId, authority.priorModel);
    await access.revalidateRead(controller, caseId);
    return { record: stored.record, authority, destination };
  }
  return {
    admittedSource,
    authorization,
    /** Host-internal source context of a delegated MO decision (4.8c A1). */
    hostSourceContext: (caseId: string, requester?: ScopedOperatorRef) =>
      sourceContexts.resolveForHost(caseId, requester),
    participant,
    resolver,
    targetForProposal,
    access,
    readProposal,
  };
}
