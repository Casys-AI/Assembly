/**
 * APE 5.1 Context Separation: bounded representation policy and evidence references;
 * this policy grants no authority.
 */
export interface DecisionContextPolicy {
  kind: "separated-context";
  pattern: "5.1";
  recentMessages: number;
  maxMessageCharacters: number;
  maxCollectionItems: number;
  /** JSON characters, never a claim about provider tokens or monetary cost. */
  maxContextCharacters: number;
}

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

/** Reject malformed policies rather than silently changing their meaning. */
export function validateContextPolicy(value: unknown): DecisionContextPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The native context policy must be an object.");
  }
  const policy = value as Record<string, unknown>;
  const keys = [
    "kind",
    "pattern",
    "recentMessages",
    "maxMessageCharacters",
    "maxCollectionItems",
    "maxContextCharacters",
  ];
  if (
    Object.keys(policy).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(policy, key)) ||
    policy.kind !== "separated-context" || policy.pattern !== "5.1"
  ) throw new Error("Unsupported native context policy.");
  for (
    const [key, minimum, maximum] of [
      ["recentMessages", 1, 100],
      ["maxMessageCharacters", 256, 100000],
      ["maxCollectionItems", 1, 128],
      ["maxContextCharacters", 4096, 2000000],
    ] as const
  ) {
    const setting = policy[key];
    if (
      typeof setting !== "number" || !Number.isSafeInteger(setting) ||
      setting < minimum || setting > maximum
    ) throw new Error(`Invalid native context policy value: ${key}.`);
  }
  return structuredClone(policy) as unknown as DecisionContextPolicy;
}
