/** Governed memory identity, content and recorded operation history. */
import type { BehaviorModelVersion } from "../../shared-kernel/behavior-model-version.ts";

export type MemoryStatus =
  | "candidate"
  | "revision-requested"
  | "admitted"
  | "rejected"
  | "withdrawn";

export type MemoryOperation =
  | "capture"
  | "revise"
  | "admit"
  | "request-revision"
  | "reject"
  | "withdraw";

export interface MemoryContent {
  text: string;
  origin: {
    decisionId: string;
    sourceRefs: string[];
  };
  scope: string[];
  validUntil: string;
  outcome:
    | { status: "pending" }
    | { status: "known"; summary: string; evidenceRefs: string[] };
}

export interface MemoryOperationEvent {
  operation: MemoryOperation;
  callerId: string;
  behaviorId: string;
  invocationId: string;
  modelVersion: BehaviorModelVersion;
  policyId: string;
  requestDigest: string;
  at: string;
  reason?: string;
  revision: number;
  digest: string;
  status: MemoryStatus;
  /** Immutable content of this version; admission never rewrites an observation. */
  content: MemoryContent;
}

export interface MemoryRecord {
  id: string;
  ownerId: string;
  contributorId: string;
  revision: number;
  digest: string;
  content: MemoryContent;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
  history: MemoryOperationEvent[];
}
