import { computed, type ReadonlySignal, signal } from "@preact/signals";

/**
 * The shared state of source changes, read by every panel that can decide:
 * the proposal generation and whether a change is in flight anywhere. The
 * conversations' proposal store provides it; Evolution reads the same one.
 */
export interface SharedSources {
  generation: ReadonlySignal<number>;
  inFlight: ReadonlySignal<boolean>;
  /** Marks a change in flight until it settles. */
  track<T>(change: () => Promise<T>): Promise<T>;
  /** Advances the generation synchronously, then rereads the threads. */
  invalidate(): Promise<void>;
}

/**
 * The one "decision in flight" lock: every decision command (source proposals,
 * adoptions, tool admissions, mandate changes, Evolution) holds it while its
 * request is unsettled, and no decision control may act while it is held.
 */
export interface DecisionLock {
  held: ReadonlySignal<boolean>;
  track<T>(change: () => Promise<T>): Promise<T>;
}

export function createDecisionLock(): DecisionLock {
  const count = signal(0);
  return {
    held: computed(() => count.value > 0),
    async track(change) {
      count.value++;
      try {
        return await change();
      } finally {
        count.value--;
      }
    },
  };
}

/** A standalone shared state, for a view used without the conversations. */
export function localSources(): SharedSources {
  const generation = signal(0);
  const changes = signal(0);
  return {
    generation,
    inFlight: computed(() => changes.value > 0),
    async track(change) {
      changes.value++;
      try {
        return await change();
      } finally {
        changes.value--;
      }
    },
    invalidate() {
      generation.value++;
      return Promise.resolve();
    },
  };
}

/**
 * One source change made from Evolution (a decision or an adoption). It is in
 * flight for every panel from the request on; the generation advances as soon
 * as the server confirms it, before any reread, so no panel acts on a read made
 * before it while Evolution and the runtime views refresh.
 */
export async function runSourceCommand(
  sources: Pick<SharedSources, "track" | "invalidate" | "inFlight">,
  steps: {
    operation(): Promise<unknown>;
    reread(): Promise<void>;
    changed(): void | Promise<void>;
  },
): Promise<boolean> {
  // Another decision is in flight somewhere: this one is not sent.
  if (sources.inFlight.peek()) return false;
  await sources.track(async () => {
    await steps.operation();
    const threads = sources.invalidate();
    await steps.reread();
    await Promise.all([threads, steps.changed()]);
  });
  return true;
}
