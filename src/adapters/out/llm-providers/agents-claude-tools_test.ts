// Mock transport is deliberately async to implement the real fetch contract.
// deno-lint-ignore-file require-await
import { readAssemblyEnv } from "../../../infrastructure/environment.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import {
  buildClaudeTools,
  CLAUDE_REVIEW_TOOL,
  ClaudeAgents,
} from "./agents.ts";
import { modelContextTools } from "../../../application/work/context/model-tools.ts";
import { decisionSchema } from "./output-validation.ts";
import type { Candidate } from "../../../domain/work/records/candidates.ts";
import type { ChatContext } from "../../../application/work/conversation/chat-context.ts";
import { normalizeProviderCallObservation } from "../../../application/telemetry/provider-call.ts";
import type { CompletionSink } from "./completion-observer.ts";

const baseContext: ChatContext = {
  messages: [],
  activeTools: [],
  candidates: [],
};

const readContext: ChatContext = {
  ...baseContext,
  modelTools: modelContextTools(),
};

const sysmlEditing = {
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
} as const;

const administration = {
  kind: "root",
  digest: "a".repeat(64),
} as unknown as ChatContext["modelAdministration"];

const delegation = {
  policies: [{ id: "research-network", revision: 1, enabled: true }],
  requests: [],
  awaitingPerson: [],
  awaitingPersonTruncated: false,
} as unknown as ChatContext["operatorAuthority"];

const fullContext: ChatContext = {
  ...readContext,
  modelEditing: { ...sysmlEditing } as unknown as ChatContext["modelEditing"],
  modelAdministration: administration,
  operatorAuthority: delegation,
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

type WireBody = {
  model: string;
  max_tokens: number;
  system: Array<
    { type: string; text: string; cache_control?: { type: string } }
  >;
  tools: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
    cache_control?: { type: string };
  }>;
  messages: Array<{ role: string; content: unknown[] }>;
  output_config: Record<string, unknown>;
  [key: string]: unknown;
};

function readBody(init?: RequestInit): WireBody {
  return JSON.parse(String(init?.body)) as WireBody;
}

function toolUseResponse(name: string, input: unknown, id = "toolu_1") {
  return Response.json({
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 20 },
    content: [{ type: "tool_use", id, name, input }],
  });
}

function textResponse(text: string) {
  return Response.json({
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
  });
}

function replyInput(text = "Noté.") {
  return { text };
}

/** Fake fetch serving a scripted response queue while recording request bodies. */
function scriptedFetch(
  script: Array<(body: WireBody, call: number) => Response>,
  observed: WireBody[],
): typeof fetch {
  let calls = 0;
  return (async (_url, init) => {
    const body = readBody(init as RequestInit | undefined);
    observed.push(body);
    const step = script[Math.min(calls, script.length - 1)]!;
    calls++;
    return step(body, calls);
  }) as typeof fetch;
}

function agentWith(
  script: Array<(body: WireBody, call: number) => Response>,
  observed: WireBody[],
  extra?: {
    onCompletion?: CompletionSink;
  },
) {
  return new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    fetch: scriptedFetch(script, observed),
    ...(extra?.onCompletion ? { onCompletion: extra.onCompletion } : {}),
  });
}

function assertTransportInvariants(body: WireBody) {
  // Jamais strict, jamais de choix forcé, jamais de grammaire JSON.
  for (const tool of body.tools) {
    deepStrictEqual(
      Object.keys(tool).sort(),
      ["cache_control", "description", "input_schema", "name"]
        .filter((key) => key !== "cache_control" || "cache_control" in tool)
        .sort(),
    );
    ok(!("strict" in tool), `outil ${tool.name} sans strict`);
    ok(
      !JSON.stringify(tool.input_schema).includes('"strict"'),
      `schéma ${tool.name} sans strict`,
    );
    ok(typeof tool.description === "string" && tool.description.length > 0);
  }
  // Choix automatique, au plus un appel : any/tool sont refusés par le modèle.
  deepStrictEqual(body.tool_choice, {
    type: "auto",
    disable_parallel_tool_use: true,
  });
  ok(!("format" in body.output_config), "pas de output_config.format");
  deepStrictEqual(body.output_config, { effort: "high" });
  // Cache : dernier outil + dernier bloc system, rien d'autre.
  const cacheTools = body.tools.filter((tool) =>
    JSON.stringify(tool.cache_control ?? null) !== "null"
  );
  equal(cacheTools.length, 1);
  equal(cacheTools[0]!.name, body.tools[body.tools.length - 1]!.name);
  deepStrictEqual(cacheTools[0]!.cache_control, { type: "ephemeral" });
  equal(body.system.length, 2);
  ok(!("cache_control" in body.system[0]!));
  deepStrictEqual(body.system[1]!.cache_control, { type: "ephemeral" });
}

Deno.test("outils par défaut : 5 kinds sans édition SysML ni administration", async () => {
  const observed: WireBody[] = [];
  const agent = agentWith(
    [() => toolUseResponse("reply", replyInput())],
    observed,
  );
  const decision = await agent.decide(baseContext);
  equal(decision.kind, "reply");
  equal(observed.length, 1);
  const body = observed[0]!;
  deepStrictEqual(
    body.tools.map((tool) => tool.name),
    [
      "reply",
      "propose_tool",
      "invoke_tool",
      "propose_mandate_change",
      "propose_agent_creation",
    ],
  );
  assertTransportInvariants(body);
});

Deno.test("édition ciblée + révision brute : 7 outils avec sources en liste", async () => {
  const observed: WireBody[] = [];
  const agent = agentWith(
    [() => toolUseResponse("reply", replyInput())],
    observed,
  );
  await agent.decide({
    ...baseContext,
    modelEditing: { ...sysmlEditing } as unknown as ChatContext["modelEditing"],
  });
  const body = observed[0]!;
  deepStrictEqual(
    body.tools.map((tool) => tool.name),
    [
      "reply",
      "propose_tool",
      "invoke_tool",
      "propose_mandate_change",
      "propose_sysml_revision",
      "propose_sysml_edit",
      "propose_agent_creation",
    ],
  );
  assertTransportInvariants(body);
  const revision = body.tools.find((tool) =>
    tool.name === "propose_sysml_revision"
  )!;
  const sources = (revision.input_schema.properties as Record<string, unknown>)
    .sources as Record<string, unknown>;
  equal(sources.type, "array");
  ok(!JSON.stringify(revision.input_schema).includes("propertyNames"));
});

Deno.test("administration : propose_model_delegation ajouté, 6 outils", async () => {
  const observed: WireBody[] = [];
  const agent = agentWith(
    [() => toolUseResponse("reply", replyInput())],
    observed,
  );
  await agent.decide({ ...baseContext, modelAdministration: administration });
  const body = observed[0]!;
  deepStrictEqual(
    body.tools.map((tool) => tool.name),
    [
      "reply",
      "propose_tool",
      "invoke_tool",
      "propose_mandate_change",
      "propose_model_delegation",
      "propose_agent_creation",
    ],
  );
  assertTransportInvariants(body);
});

Deno.test("politique d'opérateur admise : decide_operator_change ajouté, 6 outils", async () => {
  const observed: WireBody[] = [];
  const agent = agentWith(
    [() => toolUseResponse("reply", replyInput())],
    observed,
  );
  await agent.decide({ ...baseContext, operatorAuthority: delegation });
  const body = observed[0]!;
  deepStrictEqual(
    body.tools.map((tool) => tool.name),
    [
      "reply",
      "propose_tool",
      "invoke_tool",
      "propose_mandate_change",
      "decide_operator_change",
      "propose_agent_creation",
    ],
  );
  assertTransportInvariants(body);
  // Le nom de l'outil est la décision : l'entrée ne porte pas de kind.
  const decision = body.tools.find((tool) =>
    tool.name === "decide_operator_change"
  )!;
  const schema = decision.input_schema as {
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
  deepStrictEqual(Object.keys(schema.properties).sort(), [
    "changeId",
    "expectedRevision",
    "operatorId",
    "policyId",
    "policyRevision",
    "text",
    "verdict",
  ]);
  deepStrictEqual(
    [...schema.required].sort(),
    Object.keys(schema.properties).sort(),
  );
  equal(schema.additionalProperties, false);
});

Deno.test("sans politique admise, decide_operator_change n'est pas offert", async () => {
  for (
    const operatorAuthority of [
      undefined,
      {
        policies: [],
        requests: [],
        awaitingPerson: [],
        awaitingPersonTruncated: false,
      },
    ]
  ) {
    const observed: WireBody[] = [];
    const agent = agentWith(
      [() => toolUseResponse("reply", replyInput())],
      observed,
    );
    await agent.decide({ ...baseContext, operatorAuthority });
    ok(
      !observed[0]!.tools.some((tool) =>
        tool.name === "decide_operator_change"
      ),
    );
  }
});

Deno.test("4.8d D2: without a policy, requests awaiting the person are read-only context and decide_operator_change stays unoffered", async () => {
  const observed: WireBody[] = [];
  const agent = agentWith(
    [() => toolUseResponse("reply", replyInput())],
    observed,
  );
  await agent.decide({
    ...baseContext,
    operatorAuthority: {
      policies: [],
      requests: [],
      awaitingPerson: [{
        id: "change-awaiting",
        caseId: "case-awaiting",
        executionSpaceId: "branch-awaiting",
        requester: {
          projectId: "project",
          systemId: "system",
          executionSpaceId: "branch-awaiting",
          operatorId: "builder",
        },
        changeKind: "mandate-change",
        requestedRights: { addNetworkHosts: ["example.org"] },
        status: "human-decision",
      }],
      awaitingPersonTruncated: false,
    },
  });
  ok(
    !observed[0]!.tools.some((tool) => tool.name === "decide_operator_change"),
  );
  const wire = JSON.stringify(observed[0]!);
  ok(wire.includes("change-awaiting"), "the request is in the context");
  ok(
    wire.includes("awaitingPerson") && wire.includes("carte relayée"),
    "the instruction says where the person decides",
  );
});

Deno.test("contexte complet : 10 outils filtrés, schéma étendu à 18 avec création fusionnée", async () => {
  const observed: WireBody[] = [];
  const agent = agentWith(
    [() => toolUseResponse("reply", replyInput())],
    observed,
  );
  await agent.decide(fullContext);
  equal(observed[0]!.tools.length, 10);
  assertTransportInvariants(observed[0]!);
  // Pure: 19 variants become 18 tools, with creation roles merged. The two actions
  // d'admission restent absentes du contexte sans cette délégation.
  const tools = buildClaudeTools(decisionSchema);
  equal(tools.length, 18);
  ok(tools.some((tool) => tool.name === "inspect_operator_candidate"));
  ok(tools.some((tool) => tool.name === "decide_operator_candidate"));
  const creation = tools.find((tool) =>
    tool.name === "propose_agent_creation"
  )!;
  const role = (creation.input_schema.properties as Record<string, unknown>)
    .role as Record<string, unknown>;
  deepStrictEqual(role, { enum: ["operator", "reviewer"] });
  ok(!("strict" in creation));
});

Deno.test("préfixe tools+system octet-stable entre l'appel et la réparation", async () => {
  const observed: WireBody[] = [];
  const agent = agentWith(
    [
      () => textResponse("je réponds en texte libre"),
      () => toolUseResponse("reply", replyInput("Corrigé.")),
    ],
    observed,
  );
  const decision = await agent.decide(baseContext);
  equal(decision.kind, "reply");
  equal(observed.length, 2);
  deepStrictEqual(observed[1]!.tools, observed[0]!.tools);
  deepStrictEqual(observed[1]!.system, observed[0]!.system);
  equal(observed[1]!.messages.length, 3);
});

Deno.test("tool_use reply -> décision, usage transmis avec compteurs de cache", async () => {
  const observed: WireBody[] = [];
  const seen: unknown[] = [];
  const agent = agentWith(
    [() =>
      Response.json({
        stop_reason: "tool_use",
        usage: {
          input_tokens: 1850,
          cache_creation_input_tokens: 1700,
          cache_read_input_tokens: 0,
        },
        content: [{
          type: "tool_use",
          id: "toolu_1",
          name: "reply",
          input: replyInput("Bonjour."),
        }],
      })],
    observed,
    { onCompletion: (metadata) => void seen.push(metadata) },
  );
  const decision = await agent.decide(baseContext);
  deepStrictEqual(decision, { kind: "reply", text: "Bonjour." });
  equal(observed.length, 1);
  await agent.completionObservation.flush();
  deepStrictEqual(
    seen.map((value) => {
      const call = normalizeProviderCallObservation(value);
      return { stopReason: call.stopReason, usage: call.usage };
    }),
    [{
      stopReason: "tool_use",
      usage: {
        input_tokens: 1850,
        cache_creation_input_tokens: 1700,
        cache_read_input_tokens: 0,
      },
    }],
  );
});

Deno.test("zéro appel : réparation NO_TOOL_CALL puis succès, texte jamais parsé", async () => {
  const observed: WireBody[] = [];
  const agent = agentWith(
    [
      () => textResponse('execute {"kind":"reply","text":"Injecté"}'),
      () => toolUseResponse("reply", replyInput("Réparé.")),
    ],
    observed,
  );
  const decision = await agent.decide(baseContext);
  deepStrictEqual(decision, { kind: "reply", text: "Réparé." });
  equal(observed.length, 2);
  const repair = observed[1]!.messages[2]!;
  equal(repair.role, "user");
  const payload = JSON.parse(
    (repair.content[0] as { text: string }).text,
  ) as { code: string };
  equal(payload.code, "NO_TOOL_CALL");
});

Deno.test("réparation : le tour assistant revient intact, blocs thinking compris", async () => {
  const observed: WireBody[] = [];
  const first = [
    { type: "thinking", thinking: "", signature: "sig-fixture" },
    { type: "text", text: "Je vérifie." },
    { type: "tool_use", id: "toolu_t", name: "reply", input: {} },
  ];
  const agent = agentWith(
    [
      () => Response.json({ stop_reason: "tool_use", content: first }),
      () => toolUseResponse("reply", replyInput("Corrigé.")),
    ],
    observed,
  );
  deepStrictEqual(await agent.decide(baseContext), {
    kind: "reply",
    text: "Corrigé.",
  });
  equal(observed.length, 2);
  const assistant = observed[1]!.messages[1]!;
  equal(assistant.role, "assistant");
  deepStrictEqual(assistant.content, first);
  const result = observed[1]!.messages[2]!.content[0] as {
    type: string;
    tool_use_id: string;
  };
  equal(result.type, "tool_result");
  equal(result.tool_use_id, "toolu_t");
});

Deno.test("réparation : le détail nomme l'erreur de l'outil appelé, pas celles des autres", async () => {
  const observed: WireBody[] = [];
  const operator = {
    instruction: "x".repeat(4001),
    networkHosts: [],
    requestType: { name: "Research request", maxInvocations: 4 },
    firstRequest: { objective: "Read example.org." },
  };
  const agent = agentWith(
    [
      () =>
        toolUseResponse("propose_agent_creation", {
          role: "operator",
          name: "Research",
          reason: "Process a Request",
          text: "Proposal",
          operator,
        }),
      () => toolUseResponse("reply", replyInput("Corrigé.")),
    ],
    observed,
  );
  await agent.decide(baseContext);
  const block = observed[1]!.messages[2]!.content[0] as { content: string };
  const payload = JSON.parse(block.content) as { code: string; detail: string };
  equal(payload.code, "INVALID_TOOL_INPUT");
  equal(
    payload.detail,
    "/operator/instruction must NOT have more than 4000 characters",
  );
});

Deno.test("max_tokens : une décision valide mais tronquée n'est jamais retenue", async () => {
  const observed: WireBody[] = [];
  const agent = agentWith(
    [() =>
      Response.json({
        stop_reason: "max_tokens",
        content: [{
          type: "tool_use",
          id: "toolu_1",
          name: "reply",
          input: replyInput("Valide mais tronqué."),
        }],
      })],
    observed,
  );
  await rejects(
    () => agent.decide(baseContext),
    /Claude request failed: output token limit reached \(max_tokens\)/,
  );
  equal(observed.length, 1);
});

Deno.test("input invalide Ajv : réparation INVALID_TOOL_INPUT puis succès", async () => {
  const observed: WireBody[] = [];
  const agent = agentWith(
    [
      () => toolUseResponse("reply", {}),
      () => toolUseResponse("reply", replyInput("Corrigé.")),
    ],
    observed,
  );
  const decision = await agent.decide(baseContext);
  deepStrictEqual(decision, { kind: "reply", text: "Corrigé." });
  equal(observed.length, 2);
  const repair = observed[1]!.messages[2]!;
  const block = repair.content[0] as {
    type: string;
    tool_use_id: string;
    is_error: boolean;
    content: string;
  };
  equal(block.type, "tool_result");
  equal(block.tool_use_id, "toolu_1");
  equal(block.is_error, true);
  const payload = JSON.parse(block.content) as { code: string };
  equal(payload.code, "INVALID_TOOL_INPUT");
});

Deno.test("client singleton : appels multiples réparés avec un tool_result par id", async () => {
  const observed: WireBody[] = [];
  const agent = agentWith(
    [
      () =>
        Response.json({
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_a",
              name: "reply",
              input: replyInput("Un."),
            },
            {
              type: "tool_use",
              id: "toolu_b",
              name: "reply",
              input: replyInput("Deux."),
            },
          ],
        }),
      () => toolUseResponse("reply", replyInput("Un seul.")),
    ],
    observed,
  );
  const decision = await agent.decide(baseContext);
  deepStrictEqual(decision, { kind: "reply", text: "Un seul." });
  equal(observed.length, 2);
  const repair = observed[1]!.messages[2]!;
  equal(repair.content.length, 2);
  for (
    const block of repair.content as Array<{ type: string; is_error: boolean }>
  ) {
    equal(block.type, "tool_result");
    equal(block.is_error, true);
  }
  const payload = JSON.parse(
    (repair.content[0] as { content: string }).content,
  ) as { code: string };
  equal(payload.code, "MULTIPLE_TOOL_CALLS");
});

const consultUse = (id: string, elementId = id) => ({
  type: "tool_use",
  id,
  name: "consult_model",
  input: {
    text: `Inspect ${elementId}`,
    inputJson: JSON.stringify({
      operation: "inspect",
      version: "commit:base",
      elementId,
    }),
  },
});

Deno.test("batch : consultations corrélées et thinking conservés en une requête", async () => {
  const observed: WireBody[] = [];
  const blocks = [
    { type: "thinking", thinking: "", signature: "signed-fixture" },
    consultUse("toolu_a", "a"),
    consultUse("toolu_b", "b"),
  ];
  const agent = agentWith([
    () => Response.json({ stop_reason: "tool_use", content: blocks }),
  ], observed);
  const batch = await agent.decideBatch(readContext);
  deepStrictEqual(batch, {
    calls: blocks.slice(1).map((block) => {
      const use = block as ReturnType<typeof consultUse>;
      return { id: use.id, decision: { kind: use.name, ...use.input } };
    }),
    assistantBlocks: blocks,
  });
  equal(observed.length, 1);
  deepStrictEqual(observed[0]!.tool_choice, {
    type: "auto",
    disable_parallel_tool_use: false,
  });
  ok(observed[0]!.system[1]!.text.includes("1 et 8"));
});

Deno.test("batch : tous les résultats sont rejoués avec leurs IDs avant la décision suivante", async () => {
  const observed: WireBody[] = [];
  const blocks = [
    { type: "thinking", thinking: "", signature: "signed-fixture" },
    consultUse("toolu_a"),
    consultUse("toolu_b"),
  ];
  const agent = agentWith([
    () => toolUseResponse("reply", replyInput("Both inspected"), "toolu_final"),
  ], observed);
  const history = [{
    assistantBlocks: blocks,
    // Completion order is independent from provider call order.
    results: [
      {
        id: "toolu_b",
        result: '{"status":"failed","code":"READ_FAILED"}',
        isError: true,
      },
      {
        id: "toolu_a",
        result: '{"status":"succeeded","value":{"elementId":"a"}}',
      },
    ],
  }];
  await agent.decideBatch({
    ...baseContext,
    toolCallHistory: [{
      assistantBlocks: [],
      results: [{ id: "other-transport", result: "Recorded elsewhere" }],
    }, ...history],
  });
  equal(observed.length, 1);
  deepStrictEqual(observed[0]!.messages[1], {
    role: "assistant",
    content: blocks,
  });
  deepStrictEqual(observed[0]!.messages[2], {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_b",
        is_error: true,
        content: history[0]!.results[0]!.result,
      },
      {
        type: "tool_result",
        tool_use_id: "toolu_a",
        content: history[0]!.results[1]!.result,
      },
    ],
  });
  const payload = JSON.parse(
    (observed[0]!.messages[0]!.content.at(-1) as { text: string }).text,
  );
  ok(!("toolCallHistory" in payload.context));
});

Deno.test("batch : un membre invalide, des IDs invalides, une borne ou un terminal incompatible refusent tout le groupe", async () => {
  const proposal = {
    type: "tool_use",
    id: "toolu_p",
    name: "propose_tool",
    input: {
      text: "Prepare",
      tool: {
        name: "reader",
        description: "Read",
        kind: "read_web_page",
        code: "export default () => ({title:'t',text:'t'})",
      },
    },
  };
  const cases: Array<{ content: unknown[]; code: string }> = [
    {
      content: [consultUse("toolu_a"), { ...consultUse("toolu_b"), input: {} }],
      code: "INVALID_TOOL_INPUT",
    },
    {
      content: [consultUse("toolu_a"), consultUse("toolu_a")],
      code: "INVALID_TOOL_CALL_ID",
    },
    {
      content: [{
        type: "tool_use",
        name: "consult_model",
        input: consultUse("x").input,
      }],
      code: "INVALID_TOOL_CALL_ID",
    },
    {
      content: Array.from({ length: 9 }, (_, i) => consultUse(`toolu_${i}`)),
      code: "TOO_MANY_TOOL_CALLS",
    },
    {
      content: [{
        type: "tool_use",
        id: "toolu_r",
        name: "reply",
        input: replyInput(),
      }, consultUse("toolu_a")],
      code: "INVALID_TOOL_CALL_ORDER",
    },
    {
      content: [proposal, {
        type: "tool_use",
        id: "toolu_r",
        name: "reply",
        input: { ...replyInput(), caseClosure: "done" },
      }],
      code: "INVALID_TOOL_CALL_ORDER",
    },
  ];
  for (const invalid of cases) {
    const observed: WireBody[] = [];
    const agent = agentWith([
      () =>
        Response.json({ stop_reason: "tool_use", content: invalid.content }),
      () => toolUseResponse("reply", replyInput("Repaired"), "toolu_repaired"),
    ], observed);
    const batch = await agent.decideBatch(readContext);
    deepStrictEqual(batch.calls, [{
      id: "toolu_repaired",
      decision: { kind: "reply", text: "Repaired" },
    }]);
    equal(observed.length, 2);
    deepStrictEqual(observed[0]!.tools, observed[1]!.tools);
    deepStrictEqual(observed[0]!.system, observed[1]!.system);
    const repair = observed[1]!.messages.at(-1)!.content[0] as {
      content?: string;
      text?: string;
    };
    equal(JSON.parse(repair.content ?? repair.text!).code, invalid.code);
    if (invalid.code === "INVALID_TOOL_CALL_ID") {
      ok(
        observed[1]!.messages.every((message) => message.role !== "assistant"),
      );
    } else {
      deepStrictEqual(observed[1]!.messages[1]!.content, invalid.content);
      equal(observed[1]!.messages[2]!.content.length, invalid.content.length);
    }
  }
});

Deno.test("batch : sortie tronquée refuse même un groupe par ailleurs valide sans réparation", async () => {
  const observed: WireBody[] = [];
  const agent = agentWith([
    () =>
      Response.json({
        stop_reason: "max_tokens",
        content: [consultUse("a"), consultUse("b")],
      }),
  ], observed);
  await rejects(
    () => agent.decideBatch(readContext),
    /output token limit reached/,
  );
  equal(observed.length, 1);
});

Deno.test("batch : lecture puis proposition et réponse finale sans clôture gardent l’ordre", async () => {
  const observed: WireBody[] = [];
  const content = [
    consultUse("read"),
    {
      type: "tool_use",
      id: "propose",
      name: "propose_mandate_change",
      input: {
        text: "Propose",
        reason: "Need access",
        requestedRights: { addNetworkHosts: ["example.org"] },
      },
    },
    {
      type: "tool_use",
      id: "reply",
      name: "reply",
      input: replyInput("Prepared"),
    },
  ];
  const agent = agentWith([
    () => Response.json({ stop_reason: "tool_use", content }),
  ], observed);
  deepStrictEqual(
    (await agent.decideBatch(readContext)).calls.map((call) => call.id),
    ["read", "propose", "reply"],
  );
  equal(observed.length, 1);
});

Deno.test("scripted equivalent read and draft pairs need two singleton requests or one grouped request", async () => {
  const draftUse = (id: string, name: string) => ({
    type: "tool_use",
    id,
    name: "propose_tool",
    input: {
      text: `Prepare ${name}`,
      tool: {
        name,
        description: "Extract supplied HTML",
        kind: "read_web_page",
        code: "export default ({html}) => ({title:'Fixture',text:html})",
      },
    },
  });
  for (
    const content of [[consultUse("a"), consultUse("b")], [
      draftUse("a", "First"),
      draftUse("b", "Second"),
    ]]
  ) {
    const singles: WireBody[] = [];
    const singleton = agentWith(
      content.map((block) => () =>
        Response.json({ stop_reason: "tool_use", content: [block] })
      ),
      singles,
    );
    const expected = [
      await singleton.decide(readContext),
      await singleton.decide(readContext),
    ];
    const groups: WireBody[] = [];
    const grouped = agentWith([
      () => Response.json({ stop_reason: "tool_use", content }),
    ], groups);
    const batch = await grouped.decideBatch(readContext);
    deepStrictEqual(batch.calls.map((call) => call.decision), expected);
    equal(singles.length, 2);
    equal(groups.length, 1);
  }
});

Deno.test("outil inconnu : réparation UNKNOWN_TOOL puis refus codé", async () => {
  const observed: WireBody[] = [];
  const agent = agentWith(
    [
      () => toolUseResponse("delete_database", {}, "toolu_x"),
      () => toolUseResponse("delete_database", {}, "toolu_y"),
    ],
    observed,
  );
  await rejects(
    () => agent.decide(readContext),
    /^Error: Claude request failed: invalid tool decision schema after repair \(UNKNOWN_TOOL\)$/,
  );
  equal(observed.length, 2);
});

Deno.test("zéro appel persistant : refus codé NO_TOOL_CALL après un seul tour", async () => {
  const observed: WireBody[] = [];
  const agent = agentWith(
    [() => textResponse("toujours du texte libre")],
    observed,
  );
  await rejects(
    () => agent.decide(readContext),
    /^Error: Claude request failed: invalid tool decision schema after repair \(NO_TOOL_CALL\)$/,
  );
  equal(observed.length, 2);
});

Deno.test("kind injecté divergent : jamais exécuté, refus codé", async () => {
  const observed: WireBody[] = [];
  const agent = agentWith(
    [() =>
      toolUseResponse("reply", { kind: "consult_model", text: "Détourné." })],
    observed,
  );
  await rejects(
    () => agent.decide(baseContext),
    /INVALID_TOOL_INPUT/,
  );
  equal(observed.length, 2);
});

Deno.test("review : outil unique review_decision, budget 2048", async () => {
  const observed: WireBody[] = [];
  const agent = agentWith(
    [() =>
      toolUseResponse(CLAUDE_REVIEW_TOOL, {
        candidateDigest: candidate.digest,
        verdict: "approve",
        reason: "Le candidat exact satisfait son contrat.",
      })],
    observed,
  );
  const decision = await agent.review(candidate, { passed: true, checks: [] });
  equal(decision.verdict, "approve");
  equal(observed.length, 1);
  const body = observed[0]!;
  deepStrictEqual(body.tools.map((tool) => tool.name), [CLAUDE_REVIEW_TOOL]);
  equal(body.max_tokens, 2048);
  assertTransportInvariants(body);
});

Deno.test("review : digest divergent refusé", async () => {
  const observed: WireBody[] = [];
  const agent = agentWith(
    [() =>
      toolUseResponse(CLAUDE_REVIEW_TOOL, {
        candidateDigest: "b".repeat(64),
        verdict: "approve",
        reason: "Mauvais candidat.",
      })],
    observed,
  );
  await rejects(
    () => agent.review(candidate, { passed: true, checks: [] }),
    /digest mismatch/,
  );
  // Contrôle post-transport : aucun tour de réparation, un seul appel.
  equal(observed.length, 1);
});

// Essai réel : désactivé par défaut (aucun appel réseau sans opt-in explicite).
// Activation : ASSEMBLY_REAL_CLAUDE=1 avec ANTHROPIC_API_KEY présente (même variable
// que src/main.ts) ; modèle = ANTHROPIC_MODEL ou défaut de main.ts.
// Lecture défensive : test:unit tourne sans --allow-env, où Deno.env.get lève.
function envValue(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}
const realApiKey = envValue("ANTHROPIC_API_KEY") ?? "";
const realClaude = readAssemblyEnv("ASSEMBLY_REAL_CLAUDE", envValue) === "1";
const realModel = envValue("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5";

type RealUsage = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
};

/** One process-wide budget, shared by every opted-in real transport test. */
function boundedRealTransport(fetcher: typeof fetch) {
  let requests = 0;
  return {
    get requests() {
      return requests;
    },
    fetch: ((input, init) => {
      if (requests >= 2) {
        throw new Error("Real Claude HTTP request limit reached");
      }
      requests++;
      return fetcher(input, init);
    }) as typeof fetch,
  };
}
const realTransport = boundedRealTransport(fetch);
let reportedRealModel = realModel;

Deno.test("real smoke HTTP budget covers every call including repairs and forbids a third fetch", async () => {
  let reached = 0;
  const bounded = boundedRealTransport(async () => {
    reached++;
    return Response.json({});
  });
  await bounded.fetch("https://fixture.invalid");
  await bounded.fetch("https://fixture.invalid");
  await rejects(
    async () => await bounded.fetch("https://fixture.invalid"),
    /HTTP request limit reached/,
  );
  equal(bounded.requests, 2);
  equal(reached, 2);
});

function realAgent(usages: RealUsage[]) {
  if (!realApiKey) {
    throw new Error("ANTHROPIC_API_KEY unavailable for opted-in smoke test");
  }
  return new ClaudeAgents({
    apiKey: realApiKey,
    model: realModel,
    timeoutMs: 60_000,
    effort: "low",
    decisionMaxTokens: 1024,
    fetch: realTransport.fetch,
    onCompletion: ({ model, usage }) => {
      if (model) reportedRealModel = model;
      usages.push((usage ?? {}) as RealUsage);
    },
  });
}

const realConversation: ChatContext = {
  ...fullContext,
  messages: [{
    id: "m1",
    role: "user",
    text: "Bonjour. Que peux-tu faire pour ce système ?",
    at: "2026-10-25T00:00:00Z",
  }],
};

Deno.test("transport : fetch et AbortError restent bornés, sans corps fournisseur ni cause brute", async () => {
  const secret = "provider-body-and-api-key-must-not-leak";
  const fetchFailure = new Error(secret);
  const failingFetch = new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    fetch: () => Promise.reject(fetchFailure),
  });
  await rejects(() => failingFetch.decide(baseContext), (error: Error) => {
    equal(error.message, "Claude request failed: transport failure");
    equal(error.message.includes(secret), false);
    equal(error.cause, undefined);
    equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
  const abort = new DOMException("aborted elsewhere", "AbortError");
  const abortingFetch = new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    fetch: () => Promise.reject(abort),
  });
  await rejects(() => abortingFetch.decide(baseContext), (error: Error) => {
    equal(error.message, "Claude request failed: transport failure");
    equal(error.cause, undefined);
    return true;
  });
  // Collection failure never changes the decision or repeats the HTTP call.
  const sinkFailure = new Error("completion sink broke");
  const observed: WireBody[] = [];
  const sinkAgent = agentWith(
    [() => toolUseResponse("reply", replyInput())],
    observed,
    {
      onCompletion: () => {
        throw sinkFailure;
      },
    },
  );
  deepStrictEqual(await sinkAgent.decide(baseContext), {
    kind: "reply",
    ...replyInput(),
  });
  const collection = await sinkAgent.completionObservation.close();
  equal(collection.status.dropped.sinkFailure, 1);
  equal(collection.status.written, 0);
  equal(observed.length, 1);
  equal(JSON.stringify(collection).includes(sinkFailure.message), false);
});

Deno.test({
  name: "réel : concepteur à 10 outils sans 400, préfixe relu au second appel",
  ignore: !realClaude,
  async fn() {
    const usages: RealUsage[] = [];
    const agent = realAgent(usages);
    const decisionKinds: string[] = [];
    try {
      for (let turn = 0; turn < 2; turn++) {
        const decision = await agent.decide(realConversation);
        ok(typeof decision.kind === "string" && decision.kind.length > 0);
        decisionKinds.push(decision.kind);
      }
    } finally {
      await agent.completionObservation.close();
      console.log(JSON.stringify({
        model: reportedRealModel,
        httpCount: realTransport.requests,
        decisionKinds,
        usages,
      }));
    }
    // Le second appel relit le préfixe outils + system écrit par le premier.
    ok(
      (usages.at(-1)?.cache_read_input_tokens ?? 0) > 0,
      JSON.stringify(usages),
    );
  },
});

Deno.test({
  name: "réel : revue par l'outil unique review_decision",
  ignore: !realClaude,
  async fn() {
    const usages: RealUsage[] = [];
    const agent = realAgent(usages);
    const decision = await agent.review(candidate, {
      passed: true,
      checks: [{ name: "extract", passed: true, detail: "ok" }],
    });
    equal(decision.candidateDigest, candidate.digest);
    ok(decision.verdict === "approve" || decision.verdict === "refuse");
    await agent.completionObservation.close();
    console.log(JSON.stringify(usages));
  },
});

Deno.test("4.8d D3: a branch Request opening is offered only under the open-request act", async () => {
  const observed: WireBody[] = [];
  const command = {
    objective: "Compare sources",
    openingId: "opening-1",
    source: { kind: "current-main" as const },
    text: "Open a Request",
  };
  const opening = {
    canOpen: true,
    requests: [{
      caseId: "branch-case",
      caseNumber: 3,
      operatorId: "builder",
      executionSpaceId: "branch-space",
      status: "open" as const,
      openedBy: "person" as const,
      team: [],
    }],
    releases: [{ id: "release-1", digest: "a".repeat(64), name: "Pilot" }],
  };
  const agent = agentWith(
    [() => toolUseResponse("open_request", command)],
    observed,
  );
  const decision = await agent.decide({
    ...baseContext,
    requestOpening: opening,
  });
  deepStrictEqual(decision, { kind: "open_request", ...command });
  equal(observed[0].tools.some((tool) => tool.name === "open_request"), true);
  for (
    const context of [
      baseContext,
      { ...baseContext, requestOpening: { ...opening, canOpen: false } },
    ]
  ) {
    const without: WireBody[] = [];
    await agentWith([() => toolUseResponse("reply", replyInput())], without)
      .decide(context);
    equal(without[0].tools.some((tool) => tool.name === "open_request"), false);
  }
  await rejects(
    () =>
      agentWith([() => toolUseResponse("open_request", command)], [])
        .decide({
          ...baseContext,
          requestOpening: { ...opening, canOpen: false },
        }),
  );
});

Deno.test("team creation discovery depends on the pin grant, not live Request capacity", async () => {
  const policy = {
    id: "team-grant",
    revision: 1,
    enabled: true,
    elementId: "native-team-grant",
    sourceIds: ["native-team-grant"],
    holderNativeId: "owner",
    mandateNativeId: "mandate",
    systemId: "system",
    networkHosts: ["example.org"],
    children: [],
    maxChildren: 3,
    maxDelegationDepth: 1,
  };
  const provisionBounds = {
    budget: { maxAgentDecisions: 4, maxToolProposals: 1, maxFlowSteps: 32 },
    networkHosts: ["example.org"],
    mayPropose: [],
    mayInvokeActiveCatalog: false,
    mayConsultModel: true,
    mayProposeSysmlRevision: false,
    mayAddNetworkHosts: true,
  };
  const context: ChatContext = {
    ...baseContext,
    operator: { nativeId: "owner", name: "Owner", instruction: "Research" },
    operatorCreation: { policies: [policy], provisionBounds },
    case: {
      id: "request",
      number: 1,
      type: "request",
      objective: "Research",
      owner: "owner",
      openedBy: "main",
      openedFrom: { conversationId: "main" },
      modelPin: { digest: "admitted" },
      status: "open",
      createdAt: "2026-10-27T03:00:00Z",
    },
  };
  for (
    const [input, exposed] of [
      [context, true],
      [{ ...context, operatorCreation: undefined }, false],
      [{ ...context, case: undefined }, false],
      [{
        ...context,
        operatorCreation: {
          policies: [{ ...policy, enabled: false }],
          provisionBounds,
        },
      }, false],
      [{
        ...context,
        operatorCreation: {
          policies: [{ ...policy, holderNativeId: "other" }],
          provisionBounds,
        },
      }, false],
      [{
        ...context,
        operatorCreation: {
          policies: [{ ...policy, maxChildren: 0 }],
          provisionBounds,
        },
      }, true],
      [{
        ...context,
        case: { ...context.case!, status: "closed-done" as const },
      }, true],
    ] satisfies Array<[ChatContext, boolean]>
  ) {
    const observed: WireBody[] = [];
    const agent = agentWith(
      [() => toolUseResponse("reply", replyInput())],
      observed,
    );
    await agent.decide(input);
    const tool = observed[0]!.tools.find((tool) =>
      tool.name === "propose_agent_creation"
    );
    const inRequest = input.case?.type === "request";
    equal(!!tool, !inRequest || exposed);
    const schema = JSON.stringify(tool?.input_schema ?? {});
    equal(
      schema.includes("request-team-member"),
      exposed,
    );
    // Historical forms remain available only outside a Request.
    equal(schema.includes("firstRequest"), !inRequest);
    equal(schema.includes("reviewer"), !inRequest);
    if (exposed) {
      ok(JSON.stringify(observed[0]!).includes("same originating Request"));
      // The creator's own bounds reach the agent read-only (spec 4.8e E2).
      ok(JSON.stringify(observed[0]!).includes("provisionBounds"));
      ok(!schema.includes("actorId"));
      ok(!schema.includes("teamOrigin"));
    }
  }
});

Deno.test("initial Request owner creation advertises optional human-approved team creation bounds", async () => {
  const observed: WireBody[] = [];
  const operator = {
    instruction: "Own research Requests.",
    networkHosts: [],
    requestType: { name: "Research", maxInvocations: 4 },
    firstRequest: { objective: "Research this question." },
    creationGrant: {
      networkHosts: ["example.org"],
      maxChildren: 3,
      maxDelegationDepth: 1,
    },
  };
  const agent = agentWith([() =>
    toolUseResponse("propose_agent_creation", {
      role: "operator",
      name: "Research",
      reason: "Compose a bounded team",
      text: "Propose the Request owner and its bounded rights",
      operator,
    })], observed);
  const result = await agent.decide(baseContext);
  equal(result.kind, "propose_agent_creation");
  if (result.kind === "propose_agent_creation" && result.role === "operator") {
    deepStrictEqual(result.operator, operator);
  }
  const tool = observed[0]!.tools.find((entry) =>
    entry.name === "propose_agent_creation"
  )!;
  const schema = JSON.stringify(tool.input_schema);
  ok(schema.includes("creationGrant"));
  ok(!schema.includes("request-team-member"));
  ok(!schema.includes("actorId"));
  ok(!schema.includes("teamOrigin"));
  ok(
    JSON.stringify(observed[0]!).includes(
      "subject to the person's approval and source admission",
    ),
  );
  ok(
    JSON.stringify(observed[0]!).includes(
      "Omit it to grant no operator creation rights",
    ),
  );
});

Deno.test("resume Request remains offered with no usable target in Main scope", async () => {
  const command = {
    operatorId: "owner",
    caseId: "request",
    resumeId: "r1",
    instruction: "Collect results",
    text: "Continue",
  };
  const observed: WireBody[] = [];
  const context = {
    ...baseContext,
    requestOpening: {
      canOpen: false,
      requests: [],
      releases: [],
      mainRequests: [{
        caseId: "request",
        operatorId: "owner",
        status: "open" as const,
      }],
    },
  };
  deepStrictEqual(
    await agentWith(
      [() => toolUseResponse("resume_request", command)],
      observed,
    ).decide(context),
    { kind: "resume_request", ...command },
  );
  equal(observed[0].tools.some((tool) => tool.name === "resume_request"), true);
  const closed: WireBody[] = [];
  await agentWith([() => toolUseResponse("reply", replyInput())], closed)
    .decide({
      ...context,
      requestOpening: {
        ...context.requestOpening,
        mainRequests: [{
          ...context.requestOpening.mainRequests[0],
          status: "closed-done",
        }],
      },
    });
  equal(closed[0].tools.some((tool) => tool.name === "resume_request"), true);
  deepStrictEqual(closed[0].tools, observed[0].tools);
});

Deno.test("4.8d Q3: resume_request is offered for an open branch Request", async () => {
  const observed: WireBody[] = [];
  await agentWith([() => toolUseResponse("reply", replyInput())], observed)
    .decide({
      ...baseContext,
      requestOpening: {
        canOpen: false,
        requests: [{
          caseId: "branch-case",
          caseNumber: 4,
          operatorId: "builder",
          executionSpaceId: "branch-space",
          status: "open",
          openedBy: "main-operator",
          team: [],
        }],
        releases: [],
      },
    });
  equal(observed[0].tools.some((tool) => tool.name === "resume_request"), true);
  ok(JSON.stringify(observed[0]).includes("never as the person's"));
});
