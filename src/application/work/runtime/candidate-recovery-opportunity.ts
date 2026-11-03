import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import {
  budgetState,
  type WorkBudgetRecord,
} from "../../../domain/work/policies/budget.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { WorkBudgetPort } from "../budget/ports.ts";
import {
  nativeExecutionIdentity,
  type NativeExecutionPort,
} from "./execution.ts";

type Disposition = NonNullable<
  SystemRuntimeState["candidateRecoveryDispositions"]
>[string];
type Checkpoint = NonNullable<Disposition["checkpoint"]>;
type BudgetEvidence = NonNullable<Disposition["budget"]>;
type RecoveryOpportunity =
  | { kind: "checkpoint"; checkpoint: Checkpoint }
  | {
    kind: "budget";
    budget: BudgetEvidence;
    checkpoint: Checkpoint;
  };

/** Keep message attribution attached to the exact continuation when an attempt
 * is converted to blocked, including a retry or a consumed predecessor. */
export function recoveryMessageHistory(input: {
  candidateId: string;
  continuationDigest: string;
  acceptedDigest: string;
  retry?: Disposition;
  predecessor?: Disposition;
  prior?: Disposition;
}): Disposition | undefined {
  const exact = input.retry ?? input.predecessor;
  if (
    exact && (exact.candidateId !== input.candidateId ||
      exact.continuationDigest !== input.continuationDigest ||
      input.retry && exact.acceptedDigest !== input.acceptedDigest ||
      !Number.isSafeInteger(exact.baseMessageEnd) ||
      !Array.isArray(exact.messageRanges))
  ) {
    throw new Error("The candidate recovery message history changed");
  }
  if (exact) {
    const end = exact.baseMessageEnd!;
    if (
      end < 0 ||
      exact.messageRanges!.some((range, index) =>
        !Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        range.start < (index ? exact.messageRanges![index - 1].end : end) ||
        range.end < range.start
      )
    ) {
      throw new Error("The candidate recovery message history is invalid");
    }
    return exact;
  }
  const prior = input.prior;
  if (!prior || prior.baseMessageEnd === undefined || !prior.messageRanges) {
    return undefined;
  }
  if (
    prior.candidateId !== input.candidateId ||
    prior.continuationDigest !== input.continuationDigest ||
    !Number.isSafeInteger(prior.baseMessageEnd) || prior.baseMessageEnd < 0 ||
    prior.messageRanges.some((range, index) =>
      !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
      range.start <
        (index ? prior.messageRanges![index - 1].end : prior.baseMessageEnd!) ||
      range.end < range.start
    )
  ) {
    throw new Error("The candidate recovery message history changed");
  }
  return prior;
}

function blocked(view: ReturnType<typeof budgetState>["view"]): boolean {
  return view.exhausted || view.suspended || view.reserved > 0;
}

/** Select only an event that actually lifts a previously observed budget block.
 * A reserve, refusal or unrelated append is not a recovery opportunity. */
export async function liftingBudgetEvent(
  record: WorkBudgetRecord,
  baseline: BudgetEvidence,
): Promise<BudgetEvidence | undefined> {
  if (
    record.scopeId !== baseline.scopeId ||
    record.ownerId !== baseline.ownerId ||
    baseline.eventIndex < 0 || baseline.eventIndex >= record.events.length ||
    await executionDigest(record.events[baseline.eventIndex]) !==
      baseline.eventDigest
  ) return;
  const prefix = (length: number) =>
    budgetState({
      ...record,
      revision: length,
      events: record.events.slice(0, length),
    }).view;
  if (
    !blocked(prefix(baseline.eventIndex + 1)) ||
    blocked(budgetState(record).view)
  ) return;
  for (let i = baseline.eventIndex + 1; i < record.events.length; i++) {
    const event = record.events[i];
    if (
      (event.kind === "policy" || event.kind === "settle") &&
      blocked(prefix(i)) && !blocked(prefix(i + 1))
    ) {
      return {
        scopeId: record.scopeId,
        ownerId: record.ownerId,
        eventIndex: i,
        eventDigest: await executionDigest(event),
      };
    }
  }
}

/** Inspect the projected exact invocation; never infer reconciliation from an empty inspection. */
export async function inspectCandidateOpportunity(
  state: SystemRuntimeState,
  inputMessageId: string,
  execution: NativeExecutionPort | undefined,
  budget: WorkBudgetPort | undefined,
  prior: Disposition | undefined,
): Promise<
  {
    opportunity?: RecoveryOpportunity;
    reason?: Disposition["reason"];
    checkpoint?: Checkpoint;
    budget?: BudgetEvidence;
  }
> {
  if (
    !execution || !state.caseInvocation ||
    state.activeInputMessageId !== inputMessageId
  ) return { reason: "unknown" };
  const identity = nativeExecutionIdentity(
    state,
    "conversation",
    inputMessageId,
  );
  const snapshots = (await execution.inspect(identity.operatorId)).filter((
    item,
  ) =>
    canonical(item.identity) === canonical(identity) &&
    item.modelDigest === state.executionModel?.version.digest &&
    item.repositoryVersion === state.executionModel?.version.repositoryVersion
  );
  if (snapshots.length !== 1) return { reason: "unknown" };
  const snapshot = snapshots[0];
  const checkpoint = snapshot.runId && snapshot.checkpointId
    ? {
      threadId: snapshot.threadId,
      runId: snapshot.runId,
      checkpointId: snapshot.checkpointId,
    }
    : undefined;
  let budgetRecord: WorkBudgetRecord | undefined,
    budgetEvidence: BudgetEvidence | undefined;
  const binding = state.workBudgetBinding;
  if (binding && budget?.readRecord) {
    budgetRecord = await budget.readRecord(
      binding.scopeId,
      identity.operatorId,
    );
    if (
      budgetRecord.scopeId !== binding.scopeId ||
      budgetRecord.ownerId !== identity.operatorId
    ) throw new Error("Candidate budget record scope changed");
    budgetState(budgetRecord);
    const eventIndex = budgetRecord.events.length - 1;
    budgetEvidence = {
      scopeId: binding.scopeId,
      ownerId: identity.operatorId,
      eventIndex,
      eventDigest: await executionDigest(budgetRecord.events[eventIndex]),
    };
  }
  if (
    state.budgetSuspension || state.workBudget?.exhausted ||
    state.workBudget?.suspended || state.caseBudgetPending ||
    (state.workBudget?.reserved ?? 0) > 0 ||
    (budgetRecord && blocked(budgetState(budgetRecord).view))
  ) {
    return { reason: "budget", checkpoint, budget: budgetEvidence };
  }
  if (
    !checkpoint || snapshot.status === "uncertain" ||
    snapshot.unsettledEffects.length ||
    snapshot.openImmutableConsultationGroups?.length ||
    !["waiting", "completed"].includes(snapshot.status)
  ) {
    return { reason: "unknown", checkpoint, budget: budgetEvidence };
  }
  if (
    prior &&
    (prior.kind === "recoverable-under-same-delivery" ||
      prior.reason === "unknown" ||
      prior.reason === "budget")
  ) {
    if (
      prior.checkpoint && canonical(prior.checkpoint) !== canonical(checkpoint)
    ) {
      return {
        opportunity: { kind: "checkpoint", checkpoint },
        checkpoint,
        budget: budgetEvidence,
      };
    }
    if (prior.reason === "budget" && prior.budget && budgetRecord) {
      const lifted = await liftingBudgetEvent(budgetRecord, prior.budget);
      if (lifted) {
        return {
          opportunity: { kind: "budget", budget: lifted, checkpoint },
          checkpoint,
          budget: budgetEvidence,
        };
      }
    }
    return {
      reason: prior.reason ?? "unknown",
      checkpoint,
      budget: prior.budget,
    };
  }
  return {
    opportunity: { kind: "checkpoint", checkpoint },
    checkpoint,
    budget: budgetEvidence,
  };
}
