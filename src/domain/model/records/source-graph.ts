import type { ToolKind } from "../../shared-kernel/tool-kind.ts";
interface CapabilityBinding {
  kind: ToolKind;
  relationship: "may-propose" | "may-invoke";
  /** Present for a concrete catalog item, absent for a host contract kind. */
  nativeId?: string;
  name?: string;
  sourceRefs: string[];
  evidenceLevel: "configured";
}
export interface OperatorAnnotation {
  nativeId: string;
  roleLabel: string;
  /** Native allocated action IDs: depiction, not evidence of execution. */
  depictedJudgmentRefs: string[];
  capabilityBindings: CapabilityBinding[];
}
export interface MandateAnnotation {
  id: string;
  version: string;
  nativeId: string;
  holderNativeId: string;
  scopeLabel: string;
  allowedChoices: string[];
  limits: string[];
  sourceRefs: string[];
  evidenceLevel: "configured";
  grantingOperator: "unknown";
  /** Verified native configuration scope, separate from mandate boolean fields. */
  networkScope?: { allowedHosts: string[]; sourceRefs: string[] };
}

import type { ModelIdentity } from "../../shared-kernel/model-identity.ts";
import type { ModelGraphData, ModelGraphNode } from "../projections/graph.ts";
import type { projectNativeViews } from "../projections/native-views.ts";
import type { NativeSequence } from "../projections/sequence.ts";

export interface SourceGraph extends Omit<ModelGraphData, "nodes"> {
  nodes: Array<
    ModelGraphNode & {
      modelStage?: string;
      operator?: OperatorAnnotation;
      mandate?: MandateAnnotation;
      expression?: string;
      expressionSourceIds?: string[];
      /** Reusable native definition scaffold, never a live state observation. */
      prototype?: true;
      observedState?: boolean;
      definitionOwnerId?: string;
      inheritedFromDefinitionId?: string;
    }
  >;
  views: ReturnType<typeof projectNativeViews>["views"];
  /** Present when native view ambiguity is separate from executable facts. */
  executionDiagnostics?: string[];
  viewDiagnostics?: string[];
  identity: ModelIdentity;
  networkScope?: { allowedHosts: string[]; nativeSourceIds: string[] };
  sequences: NativeSequence[];
  sequenceDiagnostics: string[];
}
