/** Change proposals against the admitted configuration. */
import type { AuthorityExercise } from "../authority.ts";
import type { ExecutableModel } from "../../model/execution/executable-model.ts";

export type MandateRequestedRights =
  | {
    operatorCreation:
      import("../policies/operator-creation-policy.ts").OperatorCreationPolicyRequest;
  }
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

export interface SupportedMandateChange {
  kind: "propose_mandate_change";
  requestedRights:
    | "operatorCreation"
    | "toolAdmission"
    | "operatorAuthority"
    | "grantModelEditing"
    | "mayAdmitOwnCandidates"
    | "addNetworkHosts"
    | "setUrlSelectionMode";
  description: string;
}

/** A change proposal as the domain judges it: stored-form rights, any
 * recipient Case already resolved to its space by the host. `text` is the
 * operator's message, kept so the conversational decision carries the same
 * variants; no domain rule reads it. */
export type ChangeProposal =
  | {
    kind: "propose_mandate_change";
    text: string;
    reason: string;
    requestedRights: MandateRequestedRights;
  }
  | {
    kind: "propose_agent_creation";
    text: string;
    name: string;
    reason: string;
    role: "reviewer";
    mandate: {
      mayReviewExactCandidate: true;
      mayAdmitReviewedCandidates: true;
    };
  }
  | {
    kind: "propose_agent_creation";
    text: string;
    name: string;
    reason: string;
    role: "operator";
    operator: import("../operator-authority.ts").OperatorCreationSpec;
  };

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
