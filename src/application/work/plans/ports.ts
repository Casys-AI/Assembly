import type {
  BehaviorInvocationRequest,
  BehaviorInvocationResult,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type { WorkPlanRecord } from "../../../domain/work/entities/plans.ts";

export interface WorkPlanStorePort {
  load(id: string): Promise<WorkPlanRecord | null>;
  /** Compare-and-swap; null means create only. Never silently overwrite a plan. */
  save(record: WorkPlanRecord, expectedRevision: number | null): Promise<void>;
}

/** A returned call is not itself proof that the requested work completed. */
type WorkCompletion = "completed" | "waiting" | "failed";

export interface WorkPlanExecutionPorts {
  store: WorkPlanStorePort;
  invokeTarget(
    request: BehaviorInvocationRequest,
  ): Promise<BehaviorInvocationResult>;
  observeTarget?(
    request: BehaviorInvocationRequest,
  ): Promise<BehaviorInvocationResult>;
  /** Normalize the target mechanism's completion envelope, never domain policy. */
  completion?(receipt: BehaviorInvocationResult): WorkCompletion;
  now?(): string;
}

export type { WorkResultObservation } from "../../../domain/work/policies/verified-effect-closure.ts";
