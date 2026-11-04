import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type { SystemRuntimeState } from "../../../src/application/work/runtime/state.ts";
import type { ConversationsSnapshot } from "../../../src/application/work/operators/conversation-types.ts";
import type { Fetcher } from "./api.ts";
import { modelLive } from "../model/live.ts";
import { createWorkbenchState } from "./state.ts";
import type { WorkbenchEventSource } from "./state.ts";

function snapshot(revision: number): SystemRuntimeState {
  return {
    id: "fixture",
    revision,
    catalogRevision: 0,
    busy: false,
    phase: "Prêt",
    provider: "fixture",
    messages: [{
      id: `m${revision}`,
      role: "assistant",
      text: `révision ${revision}`,
      at: "now",
    }],
    candidates: [{
      id: "candidate",
      digest: "a".repeat(64),
      name: "Lire",
      description: "Lire",
      kind: "read_web_page",
      code: "",
      stage: "awaiting-admission",
      createdAt: "now",
      baseCatalogRevision: 0,
    }],
    events: [],
    configuration: {
      id: "config",
      revision: 3,
      envelope: {
        kind: "conversational-case-management",
        pattern: "1.3",
        revision: 0,
      },
      builder: {
        id: "builder",
        mandateRevision: 2,
        admissionAuthority: "human",
      },
      changes: [],
    },
  };
}
const json = (body: unknown, status = 200) => Response.json(body, { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function requestConversation(): ConversationsSnapshot {
  return {
    systemId: "fixture",
    version: "v",
    defaultAgentId: "a",
    conversations: [{
      agentId: "a",
      nativeId: "a",
      name: "a",
      responsibility: "",
      primary: true,
      canSend: true,
      revision: 1,
      busy: false,
      phase: "Ready",
      modelDigest: "digest",
      messages: [],
    }],
  };
}
class Events implements WorkbenchEventSource {
  listeners = new Map<string, Array<(event: { data?: string }) => void>>();
  closed = false;
  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, state?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(state) });
    }
  }
  close() {
    this.closed = true;
  }
}

Deno.test("refusing an older proposal sends its base revision after configuration adoption", async () => {
  const current = snapshot(10);
  current.configuration!.revision = 2;
  const threads: ConversationsSnapshot = {
    systemId: current.id,
    defaultAgentId: "native:builder",
    version: "adopted-2",
    conversations: [{
      agentId: "native:builder",
      nativeId: "native:builder",
      name: "Builder",
      responsibility: "Build",
      primary: true,
      runtimeOwned: true,
      canSend: true,
      revision: 10,
      busy: false,
      phase: "Ready",
      modelDigest: "adopted-2",
      messages: [],
      proposalContext: {
        configurationRevision: 2,
        before: {
          network: { allowedHosts: [] },
          builder: { admissionAuthority: "human" },
        },
        changes: [{
          id: "proposal-A",
          kind: "mandate-change",
          status: "pending",
          baseRevision: 1,
          reason: "One host",
          requestedAt: "now",
          requestedRights: { addNetworkHosts: ["example.org"] },
        }],
      },
    }],
  };
  const requests: Array<{ path: string; body: unknown }> = [];
  const store = createWorkbenchState({
    initialState: current,
    fetch: (path, init) => {
      if (init?.method === "POST") {
        requests.push({ path, body: JSON.parse(String(init.body)) });
        return Promise.resolve(json({ accepted: true }, 202));
      }
      return Promise.resolve(json(path === "/api/state" ? current : threads));
    },
  });
  store.agentConversations.accept(threads);
  equal(
    await store.decideOperatorChange(
      threads.conversations[0],
      "proposal-A",
      "refuse",
    ),
    true,
  );
  deepStrictEqual(requests, [{
    path: "/api/conversations/native%3Abuilder/changes/proposal-A/decision",
    body: { expectedRevision: 10, configurationRevision: 1, verdict: "refuse" },
  }]);
});

Deno.test("construction is inert and stores keep drafts and live state per instance", () => {
  const fetcher: Fetcher = () => {
    throw new Error("Unexpected fetch during SSR");
  };
  const first = createWorkbenchState({
    fetch: fetcher,
    initialState: snapshot(7),
  });
  const second = createWorkbenchState({ fetch: fetcher });
  first.draft.value = "Mon message";
  equal(second.draft.value, "");
  equal(second.current.value, null);
  equal(first.displayed.value?.revision, 7);
});

Deno.test("adapter preserves exact message and decision wire contracts without client authority", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const store = createWorkbenchState({
    initialState: snapshot(10),
    fetch: (path, init) => {
      requests.push({ path, init });
      return Promise.resolve(
        path === "/api/state"
          ? json(snapshot(10))
          : path === "/api/history"
          ? json({ currentRevision: 10, revisions: [] })
          : json({ accepted: true }, 202),
      );
    },
  });
  store.draft.value = "  Bonjour  ";
  equal(await store.sendMessage(), true);
  equal(store.draft.value, "");
  equal(
    await store.decide("candidate", "candidate", "approve", 10, "a".repeat(64)),
    true,
  );
  equal(
    await store.decide("candidate", "candidate", "refuse", 10, "a".repeat(64)),
    true,
  );
  equal(await store.decide("change", "change", "approve", 10), true);
  const writes = requests.filter((request) => request.init?.method === "POST");
  deepStrictEqual(
    writes.map((
      request,
    ) => [request.path, JSON.parse(String(request.init?.body))]),
    [
      ["/api/messages", { text: "Bonjour" }],
      ["/api/decisions", {
        kind: "candidate",
        candidateId: "candidate",
        candidateDigest: "a".repeat(64),
        expectedRevision: 10,
        verdict: "approve",
        reason: "Admission explicitly approved in the system conversation.",
      }],
      ["/api/decisions", {
        kind: "candidate",
        candidateId: "candidate",
        candidateDigest: "a".repeat(64),
        expectedRevision: 10,
        verdict: "refuse",
        reason: "Admission explicitly refused in the system conversation.",
      }],
      ["/api/decisions", {
        kind: "change",
        changeId: "change",
        expectedRevision: 10,
        verdict: "approve",
      }],
    ],
  );
  equal(
    await store.decide("candidate", "candidate", "approve", 9, "a".repeat(64)),
    false,
  );
  equal(
    await store.decide("candidate", "candidate", "approve", 10, "b".repeat(64)),
    false,
  );
  equal(
    requests.filter((request) => request.init?.method === "POST").length,
    4,
  );
  ok(
    writes.every((request) =>
      new Headers(request.init?.headers).get("content-type") ===
        "application/json"
    ),
  );
});

Deno.test("historical reads never overwrite the live state or win after a newer selection", async () => {
  const old = deferred<Response>();
  const newer = deferred<Response>();
  const events = new Events();
  const requests: string[] = [];
  const store = createWorkbenchState({
    initialState: snapshot(10),
    eventSourceFactory: () => events,
    fetch: (path, init) => {
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/history/2") return old.promise;
      if (path === "/api/history/3") return newer.promise;
      return Promise.resolve(
        path === "/api/state"
          ? json(snapshot(10))
          : json({ revisions: [], currentRevision: 10 }),
      );
    },
  });
  const stop = store.start();
  await settle();
  const firstSelection = store.selectRevision(2);
  equal(store.readOnly.value, true);
  equal(store.displayed.peek(), null);
  equal(await store.sendMessage("blocked during historical loading"), false);
  equal(await store.decide("change", "change", "approve", 10), false);
  const secondSelection = store.selectRevision(3);
  newer.resolve(
    json({
      state: snapshot(3),
      projection: {
        revision: 3,
        graph: {},
        digest: "graph",
        recordedAt: "now",
      },
    }),
  );
  await secondSelection;
  events.emit("state", snapshot(12));
  events.emit("state", snapshot(11));
  old.resolve(json({ state: snapshot(2), projection: null }));
  await firstSelection;
  equal(store.displayed.value?.revision, 3);
  equal(store.current.value?.revision, 12);
  equal(store.graphRequestUrl.value, "/api/model-graph?revision=3");
  store.inspectSourceVersion("commit:abc/def");
  equal(
    store.graphRequestUrl.value,
    "/api/model-graph?modelVersion=commit%3Aabc%2Fdef",
  );
  store.resetToCurrent();
  equal(store.displayed.value?.revision, 12);
  equal(store.graphRequestUrl.value, "/api/model-graph");
  equal(store.historicalProjection.value, null);
  ok(!requests.some((request) => request.startsWith("POST")));
  stop();
  equal(events.closed, true);
});

Deno.test("returning to current cancels a late historical result and unavailable projection keeps current graph", async () => {
  const late = deferred<Response>();
  const store = createWorkbenchState({
    initialState: snapshot(5),
    fetch: (path) =>
      path.endsWith("/2")
        ? late.promise
        : Promise.resolve(json({ state: snapshot(3), projection: null })),
  });
  const selection = store.selectRevision(2);
  store.resetToCurrent();
  late.resolve(
    json({
      state: snapshot(2),
      projection: { revision: 2, graph: {}, digest: "old", recordedAt: "now" },
    }),
  );
  await selection;
  equal(store.selectedRevision.value, null);
  equal(store.displayed.value?.revision, 5);
  equal(store.graphRequestUrl.value, "/api/model-graph");
  await store.selectRevision(3);
  equal(store.displayed.value?.revision, 3);
  equal(store.graphRequestUrl.value, "/api/model-graph");
  ok(store.modelCaption.value.includes("No graph saved"));
});

Deno.test("SSE reconnect coalesces reads, rejects stale snapshots and never submits writes", async () => {
  const stateRead = deferred<Response>();
  const historyRead = deferred<Response>();
  const events = new Events();
  const counts = new Map<string, number>();
  const store = createWorkbenchState({
    eventSourceFactory: (path) => {
      equal(path, "/api/events");
      return events;
    },
    fetch: (path, init) => {
      equal(init?.method, undefined);
      counts.set(path, (counts.get(path) ?? 0) + 1);
      return path === "/api/state" ? stateRead.promise : historyRead.promise;
    },
  });
  const stop = store.start();
  equal(store.connectionGeneration.value, 0);
  for (let i = 0; i < 8; i++) {
    events.emit("error");
    events.emit("open");
  }
  equal(store.connection.value, "live");
  equal(store.connectionGeneration.value, 8);
  equal(counts.get("/api/state"), 1);
  equal(counts.get("/api/history"), 1);
  events.emit("state", snapshot(20));
  stateRead.resolve(json(snapshot(19)));
  historyRead.resolve(json({ currentRevision: 20, revisions: [] }));
  await settle();
  equal(store.current.value?.revision, 20);
  equal(counts.get("/api/history"), 2);
  stop();
  events.emit("state", snapshot(30));
  events.emit("open");
  equal(store.connectionGeneration.value, 8);
  equal(store.current.value?.revision, 20);
  equal(store.connection.value, "closed");
});

Deno.test("failed or uncertain writes retain the draft and are never retried automatically", async () => {
  const events = new Events();
  let writes = 0;
  const store = createWorkbenchState({
    initialState: snapshot(1),
    eventSourceFactory: () => events,
    fetch: (path, init) => {
      if (init?.method === "POST") {
        writes++;
        return Promise.resolve(json({ error: "Décision non confirmée" }, 409));
      }
      return Promise.resolve(
        path === "/api/state"
          ? json(snapshot(1))
          : json({ currentRevision: 1, revisions: [] }),
      );
    },
  });
  store.draft.value = "Ne pas perdre ce message";
  equal(await store.sendMessage(), false);
  equal(store.draft.value, "Ne pas perdre ce message");
  equal(store.error.value, "Décision non confirmée");
  equal(store.pending.value, false);
  const stop = store.start();
  events.emit("error");
  events.emit("open");
  await settle();
  equal(writes, 1);
  equal(store.draft.value, "Ne pas perdre ce message");
  stop();
});

Deno.test("acknowledged message clears its own draft, preserving edits made while pending", async () => {
  const response = deferred<Response>();
  const store = createWorkbenchState({
    initialState: snapshot(1),
    fetch: (path, init) =>
      init?.method === "POST" ? response.promise : Promise.resolve(
        path === "/api/state"
          ? json(snapshot(1))
          : json({ currentRevision: 1, revisions: [] }),
      ),
  });
  store.draft.value = "Premier message";
  const sent = store.sendMessage();
  equal(store.pending.value, true);
  equal(await store.sendMessage(), false);
  store.draft.value = "Nouveau brouillon";
  response.resolve(json({ accepted: true }, 202));
  equal(await sent, true);
  equal(store.draft.value, "Nouveau brouillon");
});

Deno.test("agent conversations reuse the existing event stream and route only the selected admitted entry", async () => {
  const events = new Events();
  const older = deferred<Response>();
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const initial = snapshot(10);
  initial.busy = true;
  const threads: ConversationsSnapshot = {
    systemId: initial.id,
    defaultAgentId: "native:worker",
    version: "threads-2",
    conversations: [{
      agentId: "native:worker",
      nativeId: "native:worker",
      name: "Opérateur",
      responsibility: "Traiter le dossier reçu",
      primary: true,
      canSend: true,
      revision: 4,
      busy: false,
      phase: "Prêt",
      modelDigest: "admitted",
      messages: [],
    }],
  };
  let sources = 0, conversationReads = 0;
  const store = createWorkbenchState({
    initialState: initial,
    eventSourceFactory: (path) => {
      sources++;
      equal(path, "/api/events");
      return events;
    },
    fetch: (path, init) => {
      requests.push({ path, init });
      if (init?.method === "POST") {
        return Promise.resolve(json({ accepted: true }, 202));
      }
      if (path === "/api/conversations") {
        return ++conversationReads === 1
          ? older.promise
          : Promise.resolve(json(threads));
      }
      return Promise.resolve(
        path === "/api/state"
          ? json(initial)
          : json({ currentRevision: 10, revisions: [] }),
      );
    },
  });
  const stop = store.start();
  events.emit("conversations", threads);
  older.resolve(json({ ...threads, version: "threads-1" }));
  await settle();
  equal(sources, 1);
  equal(store.agentConversations.snapshot.value?.version, "threads-2");
  equal(store.canAct.value, false);
  equal(store.canChat.value, true);
  store.draft.value = "Une consigne";
  equal(await store.sendMessage(), true);
  deepStrictEqual(
    requests.filter((request) => request.init?.method === "POST").map((
      request,
    ) => [request.path, JSON.parse(String(request.init?.body))]),
    [
      ["/api/conversations/native%3Aworker/messages", {
        text: "Une consigne",
        expectedRevision: 4,
      }],
    ],
  );
  await store.selectRevision(3).catch(() => {});
  equal(store.canChat.value, false);
  equal(store.selectedConversation.value, null);
  equal(await store.sendMessage("Pas d’écriture depuis l’historique"), false);
  stop();
  events.emit("conversations", { ...threads, version: "late" });
  equal(store.agentConversations.snapshot.value?.version, "threads-2");
});

Deno.test("global decisions and read counts stay current while the conversation displays history", async () => {
  const original = snapshot(10);
  const historical = snapshot(3);
  historical.candidates = [];
  const store = createWorkbenchState({
    initialState: original,
    fetch: () => Promise.resolve(json({ state: historical, projection: null })),
  });
  const candidate = {
    ...original.candidates[0],
    requiredAuthority: "human" as const,
  };
  store.agentConversations.accept({
    systemId: original.id,
    version: "threads",
    defaultAgentId: "worker",
    conversations: ["worker", "other"].map((agentId) => ({
      agentId,
      nativeId: `native:${agentId}`,
      name: agentId,
      responsibility: "Process cases",
      primary: agentId === "worker",
      canSend: true,
      revision: 4,
      busy: false,
      phase: "Ready",
      modelDigest: "model",
      messages: [],
    })),
  });
  store.operatorTools.accept({
    systemId: original.id,
    version: "catalog",
    tools: [
      { agentId: "worker", agentName: "Collecteur", revision: 4, candidate },
      {
        agentId: "other",
        agentName: "Analyste",
        revision: 6,
        candidate: { ...candidate, stage: "active" },
      },
    ],
  });
  equal(store.pendingDecisionCount.value, 1);
  equal(store.currentCounts.value.activeToolCount, 1);
  await store.selectRevision(3);
  equal(store.visibleOperatorTools.value, null);
  equal(store.pendingDecisionCount.value, 1);
  equal(
    store.pendingDecisions.value[0].href,
    `/model?operator=worker&candidate=${candidate.id}&digest=${candidate.digest}`,
  );
  equal(store.currentCounts.value.activeToolCount, 1);
});

Deno.test("the decision menu reads the global repository through the existing endpoint and clears failed reads", async () => {
  const original = snapshot(10);
  original.candidates = [];
  const requests: string[] = [];
  let proposalsAvailable = true;
  const store = createWorkbenchState({
    initialState: original,
    fetch: (path, init) => {
      requests.push(path);
      equal(init?.method, undefined);
      if (path === "/api/model-revisions") {
        equal(init?.cache, "no-store");
        ok(init?.signal);
        return Promise.resolve(
          proposalsAvailable
            ? json({
              version: "commit:head",
              sourceDigest: "source",
              runtime: { active: null, available: null, executable: false },
              proposals: [{
                id: "global-proposal",
                author: "agent:unselected",
                reason: "Update the model",
                status: "proposed",
                sourceDigest: "proposal",
                baseVersion: "commit:base",
                createdAt: "now",
              }],
            })
            : json({ error: "Unavailable" }, 503),
        );
      }
      return Promise.resolve(json({ error: "Not available" }, 404));
    },
  });
  equal(requests.length, 0);
  await store.refreshPendingDecisions();
  equal(store.pendingDecisionCount.value, 1);
  equal(
    store.pendingDecisions.value[0].href,
    "/model?proposal=global-proposal",
  );
  equal(store.pendingDecisionsLoading.value, false);
  equal(requests.filter((path) => path === "/api/model-revisions").length, 1);
  ok(!requests.some((path) => path.startsWith("/api/model-revisions?")));
  proposalsAvailable = false;
  await store.refreshPendingDecisions();
  equal(store.pendingDecisionCount.value, 0);
  equal(
    store.pendingDecisionsError.value,
    "Model proposals could not be loaded.",
  );
  store.dispose();
});

Deno.test("proposal journal events reconcile decisions, coalesce in-flight changes and stop at disposal", async () => {
  const original = snapshot(10);
  original.candidates = [];
  const sources: Events[] = [];
  let status = "proposed";
  let proposalReads = 0;
  let slowRead: ReturnType<typeof deferred<Response>> | null = null;
  const store = createWorkbenchState({
    initialState: original,
    eventSourceFactory: () => {
      const events = new Events();
      sources.push(events);
      return events;
    },
    fetch: (path, init) => {
      equal(init?.method, undefined);
      if (path === "/api/model-revisions") {
        proposalReads++;
        const waiting = slowRead;
        slowRead = null;
        return waiting?.promise ?? Promise.resolve(json({
          proposals: [{ id: "other-tab-proposal", status }],
        }));
      }
      return Promise.resolve(
        path === "/api/state"
          ? json(original)
          : path === "/api/history"
          ? json({ currentRevision: 10, revisions: [] })
          : json({ error: "Not available" }, 404),
      );
    },
  });
  const announce = (events: Events, digest: string) =>
    events.emit("model-version", {
      head: `commit:${"a".repeat(40)}`,
      proposals: { pending: 0, digest: digest.repeat(64) },
    });
  const delivered = async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settle();
  };
  try {
    const stop = store.start();
    await settle();
    equal(store.pendingDecisionCount.value, 1);
    const initialReads = proposalReads;
    store.start();
    equal(sources.length, 1);
    const events = sources[0];
    for (
      const invalid of [null, {}, { proposals: null }, {
        proposals: { digest: "bad" },
      }, { proposals: { digest: 42 } }]
    ) events.emit("model-version", invalid);
    for (const listener of events.listeners.get("model-version") ?? []) {
      listener({ data: "{" });
    }
    await delivered();
    equal(proposalReads, initialReads);

    // The journal changes without a runtime state or conversation change.
    status = "rejected";
    announce(events, "b");
    await delivered();
    equal(store.pendingDecisionCount.value, 0);
    equal(proposalReads, initialReads + 1);
    announce(events, "b");
    await delivered();
    equal(proposalReads, initialReads + 1);

    const pendingRead = deferred<Response>();
    slowRead = pendingRead;
    announce(events, "c");
    await delivered();
    const readsWhilePending = proposalReads;
    announce(events, "d");
    announce(events, "e");
    equal(proposalReads, readsWhilePending);
    pendingRead.resolve(json({
      proposals: [{ id: "other-tab-proposal", status: "proposed" }],
    }));
    await settle();
    equal(proposalReads, readsWhilePending + 1);
    equal(store.pendingDecisionCount.value, 0);

    // A same-digest reconnect still catches up on decisions missed offline.
    status = "proposed";
    events.emit("error");
    events.emit("open");
    announce(events, "e");
    await delivered();
    equal(store.pendingDecisionCount.value, 1);
    equal(proposalReads, readsWhilePending + 2);

    stop();
    const stoppedReads = proposalReads;
    announce(events, "f");
    events.emit("open");
    await delivered();
    equal(proposalReads, stoppedReads);

    const stopAgain = store.start();
    await settle();
    const restartedReads = proposalReads;
    announce(events, "a");
    await delivered();
    equal(proposalReads, restartedReads);
    status = "rejected";
    announce(sources[1], "a");
    await delivered();
    equal(store.pendingDecisionCount.value, 0);
    stopAgain();
  } finally {
    store.dispose();
  }
});

Deno.test("the host's model-version event on the workbench's own connection reaches the pages that follow the model, and a closed connection reaches none", async () => {
  const events = new Events();
  const store = createWorkbenchState({
    initialState: snapshot(1),
    eventSourceFactory: () => events,
    fetch: () => Promise.resolve(json(snapshot(1))),
  });
  const heads: string[] = [];
  const unfollow = modelLive.follow((head) => {
    heads.push(head.version);
  });
  const stop = store.start();
  await settle();
  const head = `commit:${"a".repeat(40)}`;
  events.emit("model-version", { head });
  deepStrictEqual(heads, [head]);
  // Other events of the connection say nothing of the model's versions.
  events.emit("state", snapshot(2));
  deepStrictEqual(heads, [head]);
  stop();
  events.emit("model-version", { head: `commit:${"b".repeat(40)}` });
  deepStrictEqual(heads, [head], "a connection that was let go says nothing");
  unfollow();
});

Deno.test("resource events and every reconnect invalidate without another EventSource or private payload", async () => {
  const events = new Events();
  let connections = 0;
  const store = createWorkbenchState({
    initialState: snapshot(1),
    eventSourceFactory(path) {
      equal(path, "/api/events");
      connections++;
      return events;
    },
    fetch: () => Promise.resolve(json(snapshot(1))),
  });
  const stop = store.start();
  try {
    await settle();
    equal(store.performanceGeneration.value, 0);
    events.emit("open");
    equal(store.performanceGeneration.value, 1);
    events.emit("provider-resources-invalidated", { schemaVersion: 1 });
    equal(store.performanceGeneration.value, 2);
    events.emit("provider-resources-invalidated", {
      schemaVersion: 1,
      caseId: "foreign",
    });
    events.emit("provider-resources-invalidated", { schemaVersion: 2 });
    events.emit("provider-resources-invalidated", null);
    equal(store.performanceGeneration.value, 2);
    events.emit("error");
    events.emit("open");
    equal(store.performanceGeneration.value, 3);
    equal(connections, 1);
    stop();
    events.emit("provider-resources-invalidated", { schemaVersion: 1 });
    events.emit("open");
    equal(store.performanceGeneration.value, 3);
  } finally {
    stop();
  }
});

Deno.test("Case decision uses its own snapshot and never falls back to a same-id Main", async () => {
  const current = snapshot(10);
  const agent: ConversationsSnapshot["conversations"][number] = {
    agentId: "native:builder",
    nativeId: "native:builder",
    name: "BO",
    responsibility: "Build",
    primary: true,
    canSend: true,
    revision: 10,
    busy: false,
    phase: "Ready",
    modelDigest: "m",
    messages: [],
    proposalContext: {
      configurationRevision: 1,
      before: {
        network: { allowedHosts: [] },
        builder: { admissionAuthority: "human" },
      },
      changes: [{
        id: "change",
        kind: "mandate-change",
        status: "pending",
        caseId: "C",
        requestedBy: "native:builder",
        baseModelDigest: "a".repeat(64),
        baseRevision: 1,
        reason: "Host",
        requestedAt: "2026-10-30T00:00:00Z",
        diff: {
          title: "Host",
          author: "native:builder",
          base: {
            repositoryVersion: `commit:${"a".repeat(40)}`,
            modelDigest: "a".repeat(64),
            sourceDigest: "b".repeat(64),
          },
          sourceDigest: "c".repeat(64),
          files: [],
          patch: "",
          additions: 0,
          deletions: 0,
        },
        requestedRights: { addNetworkHosts: ["example.org"] },
      }],
    },
  };
  const threads: ConversationsSnapshot = {
    systemId: current.id,
    defaultAgentId: agent.agentId,
    version: "v",
    conversations: [agent],
  };
  const writes: string[] = [];
  const store = createWorkbenchState({
    initialState: current,
    fetch: (path, init) => {
      if (init?.method === "POST") {
        writes.push(path);
        return Promise.resolve(
          json({
            status: "published-awaiting-adoption",
            caseId: "C",
            changeId: "change",
          }),
        );
      }
      return Promise.resolve(json(threads));
    },
  });
  store.agentConversations.accept(threads);
  equal(
    await store.decideOperatorChange(agent, "change", "approve", "C"),
    false,
  );
  equal(writes.length, 0);
  store.requests.snapshots.value = new Map([["C", threads]]);
  equal(
    await store.decideOperatorChange(agent, "change", "approve", "C"),
    true,
  );
  equal(
    writes[0],
    "/api/conversations/native%3Abuilder/changes/change/decision?space=requests",
  );
  equal(
    store.caseChangeResult.value?.message,
    "Decision sent; checking application status.",
  );
});

Deno.test("reload reads durable Case status and retries without reconstructing approval", async () => {
  const writes: Array<{ path: string; body: unknown }> = [];
  let status = "blocked";
  const store = createWorkbenchState({
    initialState: snapshot(1),
    fetch: (path, init) => {
      if (init?.method === "POST") {
        writes.push({ path, body: JSON.parse(String(init.body)) });
        status = "adopted";
      }
      if (path.includes("/changes/")) {
        return Promise.resolve(
          json({
            caseId: "C",
            changeId: "ch",
            status,
            canResume: status === "blocked",
          }),
        );
      }
      if (path === "/api/case-model/C") {
        const version = `commit:${"b".repeat(40)}`;
        return Promise.resolve(
          json({
            caseId: "C",
            branchId: "branch",
            executionSpaceId: "space",
            branchVersion: version,
            executionVersion: version,
            version,
            release: null,
            readOnly: true,
          }),
        );
      }
      return Promise.resolve(
        json({
          systemId: "fixture",
          version: "v",
          defaultAgentId: "a",
          conversations: [],
        }),
      );
    },
  });
  store.requests.sessionReady.value = true;
  store.requests.snapshots.value = new Map([["C", requestConversation()]]);
  await store.loadCaseChangeStatus("C", "a", "ch");
  equal(store.caseChangeStatus("C", "a", "ch")?.status, "blocked");
  equal(await store.resumeCaseChange("C", "a", "ch"), true);
  equal(store.caseChangeStatus("C", "a", "ch")?.status, "adopted");
  equal(
    store.requests.scopes.value.get("C")?.executionVersion,
    `commit:${"b".repeat(40)}`,
  );
  deepStrictEqual(writes, [{
    path: "/api/conversations/a/changes/ch/decision/resume?space=requests",
    body: { caseId: "C" },
  }]);
  equal(await store.resumeCaseChange("C", "a", "ch"), false);
  equal(writes.length, 1);
});

Deno.test("late Case status and retry responses cannot cross a session or host change", async () => {
  const pending = deferred<Response>();
  const store = createWorkbenchState({
    initialState: snapshot(1),
    fetch: () => pending.promise,
  });
  store.requests.sessionReady.value = true;
  const read = store.loadCaseChangeStatus("C", "a", "ch");
  store.requests.sessionGeneration.value++;
  pending.resolve(
    json({ caseId: "C", changeId: "ch", status: "adopted", canResume: false }),
  );
  await read;
  equal(store.caseChangeStatus("C", "a", "ch"), undefined);

  const retryResponse = deferred<Response>();
  const retryStore = createWorkbenchState({
    initialState: snapshot(1),
    fetch: (_path, init) =>
      init?.method === "POST" ? retryResponse.promise : Promise.resolve(
        json({
          caseId: "C",
          changeId: "ch",
          status: "blocked",
          canResume: true,
        }),
      ),
  });
  retryStore.requests.sessionReady.value = true;
  retryStore.requests.snapshots.value = new Map([["C", requestConversation()]]);
  await retryStore.loadCaseChangeStatus("C", "a", "ch");
  const retry = retryStore.resumeCaseChange("C", "a", "ch");
  retryStore.requests.context.value = { projectId: "other", systemId: "other" };
  retryResponse.resolve(
    json({ caseId: "C", changeId: "ch", status: "adopted", canResume: false }),
  );
  equal(await retry, false);
  equal(retryStore.caseChangeStatus("C", "a", "ch"), undefined);
});

Deno.test("newer Case status wins when concurrent reads resolve in reverse order", async () => {
  const older = deferred<Response>();
  const newer = deferred<Response>();
  let calls = 0;
  const store = createWorkbenchState({
    initialState: snapshot(1),
    fetch: () => ++calls === 1 ? older.promise : newer.promise,
  });
  store.requests.sessionReady.value = true;
  const first = store.loadCaseChangeStatus("C", "a", "ch");
  const second = store.loadCaseChangeStatus("C", "a", "ch");
  newer.resolve(
    json({ caseId: "C", changeId: "ch", status: "adopted", canResume: false }),
  );
  await second;
  older.resolve(
    json({ caseId: "C", changeId: "ch", status: "blocked", canResume: true }),
  );
  await first;
  equal(store.caseChangeStatus("C", "a", "ch")?.status, "adopted");
});

Deno.test("retry fences pre-existing and in-flight status reads before loading its durable result", async () => {
  const older = deferred<Response>();
  const during = deferred<Response>();
  const mutation = deferred<Response>();
  let reads = 0;
  const store = createWorkbenchState({
    initialState: snapshot(1),
    fetch: (path, init) => {
      if (init?.method === "POST") return mutation.promise;
      if (path.includes("/changes/")) {
        reads++;
        if (reads === 1) {
          return Promise.resolve(
            json({
              caseId: "C",
              changeId: "ch",
              status: "blocked",
              canResume: true,
            }),
          );
        }
        if (reads === 2) return older.promise;
        if (reads === 3) return during.promise;
        return Promise.resolve(
          json({
            caseId: "C",
            changeId: "ch",
            status: "adopted",
            canResume: false,
          }),
        );
      }
      return Promise.resolve(
        json({
          systemId: "fixture",
          version: "v",
          defaultAgentId: "a",
          conversations: [],
        }),
      );
    },
  });
  store.requests.sessionReady.value = true;
  store.requests.snapshots.value = new Map([["C", requestConversation()]]);
  await store.loadCaseChangeStatus("C", "a", "ch");
  const preMutation = store.loadCaseChangeStatus("C", "a", "ch");
  const retry = store.resumeCaseChange("C", "a", "ch");
  const duringMutation = store.loadCaseChangeStatus("C", "a", "ch");
  mutation.resolve(
    json({ caseId: "C", changeId: "ch", status: "adopted", canResume: false }),
  );
  equal(await retry, true);
  older.resolve(
    json({ caseId: "C", changeId: "ch", status: "blocked", canResume: true }),
  );
  during.resolve(
    json({ caseId: "C", changeId: "ch", status: "blocked", canResume: true }),
  );
  await Promise.all([preMutation, duringMutation]);
  equal(store.caseChangeStatus("C", "a", "ch")?.status, "adopted");
});

const caseVersion = (letter: string) => `commit:${letter.repeat(40)}`;
function caseScope(caseId: string, execution: string, branch = execution) {
  return {
    caseId,
    branchId: `branch-${caseId}`,
    executionSpaceId: `space-${caseId}`,
    branchVersion: branch,
    executionVersion: execution,
    version: execution,
    release: null,
    readOnly: true,
  };
}
/** A host whose Case scopes move when the test says; every other read is the state. */
function caseHost(initial: Record<string, string>) {
  const runs = { ...initial };
  const reads: string[] = [];
  const fetch: Fetcher = (path) => {
    const match = /^\/api\/case-model\/([^/?]+)$/.exec(path);
    if (match) {
      reads.push(match[1]);
      const execution = runs[match[1]];
      return Promise.resolve(
        execution
          ? json(caseScope(match[1], execution))
          : json({ code: "CASE_MODEL_UNAVAILABLE" }, 404),
      );
    }
    return Promise.resolve(json(snapshot(1)));
  };
  return { runs, reads, fetch };
}
const caseEvent = (caseId: string, execution: string, branch = execution) => ({
  schemaVersion: 1,
  caseId,
  branchVersion: branch,
  executionVersion: execution,
});

Deno.test("a Case's model event reads its held scope again in place and tells that Case's pages only; an invalid one tells nothing", async () => {
  const events = new Events();
  const host = caseHost({ A: caseVersion("a"), B: caseVersion("c") });
  const store = createWorkbenchState({
    initialState: snapshot(1),
    eventSourceFactory: () => events,
    fetch: host.fetch,
  });
  const stop = store.start();
  const heads: string[] = [];
  const others: string[] = [];
  const main: string[] = [];
  const unfollow = [
    store.caseModelLive("A").follow((head) => heads.push(head.version)),
    store.caseModelLive("B").follow((head) => others.push(head.version)),
    modelLive.follow((head) => main.push(head.version)),
  ];
  try {
    await settle();
    await store.requests.loadScope("A");
    equal(
      store.requests.scopes.value.get("A")?.executionVersion,
      caseVersion("a"),
    );
    host.runs.A = caseVersion("b");
    events.emit("case-model-version", caseEvent("A", caseVersion("b")));
    // The held scope stays on show while it is read again.
    equal(
      store.requests.scopes.value.get("A")?.executionVersion,
      caseVersion("a"),
    );
    deepStrictEqual(heads, [caseVersion("b")]);
    await settle();
    equal(
      store.requests.scopes.value.get("A")?.executionVersion,
      caseVersion("b"),
    );
    deepStrictEqual(others, [], "another Case hears nothing");
    deepStrictEqual(main, [], "the main pages hear nothing of a Case");
    deepStrictEqual(host.reads, ["A", "A"]);
    // A Case whose scope is not held is not read; its pages still hear it.
    events.emit("case-model-version", caseEvent("B", caseVersion("d")));
    await settle();
    deepStrictEqual(others, [caseVersion("d")]);
    equal(store.requests.scopes.value.has("B"), false);
    deepStrictEqual(host.reads, ["A", "A"]);
    // What is not a valid announcement is not heard, nor read.
    for (
      const value of [
        { ...caseEvent("A", caseVersion("e")), ownerId: "owner" },
        caseEvent("A", "branch:main"),
        caseEvent("../A", caseVersion("e")),
        { ...caseEvent("A", caseVersion("e")), schemaVersion: 2 },
        null,
      ]
    ) events.emit("case-model-version", value);
    for (const listener of events.listeners.get("case-model-version") ?? []) {
      listener({ data: "not json" });
    }
    await settle();
    deepStrictEqual(heads, [caseVersion("b")]);
    deepStrictEqual(host.reads, ["A", "A"]);
    stop();
    events.emit("case-model-version", caseEvent("A", caseVersion("f")));
    deepStrictEqual(
      heads,
      [caseVersion("b")],
      "a closed connection says nothing",
    );
  } finally {
    for (const release of unfollow) release();
    stop();
  }
});

Deno.test("a new Request session opens the stream again, and the stream it replaces says nothing", async () => {
  const sources: Events[] = [];
  const host = caseHost({ A: caseVersion("a") });
  const store = createWorkbenchState({
    initialState: snapshot(1),
    eventSourceFactory(path) {
      equal(path, "/api/events");
      const events = new Events();
      sources.push(events);
      return events;
    },
    fetch: host.fetch,
  });
  const stop = store.start();
  const heads: string[] = [];
  const unfollow = store.caseModelLive("A").follow((head) => {
    heads.push(head.version);
  });
  try {
    await settle();
    sources[0].emit("open");
    equal(sources.length, 1);
    store.requests.sessionGeneration.value++;
    equal(sources.length, 2);
    ok(sources[0].closed);
    sources[0].emit("case-model-version", caseEvent("A", caseVersion("b")));
    deepStrictEqual(heads, []);
    sources[1].emit("case-model-version", caseEvent("A", caseVersion("c")));
    deepStrictEqual(heads, [caseVersion("c")]);
    stop();
    ok(sources[1].closed);
    store.requests.sessionGeneration.value++;
    equal(sources.length, 2, "a stopped workbench opens nothing");
  } finally {
    unfollow();
    stop();
  }
});

Deno.test("a reconnection reads the shown Cases again and tells their pages where they now stand", async () => {
  const events = new Events();
  const host = caseHost({ A: caseVersion("a"), B: caseVersion("a") });
  const store = createWorkbenchState({
    initialState: snapshot(1),
    eventSourceFactory: () => events,
    fetch: host.fetch,
  });
  const stop = store.start();
  const heads: string[] = [];
  const unfollow = store.caseModelLive("A").follow((head) => {
    heads.push(head.version);
  });
  // A Case no page shows any more is not read again.
  store.caseModelLive("B").follow(() => {})();
  try {
    await settle();
    events.emit("open");
    await settle();
    deepStrictEqual(host.reads, [], "the first connection missed nothing");
    host.runs.A = caseVersion("b");
    events.emit("error");
    events.emit("open");
    await settle();
    deepStrictEqual(host.reads, ["A"]);
    deepStrictEqual(heads, [caseVersion("b")]);
    equal(
      store.requests.scopes.value.get("A")?.executionVersion,
      caseVersion("b"),
    );
  } finally {
    unfollow();
    stop();
  }
});
