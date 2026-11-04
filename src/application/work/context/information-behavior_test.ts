import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { GovernedMemoryPromotionService } from "../../memory/governed-memory-promotion.ts";
import type { MemoryStorePort } from "../../memory/ports/store.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import type {
  MemoryContent,
  MemoryRecord,
} from "../../../domain/memory/entities/memory-record.ts";
import {
  MemoryError,
  type MemoryExpectedVersion,
} from "../../../domain/memory/governed-memory-promotion.ts";
import type {
  BehaviorInvocationRequest,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
} from "../../../domain/model/execution/native-contracts.ts";
import type { OperatorEntry } from "../../../domain/model/records/operator-entry.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import { InformationBehavior } from "./information-behavior.ts";
import {
  batchHistory,
  completeBatchCall,
  nativeCallResult,
} from "../conversation/batches.ts";
import { observeOutcome } from "../conversation/observation.ts";
import type { ConversationObservationHost } from "../conversation/turn-context.ts";

const ownerId = "operator-one";
const at = "2026-10-22T00:00:00.000Z";
const fields = {
  "context-evidence": { messageId: "string", messageDigest: "string" },
  "memory-capture": { id: "string", contentJson: "string" },
  "memory-recall": { id: "string" },
  "memory-revise": {
    id: "string",
    expectedRevision: "integer",
    expectedDigest: "string",
    contentJson: "string",
  },
  "memory-review": {
    id: "string",
    expectedRevision: "integer",
    expectedDigest: "string",
    decision: "string",
    reason: "string",
  },
  "memory-withdraw": {
    id: "string",
    expectedRevision: "integer",
    expectedDigest: "string",
    reason: "string",
  },
} as const;
type Kind = keyof typeof fields;

function behavior(kind: Kind): NativeBehaviorContract {
  return {
    id: `${kind}-access`,
    name: kind,
    description: "Exact native local information exposure",
    callerNativeId: ownerId,
    targetNativeId: `${kind}-target`,
    targetTypeId: `${kind}-type`,
    inputTypeId: `${kind}-request`,
    sourceIds: [`${kind}-access`, `${kind}-target`],
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(fields[kind]).map(([name, type]) => [name, { type }]),
      ),
      required: kind === "memory-recall" ? [] : Object.keys(fields[kind]),
      additionalProperties: false,
    },
  };
}

class MemoryStore implements MemoryStorePort {
  readonly records = new Map<string, MemoryRecord>();
  writes = 0;
  failSave = false;

  load(owner: string, id: string): Promise<MemoryRecord | null> {
    const record = this.records.get(id);
    return Promise.resolve(structuredClone(
      record?.ownerId === owner ? record : null,
    ));
  }

  list(owner: string): Promise<MemoryRecord[]> {
    return Promise.resolve(structuredClone(
      [...this.records.values()].filter((record) => record.ownerId === owner),
    ));
  }

  save(
    record: MemoryRecord,
    expected: MemoryExpectedVersion | null,
  ): Promise<void> {
    if (this.failSave) throw new Error("private storage path and secret");
    const previous = this.records.get(record.id);
    if (
      expected === null
        ? !!previous
        : !previous || previous.revision !== expected.revision ||
          previous.digest !== expected.digest
    ) throw new MemoryError("conflict", "concurrent memory update");
    this.records.set(record.id, structuredClone(record));
    this.writes++;
    return Promise.resolve();
  }
}

function candidate(): MemoryContent {
  return {
    text: "An observed failure is evidence, not a new permission.",
    origin: { decisionId: "decision-one", sourceRefs: ["message:source-one"] },
    scope: ["construction"],
    validUntil: "2026-10-22T01:00:00.000Z",
    outcome: {
      status: "known",
      summary: "The refused action remained inactive.",
      evidenceRefs: ["message:source-one"],
    },
  };
}

function setup(kinds: Kind[] = Object.keys(fields) as Kind[]) {
  const model = artifactModel(ownerId);
  model.behaviors = kinds.map(behavior);
  model.operatorEntries = kinds.map((kind) => ({
    id: `${kind}-target`,
    kind,
    typeId: `${kind}-type`,
    performerId: "admission-gate",
    allocationId: `${kind}-allocation`,
    sourceIds: [`${kind}-target`],
  }));
  model.contextPolicy = {
    id: "context-policy",
    revision: 1,
    elementId: "context-policy-native",
    sourceIds: ["context-policy-native"],
    kind: "separated-context",
    pattern: "5.1",
    recentMessages: 8,
    maxMessageCharacters: 1000,
    maxCollectionItems: 4,
    maxContextCharacters: 100000,
  };
  model.memoryPolicy = {
    id: "memory-policy",
    revision: 1,
    elementId: "memory-policy-native",
    sourceIds: ["memory-policy-native"],
    kind: "governed-memory",
    pattern: "5.2",
    ownerId,
    allowedScopes: ["construction"],
    requireSourceRefs: true,
    requireKnownOutcome: true,
    maxValidityMs: 3_600_000,
    allowSelfAdmission: true,
  };
  const entries = new Map<
    string,
    { ownerId: string; kind: OperatorEntry["kind"] }
  >(
    kinds.map((kind) => [`${kind}-target`, { ownerId, kind }]),
  );
  const snapshot: SystemRuntimeState = {
    id: "session-one",
    cases: [],
    designer: { scopeId: "session-one:designer" },
    caseInvocation: { kind: "designer", scopeId: "session-one:designer" },
    revision: 1,
    catalogRevision: 0,
    model: structuredClone(model.identity),
    executionModel: structuredClone(model),
    messages: [{
      id: "source-one",
      role: "tool",
      text: "Full local result",
      at,
      execution: {
        digest: model.version.digest,
        repositoryVersion: model.version.repositoryVersion,
        actionId: "read-result",
        sourceIds: ["native-action"],
      },
    }],
    candidates: [],
    events: [],
    busy: false,
    phase: "idle",
    provider: "test-double",
  };
  const store = new MemoryStore();
  let reads = 0;
  let resolvable = true;
  const service = new GovernedMemoryPromotionService({
    store,
    provenance: {
      verify: (owner) => Promise.resolve(owner === ownerId && resolvable),
    },
    now: () => at,
  });
  const adapter = new InformationBehavior({
    entries,
    resolveCallerModel: (caller) =>
      Promise.resolve(caller === ownerId ? structuredClone(model) : null),
    snapshotForCaller: (caller) => caller === ownerId ? snapshot : undefined,
    memory: () => {
      reads++;
      return Promise.resolve(service);
    },
  });
  let invocation = 0;
  function request(kind: Kind, input: Record<string, unknown>) {
    return {
      behavior: behavior(kind),
      callerId: ownerId,
      invocationId: `call-${++invocation}`,
      modelVersion: {
        digest: model.version.digest,
        repositoryVersion: model.version.repositoryVersion!,
      },
      input,
    } satisfies BehaviorInvocationRequest;
  }
  return {
    model,
    adapter,
    entries,
    store,
    snapshot,
    request,
    service,
    reads: () => reads,
    resolvable: (value: boolean) => resolvable = value,
  };
}

function memoryResult(result: unknown) {
  return result as {
    memory: {
      id: string;
      revision: number;
      digest: string;
      status: string;
      usableAsGuidance: boolean;
      [key: string]: unknown;
    };
    operation: Record<string, unknown>;
    replayed: boolean;
  };
}

async function capture(fixture: ReturnType<typeof setup>) {
  return memoryResult(
    (await fixture.adapter.invoke(
      fixture.request("memory-capture", {
        id: "note-one",
        contentJson: JSON.stringify(candidate()),
      }),
    )).result,
  );
}

Deno.test("information capture keeps a candidate and echoes exact admitted invocation", async () => {
  const fixture = setup();
  const request = fixture.request("memory-capture", {
    id: "note-one",
    contentJson: JSON.stringify(candidate()),
  });
  const result = await fixture.adapter.invoke(request);
  equal(result.behaviorId, request.behavior.id);
  equal(result.invocationId, request.invocationId);
  equal(result.targetNativeId, request.behavior.targetNativeId);
  deepStrictEqual(result.modelVersion, request.modelVersion);
  const receipt = memoryResult(result.result);
  equal(receipt.memory.status, "candidate");
  equal(receipt.memory.usableAsGuidance, false);
  equal("content" in receipt.memory, false);
  equal("history" in receipt.memory, false);
  equal(receipt.memory.historyLength, 1);
  equal("content" in receipt.operation, false);
  equal(fixture.store.writes, 1);
  deepStrictEqual(await fixture.adapter.read(fixture.model), {
    memoryGuidance: [],
  });
});

Deno.test("information entry ownership and exact source exposure cannot be forged", async () => {
  for (
    const mutate of [
      (
        _fixture: ReturnType<typeof setup>,
        request: BehaviorInvocationRequest,
      ) => request.callerId = "peer",
      (
        _fixture: ReturnType<typeof setup>,
        request: BehaviorInvocationRequest,
      ) => request.behavior.description += " changed",
      (fixture: ReturnType<typeof setup>) =>
        fixture.entries.get("memory-capture-target")!.ownerId = "peer",
      (fixture: ReturnType<typeof setup>) => fixture.model.behaviors = [],
      (fixture: ReturnType<typeof setup>) => fixture.model.operatorEntries = [],
      (fixture: ReturnType<typeof setup>) =>
        fixture.model.operatorEntries!.find((entry) =>
          entry.kind === "memory-capture"
        )!.typeId = "foreign-type",
      (fixture: ReturnType<typeof setup>) =>
        fixture.model.memoryPolicy!.ownerId = "peer",
    ]
  ) {
    const fixture = setup();
    const request = fixture.request("memory-capture", {
      id: "note-one",
      contentJson: JSON.stringify(candidate()),
    });
    mutate(fixture, request);
    await rejects(() => fixture.adapter.invoke(request));
    equal(fixture.store.writes, 0);
    equal(fixture.reads(), 0);
  }
});

Deno.test("information invocation rejects stale digest or source pin before any store access", async () => {
  for (const key of ["digest", "repositoryVersion"] as const) {
    const fixture = setup();
    const request = fixture.request("memory-recall", {});
    request.modelVersion[key] = "stale-version";
    equal(
      await fixture.adapter.supports(request.behavior, request.modelVersion),
      false,
    );
    await rejects(() => fixture.adapter.invoke(request));
    equal(fixture.reads(), 0);
  }
});

Deno.test("information input rejects coercion and authority-shaped additions", async () => {
  const inputs = [
    { id: 1, contentJson: JSON.stringify(candidate()) },
    {
      id: "note-one",
      contentJson: JSON.stringify(candidate()),
      mayAdmit: true,
    },
    { id: "note-one" },
    { id: "note-one", contentJson: "not JSON" },
    {
      id: "note-one",
      contentJson: JSON.stringify({ ...candidate(), permissions: ["admit"] }),
    },
    {
      id: "note-one",
      contentJson: JSON.stringify({
        ...candidate(),
        origin: { ...candidate().origin, ownerId: "peer" },
      }),
    },
  ];
  for (const input of inputs) {
    const fixture = setup();
    await rejects(() =>
      fixture.adapter.invoke(fixture.request("memory-capture", input))
    );
    equal(fixture.store.writes, 0);
  }
});

Deno.test("information registration alone neither grants recall nor admission", async () => {
  const fixture = setup(["memory-capture"]);
  fixture.entries.set("memory-recall-target", {
    ownerId,
    kind: "memory-recall",
  });
  fixture.entries.set("memory-review-target", {
    ownerId,
    kind: "memory-review",
  });
  const captured = await capture(fixture);
  await rejects(() =>
    fixture.adapter.invoke(fixture.request("memory-recall", {}))
  );
  await rejects(() =>
    fixture.adapter.invoke(fixture.request("memory-review", {
      id: "note-one",
      expectedRevision: captured.memory.revision,
      expectedDigest: captured.memory.digest,
      decision: "admit",
      reason: "Host registration does not grant authority",
    }))
  );
  deepStrictEqual(await fixture.adapter.read(fixture.model), {
    memoryGuidance: [],
  });
  equal(fixture.store.writes, 1);
});

Deno.test("information recall preserves candidate status and only admitted guidance enters context", async () => {
  const fixture = setup();
  const captured = await capture(fixture);
  const recalled = await fixture.adapter.invoke(
    fixture.request("memory-recall", {}),
  );
  const memories =
    (recalled.result as { memories: Record<string, unknown>[] }).memories;
  equal(memories[0]!.status, "candidate");
  equal(memories[0]!.usableAsGuidance, false);
  equal("history" in memories[0]!, false);
  equal(memories[0]!.historyLength, 1);
  const admitted = await fixture.adapter.invoke(
    fixture.request("memory-review", {
      id: "note-one",
      expectedRevision: captured.memory.revision,
      expectedDigest: captured.memory.digest,
      decision: "admit",
      reason: "Evidence examined under modeled policy",
    }),
  );
  equal(memoryResult(admitted.result).memory.status, "admitted");
  const guidance = await fixture.adapter.read(fixture.model);
  equal(guidance.memoryGuidance.length, 1);
  equal(guidance.memoryGuidance[0]!.content.text, candidate().text);
  equal("history" in guidance.memoryGuidance[0]!, false);
  equal(guidance.memoryGuidance[0]!.historyLength, 2);
  fixture.model.behaviors = fixture.model.behaviors!.filter((entry) =>
    entry.id !== "memory-recall-access"
  );
  deepStrictEqual(await fixture.adapter.read(fixture.model), {
    memoryGuidance: [],
  });
});

Deno.test("information native review grant still obeys self-admission and source provenance policy", async () => {
  const fixture = setup();
  fixture.model.memoryPolicy!.allowSelfAdmission = false;
  const captured = await capture(fixture);
  const input = {
    id: "note-one",
    expectedRevision: captured.memory.revision,
    expectedDigest: captured.memory.digest,
    decision: "admit",
    reason: "Native review exposure is insufficient for self-admission",
  };
  await rejects(
    () => fixture.adapter.invoke(fixture.request("memory-review", input)),
    /self-admission/,
  );
  fixture.model.memoryPolicy!.allowSelfAdmission = true;
  fixture.resolvable(false);
  await rejects(
    () => fixture.adapter.invoke(fixture.request("memory-review", input)),
    /cannot be resolved/,
  );
  equal(fixture.store.writes, 1);
});

Deno.test("information revision review and withdrawal preserve exact versions", async () => {
  const fixture = setup();
  const captured = await capture(fixture);
  const revised = memoryResult(
    (await fixture.adapter.invoke(fixture.request("memory-revise", {
      id: "note-one",
      expectedRevision: captured.memory.revision,
      expectedDigest: captured.memory.digest,
      contentJson: JSON.stringify({
        ...candidate(),
        text: "Revised observation",
      }),
    }))).result,
  );
  equal(revised.memory.revision, 2);
  await rejects(() =>
    fixture.adapter.invoke(fixture.request("memory-review", {
      id: "note-one",
      expectedRevision: captured.memory.revision,
      expectedDigest: captured.memory.digest,
      decision: "admit",
      reason: "Stale review",
    })), /revision or digest changed/);
  const withdrawn = memoryResult(
    (await fixture.adapter.invoke(fixture.request("memory-withdraw", {
      id: "note-one",
      expectedRevision: revised.memory.revision,
      expectedDigest: revised.memory.digest,
      reason: "No longer applicable",
    }))).result,
  );
  equal(withdrawn.memory.status, "withdrawn");
  equal(withdrawn.memory.usableAsGuidance, false);
  equal(fixture.store.writes, 3);
});

Deno.test("information evidence reads exact own bytes while stale or foreign references fail", async () => {
  const fixture = setup();
  const message = fixture.snapshot.messages[0]!;
  const request = fixture.request("context-evidence", {
    messageId: message.id,
    messageDigest: await executionDigest(message),
  });
  const result = await fixture.adapter.invoke(request);
  const detail = result.result as {
    reference: { messageDigest: string };
    message: { text: string };
  };
  deepStrictEqual(detail.message, message);
  equal(detail.reference.messageDigest, request.input.messageDigest);
  detail.message.text = "Mutated result";
  equal(fixture.snapshot.messages[0]!.text, "Full local result");
  message.text = "Changed durable content";
  await rejects(() => fixture.adapter.invoke(request), /content has changed/);
  await rejects(
    () =>
      fixture.adapter.invoke(fixture.request("context-evidence", {
        messageId: "peer-message",
        messageDigest: "a".repeat(64),
      })),
    /journal local/,
  );
  equal(fixture.reads(), 0);
});

for (const kind of ["invoke_tool", "invoke_behavior"] as const) {
  Deno.test(`large ${kind} observations remain readable through exact bounded journal pages`, async () => {
    const fixture = setup(["context-evidence"]);
    const evidence = fixture.model.behaviors![0];
    (evidence.inputSchema.properties as Record<string, unknown>).offset = {
      type: "integer",
    };
    (evidence.inputSchema.properties as Record<string, unknown>).limit = {
      type: "integer",
    };
    fixture.snapshot.executionModel = structuredClone(fixture.model);
    const value = {
      text: "Retained observed bytes — never repeat the external effect. "
        .repeat(180),
    };
    const chosen = kind === "invoke_tool"
      ? {
        kind,
        text: "Read",
        toolId: "page-reader",
        input: { url: "https://example.org" },
      }
      : { kind, text: "Read", behaviorId: "reader", inputJson: "{}" };
    const outcome = kind === "invoke_tool"
      ? {
        succeeded: true,
        toolId: "page-reader",
        details: JSON.stringify(value),
        result: value,
      }
      : { succeeded: true, behaviorId: "reader", behaviorResult: value };
    const batch = {
      id: "large-batch",
      designerScopeId: fixture.snapshot.designer!.scopeId,
      modelDigest: fixture.model.version.digest,
      createdAt: at,
      sourceDecision: {},
      providerTurn: { inputMessageId: "input", brief: { input: "Read" } },
      assistantBlocks: [{
        type: "tool_use",
        id: "read",
        name: kind,
        input: chosen,
      }],
      calls: [{ id: "read", decision: chosen, status: "started" as const }],
    };
    fixture.snapshot.conversationBatches = [batch];
    const host = {
      ports: { clock: { now: () => "2026-11-03T00:00:00.000Z" } },
      state: fixture.snapshot,
      update: (mutate: (state: SystemRuntimeState) => void) => {
        mutate(fixture.snapshot);
        return Promise.resolve();
      },
    };
    const result = nativeCallResult({ outputs: { outcome } })!;
    await completeBatchCall(host, batch.id, "read", result);
    const messageCount = fixture.snapshot.messages.length;
    await completeBatchCall(host, batch.id, "read", result);
    equal(
      fixture.snapshot.messages.length,
      messageCount,
      "retry reuses the same observation",
    );
    if (kind === "invoke_behavior") {
      fixture.snapshot.activeBatchCall = { batchId: batch.id, callId: "read" };
      await observeOutcome.call(
        {
          ...host,
          feedback: () =>
            Promise.reject(new Error("The observation is already journalled")),
        } as unknown as ConversationObservationHost,
        {
          resumedContribution: false,
          proposals: 0,
          decisions: 0,
          sourceDecision: {},
          failures: new Map(),
        },
        fixture.model,
        { outcome },
      );
      equal(fixture.snapshot.messages.length, messageCount);
    }
    const serialized = batchHistory(fixture.snapshot)![0].results[0].result;
    ok(serialized.length <= 8192);
    const retained = JSON.parse(serialized);
    ok(retained.truncated);
    const read = fixture.request("context-evidence", {
      ...retained.reference,
      offset: 0,
      limit: 2048,
    });
    read.behavior = evidence;
    let content = "";
    let pages = 0;
    while (true) {
      const page = (await fixture.adapter.invoke(read)).result as {
        content: string;
        next?: Record<string, unknown>;
      };
      ok(JSON.stringify(page).length <= 8192);
      content += page.content;
      pages++;
      if (!page.next) break;
      read.input = page.next;
    }
    ok(pages > 1);
    deepStrictEqual(JSON.parse(content).observation.value, value);
    const exact = fixture.snapshot.messages.find((message) =>
      message.id === retained.reference.messageId
    )!;
    exact.text += "changed";
    await rejects(() => fixture.adapter.invoke(read), /content has changed/);
  });
}

Deno.test("information evidence cannot read another conversation even with an exact journal reference", async () => {
  const fixture = setup();
  const message = fixture.snapshot.messages[0]!;
  message.caseId = "another-request";
  const request = fixture.request("context-evidence", {
    messageId: message.id,
    messageDigest: await executionDigest(message),
  });
  await rejects(() => fixture.adapter.invoke(request), /journal local/);
  delete message.caseId;
  message.designerScopeId = "foreign-designer";
  request.input.messageDigest = await executionDigest(message);
  await rejects(() => fixture.adapter.invoke(request), /journal local/);
});

Deno.test("information evidence fails explicitly for oversized complete journal messages", async () => {
  const fixture = setup();
  const message = fixture.snapshot.messages[0]!;
  message.text = "x".repeat(262144);
  const before = structuredClone(message);
  await rejects(
    () =>
      fixture.adapter.invoke(fixture.request("context-evidence", {
        messageId: message.id,
        messageDigest: "a".repeat(64),
      })),
    /content has changed/,
  );
  const messageDigest = await executionDigest(message);
  await rejects(
    () =>
      fixture.adapter.invoke(fixture.request("context-evidence", {
        messageId: message.id,
        messageDigest,
      })),
    /limite de restitution/,
  );
  deepStrictEqual(message, before);
});

Deno.test("information malformed native signatures are not registered as supported primitives", async () => {
  for (
    const alter of [
      (schema: Record<string, unknown>) => schema.additionalProperties = true,
      (schema: Record<string, unknown>) => schema.required = [],
      (schema: Record<string, unknown>) =>
        schema.properties = {
          id: { type: "number" },
          contentJson: { type: "string" },
        },
    ]
  ) {
    const fixture = setup();
    const request = fixture.request("memory-capture", {});
    alter(request.behavior.inputSchema);
    fixture.model.behaviors = [request.behavior];
    equal(
      await fixture.adapter.supports(request.behavior, request.modelVersion),
      false,
    );
    await rejects(() => fixture.adapter.invoke(request));
    equal(fixture.reads(), 0);
  }
});

Deno.test("information failed persistence returns no success and hides storage internals", async () => {
  const fixture = setup();
  fixture.store.failSave = true;
  await rejects(() => capture(fixture), (error) =>
    error instanceof Error &&
    error.message === "L’opération de mémoire locale n’a pas abouti.");
  equal(fixture.store.records.size, 0);
});

Deno.test("information scope changes expose current guidance without former scoped content or audit history", async () => {
  const fixture = setup();
  fixture.model.memoryPolicy!.allowedScopes = ["scope-a", "scope-b"];
  const first = {
    ...candidate(),
    text: "PRIVATE_A_OLD_OBSERVATION",
    scope: ["scope-a"],
  };
  const captured = memoryResult(
    (await fixture.adapter.invoke(fixture.request("memory-capture", {
      id: "note-one",
      contentJson: JSON.stringify(first),
    }))).result,
  );
  const next = {
    ...candidate(),
    text: "CURRENT_B_OBSERVATION",
    scope: ["scope-b"],
  };
  const revised = memoryResult(
    (await fixture.adapter.invoke(fixture.request("memory-revise", {
      id: "note-one",
      expectedRevision: captured.memory.revision,
      expectedDigest: captured.memory.digest,
      contentJson: JSON.stringify(next),
    }))).result,
  );
  fixture.model.memoryPolicy!.allowedScopes = ["scope-b"];
  const admitted = await fixture.adapter.invoke(
    fixture.request("memory-review", {
      id: "note-one",
      expectedRevision: revised.memory.revision,
      expectedDigest: revised.memory.digest,
      decision: "admit",
      reason: "Current scoped evidence examined",
    }),
  );
  const recalled = await fixture.adapter.invoke(
    fixture.request("memory-recall", { id: "note-one" }),
  );
  const guidance = await fixture.adapter.read(fixture.model);
  for (const value of [revised, admitted, recalled, guidance]) {
    const serialized = JSON.stringify(value);
    equal(serialized.includes("PRIVATE_A_OLD_OBSERVATION"), false);
    equal(serialized.includes('"history":'), false);
  }
  const recalledMemory =
    (recalled.result as { memories: { content: MemoryContent }[] })
      .memories[0]!;
  equal(recalledMemory.content.text, "CURRENT_B_OBSERVATION");
  equal(guidance.memoryGuidance[0]!.content.text, "CURRENT_B_OBSERVATION");
  equal(
    fixture.store.records.get("note-one")!.history[0]!.content.text,
    "PRIVATE_A_OLD_OBSERVATION",
  );
  equal("content" in memoryResult(admitted.result).operation, false);
});
