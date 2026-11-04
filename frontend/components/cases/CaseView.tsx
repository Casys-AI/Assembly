import { shortDate } from "../../lib/dates.ts";
import {
  caseKindLabel,
  type CaseRecord,
  caseStatusLabel,
  caseTitle,
  groupWakes,
  isOpenCase,
  timeLabel,
} from "../../lib/cases/cases.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";

/**
 * The page of a Job or a Watch: what it is for, where it stands, its steps or
 * its wakes. A Request is read on the Requests page, as a conversation.
 */
export function CaseView(
  { state, record, actions, caseId }: {
    state: WorkbenchState;
    record: CaseRecord | null;
    actions?: CaseActions;
    caseId?: string | null;
  },
) {
  if (!record) {
    const status = caseId ? state.cases.detailStatus(caseId) : undefined;
    return (
      <p class="case-unavailable" role="status">
        {status === "not-found"
          ? "Case not found"
          : status === "error" && caseId
          ? state.cases.detailError(caseId)
          : "Loading the case…"}
      </p>
    );
  }
  const budget = state.current.value?.workBudget;
  const effort = budget && budget.scopeId === record.budget?.scopeId
    ? `${budget.consumed} / ${budget.limit}`
    : null;
  const open = isOpenCase(record);
  const closing = state.cases.closing.value === record.id;
  const closeUnavailable = !actions;
  return (
    <div class={`case-view is-${record.type}`}>
      <header class="case-head">
        <h2 class="case-title">{caseTitle(record)}</h2>
        {caseTitle(record) !== record.objective.trim() && (
          <p class="case-objective">{record.objective}</p>
        )}
        <p class="case-meta">
          <span>{caseKindLabel[record.type]}</span>
          <span class={`case-status is-${record.status}`}>
            {caseStatusLabel[record.status]}
          </span>
          {record.job?.schedule && <span>{record.job.schedule}</span>}
          {effort && <span title="Agent invocations used">Effort {effort}
          </span>}
          <span
            title={record.modelPin.repositoryVersion || record.modelPin.digest}
          >
            Rules of {shortDate(record.createdAt)}
          </span>
        </p>
        {/* A Watch ends with Stop, a Request closes on the Requests page. */}
        {open && record.type === "job" && (
          <button
            type="button"
            class="case-close"
            disabled={closing || closeUnavailable}
            title={closeUnavailable ? notYet : undefined}
            onClick={() => {
              if (!closing && !closeUnavailable) {
                void state.cases.close(record.id, "done");
              }
            }}
          >
            {closing ? "Closing…" : "Close case"}
          </button>
        )}
        {state.cases.error.value && (
          <p class="case-error" role="alert">{state.cases.error.value}</p>
        )}
      </header>
      {record.type === "job"
        ? <JobBody record={record} actions={actions} />
        : record.type === "watch"
        ? <WatchBody record={record} actions={actions} />
        : null}
    </div>
  );
}

/**
 * Commands of Job and Watch pages. The backend does not serve them yet: without
 * a port, their buttons stay visible but disabled.
 */
export interface CaseActions {
  /** Judgment points are not served by the backend yet. */
  judge?(caseId: string, stepId: string, optionId: string): void;
  run(caseId: string): void;
  pause(caseId: string): void;
  resume(caseId: string): void;
  stop(caseId: string): void;
  /** The Case whose action is in flight, if any. */
  busy?: string | null;
}
const notYet = "Not available yet";

const stepStates: Record<string, string> = {
  done: "Done",
  running: "Running",
  judgment: "Needs your judgment",
  pending: "Next",
  failed: "Failed",
  skipped: "Skipped",
};
const runOutcomes: Record<string, string> = {
  done: "Done",
  failed: "Failed",
  running: "Running",
  abandoned: "Abandoned",
};

/** A Job: its steps as a timeline, judgment points as buttons, recent runs. */
function JobBody(
  { record, actions }: { record: CaseRecord; actions?: CaseActions },
) {
  const job = record.job;
  if (!job) return <p class="case-empty">This job has no steps yet.</p>;
  const running = job.runs.some((run) => run.outcome === "running") ||
    actions?.busy === record.id;
  const runs = [...job.runs].sort((a, b) =>
    Date.parse(a.startedAt) - Date.parse(b.startedAt)
  ).slice(-12);
  return (
    <div class="case-body">
      {isOpenCase(record) && (
        <div class="watch-controls">
          <button
            type="button"
            disabled={!actions || running}
            title={actions ? undefined : notYet}
            onClick={() => actions?.run(record.id)}
          >
            {running ? "Running…" : "Run now"}
          </button>
        </div>
      )}
      <ol class="job-steps" aria-label="Steps">
        {job.steps.map((step) => (
          <li key={step.id} class={`job-step is-${step.state}`}>
            <span class="job-step-mark" aria-hidden="true" />
            <span class="job-step-label">{step.label}</span>
            <span class="job-step-state">{stepStates[step.state]}</span>
            {step.state === "judgment" && step.judgment && (
              <div class="job-judgment">
                <p>{step.judgment.question}</p>
                <div class="job-judgment-options">
                  {step.judgment.options.map((option) => (
                    <button
                      type="button"
                      key={option.id}
                      disabled={!actions?.judge}
                      title={actions?.judge ? undefined : notYet}
                      onClick={() =>
                        actions?.judge?.(record.id, step.id, option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>
      {runs.length > 0 && (
        <section class="job-runs" aria-label="Recent runs">
          <h3>Recent runs</h3>
          <ol>
            {runs.map((run) => (
              <li
                key={run.id}
                class={`job-run is-${run.outcome}`}
                title={`${timeLabel(run.startedAt)} · ${
                  runOutcomes[run.outcome]
                }`}
              >
                <span class="sr-only">
                  {timeLabel(run.startedAt)} · {runOutcomes[run.outcome]}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

/** A Watch: whether it watches, when it wakes next, what its wakes found. */
function WatchBody(
  { record, actions }: { record: CaseRecord; actions?: CaseActions },
) {
  const watch = record.watch;
  if (!watch) return <p class="case-empty">This watch has not woken yet.</p>;
  const band = [...watch.wakes].sort((a, b) =>
    Date.parse(a.at) - Date.parse(b.at)
  ).slice(-24);
  const live = isOpenCase(record) && watch.state !== "stopped";
  return (
    <div class="case-body">
      <p class={`watch-state is-${watch.state}`} role="status">
        {watch.state === "watching"
          ? watch.nextWakeAt
            ? `Watching · next wake ${timeLabel(watch.nextWakeAt)}`
            : "Watching"
          : watch.state === "paused"
          ? "Paused"
          : "Stopped"}
      </p>
      {live && (
        <div class="watch-controls">
          <button
            type="button"
            disabled={!actions || actions.busy === record.id}
            title={actions ? undefined : notYet}
            onClick={() =>
              watch.state === "paused"
                ? actions?.resume(record.id)
                : actions?.pause(record.id)}
          >
            {watch.state === "paused" ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            disabled={!actions || actions.busy === record.id}
            title={actions ? undefined : notYet}
            onClick={() => actions?.stop(record.id)}
          >
            Stop
          </button>
        </div>
      )}
      {band.length > 0 && (
        <ol class="watch-band" aria-label="Recent wakes">
          {band.map((wake) => (
            <li
              key={wake.at}
              class={wake.changed ? "is-changed" : "is-quiet"}
              title={`${timeLabel(wake.at)} · ${
                wake.changed ? "change" : "no change"
              }`}
            >
              <span aria-hidden="true">{wake.changed ? "●" : "○"}</span>
              <span class="sr-only">
                {timeLabel(wake.at)} · {wake.changed ? "change" : "no change"}
              </span>
            </li>
          ))}
        </ol>
      )}
      <ul class="watch-wakes">
        {groupWakes(watch.wakes).map((group) =>
          group.kind === "change"
            ? (
              <li key={group.wake.at} class="watch-wake is-changed">
                <span class="watch-wake-time">{timeLabel(group.wake.at)}</span>
                <span>{group.wake.summary || "Something changed"}</span>
              </li>
            )
            : (
              <li key={`quiet:${group.to}`} class="watch-wake is-quiet">
                <span class="watch-wake-time">{timeLabel(group.to)}</span>
                <span>
                  {group.count === 1
                    ? "1 wake without change"
                    : `${group.count} wakes without change`}
                </span>
              </li>
            )
        )}
      </ul>
    </div>
  );
}
