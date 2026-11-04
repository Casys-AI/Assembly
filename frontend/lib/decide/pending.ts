import { signal } from "@preact/signals";
import type {
  AgentConversation,
  ConversationsSnapshot,
  OperatorToolsSnapshot,
} from "../../../src/application/work/operators/conversation-types.ts";
import type { SystemRuntimeState } from "../../../src/application/work/runtime/state.ts";
import { proposalOwner } from "../conversations/proposals.ts";
import {
  caseAgentHref,
  caseHref,
  type CaseRecord,
  messageCaseId,
} from "../cases/cases.ts";
import {
  revisionInspectionHref,
  type SourceRevisions,
} from "../model/revisions/api.ts";
import { toolProposalHref } from "../model/tool-proposal-location.ts";

export interface PendingDecision {
  id: string;
  kind: "proposal" | "authorization" | "tool";
  label: string;
  /** The operator whose conversation shows this decision, when there is one. */
  agentId?: string;
  agentName?: string;
  /** The exact Case named by the recorded decision, when supplied. */
  caseId?: string;
  /** The designer's own conversation, when the decision was made outside a Case. */
  designerScopeId?: string;
  /** The operator that asked, as the model names it (`nativeId`). */
  requestedBy?: string;
  href: string;
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** What the host recorded about where a decision was asked, as given. */
function originContext(
  record: object,
): Pick<PendingDecision, "caseId" | "designerScopeId" | "requestedBy"> {
  const { designerScopeId, requestedBy } = record as {
    designerScopeId?: unknown;
    requestedBy?: unknown;
  };
  const caseId = messageCaseId(record);
  return {
    ...(caseId ? { caseId } : {}),
    ...(text(designerScopeId) ? { designerScopeId } : {}),
    ...(text(requestedBy) ? { requestedBy } : {}),
  };
}

/**
 * Whether a Case is waiting for the person. The Case a decision records is the
 * only one it concerns, and a decision made in the designer's own conversation
 * concerns none. Only a historical decision without any recorded origin falls
 * back to its operator (the one who asked, else the one whose conversation
 * holds it) having a single open Case.
 */
export function caseHasPendingDecision(
  record: CaseRecord,
  openCases: readonly CaseRecord[],
  ownerAgentId: string | undefined,
  decisions: readonly PendingDecision[],
): boolean {
  const onlyCase = openCases.filter((entry) => entry.owner === record.owner)
    .length === 1;
  return decisions.some((decision) => {
    if (decision.caseId !== undefined) return decision.caseId === record.id;
    if (decision.designerScopeId !== undefined) return false;
    return onlyCase &&
      (decision.requestedBy !== undefined
        ? decision.requestedBy === record.owner
        : ownerAgentId !== undefined && decision.agentId === ownerAgentId);
  });
}

const conversationHref = (agentId: string) =>
  `/chat?${new URLSearchParams({ agent: agentId })}`;

/** A decision recorded in a Case opens that Case; else its operator's thread. */
const decisionHref = (record: { caseId?: string }, agentId: string) =>
  record.caseId ? caseHref(record.caseId) : conversationHref(agentId);

/** One decision per change an operator asked and the person has not decided. */
function authorizationDecisions(
  agents: readonly AgentConversation[],
): PendingDecision[] {
  return agents.flatMap((agent) =>
    (agent.proposalContext?.changes || []).filter((change) =>
      change.status === "pending"
    ).map((change): PendingDecision => {
      const origin = originContext(change);
      return {
        id: `authorization:${JSON.stringify([agent.agentId, change.id])}`,
        kind: "authorization",
        label: change.kind === "reviewer-creation"
          ? "Authorize reviewer creation"
          : change.kind === "operator-creation"
          ? "Authorize operator creation"
          : change.requestedRights &&
              "grantModelEditing" in change.requestedRights
          ? "Authorize model editing"
          : "Authorize mandate change",
        agentId: agent.agentId,
        agentName: agent.name,
        ...origin,
        href: decisionHref(origin, agent.agentId),
      };
    })
  );
}

/** Count only pending records with an existing destination for their review. */
export function aggregatePendingDecisions(input: {
  state: SystemRuntimeState | null;
  conversations?: ConversationsSnapshot | null;
  tools?: OperatorToolsSnapshot | null;
  proposals?: SourceRevisions | null;
}): PendingDecision[] {
  const { state } = input;
  if (!state) return [];
  const conversations = input.conversations?.systemId === state.id
    ? input.conversations
    : null;
  const agents = conversations?.conversations || [];
  const catalogue = input.tools?.systemId === state.id ? input.tools : null;
  const decisions = new Map<string, PendingDecision>();
  for (const proposal of input.proposals?.proposals || []) {
    if (proposal.status !== "proposed") continue;
    const owner = proposalOwner(proposal);
    const agent = owner && agents.find((entry) => entry.nativeId === owner);
    const id = `proposal:${proposal.id}`;
    decisions.set(id, {
      id,
      kind: "proposal",
      label: "Review model proposal",
      ...(agent ? { agentId: agent.agentId, agentName: agent.name } : {}),
      ...originContext(proposal),
      href: revisionInspectionHref({
        selection: { kind: "proposal", id: proposal.id },
      }),
    });
  }
  for (const decision of authorizationDecisions(agents)) {
    decisions.set(decision.id, decision);
  }
  if (catalogue) {
    for (const tool of catalogue.tools) {
      const agent = agents.find((entry) => entry.agentId === tool.agentId);
      if (
        !agent || tool.candidate.stage !== "awaiting-admission" ||
        tool.candidate.requiredAuthority !== "human"
      ) continue;
      const origin = originContext(tool.candidate);
      const id = `tool:${JSON.stringify([tool.agentId, tool.candidate.id])}`;
      decisions.set(id, {
        id,
        kind: "tool",
        label: `Authorize tool: ${tool.candidate.name}`,
        agentId: agent.agentId,
        agentName: agent.name,
        ...origin,
        href: toolProposalHref(tool),
      });
    }
  } else {
    // The chat still renders primary legacy candidates until a catalogue exists.
    const primary = agents.find((agent) => agent.primary);
    if (!conversations || primary) {
      for (const candidate of state.candidates) {
        if (
          candidate.stage !== "awaiting-admission" ||
          (candidate.requiredAuthority ||
              state.configuration?.builder.admissionAuthority) !== "human"
        ) continue;
        const origin = originContext(candidate);
        const id = `tool:${
          JSON.stringify([primary?.agentId || "legacy", candidate.id])
        }`;
        decisions.set(id, {
          id,
          kind: "tool",
          label: `Authorize tool: ${candidate.name}`,
          ...(primary
            ? { agentId: primary.agentId, agentName: primary.name }
            : {}),
          ...origin,
          href: origin.caseId
            ? caseHref(origin.caseId)
            : primary
            ? conversationHref(primary.agentId)
            : "/chat",
        });
      }
    }
  }
  return [...decisions.values()];
}

/**
 * What waits for the person in the Requests the snapshots read: the changes
 * their operators asked in them. A Request runs in its own execution space, so
 * its snapshot never carries the main system's id and the tools and model
 * proposals `aggregatePendingDecisions` counts are not its own.
 */
export function aggregateRequestDecisions(
  snapshots: ReadonlyMap<string, ConversationsSnapshot>,
): PendingDecision[] {
  return [...snapshots].flatMap(([caseId, snapshot]) =>
    authorizationDecisions(snapshot.conversations).map((decision) => ({
      ...decision,
      id: JSON.stringify([caseId, decision.id]),
      caseId,
      href: caseAgentHref(caseId, decision.agentId!),
    }))
  );
}

/** One global repository read, independent of the conversation being viewed. */
export function createPendingProposals(options: {
  systemId(): string | null;
  read(signal: AbortSignal): Promise<SourceRevisions>;
}) {
  const snapshot = signal<{ systemId: string; data: SourceRevisions } | null>(
    null,
  );
  const loading = signal(false);
  const error = signal("");
  let lifecycle = 0, generation = 0;
  let flight: Promise<void> | null = null;
  let queued = false;
  let abort: AbortController | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  function visible() {
    return snapshot.value?.systemId === options.systemId()
      ? snapshot.value.data
      : null;
  }
  function refresh(): Promise<void> {
    clearTimeout(scheduled);
    scheduled = undefined;
    if (!options.systemId()) return Promise.resolve();
    queued = true;
    if (flight) return flight;
    const requestLifecycle = lifecycle;
    loading.value = true;
    const task = (async () => {
      do {
        queued = false;
        const systemId = options.systemId();
        if (!systemId) return;
        const requestedGeneration = generation;
        abort = new AbortController();
        try {
          const data = await options.read(abort.signal);
          if (requestLifecycle !== lifecycle) return;
          if (
            requestedGeneration !== generation ||
            systemId !== options.systemId()
          ) continue;
          if (!Array.isArray(data.proposals)) {
            throw new Error("Model proposals could not be read.");
          }
          snapshot.value = { systemId, data };
          error.value = "";
        } catch {
          if (
            requestLifecycle === lifecycle &&
            requestedGeneration === generation &&
            systemId === options.systemId()
          ) {
            snapshot.value = null;
            error.value = "Model proposals could not be loaded.";
          }
        }
      } while (queued && requestLifecycle === lifecycle);
    })().finally(() => {
      if (flight === task) flight = null;
      if (requestLifecycle === lifecycle) loading.value = false;
    });
    flight = task;
    return task;
  }
  function invalidate() {
    generation++;
    loading.value = true;
    if (flight) {
      queued = true;
      return;
    }
    scheduled ??= setTimeout(() => {
      scheduled = undefined;
      void refresh();
    }, 80);
  }
  function dispose() {
    lifecycle++;
    generation++;
    abort?.abort();
    clearTimeout(scheduled);
    scheduled = undefined;
    queued = false;
    flight = null;
    snapshot.value = null;
    loading.value = false;
  }
  return { visible, loading, error, refresh, invalidate, dispose };
}
