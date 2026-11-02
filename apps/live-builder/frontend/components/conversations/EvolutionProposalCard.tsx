import { useEffect, useMemo, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import type { AgentConversation } from "../../../src/domain/work/records/conversations.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";
import {
  type EvolutionConversationRecord,
  type EvolutionRequest,
  evolutionRequests,
  evolutionRequestText,
  evolutionStatus,
  evolutionThreadMatches,
  exactEvolutionDiff,
} from "../../lib/conversations/evolution.ts";
import {
  createRevisionApi,
  type SourceDiff,
} from "../../lib/model/revisions/api.ts";
import { ProposalCodeDiff } from "../model/changes/ProposalCodeDiff.tsx";

const revisions = createRevisionApi();
const name = (actor: { operatorId: string; name: string | null }) =>
  actor.name?.trim() || actor.operatorId;
export const createEvolutionRequestState = () => ({
  busy: signal(false),
  result: signal(""),
  error: signal(""),
});

/** A durable evolution is observed here; buttons request an operator's next act. */
export function EvolutionProposalCard(
  {
    record,
    state,
    conversation,
    scope,
    historical = false,
    readDiff = revisions.diff,
    requestState,
    currentUnavailable,
  }: {
    record: EvolutionConversationRecord;
    state: WorkbenchState;
    conversation?: AgentConversation | null;
    scope: { caseId?: string; designerScopeId?: string };
    historical?: boolean;
    requestState?: ReturnType<typeof createEvolutionRequestState>;
    currentUnavailable?: string;
    /** On-demand immutable sources, including history; endpoint access is still
     * checked by the host. This never reads HEAD or a current dossier. */
    readDiff?: (
      from: string,
      to: string,
      signal?: AbortSignal,
    ) => Promise<SourceDiff>;
  },
) {
  const frozen = historical || state.readOnly.value ||
    Boolean(currentUnavailable);
  const [expanded, setExpanded] = useState(false);
  const [loadedComparison, setComparison] = useState<
    { key: string; diff: SourceDiff } | null
  >(null);
  const [diffError, setDiffError] = useState("");
  const requestFlow = useMemo(
    () => requestState ?? createEvolutionRequestState(),
    [requestState],
  );
  const busy = requestFlow.busy.value,
    requestResult = requestFlow.result.value,
    requestError = requestFlow.error.value;
  const diffKey = JSON.stringify([record.base, record.candidate]);
  const comparison = loadedComparison?.key === diffKey
    ? loadedComparison.diff
    : null;
  useEffect(() => {
    requestFlow.result.value = "";
    requestFlow.error.value = "";
  }, [record.dossierId, record.revision]);
  useEffect(() => {
    setComparison(null);
    setDiffError("");
    if (!expanded) return;
    const controller = new AbortController();
    void readDiff(
      record.base.version,
      record.candidate.version,
      controller.signal,
    ).then((value) => {
      if (controller.signal.aborted) return;
      if (!exactEvolutionDiff(record, value)) {
        throw new Error(
          "The comparison does not match this evolution's exact source revisions.",
        );
      }
      setComparison({ key: diffKey, diff: value });
    }).catch((cause) => {
      if (!controller.signal.aborted) {
        setDiffError(
          cause instanceof Error ? cause.message : "Comparison unavailable.",
        );
      }
    });
    return () => controller.abort();
  }, [expanded, diffKey, readDiff]);
  const originCase = record.origin.requestId
    ? state.cases.byId(record.origin.requestId)
    : undefined;
  const openCase = !record.origin.requestId ||
    originCase && ["open", "waiting"].includes(originCase.status);
  const currentDesigner = !record.origin.designerScopeId ||
    conversation?.designerScopeId === record.origin.designerScopeId;
  const threadMatches = evolutionThreadMatches(record, conversation, scope);
  const canRequest = !frozen && threadMatches && openCase && currentDesigner &&
    Boolean(
      conversation &&
        state.agentConversations.canSendTo(
          conversation.agentId,
          record.origin.requestId,
        ),
    );
  const actions = evolutionRequests(record);
  const unavailable = frozen
    ? ""
    : !threadMatches
    ? `Requests belong in the originating conversation with ${
      name(record.preparer)
    }.`
    : !openCase
    ? "The originating Request is closed or unavailable. A request cannot be sent from this card."
    : !currentDesigner
    ? "The originating Main Operator conversation is no longer current or cannot be verified. A request cannot be sent from this card."
    : !canRequest
    ? "This conversation cannot receive a human message now."
    : "";
  async function request(action: EvolutionRequest) {
    if (!canRequest || requestFlow.busy.peek() || !conversation) return;
    requestFlow.busy.value = true;
    requestFlow.result.value = "";
    requestFlow.error.value = "";
    try {
      const sent = await state.agentConversations.sendTo(
        conversation.agentId,
        evolutionRequestText(record, action),
        false,
        record.origin.requestId,
      );
      if (sent) requestFlow.result.value = "Request sent";
      else {requestFlow.error.value =
          "The request was not confirmed. The dossier status is unchanged.";}
    } catch (cause) {
      requestFlow.error.value = cause instanceof Error
        ? cause.message
        : "The request was not confirmed.";
    } finally {
      requestFlow.busy.value = false;
    }
  }
  const label = `${frozen ? "Recorded " : ""}${evolutionStatus[record.status]}${
    frozen ? ` at ${record.updatedAt}` : ""
  }`;
  const title = `Evolve ${record.targets.map(name).join(", ")}`;
  return (
    <article
      class={`chat-proposal evolution-proposal ${
        actions.length && !frozen ? "is-pending" : "is-settled"
      }`}
      data-evolution-id={record.dossierId}
      aria-label={title}
    >
      <header class="proposal-heading">
        <h3>{title}</h3>
        <span class="proposal-status">{label}</span>
      </header>
      <p class="proposal-notice">
        {record.categories.map((category) =>
          category === "flow"
            ? "Action flow"
            : category[0]!.toUpperCase() + category.slice(1)
        ).join(" · ")} · Revision {record.revision}
      </p>
      {record.reason && <p class="proposal-notice">{record.reason}</p>}
      {currentUnavailable && (
        <p class="proposal-notice" role="status">{currentUnavailable}</p>
      )}
      {record.blockers.length > 0 && (
        <ul class="evolution-blockers" aria-label="Activation blockers">
          {record.blockers.map((blocker, index) => (
            <li key={`${blocker.code}:${index}`}>
              {blocker.operatorId && (
                <b>
                  {record.targets.find((target) =>
                    target.operatorId === blocker.operatorId
                  )?.name || blocker.operatorId}: {" "}
                </b>
              )}
              {blocker.detail} <small>({blocker.code})</small>
            </li>
          ))}
        </ul>
      )}
      <details
        class="proposal-source"
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>Exact before / after sources</summary>
        <p class="proposal-notice">
          Before {record.base.version}
          <br />After {record.candidate.version}
        </p>
        {expanded && !comparison && !diffError && (
          <p class="proposal-notice" role="status">Loading exact comparison…</p>
        )}
        {diffError && <p class="proposal-error" role="alert">{diffError}</p>}
        {comparison && (
          <ProposalCodeDiff patch={comparison.patch} mode="side-by-side" />
        )}
      </details>
      <details class="proposal-source">
        <summary>Revision and responsibility</summary>
        <p class="proposal-notice">
          Prepared by {name(record.preparer)} · Finalizer{" "}
          {name(record.finalizer)}
          <br />Dossier {record.dossierId} · Proposal {record.proposalId}
          <br />Proposal digest {record.proposalDigest}
          <br />
          {record.publication
            ? `Published ${record.publication.version}`
            : "Not published"}
          <br />Adopted by {record.adoptions.length
            ? record.adoptions.map((receipt) =>
              record.targets.find((target) =>
                target.operatorId === receipt.operatorId
              )?.name || receipt.operatorId
            ).join(", ")
            : "none"}
        </p>
      </details>
      {actions.length > 0 && !frozen && (
        <>
          {canRequest
            ? (
              <div class="proposal-actions">
                {actions.map((action) => (
                  <button
                    type="button"
                    key={action}
                    disabled={busy}
                    onClick={() => void request(action)}
                  >
                    Request {action}
                  </button>
                ))}
              </div>
            )
            : <p class="proposal-notice">{unavailable}</p>}
        </>
      )}
      {requestResult && (
        <p class="proposal-notice" role="status">{requestResult}</p>
      )}
      {requestError && <p class="proposal-error" role="alert">{requestError}
      </p>}
    </article>
  );
}
