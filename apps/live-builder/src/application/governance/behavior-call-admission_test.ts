// Async fakes implement the modeled executor interface.
// deno-lint-ignore-file require-await
import {
  deepStrictEqual,
  equal,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import {
  admitBehaviorCall,
  availableBehaviors,
  behaviorVersion,
} from "../../../test/support/behavior-call-admission.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../work/behaviors/invocation.ts";
import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";
import type {
  BehaviorInvocationRequest,
} from "../../domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
} from "../../domain/model/execution/native-contracts.ts";
import { executableFixture } from "../../../test/support/execution-fixture.ts";

const contract: NativeBehaviorContract = {
  id: "echo-access",
  name: "Echo",
  description: "Return the supplied facts.",
  targetNativeId: "echo-flow",
  targetTypeId: "echo-definition",
  inputTypeId: "echo-input",
  callerNativeId: "builder",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
  sourceIds: ["echo-access", "echo-flow", "echo-input"],
};
function fixture() {
  const model = executableFixture({
    projectId: "unit",
    editingContextId: "unit",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "builder",
  });
  model.version.digest = "a".repeat(64);
  model.version.repositoryVersion = "commit:echo-model";
  model.behaviors = [structuredClone(contract)];
  return model;
}
function provider(
  supports: BehaviorInvocationPort["supports"] = async () => true,
) {
  const calls: BehaviorInvocationRequest[] = [];
  const port: BehaviorInvocationPort = {
    supports,
    invoke: async (request) => {
      calls.push(structuredClone(request));
      return {
        behaviorId: request.behavior.id,
        invocationId: request.invocationId,
        targetNativeId: request.behavior.targetNativeId,
        modelVersion: request.modelVersion,
        result: { echo: request.input },
      };
    },
  };
  return { port, calls };
}
const choice = {
  behaviorId: contract.id,
  inputJson: '{"message":"Écho"}',
};

Deno.test("behavior availability requires the current native caller and a registered executor", async () => {
  const model = fixture();
  model.behaviors!.push(
    {
      ...structuredClone(contract),
      id: "other-agent",
      callerNativeId: "other",
    },
    {
      ...structuredClone(contract),
      id: "unregistered",
      targetNativeId: "absent",
    },
  );
  const { port } = provider(async (behavior) =>
    behavior.targetNativeId === contract.targetNativeId
  );
  const available = await availableBehaviors(model, port);
  deepStrictEqual(available, [contract]);
  available[0]!.description = "Modified consumer copy";
  equal(model.behaviors![0]!.description, contract.description);
  deepStrictEqual(await availableBehaviors(model), []);
  delete model.version.repositoryVersion;
  deepStrictEqual(await availableBehaviors(model, port), []);
  throws(() => behaviorVersion(model), /immutable/);
});

Deno.test("behavior admission refuses absent, unknown, duplicate or wrong-caller source authority", async () => {
  const { port, calls } = provider();
  const variants: ExecutableModel[] = [];
  const absent = fixture();
  delete absent.behaviors;
  variants.push(absent);
  const wrongCaller = fixture();
  wrongCaller.behaviors![0]!.callerNativeId = "forged-caller";
  variants.push(wrongCaller);
  const duplicate = fixture();
  duplicate.behaviors!.push(structuredClone(contract));
  variants.push(duplicate);
  for (const model of variants) {
    const admission = await admitBehaviorCall(choice, model, port);
    equal(admission.admitted, false);
    equal(admission.failure?.code, "BEHAVIOR_NOT_AUTHORIZED");
  }
  const unknown = await admitBehaviorCall(
    { ...choice, behaviorId: "agent-invented-target" },
    fixture(),
    port,
  );
  equal(unknown.failure?.code, "BEHAVIOR_NOT_AUTHORIZED");
  equal(calls.length, 0);
});

Deno.test("behavior admission refuses unsupported executors and unpinned execution versions", async () => {
  const model = fixture();
  equal(
    (await admitBehaviorCall(choice, model)).failure?.code,
    "BEHAVIOR_UNAVAILABLE",
  );
  const { port } = provider(async () => false);
  equal(
    (await admitBehaviorCall(choice, model, port)).failure?.code,
    "BEHAVIOR_UNAVAILABLE",
  );
  delete model.version.repositoryVersion;
  equal(
    (await admitBehaviorCall(choice, model, provider().port)).failure?.code,
    "BEHAVIOR_UNAVAILABLE",
  );
});

Deno.test("native behavior inputs reject malformed JSON, type coercion and undeclared keys", async () => {
  const { port, calls } = provider();
  for (
    const inputJson of [
      "{",
      "null",
      "[]",
      '"text"',
      "{}",
      '{"message":42}',
      '{"message":"Écho","granted":true}',
      '{"message":"Écho","__proto__":{"granted":true}}',
      "x".repeat(65_537),
    ]
  ) {
    const admission = await admitBehaviorCall(
      { ...choice, inputJson },
      fixture(),
      port,
    );
    equal(admission.admitted, false, inputJson.slice(0, 100));
    equal(admission.failure?.code, "BEHAVIOR_INPUT_INVALID");
  }
  equal(calls.length, 0);
});

Deno.test("behavior inputJson bound counts code points, not UTF-16 units", async () => {
  const { port } = provider();
  const skeleton = JSON.stringify({ message: "" });
  const atBound = JSON.stringify({
    message: "😀".repeat(65_536 - skeleton.length),
  });
  const admitted = await admitBehaviorCall(
    { ...choice, inputJson: atBound },
    fixture(),
    port,
  );
  equal(admitted.admitted, true);
  const overBound = JSON.stringify({
    message: "😀".repeat(65_536 - skeleton.length + 1),
  });
  const refused = await admitBehaviorCall(
    { ...choice, inputJson: overBound },
    fixture(),
    port,
  );
  equal(refused.admitted, false);
  equal(refused.failure?.code, "BEHAVIOR_INPUT_INVALID");
});

Deno.test("native input schemas supply representation constraints without a host positivity rule", async () => {
  const model = fixture();
  model.behaviors![0]!.inputSchema = {
    type: "object",
    properties: { measure: { type: "integer" } },
    required: ["measure"],
    additionalProperties: false,
  };
  const { port, calls } = provider();
  const negative = await admitBehaviorCall(
    { behaviorId: contract.id, inputJson: '{"measure":-17}' },
    model,
    port,
    "invocation-exact",
  );
  equal(negative.admitted, true);
  deepStrictEqual(negative.input, { measure: -17 });
  equal(negative.invocationId, "invocation-exact");
  deepStrictEqual(negative.modelVersion, behaviorVersion(model));
  ok(/^[a-f0-9]{64}$/.test(negative.inputDigest!));
  const wrongType = await admitBehaviorCall(
    { behaviorId: contract.id, inputJson: '{"measure":"-17"}' },
    model,
    port,
  );
  equal(wrongType.admitted, false);
  equal(calls.length, 0, "Admission validates; it never executes an effect");
});

Deno.test("ambiguous behavior executor registration cannot turn source permission into two calls", async () => {
  const first = provider(), second = provider();
  const registry = new BehaviorInvocationRegistry([first.port, second.port]);
  const model = fixture();
  equal(await registry.supports(contract, behaviorVersion(model)), false);
  const request: BehaviorInvocationRequest = {
    behavior: contract,
    input: { message: "Écho" },
    callerId: "builder",
    invocationId: "exact-call",
    modelVersion: behaviorVersion(model),
  };
  await rejects(() => registry.invoke(request), /no unique registered/);
  equal(first.calls.length, 0);
  equal(second.calls.length, 0);
});
