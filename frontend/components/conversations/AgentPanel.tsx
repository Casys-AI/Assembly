import { RequestOperatorDetails } from "./RequestOperatorDetails.tsx";
import type { ComponentChildren } from "preact";
import type { AgentConversation } from "../../../src/domain/work/records/conversations.ts";
import { caseOperatorName } from "../../lib/cases/operator-names.ts";
import { monogram } from "../../lib/workbench/desk.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";
import {
  AgentMandate,
  AgentSkills,
  AgentTools,
  readAgentDetails,
  useSourceRights,
} from "./AgentDetails.tsx";

function Section({ label, children }: {
  label: string;
  children: ComponentChildren;
}) {
  return (
    <section class="agent-panel-section">
      <h3>{label}</h3>
      {children}
    </section>
  );
}

/**
 * What the agent of the selected conversation is: its mission, then its
 * mandate, tools and skills. Read-only: the panel grants and changes nothing.
 */
export function AgentPanel(
  { state, conversation, requestCaseId }: {
    state: WorkbenchState;
    conversation: AgentConversation;
    requestCaseId?: string;
  },
) {
  const details = readAgentDetails(state, conversation);
  useSourceRights(state, conversation, requestCaseId === undefined);
  const { mission } = details;
  const name = caseOperatorName(
    details.name,
    state.requests.cases.byId(requestCaseId),
  );
  if (requestCaseId) {
    const query = new URLSearchParams({
      caseBranch: requestCaseId,
      agent: conversation.agentId,
    });
    const releaseQuery = new URLSearchParams(query);
    releaseQuery.set("create", "1");
    if (conversation.repositoryVersion) {
      releaseQuery.set("version", conversation.repositoryVersion);
    }
    return (
      <aside
        class="agent-panel"
        aria-label={`${name}, details`}
        data-agent-id={conversation.agentId}
      >
        <header class="agent-panel-head">
          <span class="agent-tile" aria-hidden="true">{monogram(name)}</span>
          <h2>{name}</h2>
          {mission && <p title={mission}>{mission}</p>}
        </header>
        <Section label="Model">
          <p>Request · read-only</p>
          {conversation.repositoryVersion && (
            <p title={conversation.repositoryVersion}>
              {conversation.repositoryVersion}
            </p>
          )}
          <p>
            <a href={`/model?page=files&${query}`}>View model</a>
          </p>
          <p>
            <a href={`/model?page=releases&${releaseQuery}`}>
              Create release
            </a>
          </p>
        </Section>
        <RequestOperatorDetails
          key={`${requestCaseId}:${conversation.agentId}`}
          caseId={requestCaseId}
          operatorId={conversation.agentId}
          expectedModelDigest={conversation.modelDigest}
          expectedVersion={conversation.repositoryVersion}
          sessionReady={state.requests.sessionReady.value}
          sessionGeneration={state.requests.sessionGeneration.value}
          conversationRevision={conversation.revision}
        />
      </aside>
    );
  }
  // The read model is not validated field by field: a malformed catalog is
  // read as absent, and an entry without a name is not a row.
  const skills = Array.isArray(conversation.skills)
    ? conversation.skills.filter((skill) =>
      skill && typeof skill.id === "string" && typeof skill.name === "string"
    )
    : undefined;
  return (
    <aside
      class="agent-panel"
      aria-label={`${name}, details`}
      data-agent-id={conversation.agentId}
    >
      <header class="agent-panel-head">
        <span class="agent-tile" aria-hidden="true">{monogram(name)}</span>
        <h2>{name}</h2>
        {mission && <p title={mission}>{mission}</p>}
      </header>
      <Section label="Mandate">
        <AgentMandate details={details} empty="None" compact />
      </Section>
      <Section label="Tools">
        <AgentTools state={state} details={details} empty="None" />
      </Section>
      {skills && (
        <Section label="Skills">
          <AgentSkills
            skills={skills}
            empty="None"
          />
        </Section>
      )}
    </aside>
  );
}
