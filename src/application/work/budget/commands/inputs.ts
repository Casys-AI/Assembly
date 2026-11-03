import type {
  WorkBudgetModelVersion,
  WorkBudgetOperation,
  WorkBudgetPolicy,
} from "../../../../domain/work/policies/budget.ts";

export interface WorkBudgetReserveInput {
  /** Reuse only this exact exhausted attempt that never acquired credit. */
  ceilingTransition?: {
    id: string;
    manifestDigest: string;
    originRevision: number;
    refusedAttemptId: string;
  };
  scopeId: string;
  ownerId: string;
  policy: WorkBudgetPolicy | undefined;
  operation: WorkBudgetOperation;
  attemptId: string;
  modelVersion: WorkBudgetModelVersion;
}

export interface WorkBudgetSettleInput {
  scopeId: string;
  ownerId: string;
  attemptId: string;
  outcome: "returned" | "failed";
}

export interface WorkBudgetAdoptInput {
  scopeId: string;
  ownerId: string;
  previousPolicy: WorkBudgetPolicy | undefined;
  policy: WorkBudgetPolicy | undefined;
  modelVersion: WorkBudgetModelVersion;
}
