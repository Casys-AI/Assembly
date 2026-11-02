import { sameSourceVersion } from "./revisions/api.ts";

/**
 * A reader of one version of the model that follows the admitted head: the
 * board, the files, whatever reads `?version=` of the host. The host announces
 * when the head moves (lib/model-live.ts); this is the one rule for what such
 * a reader does with the announcement, so that each store need not make it
 * again.
 */

/**
 * What a reader holds: the version it asked for (none is the head), the commit
 * it holds, and whether its last read failed.
 */
export interface HeldVersion {
  asked: string | undefined;
  version: string | undefined;
  failed?: boolean;
}

/**
 * Whether a reader must read the head the host announced. Only one that
 * follows the head can be behind it: a version a person named never moves. One
 * that holds the head already has nothing to read, unless its last read failed.
 */
export function behindHead(held: HeldVersion, head: string): boolean {
  return held.asked === undefined &&
    (held.failed === true || !sameSourceVersion(held.version, head));
}

export interface HeadReader {
  /** Reads `asked`, the head when absent. */
  open(asked?: string): Promise<void>;
  /**
   * The host announced that the admitted head is now `head`. Reads it, at its
   * immutable address, when the reader is behind it (see `behindHead`). A read
   * of that very commit already on its way is the one that answers; a read of
   * the head, which the host resolves itself, finishes first and is judged by
   * the commit it brought, so an announcement that arrives while a page opens
   * does not abort the first read to start a second. A read of an older head
   * is dropped for the newer one.
   */
  moved(head: string): Promise<void>;
}

/** The read in flight: what it was asked, and when it is over. */
interface Flight {
  asked: string | undefined;
  /** The commit read for the head, when the host had named it. */
  at: string | undefined;
  done: Promise<void>;
}

export function headReader(options: {
  /** What the reader holds now. */
  held(): HeldVersion;
  /**
   * Reads `asked`, or `at` for the head when the host has named the commit,
   * and drops the read it replaces. It tells its own failures: it never rejects.
   */
  read(asked: string | undefined, at: string | undefined): Promise<void>;
}): HeadReader {
  let flight: Flight | undefined;

  function start(asked?: string, at?: string): Promise<void> {
    const mine: Flight = { asked, at, done: Promise.resolve() };
    flight = mine;
    mine.done = options.read(asked, at).finally(() => {
      if (flight === mine) flight = undefined;
    });
    return mine.done;
  }

  function moved(head: string): Promise<void> {
    const reading = flight;
    if (reading && reading.asked === undefined) {
      // The host resolves the head itself: wait for the commit it names.
      if (reading.at === undefined) {
        return reading.done.then(() => moved(head));
      }
      if (sameSourceVersion(reading.at, head)) return reading.done;
    }
    return behindHead(options.held(), head)
      ? start(undefined, head)
      : Promise.resolve();
  }

  return { open: (asked) => start(asked), moved };
}
