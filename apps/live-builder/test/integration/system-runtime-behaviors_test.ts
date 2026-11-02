// Promise-based fakes implement the actual service ports; the native interpreter runs.
// deno-lint-ignore-file require-await
import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { SystemRuntime } from "../support/system-runtime.ts";
import type { DecisionInformationPort } from "../../src/application/work/context/information-ports.ts";
import type { BehaviorInvocationPort } from "../../src/application/work/behaviors/invocation.ts";
import type {
  AgentPort,
  ModelPort,
  StorePort,
  ToolRunnerPort,
} from "../../src/application/work/runtime/ports.ts";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";
import type {
  BehaviorInvocationRequest,
  BehaviorInvocationResult,
} from "../../src/domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
} from "../../src/domain/model/execution/native-contracts.ts";
import type {
  ChatContext,
  ChatDecision,
  ModelIdentity,
  SystemRuntimeState,
} from "../../src/domain/work/dialogue.ts";
import { executableFixture } from "../support/execution-fixture.ts";

const identity: ModelIdentity = {
  projectId: "unit-echo",
  editingContextId: "unit-echo",
  rootId: "root",
  systemId: "system",
  catalogId: "catalog",
  builderId: "builder",
};
const behavior: NativeBehaviorContract = {
  id: "echo-access",
  name: "Echo",
  description: "Return the supplied message through a modeled action.",
  targetNativeId: "echo-flow",
  targetTypeId: "EchoCase",
  inputTypeId: "EchoInput",
  callerNativeId: identity.builderId,
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
  sourceIds: ["echo-access", "echo-flow", "EchoInput"],
};
const invocation: ChatDecision = {
  kind: "invoke_behavior",
  text: "Je transmets le message au comportement déclaré.",
  behaviorId: behavior.id,
  inputJson: '{"message":"Écho enregistré"}',
};
const reply: ChatDecision = { kind: "reply", text: "Résultat reçu." };
type Step = ChatDecision | ((context: ChatContext) => ChatDecision);
interface SetupOptions {
  information?: DecisionInformationPort;
  model?: (model: ExecutableModel) => void;
  choice?: ChatDecision;
  supports?: (
    count: number,
    model: ExecutableModel,
    behavior: NativeBehaviorContract,
  ) => boolean;
  result?: (
    request: BehaviorInvocationRequest,
  ) => BehaviorInvocationResult;
  next?: (context: ChatContext) => ChatDecision;
}
async function setup(options: SetupOptions = {}) {
  const current = executableFixture(identity);
  current.version.digest = "a".repeat(64);
  current.version.repositoryVersion = "commit:echo-v1";
  current.behaviors = [structuredClone(behavior)];
  const route = current.flows.conversation.edges.find((edge) =>
    edge.guard?.includes('"invoke_tool"')
  )!;
  ok(route, "The fixture must retain the actual native invocation branch");
  route.guard =
    '(chooseNextMove.choice.kind == "invoke_tool") or (chooseNextMove.choice.kind == "invoke_behavior")';
  options.model?.(current);
  let stored: SystemRuntimeState | null = null;
  const store: StorePort = {
    load: async () => structuredClone(stored),
    save: async (state, expected) => {
      equal(stored?.revision ?? null, expected);
      equal(state.revision, expected === null ? 0 : expected + 1);
      stored = structuredClone(state);
    },
    close: async () => {},
  };
  const contexts: ChatContext[] = [];
  const steps: Step[] = [
    options.choice ?? invocation,
    options.next ?? reply,
  ];
  const agents: AgentPort = {
    label: "Generic echo fixture",
    decide: async (context) => {
      contexts.push(structuredClone(context));
      const step = steps.shift();
      ok(step, "Unexpected extra agent decision");
      return structuredClone(typeof step === "function" ? step(context) : step);
    },
    review: async () => {
      throw new Error("No tool review belongs to this behavior call");
    },
  };
  const model: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize: async () => structuredClone(identity),
    readExecutableModel: async () => structuredClone(current),
    applyApprovedChange: async () => {
      throw new Error("Behavior invocation must not change the source model");
    },
    activateCandidate: async () => {
      throw new Error("A modeled behavior call must not promote a tool");
    },
    graph: async () => ({}),
  };
  const runner: ToolRunnerPort = {
    test: async () => {
      throw new Error("A native behavior must not enter the JS test runner");
    },
    run: async () => {
      throw new Error("A native behavior must not enter the URL runner");
    },
  };
  let supportsCount = 0;
  const invocations: BehaviorInvocationRequest[] = [];
  const port: BehaviorInvocationPort = {
    supports: async (contract) => {
      supportsCount++;
      return options.supports
        ? options.supports(supportsCount, current, contract)
        : true;
    },
    invoke: async (request) => {
      invocations.push(structuredClone(request));
      return options.result?.(request) ?? {
        behaviorId: request.behavior.id,
        invocationId: request.invocationId,
        targetNativeId: request.behavior.targetNativeId,
        modelVersion: request.modelVersion,
        result: { echo: request.input.message },
      };
    },
  };
  const service = new SystemRuntime({
    agents,
    model,
    store,
    runner,
    behaviors: port,
    ...(options.information ? { information: options.information } : {}),
  });
  await service.initialize();
  return { service, current, contexts, invocations };
}
async function turn(service: SystemRuntime) {
  await service.submit("Conserve ce message par le comportement déclaré.");
  await service.idle();
  equal(service.snapshot.busy, false);
}

function localMemoryPolicy(model: ExecutableModel): void {
  model.memoryPolicy = {
    kind: "governed-memory",
    pattern: "5.2",
    id: "local-memory-policy",
    revision: 1,
    elementId: "native-memory-policy",
    sourceIds: ["native-memory-policy"],
    ownerId: identity.builderId,
    allowedScopes: ["modeling"],
    requireSourceRefs: true,
    requireKnownOutcome: true,
    maxValidityMs: 86400000,
    allowSelfAdmission: false,
  };
}

Deno.test("native observations remain available to local memory without a context projection policy", async () => {
  let reads = 0;
  const fixture = await setup({
    model: localMemoryPolicy,
    information: {
      read(model) {
        reads++;
        equal(model.contextPolicy, undefined);
        equal(model.memoryPolicy!.ownerId, identity.builderId);
        return Promise.resolve({ memoryGuidance: [] });
      },
    },
    next(context) {
      equal(context.contextEvidence, undefined);
      deepStrictEqual(context.memoryGuidance, []);
      const feedback = context.messages.findLast((message) =>
        message.observation?.kind === "behavior-result"
      );
      ok(feedback);
      equal(feedback.role, "tool");
      equal(
        (feedback.observation!.value as BehaviorInvocationResult)
          .targetNativeId,
        behavior.targetNativeId,
      );
      return reply;
    },
  });
  await turn(fixture.service);
  equal(fixture.service.snapshot.error, undefined);
  equal(reads, 2);
  const stored = fixture.service.snapshot.messages.find((message) =>
    message.observation?.kind === "behavior-result"
  );
  ok(stored?.execution?.actionId);
  equal(fixture.invocations.length, 1);
});

Deno.test("an admitted memory policy fails before a provider call when its information reader is missing", async () => {
  const fixture = await setup({ model: localMemoryPolicy });
  await rejects(
    () => turn(fixture.service),
    /modèle d’information admis exige son lecteur local/,
  );
  equal(fixture.contexts.length, 0);
  equal(fixture.invocations.length, 0);
  ok(fixture.service.snapshot.error?.includes("lecteur local"));
});

Deno.test("a source-exposed Echo behavior executes through the native conversation and returns persisted feedback", async () => {
  const fixture = await setup({
    next(context) {
      const feedback = context.messages.find((message) =>
        message.role === "tool" && message.text.includes("Écho enregistré")
      );
      ok(feedback, "The next agent decision must receive the actual result");
      return { kind: "reply", text: "Écho enregistré reçu du comportement." };
    },
  });
  await turn(fixture.service);
  equal(fixture.invocations.length, 1);
  const call = fixture.invocations[0]!;
  deepStrictEqual(call.input, { message: "Écho enregistré" });
  equal(call.behavior.id, behavior.id);
  equal(call.behavior.targetNativeId, behavior.targetNativeId);
  equal(call.callerId, identity.builderId);
  equal(call.modelVersion.repositoryVersion, "commit:echo-v1");
  equal(call.modelVersion.digest, fixture.current.version.digest);
  ok(call.invocationId);
  deepStrictEqual(fixture.contexts[0]!.modeledBehaviors, [behavior]);
  const state = fixture.service.snapshot;
  equal(state.error, undefined);
  equal(state.candidates.length, 0);
  ok(
    state.events.some((event) =>
      event.kind === "behavior-called" &&
      event.elementId === behavior.targetNativeId
    ),
  );
  ok(state.events.some((event) => event.kind === "behavior-completed"));
  const feedback = state.messages.find((message) =>
    message.role === "tool" && message.text.includes('"echo":"Écho enregistré"')
  );
  ok(feedback);
  equal(feedback.execution?.repositoryVersion, "commit:echo-v1");
  equal(feedback.execution?.digest, fixture.current.version.digest);
});

Deno.test("the chat receives only source exposures for its caller with registered executors", async () => {
  const fixture = await setup({
    model(model) {
      model.behaviors!.push(
        {
          ...structuredClone(behavior),
          id: "other-caller",
          callerNativeId: "other",
        },
        {
          ...structuredClone(behavior),
          id: "unregistered",
          targetNativeId: "absent",
        },
      );
    },
    supports(_count, _model, contract) {
      return contract.targetNativeId !== "absent";
    },
  });
  await turn(fixture.service);
  deepStrictEqual(fixture.contexts[0]!.modeledBehaviors, [behavior]);
  equal(fixture.invocations.length, 1);
});

Deno.test("identical behavior result pins are accepted regardless of object property order", async () => {
  const fixture = await setup({
    result(request) {
      return {
        behaviorId: request.behavior.id,
        invocationId: request.invocationId,
        targetNativeId: request.behavior.targetNativeId,
        // Equivalent externally returned JSON need not preserve the caller's order.
        modelVersion: {
          repositoryVersion: request.modelVersion.repositoryVersion,
          digest: request.modelVersion.digest,
        },
        result: { echo: request.input.message },
      };
    },
  });
  await turn(fixture.service);
  equal(fixture.invocations.length, 1);
  ok(
    fixture.service.snapshot.events.some((event) =>
      event.kind === "behavior-completed"
    ),
  );
  ok(
    fixture.service.snapshot.messages.some((message) =>
      message.role === "tool" &&
      message.text.includes('"echo":"Écho enregistré"')
    ),
  );
});

Deno.test("absent, forged and unknown source behavior declarations never invoke the executor", async () => {
  for (const variant of ["absent", "caller", "unknown"] as const) {
    const fixture = await setup({
      model(model) {
        if (variant === "absent") delete model.behaviors;
        if (variant === "caller") {
          model.behaviors![0]!.callerNativeId = "someone-else";
        }
      },
      choice: variant === "unknown"
        ? { ...invocation, behaviorId: "agent-created-target" }
        : invocation,
    });
    await turn(fixture.service);
    equal(fixture.invocations.length, 0);
    const state = fixture.service.snapshot;
    ok(state.messages.some((message) =>
      message.role === "tool" &&
      message.text.includes("BEHAVIOR_NOT_AUTHORIZED")
    ));
    equal(
      state.events.some((event) => event.kind === "behavior-completed"),
      false,
    );
  }
});

Deno.test("malformed behavior JSON, extra fields and wrong native scalar types are refused before effects", async () => {
  for (
    const inputJson of [
      "{",
      "[]",
      '{"message":1}',
      '{"message":"x","grant":true}',
    ]
  ) {
    const fixture = await setup({ choice: { ...invocation, inputJson } });
    await turn(fixture.service);
    equal(fixture.invocations.length, 0);
    ok(
      fixture.service.snapshot.messages.some((message) =>
        message.role === "tool" &&
        message.text.includes("BEHAVIOR_INPUT_INVALID")
      ),
    );
  }
});

Deno.test("changing the native invocation guard blocks the call without changing the TypeScript dispatcher", async () => {
  const fixture = await setup({
    model(model) {
      model.flows.conversation.edges.find((edge) =>
        edge.guard?.includes('"invoke_behavior"')
      )!.guard = "false";
    },
  });
  await rejects(
    () => turn(fixture.service),
    /Choix non pris en charge par la soumission native : invoke_behavior/,
  );
  equal(fixture.invocations.length, 0);
  ok(fixture.service.snapshot.error);
  equal(
    fixture.service.snapshot.events.some((event) =>
      event.kind === "behavior-called"
    ),
    false,
  );
});

Deno.test("a changed source digest between native admission and effect prevents behavior invocation", async () => {
  const fixture = await setup({
    supports(count, model) {
      if (count === 2) {
        model.version.digest = "b".repeat(64);
        model.version.repositoryVersion = "commit:echo-v2";
      }
      return true;
    },
  });
  await rejects(() => turn(fixture.service), {
    code: "NATIVE_ADMISSION_REFUSED",
  });
  equal(fixture.invocations.length, 0);
  equal(
    fixture.service.snapshot.error,
    "The current native admission refused this action",
  );
  equal(
    fixture.service.snapshot.executionModel!.version.repositoryVersion,
    "commit:echo-v1",
  );
  equal(
    fixture.service.snapshot.executionModel!.version.digest,
    "a".repeat(64),
  );
  equal(
    fixture.service.snapshot.availableExecutionModel?.version.repositoryVersion,
    "commit:echo-v2",
  );
});

Deno.test("a result with a forged native identity is recorded as unconfirmed and never promoted to success", async () => {
  const fixture = await setup({
    result(request) {
      return {
        behaviorId: request.behavior.id,
        invocationId: request.invocationId,
        targetNativeId: "different-target",
        modelVersion: request.modelVersion,
        result: { invented: "MUST_NOT_BECOME_VERIFIED_FEEDBACK" },
      };
    },
  });
  await turn(fixture.service);
  equal(fixture.invocations.length, 1);
  const state = fixture.service.snapshot;
  equal(
    state.events.some((event) => event.kind === "behavior-completed"),
    false,
  );
  ok(state.events.some((event) => event.kind === "behavior-unconfirmed"));
  ok(state.messages.some((message) =>
    message.role === "tool" &&
    message.text.includes("BEHAVIOR_RESULT_UNCONFIRMED")
  ));
  equal(
    state.messages.some((message) =>
      message.role === "tool" &&
      message.text.includes("MUST_NOT_BECOME_VERIFIED_FEEDBACK")
    ),
    false,
  );
});
