import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { useRevisionLocationRefresh } from "../../../lib/model/revisions/location.ts";
import {
  activityFiles,
  activityGroups,
} from "../../../lib/model/revisions/activity.ts";
import type { AuthorRoster } from "../../../lib/model/revisions/authors.ts";
import { diffStats } from "../../../lib/model/revisions/change.ts";
import {
  selectedRevision,
  type SourceCommit,
} from "../../../lib/model/revisions/api.ts";
import { revisionView } from "../../../lib/model/revisions/rows.ts";
import { PLACE_PATH } from "../../../lib/workbench/view-location.ts";
import { useChangeRead } from "../changes/useChangeRead.ts";
import { type PageHistoryProps, usePageHistory } from "../usePageHistory.ts";

export interface ActivityPageProps extends Omit<PageHistoryProps, "operators"> {
  /** Changes when the runtime moves: the history is read again. */
  revisionKey?: string | number;
  /**
   * The roster of the system: it names who made each change. The feed does not
   * ask them what they run.
   */
  operators?: AuthorRoster;
  /** Read-only authority facts for the exact selected commit, when available. */
  authorityForCommit?(commit: SourceCommit): ComponentChildren;
  /** The line the address opens; a changed target opens the new line. */
  open?: string;
  /** Runtime candidates remain independent of source history. */
  state?: import("../../../lib/workbench/state.ts").WorkbenchState;
  /** A current tool notification named by the Model address. */
  location?: import("../../../lib/model/revisions/api.ts").RevisionLocation;
  /** For relative dates; the clock when absent. */
  now?: number;
}

/**
 * What the Activity page lives on: the history read on mount and again when a
 * decision anywhere or the runtime moves it, the feed made from it, the one
 * line that is open and the changes of that line, read when it opens. The page
 * itself only draws what this returns.
 */
export function useActivityPage(props: ActivityPageProps) {
  // The feed names people, it does not ask the operators what they run.
  const history = usePageHistory({
    history: props.history,
    sources: props.sources,
    onChanged: props.onChanged,
    live: props.live,
  });
  useRevisionLocationRefresh(
    { pathname: PLACE_PATH.model, search: "" },
    props.revisionKey,
    history.refresh,
    history.cancel,
    props.sources.generation.value,
  );
  const [opening, setOpening] = useState({
    target: props.open,
    key: props.open ?? null as string | null,
  });
  // A new address opens its exact line immediately, before effects synchronize local toggles.
  const opened = opening.target === props.open
    ? opening.key
    : props.open ?? null;
  useEffect(() => {
    setOpening((held) =>
      held.target === props.open
        ? held
        : { target: props.open, key: props.open ?? null }
    );
  }, [props.open]);
  const roster = props.operators ?? [];

  const snapshot = history.snapshot.value;
  const groups = snapshot
    ? activityGroups(snapshot, roster, ({ base, target }) => {
      const read = history.diff(base, target);
      return read?.status === "ready" ? diffStats(read.diff) : undefined;
    })
    : [];
  const row = groups.flatMap((group) => group.rows).find((entry) =>
    entry.key === opened
  );
  const item = snapshot && row && selectedRevision(snapshot, row.selection);
  const view = snapshot && row && item
    ? revisionView(snapshot, row.selection, item, roster)
    : undefined;
  const { diff, retry } = useChangeRead(history, row?.change, snapshot);

  return {
    history,
    snapshot,
    groups,
    opened,
    /** Opens a line, and shuts the one that was open; the open one shuts. */
    toggle: (key: string) =>
      setOpening({ target: props.open, key: opened === key ? null : key }),
    /** The line that is open, and what its change is as the detail tells it. */
    row,
    view,
    diff,
    files: row &&
      activityFiles(row, diff?.status === "ready" ? diff.diff : undefined),
    /** Accepts or declines the proposal that is open, through the shared lock. */
    decide(verdict: "approve" | "refuse") {
      if (view) void history.decideById(view.id, verdict);
    },
    retryDiff: retry,
  };
}
