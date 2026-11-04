import type { ComponentChildren } from "preact";
import type { PendingChange } from "../../../src/domain/governance/records/pending-change.ts";
import { caseHref } from "../../lib/cases/cases.ts";
import {
  APPLYING_STEPS,
  applyingSteps,
  decisionLabel,
  type DecisionState,
} from "../../lib/conversations/decision-state.ts";

/** One exact value: its label, the value, and the identity behind a name. */
export interface Fact {
  label: string;
  value: ComponentChildren;
  identity?: string;
}

/** Exact values, label then value, as an inspector lists them. */
export function FactList({ facts }: { facts: readonly Fact[] }) {
  return (
    <dl class="fact-list">
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>
            {fact.value}
            {fact.identity && <code>{fact.identity}</code>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Where a decision stands, as one chip. Applying shows how far it went in
 * dots; until a Request's record is read it only says it is checking. The
 * tooltip names the steps, then what the caller adds: who decided, why.
 */
export function DecisionChip(
  { decision, label, note }: {
    decision: DecisionState;
    /** Replaces the state's name: an adjustment the person asked for. */
    label?: string;
    note?: string;
  },
) {
  const steps = decision.phase === "applying" && !decision.checking;
  const title = [label, steps ? applyingSteps(decision) : undefined, note]
    .filter(Boolean).join(" · ");
  return (
    <span
      class={`change-chip is-${decision.phase}${
        decision.blocked ? " is-blocked" : ""
      }`}
      title={title || undefined}
    >
      {label ??
        (decision.checking ? "Checking…" : decisionLabel[decision.phase])}
      {steps && (
        <span class="chip-steps" aria-hidden="true">
          {APPLYING_STEPS.map((step, index) => (
            <span
              key={step}
              class={index < decision.reached ? "is-done" : undefined}
            />
          ))}
        </span>
      )}
    </span>
  );
}

/** A change's own exact values: its identity, its Request, its commit. */
function changeFacts(change: PendingChange): Fact[] {
  const published = change.status === "approved"
    ? change.publishedCommit
    : undefined;
  const base = change.diff?.base.repositoryVersion;
  return [
    { label: "Change", value: change.id },
    ...(change.caseId
      ? [{
        label: "Request",
        value: <a href={caseHref(change.caseId)}>{change.caseId}</a>,
      }]
      : []),
    ...(published
      ? [{ label: "Published commit", value: <code>{published}</code> }]
      : base
      ? [{ label: "Base commit", value: <code>{base}</code> }]
      : []),
    ...(change.designerScopeId
      ? [{
        label: "Design conversation",
        value: <code>{change.designerScopeId}</code>,
      }]
      : []),
  ];
}

/**
 * A change's byline, which opens in place on its exact values: identity,
 * Request, commit, then the authority facts the caller read for it. It
 * decides nothing.
 */
export function ChangeInspector(
  { change, summary, children }: {
    change: PendingChange;
    summary: ComponentChildren;
    children?: ComponentChildren;
  },
) {
  return (
    <details class="inspector change-inspector">
      <summary>{summary}</summary>
      <div class="inspector-body">
        <FactList facts={changeFacts(change)} />
        {children}
      </div>
    </details>
  );
}
