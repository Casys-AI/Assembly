import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { activityEvents } from "../../lib/decide/activity.ts";
import type { ModelLive } from "../../lib/model/live.ts";
import {
  createRevisionApi,
  type SourceHistory,
} from "../../lib/model/revisions/api.ts";
import {
  createCombinedSavedSystemsApi,
  type SavedSystemView,
} from "../../lib/system/saved-systems.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";
import { useModelLive } from "../view/useModelLive.ts";

/** Reads existing catalogues only while Activity is open. No polling or commands. */
export function useActivityHistory(state: WorkbenchState, live?: ModelLive) {
  const [retry, setRetry] = useState(0);
  const [requestRetry, setRequestRetry] = useState(0);
  const [head, setHead] = useState("");
  const refresh = () => {
    setRetry((value) => value + 1);
    void state.cases.refresh();
    void state.refreshPendingDecisions();
    void state.requests.cases.refresh().then(() =>
      setRequestRetry((value) => value + 1)
    );
  };
  const api = useMemo(
    () => ({
      revisions: createRevisionApi(),
      releases: createCombinedSavedSystemsApi(),
    }),
    [],
  );
  const [model, setModel] = useState({
    scope: "",
    data: null as SourceHistory | null,
    loading: true,
    error: "",
  });
  const [releases, setReleases] = useState({
    scope: "",
    data: [] as SavedSystemView[],
    loading: true,
    error: "",
  });
  const [requestsLoading, setRequestsLoading] = useState(false);
  const requestReads = useRef({
    scope: "",
    retry: requestRetry,
    pending: new Set<string>(),
  });
  useModelLive(({ version }) => {
    if (version !== model.data?.headVersion) setHead(version);
  }, live);
  const system = state.current.value?.id ?? "";
  const ready = state.requests.sessionReady.value;
  const session = state.requests.sessionGeneration.value;
  const releasesGeneration = state.releaseCatalogueGeneration.value;
  const scope = JSON.stringify([system, state.requests.context.value, session]);
  const requests = state.requests.cases.snapshot.value?.cases ?? [];
  const requestKey = requests.map((record) => record.id).join("\n");
  // Model announcements concern commits only, and an unchanged head is already read.
  useEffect(() => {
    if (!system || !ready) return;
    const abort = new AbortController();
    setModel((previous) => ({
      scope,
      data: previous.scope === scope ? previous.data : null,
      loading: true,
      error: "",
    }));
    void api.revisions.history(abort.signal, { limit: 200 }).then(
      (history) => {
        if (!abort.signal.aborted) {
          setModel({ scope, data: history, loading: false, error: "" });
        }
      },
      () => {
        if (!abort.signal.aborted) {
          setModel((previous) => ({
            ...previous,
            loading: false,
            error: "Model history could not be read.",
          }));
        }
      },
    );
    return () => abort.abort();
  }, [api, system, ready, scope, head, retry]);
  // A Release invalidation carries no individual ID; reread only its catalogue.
  useEffect(() => {
    if (!system || !ready) return;
    const abort = new AbortController();
    setReleases((previous) => ({
      scope,
      data: previous.scope === scope ? previous.data : [],
      loading: true,
      error: "",
    }));
    void api.releases.listWithNotice!(abort.signal).then(
      ({ records, notice }) => {
        if (!abort.signal.aborted) {
          setReleases((previous) => ({
            scope,
            data: notice && previous.scope === scope
              ? [
                ...new Map(
                  [...previous.data, ...records].map(
                    (record) => [record.id, record],
                  ),
                ).values(),
              ]
              : records,
            loading: false,
            error: notice,
          }));
        }
      },
      () => {
        if (!abort.signal.aborted) {
          setReleases((previous) => ({
            ...previous,
            loading: false,
            error: "Release history could not be read.",
          }));
        }
      },
    );
    return () => abort.abort();
  }, [api, system, ready, scope, releasesGeneration, retry]);
  useEffect(() => {
    if (!system || !ready) return;
    const abort = new AbortController();
    const records = state.requests.cases.snapshot.peek()?.cases ?? [];
    if (requestReads.current.scope !== scope) {
      requestReads.current = { scope, retry: requestRetry, pending: new Set() };
    }
    const queue = requestReads.current;
    if (queue.retry !== requestRetry) {
      queue.retry = requestRetry;
      queue.pending = new Set(records.map((record) => record.id));
    }
    const pending = records.filter((record) =>
      queue.pending.has(record.id) ||
      !state.requests.snapshots.peek().has(record.id)
    );
    setRequestsLoading(pending.length > 0);
    const readRequests = async () => {
      while (!abort.signal.aborted) {
        const record = pending.shift();
        if (!record) return;
        await state.requests.refresh(record.id);
        queue.pending.delete(record.id);
      }
    };
    // Existing/in-flight open Request reads are shared with the workbench.
    void Promise.all(Array.from({ length: 3 }, readRequests)).then(() => {
      if (!abort.signal.aborted) setRequestsLoading(false);
    });
    return () => abort.abort();
  }, [state, system, ready, scope, requestKey, requestRetry]);
  const history = ready && model.scope === scope ? model.data : null;
  const conversations = state.conversationSnapshot.value?.conversations ?? [];
  const errors = [
    ...[model.error, releases.error].filter(Boolean),
    ...(state.cases.error.value ? ["Some Requests could not be read."] : []),
    ...(state.requests.cases.error.value
      ? ["Independent Requests could not be read."]
      : []),
    ...(requests.some((record) =>
        state.requests.readErrors.value.get(record.id)
      )
      ? ["Some Request decisions could not be read."]
      : []),
  ];
  return {
    events: activityEvents({
      cases: state.cases.snapshot.value?.cases ?? [],
      requests,
      conversations,
      requestSnapshots: state.requests.snapshots.value,
      mainMessages: conversations.find((agent) => agent.primary)?.messages ??
        state.current.value?.messages ?? [],
      history,
      releases: ready && releases.scope === scope ? releases.data : [],
      tools: state.visibleOperatorTools.value?.tools,
    }),
    loading: ready && (model.loading || releases.loading),
    requestsLoading: ready && requestsLoading,
    notices: [
      ...errors,
      ...(!ready ? ["Connect to the system to read the full activity."] : []),
    ],
    truncated: history?.truncated ?? false,
    refresh,
  };
}
