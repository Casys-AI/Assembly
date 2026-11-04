import { deepStrictEqual, equal } from "node:assert/strict";
import { executableFixture } from "../../../test/support/execution-fixture.ts";
import {
  legacyOwnerAuthority,
  mainExecutionSpace,
} from "../../domain/governance/authority.ts";
import type { Case } from "../../domain/work/entities/cases.ts";
import type {
  CaseInvocation,
  OperatorWorkReceipt,
} from "../../domain/work/execution/case-context.ts";
import type {
  PendingChange,
} from "../../domain/governance/records/pending-change.ts";
import type { SystemRuntimeState } from "../work/runtime/state.ts";
import { invocationKey } from "../work/operators/journal.ts";
import {
  deliverRequestAuthorityRoute,
  requestAuthorityRoute,
} from "./request-authority-routing.ts";
import { type OperatorNotice } from "../../domain/governance/operator-authority.ts";
import { type ExecutionSpaceRef } from "../../domain/governance/authority.ts";
import { SystemRuntime } from "../../../test/support/system-runtime.ts";
import type { ModelPort } from "../work/runtime/ports.ts";

function fixture() {
  const states = ["main", "owner", "middle", "leaf"].map(
    (id): SystemRuntimeState => {
      const model = executableFixture({
        projectId: "unit",
        editingContextId: "unit",
        rootId: "root",
        systemId: id,
        catalogId: `${id}-catalog`,
        builderId: id,
      });
      model.version.repositoryVersion = "admitted-fixture";
      model.ownerAuthority = {
        ...legacyOwnerAuthority(id),
        ownerSource: "modeled",
      };
      return {
        id: `${id}-session`,
        revision: 0,
        catalogRevision: 0,
        messages: [],
        candidates: [],
        events: [],
        busy: false,
        phase: "Ready",
        provider: "fixture",
        model: model.identity,
        executionModel: model,
        configuration: structuredClone(model.configuration),
      };
    },
  );
  const [main, owner, middle, leaf] = states;
  main.designer = { scopeId: "main-designer" };
  main.caseInvocation = { kind: "designer", scopeId: "main-designer" };
  const root: Case = {
    id: "request",
    number: 1,
    type: "request",
    objective: "Research",
    owner: "owner",
    openedBy: "main",
    openedFrom: {
      conversationId: main.id,
      designerScopeId: "main-designer",
      openingId: "open-1",
    },
    modelPin: { digest: owner.executionModel!.version.digest },
    status: "open",
    createdAt: "2026-10-27T00:00:00Z",
  };
  owner.cases = [root];
  owner.caseInvocation = { kind: "local", caseId: root.id };
  owner.messages.push({
    id: "owner-input",
    role: "user",
    caseId: root.id,
    text: "Research",
    at: root.createdAt,
  });
  const receipt = (
    callerId: string,
    id: string,
    parent: SystemRuntimeState,
    invocation: CaseInvocation,
    inputMessageId: string,
  ): OperatorWorkReceipt => ({
    callerId,
    correlationId: id,
    invocationId: id,
    behaviorId: `behavior-${id}`,
    targetNativeId: `inbox-${id}`,
    modelVersion: { digest: "version", repositoryVersion: "commit" },
    fingerprint: id,
    priorCandidateIds: [],
    caseId: root.id,
    caseContext: {
      caseId: root.id,
      record: structuredClone(root),
      modelPin: root.modelPin,
    },
    parentInvocation: {
      operatorId: parent.executionModel!.identity.builderId,
      invocationKey: invocationKey(invocation),
      inputMessageId,
    },
  });
  const middleWork = receipt("owner", "middle-work", owner, {
    kind: "local",
    caseId: root.id,
  }, "owner-input");
  const middleInvocation: CaseInvocation = {
    kind: "delegated",
    work: { ...middleWork, caseContext: middleWork.caseContext! },
  };
  middle.caseInvocation = middleInvocation;
  middle.messages.push({
    id: "middle-input",
    role: "user",
    caseId: root.id,
    text: "Analyze",
    at: root.createdAt,
    work: middleWork,
  });
  const leafWork = receipt(
    "middle",
    "leaf-work",
    middle,
    middleInvocation,
    "middle-input",
  );
  const leafInvocation: CaseInvocation = {
    kind: "delegated",
    work: { ...leafWork, caseContext: leafWork.caseContext! },
  };
  leaf.caseInvocation = leafInvocation;
  leaf.messages.push({
    id: "leaf-input",
    role: "user",
    caseId: root.id,
    text: "Fetch",
    at: root.createdAt,
    work: leafWork,
  });
  leaf.changeWorkContinuations = {
    change: {
      inputMessageId: "leaf-input",
      invocationKey: invocationKey(leafInvocation),
    },
  };
  const change: PendingChange = {
    id: "change",
    requestedBy: "leaf",
    caseId: root.id,
    kind: "mandate-change",
    status: "pending",
    baseRevision: leaf.configuration!.revision,
    baseModelDigest: leaf.executionModel!.version.digest,
    requestedAt: root.createdAt,
    reason: "Fetch source",
    requestedRights: { addNetworkHosts: ["example.org"] },
  };
  leaf.configuration!.changes.push(change);
  const grant = (actorId: string) => {
    leaf.executionModel!.operatorAuthorityPolicies = [{
      id: `network-${actorId}`,
      revision: 1,
      elementId: "policy",
      sourceIds: ["policy"],
      rootAuthority: structuredClone(leaf.executionModel!.ownerAuthority),
      holderNativeId: actorId,
      mandateNativeId: `${actorId}-mandate`,
      systemId: "leaf",
      enabled: true,
      recipients: ["leaf"],
      acts: ["addNetworkHosts"],
      networkHosts: ["example.org"],
      toolIds: [],
      maxDelegationDepth: 0,
    }];
  };
  const space = mainExecutionSpace(leaf.executionModel!.identity);
  const route = () =>
    requestAuthorityRoute({
      space,
      requester: leaf,
      change,
      states,
      root: { kind: "main-opener", mainOperatorId: "main" },
    });
  return {
    states,
    main,
    owner,
    middle,
    leaf,
    root,
    change,
    grant,
    route,
    space,
    leafWork,
    middleWork,
  };
}

Deno.test("Request authority routing traverses verified parents deterministically to covered Main", () => {
  const f = fixture();
  f.grant("main");
  const route = f.route();
  equal(route.status, "actor-decision");
  equal(route.responsibleOperatorId, "middle");
  equal(route.designatedDecider?.operatorId, "main");
  deepStrictEqual(
    route.trace.map((step) => [step.operatorId, step.eligibility]),
    [["middle", "not-covered"], ["owner", "not-covered"], ["main", "eligible"]],
  );
  equal(f.change.status, "pending");
});
Deno.test("First competent responsible actor stops routing even when busy; no automatic decision", () => {
  const f = fixture();
  f.grant("middle");
  f.middle.busy = true;
  const route = f.route();
  equal(route.designatedDecider?.operatorId, "middle");
  equal(route.trace.length, 1);
  equal(f.change.status, "pending");
  f.change.status = "refused";
  equal(f.route().designatedDecider, undefined);
});
Deno.test("Human fallback requires a complete verified chain with no covering grant", () => {
  const f = fixture();
  equal(f.route().status, "human-decision");
  delete f.leafWork.parentInvocation;
  equal(f.route().status, "needs-resolution");
});
Deno.test("Routing rejects cross-Request anchors and caller cycles without false human fallback", () => {
  const f = fixture();
  f.grant("main");
  f.middle.messages[0].caseId = "other-request";
  equal(f.route().status, "needs-resolution");
  f.middle.messages[0].caseId = f.root.id;
  f.middleWork.callerId = "leaf";
  f.leafWork.parentInvocation!.invocationKey = invocationKey({
    kind: "delegated",
    work: { ...f.middleWork, caseContext: f.middleWork.caseContext! },
  });
  equal(f.route().status, "needs-resolution");
});
Deno.test("Revoked or out-of-scope policies never designate an actor; stale models require resolution", () => {
  const f = fixture();
  f.grant("main");
  f.leaf.executionModel!.operatorAuthorityPolicies![0].enabled = false;
  equal(f.route().status, "human-decision");
  f.leaf.executionModel!.operatorAuthorityPolicies![0].enabled = true;
  f.change.requestedRights = { addNetworkHosts: ["outside.org"] };
  equal(f.route().status, "human-decision");
  f.change.baseModelDigest = "superseded";
  equal(f.route().status, "needs-resolution");
});
Deno.test("Source team membership corroborates receipt and grants no inferred authority", () => {
  const f = fixture();
  f.grant("main");
  f.leaf.executionModel!.operatorTeam = {
    parentOperatorId: "other",
    requestId: f.root.id,
    requestOwnerId: f.root.owner,
  };
  equal(f.route().status, "needs-resolution");
});

Deno.test("Main refuses foreign Request membership along delegated and direct owner routes", () => {
  for (
    const member of ["leaf", "middle", "owner", "direct", "decider"] as const
  ) {
    const f = fixture();
    f.grant(member === "decider" ? "middle" : "main");
    const direct = member === "direct";
    const requester = direct ? f.owner : f.leaf;
    const foreign = direct
      ? f.owner
      : member === "decider"
      ? f.middle
      : f[member];
    foreign.executionModel!.operatorTeam = {
      parentOperatorId: member === "leaf"
        ? "middle"
        : member === "middle" || member === "decider"
        ? "owner"
        : "main",
      requestOwnerId: f.root.owner,
      requestId: "another-request",
    };
    const change = direct
      ? {
        ...f.change,
        requestedBy: f.root.owner,
        baseRevision: requester.configuration!.revision,
        baseModelDigest: requester.executionModel!.version.digest,
      }
      : f.change;
    const route = requestAuthorityRoute({
      space: f.space,
      requester,
      change,
      states: f.states,
      root: { kind: "main-opener", mainOperatorId: "main" },
    });
    equal(route.code, "CHAIN_UNVERIFIED");
    equal(route.status, "needs-resolution");
    equal(route.designatedDecider, undefined);
  }
});

Deno.test("Legacy direct caller receipt can reach its unique Request owner and verified Main opening", () => {
  const f = fixture();
  f.grant("main");
  f.leafWork.callerId = "owner";
  delete f.leafWork.parentInvocation;
  f.leaf.changeWorkContinuations!.change.invocationKey = invocationKey({
    kind: "delegated",
    work: { ...f.leafWork, caseContext: f.leafWork.caseContext! },
  });
  equal(f.route().designatedDecider?.operatorId, "main");
  deepStrictEqual(f.route().trace.map((step) => step.operatorId), [
    "owner",
    "main",
  ]);
});

Deno.test("Verified local host objective tool input anchors the Request owner without impersonating a human", () => {
  const f = fixture();
  f.grant("main");
  const input = f.owner.messages[0];
  input.id = `${f.root.id}:objective`;
  input.role = "tool";
  input.text = f.root.objective;
  f.middleWork.parentInvocation!.inputMessageId = input.id;
  equal(f.route().designatedDecider?.operatorId, "main");
  input.text = "unverified tool content";
  equal(f.route().status, "needs-resolution");
});

Deno.test("Nested authority delivery journals every checked responsible, restarts idempotently, and starts zero provider turns", async () => {
  const f = fixture();
  f.grant("main");
  let agentCalls = 0;
  const saved = new Map(
    f.states.map((
      state,
    ) => [state.executionModel!.identity.builderId, structuredClone(state)]),
  );
  const runtimes = new Map<string, SystemRuntime>();
  const open = async () => {
    for (const [operatorId, snapshot] of saved) {
      const model = snapshot.executionModel!;
      const runtime = new SystemRuntime({
        model: {
          initialize: () => Promise.resolve(structuredClone(model.identity)),
          readExecutableModel: () => Promise.resolve(structuredClone(model)),
          findApprovedChange: () => Promise.resolve(null),
          applyApprovedChange: () => {
            throw new Error("No source effect expected");
          },
        } as unknown as ModelPort,
        store: {
          load: () => Promise.resolve(structuredClone(saved.get(operatorId)!)),
          save: (state) => {
            saved.set(operatorId, structuredClone(state));
            return Promise.resolve();
          },
          close: () => Promise.resolve(),
        },
        agents: {
          label: "no-routing-provider",
          decide: () => {
            agentCalls++;
            throw new Error("Routing must not start an operator turn");
          },
          review: () => {
            agentCalls++;
            throw new Error("Routing must not review");
          },
        },
        runner: {
          run: () => {
            throw new Error("No tool effect expected");
          },
          test: () => {
            throw new Error("No tool test expected");
          },
        },
      });
      await runtime.initialize(model, { resumeCandidateContinuations: false });
      runtimes.set(operatorId, runtime);
    }
  };
  const deliver = () =>
    deliverRequestAuthorityRoute({
      space: f.space,
      requester: runtimes.get("leaf")!.snapshot,
      change: f.change,
      states: [...runtimes.values()].map((runtime) => runtime.snapshot),
      mainOperatorId: "main",
      receive: (operatorId, notice, origin) =>
        runtimes.get(operatorId)!.receiveOperatorNotice(notice, origin),
    });
  await open();
  equal((await deliver()).status, "actor-decision");
  for (const operatorId of ["middle", "owner", "main"]) {
    const notices = runtimes.get(operatorId)!.snapshot.messages.filter((
      message,
    ) => message.operatorNotice?.kind === "authority-escalation");
    equal(notices.length, 1, `${operatorId} receives its trace`);
    equal(notices[0].caseId, operatorId === "main" ? undefined : f.root.id);
    if (operatorId === "main") {
      equal(notices[0].designerScopeId, "main-designer");
    }
  }
  equal(
    runtimes.get("leaf")!.snapshot.messages.filter((message) =>
      message.operatorNotice
    ).length,
    0,
  );
  runtimes.clear();
  await open();
  await deliver();
  for (const operatorId of ["middle", "owner", "main"]) {
    equal(
      runtimes.get(operatorId)!.snapshot.messages.filter((message) =>
        message.operatorNotice?.kind === "authority-escalation"
      ).length,
      1,
      `${operatorId} deduplicates after restart`,
    );
  }
  equal(agentCalls, 0);
  equal(f.change.status, "pending");
});

Deno.test("A competent lower actor receives its delivery without notifying Main", async () => {
  const f = fixture();
  f.grant("middle");
  const delivered: string[] = [];
  await deliverRequestAuthorityRoute({
    space: f.space,
    requester: f.leaf,
    change: f.change,
    states: f.states,
    mainOperatorId: "main",
    receive: (operatorId) => {
      delivered.push(operatorId);
      return Promise.resolve();
    },
  });
  deepStrictEqual(delivered, ["middle"]);
});

Deno.test("A Main designated by a main-space route is woken in its design conversation, nobody else", async () => {
  const f = fixture();
  f.grant("main");
  const delivered: Array<[string, Case["openedFrom"], { wake: boolean }]> = [];
  await deliverRequestAuthorityRoute({
    space: f.space,
    requester: f.leaf,
    change: f.change,
    states: f.states,
    mainOperatorId: "main",
    receive: (operatorId, _notice, origin, delivery) => {
      delivered.push([operatorId, origin, delivery]);
      return Promise.resolve();
    },
  });
  deepStrictEqual(
    delivered.map(([operatorId, , delivery]) => [operatorId, delivery.wake]),
    [["middle", false], ["owner", false], ["main", true]],
  );
  deepStrictEqual(delivered.at(-1)![1], {
    conversationId: "main-session",
    designerScopeId: "main-designer",
  });
  // A lower designated actor decides in its own turn; Main is not woken.
  const lower = fixture();
  lower.grant("middle");
  const woken: string[] = [];
  await deliverRequestAuthorityRoute({
    space: lower.space,
    requester: lower.leaf,
    change: lower.change,
    states: lower.states,
    mainOperatorId: "main",
    receive: (operatorId, _notice, _origin, delivery) => {
      if (delivery.wake) woken.push(operatorId);
      return Promise.resolve();
    },
  });
  deepStrictEqual(woken, []);
});

// ---------------------------------------------------------------------------
// Spec 4.8c, contracts C5/C6: segmented routes across a verified opening.
// ---------------------------------------------------------------------------
/** The branch fixture's models share the MO/BO system identity. */
const segmentHost = { projectId: "unit", systemId: "system" };
const inSpace = (executionSpaceId: string): ExecutionSpaceRef => ({
  ...segmentHost,
  executionSpaceId,
});

/** A Request opened from the interface: its BO carries the MO native ID and
 * its Case is opened by the person, not by the MO. */
function branchFixture(mandateSpace?: string) {
  const state = (id: string, digest: string): SystemRuntimeState => {
    const model = executableFixture({
      projectId: "unit",
      editingContextId: id,
      rootId: "root",
      systemId: "system",
      catalogId: "catalog",
      builderId: "operator",
    });
    model.version.digest = digest;
    model.version.repositoryVersion = `commit:${digest.slice(0, 40)}`;
    model.ownerAuthority = {
      ...legacyOwnerAuthority("system"),
      ownerSource: "modeled",
    };
    return {
      id,
      revision: 0,
      catalogRevision: 0,
      messages: [],
      candidates: [],
      events: [],
      busy: false,
      phase: "Ready",
      provider: "fixture",
      model: model.identity,
      executionModel: model,
      configuration: structuredClone(model.configuration),
    };
  };
  const policy = (
    id: string,
    recipients: string[],
    recipientExecutionSpaceId: string,
    owner: SystemRuntimeState,
  ) => ({
    id,
    revision: 1,
    elementId: `${id}-native`,
    sourceIds: [`${id}-native`],
    rootAuthority: structuredClone(owner.executionModel!.ownerAuthority!),
    holderNativeId: "operator",
    mandateNativeId: "operator-mandate",
    systemId: "system",
    enabled: true,
    recipients,
    recipientExecutionSpaceId,
    acts: ["addNetworkHosts"] as ["addNetworkHosts"],
    networkHosts: ["example.org"],
    toolIds: [] as [],
    maxDelegationDepth: 0 as const,
  });
  const main = state("main-runtime", "a".repeat(64));
  main.designer = { scopeId: "main-designer" };
  if (mandateSpace) {
    const mandate = policy("bo-network", ["operator"], mandateSpace, main);
    main.executionModel!.operatorAuthorityPolicies = [mandate];
  }
  const bo = state("branch-runtime", "b".repeat(64));
  // Release copy of a legacy main policy naming the holder's native ID: the
  // compiler refuses it in main, but a copy must stay inert regardless.
  const copied = policy("main-network", ["operator"], "main", bo);
  bo.executionModel!.operatorAuthorityPolicies = [copied];
  const root: Case = {
    id: "branch-request",
    number: 7,
    type: "request",
    objective: "Read a page",
    owner: "operator",
    openedBy: "human-owner",
    openedFrom: { conversationId: bo.id, openingId: "opening-x" },
    modelPin: { digest: bo.executionModel!.version.digest },
    status: "open",
    createdAt: "2026-10-31T00:00:00Z",
  };
  bo.cases = [root];
  bo.caseInvocation = { kind: "local", caseId: root.id };
  const change: PendingChange = {
    id: "branch-change",
    requestedBy: "operator",
    caseId: root.id,
    kind: "mandate-change",
    status: "pending",
    baseRevision: bo.configuration!.revision,
    baseModelDigest: bo.executionModel!.version.digest,
    requestedAt: root.createdAt,
    reason: "Read the selected page",
    requestedRights: { addNetworkHosts: ["example.org"] },
  };
  bo.configuration!.changes.push(change);
  const route = () =>
    requestAuthorityRoute({
      space: inSpace("case-x"),
      requester: bo,
      change,
      states: [bo],
      root: {
        kind: "verified-opening",
        openingId: "opening-x",
        parent: { space: inSpace("main"), state: main },
      },
    });
  return { main, bo, root, change, route };
}

Deno.test("4.8c C6: a BO request crosses the verified opening to an MO whose mandate names this BO", () => {
  const route = branchFixture("case-x").route();
  equal(route.status, "actor-decision");
  equal(route.version, 2);
  deepStrictEqual(route.requester, {
    ...segmentHost,
    executionSpaceId: "case-x",
    operatorId: "operator",
  });
  equal(route.openingId, "opening-x");
  deepStrictEqual(route.designatedDecider, {
    operatorId: "operator",
    executionSpaceId: "main",
    policyId: "bo-network",
    policyRevision: 1,
  });
  deepStrictEqual(route.trace, [{
    operatorId: "operator",
    executionSpaceId: "main",
    eligibility: "eligible",
    policyId: "bo-network",
    policyRevision: 1,
  }]);
});

Deno.test("4.8c C6: without a mandate naming this BO the route ends with the person, never at a copied policy", () => {
  for (const mandateSpace of [undefined, "case-y"]) {
    const route = branchFixture(mandateSpace).route();
    equal(
      route.status,
      "human-decision",
      `mandate ${mandateSpace ?? "absent"}: got ${route.status}`,
    );
    equal(route.designatedDecider, undefined);
    deepStrictEqual(route.trace, [{
      operatorId: "operator",
      executionSpaceId: "main",
      eligibility: "not-covered",
    }]);
  }
});

Deno.test("4.8c C6: the main-space path keeps its result under the segmented input", () => {
  const f = fixture();
  f.grant("main");
  // An explicit main space reads like the legacy relative form in main (C2).
  Object.assign(f.leaf.executionModel!.operatorAuthorityPolicies![0], {
    recipientExecutionSpaceId: "main",
  });
  const route = requestAuthorityRoute({
    space: f.space,
    requester: f.leaf,
    change: f.change,
    states: f.states,
    root: { kind: "main-opener", mainOperatorId: "main" },
  });
  equal(route.status, "actor-decision");
  equal(route.designatedDecider?.operatorId, "main");
  equal(route.designatedDecider?.executionSpaceId, "main");
  deepStrictEqual(
    route.trace.map((step) => [step.operatorId, step.executionSpaceId]),
    [["middle", "main"], ["owner", "main"], ["main", "main"]],
  );
});

Deno.test("4.8c C5: a main-space notice names the change kind, rights and composite requester", async () => {
  const f = fixture();
  const notices: OperatorNotice[] = [];
  await deliverRequestAuthorityRoute({
    space: f.space,
    requester: f.leaf,
    change: f.change,
    states: f.states,
    mainOperatorId: "main",
    receive: (_operatorId, notice) => {
      notices.push(notice);
      return Promise.resolve();
    },
  });
  equal(notices.length, 3);
  for (const notice of notices) {
    if (notice.kind !== "authority-escalation") throw new Error(notice.kind);
    equal(notice.changeKind, "mandate-change");
    deepStrictEqual(notice.requestedRights, {
      addNetworkHosts: ["example.org"],
    });
    equal(notice.route?.version, 2);
    deepStrictEqual(notice.route?.requester, {
      ...f.space,
      operatorId: "leaf",
    });
    equal(notice.route?.code, undefined);
  }
});

Deno.test("4.8c C5: an unresolved route carries a closed code", () => {
  const f = fixture();
  f.change.baseModelDigest = "superseded";
  deepStrictEqual(
    [f.route().status, f.route().code],
    ["needs-resolution", "CHANGE_STALE"],
  );
  f.change.status = "refused";
  equal(f.route().code, "CHANGE_NOT_PENDING");
  const g = fixture();
  delete g.leafWork.parentInvocation;
  equal(g.route().code, "CHAIN_UNVERIFIED");
  const branch = branchFixture("case-x");
  delete branch.main.executionModel;
  deepStrictEqual(
    [branch.route().status, branch.route().code],
    ["needs-resolution", "MAIN_UNAVAILABLE"],
  );
  const forged = branchFixture("case-x");
  forged.root.openedFrom.openingId = "another-opening";
  equal(forged.route().code, "CHAIN_UNVERIFIED");
});

Deno.test("4.8e Q7: a Main order crosses directly to Main's scoped authority, never the same-ID BO", () => {
  const f = branchFixture("case-x");
  const member = structuredClone(f.bo);
  member.id = "member-runtime";
  member.executionModel!.identity.builderId = "member";
  member.executionModel!.version.digest = "d".repeat(64);
  member.executionModel!.operatorTeam = {
    parentOperatorId: "operator",
    requestOwnerId: "operator",
    requestId: f.root.id,
  };
  member.cases = [];
  const work: OperatorWorkReceipt = {
    callerId: "operator",
    correlationId: "main-order",
    invocationId: "invoke-main",
    behaviorId: "host-order",
    targetNativeId: "member-inbox",
    modelVersion: {
      digest: "a".repeat(64),
      repositoryVersion: `commit:${"a".repeat(40)}`,
    },
    fingerprint: "main-order",
    priorCandidateIds: [],
    caseId: f.root.id,
    caseContext: {
      caseId: f.root.id,
      record: structuredClone(f.root),
      modelPin: f.root.modelPin,
    },
    mainOrder: {
      openingId: "opening-x",
      caller: {
        ...segmentHost,
        executionSpaceId: "main",
        operatorId: "operator",
      },
    },
  };
  const invocation: CaseInvocation = {
    kind: "delegated",
    work: { ...work, caseContext: work.caseContext! },
  };
  member.caseInvocation = invocation;
  member.messages = [{
    id: "member-input",
    role: "tool",
    text: "Work",
    at: f.root.createdAt,
    caseId: f.root.id,
    work,
  }];
  member.changeWorkContinuations = {
    "member-change": {
      inputMessageId: "member-input",
      invocationKey: invocationKey(invocation),
    },
  };
  const change: PendingChange = {
    ...f.change,
    id: "member-change",
    requestedBy: "member",
    baseRevision: member.configuration!.revision,
    baseModelDigest: member.executionModel!.version.digest,
  };
  member.configuration!.changes = [change];
  f.main.executionModel!.operatorAuthorityPolicies![0].recipients = ["member"];
  // The BO also has an explicit policy, but it did not give this order.
  f.bo.executionModel!.operatorAuthorityPolicies![0].recipients = ["member"];
  f.bo.executionModel!.operatorAuthorityPolicies![0].recipientExecutionSpaceId =
    "case-x";
  const route = (openingId = "opening-x") =>
    requestAuthorityRoute({
      space: inSpace("case-x"),
      requester: member,
      change,
      states: [f.bo, member],
      root: {
        kind: "verified-opening",
        openingId,
        parent: { space: inSpace("main"), state: f.main },
      },
    });
  const result = route();
  equal(result.status, "actor-decision");
  equal(result.designatedDecider?.executionSpaceId, "main");
  equal(result.designatedDecider?.operatorId, "operator");
  deepStrictEqual(result.trace.map((entry) => entry.executionSpaceId), [
    "main",
  ]);
  work.mainOrder!.openingId = "forged";
  equal(route().code, "CHAIN_UNVERIFIED");
});
