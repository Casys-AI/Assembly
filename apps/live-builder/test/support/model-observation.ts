import { equal, ok } from "node:assert/strict";
import type { ChatContext } from "../../src/domain/work/dialogue.ts";

/** Mandatory source reads may follow a requested consultation. Scripted provider
 * fixtures select its exact observation instead of assuming it is the last one. */
export function latestModelObservation(
  context: ChatContext,
  operation: string,
): unknown {
  const message = context.messages.findLast((entry) => {
    const value = entry.observation?.value as {
      result?: { operation?: string };
      status?: string;
      code?: string;
    } | undefined;
    return value?.result?.operation === operation ||
      value?.status === "refused" && value.code === operation;
  });
  ok(message?.observation, `Missing observed model result: ${operation}`);
  equal(message.observation.kind, "model-context");
  return message.observation.value;
}
