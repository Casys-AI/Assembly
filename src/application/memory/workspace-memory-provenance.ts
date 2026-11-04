import type { SystemRuntimeState } from "../work/runtime/state.ts";
import type { MemoryProvenancePort } from "./ports/provenance.ts";

/** Resolve memory evidence against the owning operator's current local history. */
export function workspaceMemoryProvenance(
  snapshotForOwner: (
    ownerId: string,
  ) => Pick<SystemRuntimeState, "messages"> | undefined,
): MemoryProvenancePort {
  return {
    verify(ownerId, content) {
      const snapshot = snapshotForOwner(ownerId);
      if (!snapshot) return Promise.resolve(false);
      const decision = snapshot.messages.find((message) =>
        message.id === content.origin.decisionId
      );
      if (decision?.role !== "assistant" || !decision.execution?.actionId) {
        return Promise.resolve(false);
      }
      const reference = (value: string, outcome = false) => {
        if (!value.startsWith("message:")) return false;
        const message = snapshot.messages.find((message) =>
          message.id === value.slice("message:".length)
        );
        return !!message?.execution?.digest && (!outcome ||
          (message.role === "tool" && !!message.execution.actionId &&
            !!message.observation));
      };
      return Promise.resolve(
        content.origin.sourceRefs.every((value) => reference(value)) &&
          (content.outcome.status === "pending" ||
            content.outcome.evidenceRefs.every((value) =>
              reference(value, true)
            )),
      );
    },
  };
}
