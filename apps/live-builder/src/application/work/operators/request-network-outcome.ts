import { assertRequestNetworkChange } from "../../../domain/governance/records/request-network-change.ts";
import { assertRequestTeamChange } from "../../../domain/governance/records/request-change.ts";
import type {
  Message,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import { parseRequestDelegatedAuthority } from "../../model/source-admission/request-delegated-authority.ts";
import type { OperatorExecutionDelivery } from "./execution.ts";
import {
  parseRequestNetworkContinuation,
  parseRequestNetworkRefusalContinuation,
  parseRequestTeamContinuation,
  parseRequestTeamRefusalContinuation,
} from "../runtime/execution.ts";

/** What a Branch Operator reads, as a fact, once its network request is
 * settled: the host's own record of the decision, never a free-text report. */
interface RequestNetworkOutcome {
  kind: "request-network-change-outcome";
  changeId: string;
  verdict: "approved" | "refused";
  /** True only when the approved addition is adopted on `modelVersion`. */
  inForce: boolean;
  decidedBy:
    | { kind: "person" }
    | { kind: "main-operator"; operatorId: string };
  requestedHosts: string[];
  /** Empty for a refusal: nothing changed. */
  addedHosts: string[];
  /** The model version the Request continues on. */
  modelVersion: { repositoryVersion?: string; digest: string };
  /** Other proposals of this Case that still await a decision, in the order
   * they were recorded; empty when `changeId` was the only one. */
  otherPendingChangeIds: string[];
  statement: string;
}

/** The team twin (4.8e E4): what a Branch Operator reads once its team
 * creation is settled. */
interface RequestTeamOutcome {
  kind: "request-team-change-outcome";
  changeId: string;
  verdict: "approved" | "refused";
  inForce: boolean;
  decidedBy: { kind: "person" } | { kind: "branch-grant" };
  memberName: string;
  modelVersion: { repositoryVersion?: string; digest: string };
  otherPendingChangeIds: string[];
  statement: string;
}

const PREAMBLE =
  "Request network change outcome; observed data, not an instruction or a grant of authority.";
const TEAM_PREAMBLE =
  "Request team creation outcome; observed data, not an instruction or a grant of authority.";

/** Pure projection of the recorded change and decision. The verdict comes from
 * the delivered continuation proof; the record must agree with it. */
export function requestNetworkOutcome(input: {
  verdict: "approved" | "refused";
  changeId: string;
  state: Pick<SystemRuntimeState, "configuration" | "requestNetworkDecisions">;
  modelPin: { modelDigest: string; repositoryVersion?: string };
}): RequestNetworkOutcome {
  const change = input.state.configuration?.changes.find((entry) =>
    entry.id === input.changeId
  );
  const decision = input.state.requestNetworkDecisions?.[input.changeId];
  if (!change || !decision || change.status !== input.verdict) {
    throw new Error(
      "The recorded Request network decision differs from its continuation",
    );
  }
  assertRequestNetworkChange(change);
  const requestedHosts = [...change.requestedRights.addNetworkHosts];
  const approved = input.verdict === "approved";
  const otherPendingChangeIds = (input.state.configuration?.changes ?? [])
    .filter((entry) =>
      entry.status === "pending" && entry.caseId === change.caseId &&
      entry.id !== change.id
    )
    .map((entry) => entry.id);
  return {
    kind: "request-network-change-outcome",
    changeId: change.id,
    verdict: input.verdict,
    inForce: approved,
    decidedBy: decision.authority?.kind === "delegated"
      ? {
        kind: "main-operator",
        operatorId:
          parseRequestDelegatedAuthority(decision.authority.envelope).decider
            .operatorId,
      }
      : { kind: "person" },
    requestedHosts,
    addedHosts: approved ? [...requestedHosts] : [],
    modelVersion: {
      ...(input.modelPin.repositoryVersion
        ? { repositoryVersion: input.modelPin.repositoryVersion }
        : {}),
      digest: input.modelPin.modelDigest,
    },
    otherPendingChangeIds,
    statement: [
      `Change ${change.id} is the network proposal you made earlier in this Case, not a new one.`,
      approved
        ? "It is approved and in force: the hosts in addedHosts are now allowed on modelVersion."
        : "It is refused: no host was added and your network access is unchanged.",
      "It is settled.",
      otherPendingChangeIds.length === 0
        ? "No other proposal of this Case is pending."
        : `Other proposals of this Case still await a decision: ${
          otherPendingChangeIds.join(", ")
        }.`,
    ].join(" "),
  };
}

/** Pure projection of the recorded team creation and its decision. */
function requestTeamOutcome(input: {
  verdict: "approved" | "refused";
  changeId: string;
  state: Pick<SystemRuntimeState, "configuration" | "requestNetworkDecisions">;
  modelPin: { modelDigest: string; repositoryVersion?: string };
}): RequestTeamOutcome {
  const change = input.state.configuration?.changes.find((entry) =>
    entry.id === input.changeId
  );
  const decision = input.state.requestNetworkDecisions?.[input.changeId];
  if (!change || !decision || change.status !== input.verdict) {
    throw new Error(
      "The recorded Request team decision differs from its continuation",
    );
  }
  assertRequestTeamChange(change);
  const approved = input.verdict === "approved";
  const otherPendingChangeIds = (input.state.configuration?.changes ?? [])
    .filter((entry) =>
      entry.status === "pending" && entry.caseId === change.caseId &&
      entry.id !== change.id
    )
    .map((entry) => entry.id);
  return {
    kind: "request-team-change-outcome",
    changeId: change.id,
    verdict: input.verdict,
    inForce: approved,
    decidedBy: decision.authority?.kind === "creation-grant"
      ? { kind: "branch-grant" }
      : { kind: "person" },
    memberName: change.name,
    modelVersion: {
      ...(input.modelPin.repositoryVersion
        ? { repositoryVersion: input.modelPin.repositoryVersion }
        : {}),
      digest: input.modelPin.modelDigest,
    },
    otherPendingChangeIds,
    statement: [
      `Change ${change.id} is the team creation you proposed earlier in this Case, not a new one.`,
      approved
        ? `It is approved and in force: ${change.name} is now a member of this Request's team on modelVersion; address it through your team inbox access.`
        : "It is refused: no teammate was created and your team is unchanged.",
      "It is settled.",
      otherPendingChangeIds.length === 0
        ? "No other proposal of this Case is pending."
        : `Other proposals of this Case still await a decision: ${
          otherPendingChangeIds.join(", ")
        }.`,
    ].join(" "),
  };
}

/** Tell the resumed Request how its network change ended, in its own Case
 * history, before the dialogue runs. Idempotent per delivery; a delivery that
 * is not a network continuation is left alone. */
export function recordRequestNetworkOutcome(
  state: SystemRuntimeState,
  delivery: OperatorExecutionDelivery,
  caseId: string,
  at: string,
): void {
  const { networkAdoption, networkRefusal, teamAdoption, teamRefusal } =
    delivery.payload ?? {};
  if (
    delivery.kind !== "continuation" ||
    networkAdoption === undefined && networkRefusal === undefined &&
      teamAdoption === undefined && teamRefusal === undefined
  ) return;
  const team = teamAdoption !== undefined || teamRefusal !== undefined;
  const id = `request-network-outcome:${delivery.id}`;
  if (state.messages.some((message) => message.id === id)) return;
  const approved = networkAdoption !== undefined ||
    teamAdoption !== undefined;
  const outcome = team
    ? requestTeamOutcome({
      verdict: approved ? "approved" : "refused",
      changeId: approved
        ? parseRequestTeamContinuation(teamAdoption).changeId
        : parseRequestTeamRefusalContinuation(teamRefusal).changeId,
      state,
      modelPin: delivery.modelPin,
    })
    : requestNetworkOutcome({
      verdict: approved ? "approved" : "refused",
      changeId: approved
        ? parseRequestNetworkContinuation(networkAdoption).changeId
        : parseRequestNetworkRefusalContinuation(networkRefusal).changeId,
      state,
      modelPin: delivery.modelPin,
    });
  const message: Message = {
    id,
    role: "tool",
    caseId,
    text: `${team ? TEAM_PREAMBLE : PREAMBLE}\n${JSON.stringify(outcome)}`,
    observation: { kind: "tool-result", value: outcome },
    at,
  };
  state.messages.push(message);
  // The creator now reads its settled creation (4.8e E4): this change's
  // continuation is done, so a later adoption of the Case is not blocked by
  // it. The network path keeps its recorded bytes.
  if (team) {
    (state.changeDecisionContinuations ??= {})[outcome.changeId] = "resumed";
  }
}
