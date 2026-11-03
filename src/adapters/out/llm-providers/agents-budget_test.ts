import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import { createClaudeToolsFake } from "../../../../test/support/claude-tools-fake.ts";
import { ClaudeAgents } from "./agents.ts";
import type { Candidate } from "../../../domain/work/candidates.ts";
import type { ChatContext } from "../../../domain/work/dialogue.ts";
import {
  normalizeProviderCallObservation,
  UNKNOWN_PROVIDER_CALL_CORRELATION,
} from "../../../application/telemetry/provider-call.ts";

const context: ChatContext = {
  messages: [],
  activeTools: [],
  candidates: [],
};
const withSources: ChatContext = {
  ...context,
  modelSources: {
    version: "branch:model",
    sources: { "model.sysml": "package Model;" },
  },
};
const candidate: Candidate = {
  id: "candidate",
  name: "reader",
  description: "Extract the supplied HTML",
  kind: "read_web_page",
  digest: "a".repeat(64),
  code: "export default ({html}) => ({title:'Title',text:html})",
  stage: "reviewing",
  createdAt: "now",
  baseCatalogRevision: 0,
};

Deno.test("configured decision budget reaches the provider without replacing the review budget", async () => {
  const observed: Array<{ max_tokens: number; effort: string }> = [];
  const fake = createClaudeToolsFake((view) => {
    observed.push({
      max_tokens: view.body.max_tokens,
      effort: view.body.output_config.effort,
    });
    if (
      view.toolNames.length === 1 && view.toolNames[0] === "review_decision"
    ) {
      return {
        decision: {
          candidateDigest: String(view.payload.candidateDigest),
          verdict: "approve",
          reason: "The exact tested candidate satisfies its contract.",
        },
      };
    }
    return { decision: { kind: "reply", text: "Recorded" } };
  });
  const agent = new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    decisionMaxTokens: 32768,
    effort: "medium",
    fetch: fake.fetch,
  });

  await agent.decide(context);
  await agent.decide(withSources);
  await agent.review(candidate, { passed: true, checks: [] });

  deepStrictEqual(observed, [
    { max_tokens: 32768, effort: "medium" },
    { max_tokens: 32768, effort: "medium" },
    { max_tokens: 2048, effort: "medium" },
  ]);
});

Deno.test("unconfigured provider budgets preserve the existing decision defaults", async () => {
  const observed: Array<{ max_tokens: number; effort: string }> = [];
  const fake = createClaudeToolsFake((view) => {
    observed.push({
      max_tokens: view.body.max_tokens,
      effort: view.body.output_config.effort,
    });
    return { decision: { kind: "reply", text: "Recorded" } };
  });
  const agent = new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    fetch: fake.fetch,
  });
  await agent.decide(context);
  await agent.decide(withSources);
  await agent.decide({
    ...context,
    modelSources: { version: "branch:model", sources: {} },
  });
  deepStrictEqual(observed, [
    { max_tokens: 4096, effort: "high" },
    { max_tokens: 16384, effort: "high" },
    { max_tokens: 4096, effort: "high" },
  ]);
});

Deno.test("invalid provider budgets fail before any transport request", () => {
  const fake = createClaudeToolsFake(() => ({
    decision: { kind: "reply", text: "Unreachable" },
  }));
  for (
    const decisionMaxTokens of [0, -1, 1.5, 65537, NaN, Infinity]
  ) {
    throws(
      () =>
        new ClaudeAgents({
          apiKey: "fixture",
          model: "fixture",
          decisionMaxTokens,
          fetch: fake.fetch,
        }),
      /Invalid Claude configuration/,
    );
  }
  for (const effort of ["", "unbounded", "MEDIUM"]) {
    throws(
      () =>
        new ClaudeAgents({
          apiKey: "fixture",
          model: "fixture",
          effort,
          fetch: fake.fetch,
        }),
      /Invalid Claude configuration/,
    );
  }
  equal(fake.requests.length, 0);
});

Deno.test("truncated output records usage but cannot return a decision or retry automatically", async () => {
  const observed: unknown[] = [];
  const fake = createClaudeToolsFake(() => ({
    stopReason: "max_tokens",
    // Un texte libre partiel, même syntaxiquement valide, n'est jamais une décision.
    content: [{ type: "text", text: "Unconfirmed generated content" }],
    id: "completion",
    model: "provider-reported-model",
    usage: { input_tokens: 10, output_tokens: 32768 },
  }));
  const agent = new ClaudeAgents({
    apiKey: "fixture-secret",
    model: "fixture",
    decisionMaxTokens: 32768,
    effort: "medium",
    onCompletion: (metadata) => {
      observed.push(metadata);
    },
    fetch: fake.fetch,
  });

  await rejects(
    () => agent.decide(context),
    /^Error: Claude request failed: output token limit reached \(max_tokens\)$/,
  );
  equal(fake.requests.length, 1);
  deepStrictEqual(
    observed.map((value) => {
      // Physical-call envelope is independently covered by the producer/observer
      // tests; preserve this budget witness's exact provider-returned payload.
      const call = normalizeProviderCallObservation(value);
      equal(call.schemaVersion, 1);
      equal(call.provider, "anthropic");
      equal(call.configuredModel, "fixture");
      equal(call.outcome, "returned");
      deepStrictEqual(call.correlation, UNKNOWN_PROVIDER_CALL_CORRELATION);
      const { id, model, stopReason, usage } = call;
      return { id, model, stopReason, usage };
    }),
    [{
      id: "completion",
      model: "provider-reported-model",
      stopReason: "max_tokens",
      usage: { input_tokens: 10, output_tokens: 32768 },
    }],
  );
});
