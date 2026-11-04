import { mayConsultModel } from "../../model/consultation/model-read-policy.ts";
import {
  type ExecutableModel,
  type NativePolicyIdentity,
} from "../../model/execution/executable-model.ts";
import {
  MAX_BRANCH_TEAM,
  MAX_OPERATOR_UNITS,
} from "../../work/records/conversations.ts";
import { canonical } from "../../primitives/canonical-json.ts";
import { sha256Bytes } from "../../primitives/sha256-bytes.ts";
import { validateNetworkScope } from "./network-policy.ts";
import type { AuthorityExercise, ExecutionSpaceRef } from "../authority.ts";
import {
  exerciseOwnerAuthority,
  MAIN_EXECUTION_SPACE_ID,
} from "../authority.ts";
import type { PendingChange } from "../records/pending-change.ts";
import { OperatorAuthorityError } from "../operator-authority-error.ts";
import {
  isTeamOperatorSpec,
  type OperatorCreationGrant,
  type OperatorCreationMode,
  type OperatorCreationSpec,
  type TeamOperatorProvision,
  validateOperatorCreationSpec,
} from "../operator-authority.ts";

export interface OperatorCreationPolicy
  extends NativePolicyIdentity, OperatorCreationGrant {
  enabled: boolean;
  holderNativeId: string;
  mandateNativeId: string;
  systemId: string;
  parentPolicyElementId?: string;
  /** Admitted durable children under this exact holder and policy identity. */
  children: string[];
}

/** A BO asks for its own branch grant; holder, depth and policy identity are host-owned. */
export interface OperatorCreationPolicyRequest {
  networkHosts: string[];
  maxChildren: number;
  mode: OperatorCreationMode;
}

export function validateOperatorCreationPolicyRequest(
  value: unknown,
): OperatorCreationPolicyRequest {
  const fail = (): never => {
    throw new OperatorAuthorityError(
      "INVALID_AUTHORITY_POLICY",
      "A creation grant requires exact network hosts, a whole-team limit from 1 to 3 and an explicit autonomous or per-creation mode",
    );
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail();
  }
  const request = value as Record<string, unknown>;
  if (
    Object.keys(request).sort().join(",") !== "maxChildren,mode,networkHosts" ||
    !Number.isSafeInteger(request.maxChildren) ||
    Number(request.maxChildren) < 1 ||
    Number(request.maxChildren) > MAX_BRANCH_TEAM ||
    request.mode !== "autonomous" && request.mode !== "per-creation"
  ) return fail();
  let hosts: string[];
  try {
    hosts =
      validateNetworkScope({ allowedHosts: request.networkHosts }).allowedHosts;
  } catch {
    return fail();
  }
  return {
    networkHosts: hosts,
    maxChildren: Number(request.maxChildren),
    mode: request.mode,
  };
}

type CreationPolicyRequestModel = Pick<
  ExecutableModel,
  "identity" | "ownerAuthority" | "operatorTeam" | "operatorCreationPolicies"
>;

/** Eligibility for requesting authority; it never authorizes a creation. */
export function canRequestOperatorCreationPolicy(
  model: CreationPolicyRequestModel,
  scope: CreationScope,
): boolean {
  return !!scope?.space?.executionSpaceId &&
    scope.space.executionSpaceId !== MAIN_EXECUTION_SPACE_ID &&
    scope.space.systemId === model.identity.systemId &&
    (model.identity.projectId === undefined ||
      scope.space.projectId === model.identity.projectId) &&
    Number.isSafeInteger(scope.branchTeamSize) && scope.branchTeamSize! >= 0 &&
    model.ownerAuthority?.ownerSource === "modeled" && !model.operatorTeam &&
    !(model.operatorCreationPolicies ?? []).some((policy) =>
      policy.enabled && policy.holderNativeId === model.identity.builderId
    );
}

/** The proposed grant may only cover this BO's current hosts in its own branch. */
export function assertOperatorCreationPolicyRequest(
  model: CreationPolicyRequestModel & {
    configuration: Pick<ExecutableModel["configuration"], "network">;
  },
  request: unknown,
  scope: CreationScope,
): void {
  const value = validateOperatorCreationPolicyRequest(request);
  if (!canRequestOperatorCreationPolicy(model, scope)) {
    throw new OperatorAuthorityError(
      "AUTHORITY_POLICY_FORBIDDEN",
      "Only a Branch Operator without an enabled creation grant may request one in its own branch",
      { executionSpaceId: scope?.space?.executionSpaceId ?? "" },
    );
  }
  const ownHosts = model.configuration.network?.allowedHosts ?? [];
  if (value.networkHosts.some((host) => !ownHosts.includes(host))) {
    throw new OperatorAuthorityError(
      "AUTHORITY_OUT_OF_BOUNDS",
      "The requested creation hosts exceed the Branch Operator's own admitted hosts",
      { field: "networkHosts" },
    );
  }
}

/** A re-grant has a new identity; disabled historical membership anchors stay intact. */
export async function requestedCreationPolicyId(
  changeId: string,
): Promise<string> {
  return `operator_${(await sha256Bytes(changeId)).slice(0, 24)}-creation`;
}

export interface CreationActor {
  actorId: string;
  policyId: string;
  policyRevision: number;
}

/**
 * Where the policy is read (spec 4.8e E1). Creation policies are relative to
 * that space, as delegated policies are since 4.8c: read in a branch they
 * apply mirrored inside it and never outside it. In a branch the caller
 * supplies the current Case and whole-team size (settled Q5); main excludes both.
 */
export type CreationScope =
  & { space: ExecutionSpaceRef }
  & (
    | { branchTeamSize?: undefined; currentCaseId?: undefined }
    | { branchTeamSize: number; currentCaseId: string }
  );

/** Construct the one explicit creation scope for a verified Request branch. */
export function requestCreationScope(
  space: ExecutionSpaceRef,
  currentCaseId: string,
  branchTeamSize: number,
): CreationScope {
  return { space: { ...space }, currentCaseId, branchTeamSize };
}

/** The explicit main-space scope of a model; main callers state it, never omit it. */
export function mainCreationScope(
  identity: Pick<ExecutionSpaceRef, "projectId" | "systemId">,
): CreationScope {
  return {
    space: {
      projectId: identity.projectId,
      systemId: identity.systemId,
      executionSpaceId: MAIN_EXECUTION_SPACE_ID,
    },
  };
}

function requireCreationScope(
  model: Pick<ExecutableModel, "identity">,
  scope: CreationScope,
): boolean {
  if (
    !scope?.space || scope.space.systemId !== model.identity.systemId ||
    model.identity.projectId !== undefined &&
      scope.space.projectId !== model.identity.projectId
  ) {
    throw new OperatorAuthorityError(
      "AUTHORITY_OUT_OF_BOUNDS",
      "Creation requires an explicit scope in the model's own space",
      { executionSpaceId: scope?.space?.executionSpaceId ?? "" },
    );
  }
  const branch = scope.space.executionSpaceId !== MAIN_EXECUTION_SPACE_ID;
  if (
    !branch &&
      (scope.currentCaseId !== undefined ||
        scope.branchTeamSize !== undefined) ||
    branch &&
      (typeof scope.currentCaseId !== "string" || !scope.currentCaseId.trim())
  ) {
    throw new OperatorAuthorityError(
      "AUTHORITY_OUT_OF_BOUNDS",
      "A current creation Case requires a verified Request branch scope",
    );
  }
  if (
    branch &&
    (!Number.isSafeInteger(scope.branchTeamSize) || scope.branchTeamSize! < 0)
  ) {
    throw new OperatorAuthorityError(
      "AUTHORITY_OUT_OF_BOUNDS",
      "Creation in a branch requires the current whole-team size",
      { executionSpaceId: scope.space.executionSpaceId },
    );
  }
  return branch;
}

/** The effective creation form; an absent mode is the historical autonomous form. */
export function creationMode(
  grant: Pick<OperatorCreationGrant, "mode">,
): OperatorCreationMode {
  return grant.mode ?? "autonomous";
}

/** Whether the admitted child's executable rights equal the approved provision. */
export function matchesTeamProvision(
  child: ExecutableModel,
  provision: TeamOperatorProvision,
  options?: { missingNetworkMeansEmpty?: boolean },
): boolean {
  const hosts = child.configuration.network?.allowedHosts;
  return canonical(options?.missingNetworkMeansEmpty ? hosts ?? [] : hosts) ===
      canonical(provision.networkHosts) &&
    child.policy.maxAgentDecisions === provision.budget.maxAgentDecisions &&
    child.policy.maxToolProposals === provision.budget.maxToolProposals &&
    child.policy.maxFlowSteps === provision.budget.maxFlowSteps &&
    child.policy.mayAddNetworkHosts ===
      (provision.mayAddNetworkHosts ?? false) &&
    mayConsultModel(child.policy) === (provision.mayConsultModel === true) &&
    (child.policy.mayProposeSysmlRevision === true) ===
      (provision.mayProposeSysmlRevision === true) &&
    canonical(child.mandate.mayPropose) === canonical(provision.mayPropose) &&
    (child.mandate.mayInvoke === "active-catalog-only") ===
      provision.mayInvokeActiveCatalog;
}

/**
 * Every provisioned value stays within the creator's own admitted value
 * (spec 4.8e E2). The first field above the creator refuses, named in context.
 */
function assertProvisionWithinCreator(
  model: Pick<ExecutableModel, "policy" | "mandate"> & {
    configuration: Pick<ExecutableModel["configuration"], "network">;
  },
  provision: TeamOperatorProvision,
): void {
  const refuse = (
    field: string,
    requested: unknown,
    creator: unknown,
  ): never => {
    throw new OperatorAuthorityError(
      "AUTHORITY_OUT_OF_BOUNDS",
      "The provisioned child exceeds the creator's own admitted rights or limits",
      {
        field,
        requested: canonical(requested),
        creator: canonical(creator),
      },
    );
  };
  for (
    const field of [
      "maxAgentDecisions",
      "maxToolProposals",
      "maxFlowSteps",
    ] as const
  ) {
    if (provision.budget[field] > model.policy[field]) {
      refuse(`budget.${field}`, provision.budget[field], model.policy[field]);
    }
  }
  if (provision.mayAddNetworkHosts && !model.policy.mayAddNetworkHosts) {
    refuse("mayAddNetworkHosts", true, false);
  }
  const creatorHosts = model.configuration.network?.allowedHosts ?? [];
  if (provision.networkHosts.some((host) => !creatorHosts.includes(host))) {
    refuse("networkHosts", provision.networkHosts, creatorHosts);
  }
  if (
    provision.mayPropose.some((kind) =>
      !model.mandate.mayPropose.includes(kind)
    )
  ) {
    refuse("mayPropose", provision.mayPropose, model.mandate.mayPropose);
  }
  const creatorInvokes = model.mandate.mayInvoke === "active-catalog-only";
  if (provision.mayInvokeActiveCatalog && !creatorInvokes) {
    refuse("mayInvokeActiveCatalog", true, creatorInvokes);
  }
  const creatorModelRights = {
    mayConsultModel: mayConsultModel(model.policy),
    mayProposeSysmlRevision: model.policy.mayProposeSysmlRevision === true,
  };
  for (const field of ["mayConsultModel", "mayProposeSysmlRevision"] as const) {
    if (provision[field] === true && !creatorModelRights[field]) {
      refuse(field, true, creatorModelRights[field]);
    }
  }
}

export function assertCreationWithinPolicy(
  model:
    & Pick<
      ExecutableModel,
      "identity" | "operatorCreationPolicies" | "policy" | "mandate"
    >
    & {
      configuration: Pick<ExecutableModel["configuration"], "network">;
    },
  input: OperatorCreationSpec,
  actor: CreationActor | undefined,
  scope: CreationScope,
): OperatorCreationPolicy {
  const branch = requireCreationScope(model, scope);
  const spec = validateOperatorCreationSpec(input);
  if (isTeamOperatorSpec(spec)) {
    assertProvisionWithinCreator(model, spec.provision);
  }
  const candidates = (model.operatorCreationPolicies ?? []).filter((policy) =>
    policy.holderNativeId === model.identity.builderId &&
    (!actor || actor.actorId === model.identity.builderId &&
        policy.id === actor.policyId &&
        policy.revision === actor.policyRevision)
  );
  const within = candidates.filter((policy) => {
    // In a branch the native children list is inherited history and inert:
    // the whole current branch team counts against the tighter bound.
    const counted = branch ? scope!.branchTeamSize! : policy.children.length;
    const bound = branch
      ? Math.min(policy.maxChildren, MAX_BRANCH_TEAM)
      : policy.maxChildren;
    if (
      !isTeamOperatorSpec(spec) || !policy.enabled ||
      policy.systemId !== model.identity.systemId ||
      policy.rootAuthority?.ownerSource !== "modeled" ||
      counted >= bound ||
      spec.provision.networkHosts.some((host) =>
        !policy.networkHosts.includes(host)
      )
    ) return false;
    if (isTeamOperatorSpec(spec) && spec.creationGrant) {
      const child = spec.creationGrant;
      if (
        policy.maxDelegationDepth <= 0 ||
        child.maxDelegationDepth >= policy.maxDelegationDepth ||
        child.maxChildren > policy.maxChildren ||
        child.networkHosts.some((host) =>
          !policy.networkHosts.includes(host)
        ) ||
        creationMode(child) === "autonomous" &&
          creationMode(policy) !== "autonomous"
      ) return false;
    }
    return true;
  });
  if (within.length !== 1) {
    throw new OperatorAuthorityError(
      "AUTHORITY_OUT_OF_BOUNDS",
      "Creation requires one current grant covering the child, remaining capacity and any explicitly transmitted creation rights",
    );
  }
  return within[0]!;
}

/** A software creation decision uses only a grant admitted before this change.
 * The actor is the requester: self-approval, allowed only under `autonomous`. */
export function creationAuthorityExercise(
  model: ExecutableModel,
  change: PendingChange,
  actor: CreationActor,
  scope: CreationScope,
): AuthorityExercise {
  const requestId = scope.space.executionSpaceId === MAIN_EXECUTION_SPACE_ID
    ? model.operatorTeam?.requestId
    : scope.currentCaseId;
  if (
    change.kind !== "operator-creation" || !change.operator ||
    change.requestedBy !== actor.actorId ||
    (!!change.caseId === !!change.designerScopeId) ||
    isTeamOperatorSpec(change.operator) &&
      (!change.teamOrigin || change.teamOrigin.requestId !== change.caseId) ||
    !isTeamOperatorSpec(change.operator) && !!change.teamOrigin ||
    model.operatorTeam &&
      (change.caseId !== requestId ||
        change.teamOrigin?.requestId !== requestId ||
        change.teamOrigin?.operatorId !== model.operatorTeam.requestOwnerId)
  ) {
    throw new OperatorAuthorityError(
      "AUTHORITY_OUT_OF_BOUNDS",
      "The creation actor and exact proposal origin must match",
    );
  }
  const policy = assertCreationWithinPolicy(
    model,
    change.operator,
    actor,
    scope,
  );
  if (creationMode(policy) === "per-creation") {
    throw new OperatorAuthorityError(
      "AUTHORITY_OUT_OF_BOUNDS",
      "A per-creation grant routes every creation to a decider; the requester never approves its own creation",
      { mode: "per-creation", policyId: policy.id, changeId: change.id },
    );
  }
  return {
    ...exerciseOwnerAuthority(model, "mandate-change"),
    creationDelegation: {
      actorId: actor.actorId,
      policyId: policy.id,
      policyRevision: policy.revision,
      policyElementId: policy.elementId,
      policyIssuer: structuredClone(policy.rootAuthority!),
      changeId: change.id,
      requestedBy: change.requestedBy,
      ...(change.caseId
        ? { caseId: change.caseId }
        : { designerScopeId: change.designerScopeId! }),
      ...(change.teamOrigin
        ? { teamOrigin: structuredClone(change.teamOrigin) }
        : {}),
      operator: structuredClone(change.operator),
    },
  };
}

/** The exercise a team creation's decision will record, for budgeting its
 * preview before anyone is asked (4.8e E4c): the creator's own receipt
 * under `autonomous`, the decider's owner exercise under `per-creation`
 * (the requester never approves its own creation). A creation no current
 * grant covers is refused here, before any preview. */
export function creationPreviewExercise(
  model: ExecutableModel,
  change: PendingChange,
  scope: CreationScope,
): AuthorityExercise {
  const policy = assertCreationWithinPolicy(
    model,
    change.operator!,
    undefined,
    scope,
  );
  return creationMode(policy) === "per-creation"
    ? exerciseOwnerAuthority(model, "mandate-change")
    : creationAuthorityExercise(model, change, {
      actorId: model.identity.builderId,
      policyId: policy.id,
      policyRevision: policy.revision,
    }, scope);
}

export function assertCreationAuthorityReceipt(
  model: ExecutableModel,
  change: PendingChange,
  scope: CreationScope,
): void {
  const receipt = change.authorityExercise?.creationDelegation;
  if (
    !receipt || change.status !== "approved" ||
    change.authority !== "builder" ||
    !change.decidedAt || canonical(change.authorityExercise) !==
      canonical(creationAuthorityExercise(model, change, receipt, scope))
  ) {
    throw new OperatorAuthorityError(
      "AUTHORITY_RECEIPT_MISMATCH",
      "The creation receipt does not match the exact grant, child and origin",
    );
  }
}

/**
 * Post-hoc membership proof for `branchTeam` (spec 4.8e E3): the pinned
 * child's parent carries exactly one approved creation change for this
 * child (same origin, instruction and provision), whose receipt verifies
 * against the parent as it was when the creation was decided — never
 * against the current parent (decision 13: withdrawing a right blocks the
 * following decisions, it never removes what was already granted). The
 * historical source is the grant as the receipt records it (policy id,
 * recorded revision, element, issuer) anchored to the slot this child's
 * system consumed in the parent's published policy; bounds and provision
 * were enforced at issuance and at publication, so they are not re-read
 * from today's policy, budget, mandate or hosts. The scope states where
 * the team is read: in a branch, children inherited from main are inert
 * history in that same published list and never count. The human path
 * recomputes the person's owner-authority receipt against the pinned
 * base digest. Anything else is not a team member. Creation changes live
 * in the parent's runtime configuration, not in its compiled model:
 * `parentChanges` resolves them (default: the model's own configuration,
 * for host-built pins that carry them).
 */
export function creationReceiptVerifies(
  models: readonly ExecutableModel[],
  child: ExecutableModel,
  scope: CreationScope,
  parentChanges: (parent: ExecutableModel) => readonly PendingChange[] = (
    parent,
  ) => parent.configuration.changes ?? [],
): boolean {
  const team = child.operatorTeam;
  if (!team || !scope?.space) return false;
  const parents = models.filter((model) =>
    model.identity.builderId === team.parentOperatorId
  );
  if (parents.length !== 1) return false;
  const parent = parents[0]!;
  if (
    scope.space.systemId !== parent.identity.systemId ||
    parent.identity.projectId !== undefined &&
      scope.space.projectId !== parent.identity.projectId
  ) return false;
  const candidates = parentChanges(parent).filter((change) => {
    if (
      change.kind !== "operator-creation" || change.status !== "approved" ||
      !change.decidedAt || !change.operator ||
      change.requestedBy !== parent.identity.builderId ||
      change.caseId !== team.requestId ||
      change.teamOrigin?.requestId !== team.requestId ||
      change.teamOrigin?.operatorId !== team.requestOwnerId
    ) return false;
    let spec;
    try {
      spec = validateOperatorCreationSpec(change.operator);
    } catch {
      return false;
    }
    return isTeamOperatorSpec(spec) &&
      spec.instruction === child.operator?.instruction &&
      matchesTeamProvision(child, spec.provision, {
        missingNetworkMeansEmpty: true,
      });
  });
  if (candidates.length !== 1) return false;
  const change = candidates[0]!;
  // One native system, one child: a second pinned model claiming the same
  // system identity makes both unverifiable, never first-wins.
  if (
    models.some((model) =>
      model !== child &&
      model.identity.systemId === child.identity.systemId
    )
  ) return false;
  const receipt = change.authorityExercise;
  if (!receipt) return false;
  // Reconstruct the parent as decided upon: the receipt pins the base digest;
  // the created child had not yet consumed its policy slot.
  const before = structuredClone(parent);
  before.version = { ...before.version, digest: receipt.baseModelDigest };
  const delegation = receipt.creationDelegation;
  if (delegation) {
    // Historical anchor: the published policy that consumed exactly this
    // child's slot, at no earlier revision than the receipt recorded.
    // Its current enabled flag, bounds and hosts are never re-read.
    const policy = (parent.operatorCreationPolicies ?? []).find((entry) =>
      entry.id === delegation.policyId
    );
    if (
      change.authority !== "builder" || !policy ||
      team.creationPolicyId !== undefined &&
        delegation.policyId !== team.creationPolicyId ||
      !policy.children.includes(child.identity.systemId) ||
      !Number.isSafeInteger(delegation.policyRevision) ||
      delegation.policyRevision < 1 ||
      delegation.policyRevision > policy.revision ||
      delegation.policyElementId !== policy.elementId ||
      canonical(delegation.policyIssuer) !==
        canonical(policy.rootAuthority) ||
      delegation.actorId !== parent.identity.builderId ||
      delegation.requestedBy !== change.requestedBy ||
      delegation.changeId !== change.id ||
      canonical(delegation.operator) !== canonical(change.operator) ||
      delegation.caseId !== change.caseId ||
      delegation.designerScopeId !== change.designerScopeId ||
      (delegation.teamOrigin === undefined) !==
        (change.teamOrigin === undefined) ||
      delegation.teamOrigin?.operatorId !== change.teamOrigin?.operatorId ||
      delegation.teamOrigin?.requestId !== change.teamOrigin?.requestId
    ) return false;
    try {
      return canonical(receipt) ===
        canonical({
          ...exerciseOwnerAuthority(before, "mandate-change"),
          creationDelegation: structuredClone(delegation),
        });
    } catch {
      return false;
    }
  }
  if (
    change.authority !== "human" || receipt.delegation ||
    change.baseModelDigest !== undefined &&
      change.baseModelDigest !== receipt.baseModelDigest
  ) return false;
  if (
    team.creationPolicyId !== undefined &&
    !(parent.operatorCreationPolicies ?? []).some((policy) =>
      policy.id === team.creationPolicyId &&
      policy.children.includes(child.identity.systemId)
    )
  ) return false;
  if (team.creationPolicyId === undefined) {
    // No policy slot names the child system: a second pinned child of the
    // same parent and Request with the same instruction is ambiguous.
    const spec = validateOperatorCreationSpec(change.operator!);
    if (
      !isTeamOperatorSpec(spec) ||
      models.some((model) =>
        model !== child &&
        model.operatorTeam?.parentOperatorId === team.parentOperatorId &&
        model.operatorTeam?.requestId === team.requestId &&
        model.operator?.instruction === spec.instruction &&
        canonical(model.configuration.network?.allowedHosts ?? []) ===
          canonical(spec.provision.networkHosts)
      )
    ) return false;
  }
  try {
    return canonical(receipt) ===
      canonical(exerciseOwnerAuthority(before, "mandate-change"));
  } catch {
    return false;
  }
}

/** Shared physical headroom, separate from the holder's explicit grant. */
export function assertOperatorCreationCapacity(
  currentUnits: number,
  candidateUnits = currentUnits + 1,
): void {
  if (
    !Number.isSafeInteger(currentUnits) || currentUnits < 1 ||
    !Number.isSafeInteger(candidateUnits) ||
    candidateUnits !== currentUnits + 1 ||
    candidateUnits > MAX_OPERATOR_UNITS
  ) {
    throw new OperatorAuthorityError(
      "OPERATOR_CAPACITY_EXCEEDED",
      `Creation requires exactly one available operator slot within the technical registry limit of ${MAX_OPERATOR_UNITS}`,
    );
  }
}

/** Match the complete admitted holder grant set, never the first matching grant. */
export function exactChildCreationGrant(
  model: Pick<ExecutableModel, "identity" | "operatorCreationPolicies">,
  requested: OperatorCreationGrant | undefined,
  parentPolicyElementId?: string,
): boolean {
  const policies = (model.operatorCreationPolicies ?? []).filter((policy) =>
    policy.holderNativeId === model.identity.builderId
  );
  if (!requested) return policies.length === 0;
  if (policies.length !== 1) return false;
  const policy = policies[0]!;
  return policy.enabled && policy.systemId === model.identity.systemId &&
    policy.maxChildren === requested.maxChildren &&
    policy.maxDelegationDepth === requested.maxDelegationDepth &&
    creationMode(policy) === creationMode(requested) &&
    canonical(policy.networkHosts) === canonical(requested.networkHosts) &&
    policy.parentPolicyElementId === parentPolicyElementId;
}
