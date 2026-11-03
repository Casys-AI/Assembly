import {
  HARD_NETWORK_IMPACT_LIMITS,
  type NetworkImpactIssue,
} from "../../../domain/model/consultation/network-impact.ts";

/** Host-supplied budgets, applied before a persisted payload is materialized. */
export interface BoundedNetworkImpactEvidenceInput {
  maxSnapshots: number;
  maxPayloadBytes: number;
  maxTotalBytes: number;
  signal?: AbortSignal;
}

/** One source is captured through its existing serialized owner handle. The
 * revision bounds describe that source alone, never a cross-store snapshot. */
export interface BoundedNetworkImpactEvidenceRead {
  snapshots: Array<{ revision: number; payload: string }>;
  complete: boolean;
  snapshotsRead: number;
  bytesRead: number;
  revisionBounds: { from: number | null; to: number | null };
  issues: NetworkImpactIssue[];
}

export interface NetworkImpactStateEvidenceSource {
  readNetworkImpactEvidence(
    input: BoundedNetworkImpactEvidenceInput,
  ): Promise<BoundedNetworkImpactEvidenceRead>;
}

export interface NetworkImpactSkillsEvidenceSource {
  readNetworkImpactEvidence(
    input: BoundedNetworkImpactEvidenceInput & { ownerId: string },
  ): Promise<BoundedNetworkImpactEvidenceRead>;
}

export function assertNetworkImpactEvidenceBudget(
  input: BoundedNetworkImpactEvidenceInput,
): void {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid network impact evidence budget");
  }
  for (
    const key of ["maxSnapshots", "maxPayloadBytes", "maxTotalBytes"] as const
  ) {
    if (
      !Number.isSafeInteger(input[key]) || input[key] < 1 ||
      input[key] > HARD_NETWORK_IMPACT_LIMITS[key]
    ) throw new Error(`Invalid network impact evidence budget: ${key}`);
  }
}

export function emptyNetworkImpactEvidenceRead(): BoundedNetworkImpactEvidenceRead {
  return {
    snapshots: [],
    complete: true,
    snapshotsRead: 0,
    bytesRead: 0,
    revisionBounds: { from: null, to: null },
    issues: [],
  };
}
