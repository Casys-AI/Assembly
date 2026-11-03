import { canonical } from "../../primitives/canonical-json.ts";
import type { CaseExecutionContext } from "./modeled-behavior.ts";
import { assertBudgetPolicy, budgetIdentity } from "../policies/budget.ts";

/** A ceiling may evolve after adoption; the delegated Case identity may not. */
export function sameCaseIdentity(
  left: CaseExecutionContext,
  right: CaseExecutionContext,
): boolean {
  const identity = (context: CaseExecutionContext) => ({
    caseId: context.caseId,
    number: context.number,
    modelPin: context.modelPin,
  });
  return canonical(identity(left)) === canonical(identity(right));
}

export interface DesignerExecutionContext {
  scopeId: string;
  ownerId: string;
  policy?: import("../policies/budget.ts").WorkBudgetPolicy;
}

export function validDesignerContext(
  value: DesignerExecutionContext | undefined,
): value is DesignerExecutionContext {
  if (
    !value || !budgetIdentity(value.scopeId) || !budgetIdentity(value.ownerId)
  ) return false;
  try {
    if (value.policy !== undefined) assertBudgetPolicy(value.policy);
    return true;
  } catch {
    return false;
  }
}

/** The trigger explicitly selects a designer conversation or one Case. */
export type CaseInvocation =
  | { kind: "designer"; scopeId: string }
  | {
    kind: "delegated-designer";
    work: OperatorWorkReceipt & { designerContext: DesignerExecutionContext };
  }
  | { kind: "local"; caseId: string }
  | {
    kind: "delegated";
    work: OperatorWorkReceipt & { caseContext: CaseExecutionContext };
  };

/** Captured by the host at dispatch, never reconstructed from a later selection. */
export interface ParentInvocationAnchor {
  operatorId: string;
  invocationKey: string;
  inputMessageId: string;
}

export interface OperatorWorkReceipt {
  mainOrder?: {
    openingId: string;
    caller: import("../../governance/authority.ts").ScopedOperatorRef;
  };
  parentInvocation?: ParentInvocationAnchor;
  designerContext?: DesignerExecutionContext;
  caseId?: string;
  caseContext?: CaseExecutionContext;
  correlationId: string;
  callerId: string;
  invocationId: string;
  behaviorId?: string;
  targetNativeId: string;
  modelVersion:
    import("../../shared-kernel/behavior-model-version.ts").BehaviorModelVersion;
  fingerprint: string;
  inputDigest?: string;
  priorCandidateIds: string[];
}
