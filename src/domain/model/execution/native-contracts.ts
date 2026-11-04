/** Native compiled contracts: source-admitted policy, behavior and guidance views. */
import type { NativePolicyIdentity } from "./executable-model.ts";
import type {
  ModelEditGrant,
  ModelEditOperation,
} from "../../governance/model-access/model-edit-policy.ts";
import type { DecisionContextPolicy } from "../../work/policies/context-separation.ts";
import type { WorkBudgetPolicy } from "../../work/policies/budget.ts";

export interface NativeModelEditPolicy extends NativePolicyIdentity {
  /** Digest of the admitted delegation chain supplying this effective policy. */
  delegationDigest?: string;
  holderNativeId: string;
  mandateNativeId: string;
  mandateId: string;
  mandateRevision: number;
  operations: ModelEditOperation[];
  grants: ModelEditGrant[];
}

/** Source-admitted delegation ceiling; it does not itself authorize editing. */
export interface NativeModelAdministrationPolicy extends NativePolicyIdentity {
  holderNativeId: string;
  mandateNativeId: string;
  mandateId: string;
  mandateRevision: number;
  operations: ModelEditOperation[];
  grants: ModelEditGrant[];
  /** Exact ConversationSystem names eligible to receive a bounded grant. */
  recipients: string[];
  /** Number of further administration grants allowed below this authority. */
  maxRedelegationDepth: number;
}

export type NativeContextPolicy = DecisionContextPolicy & NativePolicyIdentity;

export type NativeWorkBudgetPolicy = WorkBudgetPolicy & NativePolicyIdentity;

export interface NativeModelingGuidance extends NativePolicyIdentity {
  content: string;
}

export interface NativeMemoryPolicy extends NativePolicyIdentity {
  kind: "governed-memory";
  pattern: "5.2";
  ownerId: string;
  allowedScopes: string[];
  requireSourceRefs: boolean;
  requireKnownOutcome: boolean;
  maxValidityMs: number;
  allowSelfAdmission: boolean;
}

/** Source-admitted local instruction acquisition and activation limits. */
export interface NativeSkillPolicy extends NativePolicyIdentity {
  kind: "lazy-skills";
  ownerId: string;
  allowedHosts: string[];
  maxSkillBytes: number;
  maxInstalledSkills: number;
  maxLoadedSkills: number;
  maxLoadedCharacters: number;
}

/** Source-owned reference, exact artifact digest and initial selection choice. */
export interface NativeInitialSkill {
  nativeId: string;
  id: string;
  source: string;
  digest: string;
  loaded: boolean;
  sourceIds: string[];
}

/** A source-declared callable behavior. Neither agent output nor host registration
 * grants permission: the admitted native exposure fixes caller, target and input. */
export interface NativeBehaviorContract {
  id: string;
  name: string;
  description: string;
  targetNativeId: string;
  targetTypeId: string;
  inputTypeId: string;
  callerNativeId: string;
  inputSchema: Record<string, unknown>;
  sourceIds: string[];
}
