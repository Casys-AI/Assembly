import { executeFlow } from "../../../../test/support/native-flow-oracle.ts";
import assert from "node:assert/strict";
import { compileModelFlow, type FlowProjection } from "./flow.ts";
import { CONVERSATION } from "../../../../test/fixtures/native-flows.ts";

function oneAction(symbol = "RefundLab::ReadRefundCase"): FlowProjection {
  const source = { file: "refund.sysml", line: 1 };
  return {
    nodes: [
      {
        id: "flow",
        nativeId: "flow-native",
        metaclass: "PerformActionUsage",
        label: "refund",
        source,
      },
      {
        id: "start",
        nativeId: "start-native",
        metaclass: "ActionUsage",
        label: "start",
        symbol: "Actions::Action::start",
        parentId: "flow",
        source,
      },
      {
        id: "read",
        nativeId: "read-native",
        metaclass: "ActionUsage",
        label: "read",
        parentId: "flow",
        source,
      },
      {
        id: "done",
        nativeId: "done-native",
        metaclass: "ActionUsage",
        label: "done",
        symbol: "Actions::Action::done",
        parentId: "flow",
        source,
      },
      {
        id: "read-type",
        nativeId: "read-type-native",
        metaclass: "ActionDefinition",
        label: "ReadRefundCase",
        symbol,
        source,
      },
    ],
    edges: [
      {
        id: "typing",
        nativeId: "typing-native",
        source: "read",
        target: "read-type",
        kind: "typing",
        metaclass: "FeatureTyping",
        sourceEvidence: source,
      },
      {
        id: "start-read",
        nativeId: "start-read-native",
        source: "start",
        target: "read",
        kind: "succession",
        metaclass: "SuccessionAsUsage",
        sourceEvidence: source,
      },
      {
        id: "read-done",
        nativeId: "read-done-native",
        source: "read",
        target: "done",
        kind: "succession",
        metaclass: "SuccessionAsUsage",
        sourceEvidence: source,
      },
    ],
  };
}

Deno.test("the default native implementation registry remains unchanged", () => {
  const flow = compileModelFlow(CONVERSATION, {
    rootNativeId: "4c04d8e9-804b-461e-bb9b-e93d835f9e43",
  });
  assert(flow.nodes.some((node) => node.mechanism === "read_case"));
  assert(flow.nodes.some((node) => node.mechanism === "await_input"));
  assert.throws(
    () => compileModelFlow(oneAction(), { rootNativeId: "flow-native" }),
    /Unsupported native executable type/,
  );
});

Deno.test("a custom qualified registry selects its declared mechanism", async () => {
  const flow = compileModelFlow(oneAction(), {
    rootNativeId: "flow-native",
    implementations: { "RefundLab::ReadRefundCase": "read_refund_case" },
  });
  assert.equal(
    flow.nodes.find((node) => node.name === "read")?.mechanism,
    "read_refund_case",
  );
  const calls: string[] = [];
  const result = await executeFlow(flow, {}, (node) => {
    calls.push(node.mechanism!);
    return {};
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["read_refund_case"]);
});

Deno.test("custom registries require exact qualified symbols and never fall back to defaults", () => {
  const compile = (
    graph: FlowProjection,
    implementations: Readonly<Record<string, string>>,
  ) =>
    compileModelFlow(graph, { rootNativeId: "flow-native", implementations });
  assert.throws(
    () => compile(oneAction(), { ReadRefundCase: "read_refund_case" }),
    /Invalid native implementation entry/,
  );
  assert.throws(
    () =>
      compile(oneAction("OtherLab::ReadRefundCase"), {
        "RefundLab::ReadRefundCase": "read_refund_case",
      }),
    /Unsupported native executable type/,
  );
  assert.throws(
    () =>
      compile(oneAction("ASEConversation::ReadCaseState"), {
        "RefundLab::ReadRefundCase": "read_refund_case",
      }),
    /Unsupported native executable type/,
  );
  assert.throws(
    () =>
      compile(oneAction("ReadRefundCase"), {
        "RefundLab::ReadRefundCase": "read_refund_case",
      }),
    /Unsupported native executable type/,
  );
});

Deno.test("empty or unsafe registries are rejected before a mechanism can execute", () => {
  for (
    const implementations of [
      {},
      { "RefundLab::__proto__": "read_refund_case" },
      { "RefundLab::ReadRefundCase": "constructor" },
      { "RefundLab::ReadRefundCase": "read-refund-case" },
      { "RefundLab::ReadRefundCase": "" },
      Object.assign(Object.create({ "OtherLab::Hidden": "hidden" }), {
        "RefundLab::ReadRefundCase": "read_refund_case",
      }),
    ]
  ) {
    assert.throws(
      () =>
        compileModelFlow(oneAction(), {
          rootNativeId: "flow-native",
          implementations,
        }),
      /Invalid native implementation/,
    );
  }
});

Deno.test("an explicitly registered mechanism still needs an implementing handler", async () => {
  const flow = compileModelFlow(oneAction(), {
    rootNativeId: "flow-native",
    implementations: { "RefundLab::ReadRefundCase": "unimplemented" },
  });
  const effects: string[] = [];
  await assert.rejects(() =>
    executeFlow(flow, {}, (node) => {
      if (node.mechanism !== "read_refund_case") {
        throw new Error("Unknown primitive mechanism");
      }
      effects.push(node.mechanism);
      return {};
    }), /Unknown primitive mechanism/);
  assert.deepEqual(effects, []);
});

Deno.test("the copied custom registry uses exactly the entries that were validated", () => {
  let reads = 0;
  const implementations = Object.defineProperty(
    {},
    "RefundLab::ReadRefundCase",
    {
      enumerable: true,
      get: () => ++reads === 1 ? "read_refund_case" : "constructor",
    },
  ) as Record<string, string>;
  const flow = compileModelFlow(oneAction(), {
    rootNativeId: "flow-native",
    implementations,
  });
  assert.equal(reads, 1);
  assert.equal(
    flow.nodes.find((node) => node.name === "read")?.mechanism,
    "read_refund_case",
  );
});
