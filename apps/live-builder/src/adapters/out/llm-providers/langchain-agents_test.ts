import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import { createClaudeToolsFake } from "../../../../test/support/claude-tools-fake.ts";
import type { ChatContext } from "../../../domain/work/dialogue.ts";
import {
  normalizeProviderCallObservation,
  type ProviderCallObservation,
  UNKNOWN_PROVIDER_CALL_CORRELATION,
} from "../../../application/telemetry/provider-call.ts";
import {
  LangChainAgents,
  MAX_PROVIDER_RESPONSE_BYTES,
} from "./langchain-agents.ts";
import { providerCallContext } from "./provider-call-context.ts";

const context: ChatContext = { messages: [], activeTools: [], candidates: [] };

function metadataPayload(value: unknown) {
  const call = normalizeProviderCallObservation(value);
  equal(call.provider, "anthropic");
  equal(call.outcome, "returned");
  deepStrictEqual(call.correlation, UNKNOWN_PROVIDER_CALL_CORRELATION);
  const { id, model, stopReason, usage } = call;
  return {
    ...(id !== undefined ? { id } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

Deno.test("LangChain SDK owns provider encoding while preserving cached authority prompts and usage", async () => {
  const completions: unknown[] = [];
  const fake = createClaudeToolsFake(() => ({
    decision: { kind: "reply", text: "Recorded" },
    id: "sdk-message",
    model: "configured-sonnet",
    usage: {
      input_tokens: 17,
      output_tokens: 8,
      cache_creation_input_tokens: 21,
      cache_read_input_tokens: 34,
    },
  }));
  const agent = new LangChainAgents({
    apiKey: "fixture-key",
    model: "configured-sonnet",
    effort: "medium",
    decisionMaxTokens: 6000,
    fetch: fake.fetch,
    onCompletion: (metadata) => {
      completions.push(metadata);
    },
  });
  deepStrictEqual(await agent.decide(context), {
    kind: "reply",
    text: "Recorded",
  });
  const view = fake.views[0]!;
  equal(view.body.model, "configured-sonnet");
  equal(view.body.max_tokens, 6000);
  equal(view.body.output_config.effort, "medium");
  deepStrictEqual(view.body.tool_choice, {
    type: "auto",
    disable_parallel_tool_use: true,
  });
  ok(Object.keys(view.headers).some((name) => name.startsWith("x-stainless-")));
  equal(view.headers["x-api-key"], "fixture-key");
  equal(view.headers.authorization, undefined);
  equal(view.headers["anthropic-version"], "2023-06-01");
  equal(view.url, "https://api.anthropic.com/v1/messages");
  equal(view.body.temperature, undefined);
  equal(view.body.stream, false);
  deepStrictEqual(view.body.system.at(-1)?.cache_control, {
    type: "ephemeral",
  });
  deepStrictEqual(view.body.tools.at(-1)?.cache_control, { type: "ephemeral" });
  equal(view.body.tools.some((tool) => "strict" in tool), false);
  equal(view.systemText.includes("fixture-key"), false);
  match(view.systemText, /mandat|mandate/);
  await agent.completionObservation.flush();
  deepStrictEqual(completions.map(metadataPayload), [{
    id: "sdk-message",
    model: "configured-sonnet",
    stopReason: "tool_use",
    usage: {
      input_tokens: 17,
      output_tokens: 8,
      cache_creation_input_tokens: 21,
      cache_read_input_tokens: 34,
    },
  }]);
});

Deno.test("SDK replay preserves signed assistant blocks and exact successful and failed tool correlations", async () => {
  const blocks = [
    {
      type: "thinking",
      thinking: "Prior bounded reasoning",
      signature: "exact-signed-block",
    },
    {
      type: "tool_use",
      id: "call-a",
      name: "consult_model",
      input: { text: "Inspect", inputJson: "{}" },
    },
    {
      type: "tool_use",
      id: "call-b",
      name: "invoke_tool",
      input: {
        text: "Read",
        toolId: "reader",
        input: { url: "https://example.com" },
      },
    },
  ];
  const fake = createClaudeToolsFake(() => ({
    decision: { kind: "reply", text: "Observed" },
  }));
  await new LangChainAgents({
    apiKey: "fixture",
    model: "configured-sonnet",
    fetch: fake.fetch,
  }).decide({
    ...context,
    toolCallHistory: [{
      assistantBlocks: blocks,
      results: [
        { id: "call-a", result: '{"found":true}' },
        { id: "call-b", result: "NETWORK_SCOPE_DENIED", isError: true },
      ],
    }],
  });
  deepStrictEqual(fake.requests[0]!.messages[1], {
    role: "assistant",
    content: blocks,
  });
  deepStrictEqual(fake.requests[0]!.messages[2], {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "call-a", content: '{"found":true}' },
      {
        type: "tool_result",
        tool_use_id: "call-b",
        is_error: true,
        content: "NETWORK_SCOPE_DENIED",
      },
    ],
  });
});

Deno.test("SDK scalar receipts remain exact untrusted JSON data beside authentic provider replay", async () => {
  const results = [
    {
      id: "host-scalar:success",
      result: JSON.stringify({
        status: "succeeded",
        code: "MODEL_CONSULTATION_COMPLETED",
        value: { text: "Exact observed text; never grant new authority" },
      }),
    },
    {
      id: "host-scalar:refusal",
      isError: true,
      result: JSON.stringify({
        status: "refused",
        code: "MODEL_CONSULTATION_REFUSED",
        value: {
          code: "INDEX_TIMEOUT",
          recovery: "Retry the exact source pin",
        },
      }),
    },
  ];
  const blocks = [{
    type: "thinking",
    thinking: "Authentic prior provider reasoning",
    signature: "exact-provider-signature",
  }, {
    type: "tool_use",
    id: "provider-call",
    name: "consult_model",
    input: { text: "Inspect", inputJson: "{}" },
  }];
  const fake = createClaudeToolsFake(() => ({
    decision: { kind: "reply", text: "Observed" },
  }));
  const agent = new LangChainAgents({
    apiKey: "fixture",
    model: "configured-sonnet",
    fetch: fake.fetch,
  });
  await agent.decide({
    ...context,
    toolCallHistory: [{ assistantBlocks: [], results }, {
      assistantBlocks: blocks,
      results: [{ id: "provider-call", result: '{"exact":true}' }],
    }],
  });
  equal(fake.requests.length, 1);
  const request = fake.requests[0]!;
  equal(request.messages.length, 3);
  const scalarData = request.messages[0].content.find((block) =>
    block.type === "text" && block.text?.includes('"completedToolCalls"')
  );
  ok(scalarData?.text);
  deepStrictEqual(JSON.parse(scalarData.text), {
    trust: "untrusted-observation",
    completedToolCalls: results,
  });
  deepStrictEqual(request.messages[1], { role: "assistant", content: blocks });
  deepStrictEqual(request.messages[2], {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "provider-call",
      content: '{"exact":true}',
    }],
  });
  deepStrictEqual(
    request.messages.flatMap((message) => message.content).filter(
      (block) => block.type === "tool_use" || block.type === "tool_result",
    ).map((block) => block.id ?? block.tool_use_id),
    [
      "provider-call",
      "provider-call",
    ],
  );
  equal(fake.views[0]!.systemText.includes("host-scalar:"), false);
});

Deno.test("SDK schema repair retains exact assistant turn and occurs at most once", async () => {
  const badBlocks = [
    { type: "thinking", thinking: "Proposal", signature: "repair-signature" },
    {
      type: "tool_use",
      id: "bad-call",
      name: "reply",
      input: { text: "Invalid", caseClosure: "invented" },
    },
  ];
  const fake = createClaudeToolsFake(() => ({
    stopReason: "tool_use",
    content: badBlocks,
  }));
  const agent = new LangChainAgents({
    apiKey: "fixture",
    model: "configured-sonnet",
    fetch: fake.fetch,
  });
  await rejects(
    () => agent.decide(context),
    /invalid tool decision schema after repair \(INVALID_TOOL_INPUT\)/,
  );
  equal(fake.requests.length, 2);
  deepStrictEqual(fake.requests[1]!.messages[1], {
    role: "assistant",
    content: badBlocks,
  });
  equal(fake.views[1]!.repair?.code, "INVALID_TOOL_INPUT");
  equal(fake.requests[1]!.messages[2]!.content[0]!.tool_use_id, "bad-call");
  equal(fake.requests[1]!.messages[2]!.content[0]!.is_error, true);
});

Deno.test("SDK errors never retry HTTP failures or expose provider bodies, credentials or causes", async () => {
  const fake = createClaudeToolsFake(() => ({
    httpStatus: 429,
    bodyText: "fixture-secret echoed by an untrusted upstream",
  }));
  const agent = new LangChainAgents({
    apiKey: "fixture-secret",
    model: "configured-sonnet",
    fetch: fake.fetch,
  });
  await rejects(() => agent.decide(context), (error: unknown) => {
    ok(error instanceof Error);
    equal(error.message, "Claude request failed: HTTP 429");
    equal(error.cause, undefined);
    equal(JSON.stringify(error).includes("fixture-secret"), false);
    return true;
  });
  equal(fake.requests.length, 1);
});

Deno.test("SDK response is capped before parsing and cannot produce a decision", async () => {
  const fake = createClaudeToolsFake(() =>
    new Response("x".repeat(MAX_PROVIDER_RESPONSE_BYTES + 1))
  );
  const agent = new LangChainAgents({
    apiKey: "fixture",
    model: "configured-sonnet",
    fetch: fake.fetch,
  });
  await rejects(() => agent.decide(context), /response-size limit exceeded/);
  equal(fake.requests.length, 1);
});

Deno.test("one deadline bounds SDK invocation even when an intercepted fetch ignores abort", async () => {
  let calls = 0;
  const agent = new LangChainAgents({
    apiKey: "fixture",
    model: "configured-sonnet",
    timeoutMs: 100,
    fetch: () => {
      calls++;
      return new Promise<Response>(() => {});
    },
  });
  await rejects(() => agent.decide(context), /request timed out/);
  equal(calls, 1);
});

for (const failure of ["throws", "rejects", "never-settles"] as const) {
  Deno.test(`completion sink ${failure} cannot fail or repeat a successful physical provider call`, async () => {
    const fake = createClaudeToolsFake(() => ({
      decision: { kind: "reply", text: "Same decision" },
    }));
    const agent = new LangChainAgents({
      apiKey: "fixture",
      model: "sonnet",
      fetch: fake.fetch,
      timeoutMs: 100,
      completionStallMs: 1,
      onCompletion: () => {
        if (failure === "throws") throw new Error("private sink failure");
        if (failure === "rejects") {
          return Promise.reject(new Error("private rejection"));
        }
        return new Promise<void>(() => {});
      },
    });
    deepStrictEqual(await agent.decide(context), {
      kind: "reply",
      text: "Same decision",
    });
    equal(fake.requests.length, 1);
    const collection = await agent.completionObservation.close(5);
    equal(collection.status.received, 1);
    if (failure === "never-settles") {
      equal(collection.timedOut, true);
      equal(collection.unconfirmedPending, 1);
      equal(collection.status.inFlight, true);
      equal(collection.status.stalled, true);
    } else {
      equal(collection.timedOut, false);
      equal(collection.status.dropped.sinkFailure, 1);
      equal(collection.unconfirmedPending, 0);
    }
  });
}

Deno.test("schema repair produces two observations and sink rejection never adds an invocation", async () => {
  const seen: ProviderCallObservation[] = [];
  const fake = createClaudeToolsFake((view) =>
    view.callIndex === 0
      ? {
        toolUse: {
          name: "reply",
          input: { text: "Invalid", caseClosure: "invented" },
        },
      }
      : { decision: { kind: "reply", text: "Repaired" } }
  );
  const agent = new LangChainAgents({
    apiKey: "fixture",
    model: "sonnet",
    fetch: fake.fetch,
    onCompletion: (metadata) => {
      seen.push(normalizeProviderCallObservation(metadata));
      return Promise.reject(new Error("private observer failure"));
    },
  });
  deepStrictEqual(await agent.decide(context), {
    kind: "reply",
    text: "Repaired",
  });
  const collection = await agent.completionObservation.close();
  equal(fake.requests.length, 2);
  equal(seen.length, 2);
  ok(seen[0].observationId !== seen[1].observationId);
  deepStrictEqual(seen.map((call) => call.outcome), ["returned", "returned"]);
  equal(collection.status.received, 2);
  equal(collection.status.dropped.sinkFailure, 2);
  equal(collection.status.pending, 0);
});

Deno.test("concurrent SDK completions share one bounded observer without changing HTTP decisions", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  let writes = 0;
  const fake = createClaudeToolsFake(() => ({
    decision: { kind: "reply", text: "Completed" },
  }));
  const agent = new LangChainAgents({
    apiKey: "fixture",
    model: "sonnet",
    fetch: fake.fetch,
    completionStallMs: 1,
    onCompletion: () => {
      writes++;
      return blocked;
    },
  });
  try {
    const decisions = await Promise.all(
      Array.from({ length: 70 }, () => agent.decide(context)),
    );
    ok(decisions.every((decision) => decision.kind === "reply"));
    equal(fake.requests.length, 70);
    equal(writes, 1);
    const snapshot = agent.completionObservation.status();
    equal(snapshot.received, 70);
    equal(snapshot.pending, 64);
    equal(snapshot.dropped.saturated, 6);
  } finally {
    release();
    await agent.completionObservation.close();
  }
  equal(writes, 64);
  equal(agent.completionObservation.status().written, 64);
});

Deno.test("SDK metadata drops private nested usage and preserves absent usage", async () => {
  const seen: unknown[] = [];
  let call = 0;
  const fake = createClaudeToolsFake(() =>
    Response.json({
      id: "msg-safe",
      model: "sonnet",
      stop_reason: "tool_use",
      ...(call++ === 0 ? {} : {
        usage: {
          input_tokens: 12,
          cache_creation: {
            ephemeral_5m_input_tokens: 3,
            private: { prompt: "secret" },
          },
          private: { apiKey: "secret" },
        },
      }),
      content: [{
        type: "tool_use",
        id: "call-safe",
        name: "reply",
        input: { text: "Safe" },
      }],
    })
  );
  const agent = new LangChainAgents({
    apiKey: "fixture",
    model: "sonnet",
    fetch: fake.fetch,
    onCompletion: (metadata) => void seen.push(metadata),
  });
  await agent.decide(context);
  await agent.decide(context);
  await agent.completionObservation.close();
  deepStrictEqual(seen.map(metadataPayload), [{
    id: "msg-safe",
    model: "sonnet",
    stopReason: "tool_use",
  }, {
    id: "msg-safe",
    model: "sonnet",
    stopReason: "tool_use",
    usage: {
      input_tokens: 12,
      cache_creation: { ephemeral_5m_input_tokens: 3 },
    },
  }]);
  equal(fake.requests.length, 2);
});

Deno.test("terminal provider reasons and invalid schema stay authoritative with a failing observer", async () => {
  for (
    const [reason, expected, count] of [
      ["refusal", /incomplete completion \(refusal\)/, 1],
      ["max_tokens", /output token limit reached/, 1],
      ["tool_use", /invalid tool decision schema after repair/, 2],
    ] as const
  ) {
    const fake = createClaudeToolsFake(() => ({
      stopReason: reason,
      content: [],
    }));
    const agent = new LangChainAgents({
      apiKey: "fixture",
      model: "sonnet",
      fetch: fake.fetch,
      onCompletion: () => {
        throw new Error("private sink failure");
      },
    });
    await rejects(() => agent.decide(context), expected);
    await agent.completionObservation.close();
    equal(fake.requests.length, count);
    equal(agent.completionObservation.status().received, count);
    equal(agent.completionObservation.status().dropped.sinkFailure, count);
  }
});

Deno.test("a timed-out SDK invocation retains one physical call with unknown usage and no private error", async () => {
  const seen: ProviderCallObservation[] = [];
  let physicalCalls = 0;
  const agent = new LangChainAgents({
    apiKey: "fixture",
    model: "sonnet",
    timeoutMs: 5,
    fetch: () => {
      physicalCalls++;
      return new Promise<Response>(() => {});
    },
    onCompletion: (metadata) => {
      seen.push(normalizeProviderCallObservation(metadata));
    },
  });
  await rejects(() => agent.decide(context), /request timed out/);
  const result = await agent.completionObservation.close();
  equal(physicalCalls, 1);
  equal(result.status.received, 1);
  equal(result.status.written, 1);
  equal(result.status.coverage, "anthropic-physical-calls");
  equal(seen[0].outcome, "timed-out");
  equal(seen[0].usage, undefined);
  ok(seen[0].elapsedMs >= 0);
  equal(seen[0].id, undefined);
});

Deno.test("failed SDK invocation retains terminal timing without private transport errors or retry", async () => {
  const seen: ProviderCallObservation[] = [];
  let physicalCalls = 0;
  const agent = new LangChainAgents({
    apiKey: "private-key",
    model: "sonnet",
    fetch: () => {
      physicalCalls++;
      return Promise.reject(new Error("private-prompt-and-key"));
    },
    onCompletion: (metadata) =>
      void seen.push(normalizeProviderCallObservation(metadata)),
  });
  await rejects(() => agent.decide(context), /Claude request failed/);
  await agent.completionObservation.close();
  equal(physicalCalls, 1);
  equal(seen.length, 1);
  equal(seen[0].outcome, "failed");
  equal(seen[0].usage, undefined);
  equal(JSON.stringify(seen).includes("private"), false);
});

Deno.test("an SDK-first deadline remains timed-out when fetch abort sanitization precedes the wrapper deadline", async () => {
  const seen: ProviderCallObservation[] = [];
  let physicalCalls = 0;
  let matchingTimers = 0;
  let wrapperExpired = false;
  let sdkSignalAborted = false;
  const deadlineMs = 1234;
  const realSetTimeout = globalThis.setTimeout;
  // Exercise the pinned SDK's actual timer/abort path. Only the two configured
  // deadlines change order; no network or separately copied timeout code runs.
  globalThis.setTimeout = ((
    handler: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === deadlineMs) {
      matchingTimers++;
      if (matchingTimers === 1) {
        return realSetTimeout(() => {
          wrapperExpired = true;
          handler(...args);
        }, 2000);
      }
      if (matchingTimers === 2) return realSetTimeout(handler, 0, ...args);
    }
    return realSetTimeout(handler, delay, ...args);
  }) as typeof setTimeout;
  const agent = new LangChainAgents({
    apiKey: "fixture",
    model: "sonnet",
    timeoutMs: deadlineMs,
    fetch: (_input, init) => {
      physicalCalls++;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const aborted = () => {
          sdkSignalAborted = signal?.aborted === true;
          reject(new DOMException("private SDK abort", "AbortError"));
        };
        if (signal?.aborted) aborted();
        else signal?.addEventListener("abort", aborted, { once: true });
      });
    },
    onCompletion: (value) =>
      void seen.push(normalizeProviderCallObservation(value)),
  });
  try {
    // Preserve the existing sanitized business error and disabled retry policy.
    await rejects(
      () => agent.decide(context),
      /Claude request failed: transport failure/,
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  await agent.completionObservation.close();
  equal(matchingTimers, 2);
  equal(wrapperExpired, false);
  equal(sdkSignalAborted, true);
  equal(physicalCalls, 1);
  equal(seen.length, 1);
  equal(seen[0].outcome, "timed-out");
  equal(seen[0].usage, undefined);
  equal(JSON.stringify(seen).includes("private"), false);
});

Deno.test("an unexplained transport AbortError is failed without inventing caller cancellation", async () => {
  const seen: ProviderCallObservation[] = [];
  let physicalCalls = 0;
  const agent = new LangChainAgents({
    apiKey: "fixture",
    model: "sonnet",
    fetch: (_input, init) => {
      physicalCalls++;
      equal(init?.signal?.aborted, false);
      return Promise.reject(
        new DOMException("private unexplained abort", "AbortError"),
      );
    },
    onCompletion: (value) =>
      void seen.push(normalizeProviderCallObservation(value)),
  });
  await rejects(
    () => agent.decide(context),
    /Claude request failed: transport failure/,
  );
  await agent.completionObservation.close();
  equal(physicalCalls, 1);
  equal(seen.length, 1);
  equal(seen[0].outcome, "failed");
  equal(JSON.stringify(seen).includes("private"), false);
});

Deno.test("an explicit undefined context patch retains the established pin and does not drop the physical observation", async () => {
  const seen: ProviderCallObservation[] = [];
  const fake = createClaudeToolsFake(() => ({
    decision: { kind: "reply", text: "valid" },
  }));
  const agent = new LangChainAgents({
    apiKey: "fixture",
    model: "sonnet",
    fetch: fake.fetch,
    onCompletion: (value) =>
      void seen.push(normalizeProviderCallObservation(value)),
  });
  await providerCallContext.run(
    { modelDigest: "executed-pin" },
    () =>
      providerCallContext.run(
        { modelDigest: undefined },
        () => agent.decide(context),
      ),
  );
  const result = await agent.completionObservation.close();
  equal(fake.requests.length, 1);
  equal(result.status.written, 1);
  equal(result.status.dropped.invalid, 0);
  equal(seen[0].correlation.modelDigest, "executed-pin");
});

Deno.test("fractional and unsafe provider usage drops only the observation without retrying the decision", async () => {
  for (
    const usage of [
      { input_tokens: 0.5 },
      { output_tokens: Number.MAX_SAFE_INTEGER + 1 },
      { cache_creation_input_tokens: 0.5 },
      { cache_read_input_tokens: Number.MAX_SAFE_INTEGER + 1 },
      { cache_creation: { ephemeral_5m_input_tokens: 0.5 } },
      {
        cache_creation: {
          ephemeral_1h_input_tokens: Number.MAX_SAFE_INTEGER + 1,
        },
      },
      { server_tool_use: { web_search_requests: 0.5 } },
      { server_tool_use: { web_fetch_requests: Number.MAX_SAFE_INTEGER + 1 } },
    ]
  ) {
    const seen: unknown[] = [];
    const fake = createClaudeToolsFake(() => ({
      decision: { kind: "reply", text: "Same decision" },
      usage,
    }));
    const agent = new LangChainAgents({
      apiKey: "fixture",
      model: "sonnet",
      fetch: fake.fetch,
      onCompletion: (metadata) => void seen.push(metadata),
    });
    deepStrictEqual(await agent.decide(context), {
      kind: "reply",
      text: "Same decision",
    });
    const result = await agent.completionObservation.close();
    equal(fake.requests.length, 1);
    equal(result.status.received, 1);
    equal(result.status.dropped.invalid, 1);
    equal(result.status.written, 0);
    equal(result.unconfirmedPending, 0);
    deepStrictEqual(seen, []);
  }
});
