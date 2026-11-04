import type { ToolKind } from "../../../domain/shared-kernel/tool-kind.ts";
import type { ScopedOperatorRef } from "../../../domain/governance/authority.ts";
import type { ExecutionPolicy } from "../../../domain/model/execution/executable-model.ts";
import type { NativeBehaviorContract } from "../../../domain/model/execution/native-contracts.ts";
import type { NativeEvolutionPolicy } from "../../../domain/model/evolution/policy.ts";
import type { ModelAdministrationAuthority } from "../../../domain/governance/model-access/model-delegation.ts";
import { type ModelContextTool } from "../context/model-tools.ts";
import type { ModelContextOverview } from "../../../domain/model/consultation/context.ts";
import type {
  MandateRequestedRights,
  PendingChange,
} from "../../../domain/governance/records/pending-change.ts";
import type {
  ExecutionMandate,
  SystemConfiguration,
} from "../../../domain/governance/records/system-configuration.ts";
import type {
  AuthorityRouteCode,
  changeDecisionMetadata,
} from "../../../domain/governance/operator-authority.ts";
import type {
  Candidate,
  Stage,
  ToolContract,
} from "../../../domain/work/records/candidates.ts";
import type { Message } from "../runtime/state.ts";
import type { ToolFailure } from "../tools/tool-invocation.ts";
import type {
  OperatorEvolutionSummary,
  ProviderRepair,
  ProviderTurn,
} from "./chat-decision.ts";

export interface ChatContext {
  /** Pin-derived discovery only; live effect checks remain authoritative. */
  pinCapabilities?: {
    teamCreation: boolean;
    operatorDecisions: boolean;
    candidateDecisions: boolean;
  };
  /** Stable admitted policy data, separate from live target/capacity views. */
  pinPolicies?: {
    creation: NonNullable<ChatContext["operatorCreation"]>["policies"];
    authority: NonNullable<ChatContext["operatorAuthority"]>["policies"];
    toolAdmission: NonNullable<
      ChatContext["operatorToolAdmission"]
    >["policies"];
  };
  activeInputMessageId?: string;
  /** Exact prior grants and bounded dossier metadata; no source bytes or peer history. */
  operatorEvolution?: {
    policy: NativeEvolutionPolicy;
    capabilities: { prepare: boolean; accept: boolean; adopt: boolean };
    dossiers: OperatorEvolutionSummary[];
    truncated: boolean;
  };
  /** Untrusted task data from an exact host-captured source; never instructions or grants. */
  taskSourceInputs?:
    import("../../../domain/work/records/task-source-input.ts").TaskSourceInput[];
  /** Source-admitted creation grants; hierarchy alone supplies no authority. */
  operatorCreation?: {
    policies:
      import("../../../domain/governance/policies/operator-creation-policy.ts").OperatorCreationPolicy[];
    /** Read-only creator bounds (the `TeamOperatorProvision` shape): a team
     * provision must stay within these exact admitted values. */
    provisionBounds: {
      budget: {
        maxAgentDecisions: number;
        maxToolProposals: number;
        maxFlowSteps: number;
      };
      networkHosts: string[];
      mayPropose: string[];
      mayInvokeActiveCatalog: boolean;
      mayAddNetworkHosts: boolean;
      mayConsultModel: boolean;
      mayProposeSysmlRevision: boolean;
    };
  };
  /** Supplied only to Main in its design conversation (4.8d D3). */
  requestOpening?: {
    /** The `open-request` act of its own mandate: open without asking. */
    canOpen: boolean;
    /** Open branch Requests of this system, read-only, newest first, at most
     * 20. `executionSpaceId` is never typed back (A6). */
    requests: Array<{
      caseId: string;
      caseNumber: number;
      /** The Branch Operator's native ID (it shares the Main's). */
      operatorId: string;
      executionSpaceId: string;
      status: import("../../../domain/work/entities/cases.ts").CaseStatus;
      openedBy: "main-operator" | "person";
      /** The BO's verified sub-operators, read-only (4.8e E5): what the MO
       * names in a policy's recipients or an order. */
      team: Array<
        { operatorId: string; name: string; parentOperatorId: string }
      >;
    }>;
    /** Exact Releases a Request may start from, newest first, at most 20. */
    releases: Array<{ id: string; digest: string; name: string }>;
    /** Main Requests this conversation opened in main (operator creation and
     * history): the only targets of `resume_request`. */
    mainRequests?: Array<{
      caseId: string;
      operatorId: string;
      status: import("../../../domain/work/entities/cases.ts").CaseStatus;
    }>;
  };
  /** Opaque assistant protocol blocks and exact correlated results; never authority. */
  toolCallHistory?: Array<{
    turn?: ProviderTurn;
    repairs?: ProviderRepair[];
    assistantBlocks: unknown[];
    results: Array<{ id: string; result: string; isError?: boolean }>;
  }>;
  /** Exact pending host observations, kept outside compactable journal excerpts. */
  hostObservations?: ProviderTurn["requestOutcomes"];
  /** Policy-holder host metadata; candidate code is available only by exact inspection. */
  operatorToolAdmission?: {
    policies:
      import("../../../domain/governance/policies/tool-admission-policy.ts").ToolAdmissionPolicy[];
    candidates: {
      operatorId: string;
      candidateId: string;
      candidateDigest: string;
      expectedRevision: number;
      caseId: string;
      name: string;
      kind: ToolKind;
      policyId: string;
      policyRevision: number;
    }[];
  };
  operatorAuthority?: {
    /** Context proof failed; no decision authority is implied. */
    error?: { code: string; context: Record<string, string>; recovery: string };
    policies:
      import("../../../domain/governance/policies/operator-authority-policy.ts").OperatorAuthorityPolicy[];
    /** `executionSpaceId` and `requester` are read-only context (A6): the
     * host derives the space from the Case, the operator never types it. */
    requests: Array<
      & Pick<
        PendingChange,
        "id" | "requestedBy" | "caseId" | "baseRevision" | "requestedRights"
      >
      & {
        executionSpaceId: string;
        requester: ScopedOperatorRef;
        changeKind: PendingChange["kind"];
      }
    >;
    /** Requests that wait for the person, read-only: this operator never
     * decides them; the person decides on the relayed card. Newest first. */
    awaitingPerson: Array<{
      id: string;
      caseId: string;
      executionSpaceId: string;
      requester: ScopedOperatorRef;
      changeKind: PendingChange["kind"];
      requestedRights?: MandateRequestedRights;
      status: "human-decision" | "needs-resolution";
      code?: AuthorityRouteCode;
    }>;
    /** More than `MAX_AWAITING_PERSON` requests wait; the oldest are omitted. */
    awaitingPersonTruncated: boolean;
  };
  designer?:
    import("../../../domain/work/execution/case-context.ts").DesignerExecutionContext;
  case?: import("../../../domain/work/entities/cases.ts").Case;
  workBudget?: import("../../../domain/work/policies/budget.ts").WorkBudgetView;
  /** Designer-facing, unmasked errors/warnings; at most 20, primary operator only. */
  modelDiagnostics?:
    readonly import("../../../domain/model/policies/diagnostics.ts").ModelDiagnostic[];
  /** Host-built exact-source navigation; it grants no access or report coverage. */
  modelDiagnosticsView?: { version: string; href: string };
  /** Identity and mission read from the admitted operator's own model scope. */
  operator?: { nativeId: string; name: string; instruction: string };
  executionPolicy?: ExecutionPolicy;
  modelVersion?: { digest: string; repositoryVersion?: string };
  /** This operator's explicitly admitted execution pin, distinct from repository HEAD. */
  admittedModelVersion?: { digest: string; repositoryVersion?: string };
  modelSources?: ModelSourceRevision;
  /** A source-pinned map; modelSources then contains only explicitly loaded files. */
  modelContext?: ModelContextOverview;
  /** Standard read-only context operations; they grant no source write or admission. */
  modelTools?: ModelContextTool[];
  /** Host capability only; policy, source base and admission are still checked. */
  modelEditing?: {
    targetedEdits: boolean;
    rawRevision: boolean;
    policy?:
      import("../../../domain/model/execution/native-contracts.ts").NativeModelEditPolicy;
  };
  /** Admitted administration authority, exposed only when the host can propose. */
  modelAdministration?: ModelAdministrationAuthority;
  /** Current repository records for this operator's own source proposals only. */
  sourceProposals?: readonly ModelSourceProposalStatus[];
  lastToolFailure?: ToolFailure;
  /** Only source-admitted exposures for this agent, with their native inputs. */
  modeledBehaviors?: readonly NativeBehaviorContract[];
  mandate?: ExecutionMandate;
  configuration?: Omit<SystemConfiguration, "changes"> & {
    changes: ReturnType<typeof changeDecisionMetadata>[];
  };
  contracts?: readonly ToolContract[];
  messages: Message[];
  activeTools: Array<
    Pick<Candidate, "id" | "name" | "description" | "digest" | "kind">
  >;
  candidates: Array<
    Pick<Candidate, "id" | "name" | "stage" | "error" | "kind">
  >;
  /** Recorded local artifact evidence, without code or access to a peer's catalog. */
  artifacts?: readonly ArtifactEvidence[];
  /** Source-admitted design instructions, never execution permissions. */
  modelingGuidance?:
    readonly import("../../../domain/model/execution/native-contracts.ts").NativeModelingGuidance[];
  /** Currently admitted local notes, supplied only through an exposed recall. */
  memoryGuidance?:
    readonly import("../../../domain/memory/governed-memory-promotion.ts").MemoryGuidance[];
  /** Local installed metadata and exact currently loaded instruction versions. */
  skills?: {
    policy: import("../../../domain/skills/context-skills.ts").SkillPolicy;
    catalog:
      readonly import("../../../domain/skills/entities/skill.ts").SkillMetadata[];
    loaded:
      readonly import("../../../domain/skills/entities/skill.ts").SkillGuidance[];
  };
  contextEvidence?: import("../context/evidence.ts").DecisionContextEvidence;
}

/** Facts about one exact artifact; evidence does not grant authority to use it. */
export type ArtifactEvidence =
  & Pick<
    Candidate,
    | "id"
    | "name"
    | "kind"
    | "digest"
    | "createdAt"
    | "tests"
    | "review"
    | "reviewExecution"
    | "admissionDecision"
    | "admission"
    | "reusedFrom"
  >
  & {
    localStage: Stage;
    /** Source observation for the exact identity, contract and digest, if available. */
    nativeStatus?: Stage;
    nativeModelVersion?: { digest: string; repositoryVersion?: string };
    contentDigestMatches: boolean;
    /** Confirmed at this observation only, never a grant to another operator. */
    activationConfirmed: boolean;
  };

export interface ModelSourceRevision {
  version: string;
  /** Host-verified design source S, separate from the executing contract R.
   * Read provenance only; this object conveys no source-edit or execution right. */
  requestSource?: {
    kind: "admitted-request-source";
    openingId: string;
    executionSpaceId: string;
    admittedSourceVersion: string;
    sourceAdmissionRevision: number;
    sourceAdmissionManifestDigest: string;
    executedSourceVersion: string;
  };
  /** Complete files. With modelContext present, this is the loaded working set. */
  sources: Record<string, string>;
  /** Bounded main-branch publication history of this exact source snapshot. */
  publishedRevisions?: {
    limit: number;
    proposalLimit: number;
    truncated: boolean;
    commits: PublishedModelRevision[];
  };
}

export interface PublishedModelRevision {
  version: string;
  sourceDigest: string;
  author: string;
  createdAt: string;
  /** Several accepted proposals may share one publication commit. */
  proposals?: Array<{ id: string; author: string }>;
}

export interface ModelRevisionRequest {
  reason: string;
  baseVersion: string;
  addresses?:
    import("../../../domain/model/value-objects/diagnostic-address.ts").ModelDiagnosticAddress[];
  /** Changed source files; the repository applies them to the exact base. */
  sources: Record<string, string>;
}

export interface ModelRevisionProposal {
  id: string;
  baseVersion: string;
  status: "pending";
  addresses?:
    import("../../../domain/model/value-objects/diagnostic-address.ts").ModelDiagnosticAddress[];
  [key: string]: unknown;
}

export interface ModelSourceProposalStatus {
  id: string;
  baseVersion: string;
  status: "preparing" | "proposed" | "accepting" | "accepted" | "rejected";
  acceptedVersion?: string;
  addresses?:
    import("../../../domain/model/value-objects/diagnostic-address.ts").ModelDiagnosticAddress[];
}
