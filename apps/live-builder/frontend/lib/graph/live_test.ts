import { settle } from "../../test/support/settle.ts";
import { deepStrictEqual, equal, throws } from "node:assert/strict";
import {
  bindLiveSource,
  createLiveSync,
  graphSource,
  type LiveStatus as Status,
  parseGraphSnapshot,
} from "./live.ts";
import type { GraphSnapshot as Snapshot } from "./types.ts";

Deno.test("native graph transport retains exact source queries and rejects unknown routing", () => {
  deepStrictEqual(graphSource("/api/model-graph"), {
    path: "/api/model-graph",
    historical: false,
  });
  deepStrictEqual(
    graphSource("/api/model-graph?modelVersion=branch%3Anative"),
    { path: "/api/model-graph?modelVersion=branch%3Anative", historical: true },
  );
  equal(graphSource("/api/model-graph?revision=4").historical, true);
  for (
    const path of [
      "/graph",
      "https://other.invalid/api/model-graph",
      "/api/model-graph?revision=1&revision=2",
      "/api/model-graph?modelVersion=x&revision=2",
      "/api/model-graph?unknown=x",
    ]
  ) throws(() => graphSource(path), /Invalid projection source/);
});
Deno.test("native graph parser requires a complete projection contract before rendering", () => {
  const snapshot = {
    graph: {
      nodes: [{ id: "native", label: "<script>text</script>" }],
      edges: [],
    },
    version: "version",
    projectionDigest: "digest",
    history: null,
    error: null,
  };
  equal(parseGraphSnapshot(snapshot), snapshot);
  equal(
    parseGraphSnapshot({
      ...snapshot,
      history: { revision: 2, recordedAt: "now" },
    }).history?.revision,
    2,
  );
  for (
    const value of [
      null,
      {},
      { ...snapshot, error: undefined },
      { ...snapshot, history: undefined },
      { ...snapshot, version: {} },
      { ...snapshot, graph: { nodes: [{}], edges: [] } },
      { ...snapshot, graph: { nodes: [], edges: [{ id: "broken" }] } },
    ]
  ) throws(() => parseGraphSnapshot(value), /Invalid native projection/);
});

function nativeSequence() {
  return {
    id: "native-sequence",
    name: "Declared exchange",
    lifelines: [
      { id: "caller", name: "Caller" },
      { id: "worker", name: "Worker" },
    ],
    messages: [
      { id: "request", name: "Request", from: "caller", to: "worker" },
      { id: "response", name: "Response", from: "worker", to: "caller" },
    ],
  };
}

function observedSequence() {
  const receipt = (
    id: string,
    name: string,
    from: string,
    to: string,
    at: string,
  ) => ({
    id: `message:${id}`,
    name,
    from,
    to,
    payloadId: "",
    payloadName: "",
    kind: "message",
    recordId: id,
    at,
    modelDigest: "exact-admitted-contract",
    repositoryVersion: "branch:recorded-source",
    evidence: {
      messageId: id,
      nativeSourceIds: ["builder-native"],
      sourceContextCount: 12,
    },
  });
  return {
    id: "observed:session",
    name: "Recorded activity",
    origin: "observed",
    revision: 8,
    busy: false,
    phase: "Prêt à discuter",
    lastActivityAt: "2026-10-21T10:23:01.000Z",
    total: 3,
    omitted: 0,
    limit: 150,
    diagnostics: [],
    lifelines: [
      {
        id: "user",
        name: "Utilisateur",
        typeId: "",
        typeName: "",
        origin: "external",
      },
      {
        id: "builder-native",
        nativeId: "builder-native",
        name: "Constructeur",
        typeId: "builder-type",
        typeName: "ConversationBuilder",
        origin: "native",
      },
    ],
    messages: [
      receipt(
        "ask",
        "Construire",
        "user",
        "builder-native",
        "2026-10-21T10:23:00.000Z",
      ),
      receipt(
        "reply",
        "Construit",
        "builder-native",
        "user",
        "2026-10-21T10:23:01.000Z",
      ),
      {
        id: "event:testing",
        name: "Essais réussis",
        from: "builder-native",
        to: "builder-native",
        payloadId: "",
        payloadName: "",
        kind: "event",
        eventKind: "tool-tested",
        recordId: "testing",
        sourceEventId: "testing",
        at: "2026-10-21T10:23:00.500Z",
        actionId: "test-action",
        modelDigest: "exact-admitted-contract",
        repositoryVersion: "branch:recorded-source",
        evidence: {
          eventId: "testing",
          nativeSourceIds: ["test-action", "test-allocation"],
          sourceContextCount: 12,
        },
      },
    ],
  };
}

function snapshot(sequence: unknown, observed = false) {
  return {
    graph: {
      nodes: [],
      edges: [],
      ...(observed
        ? { executionSequences: [sequence] }
        : { sequences: [sequence] }),
    },
    version: "branch:snapshot",
    projectionDigest: "projection-digest",
    history: null,
    error: null,
  };
}

function rejectsSequence(sequence: unknown, observed = false) {
  throws(
    () => parseGraphSnapshot(snapshot(sequence, observed)),
    /Invalid native projection/,
  );
}

Deno.test("sequence transport keeps legacy native records and native ordering metadata", () => {
  const basic = snapshot(nativeSequence());
  equal(parseGraphSnapshot(basic), basic);
  for (
    const ordering of [
      "declaration",
      "native-partial-order",
      "cyclic",
      "non-linearizable",
    ]
  ) {
    const declared = snapshot({
      ...nativeSequence(),
      nativeId: "native-sequence",
      ordering,
      diagnostics: ordering === "cyclic" ? ["Native succession cycle"] : [],
      sourceIds: ["native-source"],
    });
    equal(parseGraphSnapshot(declared), declared);
  }
});

Deno.test("sequence transport retains recorded return arrows, event notes and receipt identity without mutation", () => {
  const sequence = observedSequence();
  const value = snapshot(sequence, true);
  const before = structuredClone(value);
  const result = parseGraphSnapshot(value);
  equal(result, value);
  equal(result.graph.executionSequences?.[0], sequence);
  deepStrictEqual(value, before);
  // Transport validates the projection; it does not sort its source records.
  deepStrictEqual(
    result.graph.executionSequences?.[0].messages.map((message) => message.id),
    [
      "message:ask",
      "message:reply",
      "event:testing",
    ],
  );
});

Deno.test("sequence transport rejects duplicate identities and unresolved endpoints", () => {
  const native = nativeSequence();
  for (
    const value of [
      { ...native, id: "" },
      { ...native, lifelines: [native.lifelines[0], native.lifelines[0]] },
      { ...native, messages: [native.messages[0], native.messages[0]] },
      { ...native, messages: [{ ...native.messages[0], from: "missing" }] },
      { ...native, messages: [{ ...native.messages[0], to: "missing" }] },
    ]
  ) rejectsSequence(value);

  const observed = observedSequence();
  rejectsSequence({
    ...observed,
    messages: observed.messages.map((message) => ({
      ...message,
      recordId: "same-receipt",
      ...(message.kind === "event" ? { sourceEventId: "same-receipt" } : {}),
      evidence: {
        ...message.evidence,
        ...(message.kind === "event"
          ? { eventId: "same-receipt" }
          : { messageId: "same-receipt" }),
      },
    })),
  }, true);
  rejectsSequence({
    ...observed,
    lifelines: [...observed.lifelines, observed.lifelines[0]],
  }, true);
});

Deno.test("sequence transport validates metadata and never accepts an observed trace as a native scenario", () => {
  const native = nativeSequence();
  for (
    const value of [
      { ...native, ordering: "executed" },
      { ...native, diagnostics: [false] },
      { ...native, sourceIds: "source" },
      { ...native, nativeId: {} },
      { ...native, lifelines: [{ id: "caller", name: {} }] },
      { ...native, messages: [{ ...native.messages[0], name: null }] },
      { ...native, messages: [{ ...native.messages[0], sourceIds: [3] }] },
      { ...native, origin: "unverified" },
      observedSequence(),
    ]
  ) rejectsSequence(value);
  rejectsSequence({ ...observedSequence(), origin: "native" }, true);
  rejectsSequence({ ...observedSequence(), origin: undefined }, true);
});

Deno.test("sequence transport enforces observed receipt semantics without inventing event arrows", () => {
  const observed = observedSequence();
  const [request, response, event] = observed.messages;
  for (
    const bad of [
      { ...request, kind: "observation" },
      { ...request, at: 12 },
      { ...request, actionId: {} },
      { ...request, repositoryVersion: 3 },
      { ...request, modelDigest: [] },
      {
        ...request,
        evidence: { ...request.evidence, messageId: "another-message" },
      },
      { ...request, evidence: { nativeSourceIds: [], sourceContextCount: 0 } },
      { ...event, to: "user" },
      { ...event, eventKind: undefined },
      { ...event, sourceEventId: "another-event" },
      { ...event, evidence: { ...event.evidence, eventId: "another-event" } },
      { ...event, evidence: { ...event.evidence, nativeSourceIds: [false] } },
      { ...event, evidence: { ...event.evidence, sourceContextCount: -1 } },
    ]
  ) rejectsSequence({ ...observed, messages: [bad, response], total: 2 }, true);
});

Deno.test("sequence transport checks the retention boundary and explicit total instead of dropping records", () => {
  const observed = observedSequence();
  const first = observed.messages[0];
  const messages = Array.from({ length: 150 }, (_, index) => ({
    ...first,
    id: `message:kept-${index}`,
    recordId: `kept-${index}`,
    evidence: { ...first.evidence, messageId: `kept-${index}` },
  }));
  const retained = snapshot(
    { ...observed, messages, total: 400, omitted: 250 },
    true,
  );
  equal(parseGraphSnapshot(retained), retained);
  for (
    const patch of [
      {
        messages: [...messages, {
          ...messages[0],
          id: "message:extra",
          recordId: "extra",
          evidence: { ...first.evidence, messageId: "extra" },
        }],
        total: 151,
        omitted: 0,
      },
      { limit: 151 },
      { total: 2 },
      { total: 4, omitted: 0 },
      { omitted: -1 },
      { revision: -1 },
      { revision: 1.5 },
      { total: Number.POSITIVE_INFINITY },
      { busy: "false" },
      { phase: null },
    ]
  ) rejectsSequence({ ...observed, ...patch }, true);
});

Deno.test("sequence transport keeps unknown-time receipts and untrusted text as data", () => {
  const observed = observedSequence();
  const input = snapshot({
    ...observed,
    name: "<script>not markup</script>",
    diagnostics: ["An invalid source timestamp was retained"],
    messages: observed.messages.map((message, index) =>
      index === 0
        ? {
          ...message,
          at: "unknown source time",
          name: "<img src=x onerror=alert(1)>",
        }
        : message
    ),
  }, true);
  equal(parseGraphSnapshot(input), input);
  equal(
    parseGraphSnapshot(input).graph.executionSequences?.[0].messages[0].at,
    "unknown source time",
  );
  rejectsSequence({ ...observed, lastActivityAt: "unknown source time" }, true);
});

Deno.test("sequence transport rejects malformed collection fields instead of silently ignoring them", () => {
  const base = snapshot(nativeSequence());
  for (
    const patch of [
      { sequences: {} },
      { sequences: [null] },
      { executionSequences: {} },
      { executionSequences: [nativeSequence()] },
      { sequenceDiagnostics: "diagnostic" },
      { sequenceDiagnostics: [null] },
    ]
  ) {
    throws(
      () => parseGraphSnapshot({ ...base, graph: { ...base.graph, ...patch } }),
      /Invalid native projection/,
    );
  }
  const duplicateNative = {
    ...base,
    graph: { ...base.graph, sequences: [nativeSequence(), nativeSequence()] },
  };
  throws(
    () => parseGraphSnapshot(duplicateNative),
    /Invalid native projection/,
  );
});

Deno.test("sequence enum values are validated without coercing arrays or objects", () => {
  rejectsSequence({ ...nativeSequence(), ordering: ["cyclic"] });
  const native = nativeSequence();
  rejectsSequence({
    ...native,
    lifelines: [
      { ...native.lifelines[0], origin: ["native"] },
      native.lifelines[1],
    ],
  });
  const observed = observedSequence();
  rejectsSequence({
    ...observed,
    messages: observed.messages.map((message, index) =>
      index === 0 ? { ...message, kind: ["message"] } : message
    ),
  }, true);
});

Deno.test("native optional receipt metadata is validated when present", () => {
  const native = nativeSequence();
  rejectsSequence({
    ...native,
    messages: [
      { ...native.messages[0], evidence: { nativeSourceIds: [42] } },
      native.messages[1],
    ],
  });
});

class FakeSource {
  listeners = new Map<string, (event: { data: string }) => unknown>();
  onopen: (() => unknown) | null = null;
  onerror: (() => unknown) | null = null;
  addEventListener(
    name: string,
    listener: (event: { data: string }) => unknown,
  ) {
    this.listeners.set(name, listener);
  }
  emit(name: string, data: unknown) {
    return this.listeners.get(name)?.({ data: JSON.stringify(data) });
  }
}
function assert(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}
const liveSnapshot = (digest: string, error?: string): Snapshot => ({
  version: digest,
  history: null,
  projectionDigest: digest,
  graph: { nodes: [], edges: [] },
  error: error ?? null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}
function setup(readState: () => Promise<Snapshot>, initial = "A") {
  let digest = initial;
  let layouts = 0;
  const applied: string[] = [];
  const statuses: Status[] = [];
  const sync = createLiveSync({
    readState,
    getDigest: () => digest,
    applyState: (state, changed) => {
      applied.push(state.projectionDigest);
      if (changed) layouts++;
      digest = state.projectionDigest;
    },
    onStatus: (status) => statuses.push(status),
  });
  const source = new FakeSource();
  bindLiveSource(source, sync);
  return {
    source,
    sync,
    applied,
    statuses,
    get digest() {
      return digest;
    },
    get layouts() {
      return layouts;
    },
    get status() {
      return statuses.at(-1)!;
    },
  };
}
Deno.test("SSE burst during a read coalesces into a second fresh read", async () => {
  const reads: ReturnType<typeof deferred<Snapshot>>[] = [];
  const live = setup(() => {
    const read = deferred<Snapshot>();
    reads.push(read);
    return read.promise;
  }, "initial");
  const opening = live.source.onopen!();
  await settle(1);
  assert(reads.length === 1, "Initial reconciliation did not start");
  live.source.emit("model", { version: "B" });
  live.source.emit("model", { version: "C" });
  reads[0].resolve(liveSnapshot("A"));
  await settle(1);
  assert(Number(reads.length) === 2, "Burst was dropped or not coalesced");
  reads[1].resolve(liveSnapshot("C"));
  await opening;
  assert(live.digest === "C", "Viewer remained stuck on the earlier snapshot");
  assert(live.applied.join(",") === "A,C", "Unexpected snapshot sequence");
});
Deno.test("reconnect reconciles missed events; unchanged digest preserves layout", async () => {
  let backend = "A";
  let reads = 0;
  const live = setup(() => {
    reads++;
    return Promise.resolve(liveSnapshot(backend));
  });
  await live.source.onopen!();
  assert(live.layouts === 0, "Unchanged initial snapshot rebuilt the graph");
  live.source.onerror!();
  assert(live.status.stale && !live.status.connected, "Disconnect not visible");
  backend = "B"; // There is deliberately no model event while disconnected.
  await live.source.onopen!();
  assert(reads === 2 && live.digest === "B", "Reconnect missed current state");
  assert(Number(live.layouts) === 1, "Changed snapshot did not update once");
  assert(!live.status.stale && live.status.connected, "Reconnect stayed stale");
  await live.source.emit("model", { version: "B", error: null });
  assert(Number(live.layouts) === 1, "Same-hash recovery rebuilt the layout");
});
Deno.test("model-error cannot be erased by an older read; same-hash recovery works", async () => {
  const pending = deferred<Snapshot>();
  let reads = 0;
  const live = setup(() =>
    ++reads === 1 ? pending.promise : Promise.resolve(liveSnapshot("A"))
  );
  const opening = live.source.onopen!();
  await settle(1);
  live.source.emit("model-error", { message: "SysON unavailable" });
  pending.resolve(liveSnapshot("A"));
  await opening;
  assert(live.status.stale, "Older successful read erased newer model error");
  assert(live.status.message === "SysON unavailable", "Model error was lost");
  await live.source.emit("model", { version: "A", error: null });
  assert(!live.status.stale, "Same-hash model recovery remained stale");
  assert(live.layouts === 0, "Error recovery rebuilt an unchanged projection");
});
Deno.test("read failures and server error snapshots stay stale until valid recovery", async () => {
  let mode = "http-error";
  const live = setup(() => {
    if (mode === "http-error") throw new Error("HTTP 503");
    return Promise.resolve(
      mode === "model-error"
        ? liveSnapshot("B", "Native model unreadable")
        : liveSnapshot("A"),
    );
  });
  await live.source.onopen!();
  assert(
    live.status.stale && live.status.message === "HTTP 503",
    "Read failure hidden",
  );
  mode = "model-error";
  await live.source.emit("model", {
    version: "B",
    error: "Native model unreadable",
  });
  assert(
    live.applied.length === 0,
    "Server-error snapshot was rendered as current",
  );
  assert(
    live.status.stale && live.status.message === "Native model unreadable",
    "Server error hidden",
  );
  mode = "healthy";
  await live.source.emit("model", { version: "A", error: null });
  assert(!live.status.stale && live.digest === "A", "Valid recovery failed");
  assert(live.layouts === 0, "Unchanged recovery rebuilt the graph");
});

Deno.test("disposing a graph source suppresses its late read and status updates", async () => {
  const pending = deferred<Snapshot>();
  const live = setup(() => pending.promise);
  const opening = live.source.onopen!();
  await settle(1);
  const statuses = live.statuses.length;
  live.sync.dispose();
  pending.resolve(liveSnapshot("late"));
  await opening;
  assert(
    live.applied.length === 0,
    "An unmounted source applied its late model",
  );
  assert(
    live.statuses.length === statuses,
    "An unmounted source changed status",
  );
  await live.sync.request();
  assert(live.applied.length === 0, "A disposed source restarted");
});
