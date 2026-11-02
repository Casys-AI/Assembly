import { useEffect } from "preact/hooks";
import { MAIN_EXECUTION_SPACE_ID } from "../../../src/domain/governance/operator-authority.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";
import { caseHref, caseStatusLabel, caseTitle } from "../../lib/cases/cases.ts";
import { branchOperatorName } from "../../lib/cases/operator-names.ts";
import {
  changeOutcome,
  operatorName,
  outcomeLabel,
} from "../../lib/model/revisions/change.ts";
import {
  noticeRequest,
  type OperatorNotice,
  readNoticeRoute,
  routeCodeLabel,
  shortSummary,
} from "../../lib/conversations/operator-notice.ts";
import {
  authorityName,
  delegatedDecisionLabel,
  noticeChange,
} from "../../lib/conversations/operator-authority.ts";
import { ChangeProposalCard } from "./ChangeProposalCard.tsx";

/**
 * What an operator reported to the agent that opened its Request, as one line
 * that leads to that Request. Routing observations and decision receipts stay
 * distinct. The texts come from the operator and are shown as text only;
 * the full result stays in the title.
 *
 * A Request opened from the interface runs apart from main, on its own Branch
 * Operator, which shares its native identity with the Main Operator of the
 * roster: that operator goes by its Branch Operator name, and the change it
 * asked is read in the Request's own conversation. On a recorded route, the
 * space of each operator tells that Branch Operator from the Main Operator.
 */
export function OperatorNoticeRow(
  { notice, state }: { notice: OperatorNotice; state: WorkbenchState },
) {
  const roster = state.conversationSnapshot.value?.conversations;
  const branch = state.requests.cases.byId(notice.caseId);
  const record = branch ?? state.cases.byId(notice.caseId);
  const href = caseHref(notice.caseId, record?.type);
  const branchId = branch?.id;
  const branchConversations = branchId
    ? state.requests.snapshots.value.get(branchId)?.conversations
    : undefined;
  const unread = !!branchId && !branchConversations;
  const sessionReady = state.requests.sessionReady.value;
  useEffect(() => {
    // No one has opened the Request yet: whether its change was decided is only
    // known from its own conversation.
    if (branchId && unread && sessionReady) {
      void state.requests.refresh(branchId);
    }
  }, [state, branchId, unread, sessionReady]);
  const branchName = (nativeId: string) =>
    branch && nativeId === branch.owner
      ? branchOperatorName(branch)
      : undefined;
  // A hop of main is never the Branch Operator, though it shares its native
  // ID; without a space (a notice, a version 1 hop), the Request's owner is.
  const nameOf = (nativeId: string, spaceId?: string) =>
    (spaceId === MAIN_EXECUTION_SPACE_ID ? undefined : branchName(nativeId)) ??
      authorityName(roster ?? [], nativeId);
  if (notice.kind === "authority-escalation") {
    const route = readNoticeRoute(notice);
    const name = nameOf(notice.requestedBy, route?.requester?.executionSpaceId);
    const requested = noticeRequest(notice);
    const change = noticeChange(
      notice,
      (branch ? branchConversations : roster) ?? [],
    );
    const actor = route?.designatedDecider;
    // A Branch Operator's request is relayed with the Case's own card, read
    // in the Request's conversation and decided through the same command.
    const relayed = branch && route?.version === 2 && change
      ? branchConversations?.find((agent) => agent.nativeId === branch.owner)
      : undefined;
    // A closed code reads as a short phrase; the host's reason stays in the detail.
    const why = route?.code ? routeCodeLabel[route.code] : route?.reason;
    // "Forwarded by" names the first hop, in the space the route records for it.
    const routeLabel = route?.status === "actor-decision" && actor
      ? `Forwarded${
        route.responsibleOperatorId
          ? ` by ${
            nameOf(
              route.responsibleOperatorId,
              route.trace[0]?.executionSpaceId,
            )
          }`
          : ""
      } to ${nameOf(actor.operatorId, actor.executionSpaceId)}`
      : route?.status === "human-decision"
      ? "Human decision requested"
      : route?.status === "needs-resolution"
      ? `Routing needs resolution${why ? `: ${why}` : ""}`
      : "Decision routing unavailable";
    const outcome = change && change.status !== "pending"
      ? delegatedDecisionLabel(change, roster ?? []) ??
        outcomeLabel[changeOutcome(change)]
      : routeLabel;
    const trace = route?.trace.map((hop) =>
      `${nameOf(hop.operatorId, hop.executionSpaceId)}: ${
        hop.eligibility === "eligible"
          ? `${hop.policyId} revision ${hop.policyRevision}`
          : "no covering grant"
      }`
    ).join(" → ");
    const routeDetail = route
      ? `Route recorded; eligibility is rechecked on decision.${
        trace ? ` ${trace}.` : ""
      }${route.reason ? ` ${route.reason}` : ""}`
      : "No verified decision route is available for this historical notice.";
    return (
      <article
        class="operator-notice is-escalation"
        data-notice="authority-escalation"
      >
        <a class="notice-line" href={href} title={notice.reason}>
          <span class="notice-mark" aria-hidden="true" />
          <span class="notice-text">
            <b>{name}</b> asks: {shortSummary(notice.reason)}
          </span>
          <span class="notice-state" title={`${outcome}. ${routeDetail}`}>
            · {outcome}
          </span>
        </a>
        {requested && (
          <p class="notice-result" title={requested}>{requested}</p>
        )}
        {route && (
          <details class="notice-route">
            <summary>Decision route</summary>
            <p>{routeDetail}</p>
            <p>
              Change {route.changeId} · base revision {route.baseRevision}{" "}
              · model {route.modelDigest}
            </p>
          </details>
        )}
        {relayed && change && (
          <ChangeProposalCard
            change={change}
            conversation={relayed}
            state={state}
            caseId={notice.caseId}
            independentRequest
            decidedByMain={notice.decisionAuthority === "operator"}
          />
        )}
      </article>
    );
  }
  if (notice.kind === "subordinate-order") {
    // Another operator than the parent gave the order. The notice names the
    // space of an orderer from another space (the Main Operator, in main);
    // without one, the orderer is read in the Case's own space.
    const order = shortSummary(notice.summary);
    return (
      <article class="operator-notice is-order" data-notice="subordinate-order">
        <a class="notice-line" href={href} title={notice.summary}>
          <span class="notice-mark" aria-hidden="true" />
          <span class="notice-text">
            <b>
              {nameOf(
                notice.orderedBy.operatorId,
                notice.orderedBy.executionSpaceId,
              )}
            </b>{" "}
            gave {nameOf(notice.subordinate)} an order
          </span>
          {order && <span class="notice-state">· {order}</span>}
        </a>
      </article>
    );
  }
  const name = branchName(notice.owner) ??
    operatorName(roster, notice.owner) ?? "An operator";
  return (
    <article
      class="operator-notice is-completed"
      data-notice="request-completed"
    >
      <a class="notice-line" href={href}>
        <span class="notice-mark" aria-hidden="true" />
        <span class="notice-text">
          <b>{name}</b> finished{" "}
          {record ? caseTitle(record, 40) : "its Request"}
        </span>
        <span class="notice-state">· {caseStatusLabel[notice.status]}</span>
      </a>
      {notice.result && (
        <p class="notice-result" title={notice.result}>{notice.result}</p>
      )}
    </article>
  );
}
