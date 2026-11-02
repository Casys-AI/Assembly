import assert from "node:assert/strict";
import type { CompiledFlowNode } from "../../../domain/model/execution/flow.ts";
import { transportNativeEffectTarget } from "./conversation.ts";

Deno.test("native effect target comes from the checked invocation input", () => {
  const node = { mechanism: "invoke_tool" } as CompiledFlowNode;
  const retainedTool = {
    resourceId: `retained-tool:v1:${"a".repeat(64)}`,
    descriptorDigest: "a".repeat(64),
    toolId: "selected",
    toolDigest: "b".repeat(64),
  };
  assert.deepEqual(
    transportNativeEffectTarget(node, {
      decision: { admitted: true, toolId: "selected", retainedTool },
    }),
    {
      kind: "invocation",
      admitted: true,
      toolId: "selected",
      behaviorId: null,
      retainedTool,
    },
  );
  assert.deepEqual(
    transportNativeEffectTarget(node, {
      decision: {
        admitted: true,
        toolId: "other",
        retainedTool: { toolId: "selected" },
      },
    }),
    { kind: "invocation", admitted: true, toolId: "other", behaviorId: null },
  );
  assert.equal(
    transportNativeEffectTarget({ mechanism: "reply" } as CompiledFlowNode, {}),
    undefined,
  );
});
