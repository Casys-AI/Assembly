import type { BuildRef } from "../value-objects/element-ref.ts";
import type { ModelFirstParentInterval } from "../records/revision.ts";

/** Read-only analysis identities and findings. None of these facts grants a right. */
export const NETWORK_IMPACT_RULE_VERSION = "ase-network-impact-v1";
type NetworkImpactChannel = "web" | "skill-install";
type NetworkImpactGuardState =
  | "pass"
  | "fail"
  | "conditional"
  | "unknown";
type NetworkImpactPathState = "conditional" | "blocked" | "unknown";

export interface NetworkImpactIssue {
  code: string;
  message: string;
  version?: string;
  recordId?: string;
  sourceId?: string;
}
export interface NetworkImpactWitness {
  role: string;
  elementId: string;
  metaclass?: string;
  qualifiedName?: string;
  path?: string;
  line?: number;
  column?: number;
}
export interface NetworkImpactGuard {
  code: string;
  state: NetworkImpactGuardState;
  explanation: string;
  witnesses: NetworkImpactWitness[];
}
export interface NetworkImpactPath {
  id: string;
  channel: NetworkImpactChannel;
  hostPermission: "allowed" | "denied" | "unknown";
  state: NetworkImpactPathState;
  guards: NetworkImpactGuard[];
  witnesses: NetworkImpactWitness[];
  /** Implemented consumption link, explicitly not a native SysML relationship. */
  consumer: { symbol: string; source: string };
}
export interface NetworkImpactFrame {
  version: string;
  state: "known" | "unknown";
  sourceDigest?: string;
  build?: BuildRef;
  contractDigest?: string;
  operatorId?: string;
  systemQualifiedName?: string;
  paths: NetworkImpactPath[];
  issues: NetworkImpactIssue[];
  /** Call exposures outside the two direct network routes are not silently closed. */
  indirectAccess: "not-covered";
}
interface NetworkImpactPathChange {
  channel: NetworkImpactChannel;
  kind:
    | "permission-revoked"
    | "permission-granted"
    | "route-changed"
    | "unchanged"
    | "indeterminate";
  before?: NetworkImpactPath;
  after?: NetworkImpactPath;
}
export interface NetworkImpactTransition {
  fromVersion: string;
  toVersion: string;
  changes: NetworkImpactPathChange[];
  directAccessAfter: "possible" | "blocked" | "unknown";
  issues: NetworkImpactIssue[];
}

type NetworkImpactEvidenceKind =
  | "network-refused"
  | "page-received"
  | "attempt-unconfirmed"
  | "skill-downloaded"
  | "skill-operation-unattributed"
  | "context-only";
/** Metadata projection only: never include message text, page content or skill instructions. */
export interface NetworkImpactEvidence {
  id: string;
  source: "message" | "event" | "skill-operation";
  sourceIds?: string[];
  kind: NetworkImpactEvidenceKind;
  operatorId?: string;
  modelVersion?: string;
  contractDigest?: string;
  runtimeDigest?: string;
  at?: string;
  systemId?: string;
  snapshotRevision?: number;
  caseId?: string;
  invocationId?: string;
  actionId?: string;
  edgeId?: string;
  toolId?: string;
  behaviorId?: string;
  policyId?: string;
  host?: string;
  code?: string;
  allowedHosts?: string[];
  /** Existing journals do not establish the actual HTTP start instant. */
  startOrder: "unknown";
  issues: NetworkImpactIssue[];
}
export interface NetworkImpactEvidenceRead {
  evidence: NetworkImpactEvidence[];
  complete: boolean;
  snapshotsRead: number;
  recordsRead: number;
  bytesRead: number;
  issues: NetworkImpactIssue[];
  /** Opaque source IDs map to the explicit input positions without disclosing paths. */
  sources?: Array<{
    id: string;
    kind: "state" | "skills";
    inputIndex: number;
    /** Independent owner capture bounds, never a cross-store atomic snapshot. */
    revisionBounds?: { from: number | null; to: number | null };
    complete?: boolean;
  }>;
}
export interface NetworkImpactEvidenceMatch extends NetworkImpactEvidence {
  match: "exact-version" | "contract-only" | "unresolved";
  relatedVersions: string[];
  policyAtRecordedVersion: "allowed" | "denied" | "unknown";
}
export interface NetworkImpactLimits {
  maxVersions: number;
  maxSnapshots: number;
  maxRecords: number;
  maxPayloadBytes: number;
  maxTotalBytes: number;
  timeoutMs: number;
}
/** Technical defaults for this narrow path, not a latency or retention SLA. */
export const DEFAULT_NETWORK_IMPACT_LIMITS: Readonly<NetworkImpactLimits> =
  Object.freeze({
    maxVersions: 32,
    maxSnapshots: 64,
    maxRecords: 10_000,
    maxPayloadBytes: 16 * 1024 * 1024,
    maxTotalBytes: 128 * 1024 * 1024,
    timeoutMs: 30_000,
  });
export const HARD_NETWORK_IMPACT_LIMITS: Readonly<NetworkImpactLimits> = Object
  .freeze({
    maxVersions: 128,
    maxSnapshots: 256,
    maxRecords: 50_000,
    maxPayloadBytes: 16 * 1024 * 1024,
    maxTotalBytes: 256 * 1024 * 1024,
    timeoutMs: 300_000,
  });
export interface NetworkImpactRequest {
  operatorId: string;
  host: string;
  fromVersion: string;
  toVersion: string;
  limits?: Partial<NetworkImpactLimits>;
}
export interface NetworkImpactReport {
  ruleVersion: typeof NETWORK_IMPACT_RULE_VERSION;
  request: Omit<NetworkImpactRequest, "limits">;
  limits: NetworkImpactLimits;
  lineage: ModelFirstParentInterval;
  frames: NetworkImpactFrame[];
  transitions: NetworkImpactTransition[];
  evidence: NetworkImpactEvidenceMatch[];
  evidenceRead: Omit<NetworkImpactEvidenceRead, "evidence">;
  coverage: {
    calculationComplete: boolean;
    versionsComplete: boolean;
    modelReadComplete: boolean;
    recordsReadComplete: boolean;
    /** HTTP hops, pre-commit failures and actual start instants are not exhaustive. */
    networkObservationComplete: false;
    indirectAccess: "not-covered";
  };
  issues: NetworkImpactIssue[];
}

export function networkImpactPathState(
  guards: readonly NetworkImpactGuard[],
): NetworkImpactPathState {
  if (guards.some((guard) => guard.state === "fail")) return "blocked";
  if (!guards.length || guards.some((guard) => guard.state === "unknown")) {
    return "unknown";
  }
  return "conditional";
}
