import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import {
  CompletionObserver,
  MAX_COMPLETION_METADATA_BYTES,
  MAX_COMPLETION_OBSERVATIONS,
} from "./completion-observer.ts";
import {
  type ProviderCallObservation,
  UNKNOWN_PROVIDER_CALL_CORRELATION,
} from "../../../application/telemetry/provider-call.ts";

const completion = { id: "msg-1", model: "sonnet", stopReason: "tool_use" };

Deno.test("canonical call replay preserves its preallocated identity and bytes through the same bounded observer", async () => {
  const seen: unknown[] = [];
  const observer = new CompletionObserver((metadata) =>
    void seen.push(metadata)
  );
  const call: ProviderCallObservation = {
    schemaVersion: 1,
    observationId: "a6609ebc-6218-4d71-a2ae-893b875b8482",
    provider: "anthropic",
    configuredModel: "sonnet",
    startedAt: "2026-10-29T00:00:00.000Z",
    endedAt: "2026-10-29T00:00:00.005Z",
    elapsedMs: 5,
    outcome: "failed",
    correlation: { ...UNKNOWN_PROVIDER_CALL_CORRELATION },
  };
  const expected = structuredClone(call);
  observer.publish({ ...call, rawError: "private exception" });
  observer.publish(call);
  await observer.close();
  deepStrictEqual(seen, [expected, expected]);
  equal(observer.status().written, 2);
  equal(JSON.stringify(seen).includes("private"), false);
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}

Deno.test("publication defers the sink and retains only an immutable bounded allowlist", async () => {
  const seen: unknown[] = [];
  const observer = new CompletionObserver((metadata) => {
    seen.push(metadata);
    ok(Object.isFrozen(metadata));
    ok(Object.isFrozen(metadata.usage));
    ok(Object.isFrozen(metadata.usage?.cache_creation));
  });
  const source = {
    ...completion,
    prompt: "private prompt",
    response: "private response",
    apiKey: "secret",
    usage: {
      input_tokens: 0,
      output_tokens: 9,
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation: {
        ephemeral_5m_input_tokens: 1,
        ephemeral_1h_input_tokens: 3,
        private: "secret",
      },
      server_tool_use: { web_search_requests: 2, private: "secret" },
      private: { prompt: "secret" },
    },
  };
  observer.publish(source);
  equal(seen.length, 0);
  source.usage.output_tokens = 999;
  source.usage.cache_creation.ephemeral_1h_input_tokens = 999;
  await observer.flush();
  deepStrictEqual(seen, [{
    ...completion,
    usage: {
      input_tokens: 0,
      output_tokens: 9,
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation: {
        ephemeral_5m_input_tokens: 1,
        ephemeral_1h_input_tokens: 3,
      },
      server_tool_use: { web_search_requests: 2 },
    },
  }]);
  ok(
    new TextEncoder().encode(JSON.stringify(seen[0])).length <=
      MAX_COMPLETION_METADATA_BYTES,
  );
  const snapshot = observer.status();
  snapshot.dropped.invalid = 999;
  snapshot.written = 999;
  equal(observer.status().dropped.invalid, 0);
  equal(observer.status().written, 1);
});

Deno.test("absent and unknown usage stays absent without invented zero units", async () => {
  const seen: unknown[] = [];
  const observer = new CompletionObserver((metadata) =>
    void seen.push(metadata)
  );
  observer.publish(completion);
  observer.publish({ ...completion, usage: { private: { input_tokens: 1 } } });
  await observer.flush();
  deepStrictEqual(seen, [completion, completion]);
});

Deno.test("invalid and oversize completions have fixed drop reasons without retaining errors", async () => {
  const seen: unknown[] = [];
  const observer = new CompletionObserver((metadata) =>
    void seen.push(metadata)
  );
  for (const value of [-1, NaN, Infinity, "1", null]) {
    observer.publish({ ...completion, usage: { input_tokens: value } });
  }
  observer.publish({
    ...completion,
    usage: { cache_creation: { ephemeral_5m_input_tokens: -1 } },
  });
  observer.publish({ ...completion, id: "invalid id" });
  observer.publish({ ...completion, stopReason: {} });
  observer.publish({ ...completion, model: "x".repeat(4096) });
  observer.publish({ ...completion, id: "x".repeat(4096) });
  const throwing = Object.defineProperty({}, "stopReason", {
    get() {
      throw new Error("private error");
    },
  });
  observer.publish(throwing);
  await observer.flush();
  equal(observer.status().received, 11);
  equal(observer.status().dropped.invalid, 9);
  equal(observer.status().dropped.oversize, 2);
  equal(observer.status().pending, 0);
  equal(seen.length, 0);
  equal(JSON.stringify(observer.status()).includes("private error"), false);
});

Deno.test("throws and rejections are counted and serial draining continues without unhandled rejection", async () => {
  let calls = 0;
  const observer = new CompletionObserver(() => {
    calls++;
    if (calls === 1) throw new Error("raw private error");
    if (calls === 2) return Promise.reject(new Error("raw rejection"));
  });
  observer.publish(completion);
  observer.publish(completion);
  observer.publish(completion);
  const result = await observer.close();
  equal(calls, 3);
  equal(result.timedOut, false);
  equal(result.status.received, 3);
  equal(result.status.written, 1);
  equal(result.status.dropped.sinkFailure, 2);
  equal(result.status.closed, true);
  equal(result.status.stalled, false);
  equal(result.unconfirmedPending, 0);
});

Deno.test("one blocked write retains at most 64 completions, drops new arrivals and resumes after settlement", async () => {
  const blocked = gate();
  let calls = 0;
  let active = 0;
  let peak = 0;
  const observer = new CompletionObserver(async () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await blocked.promise;
    active--;
  }, { stallMs: 1 });
  observer.publish(completion);
  await Promise.resolve();
  for (let i = 0; i < 70; i++) observer.publish(completion);
  const result = await observer.flush(5);
  equal(result.timedOut, true);
  equal(result.unconfirmedPending, MAX_COMPLETION_OBSERVATIONS);
  equal(result.status.inFlight, true);
  equal(result.status.stalled, true);
  equal(result.status.dropped.saturated, 7);
  equal(calls, 1);
  blocked.resolve();
  const drained = await observer.close();
  equal(peak, 1);
  equal(calls, MAX_COMPLETION_OBSERVATIONS);
  equal(drained.status.written, MAX_COMPLETION_OBSERVATIONS);
  equal(drained.status.pending, 0);
});

Deno.test("close deadline leaves unconfirmed writes explicit and late settlement never duplicates the drain", async () => {
  const blocked = gate();
  let calls = 0;
  const observer = new CompletionObserver(() => {
    calls++;
    return blocked.promise;
  }, { stallMs: 1 });
  observer.publish(completion);
  observer.publish(completion);
  const [first, second] = await Promise.all([
    observer.close(5),
    observer.close(5),
  ]);
  equal(first.timedOut, true);
  equal(second.unconfirmedPending, 2);
  equal(first.status.closed, true);
  equal(first.status.inFlight, true);
  observer.publish(completion);
  equal(observer.status().dropped.closed, 1);
  equal(calls, 1);
  blocked.resolve();
  const late = await observer.flush();
  equal(late.timedOut, false);
  equal(late.status.written, 2);
  equal(late.unconfirmedPending, 0);
  equal(calls, 2);
});

Deno.test("disabled observation is explicit and timing settings cannot remove the bound", async () => {
  const observer = new CompletionObserver();
  observer.publish(completion);
  equal(observer.status().enabled, false);
  equal(observer.status().coverage, "anthropic-physical-calls");
  equal(observer.status().dropped.disabled, 1);
  equal((await observer.close()).unconfirmedPending, 0);
  for (const duration of [0, -1, NaN, Infinity, 1001]) {
    throws(() => new CompletionObserver(undefined, { stallMs: duration }));
    await observer.flush(duration).then(
      () => {
        throw new Error("Invalid deadline was accepted");
      },
      () => {},
    );
  }
});

Deno.test("encoded metadata accepts exactly 4 KiB and drops the next byte", async () => {
  const seen: unknown[] = [];
  const observer = new CompletionObserver((metadata) =>
    void seen.push(metadata)
  );
  const overhead =
    new TextEncoder().encode(JSON.stringify({ ...completion, id: "" }))
      .byteLength;
  observer.publish({
    ...completion,
    id: "x".repeat(MAX_COMPLETION_METADATA_BYTES - overhead),
  });
  observer.publish({
    ...completion,
    id: "x".repeat(MAX_COMPLETION_METADATA_BYTES - overhead + 1),
  });
  await observer.close();
  equal(seen.length, 1);
  equal(
    new TextEncoder().encode(JSON.stringify(seen[0])).byteLength,
    MAX_COMPLETION_METADATA_BYTES,
  );
  equal(observer.status().dropped.oversize, 1);
});

Deno.test("every allowlisted token and request counter requires a nonnegative safe integer", async () => {
  const seen: unknown[] = [];
  const observer = new CompletionObserver((metadata) =>
    void seen.push(metadata)
  );
  const usages = [
    (value: number) => ({ input_tokens: value }),
    (value: number) => ({ output_tokens: value }),
    (value: number) => ({ cache_creation_input_tokens: value }),
    (value: number) => ({ cache_read_input_tokens: value }),
    (value: number) => ({
      cache_creation: { ephemeral_5m_input_tokens: value },
    }),
    (value: number) => ({
      cache_creation: { ephemeral_1h_input_tokens: value },
    }),
    (value: number) => ({ server_tool_use: { web_search_requests: value } }),
    (value: number) => ({ server_tool_use: { web_fetch_requests: value } }),
  ];
  for (const usage of usages) {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      observer.publish({ ...completion, usage: usage(value) });
    }
    observer.publish({ ...completion, usage: usage(0) });
    observer.publish({ ...completion, usage: usage(Number.MAX_SAFE_INTEGER) });
  }
  const result = await observer.close();
  equal(result.status.received, usages.length * 6);
  equal(result.status.dropped.invalid, usages.length * 4);
  equal(result.status.written, usages.length * 2);
  equal(result.unconfirmedPending, 0);
  deepStrictEqual(
    seen,
    usages.flatMap((usage) => [
      { ...completion, usage: usage(0) },
      { ...completion, usage: usage(Number.MAX_SAFE_INTEGER) },
    ]),
  );
});
