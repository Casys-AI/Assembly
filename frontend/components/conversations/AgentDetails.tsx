import { useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { WorkbenchState } from "../../lib/workbench/state.ts";
import {
  operatorTools,
  toolServers,
  usableCandidates,
} from "../../lib/system/tools/servers.ts";
import type { ModelEditGrant } from "../../../src/domain/governance/policies/model-edit-policy.ts";
import {
  candidateReadMessage,
  candidatesFor,
  candidateState,
} from "../../lib/system/tools/candidates.ts";
import { ToolCandidateChip } from "../system/ToolCandidateChip.tsx";
import type { AgentConversation } from "../../../src/domain/work/records/conversations.ts";

/**
 * What an agent's details read, shared by the drawer on an agent's name
 * (`AgentContextPanel`) and the panel beside a Case's conversation
 * (`AgentPanel`). These are read views of the operator; they grant nothing.
 */
export function readAgentDetails(
  state: WorkbenchState,
  /**
   * The operator described. Omitted, it is the selected conversation (with the
   * legacy primary fallback); `null` is an operator that is no longer available.
   */
  given?: AgentConversation | null,
) {
  const conversation = given !== undefined
    ? given
    : state.selectedConversation.value;
  const current = state.current.value;
  const displayed = state.displayed.value;
  // An operator that left the catalogue never borrows the primary's details.
  const unavailable = given === null;
  const primaryFallback = !conversation && !unavailable &&
    !state.readOnly.value && !!current && displayed === current;
  const name = conversation?.name ||
    (primaryFallback ? displayed?.executionModel?.operator?.name : undefined) ||
    "Agent";
  const legacy = primaryFallback ? displayed : null;
  const catalogue = state.visibleOperatorTools.value;
  const tools = conversation
    ? operatorTools(catalogue, [conversation.agentId])
    : {
      candidates: usableCandidates(
        primaryFallback ? legacy?.candidates ?? [] : [],
      ),
      modelTools: primaryFallback ? legacy?.modelTools ?? [] : [],
    };
  const toolRead = {
    catalogue,
    loading: state.operatorTools.loading.value,
    stale: state.operatorTools.stale.value,
    error: state.operatorTools.error.value,
  };
  const toolEntries = conversation
    ? candidatesFor(toolRead, [conversation.agentId])
    : [];
  const context = conversation?.proposalContext?.before;
  return {
    conversation,
    unavailable,
    primaryFallback,
    primary: conversation?.primary ?? primaryFallback,
    name,
    legacy,
    context,
    mission: conversation?.responsibility ||
      (primaryFallback ? legacy?.executionModel?.operator?.instruction : null),
    hosts: context?.network.allowedHosts ??
      legacy?.configuration?.network?.allowedHosts,
    admission: context?.builder.admissionAuthority ||
      legacy?.configuration?.builder.admissionAuthority,
    declared: legacy?.executionModel?.mandate,
    sourceRights: conversation && !state.readOnly.value
      ? state.chatProposals.visible(conversation.nativeId)?.runtime.sourceRights
      : undefined,
    candidates: conversation
      ? toolEntries.map((entry) => entry.candidate)
      : tools.candidates,
    toolEntries,
    toolRead,
    modelTools: tools.modelTools,
    toolsUnknown: Boolean(
      conversation &&
        (!catalogue || state.operatorTools.loading.value ||
          state.operatorTools.stale.value),
    ),
  };
}
export type AgentDetails = ReturnType<typeof readAgentDetails>;

/** Reads the rights the source grants the operator, once, when they are shown. */
export function useSourceRights(
  state: WorkbenchState,
  conversation: AgentConversation | null | undefined,
  wanted: boolean,
) {
  useEffect(() => {
    if (
      wanted && conversation &&
      conversation.runtimeOwned !== false && !state.readOnly.value &&
      !state.chatProposals.visible(conversation.nativeId)
    ) {
      void state.chatProposals.refresh(conversation.nativeId);
    }
  }, [wanted, conversation?.nativeId, conversation?.revision]);
}

const admissions = {
  human: "Human decision",
  reviewer: "Reviewer",
  builder: "Main Operator under delegation",
};
const urlSelections = {
  "user-provided": "Pages in the request",
  "authorized-host": "Pages of allowed hosts",
};

function Fact({ label, children }: {
  label: string;
  children: ComponentChildren;
}) {
  return (
    <p>
      <strong>{label}</strong>
      <span>{children}</span>
    </p>
  );
}

function Grants({ grants }: { grants: readonly ModelEditGrant[] }) {
  return (
    <ul class="agent-context-grants">
      {grants.map((grant) => (
        <li key={grant.file}>
          <code>{grant.file}</code>
          <span>{grant.qualifiedRoots.join(", ")}</span>
        </li>
      ))}
    </ul>
  );
}

/** A scope that opens in the drawer and shows in full in the compact panel. */
function Scope(
  { label, compact, children }: {
    label: string;
    compact: boolean;
    children: ComponentChildren;
  },
) {
  return compact ? <>{children}</> : (
    <details>
      <summary>{label}</summary>
      {children}
    </details>
  );
}

/**
 * The mandate: what the agent may reach and do, as far as it is known. `empty`
 * is what shows when nothing is known; `compact` drops the disclosures.
 */
export function AgentMandate(
  { details, empty, compact = false }: {
    details: AgentDetails;
    empty: string;
    compact?: boolean;
  },
) {
  const { context, hosts, admission, declared, sourceRights } = details;
  if (!context && !sourceRights && !details.legacy) {
    return <p class="agent-context-empty">{empty}</p>;
  }
  const editing = sourceRights?.modelEditPolicy;
  const administration = sourceRights?.modelAdministration;
  return (
    <div class="agent-context-mandate">
      {hosts && <Fact label="Allowed hosts">{hosts.join(", ") || "None"}</Fact>}
      {context?.urlSelectionMode && (
        <Fact label="URL selection">
          {urlSelections[context.urlSelectionMode]}
        </Fact>
      )}
      {admission && <Fact label="Tool admission">{admissions[admission]}</Fact>}
      {details.primary && declared && (
        <Fact label="Declared capabilities">
          {[
            declared.mayPropose.length && "Propose tools",
            declared.mayInvoke === "active-catalog-only" && "Use active tools",
          ].filter(Boolean).join(" · ") || "None"}
        </Fact>
      )}
      {sourceRights && (
        <>
          <Fact label="Model editing">
            {editing ? editing.operations.join(", ") : "None"}
          </Fact>
          {editing && (
            <Scope label="Editing scope" compact={compact}>
              <Grants grants={editing.grants} />
            </Scope>
          )}
          <Fact label="Model administration">
            {administration ? administration.operations.join(", ") : "None"}
          </Fact>
          {administration && (
            <Scope label="Administration scope" compact={compact}>
              <Grants grants={administration.grants} />
              <p>
                Recipients: {administration.recipients.join(", ") || "none"}
              </p>
            </Scope>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The tools of the agent, grouped by server the way an MCP client lists them:
 * one row per server with its count, opened on its tools' short names, their
 * description and, while not usable, their stage. Nothing here admits,
 * refuses or runs a tool.
 */
export function AgentTools(
  { details, empty }: {
    state: WorkbenchState;
    details: AgentDetails;
    /** What shows when the catalogue is known and the agent has no tool. */
    empty: string;
  },
) {
  const {
    candidates,
    modelTools,
    toolsUnknown,
    conversation,
    toolEntries,
    toolRead,
  } = details;
  const message = toolsUnknown ? candidateReadMessage(toolRead) : undefined;
  const servers = toolServers(candidates, modelTools);
  if (servers.length) {
    return (
      <>
        {toolsUnknown && (
          <p class="agent-context-status" role="status">
            {message}
          </p>
        )}
        <ul class="tool-servers">
          {servers.map((server) => {
            const waiting = server.tools.filter((tool) =>
              tool.stage && tool.stage !== "refused" && tool.stage !== "failed"
            ).length;
            return (
              <li key={server.name} data-tool-server={server.name}>
                <details>
                  <summary>
                    <span class="tool-server-name">{server.name}</span>
                    {waiting > 0 && <span class="chip">{waiting} pending</span>}
                    <span class="tool-server-count">{server.tools.length}</span>
                  </summary>
                  <ul class="agent-context-tools">
                    {server.tools.map((tool) => (
                      <li
                        key={`${tool.kind}:${tool.id}`}
                        class="agent-context-tool"
                        {...(tool.kind === "candidate"
                          ? { "data-tool-id": tool.id }
                          : { "data-model-tool-id": tool.id })}
                      >
                        <div class="agent-context-tool-head">
                          {tool.kind === "candidate"
                            ? (() => {
                              const exact = toolEntries.find((entry) =>
                                entry.candidate.id === tool.id
                              );
                              const candidate = candidates.find((candidate) =>
                                candidate.id === tool.id
                              );
                              return exact
                                ? (
                                  <ToolCandidateChip
                                    tool={exact}
                                    read={toolRead}
                                  />
                                )
                                : (
                                  <>
                                    <code>{tool.name}</code>
                                    {candidate && (
                                      <span>
                                        {candidateState(candidate).label}
                                      </span>
                                    )}
                                  </>
                                );
                            })()
                            : <code>{tool.name}</code>}
                        </div>
                        <p title={tool.description}>{tool.description}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            );
          })}
        </ul>
      </>
    );
  }
  return (
    <p class="agent-context-empty" role="status">
      {toolsUnknown
        ? message
        : !conversation && !details.primaryFallback
        ? "Tools not recorded."
        : empty}
    </p>
  );
}

/**
 * The skills installed for the agent, metadata only. The description stays in
 * the tooltip; runtime loading state does not add a badge to this list.
 */
export function AgentSkills(
  { skills, empty }: {
    skills: NonNullable<AgentConversation["skills"]>;
    empty: string;
  },
) {
  return skills.length
    ? (
      <ul class="agent-context-tools agent-context-skills">
        {skills.map((skill) => (
          <li
            key={skill.id}
            class="agent-context-tool"
            title={skill.description}
            data-skill-id={skill.id}
          >
            <div class="agent-context-tool-head">
              <strong>{skill.name}</strong>
            </div>
          </li>
        ))}
      </ul>
    )
    : <p class="agent-context-empty">{empty}</p>;
}
