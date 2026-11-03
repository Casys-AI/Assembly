import { matchesExactRevision } from "../../shared-kernel/revision-id.ts";
import { canonical } from "../../primitives/canonical-json.ts";
import { canonicalDigest } from "../../primitives/execution-digest.ts";
import {
  MAX_NETWORK_HOST_ADDITIONS,
  validateNetworkScope,
} from "../policies/network-policy.ts";
import { OperatorAuthorityError } from "../operator-authority.ts";
import type { PendingChange } from "./pending-change.ts";

type RequestNetworkChange = PendingChange & {
  kind: "mandate-change";
  caseId: string;
  requestedBy: string;
  baseModelDigest: string;
  requestedRights: { addNetworkHosts: string[] };
};
/** A Case request for one bounded addition, never a general mandate change. */
const allowedChangeFields = new Set([
  "id",
  "kind",
  "status",
  "requestedBy",
  "caseId",
  "baseRevision",
  "baseModelDigest",
  "reason",
  "requestedAt",
  "requestedRights",
  "diff",
  "publishedCommit",
  "decidedAt",
  "authority",
  "authorityExercise",
]);
const exactKeys = (value: object, names: readonly string[]) =>
  Object.keys(value).sort().join(",") === [...names].sort().join(",");
export function assertRequestNetworkChange(
  change: PendingChange,
): asserts change is RequestNetworkChange {
  const text = (v: unknown): v is string =>
    typeof v === "string" && v.trim() === v && v.length > 0 &&
    // Exact change identifiers intentionally reject control characters.
    // deno-lint-ignore no-control-regex
    v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v);
  if (
    Object.keys(change).some((key) => !allowedChangeFields.has(key)) ||
    !["pending", "approved", "refused", "superseded"].includes(change.status) ||
    change.kind !== "mandate-change" || !text(change.id) ||
    !text(change.caseId) || !text(change.requestedBy) ||
    change.designerScopeId !== undefined ||
    !/^[a-f0-9]{64}$/.test(change.baseModelDigest ?? "") ||
    !Number.isSafeInteger(change.baseRevision) || change.baseRevision < 0 ||
    !change.reason?.trim() ||
    !Number.isFinite(Date.parse(change.requestedAt)) ||
    !change.requestedRights ||
    Object.keys(change.requestedRights).join(",") !== "addNetworkHosts" ||
    !("addNetworkHosts" in change.requestedRights) ||
    [
      change.name,
      change.role,
      change.operator,
      change.teamOrigin,
      change.mandate,
    ].some((v) => v !== undefined)
  ) {
    throw new OperatorAuthorityError(
      "INVALID_OPERATOR_REQUEST",
      "An exact Case network addition is required",
      { changeId: change.id },
    );
  }
  try {
    const hosts = validateNetworkScope({
      allowedHosts: change.requestedRights.addNetworkHosts,
    }).allowedHosts;
    if (
      !hosts.length || hosts.length > MAX_NETWORK_HOST_ADDITIONS ||
      canonical(hosts) !== canonical(change.requestedRights.addNetworkHosts)
    ) throw new Error("An exact bounded host addition is required");
  } catch (error) {
    throw new OperatorAuthorityError(
      "INVALID_OPERATOR_REQUEST",
      error instanceof Error ? error.message : "Invalid bounded host addition",
      { changeId: change.id },
    );
  }
}
/** Who may decide a Case network addition for adoption: the person, or the
 * Main Operator under its delegated mandate (4.8c C9), whose receipt the
 * decision record and the write dossier gate verified. */
export function decidedByNetworkAuthority(change: PendingChange): boolean {
  return change.authority === "human" ||
    change.authority === "builder" && !!change.authorityExercise?.delegation;
}
/** The exact compiled preview every Request change proposal digest binds. */
export function exactChangeDiff(change: PendingChange): boolean {
  return !!change.diff &&
    exactKeys(change.diff, [
      "title",
      "author",
      "base",
      "sourceDigest",
      "files",
      "patch",
      "additions",
      "deletions",
    ]) &&
    exactKeys(change.diff.base, [
      "repositoryVersion",
      "modelDigest",
      "sourceDigest",
    ]) && Array.isArray(change.diff.files) &&
    !change.diff.files.some((file) =>
      !exactKeys(file, ["path", "kind", "additions", "deletions"])
    ) && change.diff.base.modelDigest === change.baseModelDigest &&
    matchesExactRevision(change.diff.base.repositoryVersion) &&
    /^[a-f0-9]{64}$/.test(change.diff.sourceDigest) &&
    /^[a-f0-9]{64}$/.test(change.diff.base.sourceDigest);
}
/** The proposal's immutable meaning. Decision/publication fields are checked separately. */
export async function requestNetworkProposalDigest(
  input: PendingChange,
): Promise<string> {
  const change = structuredClone(input);
  assertRequestNetworkChange(change);
  if (!exactChangeDiff(change)) {
    throw new OperatorAuthorityError(
      "CHANGE_PREVIEW_MISMATCH",
      "The exact compiled network proposal preview is required",
      { changeId: change.id },
    );
  }
  return await canonicalDigest({
    format: "request-network-proposal/v1",
    id: change.id,
    kind: change.kind,
    caseId: change.caseId,
    requestedBy: change.requestedBy,
    baseRevision: change.baseRevision,
    baseModelDigest: change.baseModelDigest,
    requestedRights: change.requestedRights,
    reason: change.reason,
    requestedAt: change.requestedAt,
    diff: change.diff,
  });
}
