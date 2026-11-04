import { SavedSystemError } from "../../../domain/work/records/saved-systems.ts";

export const TAG_MUTATION_TRANSACTION = { timeout: 15_000, maxWait: 5_000 };
const nativeTimeoutMs = 2_000;
const completionMarginMs = 3_000;
export const TAG_MUTATION_MIN_VALIDITY_MS = nativeTimeoutMs +
  completionMarginMs;
const unavailable = () =>
  new SavedSystemError(
    "TAG_UNAVAILABLE",
    "The exact tag operation is unavailable.",
  );

/** Count acquisition and guards from before transaction entry. Await cancellation
 * settlement so no native mutation can outlive the authority locks. */
export function tagMutationBudget(now: () => number = () => performance.now()) {
  const deadline = now() + TAG_MUTATION_TRANSACTION.timeout;
  return async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (deadline - now() <= TAG_MUTATION_MIN_VALIDITY_MS) {
      throw unavailable();
    }
    const native = new AbortController();
    const timer = setTimeout(
      () => native.abort(unavailable()),
      nativeTimeoutMs,
    );
    try {
      await operation(native.signal);
    } finally {
      clearTimeout(timer);
    }
    if (native.signal.aborted || deadline - now() <= completionMarginMs) {
      throw unavailable();
    }
  };
}
