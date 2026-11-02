import { deepStrictEqual, equal } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { ChangePendingError } from "../../../domain/governance/policies/governance.ts";
import { handleConversationNode } from "./flow-handlers.ts";
import type {
  ConversationTurnHost,
  ConversationTurnState,
} from "./turn-context.ts";

Deno.test("a second change exposes the exact agent lock and reaches native await-input without retrying submission", async () => {
  const model = executableFixture({
    projectId: "unit",
    editingContextId: "unit",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "builder",
  });
  const node = model.flows.conversation.nodes.find((entry) =>
    entry.mechanism === "submit_proposal"
  )!;
  const context = {
    requestedBy: "builder",
    changeId: "pending",
    caseId: "original",
  };
  const messages: string[] = [];
  let attempts = 0;
  const host = {
    // A main runtime's model port: creation is read in main.
    ports: { model: {} },
    action: (
      _node: unknown,
      run: (current: typeof model) => Promise<unknown>,
    ) => run(model),
    say: () => Promise.resolve(),
    proposeChange: () => {
      attempts++;
      throw new ChangePendingError(context);
    },
    feedback: (text: string) => {
      messages.push(text);
      return Promise.resolve();
    },
  } as unknown as ConversationTurnHost;
  const turn: ConversationTurnState = {
    resumedContribution: false,
    proposals: 0,
    decisions: 0,
    sourceDecision: {},
    failures: new Map(),
  };
  const result = await handleConversationNode.call(host, turn, node, {
    choice: {
      kind: "propose_mandate_change",
      text: "Another proposal",
      reason: "Need a host",
      requestedRights: { addNetworkHosts: ["example.org"] },
    },
  });
  equal(attempts, 1);
  equal(result.suspend, undefined);
  deepStrictEqual(result.outputs?.submission, { awaitingInput: true });
  deepStrictEqual(JSON.parse(messages[0]), {
    code: "CHANGE_PENDING",
    context,
    recovery: { action: "await-decision" },
  });
});
