import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { createTestNativeExecution } from "../../../../test/support/native-execution.ts";
import { AgentBudgetWait } from "../budget/agent.ts";
import { AgentPreparationError } from "../runtime/agent-preparation.ts";
import type {
  CompiledFlow,
  CompiledFlowNode,
} from "../../../domain/model/execution/flow.ts";
import type {
  ChatContext,
  ChatDecision,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import { selectDesignerInvocation } from "../cases/runtime.ts";
import { chooseMove, executeOperatorCommand } from "./decision.ts";
import { handleConversationNode } from "./flow-handlers.ts";
import { runTurn } from "./turn.ts";
import type {
  ConversationTurnHost,
  ConversationTurnState,
} from "./turn-context.ts";

const resume: ChatDecision = {
  kind: "resume_request",
  text: "Resume the request",
  operatorId: "other",
  caseId: "request",
  resumeId: "resume",
  instruction: "Continue",
};
const reply: ChatDecision = { kind: "reply", text: "Complete" };

function fixture() {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "operator",
  });
  model.version.repositoryVersion = "commit:exact";
  model.policy.mayProposeSysmlRevision = true;
  const state: SystemRuntimeState = {
    id: "session",
    revision: 1,
    catalogRevision: 0,
    executionModel: model,
    model: model.identity,
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "ready",
    provider: "test",
  };
  selectDesignerInvocation(state);
  state.messages.push({
    id: "user",
    role: "user",
    text: "Current Case",
    at: "2026-10-27T00:00:00Z",
    designerScopeId: state.designer!.scopeId,
  });
  state.activeInputMessageId = "user";
  const native = createTestNativeExecution({
    load: () => Promise.resolve(structuredClone(state)),
    save: () => Promise.resolve(),
    close: () => Promise.resolve(),
  });
  const contexts: ChatContext[] = [];
  let reads = 0;
  let effects = 0;
  const decisions = [resume, reply];
  const host = {
    state,
    get snapshot() {
      return structuredClone(state);
    },
    ports: {
      clock: { now: () => "2026-11-03T00:00:00.000Z" },
      execution: native.execution,
      stateHistory: native.stateHistory,
      model: {},
      agents: {
        decide(context: ChatContext) {
          contexts.push(structuredClone(context));
          return Promise.resolve(structuredClone(decisions.shift() ?? reply));
        },
      },
      information: {
        read: () =>
          Promise.resolve({
            memoryGuidance: [],
            modelSources: { version: "commit:exact", sources: {} },
            modelContext: {
              version: "commit:exact",
              sourceDigest: "source",
              files: [],
              roots: { items: [], total: 0, truncated: false },
              limits: {
                maxPageSize: 10,
                maxSourceBytes: 4096,
                maxInspectSourceBytes: 4096,
              },
              coverage: "bounded-discovery-not-exhaustive-impact" as const,
              loadedSources: [],
              maxLoadedCharacters: 4096,
            },
          }),
        consultAdmittedModelSource() {
          return this.consultModel();
        },
        consultModel() {
          reads++;
          return Promise.resolve({
            modelVersion: {
              digest: model.version.digest,
              repositoryVersion: model.version.repositoryVersion,
            },
            result: { observed: "exact source" },
          });
        },
      },
    },
    update(change: (state: SystemRuntimeState) => void) {
      const previous = state.revision;
      change(state);
      state.revision++;
      return native.store.save(structuredClone(state), previous);
    },
    currentModel: async () => {
      await native.store.load();
      return model;
    },
    inspectModelVersion: () => Promise.resolve(model),
    withExecutionOrigin: (_origin: unknown, effect: () => Promise<unknown>) =>
      effect(),
    action: (
      _node: unknown,
      run: (current: typeof model) => Promise<unknown>,
    ) => run(model),
    say: () => Promise.resolve(),
    feedback(text: string) {
      return host.update((current) => {
        current.messages.push({
          id: `feedback-${current.messages.length}`,
          role: "tool",
          text,
          at: "2026-10-27T00:00:00Z",
          designerScopeId: current.designer!.scopeId,
        });
      });
    },
    resumeRequest() {
      effects++;
      return Promise.resolve({
        caseId: "request",
        operatorId: "other",
        status: "open",
      });
    },
    nativeCandidate: () => false,
    artifactEvidence: () => Promise.resolve({}),
    isPrimaryOperator: () => false,
    budgetView: () => Promise.resolve(undefined),
    operatorAuthorityContext: () => Promise.resolve(undefined),
    operatorToolAdmissionContext: () => undefined,
    agentCall: (
      _model: unknown,
      _operation: unknown,
      run: () => Promise<unknown>,
    ) => run(),
    executionReference: () => ({ modelVersion: model.version.digest }),
  } as unknown as ConversationTurnHost;
  const turn: ConversationTurnState = {
    executionProfile: "operator-command-v1",
    noticeCompletionAvailable: true,
    resumedContribution: false,
    proposals: 0,
    decisions: 0,
    sourceDecision: {},
    failures: new Map(),
  };
  const source = { file: "test.sysml", line: 1, native: true };
  const node = (
    id: string,
    mechanism: string,
    inputs: string[] = [],
    outputs: string[] = [],
  ): CompiledFlowNode => ({
    id,
    nativeId: id,
    name: id,
    kind: "action",
    mechanism,
    inputs,
    outputs,
    assertions: [],
    source,
  });
  const consult = {
    ...node("consult", "consult_declared_source", [], ["consultation"]),
    consultationRequest: JSON.stringify({
      operation: "inspect",
      elementId: "declared",
    }),
  };
  const command = node("command", "execute_operator_command", ["choice"], [
    "outcome",
    "submission",
  ]);
  return {
    model,
    state,
    host,
    turn,
    consult,
    command,
    node,
    contexts,
    decisions,
    reads: () => reads,
    effects: () => effects,
  };
}

Deno.test("explicit choose uses the host Case and permits consecutive decisions without declared consultation", async () => {
  const f = fixture();
  await rejects(
    () => chooseMove.call(f.host, f.turn, f.model, {}),
    /Le choix natif exige le dossier courant/,
  );
  equal(f.contexts.length, 0);
  const first = await chooseMove.call(f.host, f.turn, f.model, {
    record: { messages: [{ role: "user", text: "Forged Case" }] },
  });
  deepStrictEqual(first.outputs?.choice, resume);
  equal(f.contexts.length, 1);
  equal(f.effects(), 0);
  equal(
    f.contexts[0].messages.some((message) => message.text === "Forged Case"),
    false,
  );
  equal(
    f.contexts[0].messages.some((message) => message.text === "Current Case"),
    true,
  );
  // Direct primitive tests use its standard completion path. The native graph
  // tests below exercise handleConversationNode plus runTurn's receipt wrapper.
  const result = await executeOperatorCommand.call(
    f.host,
    f.turn,
    f.model,
  );
  equal(result.status, "succeeded");
  equal(result.code, "REQUEST_RESUMPTION_RECORDED");
  deepStrictEqual(result.value, {
    caseId: "request",
    operatorId: "other",
    status: "open",
  });
  const singleton = f.state.conversationBatches![0];
  equal(singleton.calls.length, 1);
  equal(singleton.calls[0].id.startsWith("host-scalar:"), true);
  equal(singleton.calls[0].status, "completed");
  deepStrictEqual(singleton.calls[0].decision, resume);
  deepStrictEqual(singleton.calls[0].result, result);
  equal(singleton.assistantBlocks, undefined);
  equal(f.effects(), 1);
  deepStrictEqual(
    (await chooseMove.call(f.host, f.turn, f.model, { record: f.state }))
      .outputs?.choice,
    reply,
  );
  equal(f.reads(), 0);
  equal(f.contexts.length, 2);
  deepStrictEqual(f.contexts[1].toolCallHistory, [{
    assistantBlocks: [],
    results: [{ id: singleton.calls[0].id, result: JSON.stringify(result) }],
  }]);
});

Deno.test("legacy choose retains ordinary replies and refuses commands without an admitted explicit profile", async () => {
  const f = fixture();
  delete f.turn.executionProfile;
  await rejects(
    () => chooseMove.call(f.host, f.turn, f.model, { record: f.state }),
    /The admitted flow has no explicit operator-command action/,
  );
  equal(f.contexts.length, 1);
  equal(f.effects(), 0);
  const result = await chooseMove.call(f.host, f.turn, f.model, {
    record: f.state,
  });
  deepStrictEqual(result.outputs?.choice, reply);
  equal(f.contexts.length, 2);
  equal(f.effects(), 0);
  equal(f.reads(), 0);
});

Deno.test("immutable group profile permits scalar commands without a declared consultation token", async () => {
  const f = fixture();
  f.turn.executionProfile = "operator-command-immutable-group-v1";
  await chooseMove.call(f.host, f.turn, f.model, { record: f.state });
  equal(f.contexts.length, 1);
  equal(f.reads(), 0);
  equal(f.effects(), 0);
  const result = await executeOperatorCommand.call(f.host, f.turn, f.model);
  equal(result.status, "succeeded");
  equal(f.state.conversationBatches![0].calls[0].status, "completed");
  deepStrictEqual(f.state.conversationBatches![0].calls[0].result, result);
  equal(f.effects(), 1);
});

Deno.test("an old pinned graph retains its failed declared consultation branch", async () => {
  const f = fixture();
  f.model.flows.conversation = explicitFlow(f);
  delete (f.host.ports.information as {
    consultAdmittedModelSource?: unknown;
  }).consultAdmittedModelSource;
  await runTurn.call(f.host);
  equal(f.contexts.length, 0);
  equal(f.reads(), 0);
  const [execution] = await f.host.ports.execution!.inspect(
    f.model.identity.builderId,
  );
  equal(execution.status, "waiting");
  equal(execution.waits[0].nodeId, "wait");
});

function explicitFlow(f: ReturnType<typeof fixture>): CompiledFlow {
  // Match the production compiled-flow contract: an initial control node owns
  // the entry, while a genuine input wait routes the next contribution to read.
  const start: CompiledFlowNode = {
    ...f.node("start", ""),
    kind: "start",
    mechanism: undefined,
  };
  const read = f.node("read", "read_case", [], ["record"]);
  const choose = f.node("choose", "choose_move", ["record"], ["choice"]);
  const dispatch = {
    ...f.node("dispatch", ""),
    kind: "decision" as const,
    mechanism: undefined,
  };
  const consulted = {
    ...f.node("consulted", ""),
    kind: "decision" as const,
    mechanism: undefined,
  };
  const observe = f.node("observe", "observe_outcome", ["outcome"]);
  const commandOutcome = {
    ...f.node("commandOutcome", ""),
    kind: "decision" as const,
    mechanism: undefined,
  };
  const response = f.node("response", "reply", ["choice"], ["response"]);
  const wait = f.node("wait", "await_input");
  const edge = (source: string, target: string, guard?: string) => ({
    id: `${source}-${target}`,
    nativeId: `${source}-${target}`,
    source,
    target,
    guard,
    guardIds: [],
    sourceEvidence: read.source,
  });
  const binding = (
    from: string,
    output: string,
    to: string,
    input: string,
  ) => ({
    nativeId: `${from}-${to}`,
    sourceFeaturePath: [],
    targetFeaturePath: [],
    sourcePath: [from, output],
    targetPath: [to, input],
    sourceEvidence: read.source,
  });
  return {
    executionProfile: "operator-command-v1",
    rootNativeId: "conversation",
    rootOccurrenceId: "conversation",
    name: "conversation",
    source: read.source,
    startNodeId: start.id,
    maxSteps: 128,
    nodes: [
      start,
      read,
      f.consult,
      consulted,
      choose,
      dispatch,
      f.command,
      commandOutcome,
      observe,
      response,
      wait,
    ],
    edges: [
      edge("start", "read"),
      edge("read", "consult"),
      edge("consult", "consulted"),
      edge("consulted", "choose", "consult.consultation.succeeded"),
      edge("consulted", "wait", "else"),
      edge("choose", "dispatch"),
      edge("dispatch", "command", 'choose.choice.kind == "resume_request"'),
      edge("dispatch", "response", "else"),
      edge("command", "commandOutcome"),
      edge("commandOutcome", "wait", "command.submission.awaitingInput"),
      edge("commandOutcome", "observe", "else"),
      edge("observe", "read"),
      edge("response", "wait"),
      edge("wait", "read"),
    ],
    bindings: [
      binding("read", "record", "choose", "record"),
      binding("choose", "choice", "command", "choice"),
      binding("choose", "choice", "response", "choice"),
      binding("command", "outcome", "observe", "outcome"),
    ],
  };
}

Deno.test("native explicit flow drains one correlated batch without extra provider calls or consultations", async () => {
  const f = fixture();
  f.model.flows.conversation = explicitFlow(f);
  let calls = 0;
  f.host.ports.agents.decideBatch = (context) => {
    f.contexts.push(structuredClone(context));
    calls++;
    return Promise.resolve({
      calls: [{ id: "resume-call", decision: resume }, {
        id: "reply-call",
        decision: reply,
      }],
    });
  };
  await runTurn.call(f.host);
  equal(calls, 1);
  equal(f.reads(), 1);
  equal(f.effects(), 1);
  const batch = f.state.conversationBatches![0];
  equal(batch.calls[0].result?.code, "REQUEST_RESUMPTION_RECORDED");
  equal(batch.calls[0].status, "completed");
  equal(batch.calls[1].status, "completed");
  equal(batch.calls[0].result?.status, "succeeded");
  const resumedRequest = {
    caseId: "request",
    operatorId: "other",
    status: "open",
  };
  equal(batch.calls[0].result?.details, JSON.stringify(resumedRequest));
  deepStrictEqual(batch.calls[0].result?.value, resumedRequest);
  const [execution] = await f.host.ports.execution!.inspect(
    f.model.identity.builderId,
  );
  equal(execution.modelDigest, f.model.version.digest);
  equal(execution.status, "waiting");
  deepStrictEqual(execution.waits, [{
    nodeId: "wait",
    mechanism: "await_input",
    kind: "input",
  }]);
  deepStrictEqual(execution.unsettledEffects, []);
});

const opening: Extract<ChatDecision, { kind: "open_request" }> = {
  kind: "open_request",
  text: "Open the Request",
  openingId: "opening-1",
  objective: "Review the source",
  source: { kind: "current-main" },
};
const opened = {
  status: "opened" as const,
  caseId: "request:7",
  caseNumber: 7,
  executionSpaceId: "space:7",
  phase: "dispatched" as const,
};

Deno.test("a person-opened Request turn writes a linked host receipt and waits after one provider call", async () => {
  const f = fixture();
  f.model.flows.conversation = explicitFlow(f);
  f.model.flows.conversation.edges.find((edge) =>
    edge.source === "dispatch" && edge.target === "command"
  )!.guard = 'choose.choice.kind == "open_request"';
  const said: string[] = [];
  f.host.say = (text) => {
    said.push(text);
    return Promise.resolve();
  };
  f.host.openRequest = () => Promise.resolve(opened);
  f.host.ports.agents.decideBatch = (context) => {
    f.contexts.push(context);
    return Promise.resolve({
      calls: [
        { id: "opening", decision: opening },
        { id: "unneeded-reply", decision: reply },
      ],
    });
  };
  await runTurn.call(f.host);
  equal(f.contexts.length, 1);
  deepStrictEqual(said, [
    "[Request 7](/cases?case=request%3A7) opened: Review the source",
  ]);
  const calls = f.state.conversationBatches![0].calls;
  equal(calls[0].status, "completed");
  deepStrictEqual(calls[0].result?.value, opened);
  equal(calls[1].status, "cancelled");
  equal(calls[1].result?.code, "REQUEST_OPENING_RECORDED");
  const [execution] = await f.host.ports.execution!.inspect(
    f.model.identity.builderId,
  );
  equal(execution.status, "waiting");
  equal(execution.waits[0].nodeId, "wait");
});

for (
  const situation of [
    "refused",
    "partial",
    "notice",
    "other-input",
    "historical-flow",
  ] as const
) {
  Deno.test(`Request opening ${situation} retains the ordinary continuation without a success receipt`, async () => {
    const f = fixture();
    f.turn.inputMessageId = "user";
    f.turn.chosen = opening;
    if (situation === "notice") selectNoticeInput(f);
    if (situation === "other-input") f.turn.inputMessageId = "absent";
    if (situation === "historical-flow") {
      f.turn.noticeCompletionAvailable = false;
      f.command.outputs = ["outcome"];
    }
    const said: string[] = [];
    f.host.say = (text) => {
      said.push(text);
      return Promise.resolve();
    };
    f.host.openRequest = () =>
      Promise.resolve(
        situation === "refused"
          ? {
            status: "refused",
            code: "AUTHORITY_OUT_OF_BOUNDS",
            recovery: "Review the mandate.",
          }
          : situation === "partial"
          ? {
            ...opened,
            phase: "branch-ready",
            issues: ["PROVISIONING_UNAVAILABLE"],
          }
          : opened,
      );
    const result = await handleConversationNode.call(
      f.host,
      f.turn,
      f.command,
      {},
    );
    deepStrictEqual(
      result.outputs?.submission,
      situation === "historical-flow" ? undefined : { awaitingInput: false },
    );
    deepStrictEqual(said, []);
  });
}

Deno.test("uncertain explicit command effect is refused on recovery without replay", async () => {
  const f = fixture();
  f.model.flows.conversation = explicitFlow(f);
  f.host.ports.agents.decideBatch = () =>
    Promise.resolve({
      calls: [{ id: "resume-call", decision: resume }, {
        id: "reply-call",
        decision: reply,
      }],
    });
  const feedback = f.host.feedback;
  f.host.feedback = (text, observation) => {
    if (text.startsWith("Request continuation result")) {
      throw new Error("persistence interrupted");
    }
    return feedback(text, observation);
  };
  await rejects(() => runTurn.call(f.host), /persistence interrupted/);
  equal(f.effects(), 1);
  const [uncertain] = await f.host.ports.execution!.inspect(
    f.model.identity.builderId,
  );
  equal(uncertain.status, "uncertain");
  equal(uncertain.unsettledEffects.length, 1);
  const started = f.state.conversationBatches![0].calls[0];
  equal(started.status, "started");
  equal(started.effectStarted, true);
  equal(started.result, undefined);
  f.host.feedback = feedback;
  await rejects(
    () => runTurn.call(f.host),
    /Native effect was already started under this invocation/,
  );
  equal(f.effects(), 1);
  const [retried] = await f.host.ports.execution!.inspect(
    f.model.identity.builderId,
  );
  equal(retried.status, "uncertain");
  equal(retried.threadId, uncertain.threadId);
  equal(retried.contributionId, uncertain.contributionId);
  equal(retried.modelDigest, uncertain.modelDigest);
  deepStrictEqual(retried.unsettledEffects, uncertain.unsettledEffects);
  equal(started.status, "started");
  equal(started.effectStarted, true);
  equal(started.result, undefined);
});

Deno.test("budget-resumed explicit choose consults again before a fresh provider call", async () => {
  const f = fixture();
  f.model.flows.conversation = explicitFlow(f);
  f.decisions.splice(0, f.decisions.length, reply);
  let blocked = true;
  const agentCall = f.host.agentCall;
  f.host.agentCall = (model, operation, dispatch) => {
    if (blocked) throw new AgentBudgetWait(undefined);
    return agentCall(model, operation, dispatch);
  };
  f.host.suspendBudget = (error, node, operation) =>
    f.host.update((state) => {
      state.budgetSuspension = {
        nodeId: node.id,
        operation,
        recipient: "local-control",
        reason: error.reason,
        diagnostic: error.message,
        dispatchStarted: error.dispatchStarted,
      };
    });
  await runTurn.call(f.host);
  equal(f.reads(), 1);
  equal(f.contexts.length, 0);
  const [suspended] = await f.host.ports.execution!.inspect(
    f.model.identity.builderId,
  );
  deepStrictEqual(suspended.waits, [{
    nodeId: "choose",
    mechanism: "choose_move",
    kind: "budget",
  }]);
  blocked = false;
  await runTurn.call(f.host, undefined, {
    id: "budget-resume",
    kind: "resume",
    inputMessageId: "user",
  });
  equal(f.reads(), 2);
  equal(f.contexts.length, 1);
  equal(f.effects(), 0);
  equal(f.state.budgetSuspension, undefined);
});

Deno.test("legacy delegated commands refuse before effects while the admitted explicit profile records success and refusal", async () => {
  const { OperatorAuthorityError } = await import(
    "../../../domain/governance/operator-authority.ts"
  );
  for (const refused of [false, true]) {
    const f = fixture();
    delete f.turn.executionProfile;
    const decision: ChatDecision = {
      kind: "decide_operator_change",
      text: "Recorded decision",
      operatorId: "other",
      changeId: "change",
      expectedRevision: 1,
      policyId: "policy",
      policyRevision: 1,
      verdict: "approve",
    };
    f.decisions.splice(0, f.decisions.length, decision);
    let effects = 0;
    f.host.decideOperatorChange = () => {
      effects++;
      if (refused) {
        throw new OperatorAuthorityError(
          "AUTHORITY_REQUEST_STALE",
          "Exact request changed",
        );
      }
      return Promise.resolve();
    };
    await rejects(
      () => chooseMove.call(f.host, f.turn, f.model, { record: f.state }),
      /The admitted flow has no explicit operator-command action/,
    );
    equal(effects, 0);
    equal(f.contexts.length, 1);
    equal(f.reads(), 0);
    f.turn.executionProfile = "operator-command-v1";
    f.decisions.push(decision, reply);
    await handleConversationNode.call(f.host, f.turn, f.consult, {});
    await chooseMove.call(f.host, f.turn, f.model, { record: f.state });
    const executed = await executeOperatorCommand.call(
      f.host,
      f.turn,
      f.model,
    );
    equal(executed.status, refused ? "refused" : "succeeded");
    const singleton = f.state.conversationBatches![0];
    equal(singleton.calls.length, 1);
    equal(singleton.calls[0].id.startsWith("host-scalar:"), true);
    equal(singleton.calls[0].status, "completed");
    deepStrictEqual(singleton.calls[0].decision, decision);
    deepStrictEqual(singleton.calls[0].result, executed);
    equal(singleton.assistantBlocks, undefined);
    equal(effects, 1);
    equal(f.contexts.length, 2);
    await handleConversationNode.call(f.host, f.turn, f.consult, {});
    const result = await chooseMove.call(f.host, f.turn, f.model, {
      record: f.state,
    });
    equal(f.contexts.length, 3);
    deepStrictEqual(result.outputs?.choice, reply);
    deepStrictEqual(f.contexts[2].toolCallHistory, [{
      assistantBlocks: [],
      results: [{
        id: singleton.calls[0].id,
        result: JSON.stringify(executed),
        ...(refused ? { isError: true } : {}),
      }],
    }]);
    equal(
      f.contexts[2].messages.some((message) =>
        message.text.includes("Delegated decision result")
      ),
      true,
    );
    if (refused) {
      const observed = f.state.messages.find((message) =>
        message.text.includes("AUTHORITY_REQUEST_STALE")
      )!;
      equal(
        JSON.parse(observed.text.split("\n").slice(1).join("\n")).value.code,
        "AUTHORITY_REQUEST_STALE",
      );
    }
  }
});

function noticeDecision(verdict: "approve" | "refuse"): ChatDecision {
  return {
    kind: "decide_operator_change",
    text: "Record this exact decision",
    operatorId: "other",
    changeId: "notice-change",
    expectedRevision: 1,
    policyId: "policy",
    policyRevision: 1,
    verdict,
  };
}

function selectNoticeInput(f: ReturnType<typeof fixture>) {
  const message = {
    id: "authority-escalation:notice-change",
    role: "tool" as const,
    text: "Authority escalation observation",
    at: "2026-11-01T00:00:00Z",
    designerScopeId: f.state.designer!.scopeId,
    noticeWake: true as const,
    operatorNotice: {
      kind: "authority-escalation" as const,
      changeId: "notice-change",
      requestedBy: "other",
      caseId: "other-request",
      recipient: "operator",
      decisionAuthority: "operator" as const,
      reason: "Read the selected page",
    },
  };
  f.state.messages.push(message);
  f.state.activeInputMessageId = message.id;
  f.turn.inputMessageId = message.id;
  return message;
}

for (const verdict of ["approve", "refuse"] as const) {
  Deno.test(`recorded ${verdict} for the exact woken escalation requests an input wait and preserves its tool result`, async () => {
    const f = fixture();
    selectNoticeInput(f);
    f.turn.chosen = noticeDecision(verdict);
    let decisions = 0;
    f.host.decideOperatorChange = () => {
      decisions++;
      return Promise.resolve();
    };
    const output = await handleConversationNode.call(
      f.host,
      f.turn,
      f.command,
      {},
    );
    deepStrictEqual(output.outputs?.submission, { awaitingInput: true });
    const outcome = output.outputs?.outcome as {
      succeeded: boolean;
      code: string;
      value: ChatDecision;
    };
    equal(outcome.succeeded, true);
    equal(outcome.code, "DELEGATED_DECISION_RECORDED");
    deepStrictEqual(outcome.value, noticeDecision(verdict));
    equal(decisions, 1);
    equal(f.contexts.length, 0);
    equal(
      f.state.messages.filter((message) =>
        message.text.startsWith("Delegated decision result")
      ).length,
      1,
    );
  });
}

for (
  const mismatch of [
    "human-input",
    "turn-input",
    "not-woken",
    "human-authority",
    "other-recipient",
    "other-scope",
    "request-scope",
    "other-operator",
    "other-change",
    "host-refusal",
  ] as const
) {
  Deno.test(`delegated command ${mismatch} retains its ordinary continuation`, async () => {
    const f = fixture();
    const message = selectNoticeInput(f);
    const chosen = noticeDecision("approve");
    if (chosen.kind !== "decide_operator_change") throw new Error("fixture");
    if (mismatch === "human-input") {
      f.state.activeInputMessageId = "user";
      f.turn.inputMessageId = "user";
    }
    if (mismatch === "turn-input") f.turn.inputMessageId = "user";
    if (mismatch === "not-woken") {
      delete (message as { noticeWake?: true }).noticeWake;
    }
    if (mismatch === "human-authority") {
      (message.operatorNotice as { decisionAuthority: string })
        .decisionAuthority = "human";
    }
    if (mismatch === "other-recipient") {
      message.operatorNotice.recipient = "someone-else";
    }
    if (mismatch === "other-scope") message.designerScopeId = "other-scope";
    if (mismatch === "request-scope") {
      (message as { caseId?: string }).caseId = "request";
    }
    if (mismatch === "other-operator") chosen.operatorId = "someone-else";
    if (mismatch === "other-change") chosen.changeId = "other-change";
    f.turn.chosen = chosen;
    f.host.decideOperatorChange = async () => {
      if (mismatch === "host-refusal") {
        const { OperatorAuthorityError } = await import(
          "../../../domain/governance/operator-authority.ts"
        );
        throw new OperatorAuthorityError(
          "AUTHORITY_REQUEST_STALE",
          "Changed request",
          { changeId: "notice-change" },
        );
      }
    };
    const output = await handleConversationNode.call(
      f.host,
      f.turn,
      f.command,
      {},
    );
    deepStrictEqual(output.outputs?.submission, { awaitingInput: false });
    if (mismatch === "host-refusal") {
      const outcome = output.outputs?.outcome as {
        code: string;
        refused: boolean;
      };
      equal(outcome.code, "AUTHORITY_REQUEST_STALE");
      equal(outcome.refused, true);
      deepStrictEqual((outcome as unknown as { value: unknown }).value, {
        code: "AUTHORITY_REQUEST_STALE",
        message: "Changed request",
        context: { changeId: "notice-change" },
        recovery: { action: "refuse-and-repropose" },
      });
    }
  });
}

for (const woken of [false, true]) {
  Deno.test(`model consultation ${woken ? "within the exact notice turn is quiet" : "opened by a person keeps its narration"}`, async () => {
    const f = fixture();
    if (woken) selectNoticeInput(f);
    const said: string[] = [];
    f.host.say = (text) => {
      said.push(text);
      return Promise.resolve();
    };
    f.turn.chosen = {
      kind: "consult_model",
      text: "I will read the admitted model",
      inputJson: JSON.stringify({
        operation: "inspect",
        elementId: "declared",
      }),
    };
    const output = await handleConversationNode.call(
      f.host,
      f.turn,
      f.command,
      {},
    );
    equal((output.outputs?.outcome as { succeeded: boolean }).succeeded, true);
    deepStrictEqual(said, woken ? [] : ["I will read the admitted model"]);
    if (woken) {
      f.turn.chosen = noticeDecision("approve");
      f.host.decideOperatorChange = () => Promise.resolve();
      const decided = await handleConversationNode.call(
        f.host,
        f.turn,
        f.command,
        {},
      );
      deepStrictEqual(decided.outputs?.submission, { awaitingInput: true });
      deepStrictEqual(said, []);
    }
  });
}

Deno.test("an admitted outcome-only command retains narration and does not emit a notice completion output", async () => {
  const f = fixture();
  selectNoticeInput(f);
  f.turn.noticeCompletionAvailable = false;
  f.command.outputs = ["outcome"];
  const said: string[] = [];
  f.host.say = (text) => {
    said.push(text);
    return Promise.resolve();
  };
  f.turn.chosen = {
    kind: "consult_model",
    text: "Historical admitted narration",
    inputJson: JSON.stringify({ operation: "inspect", elementId: "declared" }),
  };
  const consulted = await handleConversationNode.call(
    f.host,
    f.turn,
    f.command,
    {},
  );
  deepStrictEqual(Object.keys(consulted.outputs!), ["outcome"]);
  deepStrictEqual(said, ["Historical admitted narration"]);
  f.turn.chosen = noticeDecision("approve");
  f.host.decideOperatorChange = () => Promise.resolve();
  const decided = await handleConversationNode.call(
    f.host,
    f.turn,
    f.command,
    {},
  );
  deepStrictEqual(Object.keys(decided.outputs!), ["outcome"]);
  equal(
    (decided.outputs?.outcome as { code: string }).code,
    "DELEGATED_DECISION_RECORDED",
  );
});

Deno.test("declared consultation does not prebuild the decision context", async () => {
  const f = fixture();
  let contextBuilds = 0;
  f.host.assertDecisionContextRepresentable = () => {
    contextBuilds++;
    throw new Error("The declared handler must not prebuild decision context");
  };
  const output = await handleConversationNode.call(
    f.host,
    f.turn,
    f.consult,
    {},
  );
  equal(
    (output.outputs?.consultation as { succeeded: boolean }).succeeded,
    true,
  );
  equal(contextBuilds, 0);
  equal(f.reads(), 1);
  await chooseMove.call(f.host, f.turn, f.model, { record: f.state });
  equal(f.contexts.length, 1);
});

for (const batched of [false, true]) {
  Deno.test(`provider preparation refusal becomes a modeled ${batched ? "batch" : "scalar"} reply before budget reservation`, async () => {
    const f = fixture();
    let reservations = 0;
    let invalidations = 0;
    f.host.agentCall = () => {
      reservations++;
      throw new Error("Preparation must precede the budget boundary");
    };
    f.host.invalidateOperatorCandidateInspection = () => invalidations++;
    f.host.ports.agents.prepareDecision = (): Promise<never> =>
      Promise.reject(
        new AgentPreparationError(
          "TURN_BRIEF_LIMIT",
          "Required turn brief exceeds its representation limit",
          { characters: 5000, maximumCharacters: 4096 },
          "Reduce required input and submit a new contribution.",
        ),
      );
    if (batched) {
      f.host.ports.agents.decideBatch = () => {
        throw new Error("No provider dispatch is allowed");
      };
    }
    const output = await chooseMove.call(f.host, f.turn, f.model, {
      record: f.state,
    });
    const chosen = output.outputs?.choice as Extract<
      ChatDecision,
      { kind: "reply" }
    >;
    equal(chosen.kind, "reply");
    const refusal = JSON.parse(chosen.text.split("\n")[1]);
    equal(refusal.code, "DECISION_CONTEXT_REFUSED");
    equal(refusal.context.causeCode, "TURN_BRIEF_LIMIT");
    equal(refusal.context.characters, 5000);
    equal(refusal.context.maximumCharacters, 4096);
    equal(refusal.context.modelDigest, f.model.version.digest);
    equal(
      refusal.recovery,
      "Reduce required input and submit a new contribution.",
    );
    equal(reservations, 0);
    equal(invalidations, 1);
    equal(f.contexts.length, 0);
    equal(f.state.conversationBatches, undefined);
  });

  Deno.test(`oversized ${batched ? "batch" : "scalar"} decision context returns a visible coded reply before provider dispatch`, async () => {
    const f = fixture();
    f.model.contextPolicy = {
      kind: "separated-context",
      pattern: "5.1",
      id: "context",
      revision: 1,
      elementId: "context-policy",
      sourceIds: [],
      recentMessages: 1,
      maxMessageCharacters: 256,
      maxCollectionItems: 1,
      maxContextCharacters: 4096,
    };
    f.model.mandate.id = "Required authority. ".repeat(1000);
    let invalidations = 0;
    let providerCalls = 0;
    f.host.invalidateOperatorCandidateInspection = () => {
      invalidations++;
    };
    if (batched) {
      f.host.ports.agents.decideBatch = () => {
        providerCalls++;
        return Promise.resolve({ calls: [{ id: "reply", decision: reply }] });
      };
    }
    const result = await chooseMove.call(f.host, f.turn, f.model, {
      record: f.state,
    });
    const chosen = result.outputs?.choice as Extract<
      ChatDecision,
      { kind: "reply" }
    >;
    equal(chosen.kind, "reply");
    const refusal = JSON.parse(chosen.text.split("\n")[1]);
    equal(refusal.code, "DECISION_CONTEXT_REFUSED");
    equal(refusal.context.modelDigest, f.model.version.digest);
    equal(refusal.context.maximumCharacters, 4096);
    ok(refusal.context.minimumCharacters > 4096);
    ok(refusal.recovery.length > 0);
    equal(invalidations, 1);
    equal(providerCalls, 0);
    equal(f.contexts.length, 0);
    equal(f.state.conversationBatches, undefined);
  });
}
