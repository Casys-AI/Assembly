import type { ComponentChildren } from "preact";
import { since } from "../../../lib/cases/cases.ts";
import {
  isShown,
  type RevisionRow,
  type RevisionTab,
} from "../../../lib/model/revisions/rows.ts";
import {
  revisionInspectionHref,
  type RevisionSelection,
} from "../../../lib/model/revisions/api.ts";
import { MainChip, Marker, StageChip } from "../RowParts.tsx";
import { outcomeLabel } from "../../../lib/model/revisions/change.ts";

const tabs: readonly (readonly [RevisionTab, string])[] = [
  ["commit", "Commits"],
  ["proposal", "Proposals"],
];

function Meta({ row, now }: { row: RevisionRow; now?: number }) {
  const runs = row.kind === "commit" ? row.runningFor : [];
  return (
    <span class="rev-meta">
      {row.author && <span class="rev-author">{row.author}</span>}
      {row.kind === "proposal" && row.branch && (
        <span class="rev-branch" title={row.branch}>{row.branch}</span>
      )}
      <time dateTime={row.createdAt}>{since(row.createdAt, now)}</time>
      {row.kind === "commit" && row.main && <MainChip />}
      {row.kind === "commit" && row.running && (
        <span
          class="chip run"
          title={runs.length > 0
            ? `In service for ${runs.join(", ")}`
            : "The version the operator runs"}
        >
          running
        </span>
      )}
      {row.kind === "proposal" &&
        (row.status === "preparing" || row.status === "accepting") && (
        <StageChip stage={row.status} />
      )}
      {row.kind === "proposal" &&
        !["preparing", "accepting"].includes(row.status) && (
        <span class={`rev-status is-${row.state}`}>
          {row.status === "proposed" ? "Proposed" : outcomeLabel[row.state]}
        </span>
      )}
    </span>
  );
}

/**
 * Main's commits and the proposals made to it, one list at a time. The open
 * proposals are counted on their tab; "main" and "running" sit on the commit
 * they belong to. A row is a link to its revision, so every one has an address.
 * What puts the head of main in service sits under its row, and the operators
 * still waiting for it are counted on the Commits tab, where it is.
 */
export function RevisionList(
  { tab, onTab, rows, open, outOfService = 0, service, shown, now }: {
    tab: RevisionTab;
    onTab(tab: RevisionTab): void;
    /** The rows of the tab shown. */
    rows: readonly RevisionRow[];
    /** The proposals waiting for a decision. */
    open: number;
    /** The operators the head of main is not yet in service for. */
    outOfService?: number;
    /** The control that puts the head of main in service: under its row. */
    service?: ComponentChildren;
    shown: RevisionSelection | undefined;
    /** For relative dates; the clock when absent. */
    now?: number;
  },
) {
  return (
    <aside class="rev-list" aria-label="Revisions">
      <div class="seg" role="group" aria-label="Kind of revision">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id ? "true" : "false"}
            onClick={() => onTab(id)}
          >
            {label}
            {id === "proposal" && open > 0 && (
              <>
                {" "}
                <span
                  class="count"
                  title={`${open} waiting for a decision`}
                >
                  {open}
                </span>
              </>
            )}
            {id === "commit" && outOfService > 0 && (
              <>
                {" "}
                <span
                  class="count"
                  title={`Not in service yet for ${outOfService} ${
                    outOfService === 1 ? "operator" : "operators"
                  }`}
                >
                  {outOfService}
                </span>
              </>
            )}
          </button>
        ))}
      </div>
      {rows.length === 0
        ? (
          <p class="rev-empty">
            {tab === "commit" ? "No commits yet." : "No proposals."}
          </p>
        )
        : (
          <ol>
            {rows.map((row) => (
              <li key={row.id}>
                <a
                  class={`rev-row${
                    row.kind === "proposal" && row.state === "declined"
                      ? " is-declined"
                      : ""
                  }`}
                  href={revisionInspectionHref({
                    selection: { kind: row.kind, id: row.id },
                  })}
                  // Stated either way: Fresh marks a link whose path is the
                  // current one, and every revision shares the page's path.
                  aria-current={isShown(row, shown) ? "true" : "false"}
                  // The commit's whole identity, never as visible text.
                  title={row.kind === "commit" ? row.id : undefined}
                >
                  <Marker
                    state={row.kind === "commit" ? "applied" : row.state}
                  />
                  <span class="rev-title">{row.title}</span>
                  <Meta row={row} now={now} />
                </a>
                {row.kind === "commit" && row.main && service}
              </li>
            ))}
          </ol>
        )}
    </aside>
  );
}
