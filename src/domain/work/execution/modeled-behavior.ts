import type { WorkBudgetPolicy } from "../policies/budget.ts";
import type { BehaviorModelVersion } from "../../shared-kernel/behavior-model-version.ts";

import type { NativeBehaviorContract } from "../../model/execution/native-contracts.ts";

/** Host-owned accounting and correlation. It never grants invocation authority. */
export interface CaseExecutionContext {
  /** Case objective and provenance travel with newly delegated work. */
  record?: import("../entities/cases.ts").Case;
  caseId: string;
  number?: number;
  modelPin: { digest: string; repositoryVersion?: string };
  budget?: {
    scopeId: string;
    ownerId: string;
    policy: WorkBudgetPolicy;
  };
}

export interface BehaviorInvocationRequest {
  caseId?: string;
  caseContext?: CaseExecutionContext;
  designerContext?: import("./case-context.ts").DesignerExecutionContext;
  behavior: NativeBehaviorContract;
  input: Record<string, unknown>;
  modelVersion: BehaviorModelVersion;
  callerId: string;
  invocationId: string;
}

export interface BehaviorInvocationResult {
  caseId?: string;
  behaviorId: string;
  invocationId: string;
  targetNativeId: string;
  /** Authority for this call; executed cases may retain an older source pin. */
  modelVersion: BehaviorModelVersion;
  result: unknown;
}
