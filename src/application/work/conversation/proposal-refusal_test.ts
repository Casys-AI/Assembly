import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { ChangeApprovabilityError } from "../../../domain/governance/policies/change-approvability.ts";
import { OperatorAuthorityError } from "../../../domain/governance/operator-authority-error.ts";
import { handleConversationNode } from "./flow-handlers.ts";
import type {
  ConversationTurnHost,
  ConversationTurnState,
} from "./turn-context.ts";

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
const choice = {
  kind: "propose_mandate_change",
  text: "A proposal",
  reason: "Need a right",
  requestedRights: { addNetworkHosts: ["example.org"] },
};

function setup(...refusals: Error[]) {
  const feedback: string[] = [];
  const host = {
    // A main runtime's model port: creation is read in main.
    ports: { model: {} },
    action: (
      _node: unknown,
      run: (current: typeof model) => Promise<unknown>,
    ) => run(model),
    say: () => Promise.resolve(),
    proposeChange: () => {
      throw refusals.shift();
    },
    feedback: (text: string) => {
      feedback.push(text);
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
  return { host, turn, feedback };
}

Deno.test("a coded refusal of a proposal reaches the agent as an observation, once per turn", async () => {
  const stale = new ChangeApprovabilityError(
    "STALE_PROPOSAL",
    "The base contract changed",
    { systemId: "system" },
  );
  const grant = new OperatorAuthorityError(
    "INVALID_MODEL_EDIT_GRANT",
    "The editing root is out of scope",
    { root: "ASELiveBuilder" },
  );
  const { host, turn, feedback } = setup(stale, grant);
  const result = await handleConversationNode.call(host, turn, node, {
    choice,
  });
  equal(result.suspend, undefined);
  deepStrictEqual(result.outputs?.submission, { awaitingInput: false });
  const [, observation] = feedback[0]!.split("\n");
  deepStrictEqual(JSON.parse(observation!), {
    code: "STALE_PROPOSAL",
    message: "The base contract changed",
    context: { systemId: "system" },
    recovery: { action: "refuse-and-repropose" },
  });
  await rejects(
    () => handleConversationNode.call(host, turn, node, { choice }),
    (error) => error === grant,
  );
  equal(feedback.length, 1);
});

Deno.test("an error that is not a coded refusal of a proposal keeps failing the turn", async () => {
  const failure = new Error("Unexpected");
  const { host, turn, feedback } = setup(failure);
  await rejects(
    () => handleConversationNode.call(host, turn, node, { choice }),
    (error) => error === failure,
  );
  equal(feedback.length, 0);
});
