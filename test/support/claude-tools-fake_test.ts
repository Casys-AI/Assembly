// Preuve du faux partagé : il est exercé via le vrai ClaudeAgents, jamais seul.
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { ClaudeAgents } from "../../src/adapters/out/llm-providers/agents.ts";
import type { CompletionSink } from "../../src/adapters/out/llm-providers/completion-observer.ts";
import { normalizeProviderCallObservation } from "../../src/application/telemetry/provider-call.ts";
import type { Candidate } from "../../src/domain/work/candidates.ts";
import type { ChatContext } from "../../src/domain/work/dialogue.ts";
import { modelContextTools } from "../../src/domain/model/consultation/context.ts";
import {
  type ClaudeFakeHandler,
  createClaudeToolsFake,
} from "./claude-tools-fake.ts";

const baseContext: ChatContext = {
  messages: [],
  activeTools: [],
  candidates: [],
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

function agentWith(
  handler: ClaudeFakeHandler,
  options: {
    timeoutMs?: number;
    onCompletion?: CompletionSink;
  } = {},
) {
  const fake = createClaudeToolsFake(handler);
  const agent = new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    fetch: fake.fetch,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.onCompletion ? { onCompletion: options.onCompletion } : {}),
  });
  return { fake, agent };
}

Deno.test("helper: decide reply lit system, contexte et outils du nouveau fil", async () => {
  const { fake, agent } = agentWith(() => ({
    decision: { kind: "reply", text: "Noté." },
  }));
  const readContext = { ...baseContext, modelTools: modelContextTools() };
  const decision = await agent.decide(readContext);
  deepStrictEqual(decision, { kind: "reply", text: "Noté." });
  equal(fake.requests.length, 1);
  const view = fake.views[0]!;
  ok(view.systemText.includes("conversational operator"));
  ok(view.systemText.includes("exactement un outil"));
  deepStrictEqual(view.context, { activeTools: [] });
  deepStrictEqual(
    (view.pinCard?.modelOperations as Array<{ operation: string }>).map((
      tool,
    ) => tool.operation),
    readContext.modelTools.map((tool) => tool.operation),
  );
  deepStrictEqual(view.toolNames, [
    "reply",
    "consult_model",
    "propose_tool",
    "invoke_tool",
    "propose_mandate_change",
    "propose_agent_creation",
  ]);
  equal(view.isRepair, false);
  equal(view.body.output_config.effort, "high");
  deepStrictEqual(view.body.tool_choice, {
    type: "auto",
    disable_parallel_tool_use: true,
  });
  ok(!("format" in view.body.output_config));

  const withoutRead = agentWith(() => ({
    decision: { kind: "reply", text: "Sans lecture." },
  }));
  await withoutRead.agent.decide(baseContext);
  equal(withoutRead.fake.views[0]!.toolNames.includes("consult_model"), false);
});

Deno.test("helper: pin instructions are cached and diagnostic state is not pushed", async () => {
  const { fake, agent } = agentWith(() => ({
    decision: { kind: "reply", text: "Constat." },
  }));
  await agent.decide({
    ...baseContext,
    modelTools: modelContextTools(),
    modelDiagnostics: [{
      code: "NO_ACCOUNTABLE_OWNER",
      severity: "warning",
      pattern: "6.3",
      finding: "indeterminate",
      message: "Aucun responsable humain déclaré.",
    }],
  });
  const view = fake.views[0]!;
  ok(view.instruction.includes("APE pattern is never mandatory"));
  equal(view.context!.modelDiagnostics, undefined);
  // Pin-derived instructions now precede the system cache marker.
  ok(view.systemText.includes("APE pattern is never mandatory"));
  equal(view.body.system.length, 2);
  equal(view.body.messages[0]!.content.length, 1);
});

Deno.test("helper: réparation INVALID_TOOL_INPUT relancée en décision corrigée", async () => {
  const { fake, agent } = agentWith((view) => {
    if (!view.isRepair) return { toolUse: { name: "reply", input: {} } };
    equal(view.repair!.code, "INVALID_TOOL_INPUT");
    deepStrictEqual(view.repair!.allowedTools, view.toolNames);
    return { decision: { kind: "reply", text: "Corrigé." } };
  });
  const decision = await agent.decide(baseContext);
  deepStrictEqual(decision, { kind: "reply", text: "Corrigé." });
  equal(fake.requests.length, 2);
  const repairMessage = fake.requests[1]!.messages[2]!;
  equal(repairMessage.role, "user");
  equal(repairMessage.content[0]!.type, "tool_result");
  equal(repairMessage.content[0]!.is_error, true);
});

Deno.test("helper: réparation NO_TOOL_CALL décodée depuis le bloc texte", async () => {
  const { fake, agent } = agentWith((view) => {
    if (!view.isRepair) return { text: "réponse libre ignorée" };
    equal(view.repair!.code, "NO_TOOL_CALL");
    return { decision: { kind: "reply", text: "Après réparation." } };
  });
  const decision = await agent.decide(baseContext);
  deepStrictEqual(decision, { kind: "reply", text: "Après réparation." });
  equal(fake.requests.length, 2);
});

Deno.test("helper: outil inconnu persistant refusé après un seul tour", async () => {
  const { fake, agent } = agentWith(() => ({
    toolUse: { name: "delete_database", input: {} },
  }));
  await rejects(
    () => agent.decide(baseContext),
    /invalid tool decision schema after repair \(UNKNOWN_TOOL\)/,
  );
  equal(fake.requests.length, 2);
});

Deno.test("helper: sources carte canonique converties en liste au fil", async () => {
  const editing = {
    targetedEdits: true,
    rawRevision: true,
    policy: {
      id: "edit",
      revision: 1,
      elementId: "edit-policy",
      sourceIds: [],
      holderNativeId: "builder",
      mandateNativeId: "mandate",
      mandateId: "mandate",
      mandateRevision: 1,
      operations: [
        "set-value",
        "rename",
        "insert-member",
        "remove",
        "replace-source",
      ],
      grants: [{ file: "system.sysml", qualifiedRoots: ["Exact"] }],
    },
  };
  const { fake, agent } = agentWith(() => ({
    decision: {
      kind: "propose_sysml_revision",
      text: "Une proposition à examiner",
      reason: "Documenter le système",
      baseVersion: "branch:exact-base",
      sources: { "core.sysml": "package Core { doc /* Reviewed */ }" },
    },
  }));
  const result = await agent.decide({
    ...baseContext,
    modelEditing: editing as unknown as ChatContext["modelEditing"],
    modelSources: {
      version: "branch:exact-base",
      sources: { "core.sysml": "package Core {}" },
    },
  });
  equal(result.kind, "propose_sysml_revision");
  if (result.kind === "propose_sysml_revision") {
    equal(result.sources["core.sysml"], "package Core { doc /* Reviewed */ }");
    deepStrictEqual(Object.keys(result.sources), ["core.sysml"]);
  }
  const sent = fake.views[0]!;
  ok(sent.toolNames.includes("propose_sysml_revision"));
});

Deno.test("helper: revue par l'outil unique review_decision", async () => {
  const { fake, agent } = agentWith(() => ({
    decision: {
      candidateDigest: candidate.digest,
      verdict: "approve",
      reason: "Le candidat exact satisfait son contrat.",
    },
  }));
  const decision = await agent.review(candidate, {
    passed: true,
    checks: [],
  });
  equal(decision.verdict, "approve");
  deepStrictEqual(fake.views[0]!.toolNames, ["review_decision"]);
  equal(fake.views[0]!.body.max_tokens, 2048);
  equal(fake.views[0]!.context, undefined);
  equal(fake.views[0]!.payload.candidateDigest, candidate.digest);
});

Deno.test("helper: usage et timeout pilotables par action et par signal", async () => {
  const seen: unknown[] = [];
  const usage = agentWith(
    () => ({
      decision: { kind: "reply", text: "Mesuré." },
      id: "completion-1",
      model: "provider-model",
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 8,
        cache_read_input_tokens: 0,
      },
    }),
    { onCompletion: (metadata) => void seen.push(metadata) },
  );
  await usage.agent.decide(baseContext);
  await usage.agent.completionObservation.flush();
  deepStrictEqual(
    seen.map((value) => {
      const call = normalizeProviderCallObservation(value);
      equal(call.outcome, "returned");
      return {
        id: call.id,
        model: call.model,
        stopReason: call.stopReason,
        usage: call.usage,
      };
    }),
    [{
      id: "completion-1",
      model: "provider-model",
      stopReason: "tool_use",
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 8,
        cache_read_input_tokens: 0,
      },
    }],
  );
  const slow = agentWith(
    (view) =>
      new Promise((_resolve, reject) => {
        view.signal?.addEventListener(
          "abort",
          () => reject(new Error("abort-secret")),
          { once: true },
        );
      }),
    { timeoutMs: 10 },
  );
  await rejects(
    () => slow.agent.decide(baseContext),
    (error: Error) =>
      error.message === "Claude request failed: request timed out" &&
      !error.message.includes("abort-secret"),
  );
});

Deno.test("helper: catégories terminales sans réparation ni réflexion de corps", async () => {
  const http = agentWith(() => ({
    httpStatus: 429,
    bodyText: "PRIVATE_PROVIDER_BODY",
  }));
  await rejects(
    () => http.agent.decide(baseContext),
    (error: Error) =>
      error.message === "Claude request failed: HTTP 429" &&
      !error.message.includes("PRIVATE_PROVIDER_BODY"),
  );
  equal(http.fake.requests.length, 1);
  const truncated = agentWith(() => ({
    stopReason: "max_tokens",
    content: [{ type: "text", text: "tronqué" }],
  }));
  await rejects(
    () => truncated.agent.decide(baseContext),
    /output token limit reached \(max_tokens\)/,
  );
  equal(truncated.fake.requests.length, 1);
});

Deno.test("helper: refuse en 400 ce que l'API réelle refuse", async () => {
  const fake = createClaudeToolsFake(() => ({ text: "Réponse." }));
  const body = (messages: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      model: "m",
      max_tokens: 1,
      system: [],
      tools: [],
      messages,
      output_config: { effort: "high" },
      ...extra,
    });
  const headers = { "anthropic-version": "2023-06-01", "x-api-key": "k" };
  const call = async (init: RequestInit) =>
    (await fake.fetch("https://api.anthropic.com/v1/messages", init)).status;
  const user = { role: "user", content: [{ type: "text", text: "{}" }] };
  equal(await call({ method: "GET", headers, body: body([user]) }), 400);
  equal(
    await call({
      method: "POST",
      headers: { "x-api-key": "k" },
      body: body([user]),
    }),
    400,
  );
  equal(
    await call({
      method: "POST",
      headers,
      body: body([user], { tool_choice: { type: "any" } }),
    }),
    400,
  );
  const assistant = {
    role: "assistant",
    content: [{ type: "tool_use", id: "a", name: "reply", input: {} }],
  };
  const answer = (id: string) => ({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, is_error: true }],
  });
  equal(
    await call({
      method: "POST",
      headers,
      body: body([user, assistant, answer("b")]),
    }),
    400,
  );
  equal(
    await call({
      method: "POST",
      headers,
      body: body([user, assistant, answer("a")]),
    }),
    200,
  );
});
