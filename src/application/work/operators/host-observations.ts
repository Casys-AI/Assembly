import type { ChatContext } from "../conversation/chat-context.ts";

export const REQUEST_OUTCOME_MESSAGE_PREFIX = "request-network-outcome:";
export const CONTRIBUTION_OBSERVATION_MESSAGE_PREFIX =
  "contribution-observation:";

/** Select host-recorded decisions and correlated contribution completions from
 * the complete scoped journal before context compaction. Once recorded in a
 * provider turn, the exact observation travels in its replay. */
export function pendingHostObservations(
  context: Pick<ChatContext, "messages" | "toolCallHistory">,
): NonNullable<ChatContext["hostObservations"]> {
  const recorded = new Set(
    context.toolCallHistory?.flatMap((entry) =>
      entry.turn?.requestOutcomes?.map((outcome) => outcome.messageId) ?? []
    ),
  );
  return context.messages.filter((message) =>
    message.role === "tool" &&
    (message.id.startsWith(REQUEST_OUTCOME_MESSAGE_PREFIX) ||
      message.id.startsWith(CONTRIBUTION_OBSERVATION_MESSAGE_PREFIX)) &&
    message.observation?.kind === "tool-result" &&
    !recorded.has(message.id)
  ).map((message) => ({
    messageId: message.id,
    value: structuredClone(message.observation!.value),
  }));
}
