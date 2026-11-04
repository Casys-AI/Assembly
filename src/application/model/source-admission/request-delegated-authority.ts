/** Spec 4.8c C9, amendments A1/A2: the Main Operator's decision for a covered
 * Branch Operator request, published in that BO's branch beside the human
 * proof. The host constructs it from the registered Main and the bridge's
 * verified opening proof; no person-facing API accepts, parses or forwards it,
 * and it borrows no human session. */
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  canonicalDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";
import type { AuthorityExercise } from "../../../domain/governance/authority.ts";
import {
  MAIN_EXECUTION_SPACE_ID,
  mainExecutionSpace,
  OperatorAuthorityError,
  type RequestAuthorityRoute,
  sameScopedOperator,
} from "../../../domain/governance/operator-authority.ts";
import {
  type ExecutionSpaceRef,
  type ScopedOperatorRef,
} from "../../../domain/governance/authority.ts";
import { delegatedAuthorityExercise } from "../../../domain/governance/policies/operator-authority-policy.ts";
import {
  assertCreationWithinPolicy,
  creationAuthorityExercise,
  requestCreationScope,
} from "../../../domain/governance/policies/operator-creation-policy.ts";
import { MAX_BRANCH_TEAM } from "../../../domain/work/records/conversations.ts";
import { scopedOperator } from "../../../domain/governance/policies/delegation-scope.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { ModelIdentity } from "../../../domain/shared-kernel/model-identity.ts";
import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import {
  parseRequestModelWriteDestination,
  type RequestModelWriteDestination,
} from "../../../domain/model/editing/request-write-destination.ts";
import type { OperatorCommandOrigin } from "../../work/operators/command-delivery.ts";
import { requestAuthorityRoute } from "../../governance/request-authority-routing.ts";
import type {
  OpeningRecord,
  SpaceExecutionAdmission,
} from "../../../domain/work/request-spaces.ts";
import {
  parseRequestSourceOwnerAuthority,
  requestSourceOwnerAuthorityDigest,
  type RequestSourceOwnerAuthorityEnvelope,
} from "./request-source-owner.ts";

export interface RequestDelegatedAuthorityEnvelope {
  readonly v: 1;
  readonly kind: "request-delegated-authority";
  /** The BO's branch; never main. */
  readonly destination: RequestModelWriteDestination;
  readonly priorModel: {
    readonly identity: ModelIdentity;
    readonly operatorTeam?: ExecutableModel["operatorTeam"];
    readonly version: {
      readonly digest: string;
      readonly repositoryVersion: string;
    };
  };
  readonly decider: ScopedOperatorRef;
  readonly requester: ScopedOperatorRef;
  readonly policy: {
    readonly id: string;
    readonly revision: number;
    readonly elementId: string;
    readonly space: ExecutionSpaceRef;
  };
  /** `actor-decision` designating the decider when the choice was captured. */
  readonly route: RequestAuthorityRoute;
  /** The MO's native effect: one decision per operator command (A4). */
  readonly origin: OperatorCommandOrigin;
  readonly exercise: AuthorityExercise;
  readonly capturedAt: string;
}

/**
 * Spec 4.8e E4: an `autonomous` team creation decided in its own branch.
 * The verified `creationDelegation` receipt is the authority — the
 * human-approved grant is the prior approval — so there is no session and
 * no decider distinct from the creator. Host-internal like the delegated
 * envelope; no person-facing port accepts or forwards one (A1).
 */
export interface RequestCreationGrantAuthorityEnvelope {
  readonly v: 1;
  readonly kind: "request-creation-grant";
  /** The creator's branch; never main. */
  readonly destination: RequestModelWriteDestination;
  readonly priorModel: {
    readonly identity: ModelIdentity;
    readonly operatorTeam?: ExecutableModel["operatorTeam"];
    readonly version: {
      readonly digest: string;
      readonly repositoryVersion: string;
    };
  };
  /** The creator, in its branch. */
  readonly requester: ScopedOperatorRef;
  /** Where the grant was read: the creator's branch (E1). */
  readonly space: ExecutionSpaceRef;
  /** The whole-team size the grant was exercised against (settled Q5). */
  readonly branchTeamSize: number;
  readonly exercise: AuthorityExercise;
  readonly capturedAt: string;
}

/** The authorities of a Request write: the person's, the MO's delegated
 * decision, or the creator's branch-read creation grant (4.8e). */
export type RequestWriteAuthority =
  | RequestSourceOwnerAuthorityEnvelope
  | RequestDelegatedAuthorityEnvelope
  | RequestCreationGrantAuthorityEnvelope;

export class RequestDelegatedAuthorityError extends Error {
  readonly code = "REQUEST_DELEGATED_AUTHORITY_INVALID";
  readonly recovery = {
    action: "recompute-from-the-registered-main",
  } as const;
  constructor(readonly context: { reason: string; path?: string }) {
    super(`Request delegated authority invalid: ${context.reason}`);
    this.name = "RequestDelegatedAuthorityError";
  }
}
function invalid(reason: string, path?: string): never {
  throw new RequestDelegatedAuthorityError({
    reason,
    ...(path ? { path } : {}),
  });
}
function exact(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("Expected an object", path);
  }
  const entry = value as Record<string, unknown>;
  if (
    Object.keys(entry).sort().join(",") !== [...keys].sort().join(",")
  ) invalid("Expected exact fields", path);
  return entry;
}
const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
function scoped(value: unknown, path: string): ScopedOperatorRef {
  const entry = exact(
    value,
    ["projectId", "systemId", "executionSpaceId", "operatorId"],
    path,
  );
  if (Object.values(entry).some((field) => !text(field))) {
    invalid("Expected a composite operator identity", path);
  }
  return entry as unknown as ScopedOperatorRef;
}

function sessionlessPrior(value: unknown) {
  const withTeam = !!value && typeof value === "object" &&
    Object.hasOwn(value, "operatorTeam");
  const prior = exact(value, [
    "identity",
    "version",
    ...(withTeam ? ["operatorTeam"] : []),
  ], "priorModel");
  if (withTeam) {
    const team = prior.operatorTeam as ExecutableModel["operatorTeam"];
    if (
      !team || typeof team !== "object" || Array.isArray(team) ||
      Object.keys(team).some((key) =>
        !["parentOperatorId", "requestOwnerId", "requestId", "creationPolicyId"]
          .includes(key)
      ) ||
      !text(team.parentOperatorId) || !text(team.requestOwnerId) ||
      !text(team.requestId) ||
      team.parentOperatorId === (prior.identity as ModelIdentity)?.builderId ||
      team.requestOwnerId === (prior.identity as ModelIdentity)?.builderId ||
      (team.creationPolicyId !== undefined && !text(team.creationPolicyId))
    ) {
      invalid(
        "The exact Request member provenance is required",
        "priorModel.operatorTeam",
      );
    }
  }
  return prior;
}

/** A split execution/publication pin is specific to an exact branch member.
 * BO envelopes retain their historical shape and require A = R. */
export function requestWriteAuthorityHasMemberPin(
  authority: RequestWriteAuthority,
): boolean {
  if (
    !isDelegatedRequestAuthority(authority) &&
    !isCreationGrantRequestAuthority(authority)
  ) return false;
  // RequestSpaceAuthorityBridge verifies the roster before constructing this authority.
  const team = authority.priorModel.operatorTeam;
  return team !== undefined &&
    team.requestOwnerId !== authority.priorModel.identity.builderId;
}

/** Exact executing/compiled-model proof for the optional member provenance.
 * Human authority keeps its existing prior-model envelope and checks. */
export function requestWriteAuthorityMemberProvenanceMatches(
  authority: RequestWriteAuthority,
  model: Pick<ExecutableModel, "operatorTeam">,
): boolean {
  return !isSessionlessRequestAuthority(authority) ||
    canonical(authority.priorModel.operatorTeam) ===
      canonical(model.operatorTeam);
}

/** Strict decoder for the host's own durable records (dossier, decision). */
export function parseRequestDelegatedAuthority(
  value: unknown,
): RequestDelegatedAuthorityEnvelope {
  const snapshot = structuredClone(value);
  const envelope = exact(snapshot, [
    "v",
    "kind",
    "destination",
    "priorModel",
    "decider",
    "requester",
    "policy",
    "route",
    "origin",
    "exercise",
    "capturedAt",
  ], "authority");
  if (envelope.v !== 1 || envelope.kind !== "request-delegated-authority") {
    invalid("Delegated authority envelope required", "authority.kind");
  }
  const destination = parseRequestModelWriteDestination(envelope.destination);
  if (destination.executionSpaceId === MAIN_EXECUTION_SPACE_ID) {
    invalid(
      "A delegated decision never publishes in main",
      "authority.destination",
    );
  }
  const prior = sessionlessPrior(envelope.priorModel);
  const version = exact(
    prior.version,
    ["digest", "repositoryVersion"],
    "priorModel.version",
  );
  const identity = prior.identity as ModelIdentity;
  if (
    !identity || typeof identity !== "object" || !text(identity.builderId) ||
    !text(identity.projectId) || !text(identity.systemId) ||
    !isSha256Hex(version.digest) ||
    !text(version.repositoryVersion)
  ) invalid("Expected the exact prior model", "priorModel");
  const decider = scoped(envelope.decider, "decider");
  const requester = scoped(envelope.requester, "requester");
  const policy = exact(
    envelope.policy,
    ["id", "revision", "elementId", "space"],
    "policy",
  );
  const space = exact(
    policy.space,
    ["projectId", "systemId", "executionSpaceId"],
    "policy.space",
  );
  const route = envelope.route as RequestAuthorityRoute;
  const delegation = (envelope.exercise as AuthorityExercise | undefined)
    ?.delegation;
  const origin = envelope.origin as OperatorCommandOrigin | undefined;
  if (
    !text(policy.id) || !text(policy.elementId) ||
    !Number.isSafeInteger(policy.revision) ||
    (decider.executionSpaceId !== MAIN_EXECUTION_SPACE_ID &&
      decider.executionSpaceId !== destination.executionSpaceId) ||
    canonical(space) !==
      canonical({
        projectId: decider.projectId,
        systemId: decider.systemId,
        executionSpaceId: decider.executionSpaceId,
      }) ||
    requester.executionSpaceId !== destination.executionSpaceId ||
    requester.operatorId !== identity.builderId ||
    requester.projectId !== identity.projectId ||
    requester.systemId !== identity.systemId ||
    sameScopedOperator(decider, requester)
  ) invalid("Decider, requester and policy differ", "decider");
  if (
    !route || route.version !== 2 || route.status !== "actor-decision" ||
    route.caseId !== destination.caseId ||
    !route.requester || !sameScopedOperator(route.requester, requester) ||
    canonical(route.designatedDecider) !==
      canonical({
        operatorId: decider.operatorId,
        executionSpaceId: decider.executionSpaceId,
        policyId: policy.id,
        policyRevision: policy.revision,
      })
  ) invalid("The route does not designate this decider", "route");
  const exercise = envelope.exercise as AuthorityExercise;
  if (
    !delegation || !delegation.actor || !delegation.requester ||
    !sameScopedOperator(delegation.actor, decider) ||
    !sameScopedOperator(delegation.requester, requester) ||
    delegation.policyId !== policy.id ||
    delegation.policyRevision !== policy.revision ||
    delegation.policyElementId !== policy.elementId ||
    delegation.changeId !== route.changeId ||
    delegation.caseId !== destination.caseId ||
    exercise.creationDelegation || exercise.candidateDelegation ||
    exercise.action !== "mandate-change" || exercise.outOfMandate !== false ||
    exercise.baseModelDigest !== version.digest
  ) invalid("The exercise differs from the decision", "exercise");
  if (
    !origin || typeof origin !== "object" || !text(origin.effectKey) ||
    !text(origin.inputMessageId) || typeof envelope.capturedAt !== "string"
  ) invalid("The MO's exact native effect is required", "origin");
  return snapshot as RequestDelegatedAuthorityEnvelope;
}

export async function requestDelegatedAuthorityDigest(
  value: RequestDelegatedAuthorityEnvelope,
): Promise<string> {
  return await canonicalDigest(parseRequestDelegatedAuthority(value));
}

export function isDelegatedRequestAuthority(
  value: RequestWriteAuthority,
): value is RequestDelegatedAuthorityEnvelope {
  return value.kind === "request-delegated-authority";
}

export function isCreationGrantRequestAuthority(
  value: RequestWriteAuthority,
): value is RequestCreationGrantAuthorityEnvelope {
  return value.kind === "request-creation-grant";
}

/** A host-internal authority with no person session: the MO's delegated
 * decision or the creator's creation grant. Participants read its prior
 * model and destination, never a controller. */
export function isSessionlessRequestAuthority(
  value: RequestWriteAuthority,
): value is
  | RequestDelegatedAuthorityEnvelope
  | RequestCreationGrantAuthorityEnvelope {
  return value.kind !== "request-source-owner-authority";
}

/** Strict decoder for the host's own durable records (dossier, decision). */
export function parseRequestCreationGrantAuthority(
  value: unknown,
): RequestCreationGrantAuthorityEnvelope {
  const snapshot = structuredClone(value);
  const envelope = exact(snapshot, [
    "v",
    "kind",
    "destination",
    "priorModel",
    "requester",
    "space",
    "branchTeamSize",
    "exercise",
    "capturedAt",
  ], "authority");
  if (envelope.v !== 1 || envelope.kind !== "request-creation-grant") {
    invalid("Creation grant authority envelope required", "authority.kind");
  }
  const destination = parseRequestModelWriteDestination(envelope.destination);
  if (destination.executionSpaceId === MAIN_EXECUTION_SPACE_ID) {
    invalid(
      "A creation in a branch never publishes in main",
      "authority.destination",
    );
  }
  const prior = sessionlessPrior(envelope.priorModel);
  const version = exact(
    prior.version,
    ["digest", "repositoryVersion"],
    "priorModel.version",
  );
  const identity = prior.identity as ModelIdentity;
  if (
    !identity || typeof identity !== "object" || !text(identity.builderId) ||
    !text(identity.projectId) || !text(identity.systemId) ||
    !isSha256Hex(version.digest) ||
    !text(version.repositoryVersion)
  ) invalid("Expected the exact prior model", "priorModel");
  const requester = scoped(envelope.requester, "requester");
  const space = exact(
    envelope.space,
    ["projectId", "systemId", "executionSpaceId"],
    "space",
  );
  if (
    requester.executionSpaceId !== destination.executionSpaceId ||
    requester.operatorId !== identity.builderId ||
    requester.projectId !== identity.projectId ||
    requester.systemId !== identity.systemId ||
    canonical(space) !==
      canonical({
        projectId: requester.projectId,
        systemId: requester.systemId,
        executionSpaceId: requester.executionSpaceId,
      }) ||
    !Number.isSafeInteger(envelope.branchTeamSize) ||
    (envelope.branchTeamSize as number) < 0 ||
    (envelope.branchTeamSize as number) > MAX_BRANCH_TEAM
  ) invalid("Requester, space and team size differ", "requester");
  const exercise = envelope.exercise as AuthorityExercise;
  const receipt = exercise?.creationDelegation;
  if (
    !receipt || exercise.delegation || exercise.candidateDelegation ||
    receipt.actorId !== requester.operatorId ||
    receipt.requestedBy !== requester.operatorId ||
    receipt.caseId !== destination.caseId ||
    receipt.teamOrigin?.requestId !== destination.caseId ||
    !text(receipt.changeId) || !text(receipt.policyId) ||
    !Number.isSafeInteger(receipt.policyRevision) ||
    exercise.action !== "mandate-change" || exercise.outOfMandate !== false ||
    exercise.baseModelDigest !== version.digest ||
    typeof envelope.capturedAt !== "string"
  ) invalid("The exercise differs from the creation", "exercise");
  return snapshot as RequestCreationGrantAuthorityEnvelope;
}

export async function requestCreationGrantAuthorityDigest(
  value: RequestCreationGrantAuthorityEnvelope,
): Promise<string> {
  return await canonicalDigest(parseRequestCreationGrantAuthority(value));
}

/** Discriminate on `kind` first; the human decoder is unchanged. */
export function parseRequestWriteAuthority(
  value: unknown,
): RequestWriteAuthority {
  const kind = value && typeof value === "object"
    ? Reflect.get(value, "kind")
    : undefined;
  return kind === "request-delegated-authority"
    ? parseRequestDelegatedAuthority(value)
    : kind === "request-creation-grant"
    ? parseRequestCreationGrantAuthority(value)
    : parseRequestSourceOwnerAuthority(value);
}
export async function requestWriteAuthorityDigest(
  value: RequestWriteAuthority,
): Promise<string> {
  return isDelegatedRequestAuthority(value)
    ? await requestDelegatedAuthorityDigest(value)
    : isCreationGrantRequestAuthority(value)
    ? await requestCreationGrantAuthorityDigest(value)
    : await requestSourceOwnerAuthorityDigest(value);
}

/** What every Request write consumer reads from any authority kind. */
export function requestWriteAuthorityPrior(
  value: RequestWriteAuthority,
): RequestDelegatedAuthorityEnvelope["priorModel"] {
  return isDelegatedRequestAuthority(value) ||
      isCreationGrantRequestAuthority(value)
    ? value.priorModel
    : value.acceptance.priorModel;
}
export function requestWriteAuthorityDestination(
  value: RequestWriteAuthority,
): RequestModelWriteDestination {
  return isDelegatedRequestAuthority(value) ||
      isCreationGrantRequestAuthority(value)
    ? value.destination
    : value.acceptance.destination;
}

/** The creation scope a Request write is read under (E1): the envelope's
 * own for a creation grant; the destination's branch for the person's
 * (its size is read where the branch team is known); absent outside a
 * branch destination, where main reads apply. */
export function requestWriteCreationScope(
  authority: RequestWriteAuthority,
  destination: RequestModelWriteDestination,
):
  | import("../../../domain/governance/policies/operator-creation-policy.ts").CreationScope
  | undefined {
  if (isCreationGrantRequestAuthority(authority)) {
    return requestCreationScope(
      authority.space,
      destination.caseId,
      authority.branchTeamSize,
    );
  }
  if (isDelegatedRequestAuthority(authority)) return undefined;
  const prior = requestWriteAuthorityPrior(authority).identity;
  return {
    space: {
      projectId: prior.projectId,
      systemId: prior.systemId,
      executionSpaceId: destination.executionSpaceId,
    },
  };
}

/** The host-verified facts a delegated decision is built from. */
interface RequestDelegatedAuthorityFacts {
  opening: OpeningRecord;
  admission: SpaceExecutionAdmission;
  /** The BO's current runtime state and its execution space. */
  request: SystemRuntimeState;
  states?: readonly SystemRuntimeState[];
  space: ExecutionSpaceRef;
  /** The registered Main's current runtime state. */
  main: SystemRuntimeState;
  change: PendingChange;
}

/** The policy holder is resolved from current host states, never from an envelope's model. */
function delegatedDecider(
  facts: RequestDelegatedAuthorityFacts,
  designated: { operatorId: string; executionSpaceId: string },
) {
  const state = designated.executionSpaceId === MAIN_EXECUTION_SPACE_ID
    ? facts.main
    : designated.executionSpaceId === facts.opening.executionSpaceId
    ? facts.states?.find((state) =>
      state.executionModel?.identity.builderId === designated.operatorId
    )
    : undefined;
  const model = state?.executionModel;
  if (!model || model.identity.builderId !== designated.operatorId) {
    throw new OperatorAuthorityError(
      "AUTHORITY_OUT_OF_BOUNDS",
      "The designated operator is unavailable in this Request",
      { caseId: facts.opening.caseId, changeId: facts.change.id },
    );
  }
  return {
    model,
    space: {
      projectId: model.identity.projectId,
      systemId: model.identity.systemId,
      executionSpaceId: designated.executionSpaceId,
    },
  };
}

/** Recompute the route and the exercise from current host states and require
 * the captured decision: revocation, a superseded policy, a changed route,
 * admission or change refuse with no effect (A2). */
export function assertRequestDelegatedAuthorityCurrent(
  value: RequestDelegatedAuthorityEnvelope,
  facts: RequestDelegatedAuthorityFacts,
): void {
  const envelope = parseRequestDelegatedAuthority(value);
  const { opening, admission, request, space, main, change } = facts;
  const model = request.executionModel, mainModel = main.executionModel;
  const actor = delegatedDecider(facts, envelope.decider);
  const stale = (reason: string): never => {
    throw new OperatorAuthorityError(
      "AUTHORITY_REQUEST_STALE",
      reason,
      { changeId: change.id, caseId: opening.caseId },
    );
  };
  if (
    !model || !mainModel || admission.status !== "active" ||
    admission.openingId !== opening.id ||
    envelope.destination.openingId !== opening.id ||
    envelope.destination.executionSpaceId !== opening.executionSpaceId ||
    envelope.destination.caseId !== opening.caseId ||
    envelope.destination.branchId !== opening.branchId ||
    space.executionSpaceId !== opening.executionSpaceId ||
    !sameScopedOperator(
      envelope.requester,
      scopedOperator(space, model.identity.builderId),
    ) ||
    !sameScopedOperator(
      envelope.decider,
      scopedOperator(
        actor.space,
        actor.model.identity.builderId,
      ),
    ) ||
    canonical(envelope.priorModel.identity) !== canonical(model.identity) ||
    !requestWriteAuthorityMemberProvenanceMatches(envelope, model) ||
    envelope.priorModel.version.digest !== model.version.digest ||
    envelope.priorModel.version.repositoryVersion !==
      model.version.repositoryVersion ||
    change.id !== envelope.route.changeId || change.status !== "pending" ||
    change.publishedCommit
  ) {
    return stale(
      "The opening, admission, Main or change changed after the choice",
    );
  }
  const policy = actor.model.operatorAuthorityPolicies?.find((entry) =>
    entry.id === envelope.policy.id
  );
  if (
    !policy?.enabled || policy.revision !== envelope.policy.revision ||
    policy.elementId !== envelope.policy.elementId
  ) {
    throw new OperatorAuthorityError(
      "AUTHORITY_POLICY_STALE",
      "Main's delegated policy is revoked or superseded; refer to the person",
      { policyId: envelope.policy.id, changeId: change.id },
    );
  }
  const route = requestAuthorityRoute({
    space,
    requester: request,
    change,
    states: facts.states ?? [request],
    root: {
      kind: "verified-opening",
      openingId: opening.id,
      parent: { space: mainExecutionSpace(mainModel.identity), state: main },
    },
  });
  if (
    route.status !== "actor-decision" ||
    canonical(route.designatedDecider) !==
      canonical(envelope.route.designatedDecider)
  ) return stale("The route no longer designates this decider");
  const exercise = delegatedAuthorityExercise({
    target: model,
    targetSpace: space,
    policyModel: actor.model,
    space: actor.space,
    change,
    command: {
      actorId: envelope.decider.operatorId,
      policyId: envelope.policy.id,
      policyRevision: envelope.policy.revision,
    },
  });
  if (canonical(exercise) !== canonical(envelope.exercise)) {
    return stale("The delegated exercise differs from the current policy");
  }
}

/** Host-internal constructor: the bridge's verified facts, the route it
 * recomputed and the destination the host resolved for this opening. */
export function buildRequestDelegatedAuthority(
  input: RequestDelegatedAuthorityFacts & {
    route: RequestAuthorityRoute;
    destination: RequestModelWriteDestination;
    origin: OperatorCommandOrigin;
    capturedAt: string;
  },
): RequestDelegatedAuthorityEnvelope {
  const model = input.request.executionModel!;
  const decided = input.route.designatedDecider;
  if (!decided) {
    throw new OperatorAuthorityError(
      "AUTHORITY_OUT_OF_BOUNDS",
      "No designated decider",
      { changeId: input.change.id },
    );
  }
  const actor = delegatedDecider(input, decided);
  const mainModel = actor.model;
  const policy = mainModel.operatorAuthorityPolicies?.find((entry) =>
    entry.id === decided?.policyId
  );
  if (!decided || !policy) {
    throw new OperatorAuthorityError(
      "AUTHORITY_OUT_OF_BOUNDS",
      "No current designated decider for this change",
      { changeId: input.change.id },
    );
  }
  const mainSpace = actor.space;
  const envelope: RequestDelegatedAuthorityEnvelope = {
    v: 1,
    kind: "request-delegated-authority",
    destination: structuredClone(input.destination),
    priorModel: {
      identity: structuredClone(model.identity),
      ...(model.operatorTeam
        ? { operatorTeam: structuredClone(model.operatorTeam) }
        : {}),
      version: {
        digest: model.version.digest,
        repositoryVersion: model.version.repositoryVersion!,
      },
    },
    decider: scopedOperator(mainSpace, mainModel.identity.builderId),
    requester: scopedOperator(input.space, model.identity.builderId),
    policy: {
      id: policy.id,
      revision: policy.revision,
      elementId: policy.elementId,
      space: mainSpace,
    },
    route: structuredClone(input.route),
    origin: structuredClone(input.origin),
    exercise: delegatedAuthorityExercise({
      target: model,
      targetSpace: input.space,
      policyModel: mainModel,
      space: mainSpace,
      change: input.change,
      command: {
        actorId: mainModel.identity.builderId,
        policyId: policy.id,
        policyRevision: policy.revision,
      },
    }),
    capturedAt: input.capturedAt,
  };
  const parsed = parseRequestDelegatedAuthority(envelope);
  assertRequestDelegatedAuthorityCurrent(parsed, input);
  return parsed;
}

/** The host-verified facts a creation-grant decision is built from. */
interface RequestCreationGrantAuthorityFacts {
  opening: OpeningRecord;
  admission: SpaceExecutionAdmission;
  /** The creator's current runtime state and its branch space. */
  request: SystemRuntimeState;
  space: ExecutionSpaceRef;
  /** The verified whole-team size before this creation (E1, Q5). */
  branchTeamSize: number;
  change: PendingChange;
}

/** Recompute the grant and its receipt from the creator's current branch
 * model: a withdrawn or superseded grant, a full team, a per-creation mode
 * or a changed change refuse with no effect (decision 13, A2 analog). */
export function assertRequestCreationGrantAuthorityCurrent(
  value: RequestCreationGrantAuthorityEnvelope,
  facts: RequestCreationGrantAuthorityFacts,
): void {
  const envelope = parseRequestCreationGrantAuthority(value);
  const { opening, admission, request, space, branchTeamSize, change } = facts;
  const model = request.executionModel;
  const receipt = envelope.exercise.creationDelegation!;
  const stale = (reason: string): never => {
    throw new OperatorAuthorityError(
      "AUTHORITY_REQUEST_STALE",
      reason,
      { changeId: change.id, caseId: opening.caseId },
    );
  };
  if (
    !model || admission.status !== "active" ||
    admission.openingId !== opening.id ||
    envelope.destination.openingId !== opening.id ||
    envelope.destination.executionSpaceId !== opening.executionSpaceId ||
    envelope.destination.caseId !== opening.caseId ||
    envelope.destination.branchId !== opening.branchId ||
    space.executionSpaceId !== opening.executionSpaceId ||
    canonical(envelope.space) !== canonical(space) ||
    !sameScopedOperator(
      envelope.requester,
      scopedOperator(space, model.identity.builderId),
    ) ||
    canonical(envelope.priorModel.identity) !== canonical(model.identity) ||
    !requestWriteAuthorityMemberProvenanceMatches(envelope, model) ||
    envelope.priorModel.version.digest !== model.version.digest ||
    envelope.priorModel.version.repositoryVersion !==
      model.version.repositoryVersion ||
    change.id !== receipt.changeId || change.status !== "pending" ||
    change.publishedCommit
  ) {
    return stale("The opening, admission or change changed after the choice");
  }
  const policy = model.operatorCreationPolicies?.find((entry) =>
    entry.id === receipt.policyId
  );
  if (
    !policy?.enabled || policy.revision !== receipt.policyRevision ||
    policy.elementId !== receipt.policyElementId
  ) {
    throw new OperatorAuthorityError(
      "AUTHORITY_POLICY_STALE",
      "The creation grant is revoked or superseded; refer to the person",
      { policyId: receipt.policyId, changeId: change.id },
    );
  }
  const exercise = creationAuthorityExercise(
    model,
    change,
    {
      actorId: model.identity.builderId,
      policyId: receipt.policyId,
      policyRevision: receipt.policyRevision,
    },
    requestCreationScope(space, opening.caseId, branchTeamSize),
  );
  if (canonical(exercise) !== canonical(envelope.exercise)) {
    return stale("The creation receipt differs from the current grant");
  }
}

/** Host-internal constructor: the verified opening facts, the branch-read
 * grant the change exercises and the destination of the requester's branch. */
export function buildRequestCreationGrantAuthority(
  input: RequestCreationGrantAuthorityFacts & {
    destination: RequestModelWriteDestination;
    capturedAt: string;
  },
): RequestCreationGrantAuthorityEnvelope {
  const model = input.request.executionModel!;
  const change = input.change;
  if (!change.operator) {
    throw new OperatorAuthorityError(
      "AUTHORITY_OUT_OF_BOUNDS",
      "A creation grant requires an exact team creation change",
      { changeId: change.id },
    );
  }
  const scope = requestCreationScope(
    input.space,
    input.opening.caseId,
    input.branchTeamSize,
  );
  const policy = assertCreationWithinPolicy(
    model,
    change.operator,
    undefined,
    scope,
  );
  const envelope: RequestCreationGrantAuthorityEnvelope = {
    v: 1,
    kind: "request-creation-grant",
    destination: structuredClone(input.destination),
    priorModel: {
      identity: structuredClone(model.identity),
      ...(model.operatorTeam
        ? { operatorTeam: structuredClone(model.operatorTeam) }
        : {}),
      version: {
        digest: model.version.digest,
        repositoryVersion: model.version.repositoryVersion!,
      },
    },
    requester: scopedOperator(input.space, model.identity.builderId),
    space: structuredClone(input.space),
    branchTeamSize: input.branchTeamSize,
    exercise: creationAuthorityExercise(model, change, {
      actorId: model.identity.builderId,
      policyId: policy.id,
      policyRevision: policy.revision,
    }, scope),
    capturedAt: input.capturedAt,
  };
  const parsed = parseRequestCreationGrantAuthority(envelope);
  assertRequestCreationGrantAuthorityCurrent(parsed, input);
  return parsed;
}
