import {
  assertRequestChange,
} from "../../../src/domain/governance/records/request-change.ts";
import type { PendingChange } from "../../../src/domain/governance/records/pending-change.ts";

/** UI eligibility only: a Case decides its BO's supported branch change.
 * The server still validates current authority and the
 * exact preview. */
export function isCaseChangeDecision(
  change: PendingChange,
  caseId: string | undefined,
  agentId: string,
): boolean {
  if (
    !caseId || change.caseId !== caseId || change.requestedBy !== agentId ||
    !change.diff
  ) return false;
  try {
    assertRequestChange(change);
    return true;
  } catch {
    return false;
  }
}
