import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import {
  type ChangeOutcome,
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
  memberFacts,
} from "../../../lib/conversations/proposal-differences.ts";
import {
  decisionLabel,
  type DecisionPhase,
  type DecisionState,
} from "../../../lib/conversations/decision-state.ts";
import {
  isTeamOperatorSpec,
  type TeamOperatorSpec,
} from "../../../../src/domain/governance/operator-authority.ts";
import { monogram } from "../../../lib/workbench/desk.ts";
import { Icon } from "../../view/Icon.tsx";
import {
  ChangeInspector,
  DecisionChip,
} from "../../conversations/DecisionParts.tsx";
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
 * Who proposed, the short commit (full one in a tooltip) and the size; a size
 * that labels the fold of the diff is not repeated here.
 */
function ChangeByline(
  { proposedBy, commit, commitLabel = "Commit", stats }: {
    proposedBy?: string;
    commit?: string;
    commitLabel?: string;
    stats?: DiffStats;
  },
) {
  if (!proposedBy && !commit && !stats) return null;
  return (
    <p class="change-byline">
      {proposedBy && <span>proposed by {proposedBy}</span>}
      {commit && (
        <code title={`${commitLabel} ${commit}`}>{shortCommit(commit)}</code>
      )}
      {stats && <StatsLine {...stats} />}
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
  state: ChangeOutcome | DecisionPhase;
  /** Open while pending and folded once decided, unless told otherwise. */
  open?: boolean;
  /**
   * "shown" (the default): the diff and its layout toggle sit on the card;
   * "folded": both wait in a closed fold under the actions, labelled
   * "SysML +n −m".
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
  /**
   * Replaces the state's chip: drawn on the receipt, and on the header
   * beside the title.
   */
  status?: ComponentChildren;
  /** Before the title: the monogram of a member being created. */
  lead?: ComponentChildren;
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
  const pending = state === "pending" || state === "to-decide";
  const open = props.open ?? pending;
  const layout = props.layout ?? (pending && open ? "header" : "receipt");
  const folded = props.diff === "folded";
  const facts = (
    <>
      {props.children}
      <ChangeByline
        proposedBy={props.author}
        commit={props.commit}
        commitLabel={props.commitLabel}
        stats={folded && patch ? undefined : props.stats}
      />
    </>
  );
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
            <summary title={filesLabel(props.stats.files)}>
              SysML{" "}
              <LineCounts
                additions={props.stats.additions}
                deletions={props.stats.deletions}
              />
            </summary>
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
                <h3>{props.lead}{props.title}</h3>
                {facts}
              </div>
              {props.status}
            </header>
            {body}
          </>
        )
        : (
          <details class="proposal-receipt" {...(open ? { open: true } : {})}>
            <summary>
              <span>{props.lead}{props.title}</span>
              {props.status ?? (
                <span class={`change-chip is-${state}`}>
                  {{ ...outcomeLabel, ...decisionLabel }[state]}
                </span>
              )}
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
  /** "Decided by … · rule …", once a recorded receipt names the decider. */
  decidedBy?: string;
  /** Said on hover of the state: who decided, why it is still checking. */
  stateNote?: string;
  notice?: string;
  /** Authority facts, listed in the inspector under the change's own. */
  authority?: ComponentChildren;
  actionsEnabled?: boolean;
  /** Where the change stands (decision-state.ts). */
  decision: DecisionState;
  /**
   * Offered only while the host has a step left; a non-empty `reason` says,
   * on hover, why it cannot be retried now.
   */
  retry?: { label: string; reason: string; onRetry(): void };
}

const MEMBER_ICON = {
  request: "bubble",
  network: "globe",
  creation: "person",
} as const;

/** A new team member: its mission on two lines, then its rights as marks. */
function MemberFacts({ spec }: { spec: TeamOperatorSpec }) {
  return (
    <>
      <p class="member-mission" title={spec.instruction}>{spec.instruction}</p>
      <ul class="member-facts">
        {memberFacts(spec).map((fact) => (
          <li key={fact.kind} title={fact.detail}>
            <Icon name={MEMBER_ICON[fact.kind]} />
            {fact.label}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * A change to the model as a card: what it does, who proposed or decided it,
 * then the exact .sysml diff folded under "SysML +n −m". A new team member
 * reads as the member: monogram, name, mission and rights. Accept and Decline
 * sit on the card while it waits; once decided it folds to one line with its
 * state. Identities and commits wait in the byline's inspector. The
 * presentation is ModelChangeView; this card only brings the decision to it.
 */
export function ModelChangeCard(props: ModelChangeCardProps) {
  const { change, decision } = props;
  const flow = useProposalDecision(props);
  // While a decision is being made or sent, the card keeps its plain header,
  // even once the host has already moved the change: the form and buttons
  // stay where they are instead of being remounted under a chip.
  const busy = decision.phase === "to-decide" || flow.adjusting ||
    flow.pending;
  const member = change.operator && isTeamOperatorSpec(change.operator)
    ? change.operator
    : undefined;
  const title = member ? change.name || "New member" : changeTitle(change);
  const byline = props.decidedBy ??
    ([
      member && "New member",
      props.proposedBy && `proposed by ${props.proposedBy}`,
    ].filter(Boolean).join(" · ") || "Details");
  return (
    <ModelChangeView
      id={props.id}
      title={title}
      lead={member && (
        <span class="agent-tile member-mark" aria-hidden="true">
          {monogram(title)}
        </span>
      )}
      stats={diffStats(change.diff)}
      patch={change.diff.patch}
      // In a conversation the card says what changes; the diff waits a click.
      diff="folded"
      state={decision.phase}
      layout={busy ? "header" : "receipt"}
      // Folded once decided, unless something there waits for the person.
      open={decision.blocked || Boolean(props.notice) || Boolean(props.retry) ||
        Boolean(flow.error)}
      status={
        <DecisionChip
          decision={decision}
          label={flow.sent ? "Adjustment requested" : undefined}
          note={props.stateNote ?? props.decidedBy}
        />
      }
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
          {props.retry && (
            <button
              type="button"
              class="change-retry"
              disabled={Boolean(props.retry.reason)}
              title={props.retry.reason || undefined}
              onClick={props.retry.onRetry}
            >
              {props.retry.label}
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
      {member ? <MemberFacts spec={member} /> : <ChangeScope change={change} />}
      <ChangeInspector change={change} summary={byline}>
        {props.authority}
      </ChangeInspector>
    </ModelChangeView>
  );
}
