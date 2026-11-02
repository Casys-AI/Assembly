import { executeFlow } from "../../../../test/support/native-flow-oracle.ts";
import assert from "node:assert/strict";
import {
  compileModelFlow,
  evaluateGuard,
  type FlowHandler,
  type FlowProjection,
  type FlowValues,
} from "./flow.ts";
import {
  CONVERSATION,
  PROMOTION,
} from "../../../../test/fixtures/native-flows.ts";
const conversationId = "4c04d8e9-804b-461e-bb9b-e93d835f9e43";
const promotionId = "6ba729a0-81e7-435e-80ce-749f239b3b0d";
const clone = (graph: FlowProjection): FlowProjection => structuredClone(graph);
const compileConversation = (graph = CONVERSATION, maxSteps = 256) =>
  compileModelFlow(graph, { rootNativeId: conversationId, maxSteps });
function conversationHandler(
  calls: string[],
  kind: string,
  admitted = true,
): FlowHandler {
  let choices = 0;
  return (action, inputs) => {
    calls.push(action.mechanism!);
    switch (action.mechanism) {
      case "read_case":
        return { outputs: { record: { revision: 3 } } };
      case "choose_move":
        assert.equal((inputs.record as { revision: number }).revision, 3);
        return { outputs: { choice: { kind: choices++ ? "reply" : kind } } };
      case "reply":
        return { outputs: { response: { text: "done" } } };
      case "await_input":
        return { suspend: true };
      case "check_invocation":
        assert.equal((inputs.choice as { kind: string }).kind, kind);
        return { outputs: { decision: { admitted } } };
      case "invoke_tool":
        assert.equal((inputs.decision as { admitted: boolean }).admitted, true);
        return { outputs: { outcome: { result: "tool result" } } };
      case "report_refusal":
        return { outputs: { outcome: { result: "refused" } } };
      case "submit_proposal":
        return {
          outputs: {
            submission: { awaitingInput: true },
            outcome: { result: "pending" },
          },
        };
      case "observe_outcome":
        assert.ok(inputs.outcome);
        return {};
      default:
        throw new Error("Unexpected mechanism");
    }
  };
}
Deno.test("native conversation edges and bindings govern repeated actions and suspension", async () => {
  const flow = compileConversation();
  assert.equal(flow.edges.length, 20);
  const calls: string[] = [];
  const result = await executeFlow(
    flow,
    {},
    conversationHandler(calls, "invoke_tool"),
  );
  assert.deepEqual(calls, [
    "read_case",
    "choose_move",
    "check_invocation",
    "invoke_tool",
    "observe_outcome",
    "read_case",
    "choose_move",
    "reply",
    "await_input",
  ]);
  assert.equal(result.status, "suspended");
  assert.equal(result.cursor!.nodeId, "f547e0ab-a5df-412f-9963-e52500bebabb");
  assert.ok(
    result.events.some((event) =>
      event.edgeId === "20ba723f-7329-49ea-981b-604f3b047eaa"
    ),
  );
  assert.ok(
    result.events.every((event) => event.source.file && event.source.line),
  );
});
Deno.test("native guards select refusal and source else selects proposal", async () => {
  const refused: string[] = [];
  await executeFlow(
    compileConversation(),
    {},
    conversationHandler(refused, "invoke_tool", false),
  );
  assert.ok(refused.includes("report_refusal"));
  assert.ok(!refused.includes("invoke_tool"));
  const proposal: string[] = [];
  await executeFlow(
    compileConversation(),
    {},
    conversationHandler(proposal, "propose_tool"),
  );
  assert.deepEqual(proposal, [
    "read_case",
    "choose_move",
    "submit_proposal",
    "await_input",
  ]);
});
Deno.test("changing native edge destinations changes executed handlers", async () => {
  const graph = clone(CONVERSATION);
  const reply = graph.edges.find((edge) =>
    edge.nativeId === "b35edb1e-3717-4f53-aaa2-85d4265d1e19"
  )!;
  const proposal = graph.edges.find((edge) =>
    edge.nativeId === "70a1864a-252a-46d5-b04a-b0664057dc9c"
  )!;
  [reply.target, proposal.target] = [proposal.target, reply.target];
  const calls: string[] = [];
  await executeFlow(
    compileConversation(graph),
    {},
    conversationHandler(calls, "reply"),
  );
  assert.deepEqual(calls, [
    "read_case",
    "choose_move",
    "submit_proposal",
    "await_input",
  ]);
});
Deno.test("changing native guard changes branch and duplicate matches fail closed", async () => {
  const graph = clone(CONVERSATION);
  const reply = graph.edges.find((edge) =>
    edge.nativeId === "b35edb1e-3717-4f53-aaa2-85d4265d1e19"
  )!;
  reply.guard = '(chooseNextMove.choice.kind == "other")';
  const calls: string[] = [];
  await executeFlow(
    compileConversation(graph),
    {},
    conversationHandler(calls, "reply"),
  );
  assert.ok(calls.includes("submit_proposal"));
  reply.guard = "true";
  graph.edges.find((edge) =>
    edge.nativeId === "52915768-21b0-4056-8983-e7e39448cc18"
  )!.guard = "true";
  await assert.rejects(
    () =>
      executeFlow(
        compileConversation(graph),
        {},
        conversationHandler([], "reply"),
      ),
    /Multiple native guards/,
  );
});
Deno.test("native promotion branches execute admitted and refused paths with bound candidate", async () => {
  const flow = compileModelFlow(PROMOTION, { rootNativeId: promotionId });
  assert.equal(flow.edges.length, 12);
  for (const passed of [true, false]) {
    const calls: string[] = [];
    const candidate = { digest: "exact" };
    const result = await executeFlow(flow, {}, (action, inputs) => {
      calls.push(action.mechanism!);
      if (action.mechanism === "propose_candidate") {
        return { outputs: { candidate } };
      }
      if (action.mechanism === "test_candidate") {
        assert.equal(inputs.candidate, candidate);
        return { outputs: { result: { passed } } };
      }
      if (action.mechanism === "decide_admission") {
        assert.equal((inputs.tests as { passed: boolean }).passed, true);
        return {
          outputs: { decision: { admitted: true, candidateDigest: "exact" } },
        };
      }
      assert.equal(inputs.candidate, candidate);
      return {};
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(
      calls,
      passed
        ? [
          "propose_candidate",
          "test_candidate",
          "decide_admission",
          "activate_candidate",
        ]
        : ["propose_candidate", "test_candidate", "refuse_candidate"],
    );
  }
});
Deno.test("suspension resumes native cursor without repeating earlier mechanisms", async () => {
  const flow = compileModelFlow(PROMOTION, { rootNativeId: promotionId });
  const context: FlowValues = {};
  const first = await executeFlow(flow, context, (action) => {
    if (action.mechanism === "propose_candidate") {
      return { outputs: { candidate: { digest: "exact" } } };
    }
    if (action.mechanism === "test_candidate") {
      return { outputs: { result: { passed: true } } };
    }
    return { suspend: true };
  });
  const calls: string[] = [];
  const resumed = await executeFlow(flow, context, (action) => {
    calls.push(action.mechanism!);
    return action.mechanism === "decide_admission"
      ? { outputs: { decision: { admitted: true, candidateDigest: "exact" } } }
      : {};
  }, { cursor: first.cursor });
  assert.equal(resumed.status, "completed");
  assert.deepEqual(calls, ["decide_admission", "activate_candidate"]);
});
Deno.test("missing edges, unknown types, malformed guards, fork and ambiguous root are rejected", () => {
  const missing = clone(CONVERSATION);
  missing.edges = missing.edges.filter((edge) =>
    edge.nativeId !== "0f7eed38-0b49-43c6-9c32-36026b9e86fa"
  );
  assert.throws(() => compileConversation(missing), /Missing native outgoing/);
  const unknown = clone(CONVERSATION);
  unknown.nodes.find((node) =>
    node.metaclass === "ActionDefinition" && node.label === "ChooseNextMove"
  )!.symbol = "Other::Unknown";
  assert.throws(
    () => compileConversation(unknown),
    /Unsupported native executable type/,
  );
  const guard = clone(CONVERSATION);
  guard.edges.find((edge) => edge.guard?.includes("kind"))!.guard =
    "globalThis.process.exit()";
  assert.throws(() => compileConversation(guard), /Unsupported native guard/);
  const fork = clone(CONVERSATION);
  fork.nodes.find((node) => node.label === "resumeCase")!.metaclass =
    "ForkNode";
  assert.throws(
    () => compileConversation(fork),
    /Unsupported native concurrency/,
  );
  const ambiguous = clone(CONVERSATION);
  ambiguous.nodes = [
    ...ambiguous.nodes,
    ambiguous.nodes.find((node) => node.nativeId === conversationId)!,
  ];
  assert.throws(() => compileConversation(ambiguous), /Expected one concrete/);
});
Deno.test("missing values, missing outputs, invalid cursor and bounded cycles fail closed", async () => {
  assert.throws(
    () => evaluateGuard("test.result.passed", {}),
    /Missing native feature/,
  );
  await assert.rejects(
    () => executeFlow(compileConversation(), {}, () => ({})),
    /Missing declared native action output/,
  );
  await assert.rejects(
    () =>
      executeFlow(compileConversation(), {}, () => ({}), {
        cursor: { nodeId: "other" },
      }),
    /Unknown native resume/,
  );
  await assert.rejects(
    () =>
      executeFlow(
        compileConversation(CONVERSATION, 5),
        {},
        conversationHandler([], "reply"),
      ),
    /exceeded admitted step limit/,
  );
  await assert.rejects(
    () => executeFlow(compileConversation(), {}, () => ({}), { maxSteps: 257 }),
    /exceeds admitted native policy/,
  );
  const noMatch = clone(CONVERSATION);
  const changedBranch = noMatch.edges.find((edge) =>
    edge.nativeId === "70a1864a-252a-46d5-b04a-b0664057dc9c"
  )!;
  changedBranch.guard = "false";
  changedBranch.guardIds = ["native-test-guard"];
  await assert.rejects(
    () =>
      executeFlow(
        compileConversation(noMatch),
        {},
        conversationHandler([], "unknown"),
      ),
    /No native control branch/,
  );
});
Deno.test("safe native expressions handle booleans, paths, comparison and implication", () => {
  assert.equal(
    evaluateGuard(
      'not false and (record.n >= 3) and record.name != "bad" implies true',
      { record: { n: 4, name: "good" } },
    ),
    true,
  );
  assert.equal(
    evaluateGuard("record.n < 3 or false", { record: { n: 4 } }),
    false,
  );
  assert.equal(evaluateGuard("'a' == 'a'", {}), true);
  for (
    const source of [
      "true; throw 1",
      "process.exit()",
      "x.constructor",
      "true && true",
      "else",
    ]
  ) assert.throws(() => evaluateGuard(source, {}));
  assert.throws(
    () => evaluateGuard("record.n == true", { record: { n: 1 } }),
    /incompatible/,
  );
  assert.throws(
    () => evaluateGuard("record.n", { record: { n: 1 } }),
    /boolean/,
  );
});

Deno.test("native assertion expressions are mandatory and unsupported references reject compilation", () => {
  const missing = clone(CONVERSATION);
  delete missing.nodes.find((node) =>
    node.metaclass === "AssertConstraintUsage"
  )!.expression;
  assert.throws(
    () => compileConversation(missing),
    /Missing native assertion expression/,
  );
  const unsupported = clone(PROMOTION);
  unsupported.nodes.find((node) => node.label === "testedAdmission")!
    .expression = "hostOverride.approved";
  assert.throws(
    () => compileModelFlow(unsupported, { rootNativeId: promotionId }),
    /Unknown native assertion feature/,
  );
});
Deno.test("input-only native assertion blocks the primitive before side effects", async () => {
  const flow = compileConversation();
  let invoked = false;
  await assert.rejects(
    () =>
      executeFlow(flow, {
        executeAction: { decision: { admitted: false } },
      }, () => {
        invoked = true;
        return { outputs: { outcome: {} } };
      }, {
        cursor: { nodeId: "8419e180-3f35-4d1b-a6c4-9cf6c9dbaccf" },
      }),
    /Native assertion failed before action: 45c0976c-3148-4ae5-985b-ec6570c0f674/,
  );
  assert.equal(invoked, false);
});
Deno.test("native output assertion rejects mismatched admission digest before activation", async () => {
  const flow = compileModelFlow(PROMOTION, { rootNativeId: promotionId });
  let activated = false;
  const context: FlowValues = {};
  await assert.rejects(
    () =>
      executeFlow(flow, context, (action) => {
        if (action.mechanism === "propose_candidate") {
          return { outputs: { candidate: { digest: "exact" } } };
        }
        if (action.mechanism === "test_candidate") {
          return { outputs: { result: { passed: true } } };
        }
        if (action.mechanism === "decide_admission") {
          return {
            outputs: { decision: { admitted: true, candidateDigest: "other" } },
          };
        }
        activated = true;
        return {};
      }),
    /Native assertion failed after action: a250c233-dbb5-454b-b70e-5e1cee731b83/,
  );
  assert.equal(activated, false);
  assert.equal((context.activate as FlowValues).admission, undefined);
});
Deno.test("editing a native assertion changes executable behavior", async () => {
  const graph = clone(PROMOTION);
  graph.nodes.find((node) => node.label === "admittedExecution")!.expression =
    "not admission.admitted";
  const flow = compileModelFlow(graph, { rootNativeId: promotionId });
  const calls: string[] = [];
  await assert.rejects(() =>
    executeFlow(flow, {}, (action) => {
      calls.push(action.mechanism!);
      if (action.mechanism === "propose_candidate") {
        return { outputs: { candidate: { digest: "exact" } } };
      }
      if (action.mechanism === "test_candidate") {
        return { outputs: { result: { passed: true } } };
      }
      if (action.mechanism === "decide_admission") {
        return {
          outputs: { decision: { admitted: true, candidateDigest: "exact" } },
        };
      }
      return {};
    }), /Native assertion failed before action/);
  assert.ok(!calls.includes("activate_candidate"));
});
Deno.test("native bindings reject mismatched identity paths and duplicate input writers", () => {
  const mismatch = clone(CONVERSATION);
  mismatch.edges.find((edge) => edge.kind === "binding")!.sourceFeaturePath = [
    "other-native-feature",
  ];
  assert.throws(() => compileConversation(mismatch), /feature path disagrees/);
  const duplicate = clone(CONVERSATION);
  const input = duplicate.edges.find((edge) => edge.kind === "binding")!;
  duplicate.edges = [...duplicate.edges, {
    ...input,
    id: "duplicate",
    nativeId: "duplicate",
  }];
  assert.throws(
    () => compileConversation(duplicate),
    /Ambiguous native input binding/,
  );
  assert.throws(() => evaluateGuard("false and 1", {}), /boolean/);
  assert.throws(() => evaluateGuard("true or 1", {}), /boolean/);
  assert.throws(() => evaluateGuard("1e999 == 1e999", {}), /Non-finite/);
});

Deno.test("assertions on native controls reject compilation instead of being ignored", () => {
  for (
    const owner of PROMOTION.nodes.filter((node) =>
      node.metaclass === "DecisionNode" || node.metaclass === "MergeNode" ||
      node.symbol === "Actions::Action::start" ||
      node.symbol === "Actions::Action::done"
    )
  ) {
    const graph = clone(PROMOTION);
    graph.nodes = [...graph.nodes, {
      id: `assert-${owner.nativeId}`,
      nativeId: `assert-${owner.nativeId}`,
      metaclass: "AssertConstraintUsage",
      label: "mustStop",
      parentId: owner.id,
      expression: "false",
      source: { file: "native.sysml", line: 1 },
    }];
    assert.throws(
      () => compileModelFlow(graph, { rootNativeId: promotionId }),
      /Unsupported native assertion placement/,
    );
  }
});
Deno.test("atomic primitives reject nested executable elements in occurrences and declared types", () => {
  const activation = PROMOTION.nodes.find((node) =>
    node.label === "activate" && node.metaclass === "ActionUsage"
  )!;
  const typeId =
    PROMOTION.edges.find((edge) =>
      edge.source === activation.id && edge.kind === "typing"
    )!.target;
  for (const parentId of [activation.id, typeId]) {
    for (
      const metaclass of [
        "ForkNode",
        "JoinNode",
        "DecisionNode",
        "MergeNode",
        "ActionUsage",
        "PerformActionUsage",
        "AcceptActionUsage",
        "SendActionUsage",
      ]
    ) {
      const graph = clone(PROMOTION);
      graph.nodes = [...graph.nodes, {
        id: "nested-executable",
        nativeId: "nested-executable",
        label: "nested",
        metaclass,
        parentId,
        source: { file: "native.sysml", line: 2 },
      }];
      assert.throws(
        () => compileModelFlow(graph, { rootNativeId: promotionId }),
        /Unsupported nested native executable element/,
      );
    }
  }
  const flow = compileConversation();
  assert.equal(
    flow.nodes.find((node) => node.mechanism === "await_input")!.acceptActionId,
    "40aed40e-9e9d-4c29-9fc0-505ade9bf311",
  );
  const duplicateAccept = clone(CONVERSATION);
  const accept = duplicateAccept.nodes.find((node) =>
    node.metaclass === "AcceptActionUsage"
  )!;
  duplicateAccept.nodes = [...duplicateAccept.nodes, {
    ...accept,
    id: "second-accept",
    nativeId: "second-accept",
  }];
  assert.throws(
    () => compileConversation(duplicateAccept),
    /Ambiguous native input acceptance/,
  );
});
Deno.test("permuting native projection arrays preserves compiled semantics and execution digest", async () => {
  const { executionDigest } = await import(
    "../../primitives/execution-digest.ts"
  );
  const graph = clone(CONVERSATION);
  const reply = graph.nodes.find((node) =>
    node.label === "replyOrClarify" && node.metaclass === "ActionUsage"
  )!;
  graph.nodes = [
    ...graph.nodes,
    ...["assert-z", "assert-a"].map((id) => ({
      id,
      nativeId: id,
      metaclass: "AssertConstraintUsage",
      label: id,
      parentId: reply.id,
      expression: "true",
      expressionSourceIds: ["source-z", "source-a"],
      source: { file: "native.sysml", line: 3 },
    })),
  ];
  const original = compileConversation(graph);
  const permuted = clone(graph);
  permuted.nodes = [...permuted.nodes].reverse();
  permuted.edges = [...permuted.edges].reverse();
  for (const node of permuted.nodes) node.expressionSourceIds?.reverse();
  for (const edge of permuted.edges) edge.guardIds?.reverse();
  const compiled = compileConversation(permuted);
  assert.deepEqual(compiled, original);
  assert.equal(
    await executionDigest(compiled),
    await executionDigest(original),
  );
  const originalCalls: string[] = [], permutedCalls: string[] = [];
  const first = await executeFlow(
    original,
    {},
    conversationHandler(originalCalls, "reply"),
  );
  const second = await executeFlow(
    compiled,
    {},
    conversationHandler(permutedCalls, "reply"),
  );
  assert.deepEqual(permutedCalls, originalCalls);
  assert.deepEqual(second.events, first.events);
});
