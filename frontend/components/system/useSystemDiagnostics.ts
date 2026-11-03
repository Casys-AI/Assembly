import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  createDiagnosticsApi,
  loadingDiagnostics,
  reconcileDiagnostics,
  type SystemDiagnosticsRead,
} from "../../lib/system/diagnostics.ts";
import type { ModelLive } from "../../lib/model/live.ts";
import { useModelLive } from "../view/useModelLive.ts";

export type DiagnosticsApi = Pick<
  ReturnType<typeof createDiagnosticsApi>,
  "read"
>;
interface Snapshot {
  key: string;
  api: DiagnosticsApi;
  read: SystemDiagnosticsRead;
  refreshing: boolean;
}
const unavailable = (): SystemDiagnosticsRead => {
  const result = {
    status: "unavailable" as const,
    message: "The diagnostics could not be read for this model version.",
  };
  return { doctor: result, shapes: result, attention: result };
};

/** One exact board source and session. Old responses cannot cross the selection. */
export function useSystemDiagnostics(props: {
  active: boolean;
  version?: string;
  caseId?: string;
  sessionReady: boolean;
  sessionGeneration?: number;
  refreshGeneration?: number;
  api?: DiagnosticsApi;
  /** The host's word on the model (the Case's own inside a Case); the tab's when absent. */
  live?: ModelLive;
}): { read: SystemDiagnosticsRead; refreshing: boolean } {
  const api = useMemo(() => props.api ?? createDiagnosticsApi(), [props.api]);
  // A new head moves the board, and the version read here with it. The same
  // head announced again tells something else of it (a mask changed, its
  // attention counted): what is shown is read again in place.
  const [announced, setAnnounced] = useState(0);
  useModelLive((head) => {
    if (head.version === props.version) setAnnounced((count) => count + 1);
  }, props.live);
  const key = props.active && props.version
    ? JSON.stringify([
      props.caseId ?? null,
      props.version,
      props.sessionReady,
      props.sessionGeneration ?? 0,
    ])
    : null;
  const [held, setHeld] = useState<Snapshot | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    if (!key || !props.version) return;
    const request = ++generation.current;
    const controller = new AbortController();
    if (props.caseId && !props.sessionReady) {
      setHeld({ key, api, read: unavailable(), refreshing: false });
      return () => {
        controller.abort();
        generation.current++;
      };
    }
    setHeld((previous) =>
      previous?.key === key && previous.api === api
        ? { ...previous, refreshing: true }
        : { key, api, read: loadingDiagnostics(), refreshing: false }
    );
    const onUpdate = (read: SystemDiagnosticsRead) => {
      if (controller.signal.aborted || generation.current !== request) return;
      setHeld((previous) => {
        const same = previous?.key === key && previous.api === api;
        const keep = <T>(next: T & { status: string }, old: T | undefined): T =>
          next.status === "loading" && old !== undefined ? old : next;
        return {
          key,
          api,
          read: reconcileDiagnostics({
            doctor: keep(read.doctor, same ? previous.read.doctor : undefined),
            shapes: keep(read.shapes, same ? previous.read.shapes : undefined),
            attention: keep(
              read.attention,
              same ? previous.read.attention : undefined,
            ),
          }),
          refreshing: same ? previous.refreshing : false,
        };
      });
    };
    void api.read(props.version, controller.signal, onUpdate).then((read) => {
      if (!controller.signal.aborted && generation.current === request) {
        setHeld({
          key,
          api,
          read: reconcileDiagnostics(read),
          refreshing: false,
        });
      }
    }, () => {
      if (!controller.signal.aborted && generation.current === request) {
        setHeld({ key, api, read: unavailable(), refreshing: false });
      }
    });
    return () => {
      controller.abort();
      generation.current++;
    };
  }, [
    api,
    key,
    props.version,
    props.caseId,
    props.sessionReady,
    props.refreshGeneration,
    announced,
  ]);
  if (!key || held?.key !== key || held.api !== api) {
    return { read: loadingDiagnostics(), refreshing: false };
  }
  return { read: held.read, refreshing: held.refreshing };
}
