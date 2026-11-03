import type { ModelHistory } from "../../lib/model/revisions/history.ts";
import type { RevisionSnapshot } from "../../lib/model/revisions/api.ts";
import { Problem } from "../view/Problem.tsx";

/**
 * What the history says about its own reading, for every page that lists it:
 * why the last read failed, with a way to read again, and, while there is
 * nothing to show yet and nothing has failed, that it is being read.
 */
export function HistoryStatus(
  { history, snapshot }: {
    history: ModelHistory;
    /** The last coherent read; none before the first one. */
    snapshot: RevisionSnapshot | undefined;
  },
) {
  const problem = history.problem.value;
  return (
    <>
      {problem && (
        <Problem problem={problem}>
          <button
            type="button"
            class="rev-retry"
            onClick={() => void history.refresh()}
          >
            Try again
          </button>
        </Problem>
      )}
      {!snapshot && !problem && (
        <p class="rev-empty" role="status">Reading the history…</p>
      )}
    </>
  );
}
