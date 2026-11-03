import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { legacyOwnerAuthority } from "../../../domain/governance/authority.ts";
import { OperatorAuthorityError } from "../../../domain/governance/operator-authority.ts";
import { RequestSpaceError } from "../../../domain/work/request-spaces.ts";
import { DuplicateOperatorCreationError } from "../../../domain/governance/policies/governance.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { CompiledFlowNode } from "../../../domain/model/execution/flow.ts";
import type { ChatDecision } from "../../../domain/work/dialogue.ts";
import { handleConversationNode } from "./flow-handlers.ts";
import type {
  ConversationTurnHost,
  ConversationTurnState,
} from "./turn-context.ts";

async function checkRefusal(
  refusal:
    | DuplicateOperatorCreationError
    | OperatorAuthorityError
    | RequestSpaceError,
): Promise<void> {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "operator",
  });
  model.operatorCreationPolicies = [{
    id: "create",
    revision: 1,
    elementId: "create-native",
    sourceIds: ["create-native"],
    holderNativeId: "operator",
    mandateNativeId: model.mandate.id,
    systemId: "system",
    enabled: true,
    rootAuthority: {
      ...legacyOwnerAuthority("system"),
      ownerSource: "modeled",
    },
    networkHosts: [],
    maxChildren: 3,
    maxDelegationDepth: 0,
    children: [],
  }];
  const decision: Extract<ChatDecision, { kind: "propose_agent_creation" }> = {
    kind: "propose_agent_creation",
    text: "I will ask the helper to read one passage.",
    role: "operator",
    name: "Reader",
    reason: "Read one passage",
    operator: {
      kind: "request-team-member",
      instruction: "Read one passage.",
      provision: {
        budget: {
          maxAgentDecisions: 1,
          maxToolProposals: 1,
          maxFlowSteps: 1,
        },
        networkHosts: [],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
      },
    },
  };
  const feedback: string[] = [];
  const said: string[] = [];
  let proposals = 0;
  const host = {
    state: {},
    ports: {
      model: {
        requestChangeScope: {
          caseId: "case",
          operatorId: "operator",
          executionSpaceId: "branch",
          branchTeamSize: 1,
        },
      },
    },
    action: <T>(
      _node: CompiledFlowNode,
      effect: (current: ExecutableModel) => Promise<T>,
    ) => effect(model),
    say: (text: string) => {
      said.push(text);
      return Promise.resolve();
    },
    proposeChange: () => {
      proposals++;
      return Promise.reject(refusal);
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
  const node = model.flows.conversation.nodes.find((node) =>
    node.mechanism === "submit_proposal"
  )!;
  const submit = () =>
    handleConversationNode.call(host, turn, node, { choice: decision });
  deepStrictEqual(await submit(), {
    outputs: {
      submission: { awaitingInput: false },
      outcome: {
        succeeded: false,
        refused: true,
        code: refusal.code,
        details: refusal.message,
        context: refusal.context,
        recovery: refusal.recovery,
      },
    },
  });
  equal(proposals, 1);
  deepStrictEqual(said, []);
  equal(feedback.length, 1);
  deepStrictEqual(
    JSON.parse(feedback[0].split("\n")[1]),
    JSON.parse(JSON.stringify({
      code: refusal.code,
      message: refusal.message,
      context: refusal.context,
      recovery: refusal.recovery,
    })),
  );
  equal(turn.failures.get("proposal-refusal"), 1);
  // Keep the existing one-correction-per-turn bound on recoverable refusals.
  await rejects(submit, (error) => error === refusal);
  equal(feedback.length, 1);
}

for (
  const refusal of [
    new RequestSpaceError(
      "OPENING_CONFLICT",
      "Adopt the current admitted source before proposing a change",
    ),
    new DuplicateOperatorCreationError({
      caseId: "case",
      changeId: "existing-helper",
      status: "approved",
    }),
    new OperatorAuthorityError(
      "INVALID_OPERATOR_REQUEST",
      "An exact Case change is required",
      { changeId: "unsupported" },
    ),
  ]
) {
  Deno.test(`${refusal.code} returns its coded refusal so the agent can correct or explain`, () =>
    checkRefusal(refusal));
}
