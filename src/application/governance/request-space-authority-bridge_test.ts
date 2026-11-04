import {
  assertRequestDelegatedAuthorityCurrent,
  buildRequestDelegatedAuthority,
  RequestDelegatedAuthorityError,
} from "../model/source-admission/request-delegated-authority.ts";
import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import {
  awaitingPersonView,
  createWorkspaceBranchReads,
  MAX_AWAITING_PERSON,
  type RequestDelegatedDecisionInput,
  RequestSpaceAuthorityBridge,
  type RequestSpaceAuthorityBridgePort,
  type RequestSpaceAuthorityBridgeSnapshot,
} from "./request-space-authority-bridge.ts";
import type { OperatorCommandOrigin } from "../work/operators/command-delivery.ts";
import { branchAuthorityFixture } from "../../../test/support/branch-authority-fixture.ts";
import type { PendingChange } from "../../domain/governance/records/pending-change.ts";
import type { Case } from "../../domain/work/entities/cases.ts";
import type { OperatorNotice } from "../../domain/governance/operator-authority.ts";
import { invocationKey } from "../work/operators/journal.ts";
import { SystemRuntime } from "../work/runtime/system.ts";
import type { SystemRuntimeState } from "../work/runtime/state.ts";

const view_requests = async (
  f: { bridge: RequestSpaceAuthorityBridge },
  decider: Parameters<RequestSpaceAuthorityBridge["mainView"]>[0],
) => (await f.bridge.mainView(decider)).requests;
const view_awaitingPerson = async (
  f: { bridge: RequestSpaceAuthorityBridge },
  decider: Parameters<RequestSpaceAuthorityBridge["mainView"]>[0],
) => (await f.bridge.mainView(decider)).awaitingPerson;
const view_openRequests = async (
  f: { bridge: RequestSpaceAuthorityBridge },
  decider: Parameters<RequestSpaceAuthorityBridge["mainView"]>[0],
) => (await f.bridge.mainView(decider)).openRequests;

async function fixture(
  receiveMain?: RequestSpaceAuthorityBridgePort["receiveMain"],
  overrides: Partial<RequestSpaceAuthorityBridgePort> = {},
) {
  const { snapshot, mandate, teamProposal, destination } =
    await branchAuthorityFixture();
  /** What the host's grant reader answers for a pending team creation. */
  let grant: "autonomous" | "per-creation" = "autonomous";
  const creations: Array<{ changeId: string; envelope: unknown }> = [];
  const resumed: string[] = [];
  const settlementOrder: string[] = [];
  const teamSizes: number[] = [];
  const deliveries: Array<{
    notice: OperatorNotice;
    origin: Case["openedFrom"];
    delivery: { wake: boolean };
  }> = [];
  const branchDeliveries: typeof deliveries = [];
  const refusals: Array<Record<string, string>> = [];
  let resolvable = true;
  const decisions: RequestDelegatedDecisionInput[] = [];
  const bridge = new RequestSpaceAuthorityBridge({
    decide: (input) => {
      decisions.push(input);
      return Promise.resolve();
    },
    resolve: () => Promise.resolve(resolvable ? snapshot : null),
    receiveMain: (notice, origin, delivery) => {
      deliveries.push({ notice, origin, delivery });
      return receiveMain?.(notice, origin, delivery) ?? Promise.resolve();
    },
    ...{
      receiveBranch: (
        _caseId: string,
        notice: OperatorNotice,
        origin: Case["openedFrom"],
        delivery: { wake: boolean },
      ) => {
        branchDeliveries.push({ notice, origin, delivery });
        return Promise.resolve();
      },
    },
    openCases: () => Promise.resolve(["case"]),
    refused: (detail) => refusals.push({ ...detail }),
    creationGrant: () => ({ change, branchTeamSize }) => {
      teamSizes.push(branchTeamSize);
      return Promise.resolve(
        grant === "autonomous" && branchTeamSize < 3
          ? { kind: "request-creation-grant", changeId: change.id } as never
          : undefined,
      );
    },
    decideCreation: ({ change, envelope }) => {
      settlementOrder.push(`decide:${change.id}`);
      creations.push({ changeId: change.id, envelope });
      return Promise.resolve();
    },
    resumeCreation: ({ change }) => {
      settlementOrder.push(`resume:${change.id}`);
      resumed.push(change.id);
      return Promise.resolve();
    },
    ...overrides,
  });
  return {
    bridge,
    destination,
    branchDeliveries,
    creations,
    resumed,
    settlementOrder,
    teamSizes,
    teamProposal,
    grantIs(mode: "autonomous" | "per-creation") {
      grant = mode;
    },
    decisions,
    snapshot,
    deliveries,
    refusals,
    mandate,
    unresolvable() {
      resolvable = false;
    },
  };
}
const escalation = (entry: { notice: OperatorNotice }) => {
  if (entry.notice.kind !== "authority-escalation") {
    throw new Error(`unexpected ${entry.notice.kind}`);
  }
  return entry.notice;
};

Deno.test("cross-space notice distinguishes same native ID without a grant or false opener", async () => {
  const f = await fixture();
  const route = await f.bridge.proposed("case", "change");
  equal(route?.status, "human-decision");
  if (!route || !("requester" in route)) {
    throw new Error("missing composite route");
  }
  // The requester names the BO by space; Main receives it under the same
  // native ID through its own designer origin (asserted below).
  equal(route.requester.operatorId, escalation(f.deliveries[0]).recipient);
  equal(route.requester.executionSpaceId, "branch");
  equal(route.openingId, "opening");
  equal(f.snapshot.request.cases![0].openedBy, "human");
  deepStrictEqual(f.deliveries[0].origin, {
    conversationId: "primary-runtime",
    designerScopeId: "main:designer",
  });
  f.snapshot.admission.status = "revoked";
  equal((await f.bridge.proposed("case", "change"))?.status, "human-decision");
  delete f.snapshot.main!.executionModel!.operatorAuthorityPolicies;
  equal((await f.bridge.proposed("case", "change"))?.status, "human-decision");
  (f.snapshot.main!.executionModel as unknown as {
    operatorAuthorityPolicies: unknown;
  }).operatorAuthorityPolicies = "unreadable";
  const unreadable = await f.bridge.proposed("case", "change");
  deepStrictEqual(
    [unreadable.status, unreadable.code],
    ["needs-resolution", "MAIN_POLICY_UNREADABLE"],
  );
});

Deno.test("4.8c A3: a forged opening proof is refused with a code and a log line, never a notice", async () => {
  const mutations: Array<
    [string, (s: RequestSpaceAuthorityBridgeSnapshot) => void]
  > = [
    ["space", (s) => s.space.parentExecutionSpaceId = "other"],
    ["space", (s) => s.space.caseId = "other"],
    ["admission", (s) => s.admission.openingId = "other"],
    [
      "admission-pin",
      (s) => s.admission.permissions.sourceVersion = `commit:${"d".repeat(40)}`,
    ],
    [
      "opening-digest",
      (s) => s.opening.baseDigest = s.admission.baseDigest = "wrong",
    ],
    ["request-owner", (s) => s.request.cases![0].owner = "someone-else"],
    [
      "change-scope",
      (s) => s.request.configuration!.changes[0].requestedBy = "someone-else",
    ],
  ];
  for (const [check, mutate] of mutations) {
    const f = await fixture();
    mutate(f.snapshot);
    const outcome = await f.bridge.proposed("case", "change");
    deepStrictEqual(
      [outcome.status, outcome.code],
      ["needs-resolution", "OPENING_PROOF_MISMATCH"],
      check,
    );
    equal(f.deliveries.length, 0, check);
    deepStrictEqual(f.refusals, [{
      caseId: "case",
      changeId: "change",
      code: "OPENING_PROOF_MISMATCH",
      check,
    }]);
  }
});

Deno.test("4.8c A3: a stale proposal reaches the MO as a coded needs-resolution notice", async () => {
  for (
    const mutate of [
      (change: PendingChange) => change.baseModelDigest = "superseded",
      (change: PendingChange) => change.baseRevision += 1,
    ]
  ) {
    const f = await fixture();
    mutate(f.snapshot.request.configuration!.changes[0]);
    const route = await f.bridge.proposed("case", "change");
    deepStrictEqual(
      [route.status, route.code],
      ["needs-resolution", "CHANGE_STALE"],
    );
    equal(f.deliveries.length, 1);
    const notice = escalation(f.deliveries[0]);
    equal(notice.decisionAuthority, "unresolved");
    equal(notice.route?.code, "CHANGE_STALE");
    equal(notice.route?.reason?.includes("re-propose"), true);
    deepStrictEqual(f.deliveries[0].delivery, { wake: false });
    deepStrictEqual(f.refusals, []);
  }
});

Deno.test("4.8c C7: an unavailable proof or Main is replayed, never routed to the person", async () => {
  const f = await fixture();
  f.unresolvable();
  const unavailable = await f.bridge.proposed("case", "change");
  equal(unavailable.status, "needs-resolution");
  equal(unavailable.code, "OPENING_PROOF_UNAVAILABLE");
  equal("recovery" in unavailable && !!unavailable.recovery, true);
  const g = await fixture();
  const main = g.snapshot.main;
  delete g.snapshot.main;
  const absent = await g.bridge.proposed("case", "change");
  deepStrictEqual(
    [absent.status, absent.code],
    ["needs-resolution", "MAIN_UNAVAILABLE"],
  );
  equal(g.deliveries.length, 0);
  // Main registers: the same request is replayed and reaches it.
  g.snapshot.main = main;
  equal((await g.bridge.proposed("case", "change")).status, "human-decision");
  equal(g.deliveries.length, 1);
  deepStrictEqual(f.refusals, []);
  deepStrictEqual(g.refusals, []);
});

Deno.test("4.8c C7: a Main the person has not yet spoken with is available on its design scope", async () => {
  const f = await fixture();
  delete f.snapshot.main!.designer;
  equal((await f.bridge.proposed("case", "change")).status, "human-decision");
  equal(f.deliveries.length, 1);
  deepStrictEqual(f.deliveries[0].origin, {
    conversationId: "primary-runtime",
    designerScopeId: "primary-runtime:designer",
  });
  // Only a missing model makes Main unavailable.
  delete f.snapshot.main!.executionModel;
  const unavailable = await f.bridge.proposed("case", "change");
  deepStrictEqual(
    [unavailable.status, unavailable.code],
    ["needs-resolution", "MAIN_UNAVAILABLE"],
  );
  equal(f.deliveries.length, 1);
});

Deno.test("4.8c C7: every pending BO request reaches the MO with a notice naming the BO by composite identity", async () => {
  const f = await fixture();
  const change = f.snapshot.request.configuration!.changes[0];
  change.requestedRights = { setUrlSelectionMode: "user-provided" };
  await f.bridge.proposed("case", "change");
  equal(f.deliveries.length, 1, "a non-network BO request is not left silent");
  const notice = escalation(f.deliveries[0]);
  equal(notice.kind, "authority-escalation");
  equal(notice.decisionAuthority, "human");
  equal(notice.changeKind, "mandate-change");
  deepStrictEqual(notice.requestedRights, {
    setUrlSelectionMode: "user-provided",
  });
  equal(notice.route?.version, 2);
  equal(notice.route?.status, "human-decision");
  // Anchored on the admitted model's identity, not the host storage scope.
  const identity = f.snapshot.request.executionModel!.identity;
  deepStrictEqual(notice.route?.requester, {
    projectId: identity.projectId,
    systemId: identity.systemId,
    executionSpaceId: "branch",
    operatorId: "operator",
  });
  deepStrictEqual(f.deliveries[0].delivery, { wake: false });
});

Deno.test("4.8c A8: reviewer and operator creation requests of a BO produce a notice", async () => {
  for (const kind of ["reviewer-creation", "operator-creation"] as const) {
    const f = await fixture();
    f.mandate("branch");
    const change = f.snapshot.request.configuration!.changes[0];
    change.kind = kind;
    delete change.requestedRights;
    const route = await f.bridge.proposed("case", "change");
    equal(route.status, "human-decision", kind);
    equal(f.deliveries.length, 1, kind);
    const notice = escalation(f.deliveries[0]);
    equal(notice.changeKind, kind);
    equal(notice.requestedRights, undefined);
    deepStrictEqual(f.deliveries[0].delivery, { wake: false });
  }
});

Deno.test("4.8c C7: an MO mandate naming this BO designates the MO and wakes it", async () => {
  const f = await fixture();
  f.mandate("branch");
  const route = await f.bridge.proposed("case", "change");
  equal(route.status, "actor-decision");
  deepStrictEqual("designatedDecider" in route && route.designatedDecider, {
    operatorId: "operator",
    executionSpaceId: "main",
    policyId: "bo-network",
    policyRevision: 1,
  });
  equal(f.deliveries.length, 1);
  equal(escalation(f.deliveries[0]).decisionAuthority, "operator");
  deepStrictEqual(f.deliveries[0].delivery, { wake: true });
});

Deno.test("4.8c C7: a mandate naming another BO leaves this request with the person", async () => {
  const f = await fixture();
  f.mandate("other-branch");
  const route = await f.bridge.proposed("case", "change");
  equal(route.status, "human-decision");
  equal(f.deliveries.length, 1);
  equal(escalation(f.deliveries[0]).decisionAuthority, "human");
  deepStrictEqual(f.deliveries[0].delivery, { wake: false });
});

Deno.test("4.8c A3: a route that flips after a revocation notifies the MO again without waking it", async () => {
  const f = await fixture();
  f.mandate("branch");
  await f.bridge.proposed("case", "change");
  f.snapshot.main!.executionModel!.operatorAuthorityPolicies = [];
  await f.bridge.proposed("case", "change");
  equal(f.deliveries.length, 2);
  const [before, after] = f.deliveries.map(escalation);
  equal(before.route?.status, "actor-decision");
  equal(after.route?.status, "human-decision");
  equal(after.decisionAuthority, "human");
  deepStrictEqual(f.deliveries.map((entry) => entry.delivery), [
    { wake: true },
    { wake: false },
  ]);
});

Deno.test("4.8c A3: a version 1 notice already persisted in Main is not re-sent as version 2", async () => {
  const f = await fixture();
  const legacy = {
    kind: "authority-escalation",
    changeId: "change",
    requestedBy: "operator",
    caseId: "case",
    recipient: "operator",
    decisionAuthority: "human",
    reason: "A host is needed",
    route: { version: 1 },
  } as unknown as OperatorNotice;
  f.snapshot.main!.messages.push({
    id: "authority-escalation:change:v1:legacy",
    role: "tool",
    text: "Operator observation",
    at: "2026-10-30T00:00:00Z",
    designerScopeId: "main:designer",
    operatorNotice: legacy,
  });
  equal((await f.bridge.proposed("case", "change")).status, "human-decision");
  equal(f.deliveries.length, 0);
  // A flip is new information, delivered as version 2.
  f.mandate("branch");
  equal((await f.bridge.proposed("case", "change")).status, "actor-decision");
  equal(f.deliveries.length, 1);
  equal(escalation(f.deliveries[0]).route?.version, 2);
});

Deno.test("4.8c A3: closing a BO Request tells the MO through the same port", async () => {
  const f = await fixture();
  const record = f.snapshot.request.cases![0];
  record.status = "closed-done";
  f.snapshot.request.messages.push({
    id: "answer",
    role: "assistant",
    text: "Read and summarized",
    at: "2026-10-31T00:00:00Z",
    caseId: "case",
  });
  await f.bridge.closed("case");
  deepStrictEqual(f.deliveries, [{
    notice: {
      kind: "request-completed",
      caseId: "case",
      owner: "operator",
      openedBy: "human",
      status: "closed-done",
      result: "Read and summarized",
    },
    origin: {
      conversationId: "primary-runtime",
      designerScopeId: "main:designer",
    },
    delivery: { wake: false },
  }]);
  // An open Request is not completed; a forged proof never notifies.
  const g = await fixture();
  await g.bridge.closed("case");
  const h = await fixture();
  h.snapshot.request.cases![0].status = "closed-done";
  h.snapshot.opening.baseDigest = "wrong";
  await h.bridge.closed("case");
  equal(g.deliveries.length + h.deliveries.length, 0);
  equal(h.refusals[0]?.code, "OPENING_PROOF_MISMATCH");
});

Deno.test("4.8c C7: replay routes the pending requests of open Requests once per route", async () => {
  const f = await fixture();
  await f.bridge.replay();
  await f.bridge.replay();
  // The port persists by deterministic notice ID; both deliveries are equal.
  equal(f.deliveries.length, 2);
  deepStrictEqual(f.deliveries[0], f.deliveries[1]);
  f.snapshot.request.configuration!.changes[0].status = "approved";
  await f.bridge.replay();
  equal(f.deliveries.length, 2, "a decided change is not routed again");
});

const mo = (f: Awaited<ReturnType<typeof fixture>>) => {
  const identity = f.snapshot.main!.executionModel!.identity;
  return {
    projectId: identity.projectId,
    systemId: identity.systemId,
    executionSpaceId: "main",
    operatorId: identity.builderId,
  };
};
const command = (f: Awaited<ReturnType<typeof fixture>>) => ({
  kind: "decide_operator_change" as const,
  text: "Approve the covered host",
  operatorId: "operator",
  changeId: "change",
  expectedRevision: f.snapshot.request.configuration!.revision,
  policyId: "bo-network",
  policyRevision: 1,
  verdict: "approve" as const,
});
const origin = { effectKey: "mo-effect" } as unknown as OperatorCommandOrigin;

Deno.test("4.8c C8: pendingFor lists only the requests whose current route designates the decider", async () => {
  const f = await fixture();
  deepStrictEqual(await view_requests(f, mo(f)), [], "no mandate");
  f.mandate("branch");
  const identity = f.snapshot.request.executionModel!.identity;
  deepStrictEqual(await view_requests(f, mo(f)), [{
    id: "change",
    requestedBy: "operator",
    caseId: "case",
    baseRevision: f.snapshot.request.configuration!.revision,
    requestedRights: { addNetworkHosts: ["example.org"] },
    executionSpaceId: "branch",
    requester: {
      projectId: identity.projectId,
      systemId: identity.systemId,
      executionSpaceId: "branch",
      operatorId: "operator",
    },
    changeKind: "mandate-change",
  }]);
  // The BO itself, or MO@main of another identity, is never the decider.
  deepStrictEqual(
    await view_requests(f, { ...mo(f), executionSpaceId: "branch" }),
    [],
  );
  deepStrictEqual(
    await view_requests(f, { ...mo(f), systemId: "other" }),
    [],
  );
  f.mandate("other-branch");
  deepStrictEqual(await view_requests(f, mo(f)), [], "another BO's mandate");
  equal(f.deliveries.length, 0, "reading never delivers a notice");
});

Deno.test("4.8c A6: decide derives the decider and the space from the host, and refuses an uncovered BO", async () => {
  const f = await fixture();
  await rejects(
    () => f.bridge.decide({ caseId: "case", command: command(f), origin }),
    { code: "AUTHORITY_OUT_OF_BOUNDS" },
  );
  f.mandate("other-branch");
  await rejects(
    () => f.bridge.decide({ caseId: "case", command: command(f), origin }),
    { code: "AUTHORITY_OUT_OF_BOUNDS" },
  );
  equal(f.decisions.length, 0, "an uncovered BO request is never decided");
  f.mandate("branch");
  for (
    const mismatch of [
      { policyRevision: 2 },
      { policyId: "another-policy" },
      { expectedRevision: 99 },
      { operatorId: "someone-else" },
      { changeId: "missing" },
    ]
  ) {
    await rejects(
      () =>
        f.bridge.decide({
          caseId: "case",
          command: { ...command(f), ...mismatch },
          origin,
        }),
      { code: "AUTHORITY_OUT_OF_BOUNDS" },
      JSON.stringify(mismatch),
    );
  }
  f.snapshot.opening.baseDigest = f.snapshot.admission.baseDigest = "wrong";
  await rejects(
    () => f.bridge.decide({ caseId: "case", command: command(f), origin }),
    { code: "AUTHORITY_REQUEST_STALE" },
  );
  equal(f.decisions.length, 0);
});

Deno.test("4.8c A6: a covered decision reaches the host-internal capability with the verified route", async () => {
  const f = await fixture();
  f.mandate("branch");
  await f.bridge.decide({ caseId: "case", command: command(f), origin });
  equal(f.decisions.length, 1);
  const [decision] = f.decisions;
  deepStrictEqual(decision.decider, mo(f));
  equal(decision.space.executionSpaceId, "branch");
  equal(decision.route?.status, "actor-decision");
  equal(decision.change.id, "change");
  equal(decision.origin, origin);
  // Once recorded, a replay of the command carries no new route (A4).
  f.snapshot.request.configuration!.changes[0].status = "approved";
  await f.bridge.decide({ caseId: "case", command: command(f), origin });
  equal(f.decisions.length, 2);
  equal(f.decisions[1].route, undefined);
});

const awaitingEntry = (
  f: Awaited<ReturnType<typeof fixture>>,
  status: "human-decision" | "needs-resolution",
) => {
  const identity = f.snapshot.request.executionModel!.identity;
  return {
    id: "change",
    caseId: "case",
    executionSpaceId: "branch",
    requester: {
      projectId: identity.projectId,
      systemId: identity.systemId,
      executionSpaceId: "branch",
      operatorId: "operator",
    },
    changeKind: "mandate-change",
    requestedRights: { addNetworkHosts: ["example.org"] },
    status,
    requestedAt: "",
  };
};

Deno.test("4.8d D2: a request for the person is awaiting the person, never pending for the MO", async () => {
  const f = await fixture();
  deepStrictEqual(await view_awaitingPerson(f, mo(f)), [
    awaitingEntry(f, "human-decision"),
  ]);
  deepStrictEqual(await view_requests(f, mo(f)), []);
  // Only the registered Main reads it.
  deepStrictEqual(
    await view_awaitingPerson(f, { ...mo(f), executionSpaceId: "branch" }),
    [],
  );
  equal(f.deliveries.length, 0, "reading never delivers a notice");
});

Deno.test("4.8d D2: a route flip moves the request between pendingFor and awaitingPerson", async () => {
  const f = await fixture();
  f.mandate("branch");
  equal((await view_requests(f, mo(f))).length, 1);
  deepStrictEqual(await view_awaitingPerson(f, mo(f)), []);
  f.snapshot.main!.executionModel!.operatorAuthorityPolicies = [];
  deepStrictEqual(await view_requests(f, mo(f)), []);
  deepStrictEqual(await view_awaitingPerson(f, mo(f)), [
    awaitingEntry(f, "human-decision"),
  ]);
});

Deno.test("4.8d D2: a stale request awaits the person with its code; a forged proof appears nowhere", async () => {
  const f = await fixture();
  f.snapshot.request.configuration!.changes[0].baseRevision += 1;
  deepStrictEqual(await view_awaitingPerson(f, mo(f)), [{
    ...awaitingEntry(f, "needs-resolution"),
    code: "CHANGE_STALE",
  }]);
  const g = await fixture();
  g.snapshot.opening.baseDigest = g.snapshot.admission.baseDigest = "wrong";
  deepStrictEqual(await view_awaitingPerson(g, mo(g)), []);
  deepStrictEqual(await view_requests(g, mo(g)), []);
  g.mandate("branch");
  deepStrictEqual(await view_requests(g, mo(g)), []);
});

Deno.test("4.8d D3: the MO reads the open branch Requests and who opened them, from verified openings only", async () => {
  const f = await fixture();
  f.snapshot.opening.caseNumber = 7;
  deepStrictEqual(await view_openRequests(f, mo(f)), [{
    caseId: "case",
    caseNumber: 7,
    operatorId: "operator",
    executionSpaceId: "branch",
    status: "open",
    openedBy: "person",
    team: [],
  }]);
  f.snapshot.opening.command = {
    openingKey: "main-key",
    text: "Read the page",
    source: { kind: "current-main" },
    opener: {
      operator: mo(f),
      origin: {
        conversationId: "primary-runtime",
        designerScopeId: "main:designer",
        openingId: "mo-opening",
      },
    },
  };
  equal((await view_openRequests(f, mo(f)))[0].openedBy, "main-operator");
  deepStrictEqual(
    await view_openRequests(f, { ...mo(f), executionSpaceId: "branch" }),
    [],
  );
  f.snapshot.request.cases![0].status = "closed-done";
  deepStrictEqual(await view_openRequests(f, mo(f)), [], "closed");
  const g = await fixture();
  g.snapshot.opening.baseDigest = g.snapshot.admission.baseDigest = "wrong";
  deepStrictEqual(await view_openRequests(g, mo(g)), [], "forged");
});

Deno.test("4.8d D4: a recipient Case resolves to its verified open branch, for the registered Main only", async () => {
  const f = await fixture();
  equal(await f.bridge.recipientSpace(mo(f), "case", ["operator"]), "branch");
  for (
    const [label, decider, caseId, mutate] of [
      ["another decider", { ...mo(f), executionSpaceId: "branch" }, "case"],
      ["unknown Case", mo(f), "case", () => f.unresolvable()],
    ] as const
  ) {
    (mutate as (() => void) | undefined)?.();
    await rejects(
      () => f.bridge.recipientSpace(decider, caseId, ["operator"]),
      {
        code: "INVALID_AUTHORITY_POLICY",
        context: { recipientCaseId: caseId, recipients: ["operator"] },
      },
      label,
    );
  }
  const g = await fixture();
  g.snapshot.request.cases![0].status = "closed-done";
  await rejects(() => g.bridge.recipientSpace(mo(g), "case", ["operator"]), {
    code: "INVALID_AUTHORITY_POLICY",
  });
  const h = await fixture();
  h.snapshot.opening.baseDigest = h.snapshot.admission.baseDigest = "wrong";
  await rejects(() => h.bridge.recipientSpace(mo(h), "case", ["operator"]), {
    code: "INVALID_AUTHORITY_POLICY",
  });
});

Deno.test("4.8d D2: one walk gives each change a single place, and names the MO's recorded decisions", async () => {
  const f = await fixture();
  let walks = 0;
  const counted = new RequestSpaceAuthorityBridge({
    resolve: (caseId) => {
      walks++;
      return Promise.resolve(caseId === "case" ? f.snapshot : null);
    },
    receiveMain: () => Promise.resolve(),
    openCases: () => Promise.resolve(["case"]),
    refused: () => {},
  });
  f.mandate("branch");
  const covered = await counted.mainView(mo(f));
  equal(walks, 1, "one verification per open Case");
  equal(covered.requests.length, 1);
  deepStrictEqual(covered.awaitingPerson, []);
  equal(covered.openRequests.length, 1);
  // Decided by the MO, its record names it for a replay of the command.
  const change = f.snapshot.request.configuration!.changes[0];
  change.status = "approved";
  f.snapshot.request.requestNetworkDecisions = {
    [change.id]: {
      authority: { kind: "delegated", digest: "d".repeat(64), envelope: {} },
    },
  } as unknown as typeof f.snapshot.request.requestNetworkDecisions;
  const decided = await counted.mainView(mo(f));
  deepStrictEqual(decided.recorded, [{ id: change.id, caseId: "case" }]);
  deepStrictEqual(decided.requests, []);
});

Deno.test("4.8e E4: an autonomous team creation waits for its creator's turn to settle, then is decided once", async () => {
  const f = await fixture();
  const change = f.teamProposal();
  // Inside the BO's turn: no notice and no decision; the BO holds its turn.
  await f.bridge.proposed("case", change.id);
  deepStrictEqual(f.deliveries, []);
  deepStrictEqual(f.creations, []);
  // Once the turn settled, the host drives it under the branch-read grant.
  await f.bridge.settled("case");
  deepStrictEqual(f.creations, [{
    changeId: change.id,
    envelope: { kind: "request-creation-grant", changeId: change.id },
  }]);
  deepStrictEqual(f.deliveries, []);
});

Deno.test("4.8e settlement boundary: proposed defers autonomous creation without capturing publication authority", async () => {
  let captures = 0;
  const f = await fixture(undefined, {
    creationGrant: () => ({ change }) => {
      captures++;
      return Promise.resolve({
        kind: "request-creation-grant",
        changeId: change.id,
      } as never);
    },
  });
  const change = f.teamProposal();
  await f.bridge.proposed("case", change.id);
  equal(captures, 0);
  deepStrictEqual(f.deliveries, []);
  deepStrictEqual(f.creations, []);
  await f.bridge.settled("case");
  equal(captures, 1);
  deepStrictEqual(f.creations, [{
    changeId: change.id,
    envelope: { kind: "request-creation-grant", changeId: change.id },
  }]);
  deepStrictEqual(f.deliveries, []);
});

Deno.test("4.8e settlement boundary: strict source capture errors propagate at settlement unchanged", async () => {
  const sourceError = new RequestDelegatedAuthorityError({
    reason: "current source changed",
    path: "sourceHead",
  });
  let captures = 0;
  const f = await fixture(undefined, {
    creationGrant: () => () => {
      captures++;
      return Promise.reject(sourceError);
    },
  });
  const change = f.teamProposal();
  await f.bridge.proposed("case", change.id);
  equal(captures, 0);
  await rejects(() => f.bridge.settled("case"), (error) => {
    equal(error, sourceError);
    equal(sourceError.code, "REQUEST_DELEGATED_AUTHORITY_INVALID");
    return true;
  });
  equal(captures, 1);
  deepStrictEqual(f.creations, []);
  deepStrictEqual(f.deliveries, []);
});

Deno.test("4.8e settlement boundary: an unavailable creation executor preserves the ordinary notice route", async () => {
  const f = await fixture(undefined, { creationGrant: undefined });
  const change = f.teamProposal();
  equal((await f.bridge.proposed("case", change.id)).status, "human-decision");
  equal(f.deliveries.length, 1);
  equal(escalation(f.deliveries[0]).changeId, change.id);
  deepStrictEqual(f.creations, []);
});

Deno.test("4.8e settlement boundary: one verified snapshot reaches the first pending creation without a preceding mutation", async () => {
  let reads = 0;
  const captureReads: number[] = [];
  const f = await fixture(undefined, {
    resolve: () => {
      reads++;
      return Promise.resolve(structuredClone(f.snapshot));
    },
    creationGrant: () => ({ change }) => {
      captureReads.push(reads);
      return Promise.resolve({ changeId: change.id } as never);
    },
  });
  const change = f.teamProposal();
  await f.bridge.settled("case");
  deepStrictEqual(captureReads, [1]);
  deepStrictEqual(f.creations.map((entry) => entry.changeId), [change.id]);
  deepStrictEqual(f.deliveries, []);
});

Deno.test("4.8e settlement boundary: a mutating recovery refreshes the snapshot before the next pending creation", async () => {
  let reads = 0;
  const captures: Array<{ reads: number; digest: string; name?: string }> = [];
  const freshDigest = "f".repeat(64);
  const f = await fixture(undefined, {
    resolve: () => {
      reads++;
      return Promise.resolve(structuredClone(f.snapshot));
    },
    resumeCreation: () => {
      f.snapshot.request.changeDecisionContinuations!["recovered"] = "resumed";
      f.snapshot.request.executionModel!.version.digest = freshDigest;
      f.snapshot.admission.permissions.modelDigests[0] = freshDigest;
      const pending = f.snapshot.request.configuration!.changes[1];
      pending.name = "After recovery";
      pending.baseModelDigest = freshDigest;
      return Promise.resolve();
    },
    creationGrant: () => ({ snapshot, change }) => {
      captures.push({
        reads,
        digest: snapshot.request.executionModel!.version.digest,
        name: change.name,
      });
      return Promise.resolve({ changeId: change.id } as never);
    },
  });
  const pending = f.teamProposal();
  const recovered = {
    ...structuredClone(pending),
    id: "recovered",
    status: "approved" as const,
  };
  f.snapshot.request.configuration!.changes.unshift(recovered);
  f.snapshot.request.requestNetworkDecisions = {
    recovered: { authority: { kind: "creation-grant" } },
  } as unknown as typeof f.snapshot.request.requestNetworkDecisions;
  f.snapshot.request.changeDecisionContinuations = { recovered: "pending" };
  await f.bridge.settled("case");
  deepStrictEqual(captures, [{
    reads: 2,
    digest: freshDigest,
    name: "After recovery",
  }]);
  deepStrictEqual(f.creations.map((entry) => entry.changeId), [pending.id]);
  deepStrictEqual(f.deliveries, []);
});

Deno.test("4.8e settlement boundary: a mutating decision refreshes the snapshot before the next pending creation", async () => {
  let reads = 0;
  const captures: Array<{ reads: number; id: string; digest: string }> = [];
  const decided: string[] = [];
  const freshDigest = "f".repeat(64);
  const f = await fixture(undefined, {
    resolve: () => {
      reads++;
      return Promise.resolve(structuredClone(f.snapshot));
    },
    creationGrant: () => ({ snapshot, change }) => {
      captures.push({
        reads,
        id: change.id,
        digest: snapshot.request.executionModel!.version.digest,
      });
      return Promise.resolve({ changeId: change.id } as never);
    },
    decideCreation: ({ change }) => {
      decided.push(change.id);
      f.snapshot.request.configuration!.changes.find((entry) =>
        entry.id === change.id
      )!.status = "approved";
      f.snapshot.request.executionModel!.version.digest = freshDigest;
      f.snapshot.admission.permissions.modelDigests[0] = freshDigest;
      f.snapshot.request.configuration!.changes[1].baseModelDigest =
        freshDigest;
      return Promise.resolve();
    },
  });
  const first = f.teamProposal();
  const firstDigest = f.snapshot.request.executionModel!.version.digest;
  const second = {
    ...structuredClone(first),
    id: "second-team-change",
    name: "Second helper",
  };
  f.snapshot.request.configuration!.changes.push(second);
  await f.bridge.settled("case");
  deepStrictEqual(captures, [
    { reads: 1, id: first.id, digest: firstDigest },
    { reads: 2, id: second.id, digest: freshDigest },
  ]);
  deepStrictEqual(decided, [first.id, second.id]);
  deepStrictEqual(f.deliveries, []);
});

Deno.test("4.8e E4c: a per-creation team creation routes like any request and is never self-approved", async () => {
  const f = await fixture();
  f.grantIs("per-creation");
  const change = f.teamProposal("per-creation");
  const route = await f.bridge.proposed("case", change.id);
  equal(route.status, "human-decision");
  equal(f.deliveries.length, 1);
  const notice = escalation(f.deliveries[0]);
  equal(notice.changeKind, "operator-creation");
  equal(notice.decisionAuthority, "human");
  await f.bridge.settled("case");
  deepStrictEqual(f.creations, []);
});

Deno.test("4.8e E4: a grant withdrawn before settlement routes the pending creation once per notice identity", async () => {
  const persisted = {
    messages: [],
    events: [],
  } as unknown as SystemRuntimeState;
  // Exercise the runtime's real notice key and persistence predicate with
  // an in-memory mutation port; no copied notice hashing or deduplication.
  const parent = {
    ports: { clock: { now: () => "2026-11-02T00:00:00Z" } },
    update: (
      mutate: (state: SystemRuntimeState) => void,
      predicate?: (state: SystemRuntimeState) => boolean,
    ) => {
      if (!predicate || predicate(persisted)) mutate(persisted);
      return Promise.resolve();
    },
  } as unknown as SystemRuntime;
  const f = await fixture((notice, origin, delivery) =>
    SystemRuntime.prototype.receiveOperatorNotice.call(
      parent,
      notice,
      origin,
      delivery,
    )
  );
  const change = f.teamProposal();
  await f.bridge.proposed("case", change.id);
  equal(f.deliveries.length, 0);
  // The host can no longer build an envelope from the withdrawn grant.
  f.snapshot.request.executionModel!.operatorCreationPolicies![0].enabled =
    false;
  f.grantIs("per-creation");
  await f.bridge.settled("case");
  equal(f.deliveries.length, 1);
  const notice = escalation(f.deliveries[0]);
  equal(notice.changeId, change.id);
  equal(notice.requestedBy, "operator");
  equal(notice.recipient, f.snapshot.main!.executionModel!.identity.builderId);
  equal(notice.decisionAuthority, "human");
  equal(notice.route?.status, "human-decision");
  equal(f.deliveries[0].origin.conversationId, f.snapshot.main!.id);
  equal(f.deliveries[0].delivery.wake, false);
  equal(persisted.messages.length, 1);
  deepStrictEqual(f.creations, []);
  equal(change.status, "pending");
  await f.bridge.replay();
  equal(f.deliveries.length, 2);
  equal(persisted.messages.length, 1);
  deepStrictEqual(f.deliveries[1], f.deliveries[0]);
  await f.bridge.settled("case");
  equal(persisted.messages.length, 1);
});

Deno.test("4.8e E4: settling drives no decided, foreign or non-team change", async () => {
  const f = await fixture();
  const change = f.teamProposal();
  change.status = "approved";
  await f.bridge.settled("case");
  // The network change of the fixture is not a creation either.
  f.snapshot.request.configuration!.changes.push({
    ...structuredClone(change),
    id: "foreign",
    status: "pending",
    caseId: "another-case",
  });
  await f.bridge.settled("case");
  deepStrictEqual(f.creations, []);
});

/** One verified sub-operator of the BO in the branch (spec 4.8e E5). */
function withMember(f: Awaited<ReturnType<typeof fixture>>) {
  const member = structuredClone(f.snapshot.request);
  member.id = "member-runtime";
  member.cases = [];
  const model = member.executionModel!;
  model.identity = {
    ...model.identity,
    builderId: "member",
    systemId: "member-system",
  };
  model.version = { ...model.version, digest: "e".repeat(64) };
  model.operator = { ...model.operator!, name: "Reader" };
  model.operatorTeam = {
    parentOperatorId: "operator",
    requestOwnerId: "operator",
    requestId: "case",
  };
  member.configuration = structuredClone(model.configuration);
  const change = structuredClone(f.snapshot.request.configuration!.changes[0]);
  change.id = "member-change";
  change.requestedBy = "member";
  change.baseRevision = member.configuration.revision;
  change.baseModelDigest = model.version.digest;
  member.configuration.changes = [change];
  f.snapshot.admission.permissions.operatorIds = ["operator", "member"];
  f.snapshot.admission.permissions.modelDigests = [
    f.snapshot.admission.permissions.modelDigests[0],
    model.version.digest,
  ];
  f.snapshot.members = [member];
  return { member, change };
}

Deno.test("4.8e E5: a sub-operator's request routes from its own runtime, among every runtime of the space", async () => {
  const f = await fixture();
  withMember(f);
  const route = await f.bridge.proposed("case", "member-change");
  deepStrictEqual(f.refusals, []);
  if ("code" in route && route.code === "OPENING_PROOF_MISMATCH") {
    throw new Error("A team member is a valid requester");
  }
  const requester =
    (route as { requester?: { operatorId: string; executionSpaceId: string } })
      .requester;
  equal(requester?.operatorId, "member");
  equal(requester?.executionSpaceId, "branch");
  equal(f.deliveries.length, 1);
  equal(escalation(f.deliveries[0]).requestedBy, "member");
});

Deno.test("4.8e E5: a requester outside the admitted team is refused with its check, and no notice", async () => {
  const f = await fixture();
  withMember(f);
  // The member's state is read, but the admission does not name it.
  f.snapshot.admission.permissions.operatorIds = ["operator"];
  f.snapshot.admission.permissions.modelDigests = [
    f.snapshot.admission.permissions.modelDigests[0],
  ];
  const route = await f.bridge.proposed("case", "member-change");
  equal(route.status, "needs-resolution");
  equal((route as { code?: string }).code, "OPENING_PROOF_MISMATCH");
  deepStrictEqual(f.refusals.map((entry) => entry.check), ["team"]);
  deepStrictEqual(f.deliveries, []);
});

Deno.test("4.8e E5: the MO reads each branch Request's team and its sub-operators' requests", async () => {
  const f = await fixture();
  withMember(f);
  const [request] = await view_openRequests(f, mo(f));
  deepStrictEqual(request.team, [{
    operatorId: "member",
    name: "Reader",
    parentOperatorId: "operator",
  }]);
  const waiting = await view_awaitingPerson(f, mo(f));
  deepStrictEqual(waiting.map((entry) => entry.id).sort(), [
    "change",
    "member-change",
  ]);
});

Deno.test("4.8e E4: a recorded creation decision that has not resumed its creator is resumed on settlement", async () => {
  const f = await fixture();
  const change = f.teamProposal();
  change.status = "approved";
  f.snapshot.request.requestNetworkDecisions = {
    [change.id]: {
      openingId: "opening",
      executionSpaceId: "branch",
      caseId: "case",
      commandId: change.id,
      expectedRevision: 1,
      configurationRevision: change.baseRevision,
      proposalIntentDigest: "a".repeat(64),
      verdict: "approve",
      authority: {
        kind: "creation-grant",
        digest: "b".repeat(64),
        envelope: {},
      },
    },
  };
  f.snapshot.request.changeDecisionContinuations = { [change.id]: "pending" };
  await f.bridge.settled("case");
  deepStrictEqual(f.resumed, [change.id]);
  deepStrictEqual(f.creations, []);
  // Once its creator resumed, the decision is settled for good.
  f.snapshot.request.changeDecisionContinuations = { [change.id]: "resumed" };
  await f.bridge.settled("case");
  deepStrictEqual(f.resumed, [change.id]);
});

function memberWork(f: Awaited<ReturnType<typeof fixture>>) {
  const { member, change } = withMember(f);
  member.executionModel!.ownerAuthority!.systemId =
    member.executionModel!.identity.systemId;
  const work = {
    callerId: "operator",
    correlationId: "member-work",
    invocationId: "member-work",
    behaviorId: "member-inbox",
    targetNativeId: "member-inbox",
    modelVersion: {
      digest: f.snapshot.request.executionModel!.version.digest,
      repositoryVersion: f.snapshot.request.executionModel!.version
        .repositoryVersion!,
    },
    fingerprint: "member-work",
    priorCandidateIds: [],
    caseId: "case",
    caseContext: {
      caseId: "case",
      record: structuredClone(f.snapshot.request.cases![0]),
      modelPin: f.snapshot.request.cases![0].modelPin!,
    },
  };
  member.messages.push({
    id: "member-input",
    role: "user",
    text: "Read",
    at: "2026-11-02T00:00:00Z",
    caseId: "case",
    work: work,
  });
  member.changeWorkContinuations = {
    [change.id]: {
      inputMessageId: "member-input",
      invocationKey: invocationKey({ kind: "delegated", work }),
    },
  };
  return { member, change };
}

Deno.test("4.8e member decision selects the verified requester and its model identity", async () => {
  const f = await fixture();
  const { member, change } = memberWork(f);
  f.mandate("branch");
  f.snapshot.main!.executionModel!.operatorAuthorityPolicies![0].recipients = [
    "member",
  ];
  const route = await f.bridge.proposed("case", change.id);
  equal(route.status, "actor-decision", JSON.stringify(route));
  if (!("requester" in route)) throw new Error("No requester");
  equal(route.requester.systemId, member.executionModel!.identity.systemId);
  await f.bridge.decide({
    caseId: "case",
    command: {
      ...command(f),
      operatorId: "member",
      changeId: change.id,
      expectedRevision: change.baseRevision,
    },
    origin,
  });
  equal(f.decisions.length, 1);
  equal(f.decisions[0].change.requestedBy, "member");
});

Deno.test("4.8e settlement and authority replay include a member's own changes", async () => {
  const f = await fixture();
  const { member, change } = memberWork(f);
  const creation = f.teamProposal();
  member.configuration!.changes = [{
    ...creation,
    id: change.id,
    requestedBy: "member",
    baseModelDigest: member.executionModel!.version.digest,
  }];
  f.snapshot.request.configuration!.changes = [];
  await f.bridge.settled("case");
  deepStrictEqual(f.creations.map((entry) => entry.changeId), [change.id]);
  f.grantIs("per-creation");
  await f.bridge.replay();
  equal(escalation(f.deliveries[0]).requestedBy, "member");
});

Deno.test("4.8e E5b the explicit BO policy wakes only the BO and admits only its exact decision", async () => {
  const f = await fixture();
  const { change } = memberWork(f);
  f.mandate("branch");
  const policy = structuredClone(
    f.snapshot.main!.executionModel!.operatorAuthorityPolicies![0],
  );
  policy.recipients = ["member"];
  f.snapshot.request.executionModel!.operatorAuthorityPolicies = [policy];
  const route = await f.bridge.proposed("case", change.id);
  equal(route.status, "actor-decision");
  equal(f.deliveries.length, 0);
  equal(f.branchDeliveries.length, 1);
  deepStrictEqual(f.branchDeliveries[0].origin, {
    conversationId: f.snapshot.request.id,
    caseId: "case",
  });
  equal(f.branchDeliveries[0].delivery.wake, true);
  const context = await f.bridge.branchView("case");
  deepStrictEqual(context.requests.map((entry) => entry.id), [change.id]);
  await f.bridge.decideInBranch({
    caseId: "case",
    command: {
      ...command(f),
      operatorId: "member",
      changeId: change.id,
      expectedRevision: change.baseRevision,
    },
    origin,
  });
  equal(f.decisions[0].decider.executionSpaceId, "branch");
  const input = f.decisions[0];
  const facts = {
    opening: input.snapshot.opening,
    admission: input.snapshot.admission,
    request: input.requester,
    space: input.space,
    main: input.snapshot.main,
    states: [input.snapshot.request, ...input.snapshot.members ?? []],
    change: input.change,
  };
  const envelope = buildRequestDelegatedAuthority({
    ...facts,
    route: input.route!,
    destination: f.destination,
    origin: { ...origin, inputMessageId: "notice" },
    capturedAt: "2026-11-02T00:00:00Z",
  });
  equal(envelope.decider.executionSpaceId, "branch");
  equal(envelope.requester.operatorId, "member");
  assertRequestDelegatedAuthorityCurrent(envelope, facts);

  policy.enabled = false;
  throws(() => assertRequestDelegatedAuthorityCurrent(envelope, facts));
  await rejects(() =>
    f.bridge.decideInBranch({
      caseId: "case",
      command: {
        ...command(f),
        operatorId: "member",
        changeId: change.id,
        expectedRevision: change.baseRevision,
      },
      origin,
    })
  );
  await f.bridge.proposed("case", change.id);
  equal(f.deliveries.length, 1);
  equal(f.deliveries[0].delivery.wake, false);
});

Deno.test("member routing never treats an incomplete admitted team as absence of authority", async () => {
  const f = await fixture();
  memberWork(f);
  f.snapshot.members = [];
  const routed = await f.bridge.proposed("case", "change");
  equal(routed.status, "needs-resolution");
  equal(routed.code, "OPENING_PROOF_MISMATCH");
  equal(f.deliveries.length, 0);
});

Deno.test("4.8e recovery reserves decided creations and resumes members before new BO decisions", async () => {
  const f = await fixture();
  const { member, change } = memberWork(f);
  const pending = f.teamProposal();
  member.configuration!.changes = [{
    ...structuredClone(pending),
    id: change.id,
    requestedBy: "member",
    baseModelDigest: member.executionModel!.version.digest,
    status: "approved",
  }];
  member.requestNetworkDecisions = {
    [change.id]: {
      openingId: "opening",
      executionSpaceId: "branch",
      caseId: "case",
      commandId: change.id,
      expectedRevision: 1,
      configurationRevision: 1,
      proposalIntentDigest: "a".repeat(64),
      verdict: "approve",
      authority: {
        kind: "creation-grant",
        digest: "b".repeat(64),
        envelope: {},
      },
    },
  };
  member.changeDecisionContinuations = { [change.id]: "pending" };
  const second = structuredClone(member);
  second.id = "second-runtime";
  second.executionModel!.identity.builderId = "second";
  second.configuration!.changes = [];
  delete second.requestNetworkDecisions;
  f.snapshot.members!.push(second);
  f.snapshot.admission.permissions.operatorIds.push("second");
  f.snapshot.admission.permissions.modelDigests.push(
    second.executionModel!.version.digest,
  );
  await f.bridge.settled("case");
  deepStrictEqual(f.settlementOrder, [`resume:${change.id}`]);
  deepStrictEqual(f.teamSizes, [3]);
  deepStrictEqual(f.creations, []);
  equal(f.deliveries.length, 1);
  equal(escalation(f.deliveries[0]).changeId, pending.id);
  equal(escalation(f.deliveries[0]).decisionAuthority, "human");
});

Deno.test("4.8e D4: Main may name a member of the recipient Case's verified admission", async () => {
  const f = await fixture();
  withMember(f);
  equal(await f.bridge.recipientSpace(mo(f), "case", ["member"]), "branch");
});

Deno.test("4.8e D4: unknown or unverified recipients are refused with the recipient and Case", async () => {
  const f = await fixture();
  const { member } = withMember(f);
  await rejects(() => f.bridge.recipientSpace(mo(f), "case", ["unknown"]), {
    code: "INVALID_AUTHORITY_POLICY",
    context: { recipientCaseId: "case", recipient: "unknown" },
    recovery: { action: "refuse-and-repropose" },
  });
  member.executionModel!.version.digest = "unverified";
  await rejects(() => f.bridge.recipientSpace(mo(f), "case", ["member"]), {
    code: "INVALID_AUTHORITY_POLICY",
    context: { recipientCaseId: "case", recipients: ["member"] },
    recovery: { action: "refuse-and-repropose" },
  });
});

Deno.test("workspace Main contexts share a revision walk and exclude another runtime with the same native ID", async () => {
  const { main } = (await branchAuthorityFixture()).snapshot;
  const primary = { snapshot: main! } as SystemRuntime;
  const other = { snapshot: structuredClone(main!) } as SystemRuntime;
  let walks = 0;
  const view = {
    requests: [],
    awaitingPerson: [],
    openRequests: [],
    recorded: [],
  };
  const reads = createWorkspaceBranchReads({
    primary,
    runtimes: new Map(),
    bridge: {
      mainView: () => {
        walks++;
        return Promise.resolve(view);
      },
    },
    authorityRoute: () => {
      throw new Error("No local changes");
    },
  });
  equal(reads.branchView(primary), reads.branchView(primary));
  await reads.awaitingPersonContext(primary);
  equal(walks, 1);
  main!.revision++;
  await reads.branchView(primary);
  equal(walks, 2);
  deepStrictEqual(await reads.branchView(other), view);
  equal(reads.branchDecider(other), undefined);
  equal(walks, 2);
});

Deno.test("workspace Main context evicts a rejected branch walk", async () => {
  const { main } = (await branchAuthorityFixture()).snapshot;
  const primary = { snapshot: main! } as SystemRuntime;
  let walks = 0;
  const reads = createWorkspaceBranchReads({
    primary,
    runtimes: new Map(),
    bridge: {
      mainView: () => {
        walks++;
        return walks === 1
          ? Promise.reject(new Error("temporarily unavailable"))
          : Promise.resolve({
            requests: [],
            awaitingPerson: [],
            openRequests: [],
            recorded: [],
          });
      },
    },
    authorityRoute: () => {
      throw new Error("No local changes");
    },
  });
  await rejects(reads.branchView(primary), /temporarily unavailable/);
  await reads.branchView(primary);
  equal(walks, 2);
});

Deno.test("4.8d D2: requests awaiting the person are newest first, bounded and flagged when truncated", () => {
  const entry = (id: string, requestedAt: string) => ({
    id,
    caseId: `case-${id}`,
    requestedAt,
  });
  const many = Array.from(
    { length: MAX_AWAITING_PERSON + 2 },
    (_, index) =>
      entry(`r${index}`, `2026-10-31T00:00:${String(index).padStart(2, "0")}Z`),
  );
  const view = awaitingPersonView(many);
  deepStrictEqual(view.awaitingPersonTruncated, true);
  deepStrictEqual(view.awaitingPerson.length, MAX_AWAITING_PERSON);
  deepStrictEqual(view.awaitingPerson[0], {
    id: `r${MAX_AWAITING_PERSON + 1}`,
    caseId: `case-r${MAX_AWAITING_PERSON + 1}`,
  });
  // Same instant: the identity breaks the tie, so the order is deterministic.
  deepStrictEqual(
    awaitingPersonView([entry("b", "t"), entry("a", "t")]),
    {
      awaitingPerson: [
        { id: "a", caseId: "case-a" },
        { id: "b", caseId: "case-b" },
      ],
      awaitingPersonTruncated: false,
    },
  );
});
