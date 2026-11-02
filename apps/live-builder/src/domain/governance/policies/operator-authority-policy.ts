/** Bounded inter-operator decisions, distinct from tool or source admission. */
import type {
  ExecutableModel,
  NativePolicyIdentity,
} from "../../model/execution/executable-model.ts";
import type { AuthorityExercise } from "../authority.ts";
import { exerciseOwnerAuthority } from "../authority.ts";
import type { PendingChange } from "../records/pending-change.ts";
import {
  MAIN_EXECUTION_SPACE_ID,
  OperatorAuthorityError,
} from "../operator-authority.ts";
import { type ExecutionSpaceRef } from "../authority.ts";
import { validateNetworkScope } from "./network-policy.ts";
import { canonical } from "../../primitives/canonical-json.ts";
import {
  assertPolicySpace,
  isDelegationIdentity,
  namesHolderInstance,
  policyScopeRefusal,
  scopedOperator,
} from "./delegation-scope.ts";

export interface OperatorAuthorityPolicyRequest {
  policyId: string;
  expectedPolicyRevision: number;
  enabled: boolean;
  recipients: string[];
  /** Absent: the legacy form, relative to the space where the policy is read. */
  recipientExecutionSpaceId?: string;
  acts: ["addNetworkHosts"];
  networkHosts: string[];
  toolIds: [];
  maxDelegationDepth: 0;
}
export interface OperatorAuthorityPolicy extends
  NativePolicyIdentity,
  Omit<
    OperatorAuthorityPolicyRequest,
    "policyId" | "expectedPolicyRevision"
  > {
  holderNativeId: string;
  mandateNativeId: string;
  systemId: string;
}
export function validateOperatorAuthorityPolicyRequest(
  value: unknown,
): OperatorAuthorityPolicyRequest {
  const fail = (): never => {
    throw new OperatorAuthorityError(
      "INVALID_AUTHORITY_POLICY",
      "Expected explicit policy identity, revision, recipients and supported bounds",
    );
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail();
  }
  const v = value as Record<string, unknown>;
  const scoped = Object.hasOwn(v, "recipientExecutionSpaceId");
  if (
    Object.keys(v).sort().join(",") !==
      [
        "acts",
        "enabled",
        "expectedPolicyRevision",
        "maxDelegationDepth",
        "networkHosts",
        "policyId",
        ...(scoped ? ["recipientExecutionSpaceId"] : []),
        "recipients",
        "toolIds",
      ].join(",") ||
    typeof v.policyId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(v.policyId) ||
    !Number.isSafeInteger(v.expectedPolicyRevision) ||
    Number(v.expectedPolicyRevision) < 0 ||
    Number(v.expectedPolicyRevision) >= Number.MAX_SAFE_INTEGER ||
    typeof v.enabled !== "boolean" || !Array.isArray(v.recipients) ||
    !v.recipients.length || v.recipients.length > 32 ||
    !v.recipients.every(isDelegationIdentity) ||
    new Set(v.recipients).size !== v.recipients.length ||
    scoped && !isDelegationIdentity(v.recipientExecutionSpaceId) ||
    canonical(v.acts) !== '["addNetworkHosts"]' ||
    canonical(v.toolIds) !== "[]" || v.maxDelegationDepth !== 0
  ) return fail();
  let hosts: string[];
  try {
    hosts = validateNetworkScope({ allowedHosts: v.networkHosts }).allowedHosts;
  } catch (error) {
    throw new OperatorAuthorityError(
      "INVALID_AUTHORITY_POLICY",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!hosts.length) return fail();
  return structuredClone(v) as unknown as OperatorAuthorityPolicyRequest;
}
export function assertOperatorPolicyRequest(
  model: Pick<
    ExecutableModel,
    "identity" | "policy" | "ownerAuthority" | "operatorAuthorityPolicies"
  >,
  request: unknown,
): OperatorAuthorityPolicyRequest {
  const value = validateOperatorAuthorityPolicyRequest(request);
  const existing = model.operatorAuthorityPolicies?.find((p) =>
    p.id === value.policyId
  );
  if (
    !model.policy.mayProposeSysmlRevision ||
    model.ownerAuthority?.ownerSource !== "modeled" ||
    namesHolderInstance(model.identity.builderId, value) ||
    existing && existing.holderNativeId !== model.identity.builderId
  ) {
    throw new OperatorAuthorityError(
      "AUTHORITY_POLICY_FORBIDDEN",
      "Only the Main Operator may request its bounded authority; self recipients are forbidden",
      { policyId: value.policyId },
    );
  }
  if (
    (existing?.revision ?? 0) !== value.expectedPolicyRevision ||
    !existing && !value.enabled
  ) {
    throw new OperatorAuthorityError(
      "AUTHORITY_POLICY_STALE",
      "The policy revision changed or does not exist",
      { policyId: value.policyId },
    );
  }
  return value;
}

/** Who exercises a delegated decision, and under which policy revision. */
export interface DelegatedActor {
  actorId: string;
  policyId: string;
  policyRevision: number;
}

/** Owner authority comes from `target`, where the change applies; the policy is
 * read in `policyModel`. Both instances are derived from host-bound inputs: the
 * actor is `command.actorId` in `space`, the requester is the change's author
 * in `targetSpace` (the same space and model in-space). */
export function delegatedAuthorityExercise(input: {
  target: ExecutableModel;
  targetSpace: ExecutionSpaceRef;
  policyModel: ExecutableModel;
  space: ExecutionSpaceRef;
  change: PendingChange;
  command: DelegatedActor;
}): AuthorityExercise {
  const { target, targetSpace, policyModel, space, change, command } = input;
  assertPolicySpace(space, [policyModel], { changeId: change.id });
  assertPolicySpace(targetSpace, [target], { changeId: change.id });
  const policy = policyModel.operatorAuthorityPolicies?.find((p) =>
    p.id === command.policyId
  );
  if (
    !policy || policy.revision !== command.policyRevision || !policy.enabled
  ) {
    throw new OperatorAuthorityError(
      "AUTHORITY_POLICY_STALE",
      "The delegated policy is missing, revoked or superseded; refer to the person",
      { policyId: command.policyId, changeId: change.id },
    );
  }
  const actor = scopedOperator(space, command.actorId);
  const requester = scopedOperator(targetSpace, change.requestedBy ?? "");
  const rights = change.requestedRights;
  const refusal = policyScopeRefusal({
    space,
    policy,
    actor,
    requester,
    targetSpace,
  });
  if (
    refusal || change.requestedBy !== target.identity.builderId ||
    change.kind !== "mandate-change" || !change.caseId ||
    change.designerScopeId ||
    !rights || Object.keys(rights).length !== 1 ||
    !("addNetworkHosts" in rights) ||
    !Array.isArray(rights.addNetworkHosts) || !rights.addNetworkHosts.length ||
    rights.addNetworkHosts.some((host) =>
      !policy.networkHosts.includes(host)
    ) ||
    !policy.acts.includes("addNetworkHosts") || policy.toolIds.length ||
    policy.maxDelegationDepth !== 0
  ) {
    throw new OperatorAuthorityError(
      "AUTHORITY_OUT_OF_BOUNDS",
      "This exact change requires the person's decision",
      {
        policyId: command.policyId,
        changeId: change.id,
        requestedBy: change.requestedBy ?? "",
        ...(refusal ? { scope: refusal } : {}),
      },
    );
  }
  return {
    ...exerciseOwnerAuthority(target, "mandate-change"),
    delegation: {
      actorId: actor.operatorId,
      actor,
      requester,
      policyId: policy.id,
      policyRevision: policy.revision,
      policyElementId: policy.elementId,
      policyIssuer: structuredClone(policy.rootAuthority!),
      requestedBy: change.requestedBy,
      changeId: change.id,
      caseId: change.caseId,
      requestedRights: structuredClone(rights),
    },
  };
}

/** Recompute the exact receipt from host-bound inputs; the recorded instances
 * must equal the recomputed ones. A receipt without them predates 4.8c: it is
 * recomputed in that historical shape and verifies in main only. */
export function assertDelegatedAuthorityReceipt(input: {
  target: ExecutableModel;
  targetSpace: ExecutionSpaceRef;
  policyModel: ExecutableModel;
  space: ExecutionSpaceRef;
  change: PendingChange;
}): void {
  const { targetSpace, space, change } = input;
  const delegated = change.authorityExercise?.delegation;
  const historical = !!delegated && !delegated.actor && !delegated.requester;
  const mismatch = (): never => {
    throw new OperatorAuthorityError(
      "AUTHORITY_RECEIPT_MISMATCH",
      "The delegated receipt does not match the exact change",
      { changeId: change.id },
    );
  };
  if (
    !delegated || change.status !== "approved" ||
    change.authority !== "builder" || !change.decidedAt ||
    historical && (space.executionSpaceId !== MAIN_EXECUTION_SPACE_ID ||
        targetSpace.executionSpaceId !== MAIN_EXECUTION_SPACE_ID)
  ) return mismatch();
  const exact = delegatedAuthorityExercise({
    ...input,
    command: {
      actorId: delegated.actorId,
      policyId: delegated.policyId,
      policyRevision: delegated.policyRevision,
    },
  });
  if (historical) {
    delete exact.delegation!.actor;
    delete exact.delegation!.requester;
  }
  if (canonical(change.authorityExercise) !== canonical(exact)) mismatch();
}
