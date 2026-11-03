/** Narrow evidence for a verified catalog publication; never a general model rebase. */
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";
import { ownerAuthorityFor } from "../../../domain/governance/authority.ts";
import type { CompiledFlow } from "../../../domain/model/execution/flow.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import {
  type NativeCatalogAdvanceEvidence,
  type NativeExecutionContribution,
  type NativeExecutionIdentity,
  type NativeExecutionScope,
  type NativeExecutionSnapshot,
  type NativeMandateAdvanceEvidence,
  type NativeModelAdvanceEvidence,
  type NativeTeamAdvanceEvidence,
  runtimeRevisionReference,
} from "./execution.ts";
import { isTeamOperatorSpec } from "../../../domain/governance/operator-authority.ts";
import { invocationInput, invocationKey } from "../operators/journal.ts";
import { valueDigest } from "./values.ts";

/** Only actual native owners prove a promotion dependency. Terminal receipts
 * settle it only after effects, groups and outgoing contributions are settled. */
export function nativePromotionDependencies(
  state: SystemRuntimeState,
  executions: readonly NativeExecutionSnapshot[],
): NativeExecutionSnapshot[] {
  return executions.filter((execution) =>
    execution.identity.purpose === "promotion" && (
      !["completed", "refused"].includes(execution.status) ||
      execution.unsettledEffects.length > 0 ||
      (execution.openImmutableConsultationGroups?.length ?? 0) > 0 ||
      execution.pendingContributions.some((id) => {
        const receipt = state.pendingContributions?.[id];
        return !receipt || receipt.status === "pending" ||
          !receipt.completionId;
      })
    )
  );
}

function flowContract(compiled: CompiledFlow) {
  const { source: _source, ...contract } = compiled;
  return {
    ...contract,
    nodes: compiled.nodes.map(({ source: _source, assertions, ...node }) => ({
      ...node,
      assertions: assertions.map(({ source: _source, ...assertion }) =>
        assertion
      ),
    })),
    edges: compiled.edges.map(({ sourceEvidence: _source, ...edge }) => edge),
    bindings: compiled.bindings.map(({ sourceEvidence: _source, ...binding }) =>
      binding
    ),
  };
}

function flowContracts(model: ExecutableModel) {
  return {
    flows: Object.fromEntries(
      Object.entries(model.flows).map((
        [key, value],
      ) => [key, flowContract(value)]),
    ),
    ...(model.caseFlows
      ? {
        caseFlows: Object.fromEntries(
          Object.entries(model.caseFlows).map((
            [key, value],
          ) => [key, flowContract(value)]),
        ),
      }
      : {}),
  };
}

export async function nativeUnchangedContractDigest(
  model: ExecutableModel,
): Promise<string> {
  const {
    catalog: _catalog,
    version,
    flows: _flows,
    caseFlows: _caseFlows,
    ...owned
  } = model;
  const {
    repositoryVersion: _repository,
    sourceIds: _sourceIds,
    ...versionContract
  } = version;
  return await executionDigest({
    ...owned,
    version: versionContract,
    ...flowContracts(model),
  });
}

/** Digest of the admitted native flows alone; a mandate publication must leave them intact. */
export async function nativeFlowContractDigest(
  model: ExecutableModel,
): Promise<string> {
  return await executionDigest(flowContracts(model));
}

export async function nativeCatalogAdvanceEvidence(
  previous: ExecutableModel,
  state: SystemRuntimeState,
): Promise<NativeCatalogAdvanceEvidence | undefined> {
  const adopted = state.executionModel;
  if (!adopted || canonical(previous.version) === canonical(adopted.version)) {
    return undefined;
  }
  if (
    !previous.version.repositoryVersion || !adopted.version.repositoryVersion ||
    canonical(previous.identity) !== canonical(adopted.identity)
  ) {
    throw new Error("Catalog continuation requires exact native source pins");
  }
  const unchangedContractDigest = await nativeUnchangedContractDigest(previous);
  if (
    unchangedContractDigest !== await nativeUnchangedContractDigest(adopted)
  ) {
    throw new Error(
      "The publication changed the owned native execution contract",
    );
  }
  const added = adopted.catalog.filter((entry) =>
    !previous.catalog.some((old) => canonical(old) === canonical(entry))
  );
  const removed = previous.catalog.filter((entry) =>
    !adopted.catalog.some((next) => canonical(next) === canonical(entry))
  );
  if (added.length !== 1 || removed.length || added[0].status !== "active") {
    throw new Error(
      "Catalog continuation requires one exact admitted publication",
    );
  }
  const entry = added[0];
  const candidate = state.candidates.find((candidate) =>
    candidate.id === entry.candidateId && candidate.digest === entry.digest
  );
  const event = state.events.findLast((event) =>
    event.kind === "tool-active" && event.candidateId === candidate?.id &&
    event.elementId === candidate?.binding?.elementId
  );
  if (
    !candidate?.admission || !candidate.binding ||
    candidate.stage !== "active" ||
    candidate.admission.candidateDigest !== candidate.digest || !event
  ) {
    throw new Error(
      "Catalog publication lacks its exact canonical admission and active readback receipt",
    );
  }
  return {
    kind: "verified-catalog-advance",
    businessRevision: runtimeRevisionReference(state),
    publicationEventId: event.id,
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    from: {
      identity: structuredClone(previous.identity),
      version: structuredClone(previous.version),
    },
    to: {
      identity: structuredClone(adopted.identity),
      version: structuredClone(adopted.version),
    },
    unchangedContractDigest,
  };
}

/** The separated admission may resume only the conversation that produced this
 * exact published candidate. This verifies canonical provenance, not a general
 * right to replace a pin or to resume an arbitrary retained graph wait. */
export async function nativeCandidateConversationAdvanceEvidence(
  previous: ExecutableModel,
  state: SystemRuntimeState,
  identity: NativeExecutionIdentity,
  contribution: NativeExecutionContribution,
  originalInputMessageId: string | undefined,
) {
  const evidence = await nativeCatalogAdvanceEvidence(previous, state);
  const candidate = evidence &&
    state.candidates.find((entry) => entry.id === evidence.candidateId);
  const input = invocationInput(state);
  if (
    !evidence || !candidate?.admissionDecision ||
    identity.purpose !== "conversation" || contribution.kind !== "resume" ||
    contribution.id !==
      `candidate-decision:${candidate.id}:${await valueDigest(
        candidate.admissionDecision,
      )}` ||
    candidate.admissionDecision.candidateDigest !== candidate.digest ||
    candidate.admissionDecision.verdict !== "approve" ||
    candidate.admission?.candidateId !== candidate.id ||
    !originalInputMessageId || identity.subjectId !== originalInputMessageId ||
    input?.id !== originalInputMessageId ||
    state.activeInputMessageId !== originalInputMessageId ||
    candidate.promotionExecution?.inputMessageId !== originalInputMessageId ||
    contribution.inputMessageId !== undefined &&
      contribution.inputMessageId !== originalInputMessageId ||
    !state.caseInvocation ||
    invocationKey(state.caseInvocation) !== identity.invocationKey ||
    state.executionModel?.identity.builderId !== identity.operatorId ||
    (identity.scope.kind === "request"
      ? candidate.caseId !== identity.scope.scopeId ||
        !!candidate.designerScopeId ||
        state.caseInvocation.kind !== "local" &&
          state.caseInvocation.kind !== "delegated"
      : candidate.designerScopeId !== identity.scope.scopeId ||
        !!candidate.caseId ||
        state.caseInvocation.kind !== "designer" &&
          state.caseInvocation.kind !== "delegated-designer")
  ) {
    throw new Error(
      "The incoming dialogue resume lacks its exact published candidate and original input",
    );
  }
  return evidence;
}

/** A reviewer publication changes future promotion, never the paused dialogue.
 * completePublication has already validated the exact source publication before
 * this immutable business revision is admitted. These checks bound that one
 * recorded transition; they do not grant creation or migrate a promotion run. */
function assertReviewerConversationPublication(
  previous: ExecutableModel,
  adopted: ExecutableModel,
  change: PendingChange,
): void {
  const authority = change.authorityExercise;
  const owner = ownerAuthorityFor(previous);
  const reviewer = adopted.configuration.reviewer;
  const reviewerId = adopted.identity.reviewerId;
  const reviews = adopted.flows.promotion.nodes.filter((node) =>
    node.mechanism === "review_candidate"
  );
  const ownerReceipt = authority &&
    Object.fromEntries(
      Object.keys(owner).map((
        key,
      ) => [key, authority[key as keyof typeof owner]]),
    );
  if (
    change.kind !== "reviewer-creation" || change.role !== "reviewer" ||
    !change.name?.trim() || change.name.length > 80 ||
    canonical(change.mandate) !==
      canonical({
        mayReviewExactCandidate: true,
        mayAdmitReviewedCandidates: true,
      }) ||
    change.authority !== "human" || !authority ||
    authority.authoritySchema !== 2 ||
    authority.action !== "mandate-change" || authority.outOfMandate !== false ||
    authority.baseModelDigest !== previous.version.digest ||
    change.diff?.base.modelDigest !== previous.version.digest ||
    authority.delegation || authority.creationDelegation ||
    authority.candidateDelegation ||
    canonical(ownerReceipt) !== canonical(owner) ||
    canonical(ownerAuthorityFor(adopted)) !== canonical(owner) ||
    previous.policy.mayCreateReviewer !== true ||
    previous.configuration.reviewer || previous.identity.reviewerId ||
    !reviewerId || reviewerId === previous.identity.builderId ||
    canonical({ ...previous.identity, reviewerId }) !==
      canonical(adopted.identity) ||
    !reviewer || reviewer.id !== change.id || reviewer.name !== change.name ||
    reviewer.mandateRevision !== 1 ||
    change.baseRevision !== previous.configuration.revision ||
    adopted.configuration.id !== previous.configuration.id ||
    adopted.configuration.revision !== previous.configuration.revision + 1 ||
    adopted.configuration.builder.mandateRevision !==
      previous.configuration.builder.mandateRevision + 1 ||
    adopted.configuration.builder.admissionAuthority !== "reviewer" ||
    previous.flows.promotion.nodes.some((node) =>
      node.mechanism === "review_candidate"
    ) ||
    reviews.length !== 1 || reviews[0].performerId !== reviewerId ||
    !reviews[0].allocationId ||
    adopted.flows.promotion.nodes.some((node) =>
      node !== reviews[0] && node.performerId === reviewerId
    )
  ) {
    throw new Error(
      "The reviewer continuation lacks its exact approved publication and prior authority",
    );
  }
  const retainedFlows = (model: ExecutableModel) => {
    const contract = flowContracts(model);
    const { promotion: _promotion, ...flows } = contract.flows;
    return { ...contract, flows };
  };
  if (
    canonical(retainedFlows(previous)) !== canonical(retainedFlows(adopted))
  ) {
    throw new Error(
      "The reviewer publication changed the retained conversation or another native flow",
    );
  }
}

/** Spec 4.8d. A mandate or team publication is based at the retained model
 * when its authority base and its displayed source base carry the retained
 * executable digest. The displayed base's commit may be newer: the preview
 * reads the current source, and a sibling's publication may move it without
 * changing this operator's contract; the publisher keeps the commit CAS
 * (HEAD = displayed base). */
export function changeBasedAtRetainedModel(
  change: PendingChange,
  retainedDigest: string,
): boolean {
  return change.baseModelDigest === retainedDigest &&
    change.diff?.base.modelDigest === retainedDigest;
}

/** The ordinary tool admission proposal is offered by the library's presence,
 * outside the digest (`execution-model.ts`, `supportedChanges`). */
function offersToolAdmission(model: ExecutableModel): boolean {
  return model.mandate.supportedChanges.some((change) =>
    change.requestedRights === "toolAdmission"
  );
}

/** The retained-model rule of a mandate or team advance. Beyond the digest,
 * what it leaves out must not move: the catalog (operational state, carried
 * only by a catalog advance) and the tool admission offer. The editing
 * authority roots stay out: they are no right, and decision and publication
 * re-read them on HEAD (`assertApprovable(native)` in
 * mandate-change-decisions.ts:1238, `assertApprovable(current)` in
 * source-model.ts:2260). */
function assertAdvanceFromRetainedModel(
  change: PendingChange,
  previous: ExecutableModel,
  adopted: ExecutableModel,
  subject: string,
): void {
  if (!changeBasedAtRetainedModel(change, previous.version.digest)) {
    throw new Error(`The ${subject} is not based at the retained model`);
  }
  if (canonical(previous.catalog) !== canonical(adopted.catalog)) {
    throw new Error(
      `CATALOG_ADVANCE_REQUIRED: the ${subject} carries a catalog the retained model lacks; only a catalog advance moves it`,
    );
  }
  if (offersToolAdmission(previous) !== offersToolAdmission(adopted)) {
    throw new Error(
      `The ${subject} changed the tool admission offer outside its digest`,
    );
  }
}

/** Narrow evidence for an approved mandate publication; never a general model rebase.
 * The recorded change must be approved (or published while still completing),
 * based at the retained model (`changeBasedAtRetainedModel`) and published exactly at the
 * adopted target pin. Ordinary mandates preserve all flows; an exact reviewer
 * publication may replace only future promotion, preserving the conversation
 * and all Case flows. The evidence always binds the complete target flow set. */
export async function nativeMandateAdvanceEvidence(
  previous: ExecutableModel,
  state: SystemRuntimeState,
  changeId: string,
): Promise<NativeMandateAdvanceEvidence | undefined> {
  const adopted = state.executionModel;
  if (!adopted || canonical(previous.version) === canonical(adopted.version)) {
    return undefined;
  }
  if (
    !previous.version.repositoryVersion || !adopted.version.repositoryVersion
  ) {
    throw new Error("Mandate continuation requires exact native source pins");
  }
  const change = state.configuration?.changes.find((entry) =>
    entry.id === changeId
  );
  // Old-path resumptions read the recorded approval; new-path resumptions
  // read the published approval while it is still completing.
  const completing = change?.status === "pending" && !!change.publishedCommit;
  if (
    !change || !change.decidedAt ||
    change.status !== "approved" && !completing
  ) {
    throw new Error(
      "Mandate continuation requires its exact approved change receipt",
    );
  }
  assertAdvanceFromRetainedModel(change, previous, adopted, "approved change");
  if (change.publishedCommit !== adopted.version.repositoryVersion) {
    throw new Error(
      "The approved change publication is not the adopted target pin",
    );
  }
  if (
    canonical(previous.spaceControlPolicy) !==
      canonical(adopted.spaceControlPolicy)
  ) {
    throw new Error(
      "The mandate publication changed the admitted space-control policy",
    );
  }
  const flowContractDigest = await nativeFlowContractDigest(adopted);
  if (change.kind === "reviewer-creation") {
    assertReviewerConversationPublication(previous, adopted, change);
  } else {
    if (canonical(previous.identity) !== canonical(adopted.identity)) {
      throw new Error("Mandate continuation requires exact native source pins");
    }
    if (await nativeFlowContractDigest(previous) !== flowContractDigest) {
      throw new Error(
        "The mandate publication changed the admitted native flows",
      );
    }
  }
  return {
    kind: "verified-mandate-advance",
    businessRevision: runtimeRevisionReference(state),
    changeId,
    decidedAt: change.decidedAt,
    from: {
      identity: structuredClone(previous.identity),
      version: structuredClone(previous.version),
    },
    to: {
      identity: structuredClone(adopted.identity),
      version: structuredClone(adopted.version),
    },
    flowContractDigest,
  };
}

/** Narrow evidence for a creator's own team publication, decided under its
 * admitted creation grant inside its originating Request (whose owner,
 * `teamOrigin.operatorId`, is the creator only at the first generation). The creator's
 * contract gains the teammate (behaviors, creation policies, configuration);
 * its identity, space-control policy and flows stay exactly as admitted. */
export async function nativeTeamAdvanceEvidence(
  previous: ExecutableModel,
  state: SystemRuntimeState,
  changeId: string,
  /** The continued turn's scope: only its own Request's team publication. */
  scope: NativeExecutionScope,
): Promise<NativeTeamAdvanceEvidence | undefined> {
  const adopted = state.executionModel;
  if (!adopted || canonical(previous.version) === canonical(adopted.version)) {
    return undefined;
  }
  if (
    !previous.version.repositoryVersion || !adopted.version.repositoryVersion
  ) {
    throw new Error("Team continuation requires exact native source pins");
  }
  const change = state.configuration?.changes.find((entry) =>
    entry.id === changeId
  );
  const delegation = change?.authorityExercise?.creationDelegation;
  if (
    !change || change.kind !== "operator-creation" || !change.operator ||
    !isTeamOperatorSpec(change.operator) || !change.teamOrigin ||
    !change.caseId || change.caseId !== change.teamOrigin.requestId ||
    scope.kind !== "request" || change.caseId !== scope.scopeId ||
    change.requestedBy !== previous.identity.builderId ||
    !delegation || delegation.changeId !== change.id ||
    delegation.requestedBy !== change.requestedBy ||
    delegation.actorId !== change.requestedBy
  ) {
    throw new Error(
      "Team continuation requires its exact team publication receipt",
    );
  }
  const completing = change.status === "pending" && !!change.publishedCommit;
  if (!change.decidedAt || change.status !== "approved" && !completing) {
    throw new Error("Team continuation requires its decided team publication");
  }
  assertAdvanceFromRetainedModel(change, previous, adopted, "team publication");
  if (change.publishedCommit !== adopted.version.repositoryVersion) {
    throw new Error("The team publication is not the adopted target pin");
  }
  if (
    canonical(previous.identity) !== canonical(adopted.identity) ||
    canonical(previous.spaceControlPolicy) !==
      canonical(adopted.spaceControlPolicy)
  ) {
    throw new Error(
      "The team publication changed the creator's identity or space policy",
    );
  }
  const flowContractDigest = await nativeFlowContractDigest(adopted);
  if (await nativeFlowContractDigest(previous) !== flowContractDigest) {
    throw new Error("The team publication changed the admitted native flows");
  }
  return {
    kind: "verified-team-advance",
    businessRevision: runtimeRevisionReference(state),
    changeId: change.id,
    caseId: change.caseId,
    decidedAt: change.decidedAt,
    from: {
      identity: structuredClone(previous.identity),
      version: structuredClone(previous.version),
    },
    to: {
      identity: structuredClone(adopted.identity),
      version: structuredClone(adopted.version),
    },
    flowContractDigest,
  };
}

/** The publication a settled turn action produced: the creator's own team
 * publication in this turn's Request at the adopted pin, otherwise exactly one
 * catalog publication. */
export async function nativeSettledActionAdvanceEvidence(
  previous: ExecutableModel,
  state: SystemRuntimeState,
  scope: NativeExecutionScope,
): Promise<
  NativeCatalogAdvanceEvidence | NativeTeamAdvanceEvidence | undefined
> {
  const adopted = state.executionModel;
  if (!adopted || canonical(previous.version) === canonical(adopted.version)) {
    return undefined;
  }
  const team = scope.kind === "request" &&
    state.configuration?.changes.find((change) =>
      change.kind === "operator-creation" && !!change.teamOrigin &&
      change.caseId === scope.scopeId &&
      change.publishedCommit === adopted.version.repositoryVersion &&
      change.baseModelDigest === previous.version.digest
    );
  return team
    ? await nativeTeamAdvanceEvidence(previous, state, team.id, scope)
    : await nativeCatalogAdvanceEvidence(previous, state);
}

/** Re-derives a settled-effect advance from an accepted business revision,
 * under the scope of the turn being continued or recovered. */
export async function rederiveSettledAdvanceEvidence(
  previous: ExecutableModel,
  accepted: SystemRuntimeState,
  evidence: NativeModelAdvanceEvidence,
  scope: NativeExecutionScope,
): Promise<
  NativeCatalogAdvanceEvidence | NativeTeamAdvanceEvidence | undefined
> {
  if (evidence.kind === "verified-catalog-advance") {
    return await nativeCatalogAdvanceEvidence(previous, accepted);
  }
  if (evidence.kind === "verified-team-advance") {
    return await nativeTeamAdvanceEvidence(
      previous,
      accepted,
      evidence.changeId,
      scope,
    );
  }
  throw new Error(
    "A settled action continuation requires catalog or team evidence",
  );
}
