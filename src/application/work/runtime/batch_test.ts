import { ACCEPTED_CASE_CLOSURE } from "../../../../test/support/case-closure.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { unexpectedModelAuthoring } from "../../../../test/support/model-authoring.ts";
import { SystemRuntime } from "../../../../test/support/system-runtime.ts";
import type {
  BehaviorInvocationRequest,
  BehaviorInvocationResult,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
} from "../../../domain/model/execution/native-contracts.ts";
import type { ChatContext } from "../conversation/chat-context.ts";
import type {
  ChatDecision,
  ChatDecisionBatch,
} from "../conversation/chat-decision.ts";
import type { SystemRuntimeState } from "./state.ts";
import type { ToolDraft } from "../../../domain/work/records/candidates.ts";
import type { AgentPort, ModelPort, StorePort } from "./ports.ts";
import { ClaudeAgents } from "../../../adapters/out/llm-providers/agents.ts";
import { caseTypesForModel } from "../../../domain/work/records/case-types.ts";
import { WorkBudgetService } from "../budget/service.ts";
import type { WorkBudgetPort } from "../budget/ports.ts";
import type { WorkBudgetRecord } from "../../../domain/work/policies/budget.ts";
import { OperatorAuthorityError } from "../../../domain/governance/operator-authority-error.ts";
import { immutableModelConsultation } from "../../../domain/model/consultation/context.ts";
import type { BehaviorAdmission } from "../../governance/behavior-call-admission.ts";
import type { OperatorWorkReceipt } from "../../../domain/work/execution/case-context.ts";
import { createTestNativeExecution } from "../../../../test/support/native-execution.ts";

const reply: ChatDecision = { kind: "reply", text: "All results observed." };
const sourceVersion = "commit:batch-source";

function batch(...decisions: ChatDecision[]): ChatDecisionBatch {
  const calls = decisions.map((decision, index) => ({
    id: `provider-call-${index + 1}`,
    decision: structuredClone(decision),
  }));
  return {
    calls,
    assistantBlocks: calls.map((call) => ({
      type: "tool_use",
      id: call.id,
      name: call.decision.kind,
      input: structuredClone(call.decision),
    })),
  };
}

function consult(query: string): ChatDecision {
  return {
    kind: "consult_model",
    text: `Inspect ${query}`,
    inputJson: JSON.stringify({
      operation: "search",
      version: sourceVersion,
      query,
    }),
  };
}

function propose(name: string): ChatDecision {
  return {
    kind: "propose_tool",
    text: `Prepare ${name}`,
    tool: {
      name,
      kind: "read_web_page",
      description: `Read HTML with ${name}`,
      code: `export default ({html}) => ({title:${
        JSON.stringify(name)
      },text:html})`,
    },
  };
}

const behavior: NativeBehaviorContract = {
  id: "record-resource",
  name: "Record one resource",
  description: "A serial opaque native behavior.",
  callerNativeId: "batch-builder",
  targetNativeId: "native-record-resource",
  targetTypeId: "Fixture::RecordResource",
  inputTypeId: "Fixture::RecordInput",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  sourceIds: ["native-record-resource", "native-record-input"],
};

function invoke(value: string): ChatDecision {
  return {
    kind: "invoke_behavior",
    text: `Record ${value}`,
    behaviorId: behavior.id,
    inputJson: JSON.stringify({ value }),
  };
}

class MemoryStore implements StorePort {
  constructor(public value: SystemRuntimeState | null = null) {}
  fail?: (state: SystemRuntimeState) => boolean;
  load() {
    return Promise.resolve(structuredClone(this.value));
  }
  save(state: SystemRuntimeState, expected: number | null) {
    equal(this.value?.revision ?? null, expected);
    if (this.fail?.(state)) {
      throw new Error("Controlled batch persistence interruption");
    }
    this.value = structuredClone(state);
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

/** The native interpreter and journal are real; only external technical effects are doubled. */
function fixture(options: {
  agents?: AgentPort;
  steps?: ChatDecisionBatch[];
  legacySteps?: ChatDecision[];
  store?: MemoryStore;
  consult?: (input: Record<string, unknown>) => Promise<unknown>;
  test?: (draft: ToolDraft) => void;
  invoke?: (
    request: BehaviorInvocationRequest,
  ) => Promise<BehaviorInvocationResult>;
  supports?: () => boolean;
  autoAdmission?: boolean;
  workBudget?: WorkBudgetPort;
  budgetLimit?: number;
  native?: ReturnType<typeof createTestNativeExecution>;
  /** Keep the historical compiled pin, without projecting a current profile. */
  historicalFlow?: boolean;
} = {}) {
  const model = executableFixture({
    projectId: "batch-project",
    editingContextId: "batch-context",
    rootId: "batch-root",
    systemId: "batch-system",
    catalogId: "batch-catalog",
    builderId: "batch-builder",
  });
  model.version.digest = "batch-source-0";
  model.version.repositoryVersion = sourceVersion;
  model.policy.mayProposeSysmlRevision = true;
  model.behaviors = [structuredClone(behavior)];
  if (options.autoAdmission) {
    model.configuration.builder.admissionAuthority = "builder";
    model.mandate.mayAdmitOwnCandidates = true;
  }
  if (options.budgetLimit !== undefined) {
    model.workBudgetPolicy = {
      id: "batch-budget",
      revision: 1,
      unit: "agent-invocation",
      limit: options.budgetLimit,
      onExhausted: "wait",
      exhaustionRecipient: "local-control",
      elementId: "native-batch-budget",
      sourceIds: ["native-batch-budget"],
    };
  }
  if (!options.historicalFlow) {
    // The historical fixture predates the invoke_behavior branch now present in
    // models/conversation.sysml; use its explicit current native alternative.
    const invocationRoute = model.flows.conversation.edges.find((edge) =>
      edge.guard?.includes('"invoke_tool"')
    )!;
    invocationRoute.guard =
      '(chooseNextMove.choice.kind == "invoke_tool") or (chooseNextMove.choice.kind == "invoke_behavior")';
    // Project the current declared ConsultingConversationV1 additions onto the
    // historical compiled fixture. Existing invocation and proposal paths stay
    // intact so the batch journal still exercises their real native primitives.
    const flow = model.flows.conversation;
    flow.executionProfile = "operator-command-immutable-group-v1";
    const read = flow.nodes.find((node) => node.mechanism === "read_case")!;
    const choose = flow.nodes.find((node) => node.mechanism === "choose_move")!;
    const check = flow.nodes.find((node) =>
      node.mechanism === "check_invocation"
    )!;
    const execute = flow.nodes.find((node) =>
      node.mechanism === "invoke_tool"
    )!;
    const replyNode = flow.nodes.find((node) => node.mechanism === "reply")!;
    const readEdge = flow.edges.find((edge) =>
      edge.source === read.id && edge.target === choose.id
    )!;
    const choiceEdge = flow.edges.find((edge) => edge.source === choose.id)!;
    const fallback = flow.edges.find((edge) =>
      edge.source === choiceEdge.target && edge.guard === "else"
    )!;
    const reported = flow.edges.find((edge) => edge.source === execute.id)!;
    const awaiting = flow.edges.find((edge) => edge.source === replyNode.id)!;
    const node = (
      id: string,
      name: string,
      mechanism: typeof read.mechanism,
      inputs: string[],
      outputs: string[],
    ) => ({
      ...structuredClone(read),
      id,
      nativeId: id,
      name,
      mechanism,
      inputs,
      outputs,
      assertions: [],
    });
    const consultNode = {
      ...node(
        "batch-declared-consult",
        "consultDeclaredSource",
        "consult_declared_source",
        [],
        ["consultation"],
      ),
      consultationRequest: JSON.stringify({
        operation: "read_source",
        path: "conversation.sysml",
      }),
    };
    const commandNode = node(
      "batch-command",
      "executeOperatorCommand",
      "execute_operator_command",
      ["choice"],
      ["outcome"],
    );
    const decisionNode = {
      ...structuredClone(read),
      id: "batch-consult-outcome",
      nativeId: "batch-consult-outcome",
      name: "consultationOutcome",
      kind: "decision" as const,
      mechanism: undefined,
      inputs: [],
      outputs: [],
      assertions: [],
    };
    flow.nodes.push(consultNode, commandNode, decisionNode);
    readEdge.target = consultNode.id;
    const addEdge = (
      id: string,
      source: string,
      target: string,
      guard?: string,
    ) =>
      flow.edges.push({
        ...structuredClone(readEdge),
        id,
        nativeId: id,
        source,
        target,
        ...(guard ? { guard } : {}),
      });
    addEdge("batch-consult-decision", consultNode.id, decisionNode.id);
    addEdge(
      "batch-consult-success",
      decisionNode.id,
      choose.id,
      "consultDeclaredSource.consultation.succeeded",
    );
    addEdge("batch-consult-refusal", decisionNode.id, awaiting.target, "else");
    addEdge(
      "batch-command-choice",
      fallback.source,
      commandNode.id,
      '(chooseNextMove.choice.kind == "consult_model") or (chooseNextMove.choice.kind == "inspect_operator_candidate") or (chooseNextMove.choice.kind == "decide_operator_candidate") or (chooseNextMove.choice.kind == "decide_operator_change") or (chooseNextMove.choice.kind == "open_request") or (chooseNextMove.choice.kind == "resume_request")',
    );
    addEdge("batch-command-reported", commandNode.id, reported.target);
    const choiceBinding = flow.bindings.find((binding) =>
      binding.targetPath.join(".") === `${check.name}.choice`
    )!;
    flow.bindings.push({
      ...structuredClone(choiceBinding),
      nativeId: "batch-command-choice-binding",
      targetPath: [commandNode.name, "choice"],
      targetFeaturePath: [commandNode.nativeId, "choice"],
    });
    const outcomeBinding = flow.bindings.find((binding) =>
      binding.sourcePath.join(".") === `${execute.name}.outcome`
    )!;
    flow.bindings.push({
      ...structuredClone(outcomeBinding),
      nativeId: "batch-command-outcome-binding",
      sourcePath: [commandNode.name, "outcome"],
      sourceFeaturePath: [commandNode.nativeId, "outcome"],
    });
  }
  const store = options.store ?? new MemoryStore();
  const steps = [...(options.steps ?? [batch(reply)])];
  const legacySteps = [...(options.legacySteps ?? [reply])];
  const contexts: ChatContext[] = [];
  const tested: ToolDraft[] = [];
  const effects: string[] = [];
  let providerRequests = 0;
  let publications = 0;
  const forbidden = () => {
    throw new Error("Unexpected external effect in batch regression");
  };
  // Each controlled source pin remains recoverable after HEAD advances.
  const pinnedModels = new Map<string, typeof model>();
  const rememberPin = () => {
    if (model.version.repositoryVersion) {
      pinnedModels.set(model.version.repositoryVersion, structuredClone(model));
    }
  };
  rememberPin();
  const native: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize: () => Promise.resolve(structuredClone(model.identity)),
    readExecutableModel: (_identity, repositoryVersion) => {
      if (repositoryVersion !== undefined) {
        const retained = pinnedModels.get(repositoryVersion);
        if (!retained) {
          return Promise.reject(
            new Error("Exact controlled source pin is unavailable"),
          );
        }
        return Promise.resolve(structuredClone(retained));
      }
      rememberPin();
      return Promise.resolve(structuredClone(model));
    },
    applyApprovedChange: forbidden,
    activateCandidate(_identity, candidate, admittedDigest) {
      equal(admittedDigest, candidate.activationModelDigest);
      equal(candidate.tests?.passed, true);
      equal(candidate.admission?.candidateDigest, candidate.digest);
      const binding = {
        elementId: `native-${candidate.id}`,
        graphPath: `batch.catalog.${candidate.name}`,
      };
      rememberPin();
      model.catalog.push({
        nativeId: binding.elementId,
        candidateId: candidate.id,
        contractId: model.contracts.find((entry) =>
          entry.kind === candidate.kind
        )!.nativeId,
        name: candidate.name,
        kind: candidate.kind,
        digest: candidate.digest,
        status: "active",
      });
      publications++;
      model.version.repositoryVersion =
        `commit:batch-published-${publications}`;
      rememberPin();
      return Promise.resolve(binding);
    },
    findCandidate(_identity, candidate) {
      const entry = model.catalog.find((item) =>
        item.candidateId === candidate.id
      );
      return Promise.resolve(
        entry
          ? {
            elementId: entry.nativeId,
            graphPath: `batch.catalog.${candidate.name}`,
          }
          : null,
      );
    },
    graph: () => Promise.resolve({}),
  };
  const nativeExecution = options.native ??
    createTestNativeExecution(store, options.workBudget);
  const service = new SystemRuntime({
    model: native,
    store: nativeExecution.store,
    execution: nativeExecution.execution,
    dispatch: nativeExecution.dispatch,
    stateHistory: nativeExecution.stateHistory,
    artifactSources: nativeExecution.artifactSources,
    ...(options.workBudget ? { workBudget: options.workBudget } : {}),
    agents: options.agents ?? {
      label: "scripted-batch-provider",
      decide(context) {
        providerRequests++;
        contexts.push(structuredClone(context));
        const next = legacySteps.shift();
        if (!next) throw new Error("Unexpected legacy provider request");
        return Promise.resolve(structuredClone(next));
      },
      ...(options.legacySteps ? {} : {
        decideBatch(context: ChatContext) {
          providerRequests++;
          contexts.push(structuredClone(context));
          const next = steps.shift();
          if (!next) throw new Error("Unexpected batch provider request");
          return Promise.resolve(structuredClone(next));
        },
      }),
      review: forbidden,
      ...(options.autoAdmission
        ? {
          admit(candidate) {
            providerRequests++;
            return Promise.resolve({
              candidateDigest: candidate.digest,
              verdict: "approve" as const,
              reason:
                "Automatic admission under the preexisting builder mandate",
            });
          },
        }
        : { admit: forbidden }),
    },
    runner: {
      test(draft) {
        tested.push(structuredClone(draft));
        options.test?.(draft);
        return Promise.resolve({
          passed: true,
          checks: [{ name: "exact-draft", passed: true, detail: draft.name }],
        });
      },
      run: forbidden,
    },
    information: {
      assertModelContextPin: () => Promise.resolve(),
      withModelContextPin: async (_model, _messages, _pin, operation) =>
        await operation(),
      read: () =>
        Promise.resolve({
          memoryGuidance: [],
          modelContext: {
            version: sourceVersion,
            sourceDigest: "a".repeat(64),
            files: [],
            roots: { items: [], total: 0, truncated: false },
            limits: {
              maxPageSize: 50,
              maxSourceBytes: 131072,
              maxInspectSourceBytes: 24576,
            },
            coverage: "bounded-discovery-not-exhaustive-impact",
            loadedSources: [],
            maxLoadedCharacters: 120000,
          },
          modelSources: { version: sourceVersion, sources: {} },
        }),
      consultAdmittedModelSource(current, input) {
        equal(input.operation, "read_source");
        equal(input.path, "conversation.sysml");
        equal(input.version, current.version.repositoryVersion);
        return Promise.resolve({
          modelVersion: {
            digest: current.version.digest,
            repositoryVersion: current.version.repositoryVersion,
          },
          result: { path: input.path },
        });
      },
      async consultModel(current, input) {
        if (
          input.operation === "read_source" &&
          input.path === "conversation.sysml"
        ) {
          return {
            modelVersion: {
              digest: current.version.digest,
              repositoryVersion: current.version.repositoryVersion,
            },
            result: { path: input.path },
          };
        }
        effects.push(`read:${String(input.query)}`);
        return await (options.consult?.(input) ??
          Promise.resolve({ observed: input.query }));
      },
    },
    behaviors: {
      supports: () => Promise.resolve(options.supports?.() ?? true),
      async invoke(request) {
        effects.push(`behavior:${String(request.input.value)}`);
        return await (options.invoke?.(request) ?? Promise.resolve({
          behaviorId: request.behavior.id,
          invocationId: request.invocationId,
          targetNativeId: request.behavior.targetNativeId,
          modelVersion: request.modelVersion,
          result: { recorded: request.input.value },
        }));
      },
    },
  });
  const initialize = service.initialize.bind(service);
  const localIdle = service.idle.bind(service);
  service.initialize = async (...args) => {
    await initialize(...args);
    nativeExecution.bind(service);
    service.idle = async () => {
      await localIdle();
      await nativeExecution.idle();
      await localIdle();
    };
  };
  return {
    service,
    model,
    store,
    native: nativeExecution,
    contexts,
    tested,
    effects,
    get providerRequests() {
      return providerRequests;
    },
    get publications() {
      return publications;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}

function interruptAfterInvocationCheck(
  f: ReturnType<typeof fixture>,
  nextMechanism: "invoke_tool" | "report_refusal",
) {
  const check = f.model.flows.conversation.nodes.find((node) =>
    node.mechanism === "check_invocation"
  )!;
  let interrupted = false;
  f.native.effectBoundary((boundary) => {
    if (
      !interrupted && boundary.phase === "after-receipt" &&
      boundary.node.id === check.id
    ) {
      interrupted = true;
      throw new Error(`Controlled native interruption before ${nextMechanism}`);
    }
  });
  return async () => {
    equal(interrupted, true);
    const call = f.store.value!.conversationBatches![0].calls[0];
    equal(call.status, "started");
    equal(call.effectStarted, undefined);
    const frames = await f.native.checkpoints();
    const frame = frames.find((entry) =>
      entry.request.identity.purpose === "conversation"
    )!;
    ok(
      frame.checkpointId,
      "Accepted pre-effect graph checkpoint remains available",
    );
    const saved = frame.effects.find((effect) => effect.node.id === check.id)!;
    ok(saved?.settled, "The exact admission is retained before its graph join");
    const output = saved.result as { outputs: { decision: unknown } };
    ok(output.outputs.decision);
    deepStrictEqual(f.effects, []);
    f.native.effectBoundary();
    return structuredClone(output.outputs.decision);
  };
}

async function interruptedIdle(f: ReturnType<typeof fixture>) {
  let failed: unknown;
  try {
    await f.service.idle();
  } catch (error) {
    failed = error;
  }
  ok(failed, "The interrupted delivery must fail visibly");
}

async function reopen(
  f: ReturnType<typeof fixture>,
  options: Parameters<typeof fixture>[0] = {},
) {
  const next = fixture({ ...options, store: f.store, native: f.native });
  await next.service.initialize(undefined, {
    resumeContinuations: false,
    resumeCandidateContinuations: false,
  });
  return next;
}

Deno.test("the singleton AgentPort retains a historical profile-free pin, reply and Case provenance", async () => {
  const f = fixture({ legacySteps: [reply], historicalFlow: true });
  equal(Object.hasOwn(f.model.flows.conversation, "executionProfile"), false);
  await f.service.initialize();
  const caseId = await f.service.submit(
    "Reply in this Request",
    undefined,
    undefined,
    true,
  );
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  equal(f.providerRequests, 1);
  const response = f.service.snapshot.messages.find((entry) =>
    entry.text === reply.text
  )!;
  equal(response.caseId, caseId);
  ok(response.execution?.actionId);
  const frames = await f.native.checkpoints();
  const conversation = frames.find((frame) =>
    frame.request.identity.purpose === "conversation"
  )!;
  equal(Object.hasOwn(conversation.request.flow, "executionProfile"), false);
  ok(conversation.checkpointId);
  equal(
    Object.hasOwn(conversation.values.modelPin!, "executionProfile"),
    false,
  );
});

Deno.test("two independent consultations complete out of order before the next provider request", async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  const started = deferred<void>();
  let entered = 0;
  const f = fixture({
    steps: [batch(consult("first"), consult("second")), batch(reply)],
    consult(input) {
      if (++entered === 2) started.resolve();
      return input.query === "first" ? first.promise : second.promise;
    },
  });
  await f.service.initialize();
  await f.service.submit("Read both sources", undefined, undefined, true);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      started.promise,
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Independent reads did not overlap")),
          1000,
        );
      }),
    ]);
    equal(f.providerRequests, 1);
    second.resolve({ marker: "second-result" });
    await Promise.resolve();
    equal(f.providerRequests, 1);
  } finally {
    clearTimeout(deadline);
    first.resolve({ marker: "first-result" });
    second.resolve({ marker: "second-result" });
    await f.service.idle();
  }
  equal(f.service.snapshot.error, undefined);
  equal(f.providerRequests, 2);
  const recorded = f.service.snapshot.conversationBatches![0];
  deepStrictEqual(recorded.calls.map((call) => [call.id, call.status]), [
    ["provider-call-1", "completed"],
    ["provider-call-2", "completed"],
  ]);
  ok(JSON.stringify(recorded.calls[0].result).includes("first-result"));
  ok(JSON.stringify(recorded.calls[1].result).includes("second-result"));
  const replay = JSON.stringify(f.contexts[1].toolCallHistory);
  ok(replay.includes("provider-call-1") && replay.includes("first-result"));
  ok(replay.includes("provider-call-2") && replay.includes("second-result"));
});

Deno.test("immutable consultation concurrency is bounded at four", async () => {
  let running = 0;
  let maximum = 0;
  const firstEntered = deferred<void>(), secondEntered = deferred<void>();
  const firstGate = deferred<void>(), secondGate = deferred<void>();
  const entered: string[] = [];
  const f = fixture({
    steps: [
      batch(
        ...Array.from({ length: 6 }, (_, index) => consult(`source-${index}`)),
      ),
      batch(reply),
    ],
    async consult(input) {
      const ordinal = Number(String(input.query).replace("source-", ""));
      entered.push(String(input.query));
      running++;
      maximum = Math.max(maximum, running);
      if (entered.length === 4) firstEntered.resolve();
      if (entered.length === 6) secondEntered.resolve();
      try {
        await (ordinal < 4 ? firstGate.promise : secondGate.promise);
        return { observed: input.query };
      } finally {
        running--;
      }
    },
  });
  await f.service.initialize();
  await f.service.submit("Inspect six independent sources");
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const bounded = async (promise: Promise<void>, label: string) => {
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error(label)), 5000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  };
  try {
    await bounded(firstEntered.promise, "First four reads did not overlap");
    equal(running, 4);
    deepStrictEqual([...entered].sort(), [
      "source-0",
      "source-1",
      "source-2",
      "source-3",
    ]);
    equal(f.providerRequests, 1);
    firstGate.resolve();
    await bounded(secondEntered.promise, "Last two reads did not overlap");
    equal(running, 2);
    deepStrictEqual(entered.slice(4).sort(), ["source-4", "source-5"]);
    equal(f.providerRequests, 1);
    secondGate.resolve();
  } finally {
    firstGate.resolve();
    secondGate.resolve();
    await f.service.idle();
  }
  equal(f.service.snapshot.error, undefined);
  equal(maximum, 4);
  equal(f.effects.length, 6);
  equal(f.providerRequests, 2);
});

Deno.test("two exact drafts are tested before waiting for their separate admissions", async () => {
  const f = fixture({
    steps: [batch(propose("reader-a"), propose("reader-b"))],
  });
  await f.service.initialize();
  const caseId = await f.service.submit(
    "Prepare both tools",
    undefined,
    undefined,
    true,
  );
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  equal(f.providerRequests, 1);
  deepStrictEqual(f.tested.map((draft) => draft.name), [
    "reader-a",
    "reader-b",
  ]);
  deepStrictEqual(
    f.service.snapshot.candidates.map((candidate) => [
      candidate.name,
      candidate.stage,
      candidate.caseId,
    ]),
    [["reader-a", "awaiting-admission", caseId], [
      "reader-b",
      "awaiting-admission",
      caseId,
    ]],
  );
  const calls = f.service.snapshot.conversationBatches![0].calls;
  const executions = await f.native.execution.inspect(
    f.model.identity.builderId,
  );
  const retained = await f.native.checkpoints();
  for (const [index, call] of calls.entries()) {
    equal(call.result?.status, "awaiting-admission");
    const candidate = f.service.snapshot.candidates[index];
    equal(call.candidateId, candidate.id);
    const admission = executions.find((entry) =>
      entry.identity.purpose === "promotion" &&
      entry.identity.subjectId === candidate.promotionExecution?.subjectId
    );
    ok(
      admission?.checkpointId,
      "Pending exact admission retains its real recovery checkpoint",
    );
    equal(admission.status, "waiting");
    equal(admission.identity.scope.scopeId, caseId);
    equal(admission.modelDigest, f.model.version.digest);
    equal(admission.unsettledEffects.length, 0);
    ok(admission.waits.some((wait) => wait.kind === "decision"));
    const checkpoint = retained.find((entry) =>
      entry.checkpointId === admission.checkpointId
    )!;
    ok(
      checkpoint,
      "The exact admission checkpoint is readable from the official saver",
    );
    ok(JSON.stringify(checkpoint.values).includes(candidate.digest));
  }
  ok(
    executions.some((entry) =>
      entry.identity.purpose === "conversation" && entry.checkpointId &&
      entry.identity.scope.scopeId === caseId && entry.status === "waiting"
    ),
  );
  equal(f.publications, 0);
});

Deno.test("both prepared batch siblings activate through separate exact human admissions", async () => {
  const f = fixture({
    steps: [
      batch(propose("admitted-reader-a"), propose("admitted-reader-b")),
      batch(reply),
      batch(reply),
    ],
  });
  await f.service.initialize();
  await f.service.submit(
    "Prepare two tools for separate decisions",
    undefined,
    undefined,
    true,
  );
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  equal(f.providerRequests, 1);
  equal(f.tested.length, 2);
  const prepared = f.service.snapshot.candidates;
  for (const candidate of prepared) {
    await f.service.decideCandidate({
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      caseId: candidate.caseId,
      verdict: "approve",
      reason: `Exact separate admission for ${candidate.name}`,
    });
    await f.service.idle();
  }
  equal(f.service.snapshot.error, undefined);
  equal(f.publications, 2);
  equal(f.tested.length, 2);
  deepStrictEqual(
    f.service.snapshot.candidates.map((candidate) => candidate.stage),
    ["active", "active"],
  );
  deepStrictEqual(
    f.service.snapshot.candidates.map((candidate) =>
      candidate.admission?.candidateDigest
    ),
    prepared.map((candidate) => candidate.digest),
  );
  ok(
    f.service.snapshot.events.some((event) =>
      event.kind === "candidate-catalog-base-refreshed"
    ),
  );
  equal(f.model.catalog.length, 2);
});

Deno.test("scripted equivalent reads use two grouped provider requests instead of three singleton requests", async () => {
  const singleton = fixture({
    legacySteps: [consult("same-a"), consult("same-b"), reply],
  });
  await singleton.service.initialize();
  await singleton.service.submit("Observe the same two sources");
  await singleton.service.idle();
  equal(singleton.service.snapshot.error, undefined);
  const grouped = fixture({
    steps: [batch(consult("same-a"), consult("same-b")), batch(reply)],
  });
  await grouped.service.initialize();
  await grouped.service.submit("Observe the same two sources");
  await grouped.service.idle();
  equal(grouped.service.snapshot.error, undefined);
  deepStrictEqual(grouped.effects, singleton.effects);
  equal(singleton.providerRequests, 3);
  equal(grouped.providerRequests, 2);
});

Deno.test("two scripted drafts need one grouped drafting response instead of two singleton responses", async () => {
  const singleton = fixture({
    legacySteps: [propose("same-reader-a"), propose("same-reader-b")],
  });
  await singleton.service.initialize();
  await singleton.service.submit(
    "Prepare the same two drafts",
    undefined,
    undefined,
    true,
  );
  await singleton.service.idle();
  const first = singleton.service.snapshot.candidates[0];
  await singleton.service.decideCandidate({
    candidateId: first.id,
    candidateDigest: first.digest,
    caseId: first.caseId,
    verdict: "approve",
    reason: "Separate first admission to continue singleton preparation",
  });
  await singleton.service.idle();
  equal(singleton.service.snapshot.error, undefined);
  const grouped = fixture({
    steps: [batch(propose("same-reader-a"), propose("same-reader-b"))],
  });
  await grouped.service.initialize();
  await grouped.service.submit(
    "Prepare the same two drafts",
    undefined,
    undefined,
    true,
  );
  await grouped.service.idle();
  equal(grouped.service.snapshot.error, undefined);
  deepStrictEqual(
    grouped.tested.map(({ name, code }) => ({ name, code })),
    singleton.tested.map(({ name, code }) => ({ name, code })),
  );
  equal(singleton.providerRequests, 2);
  equal(grouped.providerRequests, 1);
});

Deno.test("a mixed read and proposal preserves order and each exact result", async () => {
  const order: string[] = [];
  const f = fixture({
    steps: [batch(consult("basis"), propose("basis-reader"))],
    consult(input) {
      order.push(`read:${String(input.query)}`);
      return Promise.resolve({ marker: "basis-observed" });
    },
    test(draft) {
      order.push(`test:${draft.name}`);
    },
  });
  await f.service.initialize();
  await f.service.submit(
    "Read the basis and prepare its tool",
    undefined,
    undefined,
    true,
  );
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  deepStrictEqual(order, ["read:basis", "test:basis-reader"]);
  const calls = f.service.snapshot.conversationBatches![0].calls;
  equal(calls[0].result?.status, "succeeded");
  equal(calls[1].result?.status, "awaiting-admission");
  equal(f.providerRequests, 1);
});

Deno.test("opaque calls to a shared resource execute serially and preserve native results", async () => {
  let running = 0;
  let maximum = 0;
  const f = fixture({
    steps: [batch(invoke("first"), invoke("second")), batch(reply)],
    async invoke(request) {
      running++;
      maximum = Math.max(maximum, running);
      await new Promise((done) => setTimeout(done, 1));
      running--;
      return {
        behaviorId: request.behavior.id,
        invocationId: request.invocationId,
        targetNativeId: request.behavior.targetNativeId,
        modelVersion: request.modelVersion,
        result: { recorded: request.input.value },
      };
    },
  });
  await f.service.initialize();
  await f.service.submit("Record two changes", undefined, undefined, true);
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  equal(maximum, 1);
  deepStrictEqual(f.effects, ["behavior:first", "behavior:second"]);
  const calls = f.service.snapshot.conversationBatches![0].calls;
  ok(calls.every((call) => call.status === "completed"));
  ok(JSON.stringify(calls[0].result).includes("first"));
  ok(JSON.stringify(calls[1].result).includes("second"));
});

Deno.test("one terminal reply may follow effects from the same response", async () => {
  const f = fixture({ steps: [batch(invoke("before-reply"), reply)] });
  await f.service.initialize();
  await f.service.submit("Record then reply", undefined, undefined, true);
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  deepStrictEqual(f.effects, ["behavior:before-reply"]);
  equal(f.providerRequests, 1);
  equal(
    f.service.snapshot.messages.filter((entry) => entry.text === reply.text)
      .length,
    1,
  );
  ok(
    f.service.snapshot.conversationBatches![0].calls.every((call) =>
      call.status === "completed"
    ),
  );
});

Deno.test("singleton and batch AgentPorts deduplicate the business dossier throughout native checkpoints", async () => {
  const decisions = [invoke("first"), invoke("second"), invoke("third"), reply];
  const measurements: Record<string, {
    stateCharacters: number;
    checkpointCharacters: number;
    peakCheckpointCharacters: number;
    duplicatedRecordCharacters: number;
  }> = {};
  for (const mode of ["singleton-port", "batch-port"] as const) {
    const store = new MemoryStore();
    let peakCheckpointCharacters = 0;
    let duplicatedRecordCharacters = 0;
    const f = fixture({
      store,
      ...(mode === "singleton-port"
        ? { legacySteps: decisions }
        : { steps: decisions.map((decision) => batch(decision)) }),
    });
    f.model.version.sourceIds = Array.from(
      { length: 128 },
      (_, index) => `native-source-${String(index).padStart(3, "0")}`,
    );
    await f.service.initialize();
    await f.service.submit(
      "Observe three native effects",
      undefined,
      undefined,
      true,
    );
    await f.service.idle();
    const state = f.service.snapshot;
    equal(state.error, undefined);
    deepStrictEqual(f.effects, [
      "behavior:first",
      "behavior:second",
      "behavior:third",
    ]);
    equal(f.providerRequests, 4);
    equal(
      state.messages.filter((entry) => entry.text === reply.text).length,
      1,
    );
    if (mode === "batch-port") {
      const calls = state.conversationBatches!.flatMap((entry) => entry.calls);
      equal(calls.length, 4);
      ok(calls.every((call) => call.status === "completed" && call.result));
      ok(calls.every((call) => call.checkpoint === undefined));
      deepStrictEqual(calls.map((call) => call.result!.code), [
        "BEHAVIOR_COMPLETED",
        "BEHAVIOR_COMPLETED",
        "BEHAVIOR_COMPLETED",
        "REPLY_RECORDED",
      ]);
    }
    const checkpoints = await f.native.checkpoints();
    let referencePairs = 0;
    // Inspect every nested channel (including prepared inputs/results and
    // operator data), not just the two known record bindings. Actual messages
    // and candidate DTOs remain valid; a hydrated dossier is not checkpoint data.
    const inspectDossierCopies = (value: unknown, path: string): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((item, index) =>
          inspectDossierCopies(item, `${path}[${index}]`)
        );
        return;
      }
      const object = value as Record<string, unknown>;
      const copiedDossier = Array.isArray(object.messages) &&
        (Array.isArray(object.candidates) || "executionModel" in object ||
          "sessionId" in object);
      if (copiedDossier) {
        duplicatedRecordCharacters += JSON.stringify(object).length;
      }
      ok(
        !copiedDossier,
        `The real saver contains a copied business dossier at ${path}`,
      );
      for (const [name, nested] of Object.entries(object)) {
        inspectDossierCopies(nested, `${path}.${name}`);
      }
    };
    for (const checkpoint of checkpoints) {
      for (const saved of checkpoint.history) {
        inspectDossierCopies(saved, "checkpoint");
        peakCheckpointCharacters = Math.max(
          peakCheckpointCharacters,
          JSON.stringify(saved).length,
        );
        const read = saved.values?.readCaseState as
          | { record?: unknown }
          | undefined;
        const chosen = saved.values?.chooseNextMove as
          | { record?: unknown }
          | undefined;
        for (const record of [read?.record, chosen?.record]) {
          if (record) {
            ok(
              typeof record === "object" &&
                "__assemblyRuntimeRevision" in record,
              "The real saver retains an immutable business reference, never a copied dossier",
            );
            equal("messages" in record, false);
          }
        }
        if (read?.record && chosen?.record) {
          deepStrictEqual(read.record, chosen.record);
          referencePairs++;
        }
      }
    }
    ok(
      referencePairs > 0,
      "The shared read/decision reference was observed in real checkpoints",
    );
    measurements[mode] = {
      stateCharacters: JSON.stringify(state).length,
      checkpointCharacters: checkpoints.reduce(
        (total, checkpoint) => total + JSON.stringify(checkpoint.values).length,
        0,
      ),
      peakCheckpointCharacters,
      duplicatedRecordCharacters,
    };
  }
  console.log(
    "Dossier deduplication observations (not a total-size bound):",
    JSON.stringify(measurements),
  );
  equal(measurements["batch-port"].duplicatedRecordCharacters, 0);
  equal(measurements["singleton-port"].duplicatedRecordCharacters, 0);
  ok(measurements["batch-port"].peakCheckpointCharacters > 0);
});

for (const boundary of ["next-decision", "reply-cursor"] as const) {
  Deno.test(`native checkpoint interrupted at ${boundary} resumes without replaying an effect or reply`, async () => {
    const original = fixture({
      steps: boundary === "next-decision"
        ? [batch(invoke("effect-once"))]
        : [batch(reply)],
    });
    await original.service.initialize();
    let interrupted = false;
    const mechanism = boundary === "next-decision" ? "invoke_tool" : "reply";
    original.native.effectBoundary((point) => {
      if (
        !interrupted && point.phase === "after-receipt" &&
        point.node.mechanism === mechanism
      ) {
        interrupted = true;
        throw new Error(
          "Controlled native interruption after settled effect before checkpoint join",
        );
      }
    });
    const caseId = await original.service.submit(
      "Reach the durable native boundary",
      undefined,
      undefined,
      true,
    );
    await interruptedIdle(original);
    equal(interrupted, true);
    const accepted = structuredClone(original.store.value!);
    const frames = await original.native.checkpoints();
    const frame = frames.find((entry) =>
      entry.request.identity.purpose === "conversation"
    )!;
    ok(frame.checkpointId);
    const receipt = frame.effects.find((effect) =>
      effect.node.mechanism === mechanism
    )!;
    ok(receipt.settled);
    equal(accepted.conversationBatches![0].caseId, caseId);
    original.native.effectBoundary();
    const restarted = await reopen(original, { steps: [batch(reply)] });
    await restarted.native.retryFailed();
    await restarted.service.idle();
    const state = restarted.service.snapshot;
    equal(state.error, undefined);
    deepStrictEqual(
      original.effects,
      boundary === "next-decision" ? ["behavior:effect-once"] : [],
    );
    deepStrictEqual(restarted.effects, []);
    equal(restarted.providerRequests, boundary === "next-decision" ? 1 : 0);
    equal(
      state.messages.filter((entry) => entry.text === reply.text).length,
      1,
    );
    const recovered = (await restarted.native.checkpoints()).flatMap((entry) =>
      entry.effects
    ).find((effect) => effect.key === receipt.key);
    deepStrictEqual(recovered, receipt);
    deepStrictEqual(
      original.store.value!.conversationBatches![0].calls[0].result,
      accepted.conversationBatches![0].calls[0].result,
    );
    ok(
      frames[0].checkpointId,
      "Recovery did not mutate the previously captured frame",
    );
  });
}

Deno.test("a known refusal preserves the earlier effect and both correlated outcomes", async () => {
  const f = fixture({
    steps: [
      batch(invoke("confirmed-before-refusal"), consult("refused-read")),
      batch(reply),
    ],
    consult() {
      throw new Error("Source consultation refused by its technical contract");
    },
  });
  await f.service.initialize();
  await f.service.submit("Record then consult", undefined, undefined, true);
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  deepStrictEqual(f.effects, [
    "behavior:confirmed-before-refusal",
    "read:refused-read",
  ]);
  const calls = f.service.snapshot.conversationBatches![0].calls;
  equal(calls[0].result?.status, "succeeded");
  ok(["refused", "failed"].includes(calls[1].result!.status));
  equal(calls[1].status, "completed");
  ok(
    JSON.stringify(f.contexts[1].toolCallHistory).includes(
      "Source consultation refused",
    ),
  );
});

Deno.test("a proposal authority refusal after a successful read is recorded as refused", async () => {
  const denied: ChatDecision = {
    kind: "propose_mandate_change",
    text: "Request an unauthorized URL selection change",
    reason: "The read does not grant new proposal authority",
    requestedRights: { setUrlSelectionMode: "authorized-host" },
  };
  const f = fixture({
    steps: [batch(consult("preserved-basis"), denied), batch(reply)],
  });
  f.model.policy.mayChangeUrlSelection = false;
  await f.service.initialize();
  await f.service.submit(
    "Read, then respect the current authority",
    undefined,
    undefined,
    true,
  );
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  deepStrictEqual(f.effects, ["read:preserved-basis"]);
  const calls = f.service.snapshot.conversationBatches![0].calls;
  equal(calls[0].result?.status, "succeeded");
  equal(calls[1].result?.status, "refused");
  equal(calls[1].result?.code, "PROPOSAL_NOT_AUTHORIZED");
  equal(f.service.snapshot.configuration!.changes.length, 0);
  equal(f.providerRequests, 2);
});

for (
  const kind of ["decide_operator_candidate", "decide_operator_change"] as const
) {
  Deno.test(`${kind} continues with its exact refused outcome`, async () => {
    const command: ChatDecision = kind === "decide_operator_candidate"
      ? {
        kind,
        text: "Admit the exact candidate",
        operatorId: "peer",
        candidateId: "candidate-17",
        candidateDigest: "b".repeat(64),
        expectedRevision: 17,
        caseId: "peer-request",
        policyId: "candidate-policy",
        policyRevision: 3,
        verdict: "approve",
        reason: "Exact inspected candidate",
      }
      : {
        kind,
        text: "Decide the exact authority request",
        operatorId: "peer",
        changeId: "change-17",
        expectedRevision: 17,
        policyId: "authority-policy",
        policyRevision: 3,
        verdict: "approve",
      };
    const refusal = new OperatorAuthorityError(
      kind === "decide_operator_candidate"
        ? "AUTHORITY_REQUEST_STALE"
        : "AUTHORITY_POLICY_FORBIDDEN",
      `Exact ${kind} authority was refused`,
      { operatorId: "peer", requestId: "17" },
    );
    const f = fixture({
      steps: [
        batch(consult("confirmed-before-delegated-refusal"), command),
        batch(reply),
      ],
    });
    await f.service.initialize();
    let attempts = 0;
    const refuse = (received: ChatDecision) => {
      attempts++;
      deepStrictEqual(received, command);
      return Promise.reject(refusal);
    };
    f.service.bindOperatorAuthorityLifecycle({
      decideCandidate: refuse,
      decide: refuse,
      proposed: () => Promise.resolve(),
      approved: () => Promise.resolve(),
      closed: () => Promise.resolve(),
    });
    await f.service.submit(
      "Read and decide the exact delegated request",
      undefined,
      undefined,
      true,
    );
    await f.service.idle();
    equal(f.service.snapshot.error, undefined);
    const calls = f.service.snapshot.conversationBatches![0].calls;
    equal(calls[0].result?.status, "succeeded");
    deepStrictEqual(calls[1].result, {
      status: "refused",
      code: refusal.code,
      details: refusal.message,
      value: {
        code: refusal.code,
        context: refusal.context,
        recovery: refusal.recovery,
        message: refusal.message,
      },
    });
    equal(calls[1].status, "completed");
    equal(
      f.service.snapshot.messages.some((message) =>
        message.role === "tool" && message.text.includes(refusal.code)
      ),
      true,
    );
    equal(attempts, 1);
    const replay = f.contexts[1].toolCallHistory![0].results[1];
    equal(replay.id, calls[1].id);
    equal(replay.isError, true);
    deepStrictEqual(JSON.parse(replay.result), calls[1].result);
  });
}

Deno.test("only pinned pure navigation is eligible for parallel consultation", async () => {
  for (const operation of ["search", "inspect", "references", "query"]) {
    equal(
      immutableModelConsultation({ operation, version: sourceVersion }),
      true,
    );
  }
  for (
    const operation of [
      "read_source",
      "unload_sources",
      "network_impact",
      "unknown",
    ]
  ) {
    equal(
      immutableModelConsultation({ operation, version: sourceVersion }),
      false,
    );
  }
  equal(immutableModelConsultation({ operation: "search" }), false);
  const loading = deferred<unknown>();
  const entered = deferred<void>();
  const order: string[] = [];
  const chosen = (operation: string): ChatDecision => ({
    kind: "consult_model",
    text: operation,
    inputJson: JSON.stringify({
      operation,
      version: sourceVersion,
      path: "system.sysml",
    }),
  });
  const f = fixture({
    steps: [
      batch(
        chosen("read_source"),
        chosen("unload_sources"),
        consult("after-working-set"),
      ),
      batch(reply),
    ],
    consult(input) {
      order.push(String(input.operation));
      if (input.operation === "read_source") {
        entered.resolve();
        return loading.promise;
      }
      return Promise.resolve({ operation: input.operation });
    },
  });
  await f.service.initialize();
  await f.service.submit("Load and unload the exact source before searching");
  await entered.promise;
  deepStrictEqual(order, ["read_source"]);
  loading.resolve({ loaded: true });
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  deepStrictEqual(order, ["read_source", "unload_sources", "search"]);
  ok(
    f.service.snapshot.conversationBatches![0].calls.every((call) =>
      call.status === "completed"
    ),
  );
});

Deno.test("a native budget wait resumes the exact second draft without repeated tests or publication", async () => {
  let ledger: WorkBudgetRecord | null = null;
  const workBudget = new WorkBudgetService({
    load: () => Promise.resolve(structuredClone(ledger)),
    save(record) {
      ledger = structuredClone(record);
      return Promise.resolve();
    },
  });
  const f = fixture({
    autoAdmission: true,
    workBudget,
    budgetLimit: 2,
    steps: [
      batch(propose("budget-reader-a"), propose("budget-reader-b")),
      batch(reply),
    ],
  });
  await f.service.initialize();
  const caseId = await f.service.submit(
    "Prepare both within the admitted budget",
    undefined,
    undefined,
    true,
  );
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  equal(f.service.snapshot.budgetSuspension?.reason, "exhausted");
  equal(
    f.providerRequests,
    2,
    "One group decision and the first admission consume the initial budget",
  );
  equal(f.publications, 1);
  deepStrictEqual(f.tested.map((draft) => draft.name), [
    "budget-reader-a",
    "budget-reader-b",
  ]);
  const candidateIds = f.service.snapshot.candidates.map((candidate) =>
    candidate.id
  );

  const proposalMessages = f.service.snapshot.messages.filter((message) =>
    message.role === "assistant" &&
    [propose("budget-reader-a").text, propose("budget-reader-b").text].includes(
      message.text,
    )
  );
  equal(proposalMessages.length, 2);
  f.model.workBudgetPolicy!.revision = 2;
  f.model.workBudgetPolicy!.limit = 4;
  f.model.version.digest = "batch-budget-authority-v2";
  f.model.version.repositoryVersion = "commit:batch-budget-authority-v2";
  await f.service.adoptModelVersion({ expectedDigest: f.model.version.digest });
  await f.service.submit(
    "Resume the exact queued work under the adopted budget",
    undefined,
    caseId,
  );
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  equal(f.service.snapshot.budgetSuspension, undefined);
  equal(f.publications, 2);
  equal(
    f.providerRequests,
    4,
    "Only the second admission and final reply dispatch after adoption",
  );
  equal(f.tested.length, 2);
  deepStrictEqual(
    f.service.snapshot.messages.filter((message) =>
      message.role === "assistant" &&
      [propose("budget-reader-a").text, propose("budget-reader-b").text]
        .includes(message.text)
    ),
    proposalMessages,
  );
  deepStrictEqual(
    f.service.snapshot.candidates.map((candidate) => candidate.id),
    candidateIds,
  );
  ok(
    f.service.snapshot.candidates.every((candidate) =>
      candidate.stage === "active"
    ),
  );
});

Deno.test("restart restores the exact cached behavior admission before its first effect", async () => {
  const store = new MemoryStore();
  const original = fixture({
    store,
    steps: [batch(invoke("cached-admission-once"))],
  });
  await original.service.initialize();
  const interrupted = interruptAfterInvocationCheck(original, "invoke_tool");
  const caseId = await original.service.submit(
    "Record with the exact checked invocation",
    undefined,
    undefined,
    true,
  );
  await interruptedIdle(original);
  const checked = (await interrupted()) as BehaviorAdmission;
  equal(original.service.snapshot.cases![0].id, caseId);
  equal(checked.admitted, true);
  deepStrictEqual(checked.input, { value: "cached-admission-once" });
  const savedCheck = structuredClone(
    (await original.native.checkpoints()).flatMap((frame) => frame.effects)
      .filter((effect) => effect.node.mechanism === "check_invocation"),
  );
  const requests: BehaviorInvocationRequest[] = [];
  const restarted = await reopen(original, {
    steps: [batch(reply), batch(reply)],
    invoke(request) {
      requests.push(structuredClone(request));
      return Promise.resolve({
        behaviorId: request.behavior.id,
        invocationId: request.invocationId,
        targetNativeId: request.behavior.targetNativeId,
        modelVersion: request.modelVersion,
        result: { recorded: request.input.value },
      });
    },
  });
  await restarted.native.retryFailed();
  await restarted.service.idle();
  equal(restarted.service.snapshot.error, undefined);
  equal(requests.length, 1);
  equal(requests[0].invocationId, checked.invocationId);
  deepStrictEqual(requests[0].input, checked.input);
  deepStrictEqual(requests[0].modelVersion, checked.modelVersion);
  deepStrictEqual(restarted.effects, ["behavior:cached-admission-once"]);
  const completed = restarted.service.snapshot.conversationBatches![0].calls[0];
  equal(completed.status, "completed");
  equal(completed.result?.code, "BEHAVIOR_COMPLETED");
  const retainedChecks = (await restarted.native.checkpoints()).flatMap(
    (frame) => frame.effects,
  );
  for (const receipt of savedCheck) {
    deepStrictEqual(
      retainedChecks.find((effect) => effect.key === receipt.key),
      receipt,
    );
  }
  await restarted.service.submit(
    "Continue after the result",
    undefined,
    caseId,
  );
  await restarted.service.idle();
  equal(restarted.service.snapshot.error, undefined);
  equal(requests.length, 1);
  equal(restarted.providerRequests, 2);
});

for (
  const refused of [
    {
      name: "behavior",
      decision: { ...invoke("not-authorized"), behaviorId: "absent-behavior" },
      code: "BEHAVIOR_NOT_AUTHORIZED",
    },
    {
      name: "generated-tool",
      decision: {
        kind: "invoke_tool" as const,
        text: "Read with an unavailable tool",
        toolId: "absent-tool",
        input: { url: "https://example.org/refused" },
      },
      code: "TOOL_UNAVAILABLE",
    },
  ]
) {
  Deno.test(`restart preserves a cached ${refused.name} refusal before reporting it`, async () => {
    const store = new MemoryStore();
    const original = fixture({ store, steps: [batch(refused.decision)] });
    await original.service.initialize();
    const interrupted = interruptAfterInvocationCheck(
      original,
      "report_refusal",
    );
    const caseId = await original.service.submit(
      "Observe the refusal without invoking",
      undefined,
      undefined,
      true,
    );
    await interruptedIdle(original);
    equal(original.service.snapshot.cases![0].id, caseId);
    const checked = (await interrupted()) as {
      admitted: boolean;
      failure?: { code: string };
    };
    equal(checked.admitted, false);
    equal(checked.failure?.code, refused.code);

    const restarted = await reopen(original, { steps: [batch(reply)] });
    await restarted.native.retryFailed();
    await restarted.service.idle();
    equal(restarted.service.snapshot.error, undefined);
    deepStrictEqual(restarted.effects, []);
    const call = restarted.service.snapshot.conversationBatches![0].calls[0];
    equal(call.status, "completed");
    equal(call.result?.status, "refused");
    equal(call.result?.code, refused.code);
    equal(restarted.providerRequests, 1);
  });
}

Deno.test("a restored cached behavior admission still requires fresh invocation authority", async () => {
  const store = new MemoryStore();
  const original = fixture({ store, steps: [batch(invoke("revoked-call"))] });
  await original.service.initialize();
  const interrupted = interruptAfterInvocationCheck(original, "invoke_tool");
  const caseId = await original.service.submit(
    "Check before authority is revoked",
    undefined,
    undefined,
    true,
  );
  await interruptedIdle(original);
  equal(((await interrupted()) as BehaviorAdmission).admitted, true);
  equal(original.service.snapshot.cases![0].id, caseId);
  let supportChecks = 0;
  const restarted = await reopen(original, {
    supports() {
      supportChecks++;
      return false;
    },
  });
  try {
    await restarted.native.retryFailed();
  } catch { /* Assert the durable refusal below. */ }
  await restarted.service.idle();
  ok(supportChecks > 0);
  ok(
    restarted.service.snapshot.error?.includes(
      "contrat natif d’appel a changé",
    ),
  );
  deepStrictEqual(restarted.effects, []);
  equal(restarted.providerRequests, 0);
  equal(
    restarted.service.snapshot.conversationBatches![0].calls[0].result,
    undefined,
  );
});

Deno.test("restart resumes queued members without repeating a durably completed effect", async () => {
  const store = new MemoryStore();
  const original = fixture({
    store,
    steps: [batch(invoke("completed-once"), invoke("queued-once"))],
  });
  await original.service.initialize();
  let interrupted = false;
  original.native.effectBoundary((point) => {
    if (
      !interrupted && point.phase === "after-receipt" &&
      point.node.mechanism === "invoke_tool"
    ) {
      interrupted = true;
      throw new Error(
        "Controlled native interruption after first exact effect",
      );
    }
  });
  const caseId = await original.service.submit(
    "Record both members",
    undefined,
    undefined,
    true,
  );
  await interruptedIdle(original);
  equal(interrupted, true);
  deepStrictEqual(original.effects, ["behavior:completed-once"]);
  equal(store.value!.conversationBatches![0].calls[0].status, "completed");
  equal(store.value!.conversationBatches![0].calls[1].status, "queued");

  original.native.effectBoundary();
  const restarted = await reopen(original, { steps: [batch(reply)] });
  await restarted.native.retryFailed();
  equal(restarted.service.snapshot.cases![0].id, caseId);
  await restarted.service.idle();
  equal(restarted.service.snapshot.error, undefined);
  deepStrictEqual(restarted.effects, ["behavior:queued-once"]);
  equal(restarted.providerRequests, 1);
  ok(
    restarted.service.snapshot.conversationBatches![0].calls.every((call) =>
      call.status === "completed"
    ),
  );
});

Deno.test("a newer interrupted batch checkpoint takes priority over an older native wait cursor", async () => {
  const store = new MemoryStore();
  const original = fixture({
    store,
    steps: [
      batch(reply),
      batch(invoke("newer-completed"), invoke("newer-queued")),
    ],
  });
  await original.service.initialize();
  const caseId = await original.service.submit(
    "Establish an earlier native wait",
    undefined,
    undefined,
    true,
  );
  await original.service.idle();
  const oldCursor = (await original.native.checkpoints()).find((entry) =>
    entry.request.identity.purpose === "conversation"
  )!;
  ok(oldCursor.checkpointId);
  let interrupted = false;
  original.native.effectBoundary((point) => {
    if (
      !interrupted && point.phase === "after-receipt" &&
      point.node.mechanism === "invoke_tool"
    ) {
      interrupted = true;
      throw new Error(
        "Controlled native interruption after first exact effect",
      );
    }
  });
  await original.service.submit(
    "Run the newer correlated group",
    undefined,
    caseId,
  );
  await interruptedIdle(original);
  equal(interrupted, true);
  deepStrictEqual(original.effects, ["behavior:newer-completed"]);
  deepStrictEqual(
    (await original.native.checkpoints()).find((entry) =>
      entry.checkpointId === oldCursor.checkpointId
    ),
    oldCursor,
  );
  equal(store.value!.conversationBatches![1].calls[0].status, "completed");
  equal(store.value!.conversationBatches![1].calls[1].status, "queued");

  original.native.effectBoundary();
  const restarted = await reopen(original, { steps: [batch(reply)] });
  await restarted.native.retryFailed();
  equal(restarted.service.snapshot.cases![0].id, caseId);
  await restarted.service.idle();
  equal(restarted.service.snapshot.error, undefined);
  deepStrictEqual(restarted.effects, ["behavior:newer-queued"]);
  equal(restarted.providerRequests, 1);
  ok(
    restarted.service.snapshot.conversationBatches![1].calls.every((call) =>
      call.status === "completed"
    ),
  );
});

Deno.test("queued work remains with its exact Request while another Request receives a contribution", async () => {
  const f = fixture({
    steps: [
      batch(invoke("request-a-completed"), invoke("request-a-queued")),
      batch(reply),
      batch(reply),
    ],
  });
  await f.service.initialize();
  let interrupted = false;
  f.native.effectBoundary((point) => {
    if (
      !interrupted && point.phase === "after-receipt" &&
      ["invoke_tool", "execute_operator_command"].includes(
        point.node.mechanism ?? "",
      )
    ) {
      interrupted = true;
      throw new Error("Controlled native interruption before queued sibling");
    }
  });
  const requestA = await f.service.submit(
    "Run only Request A work",
    undefined,
    undefined,
    true,
  );
  await interruptedIdle(f);
  equal(interrupted, true);
  f.native.effectBoundary();
  const requestB = await f.service.submit(
    "Open independent Request B",
    undefined,
    undefined,
    true,
  );
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  ok(requestA !== requestB);
  deepStrictEqual(f.effects, ["behavior:request-a-completed"]);
  equal(f.service.snapshot.conversationBatches![0].calls[1].status, "queued");
  equal(f.service.snapshot.conversationBatches![0].caseId, requestA);
  equal(f.service.snapshot.conversationBatches![1].caseId, requestB);

  await f.native.retryFailed();
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  deepStrictEqual(f.effects, [
    "behavior:request-a-completed",
    "behavior:request-a-queued",
  ]);
  equal(f.providerRequests, 3);
  equal(
    f.service.snapshot.conversationBatches![0].calls[1].status,
    "completed",
  );
});

Deno.test("a pure consultation interrupted before a queued effect stays with its exact delegated invocation", async () => {
  const f = fixture({
    steps: [batch(consult("A-read"), invoke("A-effect")), batch(reply)],
  });
  await f.service.initialize();
  const work = (id: string): OperatorWorkReceipt => ({
    callerId: "main",
    correlationId: id,
    fingerprint: id,
    invocationId: id,
    behaviorId: "inbox",
    targetNativeId: "batch-builder",
    priorCandidateIds: [],
    modelVersion: { digest: "main-pin", repositoryVersion: "main-source" },
    caseId: "root-request",
    caseContext: {
      caseId: "root-request",
      number: 1,
      modelPin: { digest: "main-pin" },
      record: {
        id: "root-request",
        number: 1,
        type: "request",
        owner: "main",
        openedBy: "owner",
        openedFrom: {
          conversationId: "main",
          openingId: "root-opening",
          designerScopeId: "main-designer",
        },
        objective: "Coordinate these delegated contributions",
        modelPin: { digest: "main-pin" },
        status: "open",
        createdAt: "now",
      },
    },
  });
  let interrupted = false;
  f.native.effectBoundary((point) => {
    const calls = f.store.value?.conversationBatches?.[0]?.calls;
    if (
      !interrupted && point.phase === "before-operation" &&
      point.node.mechanism === "choose_move" &&
      calls?.[0].status === "completed" && calls[1]?.status === "queued"
    ) {
      interrupted = true;
      throw new Error("Controlled native interruption before queued sibling");
    }
  });
  await f.service.submit("Contribution A", work("A"));
  await interruptedIdle(f);
  equal(
    interrupted,
    true,
    JSON.stringify({
      error: f.service.snapshot.error,
      providerRequests: f.providerRequests,
      calls: f.service.snapshot.conversationBatches?.[0]?.calls.map((call) => ({
        id: call.id,
        status: call.status,
        result: call.result,
      })),
      effects: f.effects,
    }),
  );
  f.native.effectBoundary();
  ok(
    (await f.native.checkpoints()).some((entry) =>
      entry.request.identity.invocationKey ===
        f.service.snapshot.conversationBatches![0].invocationKey
    ),
  );
  deepStrictEqual(f.effects, ["read:A-read"]);
  await f.service.submit("Contribution B", work("B"));
  await f.service.idle();
  deepStrictEqual(f.effects, ["read:A-read"]);
  equal(f.service.snapshot.conversationBatches![0].calls[1].status, "queued");
  equal(f.providerRequests, 2);
  equal(f.contexts[1].toolCallHistory, undefined);
  ok(
    f.service.snapshot.conversationBatches![0].invocationKey !==
      f.service.snapshot.conversationBatches![1].invocationKey,
  );
});

Deno.test("a started opaque effect without durable result remains unknown after restart", async () => {
  const store = new MemoryStore();
  const original = fixture({
    store,
    steps: [
      batch(
        invoke("effect-without-durable-result"),
        invoke("must-stay-queued"),
      ),
    ],
  });
  await original.service.initialize();
  let interrupted = false;
  original.native.effectBoundary((point) => {
    if (
      !interrupted && point.phase === "after-operation" &&
      point.node.mechanism === "invoke_tool"
    ) {
      interrupted = true;
      throw new Error(
        "Controlled native interruption before opaque result receipt",
      );
    }
  });
  const caseId = await original.service.submit(
    "Record with durable evidence",
    undefined,
    undefined,
    true,
  );
  await interruptedIdle(original);
  equal(interrupted, true);
  deepStrictEqual(original.effects, ["behavior:effect-without-durable-result"]);

  original.native.effectBoundary();
  const restarted = await reopen(original, { steps: [batch(reply)] });
  let refused: unknown;
  try {
    await restarted.native.retryFailed();
  } catch (error) {
    refused = error;
  }
  ok(refused, "A missing opaque receipt must fail closed");
  equal(restarted.service.snapshot.cases![0].id, caseId);
  await restarted.service.idle();
  equal(restarted.providerRequests, 0);
  deepStrictEqual(restarted.effects, []);
  const calls = restarted.service.snapshot.conversationBatches![0].calls;
  const executions = await restarted.native.execution.inspect(
    restarted.model.identity.builderId,
  );
  ok(
    executions.some((entry) =>
      entry.status === "uncertain" && entry.unsettledEffects.length > 0
    ),
  );
  ok(
    (await restarted.native.checkpoints()).some((entry) =>
      entry.effects.some((effect) =>
        effect.node.mechanism === "invoke_tool" && !effect.settled
      )
    ),
  );
  equal(calls[1].status, "queued");
  ok(restarted.service.snapshot.error);
});

Deno.test("abandoning an interrupted Case cancels its queued members without further effects", async () => {
  const store = new MemoryStore();
  const f = fixture({
    store,
    steps: [batch(invoke("already-recorded"), invoke("cancelled-member"))],
  });
  await f.service.initialize();
  let interrupted = false;
  f.native.effectBoundary((point) => {
    if (
      !interrupted && point.phase === "after-receipt" &&
      ["invoke_tool", "execute_operator_command"].includes(
        point.node.mechanism ?? "",
      )
    ) {
      interrupted = true;
      throw new Error("Controlled native interruption before queued sibling");
    }
  });
  const caseId = await f.service.submit(
    "Record until cancellation",
    undefined,
    undefined,
    true,
  );
  await interruptedIdle(f);
  equal(interrupted, true);
  f.native.effectBoundary();
  await f.service.closeCase(caseId!, "abandoned");
  deepStrictEqual(f.effects, ["behavior:already-recorded"]);
  const calls = f.service.snapshot.conversationBatches![0].calls;
  equal(calls[0].status, "completed");
  equal(calls[1].status, "cancelled");
  equal(calls[1].result?.status, "cancelled");
});

for (
  const malformed of [
    {
      name: "duplicate provider IDs",
      error: "Every tool call requires its own exact, unique ID.",
      value: {
        calls: [
          { id: "same", decision: invoke("one") },
          { id: "same", decision: invoke("two") },
        ],
      },
    },
    {
      name: "missing provider ID",
      error: "Every tool call requires its own exact, unique ID.",
      value: {
        calls: [
          { decision: invoke("one") },
        ],
      },
    },
    {
      name: "oversized group",
      error: "A response requires between one and eight tool calls.",
      value: batch(
        ...Array.from({ length: 9 }, (_, index) => invoke(String(index))),
      ),
    },
    {
      name: "the lower admitted proposal ceiling",
      error: "The group exceeds the admitted tool proposal ceiling.",
      value: batch(
        propose("over-limit-a"),
        propose("over-limit-b"),
        propose("over-limit-c"),
      ),
    },
    {
      name: "reply before another member",
      error: "A terminal response must be the final call in its group.",
      value: batch(reply, invoke("after-reply")),
    },
    {
      name: "multiple terminal replies",
      value: batch(reply, reply),
      error: "A terminal response must be the final call in its group.",
    },
  ] as const
) {
  Deno.test(`batch validation refuses ${malformed.name} before effects`, async () => {
    const f = fixture({ steps: [malformed.value as ChatDecisionBatch] });
    await f.service.initialize();
    await f.service.submit("Do only a valid bounded group");
    await rejects(() => f.service.idle(), {
      name: "Error",
      message: malformed.error,
    });
    equal(f.service.snapshot.error, malformed.error);
    deepStrictEqual(f.effects, []);
    deepStrictEqual(f.tested, []);
    equal(f.publications, 0);
  });
}

Deno.test("a successful delegated decision can precede another grouped call and explicit reply", async () => {
  const command: ChatDecision = {
    kind: "decide_operator_change",
    text: "Approve",
    operatorId: "peer",
    changeId: "change-1",
    expectedRevision: 1,
    policyId: "grant",
    policyRevision: 1,
    verdict: "approve",
  };
  const f = fixture({
    steps: [batch(command, consult("after-decision")), batch(reply)],
  });
  await f.service.initialize();
  let decisions = 0;
  f.service.bindOperatorAuthorityLifecycle({
    decide: () => {
      decisions++;
      return Promise.resolve();
    },
    proposed: () => Promise.resolve(),
    approved: () => Promise.resolve(),
    closed: () => Promise.resolve(),
  });
  await f.service.submit("Decide then inspect", undefined, undefined, true);
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  equal(decisions, 1);
  const calls = f.service.snapshot.conversationBatches![0].calls;
  equal(calls[0].result?.status, "succeeded");
  equal(calls[0].result?.code, "DELEGATED_DECISION_RECORDED");
  equal(calls[1].result?.status, "succeeded");
  equal(f.contexts[1].toolCallHistory![0].results.length, 2);
  equal(
    f.service.snapshot.messages.some((message) =>
      message.role === "assistant" && message.text === reply.text
    ),
    true,
  );
});

for (const inputKind of ["human", "host-resume"] as const) {
  Deno.test(`Claude wire ${inputKind} appends fresh input after delivered replies and preserves native observations once`, async () => {
    type WireBody = {
      messages: Array<
        { role: string; content: Array<Record<string, unknown>> }
      >;
    };
    const observed: WireBody[] = [];
    const reads = ["first", "second"].map((elementId) => ({
      type: "tool_use",
      id: `inspect-${elementId}`,
      name: "consult_model",
      input: {
        text: `Inspect ${elementId}`,
        inputJson: JSON.stringify({
          operation: "inspect",
          version: sourceVersion,
          elementId,
        }),
      },
    }));
    const ongoing = [
      {
        type: "thinking",
        thinking: "",
        signature: "signed-exact-inspection+/=",
      },
      { type: "redacted_thinking", data: "opaque-exact-inspection" },
      ...reads,
    ];
    const response = (id: string, text: string) => [{
      type: "tool_use",
      id,
      name: "reply",
      input: { text },
    }];
    const script = [
      response("prior-delivered-final", "Prior contribution complete"),
      ongoing,
      response("fresh-delivered-final", "Fresh inspection complete"),
    ];
    const agent = new ClaudeAgents({
      apiKey: "fixture",
      model: "fixture",
      effort: "low",
      fetch: ((_url, init) => {
        observed.push(JSON.parse(String(init?.body)));
        const content = script.shift();
        ok(content, "Every transport request must match the bounded script");
        return Promise.resolve(
          Response.json({ stop_reason: "tool_use", content }),
        );
      }) as typeof fetch,
    });
    const f = fixture({
      agents: agent,
      consult: (input) =>
        Promise.resolve({
          elementId: input.elementId,
          observed: "exact source",
        }),
    });
    await f.service.initialize();
    let caseId: string;
    const origin = {
      openedBy: "main",
      openedFrom: {
        conversationId: "main-conversation",
        designerScopeId: "main-design",
      },
    };
    if (inputKind === "host-resume") {
      caseId = await f.service.openOperatorRequest({
        ...origin,
        changeId: "wire-opening",
        caseTypeId: caseTypesForModel(f.model)[0].id,
        objective: "First owner contribution",
      });
      await f.service.idle();
    } else {
      const submitted = await f.service.submit(
        "First human contribution",
        undefined,
        undefined,
        true,
      );
      ok(submitted);
      caseId = submitted;
      await f.service.idle();
    }
    equal(f.service.snapshot.error, undefined);
    const delivered = structuredClone(
      f.service.snapshot.conversationBatches![0],
    );
    equal(delivered.calls.at(-1)!.result?.code, "REPLY_RECORDED");
    const freshInput = inputKind === "human"
      ? "Fresh human instruction"
      : "Fresh host continuation instruction";
    if (inputKind === "host-resume") {
      await f.service.resumeRequest({
        caseId,
        resumeId: "wire-resume",
        instruction: freshInput,
        openedBy: origin.openedBy,
        conversationId: origin.openedFrom.conversationId,
        designerScopeId: origin.openedFrom.designerScopeId,
      });
      await f.service.idle();
    } else {
      await f.service.submit(freshInput, undefined, caseId);
      await f.service.idle();
    }
    equal(f.service.snapshot.error, undefined);
    equal(observed.length, 3);
    equal(script.length, 0);
    const withoutMarkers = (value: unknown) =>
      JSON.parse(
        JSON.stringify(value, (key, member) =>
          key === "cache_control" ? undefined : member),
      );
    const freshBrief = observed[1].messages.at(-1)!;
    const payload = JSON.parse(freshBrief.content.at(-1)!.text as string);
    equal(payload.context.input.text, freshInput);
    equal(payload.context.messages, undefined);
    deepStrictEqual(
      withoutMarkers(
        observed[1].messages.slice(0, observed[0].messages.length),
      ),
      withoutMarkers(observed[0].messages),
      "A fresh input appends after the preceding complete contribution",
    );
    deepStrictEqual(
      withoutMarkers(
        observed[2].messages.slice(0, observed[1].messages.length),
      ),
      withoutMarkers(observed[1].messages),
      "The next decision keeps every prior input and native exchange unchanged",
    );
    equal(JSON.stringify(observed[2]).includes("prior-delivered-final"), true);
    deepStrictEqual(observed[2].messages.at(-2), {
      role: "assistant",
      content: ongoing,
    });
    const exact = f.service.snapshot.conversationBatches![1];
    const results = observed[2].messages.at(-1)!.content;
    deepStrictEqual(
      results.map((result) => result.tool_use_id),
      exact.calls.map((call) => call.id),
    );
    for (const [index, result] of results.entries()) {
      const data = JSON.parse(result.content as string);
      deepStrictEqual(data.value, exact.calls[index].result!.value);
      equal(
        data.details,
        undefined,
        "An observation must not repeat as escaped details",
      );
    }
    equal(
      JSON.stringify(observed[2].messages).split("exact source").length - 1,
      2,
    );
    deepStrictEqual(
      f.service.snapshot.conversationBatches![0],
      delivered,
      "Prompt replay selection must not modify the delivered journal",
    );
  });
}

Deno.test("a registered unpublished immutable group blocks completing its Case", async () => {
  const store = new MemoryStore();
  const f = fixture({
    store,
    steps: [batch(consult("first"), consult("second"), reply)],
  });
  await f.service.initialize();
  let failedPublication = false;
  store.fail = (state) => {
    if (
      !failedPublication &&
      state.conversationBatches?.some((entry) =>
        entry.immutableGroup?.publication
      )
    ) {
      failedPublication = true;
      return true;
    }
    return false;
  };
  const caseId = await f.service.submit(
    "Inspect before closure",
    undefined,
    undefined,
    true,
  );
  await interruptedIdle(f);
  ok(
    failedPublication,
    "the group must reach canonical publication after registration",
  );
  ok(
    !f.service.snapshot.conversationBatches?.[0]?.immutableGroup,
    "no unpublished canonical group reference was manufactured",
  );
  deepStrictEqual(f.effects.toSorted(), ["read:first", "read:second"]);
  await import("node:assert/strict").then(({ rejects }) =>
    rejects(
      () => f.service.closeCase(caseId!, "done", ACCEPTED_CASE_CLOSURE),
      /awaits publication/,
    )
  );
  ok(
    !f.service.snapshot.cases?.find((item) => item.id === caseId)?.status
      .startsWith("closed-"),
  );
});

Deno.test("a budget-resumed batch preserves its queued reply after its own exact catalog publication", async () => {
  let ledger: WorkBudgetRecord | null = null;
  const workBudget = new WorkBudgetService({
    load: () => Promise.resolve(structuredClone(ledger)),
    save(record) {
      ledger = structuredClone(record);
      return Promise.resolve();
    },
  });
  const f = fixture({
    autoAdmission: true,
    workBudget,
    budgetLimit: 2,
    steps: [
      batch(propose("retained-reader-a"), propose("retained-reader-b"), reply),
    ],
  });
  await f.service.initialize();
  const caseId = await f.service.submit(
    "Prepare both and retain this reply",
    undefined,
    undefined,
    true,
  );
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  equal(f.service.snapshot.budgetSuspension?.reason, "exhausted");
  equal(f.providerRequests, 2);
  equal(f.publications, 1);
  equal(f.tested.length, 2);
  const proposalMessages = f.service.snapshot.messages.filter((message) =>
    message.role === "assistant" &&
    [propose("retained-reader-a").text, propose("retained-reader-b").text]
      .includes(message.text)
  );
  equal(proposalMessages.length, 2);
  const originalBatch = structuredClone(
    f.service.snapshot.conversationBatches![0],
  );
  const candidates = f.service.snapshot.candidates.map((candidate) =>
    candidate.id
  );
  const eventsBefore = structuredClone(ledger!.events);
  f.model.workBudgetPolicy!.revision = 2;
  f.model.workBudgetPolicy!.limit = 4;
  f.model.version.digest = "retained-batch-budget-v2";
  f.model.version.repositoryVersion = "commit:retained-batch-budget-v2";
  await f.service.adoptModelVersion({ expectedDigest: f.model.version.digest });
  equal(f.providerRequests, 2, "Adoption alone cannot decide or admit");
  await f.service.submit("Resume the exact retained calls", undefined, caseId);
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  equal(f.service.snapshot.budgetSuspension, undefined);
  equal(
    f.providerRequests,
    3,
    "The retained reply needs no new provider decision",
  );
  equal(f.publications, 2);
  deepStrictEqual(
    f.service.snapshot.messages.filter((message) =>
      message.role === "assistant" &&
      [propose("retained-reader-a").text, propose("retained-reader-b").text]
        .includes(message.text)
    ),
    proposalMessages,
  );
  equal(f.tested.length, 2);
  deepStrictEqual(
    f.service.snapshot.candidates.map((candidate) => candidate.id),
    candidates,
  );
  const completed = f.service.snapshot.conversationBatches!.find((batch) =>
    batch.id === originalBatch.id
  )!;
  equal(completed.modelDigest, originalBatch.modelDigest);
  deepStrictEqual(
    completed.calls.map((call) => call.id),
    originalBatch.calls.map((call) => call.id),
  );
  ok(completed.calls.every((call) => call.status === "completed"));
  equal(completed.calls.at(-1)!.decision.kind, "reply");
  deepStrictEqual(ledger!.events.slice(0, eventsBefore.length), eventsBefore);
});
