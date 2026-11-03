/**
 * APE 4.1 Operator Identity & Mandate: interpret modeled identities, capabilities and
 * mandate annotations; declarations alone do not authenticate a mandator.
 */
/** Read-only host configuration, not a grant/revocation registry.
 * Native declarations document these profiles; editing a model cannot widen them.
 */
import type { ToolKind } from "../shared-kernel/tool-kind.ts";

export const REVIEWER_MANDATE = Object.freeze({
  id: "reviewer-v1" as const,
  mayPropose: Object.freeze([] as ToolKind[]),
  mayInvoke: false as const,
  mayReview: "exact-tested-candidate-opinion-only" as const,
  mayAdmit: false as const,
  mayActivate: false as const,
});
export const MANDATE_SOURCE =
  "host configuration: src/domain/governance/mandates.ts; src/application/work/runtime/system.ts; src/adapters/out/llm-providers/agents.ts";

export const DYNAMIC_MANDATE_SOURCE =
  "host configuration: src/domain/governance/policies/governance.ts; src/domain/governance/mandates.ts; src/application/work/runtime/system.ts; src/adapters/out/llm-providers/agents.ts";

/** Exact historical provenance, retained for reading admitted models unchanged. */
export const LEGACY_MANDATE_SOURCE =
  "host configuration: src/domain/mandates.ts; src/application/system-runtime.ts; src/adapters/agents.ts";

export const LEGACY_DYNAMIC_MANDATE_SOURCE =
  "host configuration: src/domain/governance.ts; src/domain/mandates.ts; src/application/system-runtime.ts; src/adapters/agents.ts";

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
