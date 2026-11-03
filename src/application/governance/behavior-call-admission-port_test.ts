import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { executableFixture } from "../../../test/support/execution-fixture.ts";
import { admitBehaviorCall } from "./behavior-call-admission.ts";
import type { SchemaValidationPort } from "../work/behaviors/schema-validation.ts";
import type { BehaviorInvocationPort } from "../work/behaviors/invocation.ts";

function fixture() {
  const model = executableFixture({
    projectId: "unit",
    editingContextId: "unit",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "builder",
  });
  model.version.repositoryVersion = "commit:exact";
  model.behaviors = [{
    id: "echo",
    name: "Echo",
    description: "Return input",
    callerNativeId: "builder",
    targetNativeId: "echo-flow",
    targetTypeId: "echo-type",
    inputTypeId: "echo-input",
    inputSchema: { type: "object" },
    sourceIds: ["echo"],
  }];
  return model;
}

const executor: BehaviorInvocationPort = {
  supports: () => Promise.resolve(true),
  invoke: () => Promise.reject(new Error("Admission must not invoke")),
};

Deno.test("behavior admission delegates the exact contract and bounds validator diagnostics", async () => {
  const model = fixture();
  const errors = "É".repeat(850);
  const validator: SchemaValidationPort = {
    validate(schema, value) {
      equal(schema, model.behaviors![0]!.inputSchema);
      deepStrictEqual(value, { message: "Écho" });
      return { valid: false, errors };
    },
  };
  const admission = await admitBehaviorCall(
    { behaviorId: "echo", inputJson: '{"message":"Écho"}' },
    model,
    validator,
    executor,
    "exact-call",
  );
  deepStrictEqual(admission, {
    kind: "behavior",
    admitted: false,
    behaviorId: "echo",
    invocationId: "exact-call",
    failure: {
      code: "BEHAVIOR_INPUT_INVALID",
      message: "Paramètres non conformes au contrat SysML : " +
        errors.slice(0, 800),
    },
  });
});

Deno.test("behavior admission keeps authority and parsing ahead of technical validation", async () => {
  const model = fixture();
  const failure = new Error("Exact schema compilation failure");
  let calls = 0;
  const validator: SchemaValidationPort = {
    validate() {
      calls++;
      throw failure;
    },
  };
  equal(
    (await admitBehaviorCall(
      { behaviorId: "unknown", inputJson: "{}" },
      model,
      validator,
      executor,
    )).failure?.code,
    "BEHAVIOR_NOT_AUTHORIZED",
  );
  equal(
    (await admitBehaviorCall(
      { behaviorId: "echo", inputJson: "{}" },
      model,
      validator,
    )).failure?.code,
    "BEHAVIOR_UNAVAILABLE",
  );
  for (const inputJson of ["{", "null", "[]", "x".repeat(65_537)]) {
    equal(
      (await admitBehaviorCall(
        { behaviorId: "echo", inputJson },
        model,
        validator,
        executor,
      )).failure?.code,
      "BEHAVIOR_INPUT_INVALID",
    );
  }
  equal(calls, 0);
  await rejects(
    () =>
      admitBehaviorCall(
        { behaviorId: "echo", inputJson: "{}" },
        model,
        validator,
        executor,
      ),
    (error) => error === failure,
  );
  equal(calls, 1);
});
