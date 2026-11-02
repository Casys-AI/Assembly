import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import {
  type ChangeOutcome,
  changeOutcome,
  type ChangeWithDiff,
  type DiffStats,
  diffStats,
  filesLabel,
  outcomeLabel,
  shortCommit,
} from "../../../lib/model/revisions/change.ts";
import {
  changeScope,
  changeTitle,
} from "../../../lib/conversations/proposal-differences.ts";
import type { DiffMode } from "../../../lib/model/revisions/api.ts";
import {
  ProposalAdjustment,
  ProposalButtons,
  type ProposalDecisionProps,
  useProposalDecision,
} from "../../conversations/ChatProposalCard.tsx";
import { ProposalCodeDiff } from "./ProposalCodeDiff.tsx";

const layouts: readonly (readonly [DiffMode, string])[] = [
  ["line-by-line", "Unified"],
  ["side-by-side", "Split"],
];

/** "+n −m": the lines gained and lost; `children` follow in the same line. */
export function LineCounts(
  { additions, deletions, children }: {
    additions: number;
    deletions: number;
    children?: ComponentChildren;
  },
) {
  return (
    <span class="change-stats">
      <span class="plus">+{additions}</span>{" "}
      <span class="minus">−{deletions}</span>
      {children}
    </span>
  );
}

/** "+n −m · k files", from totals already known. */
export function StatsLine({ additions, deletions, files }: DiffStats) {
  return (
    <LineCounts additions={additions} deletions={deletions}>
      {" "}
      <span class="faint">· {filesLabel(files)}</span>
    </LineCounts>
  );
}

/** Unified or Split, for the diff beside it. */
export function ChangeLayout(
  { mode, onChange }: { mode: DiffMode; onChange(mode: DiffMode): void },
) {
  return (
    <div class="change-layout" role="group" aria-label="Diff layout">
      {layouts.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value ? "true" : "false"}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** What a change touches, as one line of short parts. */
function ChangeScope({ change }: { change: ChangeWithDiff }) {
  const scope = changeScope(change);
  return scope.length > 0
    ? (
      <p class="change-scope">
        {scope.map((part, index) => <span key={index}>{part}</span>)}
      </p>
    )
    : null;
}

/**
 * The commit a change stands on. Before publication it is the base the diff
 * applies to; afterwards it is the commit that published it.
 */
function changeCommit(change: ChangeWithDiff) {
  const published = change.status === "approved"
    ? change.publishedCommit
    : undefined;
  return {
    commit: published ?? change.diff.base?.repositoryVersion,
    label: published ? "Published commit" : "Base commit",
  };
}

/** Who proposed, the short commit (full one in a tooltip) and the size. */
function ChangeByline(
  { proposedBy, commit, commitLabel = "Commit", stats }: {
    proposedBy?: string;
    commit?: string;
    commitLabel?: string;
    stats: DiffStats;
  },
) {
  return (
    <p class="change-byline">
      {proposedBy && <span>proposed by {proposedBy}</span>}
      {commit && (
        <code title={`${commitLabel} ${commit}`}>{shortCommit(commit)}</code>
      )}
      <StatsLine {...stats} />
    </p>
  );
}

export interface ModelChangeViewProps {
  /** Identifies the element; the chat scrolls to a pending one. */
  id?: string;
  title: string;
  /** The proposer's name in the roster, never its identity. */
  author?: string;
  /** Short or full; shown short, the full value in a tooltip. */
  commit?: string;
  /** Leads the commit's tooltip: "Base commit", "Published commit"... */
  commitLabel?: string;
  stats: DiffStats;
  /** The Git diff of the .sysml sources; without one there is no diff. */
  patch: string;
  /** Controls the layout when given; otherwise the view keeps its own. */
  mode?: DiffMode;
  onModeChange?(mode: DiffMode): void;
  state: ChangeOutcome;
  /** Open while pending and folded once decided, unless told otherwise. */
  open?: boolean;
  /**
   * "shown" (the default): the diff and its layout toggle sit on the card;
   * "folded": both wait in a closed fold under the actions.
   */
  diff?: "shown" | "folded";
  /**
   * "header": the plain title and facts, no chip, nothing to fold; "receipt":
   * a fold that carries the state's chip. By default a pending change that is
   * open reads as a header and anything else as a receipt. A caller whose
   * controls are still busy on a decided change asks for the header, so the
   * controls do not move under a chip.
   */
  layout?: "header" | "receipt";
  /** Replaces the state's name on the chip of a decided change. */
  statusLabel?: string;
  /** Rendered only while pending, beside the layout toggle. */
  actions?: ComponentChildren;
  notice?: string;
  /** Extra facts under the title, above the byline. */
  children?: ComponentChildren;
  /** Between the actions and the diff: a form the actions opened. */
  panel?: ComponentChildren;
  /** After the diff: a reason, an error. */
  footer?: ComponentChildren;
}

/**
 * The shared presentation of a change to the model: title, who proposed it,
 * the commit it stands on, "+n −m · k files", then the exact .sysml diff
 * (Unified or Split). Case conversations and the Model views (Activity,
 * Revisions) all show a change through it. It decides nothing by itself: the
 * caller supplies the state and, while pending, the actions.
 */
export function ModelChangeView(props: ModelChangeViewProps) {
  const { state, patch } = props;
  const [own, setOwn] = useState<DiffMode>("line-by-line");
  const mode = props.mode ?? own;
  const choose = (next: DiffMode) => {
    if (props.mode === undefined) setOwn(next);
    props.onModeChange?.(next);
  };
  const pending = state === "pending";
  const open = props.open ?? pending;
  const layout = props.layout ?? (pending && open ? "header" : "receipt");
  const facts = (
    <>
      {props.children}
      <ChangeByline
        proposedBy={props.author}
        commit={props.commit}
        commitLabel={props.commitLabel}
        stats={props.stats}
      />
    </>
  );
  const folded = props.diff === "folded";
  const actions = pending && props.actions;
  const toggle = patch && <ChangeLayout mode={mode} onChange={choose} />;
  const code = patch && <ProposalCodeDiff patch={patch} mode={mode} />;
  const body = (
    <>
      {props.notice && (
        <p class="proposal-notice" role="status">{props.notice}</p>
      )}
      {(actions || (!folded && toggle)) && (
        <div class="change-bar">
          {actions && <div class="proposal-actions">{actions}</div>}
          {!folded && toggle}
        </div>
      )}
      {props.panel}
      {folded
        ? patch && (
          <details class="change-diff">
            <summary>View diff</summary>
            <div class="change-bar">{toggle}</div>
            {code}
          </details>
        )
        : code}
      {props.footer}
    </>
  );
  return (
    <article
      class={`chat-proposal model-change ${
        pending ? "is-pending" : `is-settled is-${state}`
      }`}
      data-proposal-id={props.id}
      aria-label={props.title}
    >
      {layout === "header"
        ? (
          <>
            <header class="proposal-heading change-heading">
              <div>
                <h3>{props.title}</h3>
                {facts}
              </div>
            </header>
            {body}
          </>
        )
        : (
          <details class="proposal-receipt" {...(open ? { open: true } : {})}>
            <summary>
              <span>{props.title}</span>
              <span class={`change-chip is-${state}`}>
                {props.statusLabel ?? outcomeLabel[state]}
              </span>
            </summary>
            <div class="change-heading">{facts}</div>
            {body}
          </details>
        )}
    </article>
  );
}

export interface ModelChangeCardProps extends ProposalDecisionProps {
  /** Identifies the element; the chat scrolls to a pending one. */
  id: string;
  change: ChangeWithDiff;
  /** The proposer's name in the roster, never its identity. */
  proposedBy?: string;
  notice?: string;
  authority?: ComponentChildren;
  actionsEnabled?: boolean;
  retryStatus?: string;
  onRetryApplying?(): void;
  retryLabel?: string;
  retryDisabled?: boolean;
}

/**
 * A change to the model that reads like a pull request: what it does, who
 * proposed it, the commit it stands on, how big it is, then the exact .sysml
 * diff (Diff2Html, Unified or Split). Accept and Decline sit on the card while
 * it waits; once decided it folds to one line with its outcome. The
 * presentation is ModelChangeView; this card only brings the decision to it.
 */
export function ModelChangeCard(props: ModelChangeCardProps) {
  const { change } = props;
  const state = changeOutcome(change);
  const flow = useProposalDecision(props);
  const { commit, label } = changeCommit(change);
  // While a decision is being made or sent, the card keeps its plain header,
  // even once the host has already moved the change: the form and buttons
  // stay where they are instead of being remounted under a chip.
  const busy = state === "pending" || flow.adjusting || flow.pending;
  return (
    <ModelChangeView
      id={props.id}
      title={changeTitle(change)}
      author={props.proposedBy}
      commit={commit}
      commitLabel={label}
      stats={diffStats(change.diff)}
      patch={change.diff.patch}
      // In a conversation the card says what changes; the diff waits a click.
      diff="folded"
      state={state}
      layout={busy ? "header" : "receipt"}
      statusLabel={props.retryStatus ??
        (flow.sent ? "Adjustment requested" : undefined)}
      notice={props.notice}
      actions={props.actionsEnabled === false || flow.adjusting
        ? undefined
        : (
          <ProposalButtons
            flow={flow}
            disabled={props.disabled}
            acceptDisabled={props.acceptDisabled}
            adjustDisabled={props.adjustDisabled}
          />
        )}
      panel={flow.adjusting
        ? (
          <ProposalAdjustment
            id={props.id}
            flow={flow}
            adjustDisabled={props.adjustDisabled}
          />
        )
        : undefined}
      footer={
        <>
          {props.onRetryApplying && (
            <button
              type="button"
              disabled={props.retryDisabled}
              onClick={props.onRetryApplying}
            >
              {props.retryLabel ?? "Retry applying"}
            </button>
          )}
          {change.reason && (
            <details class="proposal-rationale">
              <summary>Reason</summary>
              <p>{change.reason}</p>
            </details>
          )}
          {flow.error && <p class="proposal-error" role="alert">{flow.error}
          </p>}
        </>
      }
    >
      <ChangeScope change={change} />
      {props.authority}
    </ModelChangeView>
  );
}
