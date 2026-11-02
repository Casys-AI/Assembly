import { equal, rejects } from "node:assert/strict";
import type {
  BehaviorInvocationRequest,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
} from "../../../domain/model/execution/native-contracts.ts";
import type { BehaviorModelVersion } from "../../../domain/shared-kernel/behavior-model-version.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
  matchesNativeInputSchema,
  pinnedResolution,
} from "./invocation.ts";

const behavior: NativeBehaviorContract = {
  id: "behavior",
  name: "Behavior",
  description: "Probe",
  targetNativeId: "target",
  targetTypeId: "type",
  inputTypeId: "input",
  callerNativeId: "caller",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  sourceIds: ["source"],
};
const version: BehaviorModelVersion = {
  digest: "digest",
  repositoryVersion: "commit:one",
};
const request: BehaviorInvocationRequest = {
  behavior,
  input: {},
  callerId: "caller",
  invocationId: "invocation",
  modelVersion: version,
};

class ToolkitFailure extends Error {
  readonly code = "TOOLKIT_TIMEOUT";
}

Deno.test("a provider infrastructure failure crosses the registry with its code, never as no unique executor", async () => {
  const failure = new ToolkitFailure("toolkit exploded");
  const failing: BehaviorInvocationPort = {
    supports: () => Promise.reject(failure),
    invoke: () => Promise.reject(new Error("must not be invoked")),
  };
  const registry = new BehaviorInvocationRegistry([failing]);
  await rejects(
    () => registry.supports(behavior, version),
    (error: unknown) =>
      error === failure && (error as ToolkitFailure).code === "TOOLKIT_TIMEOUT",
  );
  await rejects(
    () => registry.invoke(request),
    (error: unknown) => error === failure,
  );
});

Deno.test("only not supported is false: an unsupported provider still yields no unique executor on invoke", async () => {
  const unsupported: BehaviorInvocationPort = {
    supports: () => Promise.resolve(false),
    invoke: () => Promise.reject(new Error("must not be invoked")),
  };
  const registry = new BehaviorInvocationRegistry([unsupported]);
  equal(await registry.supports(behavior, version), false);
  await rejects(
    () => registry.invoke(request),
    /no unique registered executor/,
  );
});

Deno.test("pinned resolution caches only successes: a rejection is evicted and rethrown, then the same key can succeed", async () => {
  const pins = new Map<string, Promise<string | null>>();
  const failure = new Error("toolkit timeout");
  let calls = 0;
  const load = () => {
    calls++;
    return calls === 1 ? Promise.reject(failure) : Promise.resolve("model");
  };
  await rejects(
    () => pinnedResolution(pins, "same-key", load),
    (error: unknown) => error === failure,
  );
  equal(pins.has("same-key"), false);
  equal(await pinnedResolution(pins, "same-key", load), "model");
  equal(calls, 2);
  equal(await pinnedResolution(pins, "same-key", load), "model");
  equal(calls, 2);
});

Deno.test("pinned resolution keeps a resolved null (digest differs) as a cached success", async () => {
  const pins = new Map<string, Promise<string | null>>();
  let calls = 0;
  const load = () => {
    calls++;
    return Promise.resolve(null);
  };
  equal(await pinnedResolution(pins, "digest-key", load), null);
  equal(await pinnedResolution(pins, "digest-key", load), null);
  equal(calls, 1);
});

Deno.test("the shared native input-schema match requires the exact flat contract", () => {
  const fields = { id: "string", count: "integer" };
  equal(
    matchesNativeInputSchema({
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" }, count: { type: "integer" } },
      required: ["id", "count"],
    }, fields),
    true,
  );
  equal(
    matchesNativeInputSchema({
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      required: ["id"],
    }, fields),
    false,
  );
  equal(
    matchesNativeInputSchema({
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" }, count: { type: "string" } },
      required: ["id", "count"],
    }, fields),
    false,
  );
  equal(
    matchesNativeInputSchema(
      {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" }, note: { type: "string" } },
        required: ["id"],
      },
      { id: "string", note: "string" },
      ["note"],
    ),
    true,
  );
});
