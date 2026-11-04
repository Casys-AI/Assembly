import type { DecisionContextPolicy } from "../../../domain/work/policies/context-separation.ts";

/** Host-recorded result data, distinct from both instructions and current state. */
export interface MessageObservation {
  /** Exact evidence/model observations are host-issued after native admission. */
  kind:
    | "behavior-result"
    | "tool-result"
    | "tool-failure"
    | "watch-notification"
    | "context-evidence"
    | "candidate-inspection"
    | "model-context"
    | "operator-evolution";
  value: unknown;
}

export type ContextOmissionReason =
  | "history"
  | "representation-limit"
  | "provenance"
  | "legacy-encoding";

/** Resolved only against the caller's journal, never a peer's conversation. */
export interface ContextEvidenceReference {
  kind: "journal-message";
  messageId: string;
  /** SHA-256 of the complete canonical durable message, including its evidence. */
  messageDigest: string;
  role: "user" | "assistant" | "tool";
  at: string;
  reasons: ContextOmissionReason[];
  /** Top-level text was shortened or replaced in this decision projection. */
  textOmitted?: true;
  execution?: {
    digest: string;
    repositoryVersion?: string;
    actionId?: string;
    edgeId?: string;
  };
  sourceIdCount?: number;
}

export interface DecisionContextEvidence {
  pattern: "5.1";
  policy: DecisionContextPolicy;
  modelVersion?: { digest: string; repositoryVersion?: string };
  admittedModelVersion?: { digest: string; repositoryVersion?: string };
  currentRequestMessageId?: string;
  journalMessageCount: number;
  projectedMessageCount: number;
  /** JSON characters in the complete/projected message arrays, never tokens. */
  originalMessageCharacters: number;
  projectedMessageCharacters: number;
  references: ContextEvidenceReference[];
  /** Explicit historical decoding; these values are never current authority. */
  legacyMessageIds: string[];
}
