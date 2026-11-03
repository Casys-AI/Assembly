import type { ComponentChildren } from "preact";
import { since } from "../../../lib/cases/cases.ts";
import { activityFiles } from "../../../lib/model/revisions/activity.ts";
import type {
  DiffState,
  HistoryProblem,
} from "../../../lib/model/revisions/history.ts";
import {
  type DiffStats,
  diffStats,
  filesLabel,
  outcomeLabel,
  shortCommit,
} from "../../../lib/model/revisions/change.ts";
import {
  type DiffMode,
  revisionInspectionHref,
  type SourceCommit,
} from "../../../lib/model/revisions/api.ts";
import type { RevisionView } from "../../../lib/model/revisions/rows.ts";
import { AcceptDecline } from "../../conversations/ChatProposalCard.tsx";
import {
  ChangeLayout,
  LineCounts,
  ModelChangeView,
} from "../changes/ModelChangeCard.tsx";
import { Problem } from "../../view/Problem.tsx";

/** The exact date and time, for the tooltip of a relative one. */
export const exactDate = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.valueOf()) ? at : new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  })
    .format(date);
};

const noChanges: DiffStats = { additions: 0, deletions: 0, files: 0 };

/**
 * The selected revision beside the list: its title, who made it and when, the
 * commit it stands on, the size of its changes and the exact .sysml diff, all
 * through the one presentation of a change to the model. A proposal that waits
 * carries Accept and Decline; they act only on changes the page has shown.
 */
export function RevisionDetail(
  {
    view,
    diff,
    mode,
    onModeChange,
    available,
    deciding,
    refusal,
    onDecide,
    onRetryDiff,
    files,
    sourceCommit,
    authority,
    tagAction,
    now,
  }: {
    view: RevisionView;
    /** The changes, as far as they are read; none for a proposal in the making. */
    diff: DiffState | undefined;
    mode: DiffMode;
    onModeChange(mode: DiffMode): void;
    /** A settled read, and no decision in flight anywhere. */
    available: boolean;
    /** This proposal's decision is in flight. */
    deciding: boolean;
    /** Why the last decision on this proposal was not recorded. */
    refusal?: HistoryProblem;
    onDecide(verdict: "approve" | "refuse"): void;
    onRetryDiff(): void;
    /** The files the change touches, above the diff, when the page lists them. */
    files?: ComponentChildren;
    /** Git's selected commit, including its actual parentage and changed files. */
    sourceCommit?: SourceCommit;
    /** Read-only facts supplied by the exact commit's recorded decision. */
    authority?: ComponentChildren;
    tagAction?: ComponentChildren;
    now?: number;
  },
) {
  const ready = diff?.status === "ready" ? diff.diff : undefined;
  const stats = ready ? diffStats(ready) : noChanges;
  const initial = view.kind === "commit" &&
    sourceCommit?.version === view.id && sourceCommit.parents.length === 0;
  if (initial) {
    return (
      <InitialRevisionDetail
        view={view}
        commit={sourceCommit}
        authority={authority}
        tagAction={tagAction}
        mode={mode}
        onModeChange={onModeChange}
      />
    );
  }
  // A decision is made on changes that were read and shown, never blind.
  const decidable = view.decidable && available && Boolean(ready);
  return (
    <section
      // Until the changes are read there are no totals to show, not zeros.
      class={`rev-detail${ready ? "" : " is-unread"}`}
      aria-label="Revision"
    >
      <ModelChangeView
        id={view.id}
        title={view.title}
        author={view.kind === "proposal" ? view.author : undefined}
        commit={view.commit}
        commitLabel={view.commitLabel}
        stats={stats}
        patch={ready?.patch ?? ""}
        mode={mode}
        onModeChange={onModeChange}
        state={view.state}
        layout="header"
        notice={view.notice}
        actions={view.decidable
          ? (
            <AcceptDecline
              busy={deciding}
              disabled={!decidable}
              onDecide={onDecide}
            />
          )
          : undefined}
        // A refused decision is told where it was asked for, above the diff.
        panel={
          <>
            {refusal && <Problem problem={refusal} />}
            {view.kind === "proposal" && view.reason && (
              <section class="rev-description" aria-label="Proposal reason">
                <h4>Reason</h4>
                <p>{view.reason}</p>
              </section>
            )}
            {files}
            {tagAction}
          </>
        }
        footer={
          <>
            {diff?.status === "loading" && (
              <p class="rev-reading" role="status">Reading the changes…</p>
            )}
            {ready && ready.files.length === 0 && (
              <p class="rev-reading">No source changes.</p>
            )}
            {diff?.status === "failed" && (
              <Problem problem={diff.problem}>
                <button type="button" class="rev-retry" onClick={onRetryDiff}>
                  Try again
                </button>
              </Problem>
            )}
          </>
        }
      >
        {view.kind === "commit" && authority}
        <p class="change-byline">
          {view.kind === "commit" && view.author && <span>{view.author}</span>}
          {view.kind === "proposal" && view.branch && (
            <span class="rev-branch" title={view.branch}>{view.branch}</span>
          )}
          <time dateTime={view.createdAt} title={exactDate(view.createdAt)}>
            {since(view.createdAt, now)}
          </time>
          {view.kind === "proposal" && view.state !== "pending" && (
            <span class={`change-chip is-${view.state}`}>
              {outcomeLabel[view.state]}
            </span>
          )}
          {view.kind === "proposal" && view.proposalStatus === "proposed" && (
            <span class="rev-status is-pending">Proposed</span>
          )}
          {view.mergedAs && (
            // Stated either way: Fresh marks a link to the current path.
            <a
              href={revisionInspectionHref({
                selection: { kind: "commit", id: view.mergedAs },
              })}
              aria-current="false"
            >
              merged as {shortCommit(view.mergedAs)}
            </a>
          )}
        </p>
      </ModelChangeView>
    </section>
  );
}

/** The first admission is a file inventory, exactly as in the reference mock.
 * Git already supplies its counts: reading or rendering an all-added patch
 * adds no information here. Every file opens at this immutable commit. */
function InitialRevisionDetail(
  { view, commit, mode, onModeChange, authority, tagAction }: {
    view: RevisionView;
    commit: SourceCommit;
    mode: DiffMode;
    onModeChange(mode: DiffMode): void;
    authority?: ComponentChildren;
    tagAction?: ComponentChildren;
  },
) {
  const files = activityFiles({
    files: commit.files,
    version: commit.version,
    main: false,
  });
  const date = new Date(view.createdAt);
  const when = Number.isNaN(date.valueOf())
    ? view.createdAt
    : date.toLocaleString("en", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <section class="rev-detail rev-initial" aria-label="Revision">
      <header class="rev-initial-head">
        <h2>{view.title}</h2>
        <div class="rev-initial-meta">
          {view.author && (
            <>
              <span>{view.author}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <time dateTime={view.createdAt} title={exactDate(view.createdAt)}>
            {when}
          </time>
          <span aria-hidden="true">·</span>
          <code title={commit.version}>{shortCommit(commit.version)}</code>
        </div>
      </header>
      {authority}
      {tagAction}
      <div class="rev-initial-bar">
        <span class="rev-initial-stats">
          <span class="plus">+{commit.additions}</span>
          <span class="minus">−{commit.deletions}</span>
          <span class="faint">{filesLabel(commit.files.length)}</span>
        </span>
        <ChangeLayout mode={mode} onChange={onModeChange} />
      </div>
      <ul class="rev-initial-files" aria-label="Changed files">
        {files.map((file) => {
          const content = (
            <>
              <span class={`rev-initial-status is-${file.status}`}>
                {file.status === "modified"
                  ? "changed"
                  : file.status === "deleted"
                  ? "removed"
                  : file.status}
              </span>
              <code>{file.path}</code>
              <LineCounts
                additions={file.additions}
                deletions={file.deletions}
              />
            </>
          );
          return (
            <li key={file.path}>
              {file.href
                ? <a href={file.href} aria-current="false">{content}</a>
                : <span class="rev-initial-file">{content}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
