import { canonical } from "../../primitives/canonical-json.ts";
import { canonicalDigest } from "../../primitives/execution-digest.ts";
import {
  isTeamOperatorSpec,
  type TeamOperatorSpec,
  validateOperatorCreationSpec,
} from "../operator-authority.ts";
import type { PendingChange } from "./pending-change.ts";
import {
  exactChangeDiff,
  requestNetworkProposalDigest,
} from "./request-network-change.ts";

/**
 * The effect a Request (Case branch) change decision publishes (spec 4.8e
 * E4). It is derived from the change, never stored on it: the network
 * change's closed field list stays untouched, and a persisted discriminant
 * could disagree with the change it labels.
 */
export type RequestChangeEffect = "network" | "team-member";

export function requestChangeEffect(
  change: PendingChange,
): RequestChangeEffect | undefined {
  if (
    change.kind === "mandate-change" && change.requestedRights &&
    "addNetworkHosts" in change.requestedRights
  ) return "network";
  if (
    change.kind === "operator-creation" && change.operator &&
    isTeamOperatorSpec(change.operator) && change.caseId &&
    change.teamOrigin?.requestId === change.caseId
  ) return "team-member";
  return undefined;
}

/** A recorded creation owns its reserved slot until its continuation resumes. */
export function unresumedTeamCreation(
  change: PendingChange,
  continuation: "pending" | "feedback-sent" | "resumed" | undefined,
): boolean {
  return change.status === "approved" &&
    requestChangeEffect(change) === "team-member" &&
    (continuation === undefined || pendingChangeContinuation(continuation));
}

export function pendingChangeContinuation(
  continuation: "pending" | "feedback-sent" | "resumed" | undefined,
): boolean {
  return continuation === "pending" || continuation === "feedback-sent";
}

export type RequestTeamChange = PendingChange & {
  kind: "operator-creation";
  caseId: string;
  requestedBy: string;
  baseModelDigest: string;
  name: string;
  operator: TeamOperatorSpec;
  teamOrigin: { operatorId: string; requestId: string };
};
/** A Case request for exactly one durable teammate of its own Request,
 * closed like the network change: no stored rights, no designer scope. */
const allowedTeamChangeFields = new Set([
  "id",
  "kind",
  "status",
  "requestedBy",
  "caseId",
  "baseRevision",
  "baseModelDigest",
  "reason",
  "requestedAt",
  "name",
  "role",
  "operator",
  "teamOrigin",
  "diff",
  "publishedCommit",
  "decidedAt",
  "authority",
  "authorityExercise",
]);
export function assertRequestTeamChange(
  change: PendingChange,
): asserts change is RequestTeamChange {
  const text = (v: unknown): v is string =>
    typeof v === "string" && v.trim() === v && v.length > 0 &&
    // Exact change identifiers intentionally reject control characters.
    // deno-lint-ignore no-control-regex
    v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v);
  let spec: ReturnType<typeof validateOperatorCreationSpec> | undefined;
  try {
    spec = change.operator
      ? validateOperatorCreationSpec(change.operator)
      : undefined;
  } catch {
    spec = undefined;
  }
  if (
    Object.keys(change).some((key) => !allowedTeamChangeFields.has(key)) ||
    !["pending", "approved", "refused", "superseded"].includes(change.status) ||
    change.kind !== "operator-creation" || !text(change.id) ||
    !text(change.caseId) || !text(change.requestedBy) ||
    change.designerScopeId !== undefined ||
    !/^[a-f0-9]{64}$/.test(change.baseModelDigest ?? "") ||
    !Number.isSafeInteger(change.baseRevision) || change.baseRevision < 0 ||
    !change.reason?.trim() ||
    !Number.isFinite(Date.parse(change.requestedAt)) ||
    !text(change.name) || change.role !== "operator" ||
    !spec || !isTeamOperatorSpec(spec) ||
    canonical(spec) !== canonical(change.operator) ||
    !change.teamOrigin || !text(change.teamOrigin.operatorId) ||
    change.teamOrigin.requestId !== change.caseId ||
    [change.requestedRights, change.mandate].some((v) => v !== undefined)
  ) throw new Error("An exact Case team creation is required");
}

/** Who may decide a Case team creation for adoption: the person, or the
 * creator itself under its branch-read `autonomous` grant (E1), whose
 * receipt the decision record and the write dossier gate verified. */
export function decidedByTeamAuthority(change: PendingChange): boolean {
  return change.authority === "human" ||
    change.authority === "builder" &&
      !!change.authorityExercise?.creationDelegation;
}

/** The team proposal's immutable meaning, provision included. */
export async function requestTeamProposalDigest(
  input: PendingChange,
): Promise<string> {
  const change = structuredClone(input);
  assertRequestTeamChange(change);
  if (!exactChangeDiff(change)) {
    throw new Error("The exact compiled team proposal preview is required");
  }
  return await canonicalDigest({
    format: "request-team-proposal/v1",
    id: change.id,
    kind: change.kind,
    caseId: change.caseId,
    requestedBy: change.requestedBy,
    baseRevision: change.baseRevision,
    baseModelDigest: change.baseModelDigest,
    name: change.name,
    operator: change.operator,
    teamOrigin: change.teamOrigin,
    reason: change.reason,
    requestedAt: change.requestedAt,
    diff: change.diff,
  });
}

/** One digest entry for every Request change effect; the network format is
 * delegated untouched so recorded network decisions keep their bytes. */
export async function requestChangeProposalDigest(
  change: PendingChange,
): Promise<string> {
  return requestChangeEffect(change) === "team-member"
    ? await requestTeamProposalDigest(change)
    : await requestNetworkProposalDigest(change);
}
