/** Delayed layout notifications never take control away from live following. */
export interface SequenceInteractionGuard {
  programmatic(): void;
  user(): void;
  dispose(): void;
}

export function createSequenceInteractionGuard(
  schedule: (callback: () => void) => number,
  cancel: (handle: number) => void,
  onSuppressed: (suppressed: boolean) => void,
  onUser: () => void,
): SequenceInteractionGuard {
  let epoch = 0;
  let pending: number | undefined;
  let disposed = false;
  const release = () => {
    if (pending !== undefined) cancel(pending);
    pending = undefined;
  };
  return {
    programmatic() {
      if (disposed) return;
      const ownEpoch = ++epoch;
      release();
      onSuppressed(true);
      pending = schedule(() => {
        if (disposed || epoch !== ownEpoch) return;
        pending = undefined;
        onSuppressed(false);
      });
    },
    user() {
      if (disposed) return;
      epoch++;
      release();
      onSuppressed(false);
      onUser();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch++;
      release();
      onSuppressed(false);
    },
  };
}
