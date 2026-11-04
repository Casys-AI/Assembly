import type { Candidate } from "../../../domain/work/records/candidates.ts";
import type { Message } from "../runtime/state.ts";
import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";
import type {
  SystemConfiguration,
} from "../../../domain/governance/records/system-configuration.ts";
import { type ModelContextTool } from "../context/model-tools.ts";
import type { SkillMetadata } from "../../../domain/skills/entities/skill.ts";

/** A read model of a modeled operator, never a grant inferred from its name. */
export interface AgentConversation {
  agentId: string;
  nativeId: string;
  name: string;
  responsibility: string;
  /** Source-owned Request team membership; display metadata confers no authority. */
  operatorTeam?: Readonly<
    NonNullable<
      import("../../../domain/model/execution/executable-model.ts").ExecutableModel[
        "operatorTeam"
      ]
    >
  >;
  primary: boolean;
  /** False for a recorded audit without an independently admitted runtime. */
  runtimeOwned?: boolean;
  /** Human input needs its own modeled entry; observing a review grants none. */
  canSend: boolean;
  readOnlyReason?: string;
  revision: number;
  busy: boolean;
  phase: string;
  /** Static observation of this Request's still-current initial input only. */
  initialExecutionOutcome?: "refused";
  messages: Message[];
  /** Exact current host designer identity; absence never implies the designer. */
  designerScopeId?: string;
  /** Durable model activations projected independently of the LLM dialogue. */
  effectiveModelUpdates?:
    import("../../../domain/work/records/effective-model-update.ts").EffectiveModelUpdate[];
  /**
   * The skills installed for this agent, metadata only: `loaded` ones guide its
   * current work. Absent when the agent has no skill catalog. Read-only.
   */
  skills?: Array<
    Pick<
      SkillMetadata,
      "id" | "name" | "description" | "loaded" | "sourceBinding"
    >
  >;
  modelDigest: string;
  repositoryVersion?: string;
  /** Runtime observations for reviewing exact proposals; these confer no authority. */
  proposalContext?: {
    configurationRevision: number;
    before: {
      network: { allowedHosts: string[] };
      builder: Pick<SystemConfiguration["builder"], "admissionAuthority">;
      reviewer?: SystemConfiguration["reviewer"];
      urlSelectionMode?: "user-provided" | "authorized-host";
    };
    changes: PendingChange[];
  };
}

export interface ConversationsSnapshot {
  /** Current durable evolution metadata, scoped by its actual captured origin. */
  evolutions?:
    import("../../../domain/work/records/operator-evolution.ts").EvolutionConversationsSnapshot;
  systemId: string;
  defaultAgentId: string;
  /** A read identity for this aggregate, independent of command CAS revisions. */
  version: string;
  conversations: AgentConversation[];
}

export interface AgentMessageCommand {
  agentId: string;
  text: string;
  expectedRevision: number;
  /** Without newConversation, absence selects the perpetual designer. */
  caseId?: string;
  newConversation?: true;
}

/** Catalog occurrences remain owned by their exact modeled operator session. */
export interface OperatorTool {
  agentId: string;
  agentName: string;
  revision: number;
  candidate: Candidate;
}

export interface OperatorToolsSnapshot {
  systemId: string;
  version: string;
  tools: OperatorTool[];
  /** Available model consultations reported by each operator's runtime. */
  modelTools?: Array<{
    agentId: string;
    agentName: string;
    tool: ModelContextTool;
  }>;
}
