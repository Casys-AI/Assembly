import { useEffect, useMemo, useRef } from "preact/hooks";
import {
  createModelHistory,
  type ModelHistory,
} from "../../lib/model/revisions/history.ts";
import {
  createRevisionApi,
  type RevisionSelection,
  type RuntimeOperator,
} from "../../lib/model/revisions/api.ts";
import type { ModelLive } from "../../lib/model/live.ts";
import type { SharedSources } from "../../lib/model/sources/command.ts";
import { useModelLive } from "../view/useModelLive.ts";

/** What a page needs to read the history and to decide on it. */
export interface PageHistoryProps {
  /** The source state shared with the conversations: one decision in flight. */
  sources: SharedSources;
  /** The model's sources changed: the other views read again. */
  onChanged(): void | Promise<void>;
  /**
   * The operators the history asks what they run along with each read; a page
   * with no use for that leaves them out.
   */
  operators?: readonly RuntimeOperator[];
  /** The history, when the caller owns it; the page reads its own otherwise. */
  history?: ModelHistory;
  /** The host's word on the model, when it moves; the tab's own when absent. */
  live?: ModelLive;
}

/**
 * The history a page of the Model place reads, made once and let go with the
 * page. Every page decides through it, and so through the one change in flight
 * of `sources`: a decision made on one page is a change to all of them. It is
 * read again when the host announces that the model moved (a proposal made or
 * decided, the head advanced), whoever did it. The host has no address for the
 * history by version: it is read at the head, and a read already in flight
 * reads once more rather than a second one starting.
 */
export function usePageHistory(
  props: PageHistoryProps,
  /** The revision the address names: a read keeps it in the list. */
  named: () => RevisionSelection | undefined = () => undefined,
): ModelHistory {
  const latest = useRef(props);
  latest.current = props;
  const history = useMemo(() =>
    props.history ?? createModelHistory({
      api: createRevisionApi(),
      sources: props.sources,
      selection: named,
      onChanged: () => latest.current.onChanged(),
      operators: () => latest.current.operators ?? [],
    }), [props.history, props.sources]);
  useEffect(() => () => {
    if (!props.history) history.dispose();
  }, [history]);
  useModelLive(() => history.refresh(), props.live);
  return history;
}
