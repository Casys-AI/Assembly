import type { AgentConversation } from "../../../src/domain/work/records/conversations.ts";
import { canonical } from "../../../src/domain/primitives/canonical-json.ts";
import type { Candidate } from "../../../src/domain/work/candidates.ts";
import type {
  PendingChange,
} from "../../../src/domain/governance/records/pending-change.ts";
import type { AuthorityExercise } from "../../../src/domain/governance/authority.ts";
import type { SourceCommit, SourceRevisions } from "../model/revisions/api.ts";
import type { OperatorNotice } from "./operator-notice.ts";

type Delegation = NonNullable<AuthorityExercise["delegation"]>;
export type AuthorityRoster = readonly Pick<
  AgentConversation,
  "nativeId" | "name"
>[];
export interface AuthorityReading {
  data: SourceRevisions | null;
  fresh: boolean;
}
export const sameCommit = (a: string, b: string) =>
  a.replace(/^(commit|branch):/, "") === b.replace(/^(commit|branch):/, "");

/**
 * The receipt a decided change records for its own base: decided, dated, of
 * the current schema, a mandate change within mandate. Who exercised it is
 * for each reader below to check.
 */
function decidedReceipt(change: PendingChange): AuthorityExercise | undefined {
  const receipt = change.authorityExercise;
  return receipt && ["approved", "refused"].includes(change.status) &&
      change.decidedAt && receipt.authoritySchema === 2 &&
      receipt.action === "mandate-change" && !receipt.outOfMandate &&
      change.baseModelDigest &&
      receipt.baseModelDigest === change.baseModelDigest
    ? receipt
    : undefined;
}

/** A delegated act names this exact change, its requester, an actor and a policy revision. */
function bindsDelegation(
  change: PendingChange,
  act: {
    changeId: string;
    requestedBy: string;
    caseId?: string;
    actorId: string;
    policyId: string;
    policyRevision: number;
  },
): boolean {
  return act.changeId === change.id && act.requestedBy === change.requestedBy &&
    act.caseId === change.caseId && Boolean(act.actorId) &&
    Boolean(act.policyId) && Number.isSafeInteger(act.policyRevision) &&
    act.policyRevision >= 1;
}

export function recordedOwnerAuthority(
  change: PendingChange,
): AuthorityExercise | undefined {
  const receipt = decidedReceipt(change);
  // A receipt that delegated the act is never the person's own.
  return change.authority === "human" && !receipt?.delegation &&
      !receipt?.creationDelegation
    ? receipt
    : undefined;
}

/** Recorded host evidence only; this presentation never grants authority. */
export function recordedDelegation(
  change: PendingChange,
): Delegation | undefined {
  const delegated = decidedReceipt(change)?.delegation;
  if (
    !delegated || change.authority !== "builder" ||
    change.kind !== "mandate-change" || !bindsDelegation(change, delegated) ||
    !change.caseId || change.designerScopeId ||
    delegated.actorId === change.requestedBy ||
    canonical(delegated.requestedRights) !==
      canonical(change.requestedRights) ||
    !change.requestedRights || !("addNetworkHosts" in change.requestedRights) ||
    Object.keys(change.requestedRights).length !== 1
  ) return undefined;
  return delegated;
}

export function authorityOwner(change: PendingChange): string | undefined {
  return change.requestedRights &&
      ("operatorAuthority" in change.requestedRights ||
        "toolAdmission" in change.requestedRights)
    ? change.requestedBy
    : recordedDelegation(change)?.actorId;
}

export function authorityName(
  roster: AuthorityRoster,
  nativeId: string,
): string {
  return roster.find((entry) => entry.nativeId === nativeId)?.name.trim() ||
    nativeId;
}

/** A current source policy, never a policy borrowed from an old execution pin. */
export function currentAuthorityLabel(
  change: PendingChange,
  read?: AuthorityReading,
): string {
  if (change.requestedRights && "toolAdmission" in change.requestedRights) {
    return currentToolAdmissionGrantLabel(change, read);
  }
  const owner = authorityOwner(change);
  const data = read?.data;
  const policyId =
    change.requestedRights && "operatorAuthority" in change.requestedRights
      ? change.requestedRights.operatorAuthority.policyId
      : recordedDelegation(change)?.policyId;
  const available = data?.runtime.available;
  if (
    !read?.fresh || !owner || !policyId || data?.agentId !== owner ||
    !data.runtime.executable || !available?.repositoryVersion ||
    !sameCommit(data.version, available.repositoryVersion) ||
    !data.runtime.sourceRights?.operatorAuthorityPolicies
  ) return "Current policy status unavailable";
  const policies = data.runtime.sourceRights.operatorAuthorityPolicies.filter((
    p,
  ) => p.id === policyId && p.holderNativeId === owner);
  if (policies.length === 0) return "Not granted in the current model";
  if (policies.length !== 1) return "Current policy status unavailable";
  const policy = policies[0]!;
  if (!policy.enabled) return `Revoked · current revision ${policy.revision}`;
  const delegated = recordedDelegation(change);
  const referencedRevision = delegated?.policyRevision ??
    (change.status === "approved" && change.requestedRights &&
        "operatorAuthority" in change.requestedRights
      ? change.requestedRights.operatorAuthority.expectedPolicyRevision + 1
      : undefined);
  if (referencedRevision && referencedRevision !== policy.revision) {
    return `Policy revision changed · current revision ${policy.revision}`;
  }
  if (
    change.status === "approved" && change.publishedCommit &&
    change.requestedRights && "operatorAuthority" in change.requestedRights
  ) {
    const request = change.requestedRights.operatorAuthority;
    if (
      canonical(policy.recipients) !== canonical(request.recipients) ||
      // A named recipient space is part of who the policy covers (4.8c C2).
      (policy.recipientExecutionSpaceId ?? null) !==
        (request.recipientExecutionSpaceId ?? null) ||
      canonical(policy.networkHosts) !== canonical(request.networkHosts) ||
      canonical(policy.acts) !== canonical(request.acts) ||
      canonical(policy.toolIds) !== canonical(request.toolIds) ||
      policy.maxDelegationDepth !== request.maxDelegationDepth
    ) return "Current policy differs from the recorded authority";
  }
  if (delegated) {
    if (!policy.rootAuthority || !delegated.policyElementId) {
      return "Current policy status unavailable";
    }
    if (
      policy.elementId !== delegated.policyElementId ||
      canonical(policy.rootAuthority) !== canonical(delegated.policyIssuer) ||
      !policy.recipients.includes(delegated.requestedBy) ||
      policy.recipientExecutionSpaceId !== undefined &&
        policy.recipientExecutionSpaceId !==
          delegated.requester?.executionSpaceId ||
      canonical(policy.acts) !== '["addNetworkHosts"]' ||
      policy.toolIds.length !== 0 || policy.maxDelegationDepth !== 0 ||
      !delegated.requestedRights ||
      !("addNetworkHosts" in delegated.requestedRights) ||
      !delegated.requestedRights.addNetworkHosts.every((host) =>
        policy.networkHosts.includes(host)
      )
    ) return "Current policy differs from the recorded authority";
  }
  return `Enabled in current sources · revision ${policy.revision}`;
}

function currentToolAdmissionGrantLabel(
  change: PendingChange,
  read?: AuthorityReading,
): string {
  const rights = change.requestedRights;
  if (!rights || !("toolAdmission" in rights)) {
    return "Current policy status unavailable";
  }
  const request = rights.toolAdmission;
  const data = read?.data;
  const owner = change.requestedBy;
  const available = data?.runtime.available;
  if (
    !read?.fresh || !owner || data?.agentId !== owner ||
    !data.runtime.executable || !available?.repositoryVersion ||
    !sameCommit(data.version, available.repositoryVersion) ||
    !data.runtime.sourceRights?.toolAdmissionPolicies
  ) return "Current policy status unavailable";
  const policies = data.runtime.sourceRights.toolAdmissionPolicies.filter((
    policy,
  ) => policy.id === request.policyId && policy.holderNativeId === owner);
  if (policies.length === 0) return "Not granted in the current model";
  if (policies.length !== 1) return "Current policy status unavailable";
  const policy = policies[0]!;
  if (!policy.enabled) return `Revoked · current revision ${policy.revision}`;
  if (
    change.status === "approved" &&
    request.expectedPolicyRevision + 1 !== policy.revision
  ) return `Policy revision changed · current revision ${policy.revision}`;
  if (
    change.status === "approved" && change.publishedCommit &&
    (canonical(policy.recipients) !== canonical(request.recipients) ||
      (policy.recipientExecutionSpaceId ?? null) !==
        (request.recipientExecutionSpaceId ?? null) ||
      canonical(policy.toolKinds) !== canonical(request.toolKinds) ||
      policy.maxDelegationDepth !== request.maxDelegationDepth)
  ) return "Current policy differs from the recorded authority";
  return `Enabled in current sources · revision ${policy.revision}`;
}

/** Candidate-specific proof; network delegation never stands in for admission. */
export function recordedCandidateDelegation(
  candidate: Candidate,
  operatorId: string,
): NonNullable<AuthorityExercise["candidateDelegation"]> | undefined {
  const decision = candidate.admissionDecision;
  const receipt = decision?.authorityExercise;
  const proof = receipt?.candidateDelegation;
  const admission = candidate.admission;
  const contract = candidate.toolAdmissionContract;
  if (
    !proof || !decision || decision.candidateDigest !== candidate.digest ||
    !["approve", "refuse"].includes(decision.verdict) ||
    candidate.requiredAuthority !== "human" || receipt?.authoritySchema !== 2 ||
    receipt.action !== "candidate-admission" || receipt.outOfMandate ||
    receipt.delegation || !candidate.promotionModelDigest ||
    receipt.baseModelDigest !== candidate.promotionModelDigest ||
    proof.requestedBy !== operatorId || !proof.actorId ||
    proof.actorId === operatorId || proof.candidateId !== candidate.id ||
    proof.candidateDigest !== candidate.digest || !candidate.caseId ||
    candidate.designerScopeId || proof.caseId !== candidate.caseId ||
    proof.toolKind !== candidate.kind ||
    !contract || contract.kind !== candidate.kind ||
    typeof contract.nativeId !== "string" || !contract.nativeId.trim() ||
    contract.module !== "default({url,html}) => {title,text}" ||
    !Array.isArray(contract.acceptanceCriteria) ||
    !contract.acceptanceCriteria.length ||
    !contract.acceptanceCriteria.every((criterion) =>
      typeof criterion === "string" && criterion.trim().length > 0
    ) ||
    canonical(proof.contract) !== canonical(contract) ||
    !proof.policyIssuer?.operatorNativeId ||
    canonical(proof.tests) !== canonical(candidate.tests) ||
    proof.tests?.passed !== true || !proof.policyId || !proof.policyElementId ||
    !Number.isSafeInteger(proof.policyRevision) || proof.policyRevision < 1 ||
    !candidate.toolAdmissionPolicyPins?.some((pin) =>
      pin.policyId === proof.policyId &&
      pin.policyRevision === proof.policyRevision &&
      pin.policyElementId === proof.policyElementId &&
      pin.holderNativeId === proof.actorId
    ) ||
    candidate.stage === "active" && !admission ||
    admission &&
      (decision.verdict !== "approve" ||
        admission.reason !== decision.reason ||
        admission.authority !== "delegate" ||
        admission.actorId !== proof.actorId ||
        admission.candidateId !== candidate.id ||
        admission.candidateDigest !== candidate.digest ||
        canonical(admission.authorityExercise) !== canonical(receipt))
  ) return undefined;
  return proof;
}

type CreationDelegation = NonNullable<
  AuthorityExercise["creationDelegation"]
>;

/** An operator's own creation under its prior grant, bound to this change. */
export function recordedCreationDelegation(
  change: PendingChange,
): CreationDelegation | undefined {
  const receipt = decidedReceipt(change);
  const delegated = receipt?.creationDelegation;
  return delegated && change.kind === "operator-creation" &&
      change.authority === "builder" && change.status === "approved" &&
      !receipt.delegation && bindsDelegation(change, delegated) &&
      canonical(delegated.operator) === canonical(change.operator)
    ? delegated
    : undefined;
}

/** Who decided a change and under which rule, from its recorded receipt only. */
export interface DecisionAuthor {
  by: string;
  rule: string;
  revision: number;
}

/**
 * The person under their own mandate, or an operator under the policy that
 * delegated the decision to it. A receipt that does not bind to the change
 * names no one.
 */
export function decidedBy(
  change: PendingChange,
  roster: AuthorityRoster,
): DecisionAuthor | undefined {
  const owner = recordedOwnerAuthority(change);
  if (owner) {
    return {
      by: "you",
      rule: owner.mandateId,
      revision: owner.mandateRevision,
    };
  }
  const delegated = recordedDelegation(change) ??
    recordedCreationDelegation(change);
  return delegated && {
    by: authorityName(roster, delegated.actorId),
    rule: delegated.policyId,
    revision: delegated.policyRevision,
  };
}

/** "Decided by you · rule owner · rev. 1". */
export function decidedByLabel({ by, rule, revision }: DecisionAuthor): string {
  return `Decided by ${by} · rule ${rule} · rev. ${revision}`;
}

/** A notice may only point at the exact recorded change of its native owner. */
export function noticeChange(
  notice: OperatorNotice,
  roster: readonly AgentConversation[],
): PendingChange | undefined {
  if (notice.kind !== "authority-escalation") return undefined;
  const matches = roster.filter((agent) =>
    agent.nativeId === notice.requestedBy
  )
    .flatMap((agent) => agent.proposalContext?.changes ?? [])
    .filter((change) =>
      change.id === notice.changeId &&
      change.requestedBy === notice.requestedBy &&
      change.caseId === notice.caseId
    );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Host-parsed author, recorded change and publication must all name this commit. */
export function authorityChangeForCommit(
  commit: Pick<SourceCommit, "version" | "parsedAuthor">,
  roster: readonly AgentConversation[],
): PendingChange | undefined {
  if (
    commit.parsedAuthor.kind !== "ase" ||
    !commit.parsedAuthor.ref.startsWith("approved-change:")
  ) return undefined;
  const changeId = commit.parsedAuthor.ref.slice("approved-change:".length);
  const matches = roster.flatMap((agent) =>
    (agent.proposalContext?.changes ?? []).filter((change) =>
      change.id === changeId && change.requestedBy === agent.nativeId &&
      change.status === "approved" && Boolean(change.publishedCommit) &&
      sameCommit(change.publishedCommit!, commit.version) &&
      Boolean(authorityOwner(change)) &&
      Boolean(recordedDelegation(change) || recordedOwnerAuthority(change))
    )
  );
  return matches.length === 1 ? matches[0] : undefined;
}
