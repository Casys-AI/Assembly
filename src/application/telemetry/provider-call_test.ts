import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import {
  normalizeProviderCallObservation,
  UNKNOWN_PROVIDER_CALL_CORRELATION,
} from "./provider-call.ts";

const call = () => ({
  schemaVersion: 1,
  observationId: "a6609ebc-6218-4d71-a2ae-893b875b8482",
  provider: "anthropic",
  configuredModel: "sonnet",
  startedAt: "2026-10-29T00:00:00.000Z",
  endedAt: "2026-10-29T00:00:00.005Z",
  elapsedMs: 5.25,
  outcome: "returned",
  correlation: { ...UNKNOWN_PROVIDER_CALL_CORRELATION },
});

Deno.test("physical observation copies its fixed immutable allowlist with unknown coverage explicit", () => {
  const normalized = normalizeProviderCallObservation({
    ...call(),
    prompt: "private",
    response: "private",
    error: "private",
    correlation: {
      ...UNKNOWN_PROVIDER_CALL_CORRELATION,
      executionScope: {
        projectId: "p",
        systemId: "s",
        executionSpaceId: "request-space",
        key: "private",
      },
      receipt: "private",
    },
    usage: {
      input_tokens: 0,
      output_tokens: 7,
      server_tool_use: { web_fetch_requests: 2, url: "private" },
    },
  });
  equal(normalized.correlation.caseId, null);
  equal(normalized.correlation.modelDigest, null);
  deepStrictEqual(normalized.correlation.executionScope, {
    projectId: "p",
    systemId: "s",
    executionSpaceId: "request-space",
  });
  equal(JSON.stringify(normalized).includes("private"), false);
  ok(Object.isFrozen(normalized));
  ok(Object.isFrozen(normalized.correlation));
  ok(Object.isFrozen(normalized.correlation.executionScope));
  ok(Object.isFrozen(normalized.usage?.server_tool_use));
  equal(normalizeProviderCallObservation(call()).usage, undefined);
});

Deno.test("physical observations refuse invalid identity timing correlation and unsafe units", () => {
  for (
    const change of [
      { observationId: "provider-message-id" },
      { startedAt: "today" },
      { endedAt: "2026-10-29" },
      { elapsedMs: NaN },
      { elapsedMs: -1 },
      { outcome: "business-success" },
      { correlation: {} },
      {
        correlation: {
          ...UNKNOWN_PROVIDER_CALL_CORRELATION,
          executionScope: { projectId: "p", systemId: "s" },
        },
      },
      { usage: { input_tokens: 0.25 } },
      { usage: { output_tokens: Number.MAX_SAFE_INTEGER + 1 } },
      { usage: { server_tool_use: { web_fetch_requests: -1 } } },
      { model: "https://private.invalid" },
    ]
  ) {
    throws(
      () => normalizeProviderCallObservation({ ...call(), ...change }),
      /Invalid provider call observation/,
    );
  }
});

Deno.test("wall clock adjustment cannot invalidate the separately measured monotonic duration", () => {
  const result = normalizeProviderCallObservation({
    ...call(),
    endedAt: "2026-10-28T23:59:59.000Z",
    elapsedMs: 12,
    outcome: "timed-out",
  });
  equal(result.elapsedMs, 12);
  equal(result.usage, undefined);
});
