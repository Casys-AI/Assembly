import { useEffect } from "preact/hooks";
import { type RevisionLocation, synchronizeRevisionLocation } from "./api.ts";
import { placeOfPath } from "../../workbench/view-location.ts";

/** The mounted view must refresh an explicit target reached through navigation.
 * Keep snapshot updates and comparison-only URL changes out of this lifecycle. */
export function useRevisionLocationRefresh(
  location: RevisionLocation,
  /** Changes when the runtime moves: the history is read again. */
  revisionKey: string | number | undefined,
  refresh: () => void | Promise<void>,
  cancel: () => void,
  /** Shared proposal generation: a decision anywhere rereads the history. */
  generation?: number,
) {
  const selection = synchronizeRevisionLocation({}, location).inspection
    .selection;
  useEffect(() => {
    if (placeOfPath(location.pathname) !== "model") return;
    void refresh();
    return cancel;
  }, [
    location.pathname,
    selection?.kind,
    selection?.id,
    revisionKey,
    generation,
    refresh,
    cancel,
  ]);
}
