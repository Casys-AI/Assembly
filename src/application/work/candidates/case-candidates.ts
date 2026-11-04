import { hasActivationIntent } from "../../../domain/work/policies/candidate-activation.ts";
import type {
  Candidate,
  Stage,
} from "../../../domain/work/records/candidates.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";

/** Work that still needs its Case. An admitted activation does not: its intent
 * is retried or settled independently, so a closed Case never blocks a restart. */
export function candidateIsPending(candidate: Candidate): boolean {
  return !["active", "refused", "failed"].includes(candidate.stage) &&
    !hasActivationIntent(candidate);
}

export interface CaseCandidatesHost {
  readonly state: SystemRuntimeState;
  update(change: (state: SystemRuntimeState) => void): Promise<void>;
  stage(id: string, stage: Stage, label: string): Promise<void>;
}

/** A Case owns its candidates durably; abandonment settles unadmitted work.
 * An activation already admitted and possibly published is not pending: it
 * keeps its durable intent, which an explicit abandon settles separately with
 * `settleCaseActivations`. Closing a Case is not a revocation of an admitted tool.
 */
export async function abandonCaseCandidates(
  this: CaseCandidatesHost,
  caseId: string,
): Promise<void> {
  const candidates = this.state.candidates.filter((candidate) =>
    candidate.caseId === caseId && candidateIsPending(candidate)
  );
  for (const candidate of candidates) {
    await this.stage(candidate.id, "failed", "Case abandoned");
    await this.update((state) => {
      const abandoned = state.candidates.find((c) => c.id === candidate.id)!;
      abandoned.error = "Case abandoned";
      abandoned.errorCode = "CASE_ABANDONED";
      delete abandoned.promotionCursor;
      delete abandoned.promotionContext;
      if (state.budgetSuspension?.candidateId === abandoned.id) {
        delete state.budgetSuspension;
      }
      if (state.budgetPromotionCandidateId === abandoned.id) {
        delete state.budgetPromotionCandidateId;
      }
    });
  }
}
