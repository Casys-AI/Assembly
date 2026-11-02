/** Revalidation cadence while an authenticated supervision surface is visible.
 * There is no authoritative external-revocation notification today. A changed
 * admission is observed on the next completed read, not at its external cause.
 * Visible views schedule a check every 15 seconds, skipping an in-flight read
 * rather than invalidating its answer. Pending reads hide the old
 * snapshot. Hidden views pause checks and revalidate on visibility/focus return.
 */
export const SUPERVISION_REFRESH_MS = 15_000;

export interface SupervisionRefreshEnvironment {
  visible(): boolean;
  interval(callback: () => void, milliseconds: number): () => void;
  focus(callback: () => void): () => void;
  visibility(callback: () => void): () => void;
}

const browserEnvironment = (): SupervisionRefreshEnvironment => ({
  visible: () =>
    typeof document === "undefined" || document.visibilityState !== "hidden",
  interval(callback, milliseconds) {
    const timer = globalThis.setInterval(callback, milliseconds);
    return () => globalThis.clearInterval(timer);
  },
  focus(callback) {
    globalThis.addEventListener?.("focus", callback);
    return () => globalThis.removeEventListener?.("focus", callback);
  },
  visibility(callback) {
    if (typeof document === "undefined") return () => {};
    document.addEventListener?.("visibilitychange", callback);
    return () => document.removeEventListener?.("visibilitychange", callback);
  },
});

/** Called only while Team/Rights is active and the local session is ready. */
export function watchSupervisionFreshness(
  refresh: () => void,
  environment: SupervisionRefreshEnvironment = browserEnvironment(),
  isReading: () => boolean = () => false,
): () => void {
  let active = true;
  const revalidate = () => {
    if (active && environment.visible() && !isReading()) refresh();
  };
  const stops = [
    environment.interval(revalidate, SUPERVISION_REFRESH_MS),
    environment.focus(revalidate),
    environment.visibility(revalidate),
  ];
  return () => {
    active = false;
    for (const stop of stops) stop();
  };
}
