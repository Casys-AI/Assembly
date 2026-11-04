import { strict as assert } from "node:assert";
import { MemorySaver } from "@langchain/langgraph";
import { compileNativeOperatorGraph } from "../../src/adapters/out/native-execution/native-graph.ts";
import {
  immutableReceiptKey,
  mergeImmutableReceipts,
} from "../../src/application/work/conversation/immutable-consultation-group.ts";
import type {
  ImmutableConsultationGroupManifest,
  ImmutableConsultationMemberOutcome,
} from "../../src/application/work/native-execution/contract.ts";
import type { CompiledFlow } from "../../src/domain/model/execution/flow.ts";
import { executableFixture } from "../support/execution-fixture.ts";

Deno.test("immutable profile schedules registered workers concurrently and joins in provider order", async () => {
  const identity = {
    projectId: "p",
    editingContextId: "e",
    rootId: "r",
    systemId: "s",
    catalogId: "c",
    builderId: "o",
  };
  const model = executableFixture(identity);
  const source = { file: "fixture.sysml", line: 1 };
  const node = (id: string, kind: "start" | "action" | "done") => ({
    id,
    nativeId: id,
    name: id,
    kind,
    source,
    assertions: [],
    inputs: [],
    outputs: kind === "action" ? ["outcome"] : [],
    ...(kind === "action"
      ? { mechanism: "execute_operator_command" as const }
      : {}),
  });
  const edge = (id: string, from: string, to: string) => ({
    id,
    nativeId: id,
    source: from,
    target: to,
    guardIds: [],
    sourceEvidence: source,
  });
  const flow: CompiledFlow = {
    executionProfile: "operator-command-immutable-group-v1",
    rootNativeId: "root",
    rootOccurrenceId: "occurrence",
    name: "flow",
    source,
    startNodeId: "start",
    maxSteps: 32,
    nodes: [
      node("start", "start"),
      node("command", "action"),
      node("done", "done"),
    ],
    edges: [edge("a", "start", "command"), edge("b", "command", "done")],
    bindings: [],
  };
  const member = (ordinal: number) => ({
    ordinal,
    callId: `call${ordinal}`,
    effectKey: `effect${ordinal}`,
    argumentsDigest: `arg${ordinal}`,
    choice: { kind: "consult_model" as const, text: "", inputJson: "{}" },
    request: { operation: "inspect" as const, version: "v" },
    responseCharacters: 10,
    flowStepOrdinal: ordinal + 3,
  });
  const manifest: ImmutableConsultationGroupManifest = {
    groupId: "group",
    manifestDigest: "digest",
    runId: "run",
    occurrenceId: "command",
    batchId: "batch",
    firstOrdinal: 0,
    identity: {
      operatorId: "o",
      invocationKey: "inv",
      scope: { kind: "request", scopeId: "case", rootRequestId: "case" },
      purpose: "conversation",
    },
    contribution: { id: "input", kind: "input" },
    businessRevision: {
      __assemblyRuntimeRevision: {
        systemId: "s",
        operatorId: "o",
        revision: 1,
        modelDigest: model.version.digest,
      },
    },
    executionPin: { modelDigest: model.version.digest },
    sourcePin: { version: "v", digest: "source" },
    members: [member(0), member(1)],
    limits: { responseCharacters: 20, flowSteps: 3 },
  };
  const started: string[] = [], finished: string[] = [];
  let release!: () => void, both!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const entered = new Promise<void>((resolve) => both = resolve);
  let registered = false, joined: string[] = [];
  const runtime = compileNativeOperatorGraph(model, () => {
    throw new Error("scalar parent called");
  }, {
    flow,
    rootRequestId: "case",
    checkpointer: new MemorySaver(),
    assertBoundary: () => {},
    immutableConsultations: {
      plan: () => Promise.resolve(manifest),
      register: (value) => {
        registered = true;
        return Promise.resolve(value);
      },
      member: async (_group, value) => {
        assert(registered);
        started.push(value.callId);
        if (started.length === 2) both();
        if (value.ordinal === 0) await gate;
        finished.push(value.callId);
        return {
          groupId: "group",
          callId: value.callId,
          effectKey: value.effectKey,
          argumentsDigest: value.argumentsDigest,
          result: { status: "succeeded", code: "OK", details: value.callId },
          messages: [],
          events: [],
        };
      },
      join: (_group, results) => {
        joined = results.map((result) => result.callId);
        return Promise.resolve({ outputs: { outcome: { succeeded: true } } });
      },
    },
  });
  const abort = new AbortController();
  const running = runtime.graph.invoke(runtime.initialState(), {
    configurable: { thread_id: "concurrent-group" },
    signal: abort.signal,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      running.then(() => {
        throw new Error("Graph finished before both workers entered");
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Workers did not enter within deadline")),
          5000,
        );
      }),
    ]);
    assert.deepEqual(started.toSorted(), ["call0", "call1"]);
    release();
    const result = await running;
    assert.deepEqual(finished, ["call1", "call0"]);
    assert.deepEqual(joined, ["call0", "call1"]);
    assert.deepEqual(result.values.command, { outcome: { succeeded: true } });
    assert.deepEqual(result.immutableOutcomes, {});
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    release();
    abort.abort();
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        running.catch(() => {}),
        new Promise<void>((resolve) => {
          cleanupTimer = setTimeout(resolve, 5000);
        }),
      ]);
    } finally {
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    }
  }
});

Deno.test("immutable receipt reducer rejects conflicting replay", () => {
  const receipt: ImmutableConsultationMemberOutcome = {
    groupId: "g",
    callId: "c",
    effectKey: "e",
    argumentsDigest: "a",
    result: { status: "succeeded", code: "OK", details: "one" },
    messages: [],
    events: [],
  };
  const key = immutableReceiptKey("g", "c");
  const first = mergeImmutableReceipts({}, {
    kind: "merge",
    receipts: { [key]: receipt },
  });
  assert.deepEqual(
    mergeImmutableReceipts(first, {
      kind: "merge",
      receipts: { [key]: receipt },
    }),
    first,
  );
  assert.throws(
    () =>
      mergeImmutableReceipts(first, {
        kind: "merge",
        receipts: {
          [key]: {
            ...receipt,
            result: { ...receipt.result, details: "different" },
          },
        },
      }),
    /Conflicting/,
  );
});

Deno.test("joined groups clear checkpoint receipts and replay an interrupted join without redispatch", async () => {
  const identity = {
    projectId: "p",
    editingContextId: "e",
    rootId: "r",
    systemId: "s",
    catalogId: "c",
    builderId: "o",
  };
  const model = executableFixture(identity);
  const source = { file: "fixture.sysml", line: 1 };
  const base = { source, assertions: [], inputs: [], outputs: [] };
  const nodes = [
    {
      ...base,
      id: "start",
      nativeId: "start",
      name: "start",
      kind: "start" as const,
    },
    {
      ...base,
      id: "command",
      nativeId: "command",
      name: "command",
      kind: "action" as const,
      mechanism: "execute_operator_command",
      outputs: ["outcome"],
    },
    {
      ...base,
      id: "branch",
      nativeId: "branch",
      name: "branch",
      kind: "decision" as const,
    },
    {
      ...base,
      id: "done",
      nativeId: "done",
      name: "done",
      kind: "done" as const,
    },
  ];
  const edge = (id: string, from: string, to: string, guard?: string) => ({
    id,
    nativeId: id,
    source: from,
    target: to,
    guardIds: [],
    sourceEvidence: source,
    ...(guard ? { guard } : {}),
  });
  const flow: CompiledFlow = {
    executionProfile: "operator-command-immutable-group-v1",
    rootNativeId: "root",
    rootOccurrenceId: "occurrence",
    name: "flow",
    source,
    startNodeId: "start",
    maxSteps: 64,
    nodes,
    edges: [
      edge("a", "start", "command"),
      edge("b", "command", "branch"),
      edge("again", "branch", "command", "command.outcome.more"),
      edge("end", "branch", "done", "else"),
    ],
    bindings: [],
  };
  const saver = new MemorySaver();
  let completed = 0, joinAttempts = 0;
  const executions = new Map<string, number>();
  const runtime = compileNativeOperatorGraph(model, () => {
    throw new Error("scalar parent called");
  }, {
    flow,
    rootRequestId: "case",
    checkpointer: saver,
    assertBoundary: () => {},
    immutableConsultations: {
      plan: (_node, _inputs, _values, invocation) => {
        const groupId = `g${completed}`;
        const member = (ordinal: number) => ({
          ordinal,
          callId: `c${ordinal}`,
          effectKey: `${groupId}-e${ordinal}`,
          argumentsDigest: `a${ordinal}`,
          choice: { kind: "consult_model" as const, text: "", inputJson: "{}" },
          request: { operation: "inspect" as const, version: "v" },
          responseCharacters: 10,
          flowStepOrdinal: invocation.step + ordinal + 1,
        });
        return Promise.resolve<ImmutableConsultationGroupManifest>({
          groupId,
          manifestDigest: `${groupId}-digest`,
          runId: "run",
          occurrenceId: "command",
          batchId: "batch",
          firstOrdinal: 0,
          identity: {
            operatorId: "o",
            invocationKey: "inv",
            scope: { kind: "request", scopeId: "case", rootRequestId: "case" },
            purpose: "conversation",
          },
          contribution: { id: "input", kind: "input" },
          businessRevision: {
            __assemblyRuntimeRevision: {
              systemId: "s",
              operatorId: "o",
              revision: 1,
              modelDigest: model.version.digest,
            },
          },
          executionPin: { modelDigest: model.version.digest },
          sourcePin: { version: "v", digest: "source" },
          members: [member(0), member(1)],
          limits: { responseCharacters: 20, flowSteps: 3 },
        });
      },
      register: (manifest) => Promise.resolve(manifest),
      member: (manifest, member) => {
        executions.set(
          member.effectKey,
          (executions.get(member.effectKey) ?? 0) + 1,
        );
        return Promise.resolve<ImmutableConsultationMemberOutcome>({
          groupId: manifest.groupId,
          callId: member.callId,
          effectKey: member.effectKey,
          argumentsDigest: member.argumentsDigest,
          result: {
            status: "succeeded",
            code: "OK",
            details: "x".repeat(1024),
          },
          messages: [],
          events: [],
        });
      },
      join: (_manifest, outcomes) => {
        assert.equal(outcomes.length, 2);
        if (joinAttempts++ === 0) {
          return Promise.reject(
            new Error("interrupt join after worker writes"),
          );
        }
        completed++;
        return Promise.resolve({
          outputs: { outcome: { more: completed < 3 } },
        });
      },
    },
  });
  const config = {
    configurable: { thread_id: "group-cleanup" },
    recursionLimit: 132,
  };
  await assert.rejects(
    () => runtime.graph.invoke(runtime.initialState(), config),
    /interrupt join/,
  );
  const failed = await runtime.graph.getState(config);
  assert.equal(Object.keys(failed.values.immutableOutcomes).length, 2);
  const result = await runtime.graph.invoke(null, config);
  assert.equal(completed, 3);
  assert.equal(executions.size, 6);
  assert(
    [...executions.values()].every((count) => count === 1),
    "join replay must retain pending worker writes",
  );
  assert.deepEqual(result.immutableOutcomes, {});
  const counts: number[] = [];
  for await (const checkpoint of runtime.graph.getStateHistory(config)) {
    counts.push(Object.keys(checkpoint.values.immutableOutcomes ?? {}).length);
  }
  assert(
    counts.some((count) => count === 2),
    "history must contain joined member receipts",
  );
  assert(
    counts.every((count) => count <= 2),
    "closed groups must not accumulate in later checkpoints",
  );
});

Deno.test("receipt cleanup is idempotent, group scoped and leaves replay checkpoint unchanged", () => {
  const receipt = (groupId: string): ImmutableConsultationMemberOutcome => ({
    groupId,
    callId: "c",
    effectKey: `${groupId}-effect`,
    argumentsDigest: "args",
    result: { status: "succeeded", code: "OK", details: "value" },
    messages: [],
    events: [],
  });
  const a = receipt("a"), b = receipt("b");
  const checkpoint = mergeImmutableReceipts({}, {
    kind: "merge",
    receipts: {
      [immutableReceiptKey("a", "c")]: a,
      [immutableReceiptKey("b", "c")]: b,
    },
  });
  const cleared = mergeImmutableReceipts(checkpoint, {
    kind: "clear",
    groupId: "a",
  });
  assert.deepEqual(cleared, { [immutableReceiptKey("b", "c")]: b });
  assert.deepEqual(
    mergeImmutableReceipts(cleared, { kind: "clear", groupId: "a" }),
    cleared,
  );
  assert.deepEqual(checkpoint[immutableReceiptKey("a", "c")], a);
  assert.deepEqual(
    mergeImmutableReceipts(checkpoint, { kind: "clear", groupId: "a" }),
    cleared,
  );
});
