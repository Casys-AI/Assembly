import type {
  AdoptionOffer,
  HistoryProblem,
} from "../../../lib/model/revisions/history.ts";
import { shortCommit } from "../../../lib/model/revisions/change.ts";
import type { RuntimeOperator } from "../../../lib/model/revisions/api.ts";
import { Problem } from "../../view/Problem.tsx";

/** An operator whose runtime could not be read, and why. */
export interface UnreadRuntime {
  operator: RuntimeOperator;
  problem: HistoryProblem;
}

/**
 * Puts the accepted model in service, on the row of the head of main. It
 * offers only the operators whose runtime holds something else (one runtime is
 * in service per operator, and read-only operators have none): the operator is
 * named, or chosen when there are several, and the one button acts for it. With
 * nobody to offer it to, it shows nothing; a refusal, or an operator whose
 * runtime could not be read, is told under it with its code. The host refuses
 * while an operator is running, so the button waits for it to finish.
 */
export function AdoptControl(
  {
    offers,
    chosen,
    onChoose,
    adopting,
    available,
    idle,
    refusal,
    unread,
    onAdopt,
  }: {
    offers: readonly AdoptionOffer[];
    /** The operator picked among the offers; the first offer when none or gone. */
    chosen?: string;
    onChoose(agentId: string): void;
    /** The operator whose adoption is in flight. */
    adopting: string | null;
    /** A settled read, and no change in flight anywhere. */
    available: boolean;
    /** No operator is running (see `operatorsIdle`). */
    idle: boolean;
    /** Why the last adoption was not recorded, and for whom (by name). */
    refusal?: { operator?: string; problem: HistoryProblem };
    unread: readonly UnreadRuntime[];
    onAdopt(agentId: string): void;
  },
) {
  const offer = offers.find((entry) => entry.operator.nativeId === chosen) ??
    offers[0];
  if (!offer && !refusal && unread.length === 0) return null;
  const agentId = offer?.operator.nativeId;
  return (
    <div class="adopt" role="group" aria-label="Put in service">
      {offer && (
        <div class="proposal-actions adopt-bar">
          {offers.length > 1
            ? (
              <select
                aria-label="Operator"
                value={agentId}
                disabled={!available || adopting !== null}
                onChange={(event) => onChoose(event.currentTarget.value)}
              >
                {offers.map((entry) => (
                  <option
                    key={entry.operator.nativeId}
                    value={entry.operator.nativeId}
                    selected={entry.operator.nativeId === agentId}
                  >
                    {entry.operator.name}
                  </option>
                ))}
              </select>
            )
            : <span class="adopt-who">{offer.operator.name}</span>}
          <button
            type="button"
            class="proposal-accept"
            disabled={!available || !idle || adopting !== null}
            title={idle
              ? `Puts ${
                shortCommit(offer.adoption.expectedVersion)
              } in service for ${offer.operator.name}`
              : "An operator is running"}
            onClick={() => onAdopt(offer.operator.nativeId)}
          >
            {adopting === agentId ? "Working…" : "Put in service"}
          </button>
        </div>
      )}
      {refusal && (
        <Problem problem={refusal.problem} subject={refusal.operator} />
      )}
      {unread.map((entry) => (
        <Problem
          key={entry.operator.nativeId}
          problem={entry.problem}
          subject={entry.operator.name}
        />
      ))}
    </div>
  );
}
