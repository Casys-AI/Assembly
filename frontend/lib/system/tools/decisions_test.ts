import { settle } from "../../../test/support/settle.ts";
import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import type {
  ConversationsSnapshot,
  OperatorTool,
  OperatorToolsSnapshot,
} from "../../../../src/domain/work/records/conversations.ts";
import {
  createOperatorTools,
  type OperatorToolDecision,
  parseOperatorToolsSnapshot,
} from "./decisions.ts";
import { modelContextTools } from "../../../../src/domain/model/consultation/context.ts";
import { DEFAULT_NETWORK_IMPACT_LIMITS } from "../../../../src/domain/model/consultation/network-impact.ts";
import { delegatedCandidate } from "../../../test/support/candidate-admission-fixture.ts";

Deno.test("catalog decoding preserves delegate admission without changing the candidate's human gate", () => {
  const entry = tool();
  entry.candidate = delegatedCandidate();
  const parsed = parseOperatorToolsSnapshot(source([entry]));
  equal(parsed.tools[0]!.candidate.admission!.authority, "delegate");
  equal(parsed.tools[0]!.candidate.requiredAuthority, "human");
});

function tool(agentId = "worker"): OperatorTool {
  return {
    agentId,
    agentName: "Opérateur",
    revision: 4,
    candidate: {
      id: "same-artifact",
      digest: "a".repeat(64),
      name: "Extraction",
      description: "Lire le HTML",
      kind: "read_web_page",
      code: "export default () => ({title:'T',text:'Texte'});",
      stage: "awaiting-admission",
      requiredAuthority: "human",
      createdAt: "now",
      baseCatalogRevision: 0,
      tests: {
        passed: true,
        checks: [{ name: "Essai", passed: true, detail: "Passé" }],
      },
    },
  };
}
const source = (tools = [tool()]): OperatorToolsSnapshot => ({
  systemId: "system",
  version: "catalog-1",
  tools,
});
function owner(): ConversationsSnapshot {
  return {
    systemId: "system",
    defaultAgentId: "worker",
    version: "threads-1",
    conversations: [{
      agentId: "worker",
      nativeId: "native:worker",
      name: "Opérateur",
      responsibility: "Traiter le dossier",
      primary: false,
      canSend: false,
      revision: 4,
      busy: false,
      phase: "Décision attendue",
      modelDigest: "admitted",
      messages: [],
    }],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}

Deno.test("catalog decisions target the exact owner, revision and digest independently of its human inbox", async () => {
  const commands: OperatorToolDecision[] = [];
  const controller = createOperatorTools({
    currentSystemId: () => "system",
    canWrite: () => true,
    conversations: owner,
    port: {
      read: () => Promise.resolve(source()),
      decide: (command) => {
        commands.push(command);
        return Promise.resolve({ accepted: true });
      },
    },
  });
  controller.accept(source());
  equal(owner().conversations[0].canSend, false);
  equal(controller.canDecide(tool()), true);
  equal(await controller.decide(tool(), "approve"), true);
  deepStrictEqual(commands, [{
    agentId: "worker",
    candidateId: "same-artifact",
    candidateDigest: "a".repeat(64),
    expectedRevision: 4,
    verdict: "approve",
    reason: "Admission explicitly approved in the system conversation.",
  }]);
  controller.dispose();
});

Deno.test("stale ownership, model authority and historical controls cannot be overridden by a displayed tool", async () => {
  const currentOwner = owner();
  let frozen = false, writes = 0;
  const controller = createOperatorTools({
    currentSystemId: () => "system",
    canWrite: () => !frozen,
    conversations: () => currentOwner,
    port: {
      read: () => Promise.resolve(source()),
      decide: () => {
        writes++;
        return Promise.resolve({ accepted: true });
      },
    },
  });
  controller.accept(source());
  const changedDigest = tool();
  changedDigest.candidate.digest = "b".repeat(64);
  equal(controller.canDecide(changedDigest), false);
  equal(controller.canDecide({ ...tool(), agentId: "another" }), false);
  equal(controller.canDecide({ ...tool(), revision: 3 }), false);
  currentOwner.conversations[0].revision = 5;
  equal(controller.canDecide(tool()), false);
  currentOwner.conversations[0].revision = 4;
  currentOwner.conversations[0].busy = true;
  equal(controller.canDecide(tool()), false);
  currentOwner.conversations[0].busy = false;
  frozen = true;
  equal(await controller.decide(tool(), "approve"), false);
  equal(writes, 0);
  frozen = false;
  const automatic = tool();
  automatic.candidate.requiredAuthority = "reviewer";
  controller.accept(source([automatic]));
  equal(controller.canDecide(automatic), false);
  controller.dispose();
});

Deno.test("conversation bursts coalesce into one event-driven catalog read without polling", async () => {
  let reads = 0;
  const read = deferred<void>();
  const controller = createOperatorTools({
    currentSystemId: () => "system",
    canWrite: () => true,
    conversations: owner,
    port: {
      read: () => {
        reads++;
        read.resolve();
        return Promise.resolve(source());
      },
      decide: () => Promise.resolve({ accepted: true }),
    },
  });
  try {
    for (let i = 0; i < 30; i++) {
      controller.invalidate("system", `revision-${i}`);
    }
    equal(reads, 0);
    await read.promise;
    await settle();
    equal(reads, 1);
    equal(controller.stale.value, false);
    for (let i = 0; i < 10; i++) controller.invalidate("system", "revision-29");
    await new Promise((resolve) => setTimeout(resolve, 100));
    equal(reads, 1);
  } finally {
    controller.dispose();
  }
});

Deno.test("a failed CAS is surfaced and reconciled without a command retry", async () => {
  let writes = 0;
  const next = source();
  next.tools[0].revision = 5;
  const currentOwner = owner();
  currentOwner.conversations[0].revision = 5;
  const controller = createOperatorTools({
    currentSystemId: () => "system",
    canWrite: () => true,
    conversations: () => currentOwner,
    port: {
      read: () => Promise.resolve(next),
      decide: () => {
        writes++;
        return Promise.reject(new Error("La révision a changé"));
      },
    },
  });
  controller.accept(source());
  currentOwner.conversations[0].revision = 4;
  equal(await controller.decide(tool(), "approve"), false);
  equal(writes, 1);
  equal(controller.snapshot.value?.tools[0].revision, 5);
  equal(controller.error.value, "La révision a changé");
  equal(controller.canDecide(tool()), false);
  controller.dispose();
});

Deno.test("instance changes and disposal ignore old catalog reads or decisions", async () => {
  let systemId = "system";
  const response = deferred<{ accepted: boolean }>();
  const controller = createOperatorTools({
    currentSystemId: () => systemId,
    canWrite: () => true,
    conversations: owner,
    port: {
      read: () => Promise.resolve(source()),
      decide: () => response.promise,
    },
  });
  controller.accept(source());
  const posting = controller.decide(tool(), "refuse");
  systemId = "new-system";
  controller.accept({ ...source(), systemId });
  response.resolve({ accepted: true });
  equal(await posting, true);
  equal(controller.snapshot.value?.systemId, "new-system");
  equal(controller.error.value, "");
  controller.dispose();
  const late = deferred<OperatorToolsSnapshot>();
  const pending = createOperatorTools({
    currentSystemId: () => "system",
    canWrite: () => true,
    conversations: owner,
    port: {
      read: () => late.promise,
      decide: () => Promise.resolve({ accepted: true }),
    },
  });
  const reading = pending.refresh();
  pending.dispose();
  late.resolve(source());
  await reading;
  equal(pending.snapshot.value, null);
});

Deno.test("catalog transport keeps reused artifacts separate by native owner and rejects ambiguous or malformed records", () => {
  const first = tool(), second = tool("second-owner");
  equal(parseOperatorToolsSnapshot(source([first, second])).tools.length, 2);
  throws(
    () => parseOperatorToolsSnapshot(source([first, first])),
    /operator catalog is unreadable/,
  );
  for (const field of ["requiredAuthority", "tests", "review", "admission"]) {
    const broken = source();
    (broken.tools[0].candidate as unknown as Record<string, unknown>)[field] = [
      "human",
    ];
    throws(
      () => parseOperatorToolsSnapshot(broken),
      /operator catalog is unreadable/,
    );
  }
  throws(
    () => parseOperatorToolsSnapshot({ ...source(), tools: [{}] }),
    /operator catalog is unreadable/,
  );
});

Deno.test("catalog parse failures do not become usable decisions or unhandled reads", async () => {
  const controller = createOperatorTools({
    currentSystemId: () => "system",
    canWrite: () => true,
    conversations: owner,
    port: {
      read: () => Promise.reject(new Error("Catalogue indisponible")),
      decide: () => Promise.resolve({ accepted: true }),
    },
  });
  controller.accept(source());
  await controller.refresh();
  equal(controller.canDecide(tool()), false);
  equal(controller.error.value, "Catalogue indisponible");
  controller.dispose();
  await rejects(
    () => Promise.resolve().then(() => parseOperatorToolsSnapshot(null)),
    /operator catalog is unreadable/,
  );
});

Deno.test("model consultation catalogs validate descriptors and preserve equal tool ids under distinct owners", () => {
  const entry = {
    agentId: "worker",
    agentName: "Opérateur",
    tool: modelContextTools()[0],
  };
  const value = {
    ...source([]),
    modelTools: [entry, { ...entry, agentId: "primary" }],
  };
  equal(parseOperatorToolsSnapshot(value).modelTools!.length, 2);
  const complete = modelContextTools().map((tool) => ({
    ...entry,
    tool,
  }));
  equal(
    parseOperatorToolsSnapshot({ ...value, modelTools: complete }).modelTools!
      .length,
    complete.length,
  );
  throws(() =>
    parseOperatorToolsSnapshot({ ...value, modelTools: [entry, entry] })
  );
  for (
    const malformed of [
      { ...entry, tool: { ...entry.tool, operation: "write_source" } },
      { ...entry, tool: { ...entry.tool, inputSchema: { type: "string" } } },
      {
        ...entry,
        tool: {
          ...entry.tool,
          inputSchema: {
            type: "object",
            properties: { version: null },
            required: [],
          },
        },
      },
      { ...entry, agentId: "" },
    ]
  ) {
    throws(() =>
      parseOperatorToolsSnapshot({ ...value, modelTools: [malformed] })
    );
  }
  equal(parseOperatorToolsSnapshot(source()).modelTools, undefined);
});

Deno.test("network impact native catalog decodes both closed schema variants without widening decision rights", () => {
  const catalog = modelContextTools({
    networkImpact: {
      scope: "own-history",
      limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
      maxPageSize: 3,
      maxResponseCharacters: 12_000,
    },
  });
  const value = {
    ...source(),
    modelTools: catalog.map((tool) => ({
      agentId: "worker",
      agentName: "Operator",
      tool,
    })),
  };
  const parsed = parseOperatorToolsSnapshot(value);
  deepStrictEqual(parsed.modelTools, value.modelTools);
  const controller = createOperatorTools({
    currentSystemId: () => "system",
    canWrite: () => false,
    conversations: owner,
  });
  controller.accept(value);
  equal(controller.canDecide(tool()), false);
  controller.dispose();
  const native = catalog.find((tool) => tool.operation === "network_impact")!;
  const schema = native.inputSchema;
  const variants = schema.oneOf as Record<string, unknown>[];
  for (
    const inputSchema of [
      { oneOf: [] },
      { oneOf: [variants[0]] },
      { oneOf: [variants[0], variants[0]] },
      { oneOf: [variants[0], { ...variants[1], additionalProperties: true }] },
      { oneOf: [variants[0], { ...variants[1], required: ["missing"] }] },
      {
        oneOf: [variants[0], { ...variants[1], properties: { action: null } }],
      },
      {
        oneOf: [variants[0], {
          ...variants[1],
          properties: {
            ...variants[1].properties as Record<string, unknown>,
            limit: { type: "integer", maximum: "unbounded" },
          },
        }],
      },
    ]
  ) {
    throws(
      () =>
        parseOperatorToolsSnapshot({
          ...source(),
          modelTools: [{
            agentId: "worker",
            agentName: "Operator",
            tool: { ...native, inputSchema },
          }],
        }),
      /operator catalog is unreadable/,
    );
  }
  throws(
    () =>
      parseOperatorToolsSnapshot({
        ...source(),
        modelTools: [{
          agentId: "worker",
          agentName: "Operator",
          tool: { ...catalog[0], inputSchema: schema },
        }],
      }),
    /operator catalog is unreadable/,
  );
});
