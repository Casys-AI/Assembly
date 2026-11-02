import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
} from "node:assert/strict";
import type {
  AgentConversation,
  OperatorTool,
} from "../../../../src/domain/work/records/conversations.ts";
import { createWorkbenchState } from "../../../lib/workbench/state.ts";
import { snapshot } from "../../../test/support/workbench-fixture.ts";
import type { VNode } from "preact";
import { probeRoot } from "../../../test/support/hook-probe.ts";
import { press } from "../../../test/support/press.ts";
import {
  createToolProposalSession,
  ToolProposalDetail,
} from "./ToolProposalDetail.tsx";

Deno.test("an exact tool adjustment retains its text and error through loading and stale refresh while actions are blocked", async () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const conversation: AgentConversation = {
    agentId: "owner",
    nativeId: "native:owner",
    name: "Owner",
    responsibility: "",
    primary: true,
    canSend: true,
    revision: 7,
    busy: false,
    phase: "Ready",
    messages: [],
    modelDigest: "model",
  };
  const tool: OperatorTool = {
    agentId: "owner",
    agentName: "Owner",
    revision: 7,
    candidate: {
      ...snapshot().candidates[0],
      name: "Exact tool",
      requiredAuthority: "human",
    },
  };
  state.agentConversations.accept({
    systemId: "ui-fixture",
    version: "v1",
    defaultAgentId: "owner",
    conversations: [conversation],
  });
  const catalogue = { systemId: "ui-fixture", version: "v1", tools: [tool] };
  state.operatorTools.accept(catalogue);
  const session = createToolProposalSession();
  const selection = {
    kind: "selected" as const,
    target: {
      operator: "owner",
      candidate: tool.candidate.id,
      digest: tool.candidate.digest,
    },
  };
  const root = probeRoot();
  let node!: VNode;
  function Probe() {
    node = ToolProposalDetail({ state, selection, session });
    return null;
  }
  const show = () => root.show(Probe, {});
  const draw = () => press(node);
  let decisions = 0;
  state.decideOperatorTool = () => {
    decisions++;
    return Promise.resolve(true);
  };
  const frame = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestAnimationFrame",
  );
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: () => 0,
  });
  try {
    await show();
    draw().click("Adjust");
    draw().input?.({ currentTarget: { value: "Keep this exact request" } });
    session.workflow.error.value = "Previous message failed";
    for (const loading of [true, false]) {
      state.operatorTools.loading.value = loading;
      state.operatorTools.stale.value = !loading;
      await show();
      const read = draw();
      match(read.html, /Last observed tool proposal/);
      match(read.html, /value="Keep this exact request"/);
      match(read.html, /Previous message failed/);
      match(read.html, /type="submit" class="proposal-accept" disabled/);
      read.submit?.({ preventDefault() {} });
      await Promise.resolve();
      equal(decisions, 0);
    }
    state.operatorTools.accept({ ...catalogue, version: "v2" });
    await show();
    const restored = draw();
    match(restored.html, /value="Keep this exact request"/);
    match(restored.html, /Previous message failed/);
    doesNotMatch(
      restored.html,
      /type="submit" class="proposal-accept" disabled/,
    );
    deepStrictEqual([
      session.workflow.adjusting.peek(),
      session.workflow.declined,
    ], [true, false]);
  } finally {
    await root.restore();
    if (frame) {
      Object.defineProperty(globalThis, "requestAnimationFrame", frame);
    } else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    state.dispose();
  }
});
