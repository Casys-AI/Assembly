import type { AgentConversation } from "../../../src/application/work/operators/conversation-types.ts";
import type { Message } from "../../../src/application/work/runtime/state.ts";
import { type CaseRecord, messageCaseId } from "./cases.ts";
import { caseOperatorName } from "./operator-names.ts";

/** The name of a Case whose owner the roster does not know. */
export const unknownOwnerName = "Coordinator";

/** One agent's conversation in a Case, and the agents it asked for work. */
export interface CaseTreeNode {
  /** `null` only for the root, when the roster does not know the owner. */
  agent: AgentConversation | null;
  name: string;
  /** What the agent said or heard in this Case, the oldest first. */
  messages: Message[];
  busy: boolean;
  children: CaseTreeNode[];
}

const time = (message: Message | undefined) =>
  message ? Date.parse(message.at) || 0 : Number.MAX_SAFE_INTEGER;

function node(
  agent: AgentConversation | null,
  messages: Message[],
  record: Pick<CaseRecord, "id"> & Partial<Pick<CaseRecord, "objective">>,
): CaseTreeNode {
  return {
    agent,
    name: agent
      ? caseOperatorName(
        agent.name || agent.agentId,
        record.objective === undefined
          ? undefined
          : { id: record.id, objective: record.objective },
      )
      : unknownOwnerName,
    messages,
    busy: agent?.busy === true,
    children: [],
  };
}

/**
 * The agents of one Case as a tree. The root is the Case's owner, always there
 * even without a message. Admitted team members match the exact Request and
 * its owner, even before their first message, and follow their modeled parent.
 * An agent with messages in the Case otherwise sits under the
 * agent whose `nativeId` is the `callerId` of its first delegated message;
 * with no known caller (or the owner, or an agent outside the tree) it sits
 * under the root. A caller loop is cut where it closes. Siblings follow the
 * time of their first message in the Case.
 */
export function caseTree(
  conversations: readonly AgentConversation[],
  record: Pick<CaseRecord, "id"> & Partial<Pick<CaseRecord, "objective">>,
  owner: AgentConversation | null,
): CaseTreeNode {
  const thread = (agent: AgentConversation) =>
    agent.messages
      .filter((message) => messageCaseId(message) === record.id)
      .sort((a, b) => time(a) - time(b));
  const root = node(owner, owner ? thread(owner) : [], record);
  const memberOfRequest = (agent: AgentConversation) =>
    agent.runtimeOwned !== false && owner !== null &&
    agent.operatorTeam?.requestId === record.id &&
    agent.operatorTeam.requestOwnerId === owner.nativeId;
  const members = conversations
    .filter((agent) => agent.agentId !== owner?.agentId)
    .map((agent, index) => ({ agent, index, messages: thread(agent) }))
    .filter(({ agent, messages }) =>
      messages.length > 0 || memberOfRequest(agent)
    )
    .sort((a, b) =>
      time(a.messages[0]) - time(b.messages[0]) || a.index - b.index
    )
    .map(({ agent, messages }) => ({
      agent,
      tree: node(agent, messages, record),
    }));
  const byNativeId = new Map<string, CaseTreeNode>();
  for (const { agent, tree } of members) {
    if (!byNativeId.has(agent.nativeId)) byNativeId.set(agent.nativeId, tree);
  }
  const parents = new Map<CaseTreeNode, CaseTreeNode>();
  const above = (ancestor: CaseTreeNode, from: CaseTreeNode) => {
    for (let at: CaseTreeNode | undefined = from; at; at = parents.get(at)) {
      if (at === ancestor) return true;
    }
    return false;
  };
  for (const { tree: member } of members) {
    const callerId = member.agent && memberOfRequest(member.agent)
      ? member.agent.operatorTeam!.parentOperatorId
      : member.messages.find((message) => message.work?.callerId)?.work
        ?.callerId;
    const caller = callerId && callerId !== owner?.nativeId
      ? byNativeId.get(callerId) ?? root
      : root;
    // An agent never sits under itself or under one of its own descendants.
    const parent = above(member, caller) ? root : caller;
    parents.set(member, parent);
    parent.children.push(member);
  }
  return root;
}

/** The node of a sub-agent in the tree, never the root. */
export function caseTreeAgent(
  root: CaseTreeNode,
  agentId: string | null | undefined,
): CaseTreeNode | undefined {
  if (!agentId) return undefined;
  const pending = [...root.children];
  for (let next = pending.shift(); next; next = pending.shift()) {
    if (next.agent?.agentId === agentId) return next;
    pending.push(...next.children);
  }
  return undefined;
}
