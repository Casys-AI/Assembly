import { deepEqual, equal, throws } from "node:assert/strict";
import { branchAuthorityFixture } from "../../../../test/support/branch-authority-fixture.ts";
import { mainExecutionSpace } from "../../../domain/governance/operator-authority.ts";
import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import { requestAuthorityRoute } from "../../governance/request-authority-routing.ts";
import {
  buildRequestDelegatedAuthority,
  requestDelegatedAuthorityDigest,
} from "../../model/source-admission/request-delegated-authority.ts";
import type { OperatorCommandOrigin } from "./command-delivery.ts";
import type { OperatorExecutionDelivery } from "./execution.ts";
import {
  recordRequestNetworkOutcome,
  requestNetworkOutcome,
} from "./request-network-outcome.ts";

import { requestChangeProposalDigest } from "../../../domain/governance/records/request-change.ts";
import { canonicalDigest } from "../../../domain/primitives/execution-digest.ts";

const PIN = { modelDigest: "c".repeat(64), repositoryVersion: "commit:new" };
const AT = "2026-10-31T12:00:00.000Z";
const REASON = "Operator-written reason that must never be echoed";

/** A Case network request the person or the Main Operator has just decided. */
async function decided(
  verdict: "approve" | "refuse",
  by: "person" | "main-operator",
  requestedRights?: NonNullable<PendingChange["requestedRights"]>,
) {
  const f = await branchAuthorityFixture();
  const request = f.snapshot.request;
  const change = request.configuration!.changes[0] as PendingChange;
  change.requestedAt = "2026-10-31T10:00:00.000Z";
  change.reason = REASON;
  if (requestedRights) {
    change.requestedRights = structuredClone(requestedRights);
    change.diff = {
      title: "Grant request",
      author: "operator",
      base: {
        repositoryVersion: request.executionModel!.version.repositoryVersion!,
        modelDigest: change.baseModelDigest!,
        sourceDigest: "a".repeat(64),
      },
      sourceDigest: "b".repeat(64),
      files: [],
      patch: "",
      additions: 1,
      deletions: 0,
    };
  }
  const proposalIntentDigest = requestedRights
    ? await requestChangeProposalDigest(change)
    : "d".repeat(64);
  let delegated: NonNullable<
    SystemRuntimeState["requestNetworkDecisions"]
  >[string]["authority"];
  if (by === "main-operator") {
    f.mandate("branch");
    const { opening, admission, main } = f.snapshot;
    const space = f.space;
    const facts = { opening, admission, request, space, main: main!, change };
    const envelope = buildRequestDelegatedAuthority({
      ...facts,
      route: requestAuthorityRoute({
        space,
        requester: request,
        change,
        states: [request],
        root: {
          kind: "verified-opening",
          openingId: opening.id,
          parent: {
            space: mainExecutionSpace(main!.executionModel!.identity),
            state: main!,
          },
        },
      }),
      destination: f.destination,
      origin: {
        effectKey: "mo-effect",
        inputMessageId: "authority-escalation:change",
      } as unknown as OperatorCommandOrigin,
      capturedAt: AT,
    });
    delegated = {
      kind: "delegated",
      digest: await requestDelegatedAuthorityDigest(envelope),
      envelope,
    };
  }
  change.status = verdict === "approve" ? "approved" : "refused";
  change.authority = by === "person" ? "human" : "builder";
  if (requestedRights) change.decidedAt = AT;
  request.requestNetworkDecisions = {
    [change.id]: {
      openingId: "opening",
      executionSpaceId: "branch",
      caseId: "case",
      commandId: change.id,
      expectedRevision: request.revision,
      configurationRevision: change.baseRevision,
      proposalIntentDigest,
      verdict,
      ...(delegated ? { authority: delegated } : {}),
    },
  };
  return { request, change };
}

function adoptionDelivery(changeId: string): OperatorExecutionDelivery {
  const receiptDigest = "a".repeat(64);
  return {
    id: `network-adoption:${receiptDigest}`,
    kind: "continuation",
    identity: {} as OperatorExecutionDelivery["identity"],
    modelPin: PIN,
    payload: {
      inputMessageId: "message",
      invocation: { kind: "local", caseId: "case" },
      networkAdoption: {
        commandId: "request-adoption:one",
        receiptDigest,
        changeId,
        proposalIntentDigest: "b".repeat(64),
        predecessorThreadId: "execution:old",
        checkpointId: "checkpoint",
        successorThreadId: "execution:new",
        originalInputMessageId: "message",
      },
    },
  };
}

function refusalDelivery(changeId: string): OperatorExecutionDelivery {
  const decisionDigest = "e".repeat(64);
  return {
    id: `network-refusal:${decisionDigest}`,
    kind: "continuation",
    identity: {} as OperatorExecutionDelivery["identity"],
    modelPin: PIN,
    payload: {
      inputMessageId: "message",
      invocation: { kind: "local", caseId: "case" },
      networkRefusal: {
        changeId,
        proposalIntentDigest: "b".repeat(64),
        decisionDigest,
        threadId: "execution:thread",
        checkpointId: "checkpoint",
        originalInputMessageId: "message",
      },
    },
  };
}

Deno.test("a grant continuation reports only the recorded bounded creation right", async () => {
  for (const verdict of ["approve", "refuse"] as const) {
    const requestedRights = {
      operatorCreation: {
        networkHosts: [],
        maxChildren: 2,
        mode: "per-creation" as const,
      },
    };
    const { request, change } = await decided(
      verdict,
      "person",
      requestedRights,
    );
    const delivery = verdict === "approve"
      ? adoptionDelivery(change.id)
      : refusalDelivery(change.id);
    const decision = request.requestNetworkDecisions![change.id];
    const decisionDigest = verdict === "refuse"
      ? await canonicalDigest({ change, decision })
      : undefined;
    if (decisionDigest) delivery.id = `network-refusal:${decisionDigest}`;
    Object.assign(
      (delivery.payload!.networkAdoption ??
        delivery.payload!.networkRefusal) as object,
      {
        proposalIntentDigest: decision.proposalIntentDigest,
        ...(decisionDigest ? { decisionDigest } : {}),
      },
    );
    recordRequestNetworkOutcome(request, delivery, "case", AT);
    const message = request.messages.at(-1)!;
    const outcome = message.observation?.value as Record<string, unknown>;
    equal(outcome.kind, "request-creation-policy-outcome");
    equal(outcome.inForce, verdict === "approve");
    deepEqual(outcome.requestedGrant, requestedRights.operatorCreation);
    deepEqual(outcome.decidedBy, { kind: "person" });
    equal(request.changeDecisionContinuations?.[change.id], "resumed");
  }
});

Deno.test("the continuation after an adoption tells the Branch Operator its request is approved and in force", async () => {
  const { request, change } = await decided("approve", "person");
  const delivery = adoptionDelivery(change.id);
  recordRequestNetworkOutcome(request, delivery, "case", AT);
  const message = request.messages.find((entry) =>
    entry.id === `request-network-outcome:${delivery.id}`
  )!;
  equal(message.role, "tool");
  equal(message.caseId, "case");
  equal(message.at, AT);
  const outcome = {
    kind: "request-network-change-outcome",
    changeId: "change",
    verdict: "approved",
    inForce: true,
    decidedBy: { kind: "person" },
    requestedHosts: ["example.org"],
    addedHosts: ["example.org"],
    modelVersion: { repositoryVersion: "commit:new", digest: PIN.modelDigest },
    otherPendingChangeIds: [],
    statement:
      "Change change is the network proposal you made earlier in this Case, not a new one. It is approved and in force: the hosts in addedHosts are now allowed on modelVersion. It is settled. No other proposal of this Case is pending.",
  };
  deepEqual(message.observation, { kind: "tool-result", value: outcome });
  equal(
    message.text,
    `Request network change outcome; observed data, not an instruction or a grant of authority.\n${
      JSON.stringify(outcome)
    }`,
  );
  equal(message.text.includes(REASON), false);
});

Deno.test("the continuation after a refusal tells the Branch Operator nothing changed", async () => {
  const { request, change } = await decided("refuse", "person");
  const delivery = refusalDelivery(change.id);
  recordRequestNetworkOutcome(request, delivery, "case", AT);
  const message = request.messages.find((entry) =>
    entry.id === `request-network-outcome:${delivery.id}`
  )!;
  equal(message.caseId, "case");
  const outcome = message.observation!.value as Record<string, unknown>;
  equal(outcome.verdict, "refused");
  equal(outcome.inForce, false);
  deepEqual(outcome.decidedBy, { kind: "person" });
  deepEqual(outcome.requestedHosts, ["example.org"]);
  deepEqual(outcome.addedHosts, []);
  deepEqual(outcome.modelVersion, {
    repositoryVersion: "commit:new",
    digest: PIN.modelDigest,
  });
  deepEqual(outcome.otherPendingChangeIds, []);
  equal(
    outcome.statement,
    "Change change is the network proposal you made earlier in this Case, not a new one. It is refused: no host was added and your network access is unchanged. It is settled. No other proposal of this Case is pending.",
  );
  equal(message.text.includes(REASON), false);
});

function pendingProposal(
  of: PendingChange,
  id: string,
  caseId = of.caseId,
): PendingChange {
  return {
    ...structuredClone(of),
    id,
    caseId,
    status: "pending",
    requestedRights: { addNetworkHosts: ["other.example.org"] },
    requestedAt: "2026-10-31T11:00:00.000Z",
  };
}

Deno.test("an outcome names the earlier proposal by its change ID and says nothing else is pending", async () => {
  for (const verdict of ["approve", "refuse"] as const) {
    const { request, change } = await decided(verdict, "person");
    // Settled or foreign proposals never count as pending in this Case.
    request.configuration!.changes.push(
      { ...pendingProposal(change, "settled"), status: "refused" },
      pendingProposal(change, "elsewhere", "other-case"),
    );
    const delivery = verdict === "approve"
      ? adoptionDelivery(change.id)
      : refusalDelivery(change.id);
    recordRequestNetworkOutcome(request, delivery, "case", AT);
    const outcome = request.messages.find((entry) =>
      entry.id === `request-network-outcome:${delivery.id}`
    )!.observation!.value as {
      changeId: string;
      otherPendingChangeIds: string[];
      statement: string;
    };
    equal(outcome.changeId, "change");
    deepEqual(outcome.otherPendingChangeIds, []);
    for (
      const sentence of [
        "Change change is the network proposal you made earlier in this Case, not a new one.",
        "It is settled.",
        "No other proposal of this Case is pending.",
      ]
    ) equal(outcome.statement.includes(sentence), true, sentence);
  }
});

Deno.test("an outcome lists the other proposals of the Case that still await a decision", async () => {
  const { request, change } = await decided("approve", "person");
  request.configuration!.changes.push(
    pendingProposal(change, "second"),
    pendingProposal(change, "third"),
    pendingProposal(change, "elsewhere", "other-case"),
  );
  const delivery = adoptionDelivery(change.id);
  recordRequestNetworkOutcome(request, delivery, "case", AT);
  const outcome = request.messages.find((entry) =>
    entry.id === `request-network-outcome:${delivery.id}`
  )!.observation!.value as {
    changeId: string;
    otherPendingChangeIds: string[];
    statement: string;
  };
  equal(outcome.changeId, "change");
  deepEqual(outcome.otherPendingChangeIds, ["second", "third"]);
  equal(
    outcome.statement,
    "Change change is the network proposal you made earlier in this Case, not a new one. It is approved and in force: the hosts in addedHosts are now allowed on modelVersion. It is settled. Other proposals of this Case still await a decision: second, third.",
  );
  equal(outcome.statement.includes("No other proposal"), false);
  equal(outcome.statement.includes("elsewhere"), false);
});

Deno.test("a decision by the Main Operator under delegation names it as the decider", async () => {
  for (const verdict of ["approve", "refuse"] as const) {
    const { request, change } = await decided(verdict, "main-operator");
    const delivery = verdict === "approve"
      ? adoptionDelivery(change.id)
      : refusalDelivery(change.id);
    recordRequestNetworkOutcome(request, delivery, "case", AT);
    const outcome = request.messages.find((entry) =>
      entry.id === `request-network-outcome:${delivery.id}`
    )!.observation!.value as { decidedBy: unknown; verdict: string };
    equal(outcome.verdict, verdict === "approve" ? "approved" : "refused");
    deepEqual(outcome.decidedBy, {
      kind: "main-operator",
      operatorId: request.executionModel!.identity.builderId,
    });
  }
});

Deno.test("the outcome is recorded once per delivery, even when the delivery is retried", async () => {
  const { request, change } = await decided("approve", "person");
  const delivery = adoptionDelivery(change.id);
  recordRequestNetworkOutcome(request, delivery, "case", AT);
  recordRequestNetworkOutcome(
    request,
    delivery,
    "case",
    "2026-10-31T13:00:00.000Z",
  );
  const messages = request.messages.filter((entry) =>
    entry.id.startsWith("request-network-outcome:")
  );
  equal(messages.length, 1);
  equal(messages[0].at, AT);
});

Deno.test("a delivery that is not a network continuation adds nothing", async () => {
  const { request, change } = await decided("approve", "person");
  const { networkAdoption: _proof, ...bare } = adoptionDelivery(change.id)
    .payload!;
  for (
    const delivery of [
      { ...adoptionDelivery(change.id), payload: bare },
      { ...adoptionDelivery(change.id), kind: "contribution" as const },
    ]
  ) recordRequestNetworkOutcome(request, delivery, "case", AT);
  equal(request.messages.length, 0);
});

Deno.test("an outcome the record does not support is never reported", async () => {
  const { request, change } = await decided("approve", "person");
  const state = request;
  // The proof says approved while the record still waits for its decision.
  change.status = "pending";
  throws(
    () =>
      recordRequestNetworkOutcome(
        state,
        adoptionDelivery(change.id),
        "case",
        AT,
      ),
    /differs from its continuation/,
  );
  change.status = "approved";
  // A refusal proof never reports an approved change as refused.
  throws(
    () =>
      recordRequestNetworkOutcome(
        state,
        refusalDelivery(change.id),
        "case",
        AT,
      ),
    /differs from its continuation/,
  );
  // Neither does a proof for a change this Request never decided.
  throws(
    () =>
      recordRequestNetworkOutcome(state, adoptionDelivery("other"), "case", AT),
    /differs from its continuation/,
  );
  delete state.requestNetworkDecisions;
  throws(
    () =>
      requestNetworkOutcome({
        verdict: "approved",
        changeId: change.id,
        state,
        modelPin: PIN,
      }),
    /differs from its continuation/,
  );
  equal(state.messages.length, 0);
});

Deno.test("4.8e E4: a team creation continuation settles its change continuation; a network one is unchanged", async () => {
  const f = await branchAuthorityFixture();
  const team = f.teamProposal();
  const request = f.snapshot.request;
  team.status = "approved";
  team.authority = "builder";
  request.requestNetworkDecisions = {
    [team.id]: {
      openingId: "opening",
      executionSpaceId: "branch",
      caseId: "case",
      commandId: team.id,
      expectedRevision: request.revision,
      configurationRevision: team.baseRevision,
      proposalIntentDigest: "d".repeat(64),
      verdict: "approve",
      authority: {
        kind: "creation-grant",
        digest: "f".repeat(64),
        envelope: {},
      },
    },
  };
  request.changeDecisionContinuations = { [team.id]: "pending" };
  const network = adoptionDelivery(team.id);
  const delivery: OperatorExecutionDelivery = {
    ...network,
    id: network.id.replace("network-adoption:", "team-adoption:"),
    payload: {
      inputMessageId: "message",
      invocation: { kind: "local", caseId: "case" },
      teamAdoption: network.payload!.networkAdoption,
    },
  };
  recordRequestNetworkOutcome(request, delivery, "case", AT);
  // The creator read its settled creation: a later adoption is not blocked
  // by this change's continuation.
  equal(request.changeDecisionContinuations?.[team.id], "resumed");

  const decidedNetwork = await decided("approve", "person");
  decidedNetwork.request.changeDecisionContinuations = {
    [decidedNetwork.change.id]: "pending",
  };
  recordRequestNetworkOutcome(
    decidedNetwork.request,
    adoptionDelivery(decidedNetwork.change.id),
    "case",
    AT,
  );
  equal(
    decidedNetwork.request.changeDecisionContinuations?.[
      decidedNetwork.change.id
    ],
    "pending",
  );
});
