import type { SpaceControlAct } from "../../governance/policies/space-execution-policy.ts";
import type {
  OwnerAuthority,
  ScopedOperatorRef,
} from "../../governance/authority.ts";
import type { RequestSpaceScope } from "./scope.ts";

/** Host-captured provenance of an opening by the Main Operator (4.8d D3):
 * the registered Main and the turn that opened. Never a public DTO field. */
export interface MainOpener {
  operator: ScopedOperatorRef;
  origin: {
    conversationId: string;
    designerScopeId: string;
    messageId?: string;
    /** The Main Operator's stable identity for this opening. */
    openingId: string;
  };
}
/** Host-owned binding to the native system in its currently admitted source.
 * The operational system instance ID and SysML native system ID are distinct. */
export interface SpaceControlSourceBinding {
  scope: RequestSpaceScope;
  sourceSystemNativeId: string;
}
/** Transient issuance precondition, not effective authority and never a browser DTO. */
export interface SpaceControlAdoptedState extends RequestSpaceScope {
  executionSpaceId: "main";
  operatorId: string;
  stateId: string;
  revision: number;
}
/** Verified from the current control source, never reconstructed from a Release. */
export interface SpaceControlAuthority extends SpaceControlSourceBinding {
  /** Exact admission-source evidence, independent of the effective policy identity. */
  sourceVersion: string;
  modelDigest: string;
  owner: OwnerAuthority;
  /** Stable source policy identity, never a display label. */
  policyId: string;
  policyRevision: number;
  operatorIds: string[];
  acts: SpaceControlAct[];
}
/** Returned only by server-side credential verification. It is never a command DTO. */
export interface SpaceController {
  kind?: "session";
  ownerId: string;
  capabilityId: string;
  capabilityRevision: number;
  sessionId: string;
  authority: SpaceControlAuthority;
}
/** Host-internal controller of a Main Operator opening (4.8d D3, 4.8c A1): a
 * capability issued by local composition, its secret discarded, no session.
 * Person-facing ports accept only `SpaceController`. */
export interface HostSpaceController {
  kind: "host";
  ownerId: string;
  capabilityId: string;
  capabilityRevision: number;
  authority: SpaceControlAuthority;
  opener: ScopedOperatorRef;
}
/** What the opening phases and their admission accept. */
export type SpaceControlPrincipal = SpaceController | HostSpaceController;
export interface SpacePermissions {
  operatorIds: string[];
  acts: ["conversation"];
  sourceVersion: string;
  modelDigests: string[];
  resourceIds: string[];
}
export interface SpaceExecutionAdmission {
  id: string;
  scope: RequestSpaceScope;
  executionSpaceId: string;
  openingId: string;
  ownerId: string;
  capabilityId: string;
  capabilityRevision: number;
  baseDigest: string;
  authority: SpaceControlAuthority;
  permissions: SpacePermissions;
  revision: number;
  status: "active" | "revoked";
  expiresAt: string;
  createdAt: string;
}
