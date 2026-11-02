/** Backend-independent contracts compiled from an admitted SysML source version.
 * Runtime state and provider output never supply these permissions or flows.
 */
import type {
  NativeBehaviorContract,
  NativeContextPolicy,
  NativeInitialSkill,
  NativeMemoryPolicy,
  NativeModelAdministrationPolicy,
  NativeModelEditPolicy,
  NativeModelingGuidance,
  NativeSkillPolicy,
  NativeWorkBudgetPolicy,
} from "./native-contracts.ts";
import type { CompiledFlow } from "./flow.ts";
import type { OperatorEntry } from "../records/operator-entry.ts";
import type { OwnerAuthority } from "../../governance/authority.ts";
import type { ChatContext, ModelIdentity } from "../../work/dialogue.ts";
import type { NativeToolContract, Stage } from "../../work/candidates.ts";
import type {
  SystemConfiguration,
} from "../../governance/records/system-configuration.ts";
import type { ToolKind } from "../../shared-kernel/tool-kind.ts";

export interface ExecutableModelVersion {
  digest: string;
  /** Absent for historical executable digest encodings. */
  authoritySchema?: 2;
  rootId: string;
  configurationId: string;
  configurationRevision: number;
  sourceIds: string[];
  /** Immutable repository commit when supplied by the source backend. */
  repositoryVersion?: string;
}

export interface ExecutionPolicy {
  maxAgentDecisions: number;
  maxToolProposals: number;
  maxFlowSteps: number;
  urlSelectionMode: "user-provided" | "authorized-host";
  mayAddNetworkHosts: boolean;
  mayDelegateOwnAdmission: boolean;
  mayCreateReviewer: boolean;
  mayChangeUrlSelection: boolean;
  /** On-demand model reads. Absent only in the historical policy encoding. */
  mayConsultModel?: boolean;
  /** Generic source revision proposals still require separate admission. */
  mayProposeSysmlRevision?: boolean;
}

export interface ExecutableCatalogEntry {
  nativeId: string;
  candidateId: string;
  contractId: string;
  name: string;
  kind: ToolKind;
  digest: string;
  status: Stage;
}

export interface NativePolicyIdentity {
  rootAuthority?: OwnerAuthority;
  id: string;
  revision: number;
  elementId: string;
  sourceIds: string[];
}

export interface ExecutableModel {
  /** Explicit modeled CAP-3 control; absence confers no isolated-space authority. */
  spaceControlPolicy?:
    import("../../governance/policies/space-execution-policy.ts").NativeSpaceControlPolicy;
  /** Explicit previous-source authority for executable evolution; absent grants none. */
  evolutionPolicy?: import("../evolution/policy.ts").NativeEvolutionPolicy;
  /** Creator-owned exact template used for future operators only. */
  operatorFlowTemplate?: {
    qualifiedName: string;
    revision: number;
    typeNativeId: string;
    digest: string;
    sourceIds: string[];
  };
  toolAdmissionPolicies?:
    import("../../governance/policies/tool-admission-policy.ts").ToolAdmissionPolicy[];
  /** Source-owned originating Request constraint for a durable teammate. */
  operatorTeam?: {
    parentOperatorId: string;
    requestOwnerId: string;
    requestId: string;
    creationPolicyId?: string;
  };
  operatorCreationPolicies?:
    import("../../governance/policies/operator-creation-policy.ts").OperatorCreationPolicy[];
  operatorAuthorityPolicies?:
    import("../../governance/policies/operator-authority-policy.ts").OperatorAuthorityPolicy[];
  /** Derived source boundaries for validating editing grants; not executable rights. */
  modelEditingAuthorityRoots?: string[];
  /** Derived compatibility provenance remains outside historical digests. */
  ownerAuthority?: OwnerAuthority;
  /** Absent for legacy systems and inert ASECases library imports. */
  caseTypes?: import("../../work/records/case-types.ts").NativeCaseType[];
  modelEditPolicy?: NativeModelEditPolicy;
  modelAdministrationPolicy?: NativeModelAdministrationPolicy;
  modelAdministration?:
    import("../../governance/policies/model-delegation.ts").ModelAdministrationAuthority;
  /** Optional cumulative invocation budget admitted for this operator case. */
  workBudgetPolicy?: NativeWorkBudgetPolicy;
  workResultContracts?:
    import("../../work/policies/verified-effect-closure.ts").WorkResultContract[];
  /** Selected source-owned bytes still follow normal testing and admission. */
  initialTools?:
    import("../../work/initial-tool-catalog.ts").NativeInitialToolSeed[];
  /** Opt-in native policies; missing fields preserve historical encodings. */
  contextPolicy?: NativeContextPolicy;
  memoryPolicy?: NativeMemoryPolicy;
  skillPolicy?: NativeSkillPolicy;
  initialSkills?: NativeInitialSkill[];
  modelingGuidance?: NativeModelingGuidance[];
  /** Source-allocated technical entries; registration alone grants no call. */
  operatorEntries?: OperatorEntry[];
  /** Optional source-declared operator endpoint; absent in historical contracts. */
  operator?: {
    name: string;
    instruction: string;
    primary: boolean;
    humanInput: boolean;
  };
  identity: ModelIdentity;
  version: ExecutableModelVersion;
  /** Derived from model values; changes is an optional audit log, not authority. */
  configuration: SystemConfiguration;
  mandate: NonNullable<ChatContext["mandate"]>;
  policy: ExecutionPolicy;
  contracts: NativeToolContract[];
  flows: { conversation: CompiledFlow; promotion: CompiledFlow };
  /** Native scheduled behaviors owned by this operator; absent in legacy contracts. */
  caseFlows?: Record<string, CompiledFlow>;
  /** Explicit native call exposures, filtered to the conversational operator. */
  behaviors?: NativeBehaviorContract[];
  /** Operational model state, excluded from the executable structure digest. */
  catalog: ExecutableCatalogEntry[];
}

export interface ModelExecutionReference {
  digest: string;
  /** Absent in historical events written before runtime provenance existed. */
  runtime?: { digest: string };
  actionId?: string;
  edgeId?: string;
  sourceIds?: string[];
  repositoryVersion?: string;
}
