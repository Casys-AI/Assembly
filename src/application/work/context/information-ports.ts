import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { MemoryGuidance } from "../../../domain/memory/governed-memory-promotion.ts";
import type { ChatContext } from "../conversation/chat-context.ts";
import type { Message } from "../runtime/state.ts";
import { type ModelContextTool } from "./model-tools.ts";
import type {
  ModelContextOverview,
  ModelContextQuery,
  ModelContextQueryResult,
  ModelGraphQueryResult,
} from "../../../domain/model/consultation/context.ts";

/** Version-pinned read surface; graph queries never use the Toolkit evaluator. */
export interface ModelConsultationReader {
  overview(requested?: string): Promise<ModelContextOverview>;
  query(input: ModelContextQuery): Promise<ModelContextQueryResult>;
  queryGraph?(
    version: string,
    sourceDigest: string,
    expression: string,
  ): Promise<ModelGraphQueryResult>;
}

export interface ModelConsultationPin {
  version: string;
  sourceDigest: string;
  modelContext: NonNullable<ChatContext["modelContext"]>;
  modelSources: NonNullable<ChatContext["modelSources"]>;
}

export interface ModelConsultationResponseBudget {
  /** Remaining JSON characters under the current admitted decision policy. */
  maxResponseCharacters?: number;
  /** Exact caller working set, validated within the adapter before and after reads. */
  expectedPin?: ModelConsultationPin;
}

export interface DecisionInformation {
  memoryGuidance: MemoryGuidance[];
  skills?: ChatContext["skills"];
  modelContext?: ModelContextOverview & {
    loadedSources: Array<{ path: string; characters: number }>;
    maxLoadedCharacters: number;
  };
  modelSources?: ChatContext["modelSources"];
  modelTools?: ModelContextTool[];
}

/** Read-only current information from the admitted operator's own scope. */
export interface DecisionInformationPort {
  /** The same effective catalogue used by dispatch, snapshots and decisions. */
  modelTools?(model: ExecutableModel): ModelContextTool[];
  read(
    model: ExecutableModel,
    messages?: readonly Message[],
  ): Promise<DecisionInformation>;
  assertModelContextPin?(
    model: ExecutableModel,
    messages: readonly Message[],
    pin: ModelConsultationPin,
  ): Promise<void>;
  withModelContextPin?<T>(
    model: ExecutableModel,
    messages: readonly Message[],
    pin: ModelConsultationPin,
    operation: () => Promise<T>,
  ): Promise<T>;
  consultModel?(
    model: ExecutableModel,
    input: Record<string, unknown>,
    messages?: readonly Message[],
    budget?: ModelConsultationResponseBudget,
  ): Promise<unknown>;
  /** Closed source-declared reads of the exact admitted pin, independent of
   * the design working set. Results retain the actual bounded source data. */
  consultAdmittedModelSource?(
    model: ExecutableModel,
    input: Record<string, unknown>,
    messages?: readonly Message[],
    budget?: ModelConsultationResponseBudget,
  ): Promise<unknown>;
}
