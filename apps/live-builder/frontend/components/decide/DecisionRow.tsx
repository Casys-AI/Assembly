import type { PendingDecision } from "../../lib/decide/pending.ts";

/**
 * One point that waits for a decision, on one line: a dot, a short text, who
 * asked, an arrow. The whole line is the link to the page where it is decided,
 * a real link so that Fresh owns the navigation. The exact phrase and the
 * agent sit in its tooltip.
 */
export function DecisionRow({ decision }: { decision: PendingDecision }) {
  const { label, agentName } = decision;
  return (
    <a
      class="decide-row"
      href={decision.href}
      data-kind={decision.kind}
      title={agentName ? `${label} · ${agentName}` : label}
    >
      <span class="rev-dot is-pending" aria-hidden="true" />
      <span class="decide-text">{label}</span>
      {agentName && <span class="decide-who">{agentName}</span>}
      <span class="decide-go" aria-hidden="true">→</span>
    </a>
  );
}
