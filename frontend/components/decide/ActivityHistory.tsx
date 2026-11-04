import type { ActivityEvent } from "../../lib/decide/activity.ts";
import { useState } from "preact/hooks";
import { exactDate } from "../model/revisions/RevisionDetail.tsx";
import { since } from "../../lib/cases/cases.ts";
import { decidedByLabel } from "../../lib/conversations/operator-authority.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";
import {
  ChangeInspector,
  DecisionChip,
  FactList,
} from "../conversations/DecisionParts.tsx";
import { useChangeDecision } from "../conversations/useChangeDecision.ts";
import { Empty } from "../view/Empty.tsx";
import { Problem } from "../view/Problem.tsx";

export interface ActivityHistoryProps {
  events: readonly ActivityEvent[];
  loading: boolean;
  notices: readonly string[];
  truncated: boolean;
  requestsLoading?: boolean;
  refresh(): void;
}

function ActivityDecision(
  { event, state }: {
    event: NonNullable<ActivityEvent["decision"]>;
    state: WorkbenchState;
  },
) {
  const { decision, error } = useChangeDecision(
    state,
    event.change,
    event.record,
  );
  return (
    <DecisionChip
      decision={decision}
      label={error ? "Status unavailable" : undefined}
      note={error || undefined}
    />
  );
}

/** Same list, dates and inspectors as the model feed; all destinations are links. */
export function ActivityHistory(
  { history, state, now }: {
    history: ActivityHistoryProps;
    state: WorkbenchState;
    now?: number;
  },
) {
  const [limit, setLimit] = useState(30);
  const events = history.events.slice(0, limit);
  const refresh = () => {
    history.refresh();
    for (const event of events) {
      const decision = event.decision;
      if (decision?.record) {
        void state.loadCaseChangeStatus(
          decision.record.caseId,
          decision.record.agentId,
          decision.change.id,
        );
      }
    }
  };
  return (
    <section class="act-group" aria-labelledby="activity-history-title">
      <h2 class="act-group-label" id="activity-history-title">What happened</h2>
      <button type="button" class="rev-retry" onClick={refresh}>
        Read again
      </button>
      {history.notices.length > 0 && (
        <Problem
          problem={{
            code: "activity-incomplete",
            message: history.notices.join(" "),
          }}
        />
      )}
      {history.loading && (
        <p class="rev-empty" role="status">Reading activity…</p>
      )}
      {history.requestsLoading && (
        <p class="rev-empty" role="status">Reading Request decisions…</p>
      )}
      {history.truncated && (
        <p class="rev-empty">Earlier model history is not included.</p>
      )}
      {history.events.length > 0
        ? (
          <ol class="act-list activity-history" aria-label="Activity history">
            {events.map((event) => (
              <li class="act-item" key={event.id} data-event={event.kind}>
                <a
                  class="decide-row"
                  href={event.href}
                  title={event.description}
                >
                  <span class="rev-dot" aria-hidden="true" />
                  <span class="decide-text">{event.title}</span>
                  {event.decision && (
                    <ActivityDecision
                      event={event.decision}
                      state={state}
                    />
                  )}
                  <span class="decide-go" aria-hidden="true">→</span>
                </a>
                <div class="activity-meta">
                  {event.description && (
                    <span class="activity-description">
                      {event.description}
                    </span>
                  )}
                  {event.byline && <span>{event.byline}</span>}
                  <time dateTime={event.at} title={exactDate(event.at)}>
                    {since(event.at, now)}
                  </time>
                  {event.decision
                    ? (
                      <ChangeInspector
                        change={event.decision.change}
                        summary={event.decision.author
                          ? decidedByLabel({
                            ...event.decision.author,
                            by: event.decision.by!,
                            rule: "…",
                          })
                          : "Decision details"}
                      >
                        {event.decision.author && (
                          <p>{decidedByLabel(event.decision.author)}</p>
                        )}
                        <FactList
                          facts={[{
                            label: "Decided at",
                            value: exactDate(event.at),
                          }]}
                        />
                      </ChangeInspector>
                    )
                    : (
                      <details class="inspector change-inspector">
                        <summary>Details</summary>
                        <div class="inspector-body">
                          <FactList facts={event.facts} />
                        </div>
                      </details>
                    )}
                </div>
              </li>
            ))}
          </ol>
        )
        : !history.loading && !history.requestsLoading &&
          history.notices.length === 0 && (
          <Empty code="no-activity">No recorded activity yet</Empty>
        )}
      {history.events.length > limit && (
        <button
          type="button"
          class="rev-retry"
          onClick={() => setLimit((value) => value + 30)}
        >
          Show more
        </button>
      )}
    </section>
  );
}
