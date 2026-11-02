import { equal, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../../test/support/execution-fixture.ts";
import type { SystemRuntimeState } from "../../../../domain/work/dialogue.ts";
import { selectDesignerInvocation } from "../../cases/runtime.ts";
import type { ConversationTurnHost } from "../turn-context.ts";
import { ExecuteConversationTurn } from "./conversation-handler.ts";

Deno.test("ExecuteConversationTurn delegates to the turn mechanism", async () => {
  const current = executableFixture({
    projectId: "handler-project",
    editingContextId: "handler-context",
    rootId: "handler-root",
    systemId: "handler-system",
    catalogId: "handler-catalog",
    builderId: "operator",
  });
  current.version.repositoryVersion = "commit:exact";
  const state: SystemRuntimeState = {
    id: "handler-test",
    revision: 1,
    catalogRevision: 0,
    executionModel: current,
    model: current.identity,
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "ready",
    provider: "fixture",
  };
  selectDesignerInvocation(state);
  let reads = 0;
  const host = {
    state,
    get snapshot() {
      return structuredClone(state);
    },
    ports: {},
    update: (change: (state: SystemRuntimeState) => void) => {
      change(state);
      return Promise.resolve();
    },
    currentModel: () => {
      reads++;
      return Promise.resolve(current);
    },
  } as unknown as ConversationTurnHost;
  await rejects(
    () =>
      ExecuteConversationTurn(host, undefined, {
        id: "handler:input-1",
        kind: "resume",
        inputMessageId: "input-1",
      }),
    /Native execution and immutable state history ports are required/,
  );
  equal(reads, 1);
});
