import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { ModelContextAccessError } from "../../../domain/model/consultation/context.ts";
import { OperatorAuthorityError } from "../../../domain/governance/operator-authority.ts";
import type { ChatDecision } from "../../../domain/work/dialogue.ts";
import {
  chooseMove,
  executeOperatorCommand,
  isOperatorCommand,
} from "./decision.ts";
import type {
  ConversationDecisionHost,
  ConversationTurnState,
} from "./turn-context.ts";

function turn(): ConversationTurnState {
  return {
    resumedContribution: false,
    proposals: 0,
    decisions: 0,
    sourceDecision: {},
    failures: new Map(),
  };
}

Deno.test("isOperatorCommand recognises the closed command family only", () => {
  const commands: ChatDecision["kind"][] = [
    "resume_request",
    "open_request",
    "inspect_operator_candidate",
    "decide_operator_candidate",
    "decide_operator_change",
    "consult_model",
  ];
  for (const kind of commands) {
    equal(isOperatorCommand({ kind, text: kind } as ChatDecision), true, kind);
  }
  const ordinary: ChatDecision["kind"][] = [
    "reply",
    "invoke_tool",
    "invoke_behavior",
    "propose_tool",
    "propose_mandate_change",
    "propose_agent_creation",
    "propose_sysml_revision",
    "propose_sysml_edit",
    "propose_model_delegation",
    "prepare_operator_evolution",
    "decide_operator_evolution",
    "adopt_operator_evolution",
  ];
  for (const kind of ordinary) {
    equal(
      isOperatorCommand({ kind, text: kind } as ChatDecision),
      false,
      kind,
    );
  }
  equal(isOperatorCommand(undefined), false);
});

Deno.test("executeOperatorCommand requires a supported selected command", async () => {
  const current = executableFixture({
    projectId: "decision-project",
    editingContextId: "decision-context",
    rootId: "decision-root",
    systemId: "decision-system",
    catalogId: "decision-catalog",
    builderId: "operator",
  });
  const host = {} as unknown as ConversationDecisionHost;
  const turnState = turn();
  turnState.chosen = { kind: "reply", text: "Done" };
  await rejects(
    () => executeOperatorCommand.call(host, turnState, current),
    /The native operator command requires a supported selected command\./,
  );
});

Deno.test("executeOperatorCommand refuses an out-of-bounds request opening", async () => {
  const current = executableFixture({
    projectId: "decision-project",
    editingContextId: "decision-context",
    rootId: "decision-root",
    systemId: "decision-system",
    catalogId: "decision-catalog",
    builderId: "operator",
  });
  const host = {} as unknown as ConversationDecisionHost;
  const turnState = turn();
  turnState.chosen = {
    kind: "open_request",
    text: "Open a request",
  } as Extract<ChatDecision, { kind: "open_request" }>;
  const error = await executeOperatorCommand
    .call(host, turnState, current)
    .then(
      () => undefined,
      (failure: unknown) => failure,
    );
  equal(error instanceof OperatorAuthorityError, true);
  equal((error as OperatorAuthorityError).code, "AUTHORITY_OUT_OF_BOUNDS");
});

Deno.test("unavailable resumption preserves the host refusal code, context and recovery", async () => {
  const current = executableFixture({
    projectId: "p",
    editingContextId: "e",
    rootId: "r",
    systemId: "s",
    catalogId: "c",
    builderId: "operator",
  });
  const chosen: ChatDecision = {
    kind: "resume_request",
    text: "Continue",
    caseId: "closed",
    operatorId: "operator",
    resumeId: "resume",
    instruction: "Continue the work",
  };
  const error = new OperatorAuthorityError(
    "AUTHORITY_OUT_OF_BOUNDS",
    "The Request is unavailable",
    { caseId: "closed" },
  );
  const host = {
    resumeRequest: () => Promise.reject(error),
    feedback: () => Promise.resolve(),
  } as unknown as ConversationDecisionHost;
  const result = await executeOperatorCommand.call(
    host,
    { ...turn(), chosen },
    current,
    undefined,
    false,
  );
  equal(result.status, "refused");
  deepStrictEqual(result.value, {
    status: "refused",
    code: error.code,
    context: error.context,
    recovery: error.recovery,
    message: error.message,
  });
});

Deno.test("chooseMove enforces the admitted decision ceiling before reading", async () => {
  const current = executableFixture({
    projectId: "decision-project",
    editingContextId: "decision-context",
    rootId: "decision-root",
    systemId: "decision-system",
    catalogId: "decision-catalog",
    builderId: "operator",
  });
  const host = {
    state: { conversationBatches: undefined, activeBatchCall: undefined },
  } as unknown as ConversationDecisionHost;
  const turnState = turn();
  turnState.decisions = current.policy.maxAgentDecisions;
  await rejects(
    () => chooseMove.call(host, turnState, current, {}),
    /La limite de décisions du modèle a été atteinte\./,
  );
  equal(turnState.decisions, current.policy.maxAgentDecisions + 1);
});

for (
  const [read, revision, allowed] of [
    [true, true, true],
    [true, false, true],
    [false, false, false],
    [undefined, true, true],
    [undefined, false, false],
  ] as const
) {
  Deno.test(`operator consult command read=${read}, revision=${revision} follows read authority`, async () => {
    const current = executableFixture({
      projectId: "p",
      editingContextId: "e",
      rootId: "r",
      systemId: "s",
      catalogId: "c",
      builderId: "operator",
    });
    current.policy.mayProposeSysmlRevision = revision;
    if (read !== undefined) current.policy.mayConsultModel = read;
    else delete current.policy.mayConsultModel;
    let reads = 0;
    const feedback: string[] = [];
    const host = {
      snapshot: { messages: [] },
      ports: {
        information: {
          consultModel: () => {
            reads++;
            return Promise.resolve({ observed: "Exact" });
          },
        },
      },
      say: () => Promise.resolve(),
      feedback: (text: string) => {
        feedback.push(text);
        return Promise.resolve();
      },
      update: () => Promise.resolve(),
      currentModel: () => Promise.resolve(current),
    } as unknown as ConversationDecisionHost;
    const turnState = turn();
    turnState.chosen = {
      kind: "consult_model",
      text: "Search",
      inputJson: JSON.stringify({ operation: "search", query: "Exact" }),
    };
    const execute = () =>
      executeOperatorCommand.call(host, turnState, current, {
        messages: [],
        activeTools: [],
        candidates: [],
      }, false);
    if (allowed) {
      equal((await execute()).status, "succeeded");
    } else {
      await rejects(execute, (error: unknown) => {
        ok(error instanceof ModelContextAccessError);
        equal(error.code, "MODEL_CONTEXT_AUTHORITY");
        deepStrictEqual(error.context, { authority: "model-read" });
        ok(error.recovery.length > 0);
        equal(feedback.length, 0);
        return true;
      });
    }
    equal(reads, allowed ? 1 : 0);
    equal(current.policy.mayProposeSysmlRevision, revision);
  });
}

for (const failureKind of ["say", "authority"] as const) {
  Deno.test(`consultation ${failureKind} failure ends the turn without a corrective decision`, async () => {
    const current = executableFixture({
      projectId: "p",
      editingContextId: "e",
      rootId: "r",
      systemId: "s",
      catalogId: "c",
      builderId: "operator",
    });
    current.policy.mayConsultModel = true;
    current.policy.mayProposeSysmlRevision = false;
    let said = 0, reads = 0, feedback = 0;
    const failure = failureKind === "say"
      ? new Error("Narration persistence failed")
      : new ModelContextAccessError("MODEL_CONTEXT_AUTHORITY", "Read revoked");
    const host = {
      snapshot: { messages: [] },
      ports: {
        information: {
          consultModel: () => {
            reads++;
            return Promise.reject(failure);
          },
        },
      },
      say: () => {
        said++;
        return failureKind === "say"
          ? Promise.reject(failure)
          : Promise.resolve();
      },
      feedback: () => {
        feedback++;
        return Promise.resolve();
      },
      update: () => Promise.resolve(),
      currentModel: () => Promise.resolve(current),
    } as unknown as ConversationDecisionHost;
    const turnState = turn();
    turnState.chosen = {
      kind: "consult_model",
      text: "Search",
      inputJson: JSON.stringify({ operation: "search", query: "Exact" }),
    };
    await rejects(
      () =>
        executeOperatorCommand.call(host, turnState, current, {
          messages: [],
          activeTools: [],
          candidates: [],
        }, false),
      (error: unknown) => error === failure,
    );
    equal(said, 1);
    equal(reads, failureKind === "say" ? 0 : 1);
    equal(feedback, 0);
  });
}
