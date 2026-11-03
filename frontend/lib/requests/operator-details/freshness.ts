import {
  type SupervisionRefreshEnvironment,
  watchSupervisionFreshness,
} from "../../system/supervision/freshness.ts";

export function requestDetailsVisible(): boolean {
  return typeof document === "undefined" ||
    document.visibilityState !== "hidden";
}
/** Share the visible authenticated surface cadence; focus/ticks never restart a pending read. */
export function watchRequestOperatorDetailsFreshness(
  refresh: () => void,
  pending: () => boolean,
  environment?: SupervisionRefreshEnvironment,
): () => void {
  return watchSupervisionFreshness(() => {
    if (!pending()) refresh();
  }, environment);
}
