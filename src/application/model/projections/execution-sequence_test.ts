import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { projectExecutionSequence } from "./execution-sequence.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { ModelIdentity } from "../../../domain/shared-kernel/model-identity.ts";
import type { SourceGraph } from "../../../domain/model/records/source-graph.ts";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";

function fixture() {
  const identity: ModelIdentity = {
    projectId: "test-model",
    editingContextId: "test-model",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "native-builder",
  };
  const executionModel = executableFixture(identity);
  const action = executionModel.flows.promotion.nodes.find((node) =>
    node.kind === "action"
  )!;
  action.performerId = "native-sandbox";
  action.allocationId = "native-allocation";
  action.name = "Tester le candidat";
  const state: SystemRuntimeState = {
    id: "session",
    revision: 42,
    catalogRevision: 1,
    busy: false,
    phase: "En attente",
    provider: "recorded-fixture",
    model: identity,
    executionModel,
    messages: [],
    events: [],
    candidates: [],
  };
  const graph: SourceGraph = {
    title: "Test",
    sourceFile: "fixture.sysml",
    projectionNote: "test-only fixture",
    edges: [],
    scopes: [],
    packages: [],
    levels: [],
    diagnostics: [],
    views: [],
    identity,
    sequences: [],
    sequenceDiagnostics: [],
    nodes: [["native-builder", "Constructeur"], ["native-sandbox", "Sandbox"]]
      .map(([nativeId, label]) => ({
        id: `use:${nativeId}`,
        nativeId,
        label,
        metaclass: "PartUsage",
        kind: "part-usage",
        category: "part",
        symbol: "part",
        role: "usage",
        dimension: "structure",
        origin: "declared",
        provenance: "ASE",
        description: "",
        contextPath: ["system", nativeId],
        declaredDirection: "",
        isReference: false,
        source: {
          file: "fixture.sysml",
          line: nativeId,
          quote: "",
          native: true,
        },
        level: 1,
        parentId: "system",
        subsystem: "test",
        packageId: "test",
      })),
  };
  return { state, graph, action, digest: executionModel.version.digest };
}

Deno.test("recorded chat roles create only the persisted conversation arrows", () => {
  const { state, graph, digest } = fixture();
  state.messages = [
    {
      id: "m1",
      role: "user",
      text: "Construis un lecteur",
      at: "2026-10-21T10:00:00.000Z",
      execution: { digest },
    },
    {
      id: "m2",
      role: "assistant",
      text: "Je propose ce candidat",
      at: "2026-10-21T10:00:02.000Z",
      execution: { digest },
    },
    {
      id: "m3",
      role: "tool",
      text: "Essais réussis, admission attendue",
      at: "2026-10-21T10:00:03.000Z",
      execution: { digest },
    },
  ];
  const before = JSON.stringify({ state, graph });
  const result = projectExecutionSequence(state, graph);
  equal(result.origin, "observed");
  equal(result.id, "observed:session");
  equal(result.messages.length, 3);
  deepStrictEqual(
    result.messages.map((message) => [message.kind, message.from, message.to]),
    [
      ["message", "observed:session:user", "native-builder"],
      ["message", "native-builder", "observed:session:user"],
      ["message", "observed:session:host", "native-builder"],
    ],
  );
  equal(result.messages[2].name, state.messages[2].text);
  equal(result.messages[2].evidence.messageId, "m3");
  equal(
    result.lifelines.find((line) => line.id === "observed:session:user")!
      .origin,
    "external",
  );
  equal(
    result.lifelines.find((line) => line.id === "observed:session:host")!
      .origin,
    "host",
  );
  equal(JSON.stringify({ state, graph }), before);
});

Deno.test("observed actions become event notes on their admitted native allocation", () => {
  const { state, graph, action, digest } = fixture();
  state.events = [
    {
      id: "e1",
      kind: "flow-action",
      label: "Promotion : action",
      at: "2026-10-21T10:00:01.000Z",
      execution: {
        digest,
        actionId: action.nativeId,
        sourceIds: ["persisted-source"],
      },
    },
    {
      id: "edge",
      kind: "flow-edge",
      label: "Edge",
      at: "2026-10-21T10:00:01.500Z",
      execution: { digest, edgeId: "edge-id" },
    },
    {
      id: "e2",
      kind: "tool-active",
      label: "Lecteur disponible",
      at: "2026-10-21T10:00:02.000Z",
    },
    {
      id: "e3",
      kind: "flow-suspended",
      label: "Attente",
      at: "2026-10-21T10:00:03.000Z",
      execution: { digest, actionId: action.nativeId },
    },
    {
      id: "e4",
      kind: "flow-completed",
      label: "Terminé",
      at: "2026-10-21T10:00:04.000Z",
      execution: { digest },
    },
  ];
  const result = projectExecutionSequence(state, graph);
  equal(result.messages.length, 4);
  const event = result.messages[0];
  equal(event.kind, "event");
  equal(event.from, "native-sandbox");
  equal(event.to, "native-sandbox");
  equal(event.actionId, action.nativeId);
  equal(event.sourceEventId, "e1");
  equal(event.evidence.eventId, "e1");
  deepStrictEqual(event.evidence.nativeSourceIds, [
    action.nativeId,
    "native-allocation",
    "native-sandbox",
  ]);
  equal(event.evidence.sourceContextCount, 1);
  ok(event.name.includes("Tester le candidat"));
  equal(result.messages[1].from, "observed:session:host");
  equal(result.messages[1].to, "observed:session:host");
  equal(result.messages[1].name, "Lecteur disponible");
  ok(result.messages.every((message) => message.kind === "event"));
});

Deno.test("observed traces retain Case correlation without assigning legacy records", () => {
  const { state, graph, digest } = fixture();
  state.messages = [{
    id: "legacy",
    role: "user",
    text: "Earlier",
    at: "2026-10-24T00:00:00.000Z",
  }, {
    id: "current",
    role: "assistant",
    text: "Case #2 : résultat",
    at: "2026-10-24T00:00:01.000Z",
    caseId: "session:case:2",
    execution: { digest },
  }];
  state.events = [{
    id: "execution",
    kind: "flow-action",
    label: "Action",
    at: "2026-10-24T00:00:02.000Z",
    caseId: "session:case:2",
    execution: { digest },
  }];
  const projected = projectExecutionSequence(state, graph).messages;
  equal(Object.hasOwn(projected[0], "caseId"), false);
  equal(projected[1].caseId, "session:case:2");
  equal(projected[2].caseId, "session:case:2");
});

Deno.test("a foreign or absent digest cannot borrow the current action performer or name", () => {
  const { state, graph, action } = fixture();
  state.events = [
    {
      id: "old",
      kind: "flow-action",
      label: "Historical action",
      at: "2026-10-21T10:00:01.000Z",
      execution: { digest: "older-model", actionId: action.nativeId },
    },
    {
      id: "unknown",
      kind: "flow-action",
      label: "Unversioned action",
      at: "2026-10-21T10:00:02.000Z",
      execution: { digest: "", actionId: action.nativeId },
    },
  ];
  const result = projectExecutionSequence(state, graph);
  ok(
    result.messages.every((message) =>
      message.from === "observed:session:host"
    ),
  );
  deepStrictEqual(result.messages.map((message) => message.name), [
    "Historical action",
    "Unversioned action",
  ]);
  equal(result.messages[0].modelDigest, "older-model");
  ok(!result.lifelines.some((line) => line.id === "native-sandbox"));
  equal(result.diagnostics.length, 2);
});

Deno.test("observations retain stable time order and explicitly bound the last 150 records", () => {
  const { state, graph } = fixture();
  state.busy = true;
  state.phase = "Un appel est en cours";
  state.events = Array.from({ length: 160 }, (_, index) => ({
    id: `e${index}`,
    kind: "recorded-event",
    label: `Observation ${index}`,
    at: new Date(Date.UTC(2026, 9, 21, 10, 0, 0, Math.floor(index / 2)))
      .toISOString(),
  }));
  const result = projectExecutionSequence(state, graph);
  equal(result.total, 160);
  equal(result.omitted, 10);
  equal(result.limit, 150);
  equal(result.messages.length, 150);
  equal(result.messages[0].recordId, "e10");
  equal(result.messages[1].recordId, "e11");
  equal(result.messages.at(-1)!.recordId, "e159");
  equal(result.busy, true);
  equal(result.phase, state.phase);
  equal(result.lastActivityAt, state.events.at(-1)!.at);
});

Deno.test("an old conversation message keeps its receipt without using the new native builder identity", () => {
  const { state, graph } = fixture();
  state.messages = [{
    id: "legacy",
    role: "assistant",
    text: "Previous reply",
    at: "2026-10-21T10:00:00Z",
    execution: { digest: "old-model" },
  }];
  const result = projectExecutionSequence(state, graph);
  equal(result.messages[0].evidence.messageId, "legacy");
  ok(result.messages[0].from !== "native-builder");
  ok(!result.lifelines.some((line) => line.name === "Constructeur"));
  ok(result.diagnostics.length > 0);
});

Deno.test("an accepted but unadopted graph cannot rename admitted observation actors", () => {
  const { state, graph, action, digest } = fixture();
  graph.nodes.find((node) => node.nativeId === "native-sandbox")!.label =
    "New unadopted sandbox";
  graph.nodes.find((node) => node.nativeId === "native-builder")!.label =
    "New unadopted builder";
  state.events = [{
    id: "recorded-action",
    kind: "flow-action",
    label: "Recorded test",
    at: "2026-10-21T10:00:00Z",
    execution: { digest, actionId: action.nativeId },
  }];
  state.messages = [{
    id: "recorded-reply",
    role: "assistant",
    text: "Recorded reply",
    at: "2026-10-21T10:00:01Z",
    execution: { digest },
  }];
  const result = projectExecutionSequence(state, graph);
  equal(
    result.lifelines.find((line) => line.nativeId === "native-builder")!.name,
    "Constructeur",
  );
  equal(
    result.lifelines.find((line) => line.nativeId === "native-sandbox")!.name,
    "Opérateur · Tester le candidat",
  );
  ok(!result.lifelines.some((line) => line.name.startsWith("New unadopted")));
  equal(result.messages[0].from, "native-sandbox");
  equal(result.messages[1].from, "native-builder");
});
