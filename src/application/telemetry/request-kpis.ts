import type { Case } from "../../domain/work/entities/cases.ts";
import type { SystemRuntimeState } from "../../domain/work/dialogue.ts";

/** Duration and human interventions in retained Request journals. */
export interface RequestKpis {
  readonly durationMs: number | null;
  readonly humanInterventions: {
    readonly messages: number;
    readonly decisions: number;
  };
}

/** Count exact Request correlations, excluding delegated inputs and notices.
 * IDs are scoped to each operator journal; repeated state reads are not inputs.
 * An explicit human decision counts even when publication is still pending. */
export function requestKpis(
  record: Case,
  states: readonly Pick<
    SystemRuntimeState,
    "id" | "messages" | "configuration"
  >[],
): RequestKpis {
  let messages = 0, decisions = 0;
  for (const state of states) {
    messages += state.messages.filter((message) =>
      message.caseId === record.id && message.role === "user" &&
      !(state.id === record.openedFrom.conversationId &&
        message.id === record.openedFrom.messageId) &&
      !message.work && !message.operatorNotice && !message.observation
    ).length;
    decisions += (state.configuration?.changes ?? []).filter((change) =>
      change.caseId === record.id && change.authority === "human" &&
      change.decidedAt !== undefined
    ).length;
  }
  const closedAt = record.closedAt ?? null;
  return Object.freeze({
    durationMs: closedAt === null
      ? null
      : Date.parse(closedAt) - Date.parse(record.createdAt),
    humanInterventions: Object.freeze({
      messages,
      decisions,
    }),
  });
}
