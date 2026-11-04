import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type {
  AgentConversation,
  ConversationsSnapshot,
  OperatorToolsSnapshot,
} from "../../../src/application/work/operators/conversation-types.ts";
import type { Candidate } from "../../../src/domain/work/records/candidates.ts";
import type {
  PendingChange,
} from "../../../src/domain/governance/records/pending-change.ts";
import type { SystemRuntimeState } from "../../../src/application/work/runtime/state.ts";
import {
  aggregatePendingDecisions,
  aggregateRequestDecisions,
  caseHasPendingDecision,
  createPendingProposals,
  type PendingDecision,
} from "./pending.ts";
import { parseCasesSnapshot } from "../cases/cases.ts";
import { caseRecord } from "../../test/support/case-fixture.ts";
import type {
  SourceProposal,
  SourceRevisions,
} from "../model/revisions/api.ts";

const change: PendingChange = {
  id: "shared-change",
  kind: "mandate-change",
  status: "pending",
  baseRevision: 1,
  reason: "Allow a host",
  requestedAt: "now",
};
const candidate: Candidate = {
  id: "shared-tool",
  digest: "a".repeat(64),
  name: "Read page",
  description: "Read a page",
  kind: "read_web_page",
  code: "",
  stage: "awaiting-admission",
  requiredAuthority: "human",
  createdAt: "now",
  baseCatalogRevision: 0,
};
function state(): SystemRuntimeState {
  return {
    id: "system",
    revision: 1,
    catalogRevision: 0,
    busy: false,
    phase: "Ready",
    provider: "fixture",
    messages: [],
    candidates: [candidate],
    events: [],
    configuration: {
      id: "config",
      revision: 1,
      envelope: {
        kind: "conversational-case-management",
        pattern: "1.3",
        revision: 0,
      },
      builder: {
        id: "builder",
        mandateRevision: 1,
        admissionAuthority: "human",
      },
      changes: [change],
    },
  };
}
function agent(id: string): AgentConversation {
  return {
    agentId: `thread:${id}`,
    nativeId: `native:${id}`,
    name: id,
    responsibility: "Process cases",
    primary: id === "alpha",
    canSend: true,
    busy: false,
    revision: 1,
    phase: "Ready",
    messages: [],
    modelDigest: "model",
    proposalContext: {
      configurationRevision: 1,
      before: {
        network: { allowedHosts: [] },
        builder: { admissionAuthority: "human" },
      },
      changes: [change, { ...change, id: "decided", status: "approved" }],
    },
  };
}
function revisions(
  status: SourceProposal["status"] = "proposed",
): SourceRevisions {
  return {
    version: "commit:head",
    sourceDigest: "source",
    proposals: [{
      id: "proposal/a & b",
      author: "agent:native:beta",
      authorization: {
        kind: "operator",
        operatorNativeId: "native:beta",
        systemQualifiedName: "System",
        operatorQualifiedName: "System::beta",
        mandateId: "mandate",
        mandateRevision: 1,
        policyId: "policy",
        policyRevision: 1,
        policyDigest: "policy",
        operations: ["set-value"],
      },
      reason: "Change the model",
      status,
      baseVersion: "commit:base",
      proposalVersion: "commit:proposal",
      sourceDigest: "source",
      createdAt: "now",
    }],
    runtime: { active: null, available: null, executable: false },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}

Deno.test("global decisions retain every owner, deduplicate occurrences and link existing review destinations", () => {
  const alpha = agent("alpha"), beta = agent("beta");
  const tools: OperatorToolsSnapshot = {
    systemId: "system",
    version: "tools",
    tools: [alpha, beta, alpha].map((owner) => ({
      agentId: owner.agentId,
      agentName: owner.name,
      revision: owner.revision,
      candidate,
    })),
  };
  tools.tools.push({
    ...tools.tools[0],
    candidate: { ...candidate, id: "automatic", requiredAuthority: "builder" },
  }, {
    ...tools.tools[0],
    candidate: { ...candidate, id: "active", stage: "active" },
  }, {
    ...tools.tools[0],
    agentId: "missing-conversation",
    candidate: { ...candidate, id: "unreachable" },
  });
  const proposals = revisions();
  proposals.proposals.push(proposals.proposals[0], {
    ...proposals.proposals[0],
    id: "accepted",
    status: "accepted",
  });
  const items = aggregatePendingDecisions({
    state: state(),
    conversations: {
      systemId: "system",
      version: "threads",
      defaultAgentId: alpha.agentId,
      conversations: [alpha, beta],
    },
    tools,
    proposals,
  });
  equal(items.length, 5);
  equal(new Set(items.map((item) => item.id)).size, 5);
  deepStrictEqual(items.map((item) => item.kind), [
    "proposal",
    "authorization",
    "authorization",
    "tool",
    "tool",
  ]);
  equal(items[0].href, "/model?proposal=proposal%2Fa+%26+b");
  equal(items[0].agentName, "beta");
  equal(items[1].href, "/chat?agent=thread%3Aalpha");
  equal(items[2].href, "/chat?agent=thread%3Abeta");
  equal(items[4].agentName, "beta");
  equal(
    items[3].href,
    `/model?operator=thread%3Aalpha&candidate=shared-tool&digest=${candidate.digest}`,
  );
  equal(
    items[4].href,
    `/model?operator=thread%3Abeta&candidate=shared-tool&digest=${candidate.digest}`,
  );
  // The Dock marks the exact operator whose conversation holds each decision.
  deepStrictEqual(items.map((item) => item.agentId), [
    "thread:beta",
    "thread:alpha",
    "thread:beta",
    "thread:alpha",
    "thread:beta",
  ]);
});

Deno.test("missing and foreign sources do not invent decisions or inaccessible conversations", () => {
  const current = state();
  const legacy = aggregatePendingDecisions({ state: current });
  equal(legacy.length, 1);
  equal(legacy[0].kind, "tool");
  equal(legacy[0].href, "/chat");
  equal(
    aggregatePendingDecisions({ state: null, proposals: revisions() }).length,
    0,
  );
  const foreign = aggregatePendingDecisions({
    state: { ...current, candidates: [] },
    conversations: {
      systemId: "different-system",
      version: "threads",
      defaultAgentId: "thread:alpha",
      conversations: [agent("alpha")],
    },
    tools: {
      systemId: "different-system",
      version: "tools",
      tools: [{
        agentId: "thread:alpha",
        agentName: "alpha",
        revision: 1,
        candidate,
      }],
    },
  });
  deepStrictEqual(foreign, []);
  const noOwner = aggregatePendingDecisions({
    state: current,
    tools: {
      systemId: "system",
      version: "tools",
      tools: [{
        agentId: "missing",
        agentName: "missing",
        revision: 1,
        candidate,
      }],
    },
  });
  deepStrictEqual(noOwner, []);
});

Deno.test("decision aggregation retains recorded Case identities for every review source", () => {
  const alpha = agent("alpha");
  alpha.proposalContext!.changes[0] = Object.assign({ ...change }, {
    caseId: "case:mandate",
  });
  const proposals = revisions();
  Object.assign(proposals.proposals[0], { caseId: "case:proposal" });
  const current = state();
  current.candidates = [
    Object.assign({ ...candidate }, { caseId: "case:legacy" }),
  ];
  const conversations = {
    systemId: "system",
    version: "threads",
    defaultAgentId: alpha.agentId,
    conversations: [alpha],
  };
  const items = aggregatePendingDecisions({
    state: current,
    conversations,
    proposals,
    tools: {
      systemId: "system",
      version: "tools",
      tools: [{
        agentId: alpha.agentId,
        agentName: alpha.name,
        revision: alpha.revision,
        candidate: Object.assign({ ...candidate }, { caseId: "case:tool" }),
      }],
    },
  });
  deepStrictEqual(items.map((item) => item.caseId), [
    "case:proposal",
    "case:mandate",
    "case:tool",
  ]);
  const legacy = aggregatePendingDecisions({ state: current });
  equal(legacy[0].caseId, "case:legacy");
  Object.assign(current.candidates[0], { caseId: ["case:legacy"] });
  equal(aggregatePendingDecisions({ state: current })[0].caseId, undefined);
});

Deno.test("native tool review links preserve opaque identities and every recorded origin field", () => {
  const owners = [agent("alpha"), agent("beta")];
  owners[0].agentId = "session:a /?&";
  owners[1].agentId = "session:b /?&";
  const origin = {
    caseId: "system:case:42",
    designerScopeId: "scope:/42",
    requestedBy: "native:requester /?&",
  };
  const scoped = Object.assign({
    ...candidate,
    id: "same-tool /?&",
    digest: "digest+/#&",
  }, origin);
  const tools: OperatorToolsSnapshot = {
    systemId: "system",
    version: "tools",
    tools: owners.map((owner) => ({
      agentId: owner.agentId,
      agentName: owner.name,
      revision: owner.revision,
      candidate: scoped,
    })),
  };
  const input = {
    state: state(),
    conversations: {
      systemId: "system",
      version: "threads",
      defaultAgentId: owners[0].agentId,
      conversations: owners,
    },
    tools,
  };
  const before = JSON.stringify(input);
  const native = aggregatePendingDecisions(input).filter((item) =>
    item.kind === "tool"
  );
  equal(native.length, 2);
  for (const [index, item] of native.entries()) {
    equal(
      item.id,
      `tool:${JSON.stringify([owners[index].agentId, scoped.id])}`,
    );
    deepStrictEqual({
      caseId: item.caseId,
      designerScopeId: item.designerScopeId,
      requestedBy: item.requestedBy,
    }, origin);
    const destination = new URL(item.href, "https://atelier.test");
    equal(destination.pathname, "/model");
    deepStrictEqual([...destination.searchParams], [
      ["operator", owners[index].agentId],
      ["candidate", scoped.id],
      ["digest", scoped.digest],
    ]);
  }
  equal(JSON.stringify(input), before);
});

Deno.test("Case decision badges use the exact Case or the owner's unique open Case", () => {
  const cases = parseCasesSnapshot({
    systemId: "system",
    cases: [caseRecord(1), caseRecord(2), caseRecord(3, { owner: "other" })],
  }).cases;
  const decision: PendingDecision = {
    id: "decision",
    kind: "authorization",
    label: "Authorize mandate change",
    agentId: "thread:alpha",
    href: "/chat?agent=thread%3Aalpha",
  };
  const has = (record: typeof cases[number], open = cases, scoped = decision) =>
    caseHasPendingDecision(record, open, "thread:alpha", [scoped]);
  equal(has(cases[0]), false);
  equal(has(cases[1]), false);
  equal(has(cases[0], [cases[0], cases[2]]), true);
  equal(has(cases[0], cases, { ...decision, caseId: cases[1].id }), false);
  equal(has(cases[1], cases, { ...decision, caseId: cases[1].id }), true);
  equal(
    has(cases[0], [cases[0]], { ...decision, caseId: "unknown-case" }),
    false,
  );
  equal(
    caseHasPendingDecision(cases[0], cases, undefined, [{
      ...decision,
      caseId: cases[0].id,
    }]),
    true,
  );
  // A standing Job counts too: an unscoped decision must remain ambiguous.
  equal(has(cases[0], [cases[0], { ...cases[1], type: "job" }]), false);
});

Deno.test("proposal reads coalesce invalidation and reject superseded or disposed results", async () => {
  const first = deferred<SourceRevisions>(),
    second = deferred<SourceRevisions>();
  const signals: AbortSignal[] = [];
  let reads = 0;
  const source = createPendingProposals({
    systemId: () => "system",
    read: (signal) => {
      signals.push(signal);
      return ++reads === 1 ? first.promise : second.promise;
    },
  });
  equal(reads, 0);
  const refresh = source.refresh();
  equal(source.refresh(), refresh);
  source.invalidate();
  first.resolve(revisions());
  await Promise.resolve();
  await Promise.resolve();
  equal(reads, 2);
  equal(source.visible(), null);
  second.resolve(revisions("accepted"));
  await refresh;
  equal(source.visible()?.proposals[0].status, "accepted");
  equal(source.loading.value, false);
  source.invalidate();
  equal(source.loading.value, true);
  equal(source.visible()?.proposals[0].status, "accepted");
  source.dispose();
  ok(signals.at(-1)?.aborted);
  equal(source.visible(), null);
});

Deno.test("failed and cross-system proposal reads are omitted and late responses cannot survive disposal", async () => {
  let systemId = "first", fail = false;
  const late = deferred<SourceRevisions>();
  let reads = 0;
  const source = createPendingProposals({
    systemId: () => systemId,
    read: () => {
      if (fail) return Promise.reject(new Error("Network unavailable"));
      return ++reads === 1 ? Promise.resolve(revisions()) : late.promise;
    },
  });
  await source.refresh();
  ok(source.visible());
  fail = true;
  await source.refresh();
  equal(source.visible(), null);
  equal(source.error.value, "Model proposals could not be loaded.");
  fail = false;
  const pending = source.refresh();
  systemId = "second";
  equal(source.visible(), null);
  source.dispose();
  late.resolve(revisions());
  await pending;
  equal(source.visible(), null);
  equal(source.loading.value, false);
});

Deno.test("native tools open exact Model proposals while authorization and legacy decisions retain their recorded destinations", () => {
  const alpha = agent("alpha"), beta = agent("beta");
  beta.proposalContext!.changes = [];
  const caseId = "ui-fixture:case:2";
  alpha.proposalContext!.changes = [
    Object.assign({ ...change, id: "in-case", requestedBy: "native:alpha" }, {
      caseId,
    }),
    Object.assign({ ...change, id: "in-designer-scope" }, {
      designerScopeId: "scope:1",
      requestedBy: "native:alpha",
    }),
    { ...change, id: "historical" },
  ];
  const catalogue = (stageCase?: string): OperatorToolsSnapshot => ({
    systemId: "system",
    version: "tools",
    tools: [{
      agentId: beta.agentId,
      agentName: beta.name,
      revision: 1,
      candidate: Object.assign(
        { ...candidate },
        stageCase ? { caseId: stageCase } : {},
      ),
    }],
  });
  const conversations = {
    systemId: "system",
    version: "threads",
    defaultAgentId: alpha.agentId,
    conversations: [alpha, beta],
  };
  const items = aggregatePendingDecisions({
    state: { ...state(), candidates: [] },
    conversations,
    tools: catalogue(caseId),
  });
  deepStrictEqual(
    items.map((item) => [item.id.split(":")[0], item.caseId, item.href]),
    [
      ["authorization", caseId, "/cases?case=ui-fixture%3Acase%3A2"],
      ["authorization", undefined, "/chat?agent=thread%3Aalpha"],
      ["authorization", undefined, "/chat?agent=thread%3Aalpha"],
      [
        "tool",
        caseId,
        `/model?operator=thread%3Abeta&candidate=shared-tool&digest=${candidate.digest}`,
      ],
    ],
  );
  // The operator that asked and the designer's scope travel with the decision.
  equal(items[0].requestedBy, "native:alpha");
  equal(items[1].designerScopeId, "scope:1");
  equal(items[2].designerScopeId, undefined);
  equal(items[2].requestedBy, undefined);
  // A native tool opens the same exact proposal regardless of its Case origin.
  equal(
    aggregatePendingDecisions({
      state: { ...state(), candidates: [] },
      conversations,
      tools: catalogue(),
    }).at(-1)?.href,
    `/model?operator=thread%3Abeta&candidate=shared-tool&digest=${candidate.digest}`,
  );
  // The legacy primary tool follows its recorded Case too.
  const legacy = state();
  legacy.candidates = [
    Object.assign({ ...candidate }, { caseId }),
  ];
  equal(
    aggregatePendingDecisions({ state: legacy }).at(0)?.href,
    "/cases?case=ui-fixture%3Acase%3A2",
  );
  equal(
    aggregatePendingDecisions({ state: state(), conversations }).at(-1)?.href,
    "/chat?agent=thread%3Aalpha",
  );
});

Deno.test("a decision names what it authorizes: operator creation and model editing have their own labels", () => {
  const alpha = agent("alpha");
  alpha.proposalContext!.changes = [
    { ...change, id: "create", kind: "operator-creation" },
    {
      ...change,
      id: "editing",
      requestedRights: {
        grantModelEditing: {
          file: "configuration.sysml",
          root: "System",
          operations: ["insert-member"],
        },
      },
    },
    { ...change, id: "reviewer", kind: "reviewer-creation" },
    { ...change, id: "plain" },
  ];
  const labels = aggregatePendingDecisions({
    state: { ...state(), candidates: [] },
    conversations: {
      systemId: "system",
      version: "threads",
      defaultAgentId: alpha.agentId,
      conversations: [alpha],
    },
  }).map((item) => item.label);
  deepStrictEqual(labels, [
    "Authorize operator creation",
    "Authorize model editing",
    "Authorize reviewer creation",
    "Authorize mandate change",
  ]);
});

Deno.test("an operator's own Request lights for its change by Case and owner, and the designer's scope lights none", () => {
  const research = "native:research";
  const cases = parseCasesSnapshot({
    systemId: "system",
    cases: [
      caseRecord(1),
      caseRecord(2, { owner: research, openedBy: "native:coordinator" }),
      caseRecord(3, { owner: research, openedBy: "native:coordinator" }),
    ],
  }).cases;
  const decision: PendingDecision = {
    id: "decision",
    kind: "authorization",
    label: "Authorize mandate change",
    agentId: "thread:research",
    href: "/chat?agent=thread%3Aresearch",
  };
  const lights = (record: typeof cases[number], scoped: PendingDecision) =>
    caseHasPendingDecision(record, cases, "thread:research", [scoped]);
  // Recorded in the second Request of Research: only that one, whoever asked.
  const recorded = {
    ...decision,
    caseId: cases[1].id,
    requestedBy: research,
  };
  deepStrictEqual(cases.map((record) => lights(record, recorded)), [
    false,
    true,
    false,
  ]);
  equal(
    caseHasPendingDecision(cases[0], cases, "thread:coordinator", [{
      ...recorded,
      caseId: cases[0].id,
      agentId: "thread:research",
    }]),
    true,
  );
  // Made in the designer's own conversation: no Case waits, even a sole one.
  const scoped = {
    ...decision,
    designerScopeId: "scope:1",
    agentId: "thread:coordinator",
  };
  equal(
    caseHasPendingDecision(cases[0], [cases[0]], "thread:coordinator", [
      scoped,
    ]),
    false,
  );
  // A historical decision names its asker: the asker's sole open Case, not
  // the Case of whichever operator holds the proposal.
  const historical = {
    ...decision,
    agentId: "thread:coordinator",
    requestedBy: research,
  };
  equal(
    caseHasPendingDecision(cases[0], [cases[0]], "thread:coordinator", [
      historical,
    ]),
    false,
  );
  equal(
    caseHasPendingDecision(cases[1], [cases[1], cases[0]], "thread:research", [
      historical,
    ]),
    true,
  );
  equal(
    caseHasPendingDecision(cases[1], cases.slice(1), "thread:research", [
      historical,
    ]),
    false,
  );
});

Deno.test("what a Request's operator asked waits on that Request, read from its own execution space", () => {
  const cases = parseCasesSnapshot({
    systemId: "system",
    cases: [caseRecord(1), caseRecord(2)],
  }).cases;
  const owner = (id: string, changes: PendingChange[]) => {
    const conversation = agent(id);
    conversation.proposalContext!.changes = changes;
    return conversation;
  };
  // A Request is read apart from main: its snapshot never has main's id.
  const snapshot = (
    record: typeof cases[number],
    conversation: AgentConversation,
  ): [string, ConversationsSnapshot] => [record.id, {
    systemId: `request:${record.id}:space`,
    version: "request-1",
    defaultAgentId: conversation.agentId,
    conversations: [conversation],
  }];
  const asked = { ...change, id: "network", requestedBy: "native:research" };
  const decisions = aggregateRequestDecisions(
    new Map([
      snapshot(
        cases[0],
        owner("research", [
          // The enclosing Request supplies the origin even for an older change.
          asked,
          { ...asked, id: "decided", status: "approved", caseId: cases[0].id },
        ]),
      ),
      snapshot(cases[1], owner("designer", [])),
    ]),
  );
  deepStrictEqual(
    decisions.map((item) => [item.kind, item.agentId, item.caseId, item.href]),
    [[
      "authorization",
      "thread:research",
      cases[0].id,
      `/cases?case=${encodeURIComponent(cases[0].id)}&agent=thread%3Aresearch`,
    ]],
  );
  // The Request that asked waits; the other does not.
  deepStrictEqual(
    cases.map((record) =>
      caseHasPendingDecision(record, cases, undefined, decisions)
    ),
    [true, false],
  );
  // Nothing is read until a Request's conversation is.
  deepStrictEqual(aggregateRequestDecisions(new Map()), []);
});
