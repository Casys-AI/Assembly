import type { ComponentChildren } from "preact";
import { isCaseChangeDecision } from "../../lib/conversations/case-change.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";
import type { AgentConversation } from "../../../src/application/work/operators/conversation-types.ts";
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
import { hasDiff, operatorName } from "../../lib/model/revisions/change.ts";
import {
  decidedBy,
  decidedByLabel,
} from "../../lib/conversations/operator-authority.ts";
import { ChangeInspector, DecisionChip } from "./DecisionParts.tsx";
import { useChangeDecision } from "./useChangeDecision.ts";
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
 * Before / After rows. Both say where the decision stands in the same words,
 * and who decided it.
 */
export function ChangeProposalCard(
  {
    change,
    conversation,
    state,
    caseId,
    independentRequest,
    route,
  }: {
    caseId?: string;
    independentRequest?: boolean;
    /** The recorded route of a relayed request, listed in the inspector. */
    route?: ComponentChildren;
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
  const { decision, observed, error } = useChangeDecision(
    state,
    change,
    independentRequest && supported && caseId
      ? { caseId, agentId: conversation.agentId }
      : undefined,
  );
  const notice = !supported
    ? "This Case change is not available for decision here."
    : common.notice ??
      (error ||
        (decision.inconsistent
          ? "Decision status is inconsistent"
          : undefined));
  const author = decidedBy(
    change,
    state.conversationSnapshot.value?.conversations ?? [],
  );
  const decider = author && decidedByLabel(author);
  // Who decided, and why the record is not read yet when the session is off.
  const stateNote = [
    decider,
    decision.checking && !state.requests.sessionReady.value
      ? "Connect the local session to read where it stands."
      : undefined,
  ].filter(Boolean).join(" · ") || undefined;
  const authority = (
    <>
      <ObservedOperatorAuthority change={change} state={state} />
      {route}
    </>
  );
  if (hasDiff(change)) {
    return (
      <ModelChangeCard
        {...common}
        change={change}
        decision={decision}
        actionsEnabled={supported}
        notice={notice}
        retry={caseId && observed?.canResume && decision.unfinished
          ? {
            label: change.status === "refused"
              ? "Retry continuation"
              : "Retry applying",
            reason: state.caseChangeResumeReason(
              caseId,
              conversation.agentId,
              change.id,
            ),
            onRetry: () => {
              void state.resumeCaseChange(
                caseId,
                conversation.agentId,
                change.id,
              );
            },
          }
          : undefined}
        authority={authority}
        decidedBy={decider}
        stateNote={stateNote}
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
      actions={supported}
      notice={notice}
      title={changeTitle(change)}
      status={<DecisionChip decision={decision} note={stateNote} />}
      open={pending}
      rows={changeDifferences(change, conversation.proposalContext!)}
      reason={change.reason}
      details={
        <>
          {change.operator && isTeamOperatorSpec(change.operator) &&
            <p>{changeScope(change).join(" · ")}</p>}
          <ChangeInspector change={change} summary={decider ?? "Details"}>
            {authority}
          </ChangeInspector>
        </>
      }
    />
  );
}
