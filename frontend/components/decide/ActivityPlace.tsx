import type { WorkbenchState } from "../../lib/workbench/state.ts";
import { ActivityPage } from "./ActivityPage.tsx";
import { useActivityHistory } from "./useActivityHistory.ts";

/** System-wide activity, independent of the selected Model or Request context. */
export function ActivityPlace(
  { state, started }: { state: WorkbenchState; started: boolean },
) {
  const history = useActivityHistory(state);
  const requests = state.requests;
  const open = requests.cases.open.value;
  const requestError = !requests.sessionReady.value
    ? "Connect to the system to read all pending decisions."
    : requests.cases.error.value ||
      (open.some((record) => requests.readErrors.value.get(record.id))
        ? "Some Request decisions could not be read."
        : "");
  const unread = open.some((record) =>
    !requests.snapshots.value.has(record.id)
  );
  return (
    <ActivityPage
      key={JSON.stringify([
        state.current.value?.id,
        requests.context.value,
        requests.sessionGeneration.value,
      ])}
      decisions={state.pendingDecisions.value}
      loading={state.pendingDecisionsLoading.value || unread && !requestError}
      error={state.pendingDecisionsError.value || requestError}
      onRefresh={() => {
        if (started) void state.refreshPendingDecisions();
      }}
      onRetry={history.refresh}
      history={history}
      state={state}
    />
  );
}
