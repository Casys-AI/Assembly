/** A separate, bounded grant to admit exact candidates of other operators. */
import type {
  ExecutableModel,
  NativePolicyIdentity,
} from "../../model/execution/executable-model.ts";
import { OperatorAuthorityError } from "../operator-authority.ts";
import { type ExecutionSpaceRef } from "../authority.ts";
import { exerciseOwnerAuthority } from "../authority.ts";
import { canonical } from "../../primitives/canonical-json.ts";
import {
  assertPolicySpace,
  isDelegationIdentity,
  namesHolderInstance,
  policyCovers,
  policyHolder,
  policyScopeRefusal,
  scopedOperator,
} from "./delegation-scope.ts";
import { TOOL_KINDS, type ToolKind } from "../../shared-kernel/tool-kind.ts";

export interface ToolAdmissionPolicyRequest {
  policyId: string;
  expectedPolicyRevision: number;
  enabled: boolean;
  recipients: string[];
  /** Absent: the legacy form, relative to the space where the policy is read. */
  recipientExecutionSpaceId?: string;
  toolKinds: ToolKind[];
  maxDelegationDepth: 0;
}
export interface ToolAdmissionPolicy
  extends
    NativePolicyIdentity,
    Omit<ToolAdmissionPolicyRequest, "policyId" | "expectedPolicyRevision"> {
  holderNativeId: string;
  mandateNativeId: string;
  systemId: string;
}
export function validateToolAdmissionPolicyRequest(
  value: unknown,
): ToolAdmissionPolicyRequest {
  const fail = (): never => {
    throw new OperatorAuthorityError(
      "INVALID_AUTHORITY_POLICY",
      "Expected explicit policy identity, revision, recipients and supported tool kinds",
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
        "enabled",
        "expectedPolicyRevision",
        "maxDelegationDepth",
        "policyId",
        ...(scoped ? ["recipientExecutionSpaceId"] : []),
        "recipients",
        "toolKinds",
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
    !Array.isArray(v.toolKinds) || !v.toolKinds.length ||
    v.toolKinds.some((kind) => !TOOL_KINDS.includes(kind as ToolKind)) ||
    new Set(v.toolKinds).size !== v.toolKinds.length ||
    v.maxDelegationDepth !== 0
  ) return fail();
  return structuredClone(v) as unknown as ToolAdmissionPolicyRequest;
}
export function assertToolAdmissionPolicyRequest(
  model: Pick<
    ExecutableModel,
    "identity" | "policy" | "ownerAuthority" | "toolAdmissionPolicies"
  >,
  request: unknown,
): ToolAdmissionPolicyRequest {
  const value = validateToolAdmissionPolicyRequest(request);
  const existing = model.toolAdmissionPolicies?.find((p) =>
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

export interface CandidateDelegatedActor {
  actorId: string;
  policyId: string;
  policyRevision: number;
}

/** Capture only authority already adopted when preparation begins. The model
 * is the requester's, admitted in `space`, where its policies are read. */
export function toolAdmissionPreparation(
  model: ExecutableModel,
  kind: ToolKind,
  space: ExecutionSpaceRef,
) {
  assertPolicySpace(space, [model], { toolKind: kind });
  const requester = scopedOperator(space, model.identity.builderId);
  const pins = model.toolAdmissionPolicies?.filter((policy) =>
    policy.enabled && policy.toolKinds.includes(kind) &&
    policy.maxDelegationDepth === 0 &&
    policyCovers({
      space,
      policy,
      actor: policyHolder(space, policy),
      requester,
    })
  ).map((policy) => ({
    policyId: policy.id,
    policyRevision: policy.revision,
    holderNativeId: policy.holderNativeId,
    policyElementId: policy.elementId,
  }));
  return pins?.length ? structuredClone(pins) : undefined;
}

export function delegatedCandidateAuthorityExercise(
  model: ExecutableModel,
  candidate: import("../../work/candidates.ts").Candidate,
  actor: CandidateDelegatedActor,
  space: ExecutionSpaceRef,
): import("../authority.ts").AuthorityExercise {
  assertPolicySpace(space, [model], { candidateId: candidate.id });
  const policy = model.toolAdmissionPolicies?.find((p) =>
    p.id === actor.policyId
  );
  if (!policy || !policy.enabled || policy.revision !== actor.policyRevision) {
    throw new OperatorAuthorityError(
      "AUTHORITY_POLICY_STALE",
      "The delegated tool admission policy is missing, revoked or superseded",
      { policyId: actor.policyId, candidateId: candidate.id },
    );
  }
  const contracts = model.contracts.filter((c) => c.kind === candidate.kind);
  const pinned = candidate.toolAdmissionPolicyPins?.some((pin) =>
    pin.policyId === policy.id && pin.policyRevision === policy.revision &&
    pin.holderNativeId === actor.actorId &&
    pin.policyElementId === policy.elementId
  );
  const refusal = policyScopeRefusal({
    space,
    policy,
    actor: scopedOperator(space, actor.actorId),
    requester: scopedOperator(space, model.identity.builderId),
  });
  if (
    !pinned || refusal ||
    !policy.toolKinds.includes(candidate.kind) ||
    policy.maxDelegationDepth !== 0 || !policy.rootAuthority ||
    candidate.requiredAuthority !== "human" ||
    model.configuration.builder.admissionAuthority !== "human" ||
    !candidate.caseId || candidate.designerScopeId ||
    candidate.promotionModelDigest !== model.version.digest ||
    candidate.proposedConfigurationRevision !== model.configuration.revision ||
    !candidate.tests?.passed || !candidate.tests.checks.length ||
    candidate.tests.checks.some((c) => c.passed !== true) ||
    contracts.length !== 1 || !candidate.toolAdmissionContract ||
    canonical(candidate.toolAdmissionContract) !== canonical(contracts[0])
  ) {
    throw new OperatorAuthorityError(
      "AUTHORITY_OUT_OF_BOUNDS",
      "This exact tested candidate requires the person's decision",
      {
        policyId: actor.policyId,
        candidateId: candidate.id,
        ...(refusal ? { scope: refusal } : {}),
      },
    );
  }
  return {
    ...exerciseOwnerAuthority(model, "candidate-admission"),
    candidateDelegation: {
      actorId: actor.actorId,
      policyId: policy.id,
      policyRevision: policy.revision,
      policyElementId: policy.elementId,
      policyIssuer: structuredClone(policy.rootAuthority),
      requestedBy: model.identity.builderId,
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      caseId: candidate.caseId,
      toolKind: candidate.kind,
      tests: structuredClone(candidate.tests),
      contract: structuredClone(contracts[0]!),
    },
  };
}

/** Recheck the exact recorded authority before creating an unpublished effect. */
export function assertCandidateDelegationReceipt(
  model: ExecutableModel,
  candidate: import("../../work/candidates.ts").Candidate,
  space: ExecutionSpaceRef,
): void {
  const exercise = candidate.admissionDecision?.authorityExercise;
  const delegated = exercise?.candidateDelegation;
  const admission = candidate.admission;
  if (
    !delegated || !exercise || !admission ||
    admission.authority !== "delegate" ||
    admission.actorId !== delegated.actorId ||
    admission.candidateId !== candidate.id ||
    admission.candidateDigest !== candidate.digest ||
    admission.mandateRevision !== model.configuration.builder.mandateRevision ||
    admission.configurationRevision !== model.configuration.revision ||
    candidate.admissionDecision?.candidateDigest !== candidate.digest ||
    candidate.admissionDecision.verdict !== "approve" ||
    admission.reason !== candidate.admissionDecision.reason ||
    canonical(admission.authorityExercise) !== canonical(exercise) ||
    canonical(exercise) !==
      canonical(
        delegatedCandidateAuthorityExercise(model, candidate, delegated, space),
      )
  ) {
    throw new OperatorAuthorityError(
      "AUTHORITY_RECEIPT_MISMATCH",
      "The delegated receipt does not match the exact candidate",
      { candidateId: candidate.id },
    );
  }
}
