import { NativeGraph } from "./NativeGraph.tsx";
import type { WorkbenchState } from "../../lib/workbench/state.ts";
import { authorities, describeState } from "../workbench/copy.ts";
import { modelHref } from "../../lib/workbench/desk.ts";
import { viewHref } from "../../lib/workbench/view-location.ts";

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

export function GraphView(
  { state, embedded = false, home = modelHref("graph"), heading = true }: {
    state: WorkbenchState;
    embedded?: boolean;
    /**
     * The address of the page that shows this graph (the Model place's Graph
     * page unless told otherwise). Inspecting a revision and returning to the
     * current model stay on it, whichever place hosts it.
     */
    home?: string;
    /** The page may already carry a title of its own. */
    heading?: boolean;
  },
) {
  const current = state.current.value;
  const inspected = state.displayed.value;
  const selected = state.selectedRevision.value;
  const readOnly = state.readOnly.value;
  const source = state.graphSourceSelection.value;
  const oldTools = new Set(
    inspected?.candidates.filter((c) => c.stage === "active").map((c) => c.id),
  );
  const newTools = new Set(
    current?.candidates.filter((c) => c.stage === "active").map((c) => c.id),
  );
  const added =
    current?.candidates.filter((c) => newTools.has(c.id) && !oldTools.has(c.id))
      .map((c) => c.name) || [];
  const removed =
    inspected?.candidates.filter((c) =>
      oldTools.has(c.id) && !newTools.has(c.id)
    ).map((c) => c.name) || [];
  const events = inspected?.events.slice(-5) || [];
  return (
    <>
      {!embedded && (
        <>
          {heading && (
            <div class="section-head">
              <h2>SysML model</h2>
            </div>
          )}
          <details class="history" id="history" hidden={Boolean(source)}>
            <summary>
              System history ·{" "}
              <span id="revision-label">
                {current
                  ? `present · revision ${current.revision}`
                  : "loading…"}
              </span>
            </summary>
            <div class="history-content">
              <form
                method="GET"
                action={viewHref(home, {
                  revision: selected === null ? null : String(selected),
                })}
                f-partial={home}
                onSubmit={(event) => {
                  const form = event.currentTarget;
                  const revision = new FormData(form).get("revision");
                  form.action = viewHref(home, {
                    revision: revision ? String(revision) : null,
                  });
                }}
              >
                <label for="revision-select">Choose a state to view</label>
                <select
                  id="revision-select"
                  name="revision"
                  value={selected === null ? "" : String(selected)}
                  disabled={!current || state.pending.value ||
                    !state.historyEntries.value.length}
                  onChange={(event) =>
                    event.currentTarget.form?.requestSubmit()}
                >
                  <option value="">
                    {current
                      ? `Present · revision ${current.revision}`
                      : "Present"}
                  </option>
                  {state.historyEntries.value.filter((entry) =>
                    entry.revision !== current?.revision
                  ).map((entry) => (
                    <option key={entry.revision} value={entry.revision}>
                      Revision {entry.revision}
                      {formatDate(entry.recordedAt)
                        ? ` · ${formatDate(entry.recordedAt)}`
                        : ""}
                      {entry.label ? ` · ${entry.label}` : ""}
                    </option>
                  ))}
                </select>
                <button type="submit" class="action">View</button>
              </form>
              <p id="revision-description" role="status">
                {state.historyError.value || (readOnly
                  ? inspected
                    ? `Recorded state at revision ${selected} · compared with the present (${current?.revision}).`
                    : `Rebuilding revision ${selected}…`
                  : "Open a revision to see its conversation, agents, tools and mandate.")}
              </p>
              <div
                id="revision-comparison"
                hidden={!readOnly || !inspected || !current}
              >
                <h3 class="sr-only">Comparison with the present</h3>
                <ul id="comparison-list">
                  {inspected && current && (
                    <>
                      <li>At this date: {describeState(inspected)}.</li>
                      <li>
                        At present:{" "}
                        {describeState(current, state.currentCounts.value)}.
                      </li>
                      <li>
                        Admission at this date: {inspected.configuration
                          ? authorities[
                            inspected.configuration.builder.admissionAuthority
                          ]
                          : "mandate not recorded"}
                      </li>
                      <li>
                        Admission at present: {current.configuration
                          ? authorities[
                            current.configuration.builder.admissionAuthority
                          ]
                          : "mandate not recorded"}
                      </li>
                      {added.length > 0 && (
                        <li>Tools admitted since: {added.join(", ")}.</li>
                      )}
                      {removed.length > 0 && (
                        <li>
                          Tools no longer active: {removed.join(", ")}.
                        </li>
                      )}
                    </>
                  )}
                </ul>
                <p>
                  This view rebuilds the state recorded at this date. The system
                  keeps evolving at present.
                </p>
              </div>
            </div>
          </details>
          <div class="model-caption">
            <span id="model-caption">{state.modelCaption.value}</span>
            <a
              class="action"
              id="return-model-current"
              href={home}
              hidden={!source && !readOnly}
            >
              Back to the current model
            </a>
          </div>
          <details
            class="recent-events"
            id="recent-events"
            hidden={!events.length}
          >
            <summary>Recent system activity</summary>
            <ol id="event-list">
              {events.map((event) => <li key={event.id}>{event.label}</li>)}
            </ol>
          </details>
        </>
      )}
      <NativeGraph
        source={embedded ? "/api/model-graph" : state.graphRequestUrl.value}
      />
    </>
  );
}
