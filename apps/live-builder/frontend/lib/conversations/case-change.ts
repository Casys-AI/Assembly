import { assertRequestNetworkChange } from "../../../src/domain/governance/records/request-network-change.ts";
import {
  assertRequestTeamChange,
  requestChangeEffect,
} from "../../../src/domain/governance/records/request-change.ts";
import type { PendingChange } from "../../../src/domain/governance/records/pending-change.ts";

/** UI eligibility only: a Case decides its BO's network request or team
 * creation (4.8e E4c). The server still validates current authority and the
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
    if (requestChangeEffect(change) === "team-member") {
      assertRequestTeamChange(change);
    } else assertRequestNetworkChange(change);
    return true;
  } catch {
    return false;
  }
}
