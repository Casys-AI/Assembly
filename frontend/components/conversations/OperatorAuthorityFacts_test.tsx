import { settle } from "../../test/support/settle.ts";
import { textOf } from "../../test/support/dom.ts";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
} from "node:assert/strict";
import { Fragment, h, type VNode } from "preact";
import { renderToString } from "preact-render-to-string";
import { act } from "preact/test-utils";
import type {
  AuthorityExercise,
  OwnerAuthority,
} from "../../../src/domain/governance/authority.ts";
import type { PendingChange } from "../../../src/domain/governance/records/pending-change.ts";
import type { SourceRevisions } from "../../lib/model/revisions/api.ts";
import type { ChatProposalApi } from "../../lib/conversations/proposals.ts";
import { modelLive } from "../../lib/model/live.ts";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { snapshot } from "../../test/support/workbench-fixture.ts";
import { grant, operatorRoster } from "../../test/support/operator-fixture.ts";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { press } from "../../test/support/press.ts";
import { ModelChangeCard } from "../model/changes/ModelChangeCard.tsx";
import { decisionState } from "../../lib/conversations/decision-state.ts";
import { chatEntries, ChatTimeline } from "./ChatTimeline.tsx";
import {
  CandidateAuthorityFacts,
  ObservedOperatorAuthority,
  OperatorAuthorityFacts,
} from "./OperatorAuthorityFacts.tsx";
import { delegatedCandidate } from "../../test/support/candidate-admission-fixture.ts";

const MAIN = "native:designer";
const PEER = "native:research";
const DIGEST = "a".repeat(64);
const HEAD = "commit:" + "b".repeat(40);
const CASE = "ui-fixture:case:2";
function owner(systemId: string): OwnerAuthority {
  return {
    ownerSource: "modeled",
    systemId,
    operatorId: "owner",
    operatorNativeId: `${systemId}:human`,
    mandateId: "owner-mandate",
    mandateNativeId: `${systemId}:mandate`,
    mandateRevision: 1,
    rootAuthorityId: "root",
    rootAuthorityNativeId: `${systemId}:root`,
    rootGrantId: "grant",
    rootGrantNativeId: `${systemId}:grant`,
    sourceIds: ["source"],
  };
}
function policyChange(patch: Partial<PendingChange> = {}) {
  return grant({
    baseModelDigest: DIGEST,
    requestedRights: {
      operatorAuthority: {
        policyId: "research-network",
        expectedPolicyRevision: 0,
        enabled: true,
        recipients: [PEER],
        acts: ["addNetworkHosts"],
        networkHosts: ["example.org", "example.net"],
        toolIds: [],
        maxDelegationDepth: 0,
      },
    },
    ...patch,
  });
}
function exercise() {
  const rights = { addNetworkHosts: ["example.org"] };
  const receipt: AuthorityExercise = {
    ...owner("research-system"),
    authoritySchema: 2,
    action: "mandate-change",
    baseModelDigest: DIGEST,
    outOfMandate: false,
    delegation: {
      actorId: MAIN,
      policyId: "research-network",
      policyRevision: 1,
      policyElementId: "policy:1",
      policyIssuer: owner("main-system"),
      requestedBy: PEER,
      changeId: "network-change",
      caseId: CASE,
      requestedRights: rights,
    },
  };
  return grant({
    id: "network-change",
    requestedBy: PEER,
    caseId: CASE,
    requestedRights: rights,
    baseModelDigest: DIGEST,
    status: "approved",
    authority: "builder",
    authorityExercise: receipt,
    decidedAt: "2026-10-26T00:00:00Z",
    publishedCommit: HEAD,
  });
}
function sources(): SourceRevisions {
  return {
    agentId: MAIN,
    version: HEAD,
    sourceDigest: "current-source",
    proposals: [],
    runtime: {
      available: { digest: "current", repositoryVersion: HEAD },
      active: {
        digest: "old-pin",
        repositoryVersion: "commit:" + "c".repeat(40),
      },
      executable: true,
      sourceRights: {
        modelEditPolicy: null,
        modelAdministration: null,
        operatorAuthorityPolicies: [{
          id: "research-network",
          revision: 2,
          enabled: false,
          recipients: [PEER],
          acts: ["addNetworkHosts"],
          networkHosts: ["example.org", "example.net"],
          toolIds: [],
          maxDelegationDepth: 0,
          holderNativeId: MAIN,
          mandateNativeId: "main-mandate",
          systemId: "main-system",
          elementId: "policy:2",
          sourceIds: ["policy:2"],
          rootAuthority: owner("main-system"),
        }],
      },
    },
  };
}
const roster = () => {
  const entries = operatorRoster().conversations;
  entries[0].name = "Main Operator";
  entries[1].name = "Research";
  return entries;
};

Deno.test("tool admission grant cards name operator recipients and tool kinds independently of network decisions", () => {
  const change = grant({
    requestedRights: {
      toolAdmission: {
        policyId: "research-tools",
        expectedPolicyRevision: 0,
        enabled: true,
        recipients: [PEER],
        toolKinds: ["read_web_page_outline"],
        maxDelegationDepth: 0,
      },
    },
  });
  const html = renderToString(
    <OperatorAuthorityFacts change={change} roster={roster()} />,
  );
  const text = textOf(html);
  match(html, /data-authority="tool-admission"/);
  match(text, /Holder Main Operator native:designer/);
  match(text, /Recipients Research native:research/);
  match(text, /Act Admit exact tested candidates/);
  match(text, /Tool kinds read_web_page_outline/);
  match(text, /Network decisions Not included/);
  doesNotMatch(
    text,
    /Allowed hosts|Add exact network hosts|Tool admission Not included/,
  );
});

Deno.test("candidate receipts identify the delegate, owning operator, exact digest and Request without adding decision controls", () => {
  const candidate = delegatedCandidate();
  const html = renderToString(
    <CandidateAuthorityFacts
      candidate={candidate}
      operatorId={PEER}
      roster={roster()}
    />,
  );
  const text = textOf(html);
  match(html, /data-authority="candidate-admission"/);
  match(text, /Decided by Main Operator · rule research-tools · rev\. 1/);
  match(text, /Owning operator Research native:research/);
  match(text, /Authority Delegate under the person’s tool admission grant/);
  match(text, new RegExp(candidate.digest));
  match(text, /Request ui-fixture:case:2/);
  match(text, /Grant issuer System owner native:person/);
  doesNotMatch(
    html,
    /<button|>Accept<|>Decline<|>Adjust<|Decided by System owner/,
  );
  candidate.admission!.actorId = PEER;
  equal(
    textOf(
      renderToString(
        <CandidateAuthorityFacts
          candidate={candidate}
          operatorId={PEER}
          roster={roster()}
        />,
      ),
    ),
    "Decision receipt unavailable",
  );
});

Deno.test("a policy proposal states holder, exact recipients and complete bounds without adding decision controls", () => {
  const html = renderToString(
    <OperatorAuthorityFacts change={policyChange()} roster={roster()} />,
  );
  const text = textOf(html);
  // Exact values only: the card says where the decision stands.
  doesNotMatch(html, /<summary|Awaiting person|Policy grant published/);
  match(
    text,
    /^Policy research-network Expected current revision 0 Proposed revision 1 Holder Main Operator native:designer/,
  );
  match(text, /Recipients Research native:research/);
  match(text, /Allowed hosts example\.org, example\.net/);
  match(text, /Tool admission Not included/);
  match(text, /Further delegation Not allowed/);
  match(text, /Current policy status unavailable/);
  doesNotMatch(html, /<button|>Accept<|>Decline<|>Adjust<|Decided by/);
});

Deno.test("a human publication names the recorded owner, from its receipt only", () => {
  const change = policyChange({
    status: "approved",
    authority: "human",
    decidedAt: "2026-10-26T00:00:00Z",
    publishedCommit: HEAD,
    authorityExercise: {
      ...owner("main-system"),
      authoritySchema: 2,
      action: "mandate-change",
      baseModelDigest: DIGEST,
      outOfMandate: false,
    },
  });
  const html = renderToString(
    <OperatorAuthorityFacts change={change} roster={roster()} />,
  );
  match(textOf(html), /Decided by System owner main-system:human/);
  doesNotMatch(textOf(html), /Policy grant published|Published commit/);
  delete change.authorityExercise;
  doesNotMatch(
    textOf(
      renderToString(
        <OperatorAuthorityFacts change={change} roster={roster()} />,
      ),
    ),
    /Decided by System owner/,
  );
});

Deno.test("a policy's expected, proposed and published revisions remain distinct with a read-only change identity", () => {
  const approval: AuthorityExercise = {
    ...owner("main-system"),
    authoritySchema: 2,
    action: "mandate-change",
    baseModelDigest: DIGEST,
    outOfMandate: false,
  };
  for (const status of ["pending", "refused", "approved"] as const) {
    const change = policyChange({
      id: "policy-revision-change",
      status,
      ...(status !== "pending"
        ? {
          authority: "human",
          authorityExercise: approval,
          decidedAt: "2026-10-26T00:00:00Z",
        }
        : {}),
    });
    const rights = change.requestedRights!;
    if (!("operatorAuthority" in rights)) {
      throw new Error("Expected policy request");
    }
    rights.operatorAuthority.expectedPolicyRevision = 4;
    const html = renderToString(
      <OperatorAuthorityFacts change={change} roster={roster()} />,
    );
    match(textOf(html), /Expected current revision 4 Proposed revision 5/);
    doesNotMatch(textOf(html), /Published revision/);
    doesNotMatch(html, /<input|<textarea|<button/);
    if (status === "approved") {
      change.publishedCommit = HEAD;
      const published = textOf(
        renderToString(
          <OperatorAuthorityFacts change={change} roster={roster()} />,
        ),
      );
      match(published, /Expected current revision 4 Published revision 5/);
      doesNotMatch(published, /Proposed revision|Policy revision published/);
    }
  }
});

Deno.test("an exercise shows only its granted hosts and keeps its recorded actor after revocation", () => {
  const html = renderToString(
    <OperatorAuthorityFacts
      change={exercise()}
      roster={roster()}
      reading={{ data: sources(), fresh: true }}
    />,
  );
  match(
    textOf(html),
    /^Policy research-network · revision 1 Decided by Main Operator native:designer/,
  );
  match(textOf(html), /Hosts in this decision example\.org/);
  doesNotMatch(textOf(html), /example\.net|Allowed hosts/);
  match(textOf(html), /Revoked · current revision 2/);
});

Deno.test("historical facts never borrow current policy status or invent authority from a mismatched receipt", () => {
  const html = renderToString(
    <OperatorAuthorityFacts
      change={exercise()}
      roster={roster()}
      reading={{ data: sources(), fresh: true }}
      historical
    />,
  );
  match(textOf(html), /Recorded at this revision/);
  match(textOf(html), /research-network · revision 1/);
  doesNotMatch(textOf(html), /Current sources|Revoked|current revision 2/);
  const invalid = exercise();
  invalid.authorityExercise!.delegation!.caseId = "foreign-case";
  equal(
    textOf(
      renderToString(
        <OperatorAuthorityFacts change={invalid} roster={roster()} />,
      ),
    ),
    "Decision receipt unavailable",
  );
});

Deno.test("authority facts escape operator names and policy text", () => {
  const change = policyChange();
  const rights = change.requestedRights!;
  if (!("operatorAuthority" in rights)) {
    throw new Error("Expected policy request");
  }
  rights.operatorAuthority.policyId = "<script>policy()</script>";
  const names = roster();
  names[0].name = '<img src=x onerror="attack()">';
  names[1].name = "<b>Research</b>";
  const html = renderToString(
    <OperatorAuthorityFacts change={change} roster={names} />,
  );
  match(html, /&lt;script(?:>|&gt;)policy/);
  match(html, /&lt;img/);
  match(html, /&lt;b(?:>|&gt;)Research/);
  doesNotMatch(html, /<script|<img|<b>Research/);
});

Deno.test("the authority disclosure preserves the existing exact proposal actions", async () => {
  const change = policyChange();
  const verdicts: string[] = [];
  const view = press(
    <ModelChangeCard
      id="policy-proposal"
      change={change}
      decision={decisionState(change)}
      authority={<OperatorAuthorityFacts change={change} roster={roster()} />}
      onDecide={(verdict) => {
        verdicts.push(verdict);
        return Promise.resolve(true);
      }}
      adjustmentMessage={(message) => message}
      onAdjustment={() => Promise.resolve(true)}
    />,
  );
  for (const action of ["Accept", "Decline", "Adjust"]) {
    equal(view.labels.filter((label) => label === action).length, 1);
  }
  view.click("Accept");
  await Promise.resolve();
  deepStrictEqual(verdicts, ["approve"]);
});

function observedState(
  calls: string[],
  data: SourceRevisions = sources(),
  failures = 0,
) {
  const api: ChatProposalApi = {
    read: (id) => {
      calls.push(id);
      if (failures > 0) {
        failures--;
        return Promise.reject(
          new Error("Source authority temporarily unavailable"),
        );
      }
      return Promise.resolve(structuredClone(data));
    },
    preview: () => Promise.reject(new Error("No source preview expected")),
    decide: () => Promise.reject(new Error("Facts cannot decide")),
    adopt: () => Promise.reject(new Error("Facts cannot adopt")),
  };
  const initial = snapshot();
  initial.candidates = [];
  initial.messages = [];
  const state = createWorkbenchState({
    initialState: initial,
    proposalApi: api,
  });
  state.connection.value = "live";
  const conversations = operatorRoster([], [exercise()]);
  conversations.conversations[0].name = "Main Operator";
  conversations.conversations[1].name = "Main Operator";
  state.agentConversations.accept(conversations);
  return state;
}

Deno.test("observed authority reads the native policy owner rather than its homonymous requester", async () => {
  const calls: string[] = [];
  const state = observedState(calls);
  const root = probeRoot();
  let node: VNode | undefined;
  const Probe = () => {
    node = ObservedOperatorAuthority({ change: exercise(), state });
    return null;
  };
  try {
    await root.show(Probe, {});
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    await root.show(Probe, {});
    deepStrictEqual(calls, [MAIN]);
    match(textOf(renderToString(node!)), /Revoked · current revision 2/);
  } finally {
    await root.restore();
    state.dispose();
  }
});

Deno.test("historical authority never starts a current-source read or paints a current overlay", async () => {
  for (const explicit of [true, false]) {
    const calls: string[] = [];
    const state = observedState(calls);
    if (!explicit) {
      state.selectedRevision.value = 3;
      state.inspected.value = snapshot();
    }
    const root = probeRoot();
    let node: VNode | undefined;
    const Probe = () => {
      node = ObservedOperatorAuthority({
        change: exercise(),
        state,
        historical: explicit,
      });
      return null;
    };
    try {
      await root.show(Probe, {});
      deepStrictEqual(calls, []);
      const html = textOf(renderToString(node!));
      match(html, /Recorded at this revision/);
      doesNotMatch(html, /Current sources|Revoked|current revision 2/);
    } finally {
      await root.restore();
      state.dispose();
    }
  }
});

Deno.test("a disconnected authority card invalidates its enabled observation and stops following model announcements", async () => {
  for (const connection of ["reconnecting", "closed"] as const) {
    const data = sources();
    data.runtime.sourceRights!.operatorAuthorityPolicies![0].enabled = true;
    data.runtime.sourceRights!.operatorAuthorityPolicies![0].revision = 1;
    data.runtime.sourceRights!.operatorAuthorityPolicies![0].elementId =
      "policy:1";
    const calls: string[] = [];
    const state = observedState(calls, data);
    const root = probeRoot();
    let node: VNode | undefined;
    const Probe = () => {
      node = ObservedOperatorAuthority({ change: exercise(), state });
      return null;
    };
    try {
      await root.show(Probe, {});
      await act(settle);
      await root.show(Probe, {});
      match(
        textOf(renderToString(node!)),
        /Enabled in current sources · revision 1/,
      );
      equal(state.chatProposals.isStale(MAIN), false);
      await act(() => {
        state.connection.value = connection;
      });
      await root.show(Probe, {});
      const offline = textOf(renderToString(node!));
      match(offline, /Current policy status unavailable/);
      doesNotMatch(offline, /Enabled in current sources/);
      const head = `commit:${crypto.randomUUID().replaceAll("-", "")}12345678`;
      await act(() => modelLive.accept(JSON.stringify({ head })));
      await act(settle);
      deepStrictEqual(calls, [MAIN]);
      equal(
        state.chatProposals.visible(MAIN)!.runtime.sourceRights!
          .operatorAuthorityPolicies![0].enabled,
        true,
      );
    } finally {
      await root.restore();
      state.dispose();
    }
  }
});

Deno.test("reconnecting to the same announced head retries a failed initial authority read", async () => {
  const calls: string[] = [];
  const data = sources();
  data.version = `commit:${crypto.randomUUID().replaceAll("-", "")}12345678`;
  data.runtime.available!.repositoryVersion = data.version;
  const announcement = JSON.stringify({ head: data.version });
  modelLive.accept(announcement);
  const state = observedState(calls, data, 1);
  const beforeSnapshot = structuredClone(state.current.value);
  const beforeRoster = structuredClone(state.conversationSnapshot.value);
  const root = probeRoot();
  let node: VNode | undefined;
  function Probe() {
    node = ObservedOperatorAuthority({ change: exercise(), state });
    return null;
  }
  try {
    await root.show(Probe, {});
    await act(settle);
    await root.show(Probe, {});
    deepStrictEqual(calls, [MAIN]);
    match(state.chatProposals.errorFor(MAIN), /temporarily unavailable/);
    match(textOf(renderToString(node!)), /Current policy status unavailable/);
    await act(() => {
      state.connection.value = "reconnecting";
    });
    await root.show(Probe, {});
    await act(() => modelLive.accept(announcement));
    deepStrictEqual(calls, [MAIN]);
    await act(() => {
      state.connection.value = "live";
    });
    await root.show(Probe, {});
    await act(settle);
    await root.show(Probe, {});
    deepStrictEqual(calls, [MAIN, MAIN]);
    equal(state.chatProposals.errorFor(MAIN), "");
    match(textOf(renderToString(node!)), /Revoked · current revision 2/);
    await act(() => modelLive.accept(announcement));
    await act(settle);
    deepStrictEqual(calls, [MAIN, MAIN]);
    deepStrictEqual(state.current.value, beforeSnapshot);
    deepStrictEqual(state.conversationSnapshot.value, beforeRoster);
  } finally {
    await root.restore();
    state.dispose();
  }
});

Deno.test("the real SSE transport retries failed authority after a coalesced same-head reconnect without writing", async () => {
  const listeners = new Map<
    string,
    Array<(event: { data?: string }) => void>
  >();
  const events = {
    closed: false,
    addEventListener(
      type: string,
      listener: (event: { data?: string }) => void,
    ) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    close() {
      events.closed = true;
    },
  };
  const emit = (type: string, body?: unknown) => {
    for (const listener of listeners.get(type) ?? []) {
      listener({ data: body === undefined ? undefined : JSON.stringify(body) });
    }
  };
  const current = snapshot();
  current.candidates = [];
  current.messages = [];
  const roster = operatorRoster([], [exercise()]);
  const data = sources();
  data.version = `commit:${crypto.randomUUID().replaceAll("-", "")}12345678`;
  data.runtime.available!.repositoryVersion = data.version;
  const oldPin = structuredClone(data.runtime.active);
  const reads: string[] = [];
  const writes: string[] = [];
  const requests: Array<{ path: string; method: string }> = [];
  let unavailable = true;
  const api: ChatProposalApi = {
    read: (owner) => {
      reads.push(owner);
      return unavailable
        ? Promise.reject(new Error("Authority source read failed"))
        : Promise.resolve(structuredClone(data));
    },
    preview: () => Promise.reject(new Error("No source preview expected")),
    decide: () => {
      writes.push("decide");
      return Promise.reject(new Error("No decision expected"));
    },
    adopt: () => {
      writes.push("adopt");
      return Promise.reject(new Error("No adoption expected"));
    },
  };
  const state = createWorkbenchState({
    initialState: current,
    proposalApi: api,
    eventSourceFactory: (path) => {
      equal(path, "/api/events");
      return events;
    },
    fetch: (path, init) => {
      const method = init?.method ?? "GET";
      requests.push({ path, method });
      if (method !== "GET") {
        writes.push(path);
        return Promise.reject(new Error("No write expected"));
      }
      const bodies: Record<string, unknown> = {
        "/api/state": current,
        "/api/history": { currentRevision: current.revision, revisions: [] },
        "/api/conversations": roster,
        "/api/operator-tools": {
          systemId: current.id,
          version: roster.version,
          tools: [],
        },
        "/api/model-revisions": data,
        "/api/cases": { systemId: current.id, cases: [] },
      };
      return Promise.resolve(
        Object.hasOwn(bodies, path)
          ? Response.json(bodies[path])
          : Response.json({ error: `Unexpected read: ${path}` }, {
            status: 404,
          }),
      );
    },
  });
  const root = probeRoot();
  let node: VNode | undefined;
  function Probe() {
    node = ObservedOperatorAuthority({ change: exercise(), state });
    return null;
  }
  const stop = state.start();
  try {
    await act(() => {
      emit("open");
      emit("model-version", { head: data.version });
    });
    await act(settle);
    equal(state.connection.value, "live");
    await root.show(Probe, {});
    await act(settle);
    await root.show(Probe, {});
    deepStrictEqual(reads, [MAIN]);
    match(state.chatProposals.errorFor(MAIN), /source read failed/);
    match(textOf(renderToString(node!)), /Current policy status unavailable/);
    const beforeGeneration = state.chatProposals.generation.value;
    const beforeSnapshot = structuredClone(state.current.value);
    const beforeRoster = structuredClone(state.conversationSnapshot.value);

    unavailable = false;
    await act(() => {
      emit("error");
      emit("open");
      emit("model-version", { head: data.version });
    });
    equal(state.connection.value, "live");
    equal(state.chatProposals.generation.value > beforeGeneration, true);
    await act(settle);
    await root.show(Probe, {});
    await act(settle);
    await root.show(Probe, {});
    deepStrictEqual(reads, [MAIN, MAIN]);
    equal(state.chatProposals.errorFor(MAIN), "");
    match(textOf(renderToString(node!)), /Revoked · current revision 2/);
    deepStrictEqual(state.current.value, beforeSnapshot);
    deepStrictEqual(state.conversationSnapshot.value, beforeRoster);
    deepStrictEqual(data.runtime.active, oldPin);
    deepStrictEqual(writes, []);
    equal(requests.every((request) => request.method === "GET"), true);
  } finally {
    await root.restore();
    stop();
    state.dispose();
    equal(events.closed, true);
  }
});

Deno.test("returning after an unobserved revocation rereads source authority instead of trusting the cached enabled policy", async () => {
  const calls: string[] = [];
  const data = sources();
  data.runtime.sourceRights!.operatorAuthorityPolicies![0].enabled = true;
  data.runtime.sourceRights!.operatorAuthorityPolicies![0].revision = 1;
  data.runtime.sourceRights!.operatorAuthorityPolicies![0].elementId =
    "policy:1";
  const state = observedState(calls, data);
  const beforeSnapshot = structuredClone(state.current.value);
  const beforeRoster = structuredClone(state.conversationSnapshot.value);
  const root = probeRoot();
  let node: VNode | undefined;
  function Probe() {
    node = ObservedOperatorAuthority({ change: exercise(), state });
    return null;
  }
  try {
    await root.show(Probe, {});
    await act(settle);
    await root.show(Probe, {});
    deepStrictEqual(calls, [MAIN]);
    match(
      textOf(renderToString(node!)),
      /Enabled in current sources · revision 1/,
    );
    await root.unmount();

    data.runtime.sourceRights!.operatorAuthorityPolicies![0].enabled = false;
    data.runtime.sourceRights!.operatorAuthorityPolicies![0].revision = 2;
    data.version = `commit:${crypto.randomUUID().replaceAll("-", "")}12345678`;
    data.runtime.available!.repositoryVersion = data.version;
    await act(() => modelLive.accept(JSON.stringify({ head: data.version })));
    deepStrictEqual(calls, [MAIN]);
    equal(
      state.chatProposals.visible(MAIN)!.runtime.sourceRights!
        .operatorAuthorityPolicies![0].enabled,
      true,
    );

    const unobserved = textOf(
      renderToString(
        <ObservedOperatorAuthority change={exercise()} state={state} />,
      ),
    );
    match(unobserved, /Current policy status unavailable/);
    doesNotMatch(unobserved, /Enabled in current sources/);
    deepStrictEqual(calls, [MAIN]);

    await root.show(Probe, {});
    await act(settle);
    await root.show(Probe, {});
    deepStrictEqual(calls, [MAIN, MAIN]);
    match(textOf(renderToString(node!)), /Revoked · current revision 2/);
    deepStrictEqual(state.current.value, beforeSnapshot);
    deepStrictEqual(state.conversationSnapshot.value, beforeRoster);
  } finally {
    await root.restore();
    state.dispose();
  }
});

Deno.test("an external model announcement refreshes the policy owner once across cards and stops after their cleanup", async () => {
  const calls: string[] = [];
  let response = sources();
  response.runtime.sourceRights!.operatorAuthorityPolicies![0].enabled = true;
  response.runtime.sourceRights!.operatorAuthorityPolicies![0].revision = 1;
  response.runtime.sourceRights!.operatorAuthorityPolicies![0].elementId =
    "policy:1";
  const oldPin = structuredClone(response.runtime.active);
  let deferred = false;
  let release: ((data: SourceRevisions) => void) | undefined;
  const api: ChatProposalApi = {
    read: (id) => {
      calls.push(id);
      return deferred
        ? new Promise((resolve) => {
          release = resolve;
        })
        : Promise.resolve(structuredClone(response));
    },
    preview: () => Promise.reject(new Error("No preview expected")),
    decide: () => Promise.reject(new Error("Facts cannot decide")),
    adopt: () => Promise.reject(new Error("Facts cannot adopt")),
  };
  const initial = snapshot();
  initial.messages = [];
  initial.candidates = [];
  const state = createWorkbenchState({
    initialState: initial,
    proposalApi: api,
  });
  state.connection.value = "live";
  state.agentConversations.accept(operatorRoster([], [exercise()]));
  const beforeSnapshot = structuredClone(state.current.value);
  const beforeRoster = structuredClone(state.conversationSnapshot.value);
  const root = probeRoot();
  const nodes = new Map<string, VNode>();
  function Card({ id }: { id: string }) {
    nodes.set(id, ObservedOperatorAuthority({ change: exercise(), state }));
    return null;
  }
  function Cards({ second }: { second: boolean }) {
    return h(
      Fragment,
      null,
      h(Card, { key: "one", id: "one" }),
      second ? h(Card, { key: "two", id: "two" }) : null,
    );
  }
  const announce = async () => {
    const version = `commit:${crypto.randomUUID().replaceAll("-", "")}12345678`;
    response.version = version;
    response.runtime.available!.repositoryVersion = version;
    await act(() => modelLive.accept(JSON.stringify({ head: version })));
  };
  const text = (id: string) => textOf(renderToString(nodes.get(id)!));
  try {
    await root.show(Cards, { second: true });
    await act(settle);
    await root.show(Cards, { second: true });
    equal(nodes.size, 2);
    deepStrictEqual(calls, [MAIN]);
    for (const id of ["one", "two"]) {
      match(text(id), /Enabled in current sources · revision 1/);
    }

    response = sources();
    deferred = true;
    await announce();
    await root.show(Cards, { second: true });
    deepStrictEqual(calls, [MAIN, MAIN]);
    equal(typeof release, "function");
    for (const id of ["one", "two"]) {
      match(text(id), /Current policy status unavailable/);
      doesNotMatch(text(id), /Enabled in current sources/);
    }
    deferred = false;
    release!(structuredClone(response));
    await act(settle);
    await root.show(Cards, { second: true });
    for (const id of ["one", "two"]) {
      match(text(id), /Revoked · current revision 2/);
    }
    deepStrictEqual(response.runtime.active, oldPin);
    deepStrictEqual(state.current.value, beforeSnapshot);
    deepStrictEqual(state.conversationSnapshot.value, beforeRoster);

    await root.show(Cards, { second: false });
    await announce();
    await act(settle);
    deepStrictEqual(calls, [MAIN, MAIN, MAIN]);
    await root.unmount();
    await announce();
    await act(settle);
    deepStrictEqual(calls, [MAIN, MAIN, MAIN]);
  } finally {
    await root.restore();
    state.dispose();
  }
});

Deno.test("the conversation's real change card includes the authority disclosure", () => {
  const state = observedState([]);
  const conversations = operatorRoster([policyChange()]);
  conversations.conversations[0].name = "Main Operator";
  state.agentConversations.accept(conversations);
  const conversation = state.conversationSnapshot.value!.conversations[0];
  const html = renderToString(
    <ChatTimeline
      state={state}
      conversation={conversation}
      entries={chatEntries(state, conversation)}
    />,
  );
  match(textOf(html), /Grant operator authority/);
  match(textOf(html), /To decide/);
  doesNotMatch(textOf(html), /Awaiting person/);
  match(textOf(html), /Holder Main Operator native:designer/);
  match(textOf(html), /Allowed hosts example\.org, example\.net/);
  match(html, />Accept<|>Decline<|>Adjust</);
  state.dispose();
});

Deno.test("4.8d D5: a policy naming a recipient space shows its Branch Operator apart from the Main Operator", () => {
  const change = grant({
    requestedRights: {
      operatorAuthority: {
        policyId: "bo-network",
        expectedPolicyRevision: 0,
        enabled: true,
        recipients: ["native:designer"],
        recipientExecutionSpaceId: "0f1e2d3c-branch-space",
        acts: ["addNetworkHosts"],
        networkHosts: ["example.org"],
        toolIds: [],
        maxDelegationDepth: 0,
      },
    },
  });
  const text = textOf(renderToString(
    <OperatorAuthorityFacts change={change} roster={roster()} />,
  ));
  match(
    text,
    /Recipients Branch Operator of Main Operator · branch 0f1e2d3c native:designer @ 0f1e2d3c-branch-space/,
  );
});
