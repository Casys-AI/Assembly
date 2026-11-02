import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { runningVersions } from "../../../lib/model/revisions/history.ts";
import {
  resolveRevision,
  type RevisionLocation,
  type RuntimeOperator,
  type SourceCommit,
  synchronizeRevisionLocation,
} from "../../../lib/model/revisions/api.ts";
import { operatorsIdle } from "../../../lib/conversations/proposals.ts";
import type { AuthorRoster } from "../../../lib/model/revisions/authors.ts";
import { useRevisionLocationRefresh } from "../../../lib/model/revisions/location.ts";
import {
  type RevisionTab,
  revisionView,
  shownRevision,
} from "../../../lib/model/revisions/rows.ts";
import { PLACE_PATH } from "../../../lib/workbench/view-location.ts";
import { useChangeRead } from "../changes/useChangeRead.ts";
import { type PageHistoryProps, usePageHistory } from "../usePageHistory.ts";

export interface RevisionsPageProps extends PageHistoryProps {
  /**
   * The address: `?commit=` or `?proposal=` names the revision shown. The page
   * is mounted on the Model place only, so the path is not read.
   */
  location: Pick<RevisionLocation, "search">;
  /** Changes when the runtime moves: the history is read again. */
  revisionKey?: string | number;
  /**
   * The operators that own a runtime: they name the proposers (one the roster
   * lacks is left unnamed) and are the ones the model can be put in service
   * for. Read-only operators are not among them.
   */
  operators?: readonly RuntimeOperator[];
  /**
   * Everyone the system's roster can name as the author of a change, when that
   * is more than the operators above; they name the authors otherwise.
   */
  names?: AuthorRoster;
  /** Read-only authority facts for the exact selected commit, when available. */
  authorityForCommit?(commit: SourceCommit): ComponentChildren;
  /** For relative dates; the clock when absent. */
  now?: number;
}

/**
 * What the Revisions page lives on: the history read on mount and again when
 * the address, the runtime, the operators or a decision anywhere moves it, the
 * list shown, the revision it selects and the changes of that revision, read
 * once they are wanted, and what is in service for each operator. The page
 * itself only draws what this returns.
 */
export function useRevisionsPage(props: RevisionsPageProps) {
  const location = {
    pathname: PLACE_PATH.model,
    search: props.location.search,
  };
  const asked = synchronizeRevisionLocation({}, location).inspection.selection;
  const inspected = useRef(asked);
  inspected.current = asked;
  const history = usePageHistory(props, () => inspected.current);
  const snapshot = history.snapshot.value;
  // A commit that is the version of a proposal names that proposal: it is not
  // on main, so the history can only know it as a proposal.
  const named = asked && snapshot ? resolveRevision(snapshot, asked) : asked;

  // The list follows the address in the render the address arrives in: the
  // revision it names is never drawn under the other list for a frame.
  const addressed = named && `${named.kind}:${named.id}`;
  const [chosen, choose] = useState<
    { tab: RevisionTab; addressed: string | undefined }
  >({ tab: named?.kind ?? "commit", addressed });
  let tab = chosen.tab;
  if (chosen.addressed !== addressed) {
    tab = named?.kind ?? chosen.tab;
    choose({ tab, addressed });
  }
  useRevisionLocationRefresh(
    location,
    props.revisionKey,
    history.refresh,
    history.cancel,
    props.sources.generation.value,
  );
  // The roster can arrive after the page: each operator is asked what it runs.
  const roster = (props.operators ?? []).map((operator) => operator.nativeId)
    .join("\n");
  const rostered = useRef(roster);
  useEffect(() => {
    if (rostered.current === roster) return;
    rostered.current = roster;
    void history.refresh();
  }, [history, roster]);
  const [picked, pick] = useState<string>();

  const shown = snapshot && shownRevision(snapshot, tab, named);
  const view = snapshot && shown?.item &&
    revisionView(
      snapshot,
      shown.selection,
      shown.item,
      props.names ?? props.operators ?? [],
    );
  const initial = view?.kind === "commit" &&
    snapshot?.history.commits.some((commit) =>
      commit.version === view.id && commit.parents.length === 0
    );
  const { diff, retry } = useChangeRead(
    history,
    !initial && view?.target
      ? { base: view.base, target: view.target }
      : undefined,
    snapshot,
  );

  const runtimes = history.runtimes.value;
  return {
    history,
    snapshot,
    tab,
    setTab: (next: RevisionTab) => choose({ tab: next, addressed }),
    shown,
    view,
    diff,
    retryDiff: retry,
    /** What each operator has in service: the "running" chips. */
    running: runningVersions(runtimes),
    /** The operators the head of main can be put in service for. */
    offers: history.offers.value,
    /** No operator is running: the host refuses to put the model in service. */
    idle: operatorsIdle(props.operators),
    /** The operators whose runtime could not be read. */
    unread: runtimes.flatMap((entry) =>
      entry.state === "failed"
        ? [{ operator: entry.operator, problem: entry.problem }]
        : []
    ),
    /** The operator picked to receive it; the first offer when none. */
    chosen: picked,
    chooseOperator: pick,
  };
}
