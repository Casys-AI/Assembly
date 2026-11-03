import { type ReadonlySignal, signal } from "@preact/signals";
import { headReader } from "./head-reader.ts";

/**
 * What a place holds of something it reads from the model at one commit (the
 * board, the authority matrix): the one it draws, the commit it describes,
 * whether it is being read, and why the last read failed. The pages draw the
 * value when there is one, and tell `problem` and `loading` beside it. The
 * value is held under `Key` (`board`, `matrix`), the name its pages know it by.
 */
export type VersionedState<Key extends string, Value, Problem> =
  & {
    /** The version the pages asked for; none is the admitted head. */
    asked: string | undefined;
    /** The immutable commit the value describes. */
    version?: string;
    /** A read is in flight. */
    loading: boolean;
    /** Why the last read failed. A value read before it stays on show. */
    problem?: Problem;
  }
  & { [Name in Key]?: Value };

export interface VersionedStore<Key extends string, Value, Problem> {
  readonly state: ReadonlySignal<VersionedState<Key, Value, Problem>>;
  /**
   * Reads the value of `asked` (the head when absent). The same version read
   * again, the head after it moved, keeps the value it showed until the answer
   * arrives, and keeps it if the answer is a failure; another version starts
   * over, and an answer that is no longer the latest asked is dropped.
   */
  open(asked?: string): Promise<void>;
  /**
   * The host announced that the admitted head is now `head`. A store that
   * follows the head and does not hold that commit reads it, at its immutable
   * address, keeping what it shows until the answer (see `headReader`, which
   * says what happens to a read already on its way). A store of a version a
   * person named never moves, and one that holds the head has nothing to read
   * (unless its last read failed).
   */
  moved(head: string): Promise<void>;
  /** Nothing is stored or sent after this. */
  dispose(): void;
}

export function createVersionedStore<
  Key extends string,
  Value,
  Problem,
>(options: {
  /** The name the state holds the value under. */
  key: Key;
  read(
    asked: string | undefined,
    signal: AbortSignal,
  ): Promise<{ value: Value; version: string }>;
  /** The head read again with nothing new: the same value stays, so what is drawn from it is not drawn again. */
  same(kept: Value, answer: Value): boolean;
  /** A failed read as the problem the page tells; `asked` says a version was named. */
  problem(failure: unknown, asked: boolean): Problem;
}): VersionedStore<Key, Value, Problem> {
  type State = VersionedState<Key, Value, Problem>;
  const { key } = options;
  const valueOf = (state: State) =>
    (state as Record<Key, Value | undefined>)[key];
  const state = signal<State>({ asked: undefined, loading: true } as State);
  let disposed = false;
  let current: AbortController | undefined;

  /** `at`: the commit to read for the head, when the host has named it. */
  async function load(asked?: string, at?: string): Promise<void> {
    if (disposed) return;
    current?.abort();
    const read = current = new AbortController();
    const { problem: _told, ...held } = state.peek();
    // A value is the value of one version: it is never shown for another.
    state.value = held.asked === asked
      ? { ...held, loading: true } as State
      : { asked, loading: true } as State;
    try {
      const answer = await options.read(at ?? asked, read.signal);
      if (read.signal.aborted || disposed) return;
      const kept = state.peek();
      const keptValue = valueOf(kept);
      const same = keptValue !== undefined && kept.version === answer.version &&
        options.same(keptValue, answer.value);
      state.value = {
        asked,
        [key]: same ? keptValue : answer.value,
        version: answer.version,
        loading: false,
      } as State;
    } catch (failure) {
      if (read.signal.aborted || disposed) return;
      const kept = state.peek();
      const keptValue = valueOf(kept);
      state.value = {
        asked,
        ...(keptValue !== undefined
          ? { [key]: keptValue, version: kept.version }
          : {}),
        loading: false,
        problem: options.problem(failure, asked !== undefined),
      } as State;
    }
  }

  const reader = headReader({
    held: () => {
      const held = state.peek();
      return {
        asked: held.asked,
        version: held.version,
        failed: held.problem !== undefined,
      };
    },
    read: load,
  });

  return {
    state,
    open: reader.open,
    moved: reader.moved,
    dispose() {
      disposed = true;
      current?.abort();
    },
  };
}
