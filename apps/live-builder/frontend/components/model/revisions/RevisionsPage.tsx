import { useState } from "preact/hooks";
import type {
  DiffMode,
  RevisionSelection,
  RevisionSnapshot,
} from "../../../lib/model/revisions/api.ts";
import {
  commitRows,
  openProposals,
  proposalRows,
} from "../../../lib/model/revisions/rows.ts";
import { AdoptControl } from "./AdoptControl.tsx";
import { HistoryStatus } from "../HistoryStatus.tsx";
import { RevisionDetail } from "./RevisionDetail.tsx";
import { RevisionList } from "./RevisionList.tsx";
import { CreateTag } from "../CreateTag.tsx";
import {
  type RevisionsPageProps,
  useRevisionsPage,
} from "./useRevisionsPage.ts";

/**
 * Model > Revisions: main's commits and the proposals made to it on the left,
 * the one selected on the right with its changes. Accepting or declining a
 * proposal acts on the host, and so does putting the accepted model in service
 * from the row of main; nothing else on the page changes the model.
 */
export function RevisionsPage(props: RevisionsPageProps) {
  const {
    history,
    snapshot,
    tab,
    setTab,
    shown,
    view,
    diff,
    retryDiff,
    running,
    offers,
    idle,
    unread,
    chosen,
    chooseOperator,
  } = useRevisionsPage(props);
  const [mode, setMode] = useState<DiffMode>("line-by-line");
  const refusal = history.refusal.value;
  const adoptionRefusal = history.adoptionRefusal.value;
  const commit = view?.kind === "commit"
    ? snapshot?.history.commits.find((entry) => entry.version === view.id)
    : undefined;
  const authority = commit ? props.authorityForCommit?.(commit) : undefined;
  return (
    <div class="rev-page">
      <HistoryStatus history={history} snapshot={snapshot} />
      {snapshot && (
        <div class="rev">
          <RevisionList
            tab={tab}
            onTab={setTab}
            rows={tab === "commit"
              ? commitRows(snapshot, running, props.names ?? props.operators)
              : proposalRows(snapshot, props.names ?? props.operators)}
            open={openProposals(snapshot)}
            outOfService={offers.length}
            service={
              <AdoptControl
                offers={offers}
                chosen={chosen}
                onChoose={chooseOperator}
                adopting={history.adopting.value}
                available={history.canAct.value}
                idle={idle}
                refusal={adoptionRefusal ?? undefined}
                unread={unread}
                onAdopt={(agentId) => void history.adopt(agentId)}
              />
            }
            shown={shown?.selection}
            now={props.now}
          />
          {view
            ? (
              <RevisionDetail
                view={view}
                sourceCommit={commit}
                authority={authority}
                tagAction={commit &&
                    /^commit:[a-f0-9]{40}$/.test(commit.version)
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
                onDecide={(verdict) =>
                  void history.decideById(view.id, verdict)}
                onRetryDiff={retryDiff}
                now={props.now}
              />
            )
            : shown && (
              <Absent selection={shown.selection} snapshot={snapshot} />
            )}
        </div>
      )}
    </div>
  );
}

/**
 * The revision the address names is not among the ones read. A commit may only
 * be older than the history reaches, which was cut short; the host lists no
 * more than the longest it was read at.
 */
function Absent(
  { selection, snapshot }: {
    selection: RevisionSelection;
    snapshot: RevisionSnapshot;
  },
) {
  const { truncated, commits } = snapshot.history;
  return selection.kind === "commit" && truncated
    ? (
      <p class="rev-empty" data-code="revision-older">
        This revision is older than the {commits.length} latest commits.
      </p>
    )
    : (
      <p class="rev-empty" data-code="revision-absent">
        This revision is not in the loaded history.
      </p>
    );
}
