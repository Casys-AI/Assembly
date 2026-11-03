import type { ComponentChildren } from "preact";
import { since } from "../../../lib/cases/cases.ts";
import type { CandidateState } from "../../../lib/system/tools/candidates.ts";
import type { ActivityRow } from "../../../lib/model/revisions/activity.ts";
import { StatsLine } from "../changes/ModelChangeCard.tsx";
import { MainChip, Marker, StageChip } from "../RowParts.tsx";

/** Only the feed presentation; a runtime tool has no source revision selection. */
export type ActivityItemRow =
  & Pick<
    ActivityRow,
    | "key"
    | "title"
    | "byline"
    | "short"
    | "version"
    | "main"
    | "stage"
    | "size"
  >
  & { createdAt?: string; state?: ActivityRow["state"] };

/**
 * One line of the feed: where the change stands, what it is, who made it and
 * when, the commit, and how big it is. The line opens its change under it
 * (`children`), and says so; it is a control, not a link, because the change
 * opens in place.
 */
export function ActivityItem(
  { row, open, onToggle, now, children, toolState }: {
    row: ActivityItemRow;
    toolState?: CandidateState;
    open: boolean;
    onToggle(): void;
    /** For relative dates; the clock when absent. */
    now?: number;
    /** The change, drawn only while the line is open. */
    children?: ComponentChildren;
  },
) {
  return (
    <li
      class="act-item"
      data-state={toolState ? undefined : row.state}
      data-tool-state={toolState?.label}
      data-activity-key={row.key}
    >
      <button
        type="button"
        class={`rev-row act-row${
          row.state === "declined" ? " is-declined" : ""
        }`}
        aria-expanded={open ? "true" : "false"}
        onClick={onToggle}
      >
        {toolState || !row.state
          ? <span class="rev-dot" aria-hidden="true" />
          : <Marker state={row.state} />}
        <span class="rev-title">{row.title}</span>
        <span class="rev-meta">
          <span class="act-by">{row.byline}</span>
          {row.createdAt && (
            <time dateTime={row.createdAt}>{since(row.createdAt, now)}</time>
          )}
          {row.short && <code title={row.version}>{row.short}</code>}
          {row.main && <MainChip />}
          {row.stage && <StageChip stage={row.stage} />}
          {toolState && (
            <span
              class={`chip${
                toolState.tone === "warning"
                  ? " warn"
                  : toolState.tone === "active"
                  ? " run"
                  : ""
              }`}
            >
              {toolState.label}
            </span>
          )}
        </span>
        {row.size && (
          <span class="act-size">
            <StatsLine {...row.size} />
          </span>
        )}
      </button>
      {open && <div class="act-detail">{children}</div>}
    </li>
  );
}
