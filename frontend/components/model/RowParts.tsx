import {
  type ChangeOutcome,
  outcomeLabel,
} from "../../lib/model/revisions/change.ts";

/**
 * The parts a revision's row is made of, on the Revisions list and on the
 * Activity feed: the marker that says where it stands, and the chips that sit
 * on the commit or the proposal they belong to.
 */

/**
 * Where a change stands. A commit is plain; a proposal says whether it waits,
 * was accepted or declined, to a reader that cannot see the colour.
 */
export function Marker({ state }: { state: ChangeOutcome }) {
  return state === "applied"
    ? <span class="rev-dot" aria-hidden="true" />
    : (
      <span
        class={`rev-dot is-${state}`}
        role="img"
        aria-label={outcomeLabel[state]}
        title={outcomeLabel[state]}
      />
    );
}

export function MainChip() {
  return <span class="chip" title="The head of main">main</span>;
}

/** A proposal that is not for the person to decide yet. */
export function StageChip(
  { stage }: { stage: "preparing" | "accepting" },
) {
  return stage === "preparing"
    ? (
      <span class="chip" title="The operator is still preparing it">
        preparing
      </span>
    )
    : <span class="chip">accepting</span>;
}
