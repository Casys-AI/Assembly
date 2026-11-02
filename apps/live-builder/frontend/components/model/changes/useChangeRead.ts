import { useEffect } from "preact/hooks";
import type {
  DiffState,
  ModelHistory,
} from "../../../lib/model/revisions/history.ts";

/**
 * The changes a page shows for one revision: the difference between two
 * versions, read once they are wanted. A version never changes, so a read is
 * made once; one that failed is made again whenever the history is (`read`
 * changes with it) or on request.
 */
export function useChangeRead(
  history: ModelHistory,
  /** The two versions to compare; none while the revision has no changes to read. */
  change: { base: string; target: string } | undefined,
  /** The last coherent read of the history: a new one retries a failed read. */
  read: unknown,
): { diff: DiffState | undefined; retry(): void } {
  useEffect(() => {
    if (change) void history.readDiff(change.base, change.target);
  }, [history, change?.base, change?.target, read]);
  return {
    diff: change ? history.diff(change.base, change.target) : undefined,
    retry() {
      if (change) void history.readDiff(change.base, change.target);
    },
  };
}
