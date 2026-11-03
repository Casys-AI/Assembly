import type { EnvironmentReader } from "../infrastructure/environment.ts";
import type {
  CompletionFlushResult,
  CompletionObserverStatus,
} from "../adapters/out/llm-providers/completion-observer.ts";
import { MuseAgents } from "../adapters/out/llm-providers/agents.ts";
import {
  LangChainAgents,
  type LangChainAgentsOptions,
} from "../adapters/out/llm-providers/langchain-agents.ts";

export interface ProviderConfiguration {
  provider: string;
  agentModel: string | undefined;
  agentEffort: string;
  decisionMaxTokens: number | undefined;
}

/** Startup provider semantics shared by the entry point and its regressions. */
export function resolveProviderConfiguration(
  read: EnvironmentReader,
): ProviderConfiguration {
  const provider = read("AGENT_PROVIDER") ?? "claude";
  const agentModel = provider === "muse"
    ? read("MUSE_MODEL") || undefined
    : read("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5";
  const agentEffort = provider === "muse"
    ? "medium"
    : read("ANTHROPIC_EFFORT") ?? "high";
  const decisionMaxTokens = provider !== "muse" &&
      read("ANTHROPIC_DECISION_MAX_TOKENS") !== undefined
    ? Number(read("ANTHROPIC_DECISION_MAX_TOKENS"))
    : undefined;
  return { provider, agentModel, agentEffort, decisionMaxTokens };
}

/** Build the selected adapter without starting a provider request. */
export function createProviderAgents(
  configuration: ProviderConfiguration,
  read: EnvironmentReader,
  onCompletion?: LangChainAgentsOptions["onCompletion"],
) {
  const { provider, agentModel, agentEffort, decisionMaxTokens } =
    configuration;
  return provider === "muse"
    ? new MuseAgents({
      command: read("MUSE_BIN") ?? "muse",
      model: agentModel,
    })
    : new LangChainAgents({
      apiKey: read("ANTHROPIC_API_KEY") ?? "",
      model: agentModel!,
      decisionMaxTokens,
      effort: agentEffort,
      onCompletion,
    });
}

/** Muse has no equivalent completion coverage; unsupported is not zero. */
export type ProviderObservation = {
  supported: true;
  status(): CompletionObserverStatus;
  close(deadlineMs?: number): Promise<CompletionFlushResult>;
} | { supported: false; coverage: "unsupported" };

/** Expose completion collection health without starting a provider request. */
export function providerObservation(
  agents: LangChainAgents | MuseAgents,
): ProviderObservation {
  return agents instanceof LangChainAgents
    ? {
      supported: true,
      status: () => agents.completionObservation.status(),
      close: (deadlineMs = 1000) =>
        agents.completionObservation.close(deadlineMs),
    }
    : { supported: false, coverage: "unsupported" };
}
