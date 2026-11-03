import { useEffect, useMemo } from "preact/hooks";
import {
  createPerformanceApi,
  type PerformanceSelection,
} from "../../../lib/system/performance/api.ts";
import {
  createPerformanceStore,
  performanceKey,
  type PerformanceState,
  type PerformanceStore,
  UNAVAILABLE_PERFORMANCE,
} from "../../../lib/system/performance/store.ts";
import type { SystemPage } from "../../../lib/workbench/desk.ts";

export function usePerformance(props: {
  store?: PerformanceStore;
  page: SystemPage;
  version?: string;
  caseId?: string;
  /** Refresh hint only: the server alone authenticates the cookie. */
  sessionReady: boolean;
  refreshGeneration?: number;
  sessionGeneration?: number;
}): PerformanceState {
  const store = useMemo(
    () =>
      props.store ?? createPerformanceStore({ api: createPerformanceApi() }),
    [props.store],
  );
  const wanted = props.page === "team" || props.page === "performance";
  const version = props.version;
  const selection: PerformanceSelection | undefined = wanted && version
    ? {
      expectedVersion: version,
      ...(props.caseId === undefined ? {} : { caseId: props.caseId }),
    }
    : undefined;
  const key = selection
    ? performanceKey(selection, props.sessionReady, props.sessionGeneration)
    : undefined;
  useEffect(() => () => {
    if (props.store) void store.open(undefined);
    else store.dispose();
  }, [store]);
  useEffect(() => {
    void store.open(
      selection,
      props.sessionReady,
      props.refreshGeneration,
      props.sessionGeneration,
    );
  }, [
    store,
    wanted,
    version,
    props.caseId,
    props.sessionReady,
    props.refreshGeneration,
    props.sessionGeneration,
  ]);
  const held = store.state.value;
  if (!key) return UNAVAILABLE_PERFORMANCE;
  // Hide the old data immediately, before the effect opens the new selection.
  return held.key === key ? held : { key, status: "loading" };
}
