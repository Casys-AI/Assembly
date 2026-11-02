import type { EvolutionAuthorityExercise } from "../evolution/policy.ts";
import type { ModelProposalAuthorization } from "../../governance/records/model-edit-authorization.ts";
/** Stored model revisions, their history, and proposals for source admission. */
import type { CompiledModel } from "./compiled-model.ts";
import type { AuthorityExercise } from "../../governance/authority.ts";
import type { ModelSources } from "../value-objects/sources.ts";

/** Source identity from the immutable tree; does not validate compiler output. */
export interface ModelRevisionHeader {
  version: string;
  sources: ModelSources;
  sourceDigest: string;
}

export interface ModelRevision extends CompiledModel {
  version: string;
}
export interface ModelCommit {
  version: string;
  /** The actual first parent, only when it also contains an Assembly source tree. */
  parentVersion?: string;
  /** Raw engine parents, including the schema-only root before source import. */
  parents: string[];
  author: string;
  message: string;
  createdAt: string;
  sourceDigest: string;
  parsedAuthor: ModelCommitAuthor;
  files: ModelChangedFile[];
  additions: number;
  deletions: number;
  proposalId?: string;
}
export interface ModelHistory {
  headVersion: string;
  commits: ModelCommit[];
  truncated: boolean;
}
/** A bounded, explicit first-parent interval. Branch parents remain provenance;
 * an incomplete interval must never be presented as an endpoint comparison. */
export interface ModelFirstParentInterval {
  fromVersion: string;
  toVersion: string;
  versions: Array<{ version: string; parents: string[] }>;
  complete: boolean;
  reason?: "version-limit" | "from-not-on-first-parent";
}
export interface SourceChange {
  path: string;
  kind: "added" | "changed" | "deleted";
  before?: string;
  after?: string;
}
export interface ProposalRecord {
  id: string;
  /** Mutable proposal workspace; version fields identify stored revisions. */
  branch: string;
  author: string;
  authorization?: ModelProposalAuthorization;
  reason: string;
  addresses?:
    import("../value-objects/diagnostic-address.ts").ModelDiagnosticAddress[];
  baseVersion: string;
  createdAt: string;
  status: "preparing" | "proposed" | "accepting" | "accepted" | "rejected";
  validation: "validated";
  sourceDigest: string;
  proposalVersion?: string;
  targetVersion?: string;
  targetSourceDigest?: string;
  acceptanceBaseVersion?: string;
  acceptedVersion?: string;
  decidedBy?: string;
  decidedAt?: string;
  /** Admission/refusal authority from the source state preceding the decision. */
  decisionAuthorityExercise?: AuthorityExercise;
  evolutionDecision?: EvolutionAuthorityExercise;
  rejectionReason?: string;
  diff: SourceChange[];
}

/** Display identity only; raw author remains authoritative for attribution. */
export interface ModelCommitAuthor {
  kind: "owner" | "agent" | "ase" | "host" | "unknown";
  ref: string;
}
export function parseModelAuthor(raw: string): ModelCommitAuthor {
  if (raw === "local-owner") return { kind: "owner", ref: raw };
  if (raw === "local-control") return { kind: "host", ref: raw };
  if (raw === "ase") return { kind: "ase", ref: raw };
  if (raw.startsWith("agent:") && raw.slice(6) && !/[\s:]/.test(raw.slice(6))) {
    return { kind: "agent", ref: raw.slice(6) };
  }
  const ref = raw.slice(4);
  if (
    raw.startsWith("ase:") && (ref === "provision-instance-id" ||
      /^(approved-change|activate-candidate|record-candidate|record-stage-observation):[^\s:]+$/
        .test(ref))
  ) {
    return { kind: "ase", ref };
  }
  return { kind: "unknown", ref: raw };
}
export interface ModelChangedFile {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
}
export interface ModelFileLastChange {
  path: string;
  lastChange: { version: string; createdAt: string; message: string };
}
