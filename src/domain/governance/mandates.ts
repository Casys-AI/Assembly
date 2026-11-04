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
