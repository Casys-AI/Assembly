import type { Message } from "../../../src/domain/work/dialogue.ts";
import type {
  AuthorityRouteCode,
  RequestAuthorityRoute,
} from "../../../src/domain/governance/operator-authority.ts";
import { changeTitle } from "./proposal-differences.ts";

/** What an operator reported to its opener: data, never an instruction. */
export type OperatorNotice = NonNullable<Message["operatorNotice"]>;

type RouteHop = RequestAuthorityRoute["trace"][number];
type RouteDecider = NonNullable<RequestAuthorityRoute["designatedDecider"]>;

/**
 * A route recorded before version 2: its hops are native operator IDs with no
 * space, and it names no requesting instance. Notices keep it as recorded.
 */
export type LegacyRequestAuthorityRoute =
  & Omit<
    RequestAuthorityRoute,
    | "version"
    | "requester"
    | "openingId"
    | "code"
    | "designatedDecider"
    | "trace"
  >
  & {
    version: 1;
    requester?: undefined;
    openingId?: undefined;
    code?: undefined;
    designatedDecider?:
      & Omit<RouteDecider, "executionSpaceId">
      & { executionSpaceId?: undefined };
    trace: Array<
      Omit<RouteHop, "executionSpaceId"> & { executionSpaceId?: undefined }
    >;
  };

/** Either version of a route a notice may carry. */
export type NoticeRoute = RequestAuthorityRoute | LegacyRequestAuthorityRoute;

/** Why a route needs resolution, as a short phrase for the person. */
export const routeCodeLabel: Readonly<Record<AuthorityRouteCode, string>> = {
  OPENING_PROOF_UNAVAILABLE: "The Request's opening is not on record",
  OPENING_PROOF_MISMATCH: "The Request's opening does not match",
  MAIN_UNAVAILABLE: "Main is unavailable",
  MAIN_POLICY_UNREADABLE: "Main's policy cannot be read",
  CHANGE_NOT_PENDING: "The change is no longer pending",
  CHANGE_STALE: "The change was proposed on an older revision",
  CHAIN_UNVERIFIED: "The chain of operators is not verified",
};

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

type Instance = { operatorId: string; executionSpaceId?: string };
/** A Branch Operator shares its Main Operator's native ID: the space tells them apart. */
const sameInstance = (a: Instance, b: Instance) =>
  a.operatorId === b.operatorId && a.executionSpaceId === b.executionSpaceId;

/** A recorded host route, bound to this notice; never proof of current rights. */
export function readNoticeRoute(
  notice: OperatorNotice,
): NoticeRoute | undefined {
  if (notice.kind !== "authority-escalation") return undefined;
  // Historical notices keep the version 1 route they recorded.
  const route = notice.route as NoticeRoute | undefined;
  if (!route || (route.version !== 1 && route.version !== 2)) return undefined;
  // Version 2 names the requesting instance and the space of every hop; a
  // version 1 route holds none of them, and a field of the other version is
  // not a route.
  const v2 = route.version === 2;
  const space = (value: unknown) => v2 ? text(value) : value === undefined;
  const requester = route.requester;
  if (
    route.changeId !== notice.changeId ||
    route.caseId !== notice.caseId ||
    route.requestedBy !== notice.requestedBy ||
    route.targetOperatorId !== notice.requestedBy ||
    (v2
      ? !requester || !text(requester.projectId) ||
        !text(requester.systemId) || !text(requester.executionSpaceId) ||
        requester.operatorId !== notice.requestedBy ||
        (route.openingId !== undefined && !text(route.openingId)) ||
        Object.hasOwn(route, "scopedActors") ||
        (route.status === "needs-resolution") !== (route.code !== undefined) ||
        (route.code !== undefined &&
          !Object.hasOwn(routeCodeLabel, route.code))
      : requester !== undefined || route.openingId !== undefined ||
        route.code !== undefined) ||
    !Number.isSafeInteger(route.baseRevision) || route.baseRevision < 0 ||
    (route.responsibleOperatorId !== undefined &&
      !text(route.responsibleOperatorId)) ||
    (route.reason !== undefined && typeof route.reason !== "string") ||
    !text(route.modelDigest) || !Array.isArray(route.trace) ||
    route.trace.some((hop) =>
      !hop || !text(hop.operatorId) || !space(hop.executionSpaceId) ||
      !["eligible", "not-covered"].includes(hop.eligibility)
    ) ||
    new Set(
        route.trace.map((hop) =>
          `${hop.executionSpaceId ?? ""}\0${hop.operatorId}`
        ),
      ).size !== route.trace.length ||
    (route.trace.length > 0 &&
      route.trace[0]?.operatorId !== route.responsibleOperatorId)
  ) return undefined;
  if (route.status === "actor-decision") {
    const actor = route.designatedDecider;
    const last = route.trace.at(-1);
    return notice.decisionAuthority === "operator" && actor &&
        text(actor.operatorId) && text(actor.policyId) &&
        space(actor.executionSpaceId) &&
        !sameInstance(actor, {
          operatorId: notice.requestedBy,
          executionSpaceId: requester?.executionSpaceId,
        }) &&
        Number.isSafeInteger(actor.policyRevision) &&
        actor.policyRevision > 0 &&
        last && sameInstance(last, actor) &&
        last.eligibility === "eligible" &&
        last.policyId === actor.policyId &&
        last.policyRevision === actor.policyRevision &&
        route.trace.slice(0, -1).every((hop) =>
          hop.eligibility === "not-covered"
        )
      ? route
      : undefined;
  }
  if (
    (route.status === "human-decision" &&
        notice.decisionAuthority === "human" ||
      route.status === "needs-resolution" &&
        notice.decisionAuthority === "unresolved") &&
    !route.designatedDecider &&
    route.trace.every((hop) => hop.eligibility === "not-covered")
  ) return route;
  return undefined;
}

/**
 * What a notice says was asked, on one line: the rights the host recorded with
 * it, as text only. A notice recorded before them says nothing.
 */
export function noticeRequest(notice: OperatorNotice): string | undefined {
  if (
    notice.kind !== "authority-escalation" || !notice.changeKind ||
    !notice.requestedRights
  ) return undefined;
  const rights = notice.requestedRights;
  const title = changeTitle({
    kind: notice.changeKind,
    requestedRights: rights,
  });
  return "addNetworkHosts" in rights
    ? `${title}: ${rights.addNetworkHosts.join(", ")}`
    : title;
}

/**
 * The notice a message carries, only when it has the exact shape of one of the
 * three kinds. Any other record stays an ordinary message, shown as text.
 */
export function readOperatorNotice(
  message: Pick<Message, "operatorNotice">,
): OperatorNotice | undefined {
  const notice = message.operatorNotice as Record<string, unknown> | undefined;
  if (!notice || typeof notice !== "object") return undefined;
  if (
    notice.kind === "authority-escalation" && text(notice.changeId) &&
    text(notice.requestedBy) && text(notice.caseId) &&
    typeof notice.reason === "string"
  ) return notice as unknown as OperatorNotice;
  if (
    notice.kind === "request-completed" && text(notice.caseId) &&
    text(notice.owner) &&
    (notice.status === "closed-done" || notice.status === "closed-abandoned") &&
    typeof notice.result === "string"
  ) return notice as unknown as OperatorNotice;
  const by = notice.orderedBy as Record<string, unknown> | undefined;
  if (
    notice.kind === "subordinate-order" && text(notice.invocationId) &&
    text(notice.caseId) && text(notice.subordinate) &&
    by && typeof by === "object" && text(by.operatorId) &&
    (by.executionSpaceId === undefined || text(by.executionSpaceId)) &&
    typeof notice.summary === "string"
  ) return notice as unknown as OperatorNotice;
  return undefined;
}

/**
 * The first sentence of a text, cut at a word boundary: enough to recognise a
 * request on one line. The full text stays available to whoever asks for it.
 */
export function shortSummary(value: string, max = 90): string {
  const sentence = value.trim().split(/(?<=[.?!])\s|\n/)[0] ?? "";
  const plain = sentence.replace(/\s+/g, " ").replace(/[.!?\s]+$/, "");
  if ([...plain].length <= max) return plain;
  const cut = [...plain].slice(0, max - 1).join("");
  const word = cut.replace(/\s+\S*$/, "");
  return `${word.length >= max / 2 ? word : cut}…`;
}
