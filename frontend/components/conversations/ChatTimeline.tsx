import { MessageText } from "./MessageText.tsx";
import { caseOperatorName } from "../../lib/cases/operator-names.ts";
import { ToolSteps } from "./ToolSteps.tsx";
import type { ProposalDecisionState } from "./ChatProposalCard.tsx";
import { Fragment } from "preact";
import { useEffect } from "preact/hooks";
import type { WorkbenchState } from "../../lib/workbench/state.ts";
import type {
  AgentConversation,
  OperatorTool,
} from "../../../src/domain/work/records/conversations.ts";
import type { Candidate } from "../../../src/domain/work/candidates.ts";
import type { Message } from "../../../src/domain/work/dialogue.ts";
import type {
  PendingChange,
} from "../../../src/domain/governance/records/pending-change.ts";
import type { SourceProposal } from "../../lib/model/revisions/api.ts";
import { proposalOwner } from "../../lib/conversations/proposals.ts";
import {
  candidateDifferences,
  displaySourceDifferences,
} from "../../lib/conversations/proposal-differences.ts";
import { ChatProposalCard } from "./ChatProposalCard.tsx";
import { CandidateAuthorityFacts } from "./OperatorAuthorityFacts.tsx";
import { OperatorNoticeRow } from "./OperatorNoticeRow.tsx";
import {
  adjustmentProps,
  cannotAdjust,
  ChangeProposalCard,
} from "./ChangeProposalCard.tsx";
import { EvolutionProposalCard } from "./EvolutionProposalCard.tsx";
import {
  currentEvolutionRecord,
  type EvolutionConversationRecord,
  evolutionOriginMatches,
  messageEvolution,
  readEvolutionRecord,
} from "../../lib/conversations/evolution.ts";
import { caseHref, caseTitle, messageCaseId } from "../../lib/cases/cases.ts";
import { conversationHref } from "../../lib/workbench/desk.ts";
import { operatorName } from "../../lib/model/revisions/change.ts";
import {
  type OperatorNotice,
  readOperatorNotice,
} from "../../lib/conversations/operator-notice.ts";
import {
  newToolPatch,
  ProposalCodeDiff,
} from "../model/changes/ProposalCodeDiff.tsx";
import type { EffectiveModelUpdate } from "../../../src/domain/work/records/effective-model-update.ts";
import { ModelUpdateDivider } from "./ModelUpdateDivider.tsx";
import { candidateState } from "../../lib/system/tools/candidates.ts";

const sourceStatus: Record<SourceProposal["status"], string> = {
  preparing: "Preparing",
  proposed: "To decide",
  accepting: "Accepting…",
  accepted: "Accepted",
  rejected: "Declined",
};
const toolStatus: Record<Candidate["stage"], string> = {
  proposed: "Proposed",
  testing: "Checking…",
  reviewing: "In review",
  "awaiting-admission": "To decide",
  active: "Active",
  activating: "Activating…",
  refused: "Declined",
  failed: "Failed",
};

/** Remove only equal surrounding lines. Every differing byte stays available. */
export function changedSource(before = "", after = "") {
  const a = before.split("\n"), b = after.split("\n");
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start && end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) end++;
  return {
    before: a.slice(Math.max(0, start - 1), a.length - Math.max(0, end - 1))
      .join("\n"),
    after: b.slice(Math.max(0, start - 1), b.length - Math.max(0, end - 1))
      .join("\n"),
  };
}
function SourceProposalCard(
  { proposal, agentId, conversation, state }: {
    proposal: SourceProposal;
    agentId: string;
    conversation: AgentConversation | null;
    state: WorkbenchState;
  },
) {
  const store = state.chatProposals;
  const data = store.visible(agentId);
  const preview = store.preview(proposal, agentId);
  const previewError = store.previewError(proposal, agentId);
  const rows = preview
    ? displaySourceDifferences(
      preview.rows,
      state.conversationSnapshot.value?.conversations || [],
    )
    : [];
  useEffect(() => {
    void store.loadPreview(proposal, agentId);
  }, [
    agentId,
    proposal.id,
    proposal.sourceDigest,
    proposal.proposalVersion,
    data?.version,
  ]);
  const available = data?.runtime.available;
  const canActivate = proposal.status === "accepted" &&
    available?.repositoryVersion &&
    available?.repositoryVersion === proposal.acceptedVersion &&
    data?.runtime.executable &&
    available.digest !== data.runtime.active?.digest;
  const beneficiaryId = preview?.rows.find((row) =>
    row.id.endsWith(":targetHolderNativeId")
  )?.after;
  const beneficiary = state.conversationSnapshot.value?.conversations.find((
    agent,
  ) => agent.nativeId === beneficiaryId)?.name || preview?.rows.find((row) =>
    row.id.endsWith(":targetSystem")
  )?.after.replaceAll("::", " / ");
  const administration =
    proposal.authorization?.kind === "operator-administration"
      ? proposal.authorization
      : undefined;
  const caseId = messageCaseId(proposal);
  const title = beneficiary && administration
    ? `${
      administration.change.kind === "revoke"
        ? "Revoke rights from"
        : "Grant rights to"
    } ${beneficiary}`
    : rows.length === 1
    ? `Change ${rows[0].label}`
    : "Change the system";
  return (
    <ChatProposalCard
      id={proposal.id}
      title={title}
      status={canActivate ? "To activate" : sourceStatus[proposal.status]}
      open={Boolean(canActivate) ||
        ["preparing", "proposed", "accepting"].includes(proposal.status)}
      actions={proposal.status === "proposed"}
      rows={administration ? rows : undefined}
      disabled={!store.canDecide(proposal, agentId, "refuse")}
      acceptDisabled={!store.canDecide(proposal, agentId, "approve")}
      adjustDisabled={cannotAdjust(conversation, caseId)}
      notice={previewError || (preview?.stale && proposal.status === "proposed"
        ? "The system changed since this proposal. Ask for an adjustment."
        : !preview && proposal.proposalVersion
        ? "Loading changes…"
        : undefined)}
      reason={proposal.reason}
      details={preview?.sourceDiff
        ? <ProposalCodeDiff patch={preview.sourceDiff.patch} />
        : preview && preview.sourceChanges.length > 0 && (
          <details class="proposal-source" open={!preview.completeness}>
            <summary>
              {preview.completeness ? "Exact changes" : "All changes"}
            </summary>
            {preview.sourceChanges.map((change) => {
              const snippets = changedSource(change.before, change.after);
              return (
                <div class="proposal-source-file" key={change.path}>
                  <h4>{change.path}</h4>
                  <div class="proposal-source-pair">
                    <div>
                      <span>Before</span>
                      <pre>{snippets.before || "—"}</pre>
                    </div>
                    <div>
                      <span>After</span>
                      <pre>{snippets.after || "—"}</pre>
                    </div>
                  </div>
                </div>
              );
            })}
          </details>
        )}
      onDecide={(verdict, reason) =>
        store.decide(proposal, agentId, verdict, reason)}
      {...adjustmentProps(state, conversation, {
        id: proposal.id,
        title,
        caseId,
      })}
    >
      {canActivate && (
        <div class="proposal-actions">
          <button
            type="button"
            class="proposal-accept"
            disabled={!store.canAdopt(agentId)}
            onClick={() => void store.adopt(agentId)}
          >
            Activate for {conversation?.name || "this agent"}
          </button>
        </div>
      )}
    </ChatProposalCard>
  );
}

/** Catalog proposals require their owner; the primary-only legacy path is explicit. */
export function ToolProposalCard(
  props:
    & {
      conversation: AgentConversation | null;
      state: WorkbenchState;
      decisionState?: ProposalDecisionState;
      unavailable?: boolean;
    }
    & (
      | { owner: OperatorTool; candidate?: never; legacyPrimary?: never }
      | { candidate: Candidate; owner?: never; legacyPrimary: true }
    ),
) {
  const { owner, conversation, state } = props;
  const candidate = owner ? owner.candidate : props.candidate;
  const snapshot = state.displayed.value!;
  const human = (candidate.requiredAuthority ||
    (!owner
      ? snapshot.configuration?.builder.admissionAuthority
      : undefined)) === "human";
  // The shared decision gate first, then this tool's own conditions.
  const canDecide = state.decisionsOpen.value &&
    (owner ? state.operatorTools.canDecide(owner) : state.canAct.value);
  const pending = candidate.stage === "awaiting-admission";
  const hosts = conversation?.proposalContext?.before.network.allowedHosts;
  return (
    <ChatProposalCard
      id={`tool-${owner?.agentId || "primary"}-${candidate.id}`}
      decisionState={props.decisionState}
      title={candidate.name}
      status={pending && !human
        ? "Awaiting admission"
        : candidate.stage === "active"
        ? candidateState(candidate).label
        : toolStatus[candidate.stage]}
      open={[
        "proposed",
        "testing",
        "reviewing",
        "awaiting-admission",
        "activating",
      ].includes(candidate.stage)}
      rows={candidateDifferences(candidate)}
      reason={candidate.description}
      disabled={props.unavailable || !pending || !human || !canDecide}
      acceptLabel="Admit and integrate"
      adjustDisabled={props.unavailable ||
        cannotAdjust(conversation, candidate.caseId)}
      notice={candidate.error}
      details={
        <>
          <CandidateAuthorityFacts
            candidate={candidate}
            operatorId={conversation?.nativeId ?? owner?.agentId ??
              snapshot.executionModel?.identity.builderId ??
              snapshot.model?.builderId ?? ""}
            roster={state.conversationSnapshot.value?.conversations}
          />
          <p class="proposal-notice">
            This single admission records your agreement and starts automatic
            integration into the SysML model in a new Git revision, followed by
            activation.
          </p>
          <ProposalCodeDiff
            patch={newToolPatch(candidate.id, candidate.code)}
          />
          <details class="proposal-source">
            <summary>Checks and scope</summary>
            {hosts && <p>Allowed sites: {hosts.join(", ") || "none"}</p>}
            {candidate.tests?.checks.map((check, i) => (
              <p key={i}>
                {check.passed ? "✓" : "✕"} {check.name} — {check.detail}
              </p>
            ))}
          </details>
        </>
      }
      onDecide={(verdict, reason) =>
        owner ? state.decideOperatorTool(owner, verdict, reason) : state.decide(
          "candidate",
          candidate.id,
          verdict,
          snapshot.revision,
          candidate.digest,
        )}
      {...adjustmentProps(state, conversation, {
        id: candidate.id,
        title: candidate.name,
        caseId: candidate.caseId,
      })}
    />
  );
}

export type ChatEntry =
  | { kind: "message"; id: string; at: string; message: Message }
  | {
    kind: "evolution";
    id: string;
    at: string;
    record: EvolutionConversationRecord;
  }
  | { kind: "source"; id: string; at: string; proposal: SourceProposal }
  | {
    kind: "tool";
    id: string;
    at: string;
    candidate: Candidate;
    owner?: OperatorTool;
  }
  | { kind: "change"; id: string; at: string; change: PendingChange }
  | {
    kind: "model-update";
    id: string;
    at: string;
    update: EffectiveModelUpdate;
  };

/** One conversation in reading order: oldest first, the latest entry last. */
export function chatEntries(
  state: WorkbenchState,
  conversation: AgentConversation | null = state.selectedConversation.value,
): ChatEntry[] {
  const snapshot = state.displayed.value;
  const messages = conversation?.messages || snapshot?.messages || [];
  const entries: ChatEntry[] = messages.map((message) => ({
    kind: "message",
    id: `message:${message.id}`,
    at: message.at,
    message,
  }));
  if (state.readOnly.value) return entries;
  for (const update of conversation?.effectiveModelUpdates || []) {
    entries.push(modelUpdateEntry(update));
  }
  const nativeId = conversation?.nativeId ||
    snapshot?.executionModel?.identity.builderId;
  const sources = nativeId
    ? state.chatProposals.visible(nativeId)?.proposals || []
    : [];
  for (const proposal of sources) {
    if (
      proposal.authorization?.kind !== "operator-evolution" &&
      proposalOwner(proposal) === nativeId
    ) {
      entries.push({
        kind: "source",
        id: `source:${proposal.id}`,
        at: proposal.createdAt,
        proposal,
      });
    }
  }
  const evolutionSnapshot = state.conversationSnapshot.value?.evolutions;
  for (
    const value of evolutionSnapshot?.error
      ? []
      : evolutionSnapshot?.items ?? []
  ) {
    const record = readEvolutionRecord(value);
    if (
      !record || record.origin.operatorId !== nativeId ||
      messages.some((message) => {
        const captured = evolutionOf(message, nativeId);
        return captured &&
          captured.dossierId === record.dossierId &&
          captured.proposalId === record.proposalId &&
          captured.proposalDigest === record.proposalDigest;
      })
    ) continue;
    entries.push({
      kind: "evolution",
      id: `evolution:${record.dossierId}`,
      at: record.createdAt,
      record,
    });
  }
  const tools = state.visibleOperatorTools.value;
  if (conversation && tools) {
    for (const owner of tools.tools) {
      if (owner.agentId === conversation.agentId) {
        entries.push({
          kind: "tool",
          id: `tool:${owner.agentId}:${owner.candidate.id}`,
          at: owner.candidate.createdAt,
          candidate: owner.candidate,
          owner,
        });
      }
    }
  } else if (!conversation || conversation.primary && !tools) {
    for (const candidate of snapshot?.candidates || []) {
      entries.push({
        kind: "tool",
        id: `tool:primary:${candidate.id}`,
        at: candidate.createdAt,
        candidate,
      });
    }
  }
  for (const change of conversation?.proposalContext?.changes || []) {
    entries.push({
      kind: "change",
      id: `change:${conversation!.agentId}:${change.id}`,
      at: change.requestedAt,
      change,
    });
  }
  return entries.sort((a, b) =>
    (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)
  );
}
/**
 * Which conversation of the central agent a view shows: the designer's
 * perpetual conversation (no Case), one Case, or a new Case not opened yet.
 */
export type ConversationTarget = "designer" | "new-case" | { caseId: string };

/**
 * Where a card says it was asked: its Case, `null` for the designer's own
 * conversation, `undefined` when the host recorded nothing (a historical
 * record). A change, a tool and a source proposal record it the same way.
 */
function recordedScope(entry: ChatEntry): string | null | undefined {
  if (entry.kind === "evolution") {
    return entry.record.origin.requestId ??
      (entry.record.origin.designerScopeId ? null : undefined);
  }
  const record = entry.kind === "model-update"
    ? entry.update
    : entry.kind === "change"
    ? entry.change
    : entry.kind === "tool"
    ? entry.candidate
    : entry.kind === "source"
    ? entry.proposal
    : undefined;
  if (!record) return undefined;
  const caseId = messageCaseId(record);
  if (caseId) return caseId;
  const { designerScopeId } = record as { designerScopeId?: unknown };
  return typeof designerScopeId === "string" && designerScopeId
    ? null
    : undefined;
}

/**
 * One conversation's entries. Messages carry their Case (none for the
 * designer); a tool, a change or a source proposal belongs to the Case it
 * records (or to the designer when it records that scope), else to the
 * conversation of the message just before it (the agent answers one turn at a
 * time). A new Case is empty: its first message is the person's request.
 */
export function entriesFor(
  entries: readonly ChatEntry[],
  target: ConversationTarget,
): ChatEntry[] {
  if (target === "new-case") return [];
  const wanted = target === "designer" ? undefined : target.caseId;
  let latest: string | undefined;
  return entries.filter((entry) => {
    if (entry.kind === "message") {
      latest = entry.message.caseId || undefined;
      return latest === wanted;
    }
    const scope = recordedScope(entry);
    if (entry.kind === "model-update" && scope === undefined) return false;
    return (scope === undefined ? latest : scope ?? undefined) === wanted;
  });
}

/**
 * What the other agents said for one Case, folded: a Case's thread shows one
 * line per agent, "Agent · N messages", which opens in place.
 */
export interface ExchangeEntry {
  kind: "exchange";
  id: string;
  at: string;
  agent: AgentConversation;
  messages: Message[];
}
export type TimelineEntry = ChatEntry | ExchangeEntry;

/**
 * The exchanges of one Case: every agent but the one whose conversation is
 * shown, each placed where it started. Only messages the host recorded with
 * this `caseId` belong to it.
 */
export function caseExchanges(
  conversations: readonly AgentConversation[],
  caseId: string,
  shown: Pick<AgentConversation, "agentId"> | null,
): ExchangeEntry[] {
  return conversations.flatMap((agent) => {
    if (agent.agentId === shown?.agentId) return [];
    const messages = agent.messages.filter((message) =>
      messageCaseId(message) === caseId
    );
    return messages.length
      ? [{
        kind: "exchange" as const,
        id: `exchange:${agent.agentId}:${caseId}`,
        at: messages[0].at,
        agent,
        messages,
      }]
      : [];
  });
}

function modelUpdateEntry(update: EffectiveModelUpdate): ChatEntry {
  return {
    kind: "model-update",
    id: `model-update:${update.id}`,
    at: update.activatedAt,
    update,
  };
}

/** Only durable updates explicitly attributed to this Case, including teammates. */
export function caseModelUpdates(
  conversations: readonly AgentConversation[],
  caseId: string,
  shown: Pick<AgentConversation, "agentId"> | null,
): ChatEntry[] {
  return conversations.flatMap((agent) =>
    agent.agentId === shown?.agentId ? [] : (agent.effectiveModelUpdates || [])
      .filter((update) => update.caseId === caseId)
      .map(modelUpdateEntry)
  );
}

/** Entries and exchanges in reading order, the oldest first. */
export function withExchanges(
  entries: readonly ChatEntry[],
  exchanges: readonly ExchangeEntry[],
  updates: readonly ChatEntry[] = [],
): TimelineEntry[] {
  const unique = new Map<string, TimelineEntry>();
  for (const entry of [...entries, ...exchanges, ...updates]) {
    if (!unique.has(entry.id)) unique.set(entry.id, entry);
  }
  return [...unique.values()].sort((a, b) =>
    (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)
  );
}

export function pendingProposalCount(entries: ChatEntry[]) {
  return entries.filter((entry) =>
    entry.kind === "source"
      ? entry.proposal.status === "proposed"
      : entry.kind === "change"
      ? entry.change.status === "pending"
      : entry.kind === "tool" && entry.candidate.stage === "awaiting-admission"
  ).length;
}

/** Resolve message references even when the open collection omits their Cases. */
export function useMessageCaseDetails(
  state: WorkbenchState,
  entries: readonly TimelineEntry[],
  enabled = true,
) {
  const missing = JSON.stringify(
    [
      ...new Set(entries.flatMap((entry) => {
        if (entry.kind === "evolution") {
          if (state.readOnly.value) return [];
          return entry.record.origin.requestId &&
              !state.cases.byId(entry.record.origin.requestId)
            ? [entry.record.origin.requestId]
            : [];
        }
        if (entry.kind !== "message") return [];
        // An operator's report names its own Request besides the message's.
        const ids = [
          messageCaseId(entry.message),
          readOperatorNotice(entry.message)?.caseId,
          messageEvolution(entry.message)?.origin.requestId,
        ];
        return ids.filter((id): id is string =>
          id !== undefined && !state.cases.byId(id)
        );
      })),
    ],
  );
  useEffect(() => {
    if (!enabled) return;
    const ids: string[] = JSON.parse(missing);
    for (const id of ids) void state.cases.ensure(id);
  }, [state.cases, missing, enabled]);
}

/** "1 message", "N messages": how much another agent said for a Case. */
export function messageCount(count: number): string {
  return count === 1 ? "1 message" : `${count} messages`;
}

/** An immutable receipt can follow only its exact, confirmed current dossier. */
function RecordedEvolutionCard({ captured, state, conversation, scope }: {
  captured: EvolutionConversationRecord;
  state: WorkbenchState;
  conversation?: AgentConversation | null;
  scope: { caseId?: string; designerScopeId?: string };
}) {
  const projection = state.conversationSnapshot.value?.evolutions;
  const historical = state.readOnly.value;
  const current = !historical && !projection?.error
    ? currentEvolutionRecord(captured, projection?.items ?? [])
    : undefined;
  return (
    <EvolutionProposalCard
      record={current ?? captured}
      state={state}
      conversation={conversation}
      scope={scope}
      historical={historical || !current}
      currentUnavailable={!historical && !current
        ? projection?.error ??
          "Current evolution dossier details are unavailable. This is the recorded receipt."
        : undefined}
    />
  );
}

/** Latest assignment per recipient in this thread; journal records stay intact. */
function latestNoticeMessages(
  messages: readonly Message[],
  operatorId?: string,
): readonly Message[] {
  const latest = new Map<string, { index: number; at: number }>();
  const keys = messages.map((message, index) => {
    const evolution = evolutionOf(message, operatorId);
    const notice = readOperatorNotice(message);
    const key = evolution
      ? JSON.stringify([
        "evolution",
        evolution.dossierId,
        evolution.proposalId,
        evolution.proposalDigest,
      ])
      : notice?.kind === "authority-escalation" &&
          typeof notice.recipient === "string" && notice.recipient
      ? JSON.stringify([
        "authority",
        notice.changeId,
        notice.caseId,
        notice.recipient,
      ])
      : undefined;
    if (!key) return undefined;
    const at = Date.parse(message.at) || 0;
    const previous = latest.get(key);
    if (!previous || at >= previous.at) latest.set(key, { index, at });
    return key;
  });
  return messages.filter((_, index) =>
    keys[index] === undefined || latest.get(keys[index]!)?.index === index
  );
}

/** The evolution receipt a message records for this thread's own operator. */
function evolutionOf(message: Message, operatorId: string | undefined) {
  const captured = messageEvolution(message);
  return captured && evolutionOriginMatches(captured, operatorId, message)
    ? captured
    : undefined;
}

/**
 * How a thread shows one message: an evolution receipt, an operator's notice,
 * a host or tool record folded with its neighbours, or a message. A thread
 * that does not read receipts and notices (a Request's own) folds them too.
 */
type Shown =
  | { kind: "captured"; record: EvolutionConversationRecord }
  | { kind: "notice"; notice: OperatorNotice }
  | { kind: "step" }
  | { kind: "message" };

function shownAs(
  message: Message,
  operatorId: string | undefined,
  readsReceipts: boolean,
): Shown {
  const record = readsReceipts ? evolutionOf(message, operatorId) : undefined;
  if (record) return { kind: "captured", record };
  const notice = readsReceipts ? readOperatorNotice(message) : undefined;
  if (notice) return { kind: "notice", notice };
  return message.role === "tool" && !message.work
    ? { kind: "step" }
    : { kind: "message" };
}

/**
 * A thread's items in order, with the steps in a row grouped where the first
 * one is. A fold ends at anything else, and where the Case changes.
 */
function foldSteps<T>(
  items: readonly T[],
  stepOf: (item: T) => Message | undefined,
): { item: T; index: number; steps?: Message[] }[] {
  const units: { item: T; index: number; steps?: Message[] }[] = [];
  let fold: Message[] | undefined;
  items.forEach((item, index) => {
    const step = stepOf(item);
    if (step && fold && messageCaseId(fold[0]) === messageCaseId(step)) {
      fold.push(step);
      return;
    }
    fold = step ? [step] : undefined;
    units.push(fold ? { item, index, steps: fold } : { item, index });
  });
  return units;
}

/**
 * What another agent said for a Case, in the order given; its messages, its
 * requests included, are agents' words. An operator's report is one line
 * leading to its Request, as in the thread; host and tool records in a row
 * fold into one line.
 */
export function ExchangeMessages(
  { messages, state, conversation }: {
    messages: readonly Message[];
    state?: WorkbenchState;
    conversation?: AgentConversation;
  },
) {
  const listed = state
    ? latestNoticeMessages(messages, conversation?.nativeId)
    : messages;
  const shown = new Map(
    listed.map((message) => [
      message,
      shownAs(message, conversation?.nativeId, Boolean(state)),
    ]),
  );
  return (
    <>
      {foldSteps(
        listed,
        (message) => shown.get(message)!.kind === "step" ? message : undefined,
      ).map(({ item: message, steps }) => {
        const as = shown.get(message)!;
        if (as.kind === "captured" && state) {
          return (
            <RecordedEvolutionCard
              key={message.id}
              captured={as.record}
              state={state}
              conversation={conversation}
              scope={message}
            />
          );
        }
        if (as.kind === "notice" && state) {
          return (
            <OperatorNoticeRow
              key={message.id}
              notice={as.notice}
              state={state}
            />
          );
        }
        if (steps) return <ToolSteps key={message.id} messages={steps} />;
        return (
          <article
            key={message.id}
            class={`message ${message.work ? "tool" : message.role}`}
          >
            <div class="message-body">
              <MessageText text={message.text} />
            </div>
          </article>
        );
      })}
    </>
  );
}

/** An exchange with another agent, folded on one line and opened in place. */
function ExchangeRow(
  { entry, state }: { entry: ExchangeEntry; state: WorkbenchState },
) {
  return (
    <details class="exchange" data-key={entry.id}>
      <summary class="change-row">
        <span class="cmark" aria-hidden="true" />
        <span class="ctitle">
          {`${entry.agent.name} · ${messageCount(entry.messages.length)}`}
        </span>
      </summary>
      <div class="exchange-messages">
        <ExchangeMessages
          messages={entry.messages}
          state={state}
          conversation={entry.agent}
        />
        <a class="exchange-open" href={conversationHref(entry.agent.agentId)}>
          Open conversation
        </a>
      </div>
    </details>
  );
}

export function ChatTimeline(
  {
    state,
    entries: recordedEntries,
    conversation = state.selectedConversation.value,
    caseLinks = true,
    independentRequest = false,
    caseId: requestCaseId,
  }: {
    caseId?: string;
    state: WorkbenchState;
    entries: readonly TimelineEntry[];
    conversation?: AgentConversation | null;
    /** A Case's own page needs no link to itself on its first message. */
    caseLinks?: boolean;
    independentRequest?: boolean;
  },
) {
  const operatorId = conversation?.nativeId ||
    state.displayed.value?.executionModel?.identity.builderId;
  // Resolve replacements first: a new operator assignment supersedes the old
  // human request even though Main does not show the new notice itself.
  const latest = new Set(latestNoticeMessages(
    recordedEntries.flatMap((entry) =>
      entry.kind === "message" ? [entry.message] : []
    ),
    operatorId,
  ));
  // Filter before folding steps and finding Case boundaries. The journal and
  // the Main's model context retain every record.
  const entries = recordedEntries.filter((entry) => {
    if (entry.kind !== "message") return true;
    if (!latest.has(entry.message)) return false;
    if (independentRequest || !conversation?.primary) return true;
    if (entry.message.work) return false;
    const notice = readOperatorNotice(entry.message);
    return !notice ||
      notice.kind === "authority-escalation" &&
        notice.decisionAuthority !== "operator" ||
      notice.kind === "request-completed" &&
        notice.status === "closed-abandoned";
  });
  useMessageCaseDetails(state, entries, !independentRequest);
  const visible = entries.flatMap((entry) =>
    entry.kind === "message" ? [entry.message] : []
  );
  const shown = new Map(
    visible.map((message) => [
      message,
      shownAs(message, operatorId, !independentRequest),
    ]),
  );
  const units = foldSteps(
    entries,
    (entry) =>
      entry.kind === "message" && shown.get(entry.message)?.kind === "step"
        ? entry.message
        : undefined,
  );
  // A teammate's update is named from the roster of the thread's own space.
  const roster = !independentRequest
    ? state.conversationSnapshot.value?.conversations
    : requestCaseId
    ? state.requests.snapshots.value.get(requestCaseId)?.conversations
    : undefined;
  return (
    <>
      {independentRequest && requestCaseId && conversation &&
        state.caseChangeNotice(requestCaseId, conversation.agentId) && (
        <p role="status">
          {state.caseChangeNotice(requestCaseId, conversation.agentId)}
        </p>
      )}
      {units.map(({ item: entry, index, steps }) => {
        if (entry.kind === "evolution") {
          if (state.readOnly.value) return null;
          return (
            <EvolutionProposalCard
              key={entry.id}
              record={entry.record}
              state={state}
              conversation={conversation}
              scope={{
                caseId: entry.record.origin.requestId,
                designerScopeId: entry.record.origin.designerScopeId,
              }}
              historical={state.readOnly.value}
            />
          );
        }
        if (entry.kind === "model-update") {
          const affectedOperator = entry.update.operatorId !== operatorId
            ? operatorName(roster, entry.update.operatorId) ||
              entry.update.operatorId
            : undefined;
          return (
            <ModelUpdateDivider
              key={entry.id}
              update={entry.update}
              affectedOperator={affectedOperator}
              requestScoped={independentRequest}
            />
          );
        }
        if (entry.kind === "exchange") {
          return <ExchangeRow key={entry.id} entry={entry} state={state} />;
        }
        if (entry.kind === "source") {
          if (
            entry.proposal.authorization?.kind === "operator-evolution"
          ) return null;
          return (
            <SourceProposalCard
              key={entry.id}
              proposal={entry.proposal}
              agentId={operatorId!}
              conversation={conversation}
              state={state}
            />
          );
        }
        if (entry.kind === "tool") {
          return entry.owner
            ? (
              <ToolProposalCard
                key={entry.id}
                owner={entry.owner}
                conversation={conversation}
                state={state}
              />
            )
            : (
              <ToolProposalCard
                key={entry.id}
                candidate={entry.candidate}
                legacyPrimary
                conversation={conversation}
                state={state}
              />
            );
        }
        if (entry.kind === "change") {
          return (
            <ChangeProposalCard
              key={entry.id}
              change={entry.change}
              caseId={requestCaseId}
              independentRequest={independentRequest}
              conversation={conversation!}
              state={state}
            />
          );
        }
        const message = entry.message;
        const as = shown.get(message);
        if (!as) return null;
        if (as.kind === "captured") {
          return (
            <RecordedEvolutionCard
              key={entry.id}
              captured={as.record}
              state={state}
              conversation={conversation}
              scope={message}
            />
          );
        }
        if (as.kind === "notice") {
          return (
            <OperatorNoticeRow
              key={entry.id}
              notice={as.notice}
              state={state}
            />
          );
        }
        // A message the host attached to a Case points to it, discreetly:
        // once where the conversation enters that Case, not on every message.
        const caseId = messageCaseId(message);
        const previous = entries.slice(0, index).reverse().find((before) =>
          before.kind === "message"
        );
        const showCase = caseLinks && caseId &&
          (previous?.kind !== "message" ||
            messageCaseId(previous.message) !== caseId);
        const record = caseId ? state.cases.byId(caseId) : null;
        const chip = showCase && (
          <a class="case-chip" href={caseHref(caseId, record?.type)}>
            {record ? caseTitle(record, 28) : "Case"}
          </a>
        );
        if (steps) {
          return (
            <Fragment key={entry.id}>
              {chip}
              <ToolSteps messages={steps} />
            </Fragment>
          );
        }
        const work = message.work &&
          (message.work.callerId === operatorId ? "returned" : "received");
        return (
          <article
            key={entry.id}
            class={`message ${work ? "tool" : message.role}`}
          >
            {chip}
            <div class="message-label">
              {work
                ? `Work ${work}`
                : message.role === "user"
                ? "You"
                : caseOperatorName(
                  conversation?.name || "System",
                  state.requests.cases.byId(requestCaseId),
                )}
            </div>
            {work
              ? (
                <details data-key={`message:${message.id}`}>
                  <summary>{`View ${work} work`}</summary>
                  <div class="message-body">
                    <MessageText text={message.text} />
                  </div>
                </details>
              )
              : (
                <div class="message-body">
                  {/* What the person wrote stays exactly as written. */}
                  {message.role === "user"
                    ? message.text
                    : <MessageText text={message.text} />}
                </div>
              )}
          </article>
        );
      })}
    </>
  );
}
