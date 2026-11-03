import { useEffect, useRef } from "preact/hooks";
import {
  type ModelFollower,
  type ModelLive,
  modelLive,
} from "../../lib/model/live.ts";

/**
 * Follows the host's word on the model while the component is mounted: `read`
 * is called once for each announcement that tells something new (see
 * lib/model-live.ts). The shell hands a new function at every pass, so the
 * latest is the one called, and the component follows from when it mounts to
 * when it goes, however often it is drawn. `live` is the tab's own unless a
 * test hands another.
 */
export function useModelLive(
  read: ModelFollower,
  live: ModelLive = modelLive,
): void {
  const latest = useRef(read);
  latest.current = read;
  useEffect(
    () => live.follow((head) => latest.current(head)),
    [live],
  );
}
