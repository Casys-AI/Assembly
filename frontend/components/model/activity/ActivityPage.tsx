import { useRef, useState } from "preact/hooks";
import {
  candidatePresentation,
  type CandidateState,
} from "../../../lib/system/tools/candidates.ts";
import {
  type ToolProposalSelection,
  toolProposalSelection,
} from "../../../lib/model/tool-proposal-location.ts";
import type { WorkbenchState } from "../../../lib/workbench/state.ts";
import type { DiffMode } from "../../../lib/model/revisions/api.ts";
import { ActivityItem } from "./ActivityItem.tsx";
import { CreateTag } from "../CreateTag.tsx";
import { ChangedFiles } from "../changes/ChangedFiles.tsx";
import { HistoryStatus } from "../HistoryStatus.tsx";
import {
  createToolProposalSession,
  ToolProposalDetail,
  type ToolProposalSession,
} from "../changes/ToolProposalDetail.tsx";
import { RevisionDetail } from "../revisions/RevisionDetail.tsx";
import { type ActivityPageProps, useActivityPage } from "./useActivityPage.ts";

type ToolSelection = Exclude<ToolProposalSelection, { kind: "none" }>;
interface ToolNotification {
  key: string;
  title: string;
  byline: string;
  createdAt?: string;
  status: CandidateState;
  selection: ToolSelection;
}
const toolKey = (selection: ToolSelection) =>
  JSON.stringify(
    selection.kind === "selected"
      ? [
        "tool",
        selection.target.operator,
        selection.target.candidate,
        selection.target.digest,
      ]
      : ["tool-address", selection.message],
  );

/** Current runtime observations only; no source proposal, commit or file diff is synthesized. */
function toolNotifications(
  state: WorkbenchState | undefined,
  selection: ToolProposalSelection,
) {
  const waiting: ToolNotification[] = [];
  const observed: ToolNotification[] = [];
  if (state && !state.readOnly.value && !state.graphSourceSelection.value) {
    const read = {
      catalogue: state.visibleOperatorTools.value,
      loading: state.operatorTools.loading.value,
      stale: state.operatorTools.stale.value,
      error: state.operatorTools.error.value,
    };
    const roster = state.conversationSnapshot.value?.conversations ?? [];
    for (const tool of read.catalogue?.tools ?? []) {
      const owner = roster.find((entry) => entry.agentId === tool.agentId);
      if (!owner) continue;
      const selected: ToolSelection = {
        kind: "selected",
        target: {
          operator: tool.agentId,
          candidate: tool.candidate.id,
          digest: tool.candidate.digest,
        },
      };
      const notification: ToolNotification = {
        key: toolKey(selected),
        selection: selected,
        title: tool.candidate.name,
        byline: `proposed by ${owner.name || tool.agentName || "An operator"}`,
        createdAt: tool.candidate.createdAt,
        status: candidatePresentation(tool, read).state,
      };
      observed.push(notification);
      if (!["active", "refused", "failed"].includes(tool.candidate.stage)) {
        waiting.push(notification);
      }
    }
  }
  const selected = selection.kind === "none" ||
      waiting.some((entry) => entry.key === toolKey(selection))
    ? undefined
    : observed.find((entry) => entry.key === toolKey(selection)) ?? {
      key: toolKey(selection),
      selection,
      title: "Tool proposal",
      byline: selection.kind === "selected"
        ? `Operator ${selection.target.operator}`
        : "",
      status: { label: "Selected proposal", tone: "plain" as const },
    };
  return { waiting, selected, observed };
}

/**
 * Model > Activity: the life of the model as a feed, like notifications. What
 * waits for the person comes first, then what main accepted, then what was
 * declined; one line each. A line opens its change in place, one at a time:
 * the files it touches, which are links to Files, and the exact diff. A
 * proposal that waits is accepted or declined there, through the same single
 * decision in flight as the Revisions page and the conversations.
 */
export function ActivityPage(props: ActivityPageProps) {
  const selection = props.location
    ? toolProposalSelection(props.location)
    : { kind: "none" as const };
  const notifications = toolNotifications(props.state, selection);
  const target = selection.kind === "none" ? props.open : toolKey(selection);
  const {
    history,
    snapshot,
    groups,
    opened,
    toggle,
    row,
    view,
    diff,
    files,
    decide,
    retryDiff,
  } = useActivityPage({ ...props, open: target });
  const sessions = useRef(
    new Map<
      string,
      { entry: ToolNotification; session: ToolProposalSession }
    >(),
  );
  for (
    const entry of [
      ...notifications.observed,
      ...(notifications.selected ? [notifications.selected] : []),
    ]
  ) {
    const session = sessions.current.get(entry.key);
    if (session) session.entry = entry;
    else {sessions.current.set(entry.key, {
        entry,
        session: createToolProposalSession(),
      });}
  }
  const contexts = [...sessions.current.values()].filter(({ entry, session }) =>
    (!props.state?.readOnly.value ||
      entry.key === notifications.selected?.key) &&
    !notifications.waiting.some((waiting) => waiting.key === entry.key) &&
    (entry.key === opened || session.workflow.adjusting.value ||
      session.workflow.pending.value)
  );
  const [mode, setMode] = useState<DiffMode>("line-by-line");
  const refusal = history.refusal.value;
  const commit = view?.kind === "commit"
    ? snapshot?.history.commits.find((entry) => entry.version === view.id)
    : undefined;
  const authority = commit ? props.authorityForCommit?.(commit) : undefined;
  const waiting = groups.find((group) => group.id === "waiting");
  const toolRow = (entry: ToolNotification) => (
    <ActivityItem
      key={entry.key}
      row={{ ...entry, main: false }}
      toolState={entry.status}
      open={entry.key === opened ||
        Boolean(
          sessions.current.get(entry.key)?.session.workflow.adjusting.value,
        ) ||
        Boolean(
          sessions.current.get(entry.key)?.session.workflow.pending.value,
        )}
      onToggle={() => toggle(entry.key)}
      now={props.now}
    >
      {props.state && (
        <ToolProposalDetail
          state={props.state}
          selection={entry.selection}
          session={sessions.current.get(entry.key)?.session}
        />
      )}
    </ActivityItem>
  );
  const sourceRow = (entry: NonNullable<typeof waiting>["rows"][number]) => (
    <ActivityItem
      key={entry.key}
      row={entry}
      open={entry.key === opened}
      onToggle={() => toggle(entry.key)}
      now={props.now}
    >
      {row === entry && view && (
        <RevisionDetail
          view={view}
          authority={authority}
          tagAction={commit && /^commit:[a-f0-9]{40}$/.test(commit.version)
            ? (
              <CreateTag
                key={commit.version}
                source={{
                  branch: { kind: "main" },
                  sourceVersion: commit.version,
                }}
              />
            )
            : undefined}
          diff={diff}
          mode={mode}
          onModeChange={setMode}
          available={history.canAct.value}
          deciding={history.deciding.value === view.id}
          refusal={refusal?.id === view.id ? refusal.problem : undefined}
          onDecide={decide}
          onRetryDiff={retryDiff}
          files={files && <ChangedFiles files={files} />}
          now={props.now}
        />
      )}
    </ActivityItem>
  );
  return (
    <div class="act-page">
      <HistoryStatus history={history} snapshot={snapshot} />
      {contexts.length > 0 && (
        <section class="act-group" data-group="tool-selection">
          <h2 class="act-group-label">Tool proposal</h2>
          <ul class="act-list">
            {contexts.map(({ entry }) =>
              toolRow(entry)
            )}
          </ul>
        </section>
      )}
      {(notifications.waiting.length > 0 || waiting) && (
        <section class="act-group" data-group="waiting">
          <h2 class="act-group-label">Waiting for you</h2>
          <ul class="act-list">
            {notifications.waiting.map(toolRow)}
            {waiting?.rows.map(sourceRow)}
          </ul>
        </section>
      )}
      {groups.filter((group) => group.id !== "waiting").map((group) => (
        <section class="act-group" key={group.id} data-group={group.id}>
          <h2 class="act-group-label">{group.label}</h2>
          <ul class="act-list">{group.rows.map(sourceRow)}</ul>
        </section>
      ))}
      {snapshot && groups.length === 0 && notifications.waiting.length === 0 &&
        contexts.length === 0 && <p class="rev-empty">No activity yet.</p>}
      {snapshot?.history.truncated && (
        <p class="rev-empty">Older commits are not shown.</p>
      )}
    </div>
  );
}
