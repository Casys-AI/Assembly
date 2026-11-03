import assert from "node:assert/strict";
import { UNKNOWN_PROVIDER_CALL_CORRELATION } from "../../../application/telemetry/provider-call.ts";
import {
  decodeProviderCall,
  encodeProviderCall,
} from "./provider-call-codec.ts";

const host = { projectId: "project", systemId: "system" };
const observation = {
  schemaVersion: 1 as const,
  observationId: "9f109fd4-fecb-4994-a2e4-3be47f07c931",
  provider: "anthropic" as const,
  configuredModel: "model",
  startedAt: "2026-10-29T00:00:00.000Z",
  endedAt: "2026-10-29T00:00:01.000Z",
  elapsedMs: 1000,
  outcome: "returned" as const,
  correlation: UNKNOWN_PROVIDER_CALL_CORRELATION,
  usage: { input_tokens: 7 },
};

Deno.test("provider call codec strips unknown fields and verifies canonical scope and identity", () => {
  const payload = encodeProviderCall(host, {
    ...observation,
    prompt: "private",
  });
  assert.equal(payload.includes("private"), false);
  assert.deepEqual(
    decodeProviderCall(
      { ...host, executionSpaceId: null },
      observation.observationId,
      payload,
    ),
    observation,
  );
  assert.throws(() =>
    decodeProviderCall(
      { ...host, executionSpaceId: "main" },
      observation.observationId,
      payload,
    )
  );
  assert.throws(() =>
    decodeProviderCall({ ...host, executionSpaceId: null }, "other", payload)
  );
  assert.throws(() =>
    decodeProviderCall(
      { ...host, executionSpaceId: null },
      observation.observationId,
      JSON.stringify(observation),
    )
  );
  assert.throws(() =>
    encodeProviderCall(host, {
      ...observation,
      correlation: {
        ...observation.correlation,
        executionScope: {
          ...host,
          systemId: "foreign",
          executionSpaceId: "main",
        },
      },
    })
  );
  assert.throws(() =>
    encodeProviderCall(host, { ...observation, usage: { input_tokens: -1 } })
  );
});
