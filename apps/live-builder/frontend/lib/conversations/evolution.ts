import type { Message } from "../../../src/domain/work/dialogue.ts";
import type { EvolutionConversationRecord } from "../../../src/domain/work/records/operator-evolution.ts";
import type { AgentConversation } from "../../../src/domain/work/records/conversations.ts";
import { isRecord } from "../transport/is-record.ts";
import { sameSourceVersion, type SourceDiff } from "../model/revisions/api.ts";

export type { EvolutionConversationRecord };
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const actor = (value: unknown) =>
  isRecord(value) && text(value.operatorId) &&
  (value.name === null || typeof value.name === "string");
const pin = (value: unknown) =>
  isRecord(value) && text(value.version) && text(value.sourceDigest);
export const evolutionStatus: Record<
  EvolutionConversationRecord["status"],
  string
> = {
  prepared: "Prepared",
  accepted: "Accepted",
  armed: "Waiting for safe checkpoint",
  publishing: "Publishing",
  "published-awaiting-adoption": "Published · not active",
  adopted: "Adopted",
  cancelled: "Cancelled",
  superseded: "Superseded",
  refused: "Refused",
  "needs-decision": "Decision required",
};

/** Decode host records only; never infer an evolution from tool-result prose. */
export function readEvolutionRecord(
  value: unknown,
): EvolutionConversationRecord | undefined {
  if (
    !isRecord(value) || !text(value.dossierId) || !text(value.proposalId) ||
    !text(value.proposalDigest) ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    typeof value.status !== "string" ||
    !Object.hasOwn(evolutionStatus, value.status) ||
    !text(value.createdAt) || !text(value.updatedAt) ||
    typeof value.reason !== "string" || !isRecord(value.origin) ||
    !text(value.origin.operatorId) ||
    (text(value.origin.requestId) === text(value.origin.designerScopeId)) ||
    (value.origin.requestId !== undefined && !text(value.origin.requestId)) ||
    (value.origin.designerScopeId !== undefined &&
      !text(value.origin.designerScopeId)) ||
    !actor(value.preparer) || !actor(value.finalizer) || !pin(value.base) ||
    !pin(value.candidate) || !text(value.recipeDigest) ||
    !Array.isArray(value.categories) || !value.categories.length ||
    value.categories.some((category) =>
      !["flow", "instructions", "budgets", "context", "memory", "contracts"]
        .includes(category)
    ) ||
    !Array.isArray(value.targets) || !value.targets.length ||
    value.targets.some((target) =>
      !actor(target) || !text(target.previousDigest) ||
      !text(target.candidateDigest)
    ) ||
    !Array.isArray(value.blockers) ||
    value.blockers.some((blocker) =>
      !isRecord(blocker) || !text(blocker.code) ||
      typeof blocker.detail !== "string" ||
      (blocker.operatorId !== undefined && !text(blocker.operatorId))
    ) ||
    !Array.isArray(value.adoptions) ||
    value.adoptions.some((receipt) =>
      !isRecord(receipt) ||
      ![
        "operatorId",
        "previousDigest",
        "candidateDigest",
        "version",
        "proposalDigest",
        "effectiveAt",
      ].every((key) => text(receipt[key]))
    ) ||
    (value.publication !== undefined &&
      (!pin(value.publication) || !isRecord(value.publication) ||
        !text(value.publication.proposalDigest)))
  ) return undefined;
  return value as unknown as EvolutionConversationRecord;
}
export function messageEvolution(
  message: Message,
): EvolutionConversationRecord | undefined {
  return message.observation?.kind === "operator-evolution"
    ? readEvolutionRecord(message.observation.value)
    : undefined;
}

/** Live records may enrich only the exact captured proposal, never history. */
export function evolutionForMessage(
  record: EvolutionConversationRecord,
  live: readonly EvolutionConversationRecord[],
  historical: boolean,
): EvolutionConversationRecord {
  if (historical) return record;
  return currentEvolutionRecord(record, live) ?? record;
}
export function currentEvolutionRecord(
  record: EvolutionConversationRecord,
  live: readonly EvolutionConversationRecord[],
): EvolutionConversationRecord | undefined {
  const matches = live.filter((entry) =>
    entry.dossierId === record.dossierId &&
    entry.proposalId === record.proposalId &&
    entry.proposalDigest === record.proposalDigest &&
    entry.base.version === record.base.version &&
    entry.base.sourceDigest === record.base.sourceDigest &&
    entry.candidate.version === record.candidate.version &&
    entry.candidate.sourceDigest === record.candidate.sourceDigest &&
    entry.recipeDigest === record.recipeDigest &&
    entry.origin.operatorId === record.origin.operatorId &&
    entry.origin.requestId === record.origin.requestId &&
    entry.origin.designerScopeId === record.origin.designerScopeId &&
    entry.revision >= record.revision
  );
  return matches.length === 1 ? matches[0]! : undefined;
}
export function exactEvolutionDiff(
  record: EvolutionConversationRecord,
  diff: SourceDiff,
): boolean {
  return sameSourceVersion(diff.fromVersion, record.base.version) &&
    sameSourceVersion(diff.toVersion, record.candidate.version) &&
    diff.fromSourceDigest === record.base.sourceDigest &&
    diff.toSourceDigest === record.candidate.sourceDigest &&
    typeof diff.patch === "string";
}
export type EvolutionRequest = "acceptance" | "activation" | "cancellation";
export function evolutionRequests(
  record: EvolutionConversationRecord,
): EvolutionRequest[] {
  if (record.status === "prepared" || record.status === "needs-decision") {
    return ["acceptance", "cancellation"];
  }
  if (record.status === "accepted") return ["activation", "cancellation"];
  if (record.status === "armed") return ["cancellation"];
  return [];
}
export function evolutionRequestText(
  record: EvolutionConversationRecord,
  action: EvolutionRequest,
): string {
  const act = action === "acceptance"
    ? "accept"
    : action === "activation"
    ? "authorize activation of"
    : "cancel";
  return `Please review and ${act} evolution ${record.dossierId}, dossier revision ${record.revision}, proposal ${record.proposalId} (${record.proposalDigest}), from ${record.base.version} to ${record.candidate.version}. Use only your existing authority and report the resulting dossier state.`;
}
/** Addressing this existing thread is a message capability, never decision power. */
export function evolutionThreadMatches(
  record: EvolutionConversationRecord,
  conversation: AgentConversation | null | undefined,
  scope: { caseId?: string; designerScopeId?: string },
): boolean {
  return evolutionOriginMatches(record, conversation?.nativeId, scope);
}
export function evolutionOriginMatches(
  record: EvolutionConversationRecord,
  operatorId: string | undefined,
  scope: { caseId?: string; designerScopeId?: string },
): boolean {
  return operatorId === record.origin.operatorId &&
    (record.origin.requestId
      ? scope.caseId === record.origin.requestId
      : scope.designerScopeId === record.origin.designerScopeId);
}
