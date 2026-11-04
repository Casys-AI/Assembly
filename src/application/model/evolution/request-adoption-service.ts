import type { ScopedOperatorRef } from "../../../domain/governance/authority.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { canonicalDigest } from "../../../domain/primitives/execution-digest.ts";
import {
  exerciseOwnerAuthority,
  sameOwnerAuthorityIdentity,
} from "../../../domain/governance/authority.ts";
import { spaceControlOwnerIdentity } from "../../../domain/work/policies/request-space-authority.ts";
import {
  exactSourceVersion,
  requestSpaceIdentity,
} from "../../../domain/work/request-spaces/scope.ts";
import {
  assertSameRequestAdoptionCompletion,
  parseRequestAdoptionDecision,
  parseRequestOwnerAdoptionDossier,
  requestInstructionCompatibility,
} from "./request-adoption-invariants.ts";
import {
  type RequestAdoptionContext,
  type RequestAdoptionContextPort,
  type RequestAdoptionDecision,
  type RequestAdoptionEligibility,
  RequestAdoptionError,
  type RequestAdoptionLookup,
  type RequestAdoptionPrepare,
  type RequestAdoptionSession,
  type RequestAdoptionStatus,
  type RequestAdoptionTransitionPort,
  type RequestOwnerAdoptionDossier,
  type RequestOwnerAdoptionStorePort,
  type RequestRuntimeAdoptionPort,
} from "./request-adoption-ports.ts";
import type { OpeningRecord } from "../../../domain/work/request-spaces/opening.ts";
import {
  parseRequestCreationGrantAuthority,
  parseRequestDelegatedAuthority,
  requestCreationGrantAuthorityDigest,
  type RequestCreationGrantAuthorityEnvelope,
  requestDelegatedAuthorityDigest,
  type RequestDelegatedAuthorityEnvelope,
} from "../source-admission/request-delegated-authority.ts";

function validLookup(value: RequestAdoptionLookup): RequestAdoptionLookup {
  const snapshot = structuredClone(value);
  if (
    !snapshot ||
    Object.keys(snapshot).sort().join(",") !== "adoptionKey,caseId" ||
    !requestSpaceIdentity(snapshot.caseId) ||
    !requestSpaceIdentity(snapshot.adoptionKey)
  ) {
    throw new RequestAdoptionError(
      "INVALID",
      "An exact Request and adoption key are required.",
    );
  }
  return snapshot;
}
function requestAdoptionStatus(
  dossier: RequestOwnerAdoptionDossier,
): RequestAdoptionStatus {
  return structuredClone({
    caseId: dossier.intent.target.caseId,
    adoptionKey: dossier.intent.adoptionKey,
    status: dossier.status,
    before: {
      version: dossier.intent.previous.pin.source.version,
      digest: dossier.intent.previous.pin.modelDigest,
    },
    target: {
      version: dossier.intent.candidate.source.version,
      digest: dossier.intent.candidate.model.version.digest,
    },
    blockers: dossier.blockers.map(({ code, detail }) => ({ code, detail })),
    ...(dossier.receipt ? { receipt: dossier.receipt } : {}),
  });
}
/** Who authorizes one adoption: the person's current session, or the MO's
 * recorded delegated network decision (4.8c), host-internal and sessionless. */
interface RequestAdoptionPrincipal {
  readonly requester?: ScopedOperatorRef;
  readonly ownerId: (opening: OpeningRecord) => string;
  opening(caseId: string): Promise<OpeningRecord>;
  revalidate(opening: OpeningRecord): Promise<void>;
  resolve(
    opening: OpeningRecord,
    effectChangeId?: string,
  ): Promise<RequestAdoptionContext>;
  capture(context: RequestAdoptionContext): RequestAdoptionDecision;
  settleObsolete(
    dossier: RequestOwnerAdoptionDossier,
  ): Promise<RequestOwnerAdoptionDossier | null>;
}
function adoptionTarget(opening: OpeningRecord, requester?: ScopedOperatorRef) {
  return {
    v: 1 as const,
    kind: "request" as const,
    repositoryId: opening.base!.manifest.source!.repositoryId,
    host: opening.scope,
    openingId: opening.id,
    executionSpaceId: opening.executionSpaceId,
    caseId: opening.caseId,
    branchId: opening.branchId,
    ref: `refs/heads/requests/${opening.branchId}`,
    operatorId: requester?.operatorId ?? opening.base!.requestOwner.operatorId,
  };
}
/** Human Request use cases are deliberately disjoint from EvolutionService's
 * v1 source publisher/software authority/Main runtime map. */
export class RequestRuntimeAdoptionService
  implements RequestRuntimeAdoptionPort {
  constructor(
    private readonly options: {
      context: RequestAdoptionContextPort;
      store: RequestOwnerAdoptionStorePort;
      transition: RequestAdoptionTransitionPort;
      networkContinuation?: {
        ensure(
          opening:
            import("../../../domain/work/request-spaces/opening.ts").OpeningRecord,
          dossier: RequestOwnerAdoptionDossier,
        ): Promise<void>;
      };
      teamContinuation?: {
        ensure(
          opening:
            import("../../../domain/work/request-spaces/opening.ts").OpeningRecord,
          dossier: RequestOwnerAdoptionDossier,
        ): Promise<void>;
      };
      now(): string;
    },
  ) {}
  private async finish(
    opening:
      import("../../../domain/work/request-spaces/opening.ts").OpeningRecord,
    dossier: RequestOwnerAdoptionDossier,
  ): Promise<RequestAdoptionStatus> {
    if (
      (dossier.intent.network || dossier.intent.creationPolicy) &&
      dossier.status === "adopted" && dossier.receipt
    ) {
      if (!this.options.networkContinuation) {
        throw new RequestAdoptionError(
          "BLOCKED",
          "The Request network continuation is unavailable.",
        );
      }
      await this.options.networkContinuation.ensure(opening, dossier);
    }
    if (
      dossier.intent.team && dossier.status === "adopted" && dossier.receipt
    ) {
      if (!this.options.teamContinuation) {
        throw new RequestAdoptionError(
          "BLOCKED",
          "The Request team continuation is unavailable.",
        );
      }
      await this.options.teamContinuation.ensure(opening, dossier);
    }
    return requestAdoptionStatus(dossier);
  }
  private async commandId(
    ownerId: string,
    opening: OpeningRecord,
    adoptionKey: string,
  ) {
    return `request-adoption:${await canonicalDigest({
      host: opening.scope,
      ownerId,
      openingId: opening.id,
      adoptionKey,
    })}`;
  }
  private capture(
    context: RequestAdoptionContext,
    session: RequestAdoptionSession,
  ) {
    const model = context.binding.state.executionModel,
      controller = session.controller;
    if (
      !model || model.version.authoritySchema !== 2 ||
      model.ownerAuthority?.ownerSource !== "modeled" ||
      !spaceControlOwnerIdentity(
        model.ownerAuthority,
        model.identity.systemId,
      ) ||
      !sameOwnerAuthorityIdentity(
        model.ownerAuthority,
        controller.authority.owner,
      ) || model.identity.builderId !== context.target.operatorId ||
      context.opening.ownerId !== controller.ownerId ||
      canonical(context.target.host) !==
        canonical(controller.authority.scope) ||
      controller.authority.sourceSystemNativeId !== model.identity.systemId
    ) {
      throw new RequestAdoptionError(
        "FORBIDDEN",
        "The current modeled R0 human owner cannot authorize this adoption.",
      );
    }
    return parseRequestAdoptionDecision({
      kind: "request-human-adoption-decision",
      controller,
      sessionRevision: session.sessionRevision,
      exercise: exerciseOwnerAuthority(model, "model-adoption"),
      capturedAt: this.options.now(),
    });
  }
  private async human(secret: string): Promise<RequestAdoptionPrincipal> {
    const session = await this.options.context.authenticate(secret);
    return {
      ownerId: () => session.controller.ownerId,
      opening: (caseId) =>
        this.options.context.ownedOpening(session.controller, caseId),
      revalidate: (opening) =>
        this.options.context.revalidateRead(session, opening),
      resolve: (opening, effectChangeId) =>
        this.options.context.resolve(session, opening, effectChangeId),
      capture: (context) => this.capture(context, session),
      settleObsolete: (dossier) =>
        this.options.transition.settleObsolete(dossier, session),
    };
  }
  /** Host-internal: authorized by the opening, the recorded delegated decision
   * and its publication, never by a session (4.8c A1). Main's policy is not
   * read again: once recorded, the decision stands (A2). */
  private async delegated(
    value: RequestDelegatedAuthorityEnvelope,
  ): Promise<RequestAdoptionPrincipal> {
    const envelope = parseRequestDelegatedAuthority(value),
      digest = await requestDelegatedAuthorityDigest(envelope),
      target = envelope.destination,
      changeId = envelope.route.changeId;
    const matches = (opening: OpeningRecord) =>
      opening.id === target.openingId && opening.caseId === target.caseId &&
      opening.executionSpaceId === target.executionSpaceId &&
      opening.branchId === target.branchId &&
      canonical(opening.scope) === canonical(target.host);
    return {
      requester: envelope.requester,
      ownerId: (opening) => opening.ownerId,
      opening: async (caseId) => {
        const opening = await this.options.context.hostOpening(caseId);
        if (!matches(opening)) {
          throw new RequestAdoptionError(
            "FORBIDDEN",
            "The delegated decision belongs to another Request.",
          );
        }
        return opening;
      },
      revalidate: async (opening) => {
        const latest = await this.options.context.hostOpening(opening.caseId);
        if (
          latest.id !== opening.id ||
          latest.baseDigest !== opening.baseDigest ||
          !matches(latest)
        ) {
          throw new RequestAdoptionError(
            "UNAVAILABLE",
            "The Request selection changed.",
          );
        }
      },
      resolve: (opening, effectChangeId) => {
        if (effectChangeId !== changeId) {
          throw new RequestAdoptionError(
            "FORBIDDEN",
            "A delegated decision adopts only its approved network change.",
          );
        }
        return this.options.context.resolveDelegated(
          opening,
          changeId,
          digest,
          envelope.requester,
        );
      },
      capture: (context) => {
        if (context.network?.changeId !== changeId) {
          throw new RequestAdoptionError(
            "FORBIDDEN",
            "A delegated decision adopts only its approved network change.",
          );
        }
        const model = context.binding.state.executionModel;
        if (!model) {
          throw new RequestAdoptionError(
            "UNAVAILABLE",
            "The executing Request model is unavailable.",
          );
        }
        // Adoption exercises the model owner's authority for adoption, as on
        // the person's path, through the MO's recorded delegation (4.8d D1).
        return parseRequestAdoptionDecision({
          kind: "request-delegated-adoption-decision",
          authorityDigest: digest,
          route: structuredClone(envelope.route),
          exercise: {
            ...exerciseOwnerAuthority(model, "model-adoption"),
            delegation: structuredClone(envelope.exercise.delegation),
          },
          capturedAt: this.options.now(),
        });
      },
      settleObsolete: (dossier) => {
        if (
          dossier.intent.decision.kind !==
            "request-delegated-adoption-decision" ||
          dossier.intent.decision.authorityDigest !== digest
        ) {
          throw new RequestAdoptionError(
            "FORBIDDEN",
            "This adoption was not authorized by this delegated decision.",
          );
        }
        return this.options.transition.settleObsolete(dossier);
      },
    };
  }
  /** Host-internal: authorized by the opening, the recorded creation-grant
   * decision and its publication, never by a session (4.8e). The grant is
   * not read again: once recorded, the decision stands. */
  private async creationGrant(
    value: RequestCreationGrantAuthorityEnvelope,
  ): Promise<RequestAdoptionPrincipal> {
    const envelope = parseRequestCreationGrantAuthority(value),
      digest = await requestCreationGrantAuthorityDigest(envelope),
      target = envelope.destination,
      changeId = envelope.exercise.creationDelegation!.changeId;
    const matches = (opening: OpeningRecord) =>
      opening.id === target.openingId && opening.caseId === target.caseId &&
      opening.executionSpaceId === target.executionSpaceId &&
      opening.branchId === target.branchId &&
      canonical(opening.scope) === canonical(target.host);
    return {
      requester: envelope.requester,
      ownerId: (opening) => opening.ownerId,
      opening: async (caseId) => {
        const opening = await this.options.context.hostOpening(caseId);
        if (!matches(opening)) {
          throw new RequestAdoptionError(
            "FORBIDDEN",
            "The creation-grant decision belongs to another Request.",
          );
        }
        return opening;
      },
      revalidate: async (opening) => {
        const latest = await this.options.context.hostOpening(opening.caseId);
        if (
          latest.id !== opening.id ||
          latest.baseDigest !== opening.baseDigest ||
          !matches(latest)
        ) {
          throw new RequestAdoptionError(
            "UNAVAILABLE",
            "The Request selection changed.",
          );
        }
      },
      resolve: (opening, teamChangeId) => {
        if (teamChangeId !== changeId) {
          throw new RequestAdoptionError(
            "FORBIDDEN",
            "A creation grant adopts only its own team creation.",
          );
        }
        return this.options.context.resolveCreationGrant(
          opening,
          changeId,
          digest,
          envelope.requester,
        );
      },
      capture: (context) => {
        if (context.team?.changeId !== changeId) {
          throw new RequestAdoptionError(
            "FORBIDDEN",
            "A creation grant adopts only its own team creation.",
          );
        }
        const model = context.binding.state.executionModel;
        if (!model) {
          throw new RequestAdoptionError(
            "UNAVAILABLE",
            "The executing Request model is unavailable.",
          );
        }
        return parseRequestAdoptionDecision({
          kind: "request-creation-grant-adoption-decision",
          authorityDigest: digest,
          exercise: {
            ...exerciseOwnerAuthority(model, "model-adoption"),
            creationDelegation: structuredClone(
              envelope.exercise.creationDelegation,
            ),
          },
          capturedAt: this.options.now(),
        });
      },
      settleObsolete: (dossier) => {
        if (
          dossier.intent.decision.kind !==
            "request-creation-grant-adoption-decision" ||
          dossier.intent.decision.authorityDigest !== digest
        ) {
          throw new RequestAdoptionError(
            "FORBIDDEN",
            "This adoption was not authorized by this creation grant.",
          );
        }
        return this.options.transition.settleObsolete(dossier);
      },
    };
  }
  async eligibility(
    secret: string,
    caseId: string,
  ): Promise<RequestAdoptionEligibility> {
    const session = await this.options.context.authenticate(secret),
      opening = await this.options.context.ownedOpening(
        session.controller,
        caseId,
      ),
      context = await this.options.context.resolve(session, opening);
    const current = context.binding.state.executionModel!;
    this.capture(context, session);
    await requestInstructionCompatibility(current, context.candidate.model);
    await this.options.context.revalidateRead(session, opening);
    return {
      caseId,
      eligible: true,
      executing: {
        version: context.binding.pin.source.version,
        digest: context.binding.pin.modelDigest,
      },
      admitted: {
        version: context.candidate.source.version,
        digest: context.candidate.model.version.digest,
      },
      blockers: [],
    };
  }
  async status(
    secret: string,
    input: RequestAdoptionLookup,
  ): Promise<RequestAdoptionStatus | null> {
    const lookup = validLookup(input);
    return await this.statusFor(await this.human(secret), lookup);
  }
  /** Host-internal: never routed from a person's API. */
  async statusDelegated(
    envelope: RequestDelegatedAuthorityEnvelope,
    input: RequestAdoptionLookup,
  ): Promise<RequestAdoptionStatus | null> {
    const lookup = validLookup(input);
    return await this.statusFor(await this.delegated(envelope), lookup);
  }
  /** Host-internal: never routed from a person's API. */
  async statusCreationGrant(
    envelope: RequestCreationGrantAuthorityEnvelope,
    input: RequestAdoptionLookup,
  ): Promise<RequestAdoptionStatus | null> {
    const lookup = validLookup(input);
    return await this.statusFor(await this.creationGrant(envelope), lookup);
  }
  private async statusFor(
    principal: RequestAdoptionPrincipal,
    lookup: RequestAdoptionLookup,
  ): Promise<RequestAdoptionStatus | null> {
    const opening = await principal.opening(lookup.caseId),
      id = await this.commandId(
        principal.ownerId(opening),
        opening,
        lookup.adoptionKey,
      );
    const target = adoptionTarget(opening, principal.requester);
    const stored = await this.options.store.get(target, id);
    await principal.revalidate(opening);
    return stored ? requestAdoptionStatus(stored) : null;
  }
  async prepare(
    secret: string,
    input: RequestAdoptionPrepare,
  ): Promise<RequestAdoptionStatus> {
    return await this.prepareSelected(() => this.human(secret), input);
  }
  /** Historical facade name: the same receipt-bound human path adopts a network
   * addition or a creation policy, each with its own exact compatibility proof. */
  async prepareNetwork(
    secret: string,
    input: RequestAdoptionPrepare & { changeId: string },
  ): Promise<RequestAdoptionStatus> {
    const { changeId, ...request } = structuredClone(input);
    if (typeof changeId !== "string" || !changeId.trim()) {
      throw new RequestAdoptionError("INVALID", "Exact change required.");
    }
    return await this.prepareSelected(
      () => this.human(secret),
      request,
      changeId,
    );
  }
  /** Host-internal: adopts exactly the approved host delta of the MO's
   * recorded decision; no general instruction adoption is delegated. */
  async prepareNetworkDelegated(
    envelope: RequestDelegatedAuthorityEnvelope,
    input: RequestAdoptionPrepare & { changeId: string },
  ): Promise<RequestAdoptionStatus> {
    const { changeId, ...request } = structuredClone(input);
    if (typeof changeId !== "string" || !changeId.trim()) {
      throw new RequestAdoptionError("INVALID", "Exact change required.");
    }
    return await this.prepareSelected(
      () => this.delegated(envelope),
      request,
      changeId,
    );
  }
  async prepareTeam(
    secret: string,
    input: RequestAdoptionPrepare & { changeId: string },
  ): Promise<RequestAdoptionStatus> {
    const { changeId, ...request } = structuredClone(input);
    if (typeof changeId !== "string" || !changeId.trim()) {
      throw new RequestAdoptionError("INVALID", "Exact change required.");
    }
    return await this.prepareSelected(
      () => this.human(secret),
      request,
      changeId,
    );
  }
  /** Host-internal: adopts exactly the one provisioned teammate of the
   * creator's recorded creation-grant decision. */
  async prepareTeamCreationGrant(
    envelope: RequestCreationGrantAuthorityEnvelope,
    input: RequestAdoptionPrepare & { changeId: string },
  ): Promise<RequestAdoptionStatus> {
    const { changeId, ...request } = structuredClone(input);
    if (typeof changeId !== "string" || !changeId.trim()) {
      throw new RequestAdoptionError("INVALID", "Exact change required.");
    }
    return await this.prepareSelected(
      () => this.creationGrant(envelope),
      request,
      changeId,
    );
  }
  private async prepareSelected(
    authorize: () => Promise<RequestAdoptionPrincipal>,
    input: RequestAdoptionPrepare,
    effectChangeId?: string,
  ): Promise<RequestAdoptionStatus> {
    const snapshot = structuredClone(input);
    if (
      !snapshot ||
      Object.keys(snapshot).sort().join(",") !==
        "adoptionKey,caseId,expectedAdmittedVersion,expectedExecutingDigest" ||
      !exactSourceVersion(snapshot.expectedAdmittedVersion) ||
      !/^[a-f0-9]{64}$/.test(snapshot.expectedExecutingDigest)
    ) {
      throw new RequestAdoptionError(
        "INVALID",
        "Exact executing and admitted expectations are required.",
      );
    }
    const lookup = validLookup({
        caseId: snapshot.caseId,
        adoptionKey: snapshot.adoptionKey,
      }),
      principal = await authorize(),
      opening = await principal.opening(lookup.caseId),
      id = await this.commandId(
        principal.ownerId(opening),
        opening,
        lookup.adoptionKey,
      );
    const target = adoptionTarget(opening, principal.requester);
    const existing = await this.options.store.get(target, id);
    if (existing) {
      if (
        existing.intent.candidate.source.version !==
          snapshot.expectedAdmittedVersion ||
        existing.intent.previous.pin.modelDigest !==
          snapshot.expectedExecutingDigest ||
        (existing.intent.network?.changeId ??
            existing.intent.team?.changeId ??
            existing.intent.creationPolicy?.changeId) !== effectChangeId
      ) {
        throw new RequestAdoptionError(
          "CONFLICT",
          "This adoption key already binds another immutable target.",
        );
      }
      await principal.revalidate(opening);
      // Recovery of a known result precedes all fresh-effect readiness checks.
      return await this.finish(opening, existing);
    }
    const context = await principal.resolve(opening, effectChangeId),
      previousModel = context.binding.state.executionModel!;
    if (
      context.candidate.source.version !== snapshot.expectedAdmittedVersion ||
      context.binding.pin.modelDigest !== snapshot.expectedExecutingDigest
    ) {
      throw new RequestAdoptionError(
        "CONFLICT",
        "The executing or admitted Request instruction changed.",
      );
    }
    const decision = principal.capture(context),
      compatibilityDigest = effectChangeId
        ? context.candidate.compatibilityDigest
        : await requestInstructionCompatibility(
          previousModel,
          context.candidate.model,
        );
    if (
      effectChangeId &&
      (context.network?.changeId ?? context.team?.changeId ??
          context.creationPolicy?.changeId) !== effectChangeId
    ) {
      throw new RequestAdoptionError(
        "UNAVAILABLE",
        "Exact approved network proof unavailable.",
      );
    }
    const capturedAt = decision.capturedAt;
    const immutable = {
      target,
      openingBaseDigest: opening.baseDigest!,
      adoptionKey: lookup.adoptionKey,
      previous: {
        pin: context.binding.pin,
        identity: previousModel.identity,
        admission: context.binding.admission,
      },
      candidate: { ...context.candidate, compatibilityDigest },
      decision,
      ...(context.network ? { network: context.network } : {}),
      ...(context.team ? { team: context.team } : {}),
      ...(context.creationPolicy
        ? { creationPolicy: context.creationPolicy }
        : {}),
    };
    const intent = {
      ...immutable,
      commandDigest: await canonicalDigest(immutable),
      accountingDigest: await canonicalDigest({
        id: `evolution:${target.repositoryId}:${id}`,
        agentInvocations: 0,
      }),
    };
    let dossier = await parseRequestOwnerAdoptionDossier({
      v: 2,
      kind: "request-owner-adoption",
      id,
      repositoryId: target.repositoryId,
      revision: 0,
      status: "prepared",
      createdAt: capturedAt,
      updatedAt: capturedAt,
      intent,
      blockers: [],
    });
    await principal.revalidate(opening);
    try {
      dossier = await this.options.store.create(target, dossier);
    } catch (error) {
      const raced = await this.options.store.get(target, id);
      if (
        !raced ||
        raced.intent.candidate.source.version !==
          snapshot.expectedAdmittedVersion ||
        raced.intent.previous.pin.modelDigest !==
          snapshot.expectedExecutingDigest ||
        (raced.intent.network?.changeId ?? raced.intent.team?.changeId ??
            raced.intent.creationPolicy?.changeId) !==
          effectChangeId
      ) throw error;
      await principal.revalidate(opening);
      return await this.finish(opening, raced);
    }
    return await this.finish(
      opening,
      await this.options.transition.attempt(dossier, decision),
    );
  }
  async resume(
    secret: string,
    input: RequestAdoptionLookup,
  ): Promise<RequestAdoptionStatus> {
    const lookup = validLookup(input);
    return await this.resumeFor(await this.human(secret), lookup);
  }
  /** Host-internal: never routed from a person's API. */
  async resumeDelegated(
    envelope: RequestDelegatedAuthorityEnvelope,
    input: RequestAdoptionLookup,
  ): Promise<RequestAdoptionStatus> {
    const lookup = validLookup(input);
    return await this.resumeFor(await this.delegated(envelope), lookup);
  }
  /** Host-internal: never routed from a person's API. */
  async resumeCreationGrant(
    envelope: RequestCreationGrantAuthorityEnvelope,
    input: RequestAdoptionLookup,
  ): Promise<RequestAdoptionStatus> {
    const lookup = validLookup(input);
    return await this.resumeFor(await this.creationGrant(envelope), lookup);
  }
  private async resumeFor(
    principal: RequestAdoptionPrincipal,
    lookup: RequestAdoptionLookup,
  ): Promise<RequestAdoptionStatus> {
    const opening = await principal.opening(lookup.caseId),
      id = await this.commandId(
        principal.ownerId(opening),
        opening,
        lookup.adoptionKey,
      );
    const target = adoptionTarget(opening, principal.requester);
    const dossier = await this.options.store.get(target, id);
    if (!dossier) {
      throw new RequestAdoptionError(
        "UNAVAILABLE",
        "No committed result is known for this adoption key.",
      );
    }
    await principal.revalidate(opening);
    if (
      dossier.receipt || dossier.status === "refused" ||
      dossier.status === "cancelled"
    ) return await this.finish(opening, dossier);
    const settled = await principal.settleObsolete(dossier);
    if (settled) return await this.finish(opening, settled);
    const context = await principal.resolve(
        opening,
        dossier.intent.network?.changeId ?? dossier.intent.team?.changeId ??
          dossier.intent.creationPolicy?.changeId,
      ),
      completion = principal.capture(context);
    assertSameRequestAdoptionCompletion(dossier.intent, completion);
    if (
      canonical(context.binding.pin) !==
        canonical(dossier.intent.previous.pin) ||
      canonical(context.binding.admission) !==
        canonical(dossier.intent.previous.admission) ||
      canonical(context.candidate) !== canonical(dossier.intent.candidate) ||
      canonical(context.network ?? null) !==
        canonical(dossier.intent.network ?? null) ||
      canonical(context.team ?? null) !==
        canonical(dossier.intent.team ?? null) ||
      canonical(context.creationPolicy ?? null) !==
        canonical(dossier.intent.creationPolicy ?? null)
    ) {
      throw new RequestAdoptionError(
        "CONFLICT",
        "The original adoption target or prior admission is no longer current.",
      );
    }
    return await this.finish(
      opening,
      await this.options.transition.attempt(dossier, completion),
    );
  }
}
