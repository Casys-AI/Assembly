/** Change proposals against the admitted configuration. */
import type { AuthorityExercise } from "../authority.ts";
import type { ExecutableModel } from "../../model/execution/executable-model.ts";

export type MandateRequestedRights =
  | {
    toolAdmission:
      import("../policies/tool-admission-policy.ts").ToolAdmissionPolicyRequest;
  }
  | {
    operatorAuthority:
      import("../policies/operator-authority-policy.ts").OperatorAuthorityPolicyRequest;
  }
  | {
    grantModelEditing: import("../operator-authority.ts").ModelEditingGrant;
  }
  | { mayAdmitOwnCandidates: true }
  | { addNetworkHosts: string[] }
  | { setUrlSelectionMode: "authorized-host" | "user-provided" };

/** What an operator may request: the stored rights, except that a delegated
 * policy names its recipient Case, never a space (4.8d D4). The host derives
 * `recipientExecutionSpaceId` from the Case before the proposal and does not
 * store the Case. */
export type MandateRightsRequest =
  | Exclude<
    MandateRequestedRights,
    { operatorAuthority: unknown } | { toolAdmission: unknown }
  >
  | {
    operatorAuthority:
      & Omit<
        import("../policies/operator-authority-policy.ts").OperatorAuthorityPolicyRequest,
        "recipientExecutionSpaceId"
      >
      & { recipientCaseId?: string };
  }
  | {
    toolAdmission:
      & Omit<
        import("../policies/tool-admission-policy.ts").ToolAdmissionPolicyRequest,
        "recipientExecutionSpaceId"
      >
      & { recipientCaseId?: string };
  };

export interface SupportedMandateChange {
  kind: "propose_mandate_change";
  requestedRights:
    | "toolAdmission"
    | "operatorAuthority"
    | "grantModelEditing"
    | "mayAdmitOwnCandidates"
    | "addNetworkHosts"
    | "setUrlSelectionMode";
  description: string;
}

/** Immutable request origin; an active Case and designer scope are exclusive. */
export type ChangeRequestOrigin =
  & { requestedBy: string }
  & (
    | { caseId: string; designerScopeId?: never }
    | { designerScopeId: string; caseId?: never }
  );

export interface PendingChange {
  /** Absent only in historical snapshots; never inferred from decision input. */
  requestedBy?: string;
  caseId?: string;
  designerScopeId?: string;
  id: string;
  kind: "mandate-change" | "reviewer-creation" | "operator-creation";
  /** `superseded` is terminal: a newer adoption overtook the proposal's base. */
  status: "pending" | "approved" | "refused" | "superseded";
  baseRevision: number;
  /** Authority of the adopted contract when the proposal was made. */
  baseModelDigest?: string;
  authorityExercise?: AuthorityExercise;
  reason: string;
  requestedAt: string;
  /** Read-only legacy journal, consumed and removed by publication migration. */
  readonly publication?: Readonly<{
    baseRepositoryVersion?: string;
    /** Original admitted pin; source-only publication re-anchoring never changes it. */
    adoptionBaseRepositoryVersion?: string;
    applied?: Pick<ExecutableModel, "identity" | "version">;
    completed?: boolean;
  }>;
  name?: string;
  requestedRights?: MandateRequestedRights;
  role?: "reviewer" | "operator";
  operator?: import("../operator-authority.ts").OperatorCreationSpec;
  /** Captured by the host from the active root Request, never provider input. */
  teamOrigin?: { operatorId: string; requestId: string };
  diff?: import("../operator-authority.ts").PreparedChangeDiff;
  publishedCommit?: string;
  mandate?: { mayReviewExactCandidate: true; mayAdmitReviewedCandidates: true };
  decidedAt?: string;
  /** An explicit local control decision; this does not assert an authenticated identity. */
  authority?: "human" | "builder";
}
