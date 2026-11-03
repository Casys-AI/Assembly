import { useEffect } from "preact/hooks";
import type { ModelLive } from "../../lib/model/live.ts";
import { useModelLive } from "../view/useModelLive.ts";

/**
 * Runs `refresh` once when the place opens, and not again while it stays open,
 * except when the host announces that the model moved (a proposal made or
 * decided, the head advanced): what waits for a decision has changed then.
 * The place is mounted only when it is the one shown, so mounting is opening.
 * The shell hands a new function at every pass and a read changes what the page
 * draws: depending on that function would read again after every read.
 */
export function useRefreshOnOpen(
  refresh: () => void,
  /** The host's word on the model; the tab's own when absent. */
  live?: ModelLive,
): void {
  useEffect(() => {
    refresh();
  }, []);
  useModelLive(() => refresh(), live);
}
