import type { OwnerAuthority } from "../../governance/authority.ts";
import { spaceControlActs } from "../../governance/policies/space-execution-policy.ts";
import { canonical } from "../../primitives/canonical-json.ts";
import { MAX_OPERATOR_UNITS } from "../records/conversations.ts";
import { exactSourceVersion } from "../request-spaces/scope.ts";
import {
  type SpaceControlAuthority,
  type SpaceControlSourceBinding,
} from "../request-spaces/space-control.ts";

/** Canonical modeled owner identity shared by active and disabled source checks. */
export function spaceControlOwnerIdentity(
  owner: OwnerAuthority | undefined,
  nativeSystemId: string,
) {
  const identity = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value !== "*";
  if (
    !owner || owner.ownerSource !== "modeled" ||
    owner.systemId !== nativeSystemId || !identity(nativeSystemId) ||
    ![
      owner.operatorId,
      owner.operatorNativeId,
      owner.mandateId,
      owner.mandateNativeId,
      owner.rootAuthorityId,
      owner.rootAuthorityNativeId,
      owner.rootGrantId,
      owner.rootGrantNativeId,
    ].every(identity) ||
    !Number.isSafeInteger(owner.mandateRevision) || owner.mandateRevision < 0 ||
    !Array.isArray(owner.sourceIds) || !owner.sourceIds.every(identity)
  ) return null;
  return {
    ownerSource: owner.ownerSource,
    systemId: owner.systemId,
    operatorId: owner.operatorId,
    operatorNativeId: owner.operatorNativeId,
    mandateId: owner.mandateId,
    mandateNativeId: owner.mandateNativeId,
    mandateRevision: owner.mandateRevision,
    rootAuthorityId: owner.rootAuthorityId,
    rootAuthorityNativeId: owner.rootAuthorityNativeId,
    rootGrantId: owner.rootGrantId,
    rootGrantNativeId: owner.rootGrantNativeId,
  };
}

/** Versioned source references and owner.sourceIds remain audit evidence. They
 * cannot invalidate an unchanged policy merely because its admitted model moved.
 * Every actual authority identity, revision and permission is compared instead.
 * Null refuses malformed/unmodeled evidence; no legacy policy is synthesized. */
export function effectiveSpaceControlAuthority(
  authority: SpaceControlAuthority,
) {
  const owner = authority?.owner, scope = authority?.scope;
  const acts = spaceControlActs(authority?.acts);
  const effectiveOwner = spaceControlOwnerIdentity(
    owner,
    authority?.sourceSystemNativeId,
  );
  const identity = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value !== "*";
  const revision = (value: unknown): value is number =>
    Number.isSafeInteger(value) && Number(value) >= 0;
  if (
    !scope || !identity(scope.projectId) || !identity(scope.systemId) ||
    !effectiveOwner ||
    !identity(authority.policyId) ||
    !revision(authority.policyRevision) ||
    !exactSourceVersion(authority.sourceVersion) ||
    !/^[a-f0-9]{64}$/.test(authority.modelDigest) ||
    !Array.isArray(authority.operatorIds) || !authority.operatorIds.length ||
    authority.operatorIds.length > MAX_OPERATOR_UNITS ||
    !authority.operatorIds.every(identity) ||
    new Set(authority.operatorIds).size !== authority.operatorIds.length ||
    !acts || !acts.includes("open-request") ||
    !acts.includes("execute-conversation")
  ) return null;
  return {
    scope: { projectId: scope.projectId, systemId: scope.systemId },
    sourceSystemNativeId: authority.sourceSystemNativeId,
    owner: effectiveOwner,
    policyId: authority.policyId,
    policyRevision: authority.policyRevision,
    operatorIds: [...authority.operatorIds].sort(),
    acts,
  };
}
export function sameEffectiveSpaceControlAuthority(
  left: SpaceControlAuthority,
  right: SpaceControlAuthority,
): boolean {
  const a = effectiveSpaceControlAuthority(left),
    b = effectiveSpaceControlAuthority(right);
  return a !== null && b !== null && canonical(a) === canonical(b);
}
/** The same person under the same effective space-control authority. The
 * credential lineage (capability, session) is deliberately not compared: one
 * owner may hold several live capabilities, and the development host issues
 * one per page load. An admission row alone governs execution; revoking its
 * capability revokes it. Each credential is checked current where it acts. */
export function sameSpaceControlPrincipal(
  left: { ownerId: string; authority: SpaceControlAuthority },
  right: { ownerId: string; authority: SpaceControlAuthority },
): boolean {
  return typeof left.ownerId === "string" && left.ownerId.length > 0 &&
    left.ownerId === right.ownerId &&
    sameEffectiveSpaceControlAuthority(left.authority, right.authority);
}

/** Checks a source-native identity against the host's explicit constructor binding. */
export function spaceControlAuthorityMatchesBinding(
  authority: SpaceControlAuthority,
  binding: SpaceControlSourceBinding,
): boolean {
  return effectiveSpaceControlAuthority(authority) !== null &&
    canonical(authority.scope) === canonical(binding.scope) &&
    authority.sourceSystemNativeId === binding.sourceSystemNativeId;
}
