import type { PreparedChangeDiff } from "../../../../src/domain/governance/operator-authority.ts";
import { isTeamOperatorSpec } from "../../../../src/domain/governance/operator-authority.ts";
import type { PendingChange } from "../../../../src/domain/governance/records/pending-change.ts";

/** A change whose exact source diff the host prepared and compiled. */
export type ChangeWithDiff = PendingChange & { diff: PreparedChangeDiff };

/** The diff is host data: a change shows as a diff only when its patch is text. */
export function hasDiff(change: PendingChange): change is ChangeWithDiff {
  return typeof change.diff?.patch === "string";
}

export type ChangeOutcome = "pending" | "accepted" | "declined" | "applied";

export const outcomeLabel: Record<ChangeOutcome, string> = {
  pending: "Pending",
  accepted: "Accepted",
  declined: "Declined",
  applied: "Applied",
};

/**
 * Where a change stands. An approved change with a diff is only "accepted"
 * until the host records the commit that published it; a change without a
 * diff has nothing more to wait for.
 */
export function changeOutcome(change: PendingChange): ChangeOutcome {
  if (change.status === "pending") return "pending";
  if (change.status === "refused") return "declined";
  if (change.operator && isTeamOperatorSpec(change.operator)) {
    return change.publishedCommit ? "applied" : "accepted";
  }
  return change.publishedCommit || !change.diff ? "applied" : "accepted";
}

/** "commit:3f9c2a1b8d…" as the seven characters a person recognises. */
export function shortCommit(version: string | undefined): string {
  const bare = (version ?? "").replace(/^(commit|branch):/, "");
  return /^[0-9a-f]{8,}$/i.test(bare) ? bare.slice(0, 7) : bare;
}

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export interface DiffStats {
  additions: number;
  deletions: number;
  files: number;
}

/**
 * "+n −m · k files" comes from the totals the host computed, never the patch.
 * Any diff the host computed has them: a prepared change's, a source diff.
 */
export function diffStats(
  diff: Pick<PreparedChangeDiff, "files" | "additions" | "deletions">,
): DiffStats {
  return {
    additions: count(diff.additions),
    deletions: count(diff.deletions),
    files: Array.isArray(diff.files) ? diff.files.length : 0,
  };
}

export function filesLabel(files: number): string {
  return `${files} file${files === 1 ? "" : "s"}`;
}

/** The name the roster gives an operator; never its raw identity. */
export function operatorName(
  agents: readonly { nativeId: string; name: string }[] | undefined,
  nativeId: string | undefined,
): string | undefined {
  if (!nativeId) return undefined;
  const name = agents?.find((agent) => agent.nativeId === nativeId)?.name;
  return name?.trim() || undefined;
}
