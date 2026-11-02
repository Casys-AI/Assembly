import type { ConversationsSnapshot } from "../../../src/domain/work/records/conversations.ts";
import { messageCaseId, parseCasesSnapshot } from "../../lib/cases/cases.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";

/** Explicit browser fixtures for the scoped read transport. Runtime identities
 * deliberately differ from the static host identity. Optional peer rows exercise
 * the existing tree presentation only; the current server bridge exposes its
 * owner and does not thereby gain peer commands or reads. */
export function seedRequestCases(
  state: WorkbenchState,
  collection: { systemId: string; cases: readonly unknown[] },
  roster: ConversationsSnapshot | null = state.agentConversations.snapshot
    .peek(),
  options: { presentationPeers?: boolean } = {},
) {
  const parsed = parseCasesSnapshot(collection);
  const cases = parsed.cases.filter((record) => record.type === "request");
  state.requests.context.value = {
    projectId: "fixture-project",
    systemId: parsed.systemId,
  };
  state.requests.sessionReady.value = true;
  state.requests.cases.accept({ systemId: parsed.systemId, cases });
  const snapshots = new Map<string, ConversationsSnapshot>();
  for (const record of cases) {
    const owner = roster?.conversations.find((agent) =>
      agent.nativeId === record.owner
    );
    if (!owner) continue;
    const selected = options.presentationPeers
      ? roster!.conversations
      : [owner];
    snapshots.set(record.id, {
      systemId: `request:${record.id}:fixture`,
      defaultAgentId: owner.agentId,
      version: `request:${record.id}:${roster!.version}`,
      conversations: selected.map((agent) => ({
        ...structuredClone(agent),
        runtimeOwned: agent.runtimeOwned ?? true,
        messages: agent.messages.filter((message) =>
          messageCaseId(message) === record.id
        ),
        effectiveModelUpdates: agent.effectiveModelUpdates?.filter((update) =>
          update.caseId === record.id
        ),
      })),
    });
  }
  state.requests.snapshots.value = snapshots;
}
