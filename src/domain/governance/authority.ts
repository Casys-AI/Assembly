import type { ModelIdentity } from "../shared-kernel/model-identity.ts";

/** An admitted model's project and system, plus the execution space (main or a
 * Request branch) where it is admitted and its policies apply. */
export interface ExecutionSpaceRef
  extends Pick<ModelIdentity, "projectId" | "systemId"> {
  executionSpaceId: string;
}

/** Host-scoped actor identity; a native operator ID alone is not an instance.
 * Defined beside `ExecutionSpaceRef` so the work context can carry it without a
 * new import of the operator authority module. */
export interface ScopedOperatorRef extends ExecutionSpaceRef {
  operatorId: string;
}

/** Provenance of the local owner's authority in one admitted system. */
export interface OwnerAuthority {
  ownerSource: "modeled" | "implicit-legacy";
  systemId: string;
  operatorId: string;
  operatorNativeId: string;
  mandateId: string;
  mandateNativeId: string;
  mandateRevision: number;
  rootAuthorityId: string;
  rootAuthorityNativeId: string;
  rootGrantId: string;
  rootGrantNativeId: string;
  sourceIds: string[];
}

/** Identity/revision equality shared with native source authorization. Source
 * references remain provenance and are intentionally excluded. */
export const OWNER_AUTHORITY_IDENTITY_FIELDS = [
  "ownerSource",
  "systemId",
  "operatorId",
  "operatorNativeId",
  "mandateId",
  "mandateNativeId",
  "mandateRevision",
  "rootAuthorityId",
  "rootAuthorityNativeId",
  "rootGrantId",
  "rootGrantNativeId",
] as const;
export function sameOwnerAuthorityIdentity(
  left: OwnerAuthority,
  right: OwnerAuthority,
): boolean {
  return OWNER_AUTHORITY_IDENTITY_FIELDS.every((field) =>
    left[field] === right[field]
  );
}

export type OwnerDecisionAction =
  | "mandate-change"
  | "candidate-admission"
  | "model-adoption"
  | "model-revision"
  | "local-recovery";

/** A decision receipt refers to the authority of the state before the effect. */
export interface AuthorityExercise extends OwnerAuthority {
  /** Exact operator creation under a grant admitted before this publication. */
  creationDelegation?: {
    actorId: string;
    policyId: string;
    policyRevision: number;
    policyElementId: string;
    policyIssuer: OwnerAuthority;
    requestedBy: string;
    changeId: string;
    caseId?: string;
    designerScopeId?: string;
    teamOrigin?: { operatorId: string; requestId: string };
    operator: import("./operator-authority.ts").OperatorCreationSpec;
  };
  /** Exact candidate admission by an operator under a prior source grant. */
  candidateDelegation?: {
    actorId: string;
    policyId: string;
    policyRevision: number;
    policyElementId: string;
    policyIssuer: OwnerAuthority;
    requestedBy: string;
    candidateId: string;
    candidateDigest: string;
    caseId: string;
    toolKind: import("../shared-kernel/tool-kind.ts").ToolKind;
    tests: import("../work/candidates.ts").TestReport;
    contract: import("../work/candidates.ts").NativeToolContract;
  };
  delegation?: {
    actorId: string;
    /** Composite instances; absent only on receipts written before 4.8c, which
     * verify in main only. */
    actor?: ScopedOperatorRef;
    requester?: ScopedOperatorRef;
    policyId: string;
    policyRevision: number;
    policyElementId: string;
    policyIssuer: OwnerAuthority;
    requestedBy: string;
    changeId: string;
    caseId: string;
    requestedRights:
      import("./records/pending-change.ts").MandateRequestedRights;
  };
  authoritySchema: 2;
  action: OwnerDecisionAction;
  baseModelDigest: string;
  outOfMandate: boolean;
  reason?: string;
}

export class AuthorityInvariantError extends Error {
  readonly code = "AUTHORITY_INVARIANT";
  constructor(
    readonly invariant: 1 | 3,
    readonly reason: string,
    message?: string,
  ) {
    super(message ?? `Authority invariant ${invariant}: ${reason}`);
    this.name = "AuthorityInvariantError";
  }
}

/** Compatibility provenance only: these synthetic identities grant no new rights. */
export function legacyOwnerAuthority(systemId: string): OwnerAuthority {
  const prefix = `${systemId}/implicit-legacy`;
  return {
    ownerSource: "implicit-legacy",
    systemId,
    operatorId: "owner",
    operatorNativeId: `${prefix}/owner`,
    mandateId: "legacy-owner",
    mandateNativeId: `${prefix}/mandate`,
    mandateRevision: 1,
    rootAuthorityId: "legacy-root",
    rootAuthorityNativeId: `${prefix}/root`,
    rootGrantId: "legacy-root-grant",
    rootGrantNativeId: `${prefix}/root-grant`,
    sourceIds: [],
  };
}

export function ownerAuthorityFor(model: {
  identity: Pick<ModelIdentity, "systemId">;
  ownerAuthority?: OwnerAuthority;
}): OwnerAuthority {
  const authority = model.ownerAuthority ??
    legacyOwnerAuthority(model.identity.systemId);
  if (authority.systemId !== model.identity.systemId) {
    throw new AuthorityInvariantError(1, "owner-system-mismatch");
  }
  return authority;
}

export function exerciseOwnerAuthority(
  model: {
    identity: Pick<ModelIdentity, "systemId">;
    version: { digest: string };
    ownerAuthority?: OwnerAuthority;
  },
  action: OwnerDecisionAction,
  options: { outOfMandate?: boolean; reason?: string } = {},
): AuthorityExercise {
  return {
    ...ownerAuthorityFor(model),
    authoritySchema: 2,
    action,
    baseModelDigest: model.version.digest,
    outOfMandate: action === "local-recovery" || options.outOfMandate === true,
    ...(options.reason ? { reason: options.reason } : {}),
  };
}
