import { deepStrictEqual, equal } from "node:assert/strict";
import type { ChatContext } from "../conversation/chat-context.ts";
import { pendingHostObservations } from "./host-observations.ts";

Deno.test("pending host observations select decisions and completions once without sharing journal values", () => {
  const messages: ChatContext["messages"] = [
    "request-network-outcome:decision",
    "contribution-observation:completion",
    "other-tool-result",
  ].map((id) => ({
    id,
    role: "tool",
    text: "Recorded",
    at: "now",
    observation: { kind: "tool-result", value: { id } },
  }));
  const context: ChatContext = { messages, activeTools: [], candidates: [] };
  const observations = pendingHostObservations(context);
  deepStrictEqual(
    observations.map(({ messageId }) => messageId),
    messages.slice(0, 2).map(({ id }) => id),
  );
  equal(observations[0].value === messages[0].observation!.value, false);
  context.toolCallHistory = [{
    turn: {
      inputMessageId: "input",
      brief: {},
      requestOutcomes: observations,
    },
    assistantBlocks: [],
    results: [],
  }];
  deepStrictEqual(pendingHostObservations(context), []);
});
