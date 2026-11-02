import type { ModelLive } from "../../lib/model/live.ts";
import type { PendingDecision } from "../../lib/decide/pending.ts";
import { Empty } from "../view/Empty.tsx";
import { PageFrame } from "../view/PageFrame.tsx";
import { Problem } from "../view/Problem.tsx";
import { DecisionRow } from "./DecisionRow.tsx";
import { useRefreshOnOpen } from "./useRefreshOnOpen.ts";

/**
 * The To decide place: the points that wait for the person's decision (a
 * proposal to the model, an authority to grant, a tool to admit), one line each,
 * in the order the host gives them. Each leads to the page where it is decided;
 * nothing is decided here. When the queue could not be read, it says so rather
 * than claiming that nothing waits.
 */
export function DecidePage(
  { decisions, loading, error, onRefresh, live }: {
    decisions: readonly PendingDecision[];
    /** A read is in flight. */
    loading: boolean;
    /** Why the queue could not be read in full; empty when it could. */
    error: string;
    /**
     * Reads the decisions: when the place opens, when the host says the model
     * moved, and from "Try again".
     */
    onRefresh(): void;
    /** The host's word on the model, when it moves; the tab's own when absent. */
    live?: ModelLive;
  },
) {
  useRefreshOnOpen(onRefresh, live);
  return (
    <PageFrame title="To decide" current="decide">
      {error && (
        <Problem problem={{ code: "decisions-unread", message: error }}>
          <button
            type="button"
            class="rev-retry"
            disabled={loading}
            onClick={onRefresh}
          >
            Try again
          </button>
        </Problem>
      )}
      {loading && !error && decisions.length === 0 && (
        <p class="rev-empty" role="status">Updating decisions…</p>
      )}
      {decisions.length > 0
        ? (
          <ul class="decide-list" aria-label="Pending decisions">
            {decisions.map((decision) => (
              <li key={decision.id}>
                <DecisionRow decision={decision} />
              </li>
            ))}
          </ul>
        )
        : !loading && !error && (
          <Empty code="nothing-to-decide">Nothing to decide</Empty>
        )}
    </PageFrame>
  );
}
