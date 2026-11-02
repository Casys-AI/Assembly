import { useEffect } from "preact/hooks";
import { isCaseChangeDecision } from "../../lib/conversations/case-change.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";
import type { AgentConversation } from "../../../src/domain/work/records/conversations.ts";
import type { PendingChange } from "../../../src/domain/governance/records/pending-change.ts";
import {
  changeDifferences,
  changeScope,
  changeTitle,
} from "../../lib/conversations/proposal-differences.ts";
import { ChatProposalCard } from "./ChatProposalCard.tsx";
import { ModelChangeCard } from "../model/changes/ModelChangeCard.tsx";
import { ObservedOperatorAuthority } from "./OperatorAuthorityFacts.tsx";
import { caseOperatorName } from "../../lib/cases/operator-names.ts";
import {
  changeOutcome,
  hasDiff,
  operatorName,
  outcomeLabel,
} from "../../lib/model/revisions/change.ts";
import { isTeamOperatorSpec } from "../../../src/domain/governance/operator-authority.ts";
import { takesHumanMessage } from "../../lib/conversations/state.ts";

/** One change card for two hosts: the thread of the Case where the change
 * was asked, and the Main Operator's thread where a Branch Operator's
 * request is relayed. Both decide through the same command. */

/**
 * Whether an adjustment can be sent now: to the agent that holds the proposal,
 * and into the Case it was made in when it records one.
 */
export function cannotAdjust(
  conversation: AgentConversation | null,
  caseId: string | undefined,
): boolean {
  return !conversation || conversation.busy ||
    !takesHumanMessage(conversation, caseId);
}

/** The request goes back to the Case of the proposal, never to another thread. */
export function sendAdjustment(
  state: WorkbenchState,
  conversation: AgentConversation | null,
  message: string,
  caseId: string | undefined,
): Promise<boolean> {
  return conversation
    ? state.agentConversations.sendTo(
      conversation.agentId,
      message,
      false,
      caseId,
    )
    : Promise.resolve(false);
}

/**
 * How a card asks for an adjustment: the one message it measures against the
 * bound, and the send of that very message to the Case of the proposal.
 */
export function adjustmentProps(
  state: WorkbenchState,
  conversation: AgentConversation | null,
  proposal: { id: string; title: string; caseId: string | undefined },
) {
  return {
    adjustmentMessage: (text: string) =>
      `Adjust the proposal “${proposal.title}” (${proposal.id}):\n${text}`,
    onAdjustment: (message: string) =>
      sendAdjustment(state, conversation, message, proposal.caseId),
  };
}

/**
 * What a card needs to decide one change held by `conversation`, and to send an
 * adjustment back to the Case the change was asked in (none for the designer).
 */
export function changeCardProps(
  state: WorkbenchState,
  conversation: AgentConversation,
  change: PendingChange,
  caseId?: string,
  independentRequest = false,
) {
  const context = conversation.proposalContext!;
  const pending = change.status === "pending";
  const key = JSON.stringify([caseId ?? null, conversation.agentId, change.id]);
  return {
    id: `change-${conversation.agentId}-${change.id}`,
    disabled: !state.decisionsOpen.value ||
      (independentRequest && !caseId) || conversation.busy ||
      state.pendingChanges.value.includes(key),
    acceptDisabled: change.baseRevision !== context.configurationRevision,
    adjustDisabled: independentRequest ||
      cannotAdjust(conversation, change.caseId),
    notice: pending && change.baseRevision !== context.configurationRevision
      ? "The mandate changed. Ask for a new proposal."
      : undefined,
    onDecide: (verdict: "approve" | "refuse") =>
      independentRequest &&
        !isCaseChangeDecision(change, caseId, conversation.agentId)
        ? Promise.resolve(false)
        : state.decideOperatorChange(conversation, change.id, verdict, caseId),
    ...adjustmentProps(state, conversation, {
      id: change.id,
      title: changeTitle(change),
      caseId: change.caseId,
    }),
  };
}

/**
 * A change to the mandate or to the model. One that carries the diff of the
 * sources the host prepared reads like a pull request; one without keeps the
 * Before / After rows.
 */
export function ChangeProposalCard(
  { change, conversation, state, caseId, independentRequest, decidedByMain }: {
    caseId?: string;
    independentRequest?: boolean;
    /** Relayed to the Main Operator, which decides it under its mandate: the
     * card shows the status, never the person's decision. */
    decidedByMain?: boolean;
    change: PendingChange;
    conversation: AgentConversation;
    state: WorkbenchState;
  },
) {
  const common = changeCardProps(
    state,
    conversation,
    change,
    caseId,
    independentRequest,
  );
  const supported = !independentRequest ||
    isCaseChangeDecision(change, caseId, conversation.agentId);
  const decidable = supported && !decidedByMain;
  const notice = !supported
    ? "This Case change is not available for decision here."
    : decidedByMain && change.status === "pending"
    ? "The Main Operator decides this request under its mandate."
    : common.notice;
  const shouldRead = independentRequest && supported && !!caseId &&
    (change.status === "approved" || change.status === "refused");
  const sessionGeneration = state.requests.sessionGeneration.value;
  const sessionReady = state.requests.sessionReady.value;
  const host = JSON.stringify(state.requests.context.value);
  const systemId = state.current.value?.id;
  useEffect(() => {
    if (shouldRead && caseId && sessionReady) {
      void state.loadCaseChangeStatus(caseId, conversation.agentId, change.id);
    }
  }, [
    state,
    caseId,
    conversation.agentId,
    change.id,
    shouldRead,
    sessionGeneration,
    sessionReady,
    host,
    systemId,
  ]);
  const observedStatus = shouldRead && caseId
    ? state.caseChangeStatus(caseId, conversation.agentId, change.id)
    : undefined;
  const consistent = observedStatus &&
    (change.status === "refused"
      ? ["refused-awaiting-continuation", "refused"].includes(
        observedStatus.status,
      )
      : [
        "decision-recorded",
        "publication-pending",
        "published-awaiting-adoption",
        "adopted",
        "blocked",
      ].includes(observedStatus.status));
  const status = consistent ? observedStatus : undefined;
  const error = shouldRead && caseId
    ? state.caseChangeError(caseId, conversation.agentId, change.id)
    : "";
  const label = status
    ? ({
      "pending": "Awaiting decision",
      "decision-recorded": "Decision recorded",
      "publication-pending": "Publication pending",
      "published-awaiting-adoption": "Published; adoption pending",
      "adopted": "Adopted",
      "refused-awaiting-continuation": "Refused; continuation pending",
      "refused": "Refused; continuation accepted",
      "blocked": "Applying blocked",
    } as const)[status.status]
    : error ||
      (observedStatus && !consistent
        ? "Decision status is inconsistent"
        : shouldRead
        ? "Checking application status"
        : undefined);
  if (hasDiff(change)) {
    return (
      <ModelChangeCard
        {...common}
        change={change}
        actionsEnabled={decidable}
        notice={notice}
        retryStatus={label}
        onRetryApplying={caseId && status?.canResume && (
            change.status === "refused"
              ? status.status === "refused-awaiting-continuation"
              : change.status === "approved" &&
                [
                  "decision-recorded",
                  "publication-pending",
                  "published-awaiting-adoption",
                  "blocked",
                ].includes(status.status)
          )
          ? () => {
            void state.resumeCaseChange(
              caseId,
              conversation.agentId,
              change.id,
            );
          }
          : undefined}
        retryLabel={change.status === "refused"
          ? "Retry continuation"
          : "Retry applying"}
        retryDisabled={!state.decisionsOpen.value ||
          state.pendingChanges.value.includes(
            JSON.stringify([caseId, conversation.agentId, change.id]),
          )}
        authority={<ObservedOperatorAuthority change={change} state={state} />}
        proposedBy={independentRequest &&
            change.requestedBy === conversation.nativeId
          ? caseOperatorName(
            conversation.name,
            state.requests.cases.byId(caseId),
          )
          : operatorName(
            state.conversationSnapshot.value?.conversations,
            change.requestedBy,
          )}
      />
    );
  }
  const pending = change.status === "pending";
  return (
    <ChatProposalCard
      {...common}
      actions={decidable}
      notice={notice}
      title={changeTitle(change)}
      status={pending ? "To decide" : outcomeLabel[changeOutcome(change)]}
      open={pending}
      rows={changeDifferences(change, conversation.proposalContext!)}
      reason={change.reason}
      details={
        <>
          {change.operator && isTeamOperatorSpec(change.operator) &&
            <p>{changeScope(change).join(" · ")}</p>}
          <ObservedOperatorAuthority change={change} state={state} />
        </>
      }
    />
  );
}
