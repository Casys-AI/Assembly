import type { PendingChange } from "../../../src/domain/governance/records/pending-change.ts";
import { MAIN_EXECUTION_SPACE_ID } from "../../../src/domain/governance/operator-authority.ts";
import type {
  AgentConversation,
  ConversationsSnapshot,
  OperatorTool,
} from "../../../src/domain/work/records/conversations.ts";
import type { Message } from "../../../src/domain/work/dialogue.ts";
import {
  caseAgentHref,
  caseHref,
  type CaseRecord,
  caseStatusLabel,
  caseTitle,
} from "../cases/cases.ts";
import { branchOperatorName, caseRoster } from "../cases/operator-names.ts";
import {
  type AuthorityRoster,
  decidedBy,
  type DecisionAuthor,
  sameCommit,
} from "../conversations/operator-authority.ts";
import {
  readNoticeRoute,
  readOperatorNotice,
  shortSummary,
} from "../conversations/operator-notice.ts";
import { changeTitle } from "../conversations/proposal-differences.ts";
import type { SourceHistory } from "../model/revisions/api.ts";
import { operatorName } from "../model/revisions/change.ts";
import type { SavedSystemView } from "../system/saved-systems.ts";
import { conversationHref, modelHref } from "../workbench/desk.ts";

export interface ActivityEvent {
  id: string;
  kind:
    | "request-opened"
    | "request-finished"
    | "decision"
    | "member-created"
    | "release-created"
    | "order"
    | "handoff"
    | "work";
  at: string;
  title: string;
  description?: string;
  byline?: string;
  href: string;
  facts: { label: string; value: string }[];
  decision?: {
    change: PendingChange;
    author?: DecisionAuthor;
    /** Only the name may be displayed; the helper's unknown ID stays in details. */
    by?: string;
    record?: { caseId: string; agentId: string };
  };
}

export interface ActivityInput {
  cases: readonly CaseRecord[];
  requests: readonly CaseRecord[];
  conversations: readonly AgentConversation[];
  requestSnapshots: ReadonlyMap<string, ConversationsSnapshot>;
  mainMessages: readonly Message[];
  history: SourceHistory | null;
  releases: readonly SavedSystemView[];
  tools?: readonly OperatorTool[];
}

/** Recorded events only. A proposal date is never a decision or publication date. */
export function activityEvents(input: ActivityInput): ActivityEvent[] {
  const events = new Map<string, ActivityEvent>();
  const add = (event: ActivityEvent) => {
    if (Number.isFinite(Date.parse(event.at))) events.set(event.id, event);
  };
  const requests = new Map(input.requests.map((record) => [record.id, record]));
  const cases = new Map(
    [...input.cases, ...input.requests].map((record) => [record.id, record]),
  );
  const ownerName = (record: CaseRecord) =>
    requests.has(record.id)
      ? branchOperatorName(record)
      : operatorName(input.conversations, record.owner);
  const completionNotices = new Map(input.mainMessages.flatMap((message) => {
    const notice = readOperatorNotice(message);
    return notice?.kind === "request-completed"
      ? [[notice.caseId, { notice, at: message.at }] as const]
      : [];
  }));
  for (const record of cases.values()) {
    if (record.type !== "request") continue;
    const name = ownerName(record);
    const common = {
      description: caseTitle(record),
      byline: name,
      href: caseHref(record.id),
      facts: [{ label: "Request", value: record.id }, {
        label: "Objective",
        value: record.objective,
      }, {
        label: "Operator",
        value: record.owner,
      }],
    };
    add({
      ...common,
      id: `opened:${record.id}`,
      kind: "request-opened",
      at: record.createdAt,
      title: `Request ${record.number} opened`,
    });
    if (
      record.closedAt &&
      (record.status === "closed-done" || record.status === "closed-abandoned")
    ) {
      const reported = completionNotices.get(record.id);
      add({
        ...common,
        id: `finished:${record.id}`,
        kind: "request-finished",
        at: record.closedAt,
        title: `Request ${record.number} finished · ${
          caseStatusLabel[record.status]
        }`,
        facts: [
          ...common.facts,
          ...(reported
            ? [{ label: "Report", value: reported.notice.result }]
            : []),
        ],
      });
    }
  }
  for (const message of input.mainMessages) {
    if (message.work) {
      const work = message.work;
      const returned = work.callerId === input.conversations.find((agent) =>
        agent.primary
      )?.nativeId;
      const memberId = returned ? work.targetNativeId : work.callerId;
      const member = input.conversations.find((agent) =>
        agent.nativeId === memberId
      );
      const name = operatorName(input.conversations, memberId);
      add({
        id: `work:${message.id}`,
        kind: "work",
        at: message.at,
        title: returned
          ? `${name ?? "An operator"} returned work`
          : `Work received from ${name ?? "an operator"}`,
        href: message.caseId
          ? caseHref(message.caseId)
          : conversationHref(member?.agentId),
        facts: [{ label: "Invocation", value: work.invocationId }, {
          label: "Operator",
          value: memberId,
        }, { label: "Message", value: message.text }],
      });
      continue;
    }
    const notice = readOperatorNotice(message);
    if (!notice) continue;
    const record = cases.get(notice.caseId);
    const facts = [{ label: "Request", value: notice.caseId }];
    const nameOf = (nativeId: string, spaceId?: string) =>
      record && spaceId !== MAIN_EXECUTION_SPACE_ID && record.owner === nativeId
        ? ownerName(record)
        : operatorName(input.conversations, nativeId);
    if (notice.kind === "authority-escalation") {
      if (notice.decisionAuthority !== "operator") continue;
      const route = readNoticeRoute(notice);
      const actor = route?.designatedDecider;
      add({
        id: `handoff:${message.id}`,
        kind: "handoff",
        at: message.at,
        title: `${
          nameOf(notice.requestedBy, route?.requester?.executionSpaceId) ??
            "An operator"
        } asked ${shortSummary(notice.reason)}${
          actor
            ? `, handed to ${
              nameOf(actor.operatorId, actor.executionSpaceId) ?? "an operator"
            }`
            : " · Operator decision"
        }`,
        href: caseHref(notice.caseId),
        facts: [
          ...facts,
          { label: "Change", value: notice.changeId },
          { label: "Request for authority", value: notice.reason },
          ...(route
            ? [{ label: "Route", value: JSON.stringify(route, null, 2) }]
            : []),
        ],
      });
    } else if (notice.kind === "request-completed") {
      if (events.has(`finished:${notice.caseId}`)) continue;
      add({
        id: `finished:${notice.caseId}`,
        kind: "request-finished",
        at: message.at,
        title: `${
          record ? `Request ${record.number}` : "Request"
        } completion reported · ${caseStatusLabel[notice.status]}`,
        description: record && caseTitle(record),
        byline: record ? ownerName(record) : undefined,
        href: caseHref(notice.caseId),
        facts: [...facts, { label: "Reported at", value: message.at }, {
          label: "Report",
          value: notice.result,
        }],
      });
    } else {
      const who = nameOf(
        notice.orderedBy.operatorId,
        notice.orderedBy.executionSpaceId,
      );
      const to = nameOf(notice.subordinate);
      add({
        id: `order:${notice.invocationId}`,
        kind: "order",
        at: message.at,
        title: `${who ?? "An operator"} gave ${to ?? "an operator"} an order`,
        href: caseHref(notice.caseId),
        facts: [...facts, { label: "Order", value: notice.summary }, {
          label: "Invocation",
          value: notice.invocationId,
        }],
      });
    }
  }
  const changes = (
    agents: readonly AgentConversation[],
    roster: AuthorityRoster,
    requestId?: string,
  ) => {
    for (const agent of agents) {
      for (const change of agent.proposalContext?.changes ?? []) {
        if (
          !change.decidedAt || !["approved", "refused"].includes(change.status)
        ) {
          continue;
        }
        const id = JSON.stringify([
          requestId ?? "main",
          agent.nativeId,
          change.id,
        ]);
        const author = decidedBy(change, roster);
        const by = author &&
          (author.by === "you" ||
              roster.some((member) => member.name === author.by)
            ? author.by
            : "an operator");
        const href = requestId
          ? caseAgentHref(requestId, agent.agentId)
          : change.caseId
          ? caseHref(change.caseId)
          : conversationHref(agent.agentId);
        add({
          id: `decision:${id}`,
          kind: "decision",
          at: change.decidedAt,
          title: changeTitle(change),
          href,
          facts: [],
          decision: {
            change,
            author,
            by,
            ...(requestId
              ? { record: { caseId: requestId, agentId: agent.agentId } }
              : {}),
          },
        });
        // Creation is publication, not approval. Only a dated matching commit
        // establishes when it happened; Request history is not exposed today.
        const published = change.status === "approved" &&
          change.publishedCommit &&
          input.history?.commits.find((commit) =>
            sameCommit(commit.version, change.publishedCommit!)
          );
        if (
          published &&
          (change.kind === "operator-creation" ||
            change.kind === "reviewer-creation")
        ) {
          add({
            id: `member:${id}`,
            kind: "member-created",
            at: published.createdAt,
            title: change.name
              ? `Member created · ${change.name}`
              : "Member created",
            href,
            facts: [{ label: "Change", value: change.id }, {
              label: "Published commit",
              value: published.version,
            }],
          });
        }
      }
    }
  };
  changes(input.conversations, input.conversations);
  for (const [caseId, snapshot] of input.requestSnapshots) {
    if (!requests.has(caseId)) continue;
    changes(snapshot.conversations, [
      ...input.conversations,
      ...caseRoster(
        snapshot.conversations.filter((agent) =>
          !input.conversations.some((main) => main.nativeId === agent.nativeId)
        ),
        requests.get(caseId),
      ),
    ], caseId);
  }
  for (const release of input.releases) {
    if (release.status !== "retained") continue;
    add({
      id: `release:${release.id}`,
      kind: "release-created",
      at: release.createdAt,
      title: `Release created · ${release.metadata.name}`,
      href: modelHref("releases"),
      facts: [
        { label: "Release", value: release.id },
        ...(release.source
          ? [{ label: "Source commit", value: release.source.sourceVersion }]
          : []),
      ],
    });
  }
  for (const tool of input.tools ?? []) {
    const { candidate } = tool;
    const admission = candidate.admission;
    if (
      !admission || admission.candidateId !== candidate.id ||
      admission.candidateDigest !== candidate.digest
    ) continue;
    const by = admission.authority === "human"
      ? "you"
      : operatorName(input.conversations, admission.actorId);
    add({
      id: `tool:${
        JSON.stringify([tool.agentId, candidate.id, candidate.digest])
      }`,
      kind: "decision",
      at: admission.at,
      title: `Tool admitted · ${candidate.name}`,
      byline: by ? `Decided by ${by}` : undefined,
      href: candidate.caseId
        ? caseAgentHref(candidate.caseId, tool.agentId)
        : conversationHref(tool.agentId),
      facts: [{ label: "Tool", value: candidate.id }, {
        label: "Admission receipt",
        value: JSON.stringify(admission, null, 2),
      }],
    });
  }
  return [...events.values()].sort((a, b) =>
    Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id)
  );
}
