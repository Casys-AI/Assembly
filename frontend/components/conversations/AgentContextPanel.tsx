import type { WorkbenchState } from "../../lib/workbench/state.ts";
import type { AgentConversation } from "../../../src/domain/work/records/conversations.ts";
import {
  AgentMandate,
  AgentTools,
  readAgentDetails,
  useSourceRights,
} from "./AgentDetails.tsx";

export interface AgentContextPanelProps {
  state: WorkbenchState;
  tab: "mission" | "mandate" | "tools";
  onClose(): void;
  /**
   * The operator described. Omitted, it is the selected conversation (with the
   * legacy primary fallback); `null` is an operator that is no longer available.
   */
  conversation?: AgentConversation | null;
}

const titles = { mission: "Mission", mandate: "Mandate", tools: "Tools" };

/** Conversation selection scopes this read view; it never grants authority. */
export function AgentContextPanel(
  { state, tab, onClose, ...props }: AgentContextPanelProps,
) {
  const details = readAgentDetails(state, props.conversation);
  const { conversation, unavailable, primaryFallback, name, mission } = details;
  useSourceRights(state, conversation, tab === "mandate");

  return (
    <aside
      id="agent-context-panel"
      class="agent-context-panel"
      aria-label={`${titles[tab]} of ${name}`}
      data-agent-id={conversation?.agentId ||
        (primaryFallback ? "primary" : "")}
    >
      <header class="agent-context-header">
        <div>
          <h2>{name}</h2>
          <p>{titles[tab]}</p>
        </div>
        <button
          type="button"
          class="agent-context-close"
          aria-label="Close the panel"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div class="agent-context-body">
        {unavailable && (
          <p class="agent-context-empty" role="status">
            This agent is not available.
          </p>
        )}
        {!unavailable && tab === "mission" && (
          mission
            ? <p class="agent-context-mission">{mission}</p>
            : <p class="agent-context-empty">Mission not recorded.</p>
        )}
        {!unavailable && tab === "mandate" && (
          <AgentMandate details={details} empty="Mandate not recorded." />
        )}
        {!unavailable && tab === "tools" && (
          <AgentTools
            state={state}
            details={details}
            empty="No tool available."
          />
        )}
      </div>
    </aside>
  );
}
