import { useEffect } from "preact/hooks";
import type { PendingChange } from "../../../src/domain/governance/records/pending-change.ts";
import { decisionState } from "../../lib/conversations/decision-state.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";

/**
 * Where a change stands for the person. A change decided in a Request is read
 * in its application record there (`record`: that Request and the agent that
 * holds the change), and read again when the session, the host or the system
 * changes; any other change stands as it records.
 */
export function useChangeDecision(
  state: WorkbenchState,
  change: PendingChange,
  record?: { caseId: string; agentId: string },
) {
  const read = record &&
      (change.status === "approved" || change.status === "refused")
    ? record
    : undefined;
  const sessionGeneration = state.requests.sessionGeneration.value;
  const sessionReady = state.requests.sessionReady.value;
  const host = JSON.stringify(state.requests.context.value);
  const systemId = state.current.value?.id;
  useEffect(() => {
    if (read && sessionReady) {
      void state.loadCaseChangeStatus(read.caseId, read.agentId, change.id);
    }
  }, [
    state,
    read?.caseId,
    read?.agentId,
    change.id,
    sessionGeneration,
    sessionReady,
    host,
    systemId,
  ]);
  const observed = read
    ? state.caseChangeStatus(read.caseId, read.agentId, change.id)
    : undefined;
  return {
    decision: decisionState(
      change,
      read ? observed?.status ?? "unread" : undefined,
    ),
    observed,
    error: read
      ? state.caseChangeError(read.caseId, read.agentId, change.id)
      : "",
  };
}
