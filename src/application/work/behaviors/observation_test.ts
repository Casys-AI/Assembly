import { equal, rejects, throws } from "node:assert/strict";
import {
  type ObservationInvocationPort,
  ObservationInvocationRegistry,
  readOnlyObservation,
} from "./observation.ts";
import type { NativeBehaviorContract } from "../../../domain/model/execution/native-contracts.ts";
const behavior: NativeBehaviorContract = {
  id: "read",
  name: "read",
  description: "",
  callerNativeId: "caller",
  targetNativeId: "record",
  targetTypeId: "read",
  inputTypeId: "query",
  inputSchema: {},
  sourceIds: [],
};
const version = { digest: "d", repositoryVersion: "v" };
Deno.test("observation registry refuses a general effect executor", () => {
  throws(() =>
    new ObservationInvocationRegistry([
      {
        supports: () => Promise.resolve(true),
        invoke: () => Promise.reject(new Error("effect")),
      } as unknown as ObservationInvocationPort,
    ])
  );
});
Deno.test("trusted observation registry requires a unique admitted reader", async () => {
  const reader: ObservationInvocationPort = {
    [readOnlyObservation]: true,
    supports: () => Promise.resolve(true),
    invoke: (request) =>
      Promise.resolve({
        behaviorId: request.behavior.id,
        invocationId: request.invocationId,
        targetNativeId: request.behavior.targetNativeId,
        modelVersion: request.modelVersion,
        result: { values: { amount: 12 } },
      }),
  };
  const registry = new ObservationInvocationRegistry([reader]);
  equal(await registry.supports(behavior, version), true);
  equal(
    (await registry.invoke({
      behavior,
      modelVersion: version,
      callerId: "caller",
      invocationId: "read:1",
      input: {},
    })).invocationId,
    "read:1",
  );
  const ambiguous = new ObservationInvocationRegistry([reader, reader]);
  equal(await ambiguous.supports(behavior, version), false);
  await rejects(() =>
    ambiguous.invoke({
      behavior,
      modelVersion: version,
      callerId: "caller",
      invocationId: "read:1",
      input: {},
    })
  );
});
