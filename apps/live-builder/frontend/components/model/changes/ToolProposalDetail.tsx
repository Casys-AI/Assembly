import { useMemo } from "preact/hooks";
import { createProposalDecisionState } from "../../conversations/ChatProposalCard.tsx";
import { conversationHref, modelHref } from "../../../lib/workbench/desk.ts";
import type { WorkbenchState } from "../../../lib/workbench/state.ts";
import {
  readToolProposal,
  toolProposalSelection,
} from "../../../lib/model/tool-proposal-location.ts";
import { ToolProposalCard } from "../../conversations/ChatTimeline.tsx";
import { ArtifactSourceInspector } from "../../system/ArtifactSourceInspector.tsx";

/** Stable exact-owner UI state, independent of a notification's group or read freshness. */
export function createToolProposalSession() {
  return {
    workflow: createProposalDecisionState(),
    observed: null as null | {
      identity: string;
      read: Extract<ReturnType<typeof readToolProposal>, { status: "ready" }>;
    },
  };
}
export type ToolProposalSession = ReturnType<typeof createToolProposalSession>;

/** A current tool proposal reuses its exact runtime object, code diff and decision gate. */
export function ToolProposalDetail(
  { state, selection, backToRevisions = false, session }: {
    state: WorkbenchState;
    session?: ToolProposalSession;
    backToRevisions?: boolean;
    selection: Exclude<
      ReturnType<typeof toolProposalSelection>,
      { kind: "none" }
    >;
  },
) {
  const identity = selection.kind === "selected"
    ? JSON.stringify(selection.target)
    : selection.message;
  const held = useMemo(() => session ?? createToolProposalSession(), [
    identity,
    session,
  ]);
  const workflow = held.workflow;
  const read = selection.kind === "selected"
    ? readToolProposal(selection.target, {
      catalogue: state.visibleOperatorTools.value,
      conversations: state.conversationSnapshot.value?.conversations,
      loading: state.operatorTools.loading.value,
      stale: state.operatorTools.stale.value,
      historical: state.readOnly.value ||
        Boolean(state.graphSourceSelection.value),
    })
    : {
      status: "unavailable" as const,
      code: "tool-proposal-address-invalid",
      message: selection.message,
    };
  if (read.status === "ready") held.observed = { identity, read };
  const refreshing = read.status === "unavailable" &&
    ["tool-proposal-loading", "tool-proposal-catalogue-stale"].includes(
      read.code,
    );
  const retained =
    refreshing && (workflow.adjusting.value || workflow.pending.value) &&
      held.observed?.identity === identity
      ? held.observed.read
      : undefined;
  const shown = read.status === "ready" ? read : retained;
  return (
    <div class="rev-detail" data-tool-proposal>
      {backToRevisions && (
        <a href={modelHref("revisions")}>
          Back to revisions
        </a>
      )}
      {read.status === "unavailable" && (
        <p class="rev-empty" role="status" data-code={read.code}>
          {read.message}
        </p>
      )}
      {shown && (
        <>
          <p>
            {refreshing ? "Last observed tool proposal" : "Tool proposal"} ·
            {" "}
            {shown.conversation.name}
            {" · "}
            <a href={conversationHref(shown.conversation.agentId)}>
              Open conversation
            </a>
          </p>
          <ToolProposalCard
            key={identity}
            owner={shown.tool}
            conversation={shown.conversation}
            state={state}
            decisionState={workflow}
            unavailable={refreshing}
          />
          <ArtifactSourceInspector
            agentId={shown.conversation.agentId}
            label={shown.tool.candidate.name}
            binding={shown.tool.candidate.sourceBinding}
            disabled={refreshing}
          />
        </>
      )}
      {state.operatorTools.error.value && !state.readOnly.value && (
        <p class="proposal-notice" role="status">
          {state.operatorTools.error.value}
        </p>
      )}
    </div>
  );
}
