import type {
  WorkBudgetPolicy,
  WorkBudgetRecord,
  WorkBudgetReservation,
  WorkBudgetView,
} from "../../../domain/work/policies/budget.ts";
import type {
  WorkBudgetAdoptInput,
  WorkBudgetReserveInput,
  WorkBudgetSettleInput,
} from "./commands/inputs.ts";

export interface WorkBudgetPort {
  /** Exact log used by the bounded owner ceiling transition, never counters alone. */
  readRecord?(scopeId: string, ownerId: string): Promise<WorkBudgetRecord>;
  advanceCeiling?(
    input: WorkBudgetAdoptInput & {
      transitionId: string;
      manifestDigest: string;
      expectedRevision: number;
      expectedDigest: string;
    },
  ): Promise<WorkBudgetRecord>;
  adopt(input: WorkBudgetAdoptInput): Promise<WorkBudgetView | undefined>;
  snapshot(
    scopeId: string,
    ownerId: string,
    policy: WorkBudgetPolicy | undefined,
  ): Promise<WorkBudgetView | undefined>;
  reserve(
    input: WorkBudgetReserveInput,
  ): Promise<WorkBudgetReservation | undefined>;
  settle(input: WorkBudgetSettleInput): Promise<void>;
}
export interface WorkBudgetStorePort {
  load(scopeId: string): Promise<WorkBudgetRecord | null>;
  save(
    record: WorkBudgetRecord,
    expectedRevision: number | null,
  ): Promise<void>;
}
