import type { SystemRuntimeState } from "../../../src/application/work/runtime/state.ts";

export const authorities = {
  human: "You decide whether each tool is admitted.",
  builder: "Admission by the builder, under delegation.",
  reviewer:
    "Review and admission by the reviewer; activation by the host check.",
};
export const count = (n: number, singular: string, plural: string) =>
  `${n} ${n === 1 ? singular : plural}`;
export function describeState(
  snapshot: SystemRuntimeState,
  counts?: {
    agentCount: number;
    activeToolCount: number;
    messageCount: number;
  },
) {
  return `${
    count(
      counts?.agentCount ??
        1 + Number(Boolean(snapshot.configuration?.reviewer)),
      "agent",
      "agents",
    )
  }, ${
    count(
      counts?.activeToolCount ??
        snapshot.candidates.filter((c) => c.stage === "active").length,
      "active tool",
      "active tools",
    )
  }, ${
    count(
      counts?.messageCount ?? snapshot.messages.length,
      "message",
      "messages",
    )
  }`;
}
