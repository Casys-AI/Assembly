/** Immutable local-owner ceiling continuation. This record grants no authority;
 * every recovery rechecks its canonical authorization and durable budget log. */
import type { ModelIdentity } from "../../shared-kernel/model-identity.ts";
import type { ExecutableModelVersion } from "../../model/execution/executable-model.ts";
import type {
  WorkBudgetOperation,
  WorkBudgetPolicy,
} from "../policies/budget.ts";

export interface BudgetCeilingPin {
  identity: ModelIdentity;
  version: ExecutableModelVersion;
}
export interface BudgetCeilingMember {
  /** Stable membership identity, independent of successor selection. */
  id: string;
  identity: {
    operatorId: string;
    invocationKey: string;
    scope:
      | { kind: "request"; scopeId: string; rootRequestId: string }
      | { kind: "designer"; scopeId: string; ownerId: string };
    purpose: "conversation" | "promotion";
    subjectId?: string;
  };
  contributionId: string;
  threadId: string;
  runId: string;
  checkpointNamespace: string;
  checkpointId: string;
  sourceKind: "settled-budget-wait" | "unconsumed-input-wait";
  occurrenceId: string;
  preparedNodeId: string;
  /** Await preparations have a key even when no effect was dispatched. */
  settledEffectKey: string;
  snapshotDigest: string;
}
export interface BudgetCeilingManifest {
  version: 1;
  id: string;
  authorizationEventId: string;
  origin: {
    __assemblyRuntimeRevision: {
      systemId: string;
      operatorId: string;
      invocationKey?: string;
      revision: number;
      modelDigest: string;
    };
  };
  from: BudgetCeilingPin;
  to: BudgetCeilingPin;
  unchangedContractDigest: string;
  budget: {
    scopeId: string;
    ownerId: string;
    budgetId: string;
    previousPolicy: WorkBudgetPolicy;
    policy: WorkBudgetPolicy;
    originRevision: number;
    originDigest: string;
    refusedAttemptId: string;
    operation: WorkBudgetOperation;
  };
  family: {
    invocationKey: string;
    inputMessageId: string;
    /** Covers canonical pending work, candidate/test/review and batch bytes. */
    retainedWorkDigest: string;
    candidateIds: string[];
    candidateProofs: Array<
      { id: string; digest: string; proofDigest: string; modelDigest?: string }
    >;
    batchIds: string[];
    /** Scalar submit_proposal source; hashes and member references only. */
    scalarProposal?: {
      parentMemberId: string;
      childMemberId: string;
      candidateId: string;
      decisionDigest: string;
      draftDigest: string;
      childSubjectId: string;
      effectResultDigest: string;
    };
  };
  members: BudgetCeilingMember[];
}
export interface BudgetCeilingTransition {
  manifest: BudgetCeilingManifest;
  manifestDigest: string;
  phase:
    | "authorized-intent"
    | "budget-policy"
    | "adopted-continuations-pending"
    | "complete";
  policyReceipt?: { revision: number; digest: string };
  resume?: {
    /** Accepted subsequent input: never substituted for the original work. */
    contributionId: string;
    inputMessageId: string;
    deliveryDigest: string;
    /** Immutable accepted canonical revision; restart cannot mint new evidence. */
    acceptedRevision: BudgetCeilingManifest["origin"];
  };
  selected: Array<
    { memberId: string; receiptId: string; successorRunId: string }
  >;
  blockedReason?: string;
}
