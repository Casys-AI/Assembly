import type { EvolutionCategory } from "../../model/evolution/policy.ts";

/** Host-recorded dossier metadata. This read model grants no decision authority. */
export interface EvolutionConversationRecord {
  dossierId: string;
  revision: number;
  status:
    | "prepared"
    | "accepted"
    | "armed"
    | "publishing"
    | "published-awaiting-adoption"
    | "adopted"
    | "cancelled"
    | "superseded"
    | "refused"
    | "needs-decision";
  proposalId: string;
  proposalDigest: string;
  createdAt: string;
  updatedAt: string;
  reason: string;
  origin: { operatorId: string; requestId?: string; designerScopeId?: string };
  preparer: { operatorId: string; name: string | null };
  finalizer: { operatorId: string; name: string | null };
  categories: EvolutionCategory[];
  targets: {
    operatorId: string;
    name: string | null;
    previousDigest: string;
    candidateDigest: string;
  }[];
  base: { version: string; sourceDigest: string };
  candidate: { version: string; sourceDigest: string };
  recipeDigest: string;
  publication?: {
    version: string;
    sourceDigest: string;
    proposalDigest: string;
  };
  adoptions: {
    operatorId: string;
    previousDigest: string;
    candidateDigest: string;
    version: string;
    proposalDigest: string;
    effectiveAt: string;
  }[];
  blockers: { code: string; operatorId?: string; detail: string }[];
}

export interface EvolutionConversationsSnapshot {
  /** Changes independently of the conversation's command CAS revision. */
  version: string;
  /** At most 64 records; no source bytes or another Case's conversation. */
  items: EvolutionConversationRecord[];
  truncated: boolean;
  /** Current details could not be verified; immutable historical receipts remain valid. */
  error?: string;
}
