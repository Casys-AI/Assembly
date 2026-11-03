// Async fake ports intentionally match the promise-based transport contract.
// deno-lint-ignore-file require-await
import {
  deepStrictEqual,
  equal,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Ajv } from "ajv";
import {
  buildClaudeTools,
  ClaudeAgents,
  decisionSchema,
  MuseAgents,
  type MuseRunRequest,
  type MuseRunResult,
  parseMuseTerminal,
  runMuseExec,
} from "../../src/adapters/out/llm-providers/agents.ts";
import {
  type Candidate,
  TOOL_CONTRACTS,
} from "../../src/domain/work/candidates.ts";
import { type ChatContext } from "../../src/domain/work/dialogue.ts";
import { TOOL_KINDS } from "../../src/domain/shared-kernel/tool-kind.ts";
import { executableFixture } from "../support/execution-fixture.ts";
import { createClaudeToolsFake } from "../support/claude-tools-fake.ts";
import { validateDecision } from "../../src/adapters/out/llm-providers/output-validation.ts";
import { changeDecisionMetadata } from "../../src/domain/governance/operator-authority.ts";
import type { ClaudeFakeAction } from "../support/claude-tools-fake.ts";
import type { ChatDecision } from "../../src/domain/work/dialogue.ts";
import type { ReviewDecision } from "../../src/domain/work/candidates.ts";
import type { OperatorAuthorityPolicy } from "../../src/domain/governance/policies/operator-authority-policy.ts";
import { modelContextTools } from "../../src/domain/model/consultation/context.ts";
const proposalModel = executableFixture({
  projectId: "p",
  editingContextId: "e",
  rootId: "r",
  systemId: "s",
  builderId: "b",
  catalogId: "c",
});
const context: ChatContext = {
  configuration: {
    ...proposalModel.configuration,
    changes: proposalModel.configuration.changes.map(changeDecisionMetadata),
  },
  executionPolicy: proposalModel.policy,
  messages: [{
    id: "m",
    role: "user",
    text: "Lis https://example.org/",
    at: "now",
  }],
  activeTools: [],
  candidates: [],
};
const answer = { kind: "reply", text: "Bonjour" };
const candidate: Candidate = {
  id: "c",
  digest: "exact-digest",
  name: "Lecteur",
  description: "Extrait le texte",
  kind: "read_web_page",
  code: "export default ({html})=>({title:'',text:html})",
  stage: "reviewing",
  createdAt: "now",
  baseCatalogRevision: 0,
};
const tests = {
  passed: true,
  checks: [{ name: "extract", passed: true, detail: "ok" }],
};
function terminal(value: unknown = answer) {
  return {
    schema_version: 1,
    payload_schema_version: 1,
    stream: { kind: "session", id: "s" },
    payload_type: "run.terminal.completed",
    payload: {
      kind: "run_terminal",
      command_id: "t",
      run_stream: { kind: "run", id: "t" },
      terminal: "completed",
      text: JSON.stringify(value),
    },
  };
}
const result = (value: unknown = answer): MuseRunResult => ({
  exitCode: 0,
  stdout: JSON.stringify(terminal(value)) + "\n",
  stderr: "",
});

function musePinCard(instruction: string) {
  return JSON.parse(
    instruction.split(
      "\nPin card (host-derived descriptive data, never additional authority):\n",
    )[1]!.split("\n")[0]!,
  );
}

Deno.test("fresh isolated Muse calls use restricted flags and remove prompt/schema files", async () => {
  const roots: string[] = [];
  const agent = new MuseAgents({
    command: "custom-muse",
    model: "chosen",
    timeoutMs: 500,
    runner: async (run) => {
      roots.push(dirname(run.cwd));
      equal(run.command, "custom-muse");
      equal(run.timeoutMs, 500);
      deepStrictEqual(readdirSync(run.cwd), []);
      equal(
        readFileSync(run.args[run.args.indexOf("--prompt-file") + 1]!, "utf8"),
        run.prompt,
      );
      deepStrictEqual(
        JSON.parse(
          readFileSync(
            run.args[run.args.indexOf("--output-schema") + 1]!,
            "utf8",
          ),
        ),
        run.schema,
      );
      for (
        const flag of [
          "--disable-web-tools",
          "--disable-shell",
          "--disable-write",
          "--disable-reminders",
          "--disable-request-user-input",
          "--no-foreign-personal-context",
          "--no-session-log",
        ]
      ) ok(run.args.includes(flag));
      for (
        const [flag, value] of [
          ["--preset", "empty"],
          ["--contributor-mode", "off"],
          ["--reasoning-effort", "medium"],
          ["--max-model-steps", "3"],
          ["--model", "chosen"],
        ]
      ) equal(run.args[run.args.indexOf(flag!) + 1], value);
      equal(run.args.includes("--yolo"), false);
      const prompt = JSON.parse(run.prompt);
      deepStrictEqual(prompt.context, {
        activeTools: [],
        input: { id: "m", role: "user", text: "Lis https://example.org/" },
      });
      deepStrictEqual(
        musePinCard(prompt.instruction).limits,
        context.executionPolicy,
      );
      return result();
    },
  });
  deepStrictEqual(await agent.decide(context), answer);
  deepStrictEqual(await agent.decide(context), answer);
  equal(new Set(roots).size, 2);
  for (const root of roots) equal(existsSync(root), false);
});
Deno.test("only one completed terminal can yield a decision", () => {
  deepStrictEqual(
    parseMuseTerminal(
      JSON.stringify({
        payload_type: "run.output.delta",
        payload: { text: "irrelevant" },
      }) + "\n" + JSON.stringify(terminal()),
    ),
    answer,
  );
  for (
    const output of [
      "",
      "not json",
      JSON.stringify(answer),
      JSON.stringify({
        payload_type: "run.output.delta",
        payload: { text: JSON.stringify(answer) },
      }),
      JSON.stringify(terminal()) + "\n" + JSON.stringify(terminal()),
      JSON.stringify({ ...terminal(), payload_type: "run.terminal.failed" }),
      JSON.stringify({ ...terminal(), schema_version: 2 }),
      JSON.stringify({
        ...terminal(),
        payload: {
          ...terminal().payload,
          run_stream: { kind: "run", id: "other" },
        },
      }),
      JSON.stringify({
        ...terminal(),
        payload: { ...terminal().payload, text: "not json" },
      }),
    ]
  ) throws(() => parseMuseTerminal(output));
});
Deno.test("decision schema rejects malformed and extra capabilities", async () => {
  for (
    const value of [null, { ...answer, approve: true }, {
      kind: "invoke_tool",
      text: "lecture",
      toolId: "c",
      input: { url: "https://example.org", shell: "rm" },
    }, {
      kind: "propose_tool",
      text: "ok",
      tool: {
        name: candidate.name,
        description: candidate.description,
        code: candidate.code,
        kind: "shell",
      },
    }]
  ) {
    await rejects(
      () =>
        new MuseAgents({ runner: async () => result(value) }).decide(context),
      /schema/,
    );
  }
  for (
    const value of [{
      kind: "invoke_tool",
      text: "lecture",
      toolId: "c",
      input: { url: "https://example.org" },
    }, {
      kind: "propose_tool",
      text: "proposition",
      tool: {
        name: "Lecteur",
        description: "lit",
        kind: "read_web_page",
        code: candidate.code,
      },
    }, {
      kind: "propose_tool",
      text: "proposition de plan",
      tool: {
        name: "Plan",
        description: "Extrait les titres et liens",
        kind: "read_web_page_outline",
        code: candidate.code,
      },
    }]
  ) {
    deepStrictEqual(
      await new MuseAgents({ runner: async () => result(value) }).decide(
        context,
      ),
      value,
    );
  }
});
Deno.test("independent reviewer receives exact code/tests and cannot return another digest", async () => {
  const verdict = {
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason: "Module autonome, tests réussis",
  };
  const agent = new MuseAgents({
    runner: async (run) => {
      const prompt = JSON.parse(run.prompt);
      deepStrictEqual(prompt.candidate, candidate);
      deepStrictEqual(prompt.contract, TOOL_CONTRACTS[0]);
      deepStrictEqual(prompt.tests, tests);
      equal(prompt.candidateDigest, candidate.digest);
      equal(prompt.context, undefined);
      return result(verdict);
    },
  });
  deepStrictEqual(await agent.review(candidate, tests), verdict);
  await rejects(
    () =>
      new MuseAgents({
        runner: async () => result({ ...verdict, candidateDigest: "wrong" }),
      }).review(candidate, tests),
    /digest mismatch/,
  );
  await rejects(
    () =>
      new MuseAgents({
        runner: async () => result({ ...verdict, verdict: "execute" }),
      }).review(candidate, tests),
    /schema/,
  );
});
Deno.test("runner failures are bounded, sanitized, and remove inputs", async () => {
  for (
    const failure of [
      undefined,
      { ...result(), exitCode: 1, stderr: "secret" },
      { ...result(), failureReason: "timeout" as const },
      { ...result(), stdout: "x".repeat(1_000_001) },
      { ...result(), stderr: "x".repeat(32_001) },
    ]
  ) {
    let root = "";
    const agent = new MuseAgents({
      runner: async (run) => {
        root = dirname(run.cwd);
        if (!failure) throw new Error("secret");
        return failure;
      },
    });
    await rejects(() => agent.decide(context), (e: Error) => {
      equal(e.message.includes("secret"), false);
      return true;
    });
    equal(existsSync(root), false);
  }
  throws(() => new MuseAgents({ timeoutMs: 0 }));
  throws(() => new MuseAgents({ command: "bad\0command" }));
});
Deno.test("real subprocess transport captures output, enforces bounds and rejects missing executables", async () => {
  const request: MuseRunRequest = {
    command: Deno.execPath(),
    args: ["eval", "console.log('ok')"],
    cwd: Deno.cwd(),
    prompt: "",
    schema: {},
    timeoutMs: 3000,
    maxStdoutBytes: 100,
    maxStderrBytes: 1000,
  };
  const success = await runMuseExec(request);
  equal(success.exitCode, 0);
  equal(success.stdout.trim(), "ok");
  const overflow = await runMuseExec({
    ...request,
    args: ["eval", "console.log('x'.repeat(200))"],
  });
  equal(overflow.failureReason, "stdout-limit");
  const timeout = await runMuseExec({
    ...request,
    args: ["eval", "setInterval(()=>{},1000)"],
    timeoutMs: 100,
  });
  equal(timeout.failureReason, "timeout");
  await rejects(() =>
    runMuseExec({ ...request, command: "/no-such-ase-muse-command" })
  );
});
// NOTE (lot-2, décision d'Erwan) : l'ancien test exigeait explicitement
// `tools === undefined` ("no tools"). Le nouveau transport décide au
// contraire par appel d'outil natif avec préfixe caché : ce test prouve la
// propriété équivalente — aucun outil hors des kinds autorisés, schémas
// non stricts bornés, préfixe de cache déterministe — au lieu de l'absence
// d'outils, qui contredirait le design.
Deno.test("a well-formed decision of a kind the context does not allow is refused, whatever the transport", async () => {
  const edit = {
    kind: "propose_sysml_edit",
    text: "Renommer",
    reason: "Nom plus clair",
    baseVersion: "commit:base",
    sourceDigest: "a".repeat(64),
    edits: [{ kind: "rename", elementId: "e", name: "Clearer" }],
  };
  // Well-formed: only the guard of the allowed kinds can refuse it.
  equal(validateDecision(edit), true);
  const muse = new MuseAgents({ runner: async () => result(edit) });
  await rejects(() => muse.decide(context), /Invalid agent decision schema/);
});

Deno.test("each transport states its own output format; the shared instructions name none", async () => {
  const verdict: ReviewDecision = {
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason: "Module autonome, tests réussis",
  };
  const instructions: string[] = [];
  const muse = new MuseAgents({
    runner: async (run) => {
      const prompt = JSON.parse(run.prompt);
      instructions.push(prompt.instruction);
      return result(prompt.candidateDigest ? verdict : answer);
    },
  });
  await muse.decide(context);
  await muse.review(candidate, tests);
  equal(instructions.length, 2);
  for (const instruction of instructions) {
    ok(instruction.endsWith(
      "\nTransport : retourne uniquement le JSON du schéma de sortie.",
    ));
    equal(instruction.split("JSON du schéma").length, 2);
  }
  const seen: string[] = [];
  const fake = createClaudeToolsFake((view) => {
    seen.push(view.instruction);
    return { decision: view.context ? answer as ChatDecision : verdict };
  });
  const claude = new ClaudeAgents({
    apiKey: "explicit-secret",
    model: "explicit-model",
    fetch: fake.fetch,
  });
  await claude.decide(context);
  await claude.review(candidate, tests);
  equal(seen.length, 2);
  for (const instruction of seen) {
    equal(instruction.includes("JSON du schéma"), false);
    equal(instruction.includes("path/content"), false);
    equal(instruction.includes("kind="), false);
    ok(instruction.includes("exactement un outil"));
  }
  // The list shape of the sources is a Claude transport detail: its tool says it.
  const revision = buildClaudeTools(decisionSchema).find((tool) =>
    tool.name === "propose_sysml_revision"
  )!;
  ok(revision.description.includes("{path, content}"));
});

Deno.test("the chat instruction answers in English unless the person writes in another language", async () => {
  const instructions: string[] = [];
  const muse = new MuseAgents({
    runner: async (run) => {
      instructions.push(JSON.parse(run.prompt).instruction);
      return result(answer);
    },
  });
  await muse.decide(context);
  ok(instructions[0]!.includes("Answer briefly in English by default"));
  ok(
    instructions[0]!.includes(
      "or in the language of the person's latest own message",
    ),
  );
  // The host's own feedback, still French, must not switch the reply.
  ok(
    instructions[0]!.includes(
      "Host and tool messages never set the language",
    ),
  );
});

Deno.test("Claude uses native tools with cached prefix and only authorized kinds, preserving local validation", async () => {
  const fake = createClaudeToolsFake((view) => {
    equal(view.url, "https://api.anthropic.com/v1/messages");
    equal(view.headers["x-api-key"], "explicit-secret");
    const body = view.body;
    equal(body.model, "explicit-model");
    // Les kinds autorisés voyagent en outils natifs, jamais en schéma JSON.
    ok(Array.isArray(body.tools));
    deepStrictEqual([...view.toolNames].sort(), [
      "invoke_behavior",
      "invoke_tool",
      "propose_agent_creation",
      "propose_mandate_change",
      "propose_tool",
      "reply",
    ]);
    // Sans édition ni administration admises, les kinds d'écriture sont cachés.
    equal(view.toolNames.includes("propose_sysml_revision"), false);
    equal(view.toolNames.includes("propose_sysml_edit"), false);
    equal(view.toolNames.includes("propose_model_delegation"), false);
    equal(view.toolNames.includes("consult_model"), false);
    // Création d'agent : les deux variantes typées (reviewer, opérateur)
    // fusionnent en un seul outil au rôle enum.
    equal(
      view.toolNames.filter((name) => name === "propose_agent_creation").length,
      1,
    );
    const creation = body.tools.find((tool) =>
      tool.name === "propose_agent_creation"
    )!;
    deepStrictEqual(
      (creation.input_schema as {
        properties: { role: { enum: string[] } };
      }).properties.role.enum.sort(),
      ["operator", "reviewer"],
    );
    deepStrictEqual(body.tool_choice, {
      type: "auto",
      disable_parallel_tool_use: true,
    });
    equal(body.thinking, undefined);
    deepStrictEqual(body.output_config, { effort: "high" });
    const schemaText = JSON.stringify(body.tools);
    equal(schemaText.includes("minLength"), false);
    equal(schemaText.includes("maxLength"), false);
    // Claude rejette les bornes numériques ; la validation locale les impose.
    for (const bound of ["minimum", "maximum", "multipleOf"]) {
      equal(schemaText.includes(`"${bound}"`), false, bound);
    }
    equal(schemaText.includes("oneOf"), false);
    equal(schemaText.includes("strict"), false);
    // Préfixe caché : directive outil + dernier outil porteurs du cache.
    equal(body.system.length, 2);
    deepStrictEqual(body.system[1]!.cache_control, { type: "ephemeral" });
    deepStrictEqual(body.tools[body.tools.length - 1]!.cache_control, {
      type: "ephemeral",
    });
    equal(body.max_tokens, 4096);
    return { decision: { ...answer, kind: "reply" as const } };
  });
  const agent = new ClaudeAgents({
    apiKey: "explicit-secret",
    model: "explicit-model",
    fetch: fake.fetch,
  });
  deepStrictEqual(await agent.decide(context), answer);
  equal(fake.views.length, 1);
  await rejects(
    () =>
      new ClaudeAgents({
        apiKey: "key",
        model: "m",
        fetch: createClaudeToolsFake(() => ({
          toolUse: { name: "reply", input: { text: "" } },
        })).fetch,
      }).decide(context),
    /schema/,
  );
  await rejects(
    () =>
      new ClaudeAgents({
        apiKey: "explicit-secret",
        model: "m",
        fetch: createClaudeToolsFake(() => {
          throw new Error("explicit-secret");
        }).fetch,
      }).decide(context),
    (e: Error) => !e.message.includes("explicit-secret"),
  );
});
Deno.test("Claude reviewer is a fresh request with exact digest, separate prompt and bounded tokens", async () => {
  const fake = createClaudeToolsFake((view) => {
    equal(view.body.messages.length, 1);
    const review = view.payload.candidateDigest !== undefined;
    equal(view.body.max_tokens, review ? 2048 : 4096);
    return {
      decision: review
        ? {
          candidateDigest: candidate.digest,
          verdict: "approve" as const,
          reason: "ok",
        }
        : { ...answer, kind: "reply" as const },
    };
  });
  const agent = new ClaudeAgents({
    apiKey: "key",
    model: "m",
    fetch: fake.fetch,
  });
  await agent.decide(context);
  await agent.review(candidate, tests);
  const review = fake.views[1]!.payload as unknown as {
    context: unknown;
    candidate: unknown;
    tests: unknown;
  };
  equal(review.context, undefined);
  deepStrictEqual(review.candidate, candidate);
  deepStrictEqual(review.tests, tests);
  equal(fake.views.length, 2);
});
Deno.test("Claude rejects incomplete, duplicate, oversized and failed responses without reflecting bodies", async () => {
  // [action, catégorie exacte, appels] : les réponses terminales échouent en
  // 1 appel, les réponses réparables (outil inconnu, aucun appel) en 2.
  const cases: Array<[ClaudeFakeAction | Response, string, number]> = [
    [{ httpStatus: 401, bodyText: "secret-key-body" }, "HTTP 401", 1],
    [
      { httpStatus: 200, bodyText: "not JSON secret-key-body" },
      "invalid response JSON",
      1,
    ],
    [
      { stopReason: "max_tokens", content: [] },
      "output token limit reached (max_tokens)",
      1,
    ],
    [
      { stopReason: "refusal", content: [] },
      "incomplete completion (refusal)",
      1,
    ],
    [
      { toolUse: { name: "other", input: answer } },
      "invalid tool decision schema after repair (UNKNOWN_TOOL)",
      2,
    ],
    [
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "{}" }, { type: "text", text: "{}" }],
      },
      "invalid tool decision schema after repair (NO_TOOL_CALL)",
      2,
    ],
    [
      { text: JSON.stringify({ kind: "reply", text: "Bonjour", extra: true }) },
      "invalid tool decision schema after repair (NO_TOOL_CALL)",
      2,
    ],
    [new Response("x".repeat(1_000_001)), "response-size limit exceeded", 1],
  ];
  for (const [action, category, calls] of cases) {
    const fake = createClaudeToolsFake(() => action);
    await rejects(
      () =>
        new ClaudeAgents({
          apiKey: "key",
          model: "m",
          fetch: fake.fetch,
        }).decide(context),
      (e: Error) => {
        equal(e.message, `Claude request failed: ${category}`);
        equal(e.message.includes("secret-key-body"), false);
        return true;
      },
    );
    equal(fake.views.length, calls);
  }
  const timeout = createClaudeToolsFake((view) =>
    new Promise((_resolve, reject) => {
      view.signal?.addEventListener(
        "abort",
        () => reject(new Error("abort-secret")),
        { once: true },
      );
    })
  );
  await rejects(
    () =>
      new ClaudeAgents({
        apiKey: "key",
        model: "m",
        timeoutMs: 10,
        fetch: timeout.fetch,
      }).decide(context),
    (e: Error) => !e.message.includes("abort-secret"),
  );
  equal(timeout.views.length, 1);
  const digest = createClaudeToolsFake(() => ({
    decision: {
      candidateDigest: "wrong",
      verdict: "approve" as const,
      reason: "ok",
    },
  }));
  await rejects(
    () =>
      new ClaudeAgents({
        apiKey: "key",
        model: "m",
        fetch: digest.fetch,
      }).review(candidate, tests),
    /digest mismatch/,
  );
  equal(digest.views.length, 1);
});

Deno.test("Claude builder and reviewer receive the host's two exact contracts and outline-specific criteria", async () => {
  const outline = { ...candidate, kind: "read_web_page_outline" as const };
  const fake = createClaudeToolsFake((view) => {
    const review = view.payload.candidateDigest !== undefined;
    return {
      decision: review
        ? {
          candidateDigest: outline.digest,
          verdict: "approve" as const,
          reason: "Plan conforme",
        }
        : {
          kind: "propose_tool" as const,
          text: "Plan",
          tool: {
            name: outline.name,
            description: outline.description,
            kind: outline.kind,
            code: outline.code,
          },
        },
    };
  });
  const agent = new ClaudeAgents({
    apiKey: "test-key",
    model: "test-model",
    fetch: fake.fetch,
  });
  const hostContext = {
    ...context,
    mandate: {
      id: "builder-v1" as const,
      mayPropose: TOOL_KINDS,
      mayInvoke: "active-catalog-only" as const,
      mayReview: false as const,
      mayActivate: false as const,
      network: { allowedHosts: ["example.org"] },
      supportedChanges: [],
    },
    contracts: TOOL_CONTRACTS,
  };
  const decision = await agent.decide(hostContext);
  equal(decision.kind, "propose_tool");
  const decideView = fake.views[0]!;
  deepStrictEqual(
    decideView.pinCard?.contracts,
    TOOL_CONTRACTS,
  );
  ok(/exact admitted kind and acceptanceCriteria/.test(decideView.instruction));
  ok(/acceptanceCriteria/.test(decideView.instruction));
  await agent.review(outline, tests);
  const reviewPayload = fake.views[1]!.payload as unknown as {
    contract: unknown;
    tests: unknown;
    candidate: Candidate;
    instruction: unknown;
  };
  deepStrictEqual(reviewPayload.contract, TOOL_CONTRACTS[1]);
  deepStrictEqual(reviewPayload.tests, tests);
  equal(reviewPayload.candidate.kind, "read_web_page_outline");
  ok(
    String(fake.views[1]!.instruction).includes(
      "sans devoir préserver toute la prose",
    ),
  );
  const requestCount = fake.views.length;
  await rejects(
    () =>
      agent.review(
        { ...outline, kind: "shell" } as unknown as Candidate,
        tests,
      ),
    /Unsupported/,
  );
  equal(fake.views.length, requestCount);
});

Deno.test("Claude failure diagnostics distinguish bounded categories without provider text or extra calls", async () => {
  const privateText = "PRIVATE_PROVIDER_BODY_KEY_PROMPT";
  // [action, catégorie exacte, appels] : les réponses terminales échouent en
  // 1 appel ; un contenu sans appel d'outil déclenche l'unique réparation.
  const cases: Array<[ClaudeFakeAction | Response, string, number]> = [
    [{ httpStatus: 429, bodyText: privateText }, "HTTP 429", 1],
    [{ httpStatus: 400, bodyText: privateText }, "HTTP 400", 1],
    [new Response(null), "missing response body", 1],
    [{ httpStatus: 200, bodyText: privateText }, "invalid response JSON", 1],
    [Response.json(null), "invalid response shape", 1],
    [
      {
        stopReason: "max_tokens",
        content: [{ type: "text", text: privateText }],
      },
      "output token limit reached (max_tokens)",
      1,
    ],
    [
      { stopReason: "refusal", content: [] },
      "incomplete completion (refusal)",
      1,
    ],
    [
      { stopReason: privateText, content: [] },
      "incomplete completion",
      1,
    ],
    [
      Response.json({ stop_reason: "end_turn", content: privateText }),
      "invalid response shape",
      1,
    ],
    [
      { stopReason: "end_turn", content: [] },
      "invalid tool decision schema after repair (NO_TOOL_CALL)",
      2,
    ],
    [
      { text: privateText },
      "invalid tool decision schema after repair (NO_TOOL_CALL)",
      2,
    ],
    [
      { text: JSON.stringify({ privateText }) },
      "invalid tool decision schema after repair (NO_TOOL_CALL)",
      2,
    ],
    [
      new Response(privateText.repeat(40_000)),
      "response-size limit exceeded",
      1,
    ],
  ];
  for (const [action, category, calls] of cases) {
    const fake = createClaudeToolsFake(() => action);
    const agent = new ClaudeAgents({
      apiKey: privateText,
      model: "model",
      fetch: fake.fetch,
    });
    await rejects(() => agent.decide(context), (error: Error) => {
      equal(
        error.message,
        `Claude request failed: ${category}`,
        `failure fixture ${cases.findIndex((entry) => entry[0] === action)}`,
      );
      equal(error.message.includes(privateText), false);
      return true;
    });
    equal(fake.views.length, calls);
  }
  const transportFailure = createClaudeToolsFake(() => {
    throw new Error(privateText);
  });
  await rejects(
    () =>
      new ClaudeAgents({
        apiKey: privateText,
        model: "model",
        fetch: transportFailure.fetch,
      }).decide(context),
    (error: Error) => {
      equal(error.message, "Claude request failed: transport failure");
      equal(error.message.includes(privateText), false);
      return true;
    },
  );
  equal(transportFailure.views.length, 1);
  const timeout = createClaudeToolsFake((view) =>
    new Promise((_resolve, reject) => {
      view.signal?.addEventListener(
        "abort",
        () => reject(new Error(privateText)),
        { once: true },
      );
    })
  );
  const timeoutAgent = new ClaudeAgents({
    apiKey: privateText,
    model: "model",
    timeoutMs: 10,
    fetch: timeout.fetch,
  });
  await rejects(() => timeoutAgent.decide(context), {
    message: "Claude request failed: request timed out",
  });
  equal(timeout.views.length, 1);
});

Deno.test("governance decisions expose exact requested rights without admitting them", async () => {
  const mandate: ChatDecision = {
    kind: "propose_mandate_change",
    text: "Je propose une délégation limitée à mes candidats.",
    reason: "Demande explicite de l’utilisateur.",
    requestedRights: { mayAdmitOwnCandidates: true },
  };
  const creation: ChatDecision = {
    kind: "propose_agent_creation",
    text: "Je propose un examinateur indépendant.",
    reason: "Séparer la construction et l’admission.",
    name: "Examinateur",
    role: "reviewer",
    mandate: {
      mayReviewExactCandidate: true,
      mayAdmitReviewedCandidates: true,
    },
  };
  const before = structuredClone(context);
  for (const proposal of [mandate, creation]) {
    deepStrictEqual(
      await new MuseAgents({ runner: async () => result(proposal) }).decide(
        context,
      ),
      proposal,
    );
    const fake = createClaudeToolsFake((view) => {
      ok(view.instruction.includes("propose_mandate_change"));
      ok(view.instruction.includes("propose_agent_creation"));
      ok(
        /subject to the person's approval and source admission/.test(
          view.instruction,
        ),
      );
      ok(
        /Required human admission is a separate command, not chat consent/.test(
          view.instruction,
        ),
      );
      ok(
        /A proposal grants nothing/.test(
          view.instruction,
        ),
      );
      const change = view.body.tools.find((tool) =>
        tool.name === "propose_mandate_change"
      )!;
      const rights = (change.input_schema as {
        properties: {
          requestedRights: {
            anyOf: Array<{ required: string[]; additionalProperties: boolean }>;
          };
        };
      }).properties.requestedRights.anyOf;
      equal(rights.length, 5);
      deepStrictEqual(
        rights.map((branch) => branch.required),
        [
          ["mayAdmitOwnCandidates"],
          ["grantModelEditing"],
          ["operatorAuthority"],
          ["addNetworkHosts"],
          ["setUrlSelectionMode"],
        ],
      );
      for (const branch of rights) equal(branch.additionalProperties, false);
      return { decision: proposal };
    });
    const claude = new ClaudeAgents({
      apiKey: "fixture-key",
      model: "fixture-model",
      fetch: fake.fetch,
    });
    deepStrictEqual(await claude.decide(context), proposal);
    equal(fake.views.length, 1);
  }
  deepStrictEqual(context, before);
  for (
    const invalid of [
      {
        ...mandate,
        requestedRights: { mayAdmitOwnCandidates: true, mayActivate: true },
      },
      {
        ...mandate,
        requestedRights: { mayAdmitOwnCandidates: true, mayCreateAgents: true },
      },
      { ...mandate, requestedRights: { mayAdmitOwnCandidates: false } },
      { ...mandate, requestedRights: {} },
      { ...mandate, requestedRights: { mayAdmitOwnCandidates: "true" } },
      { ...mandate, admitted: true },
      { ...creation, role: "administrator" },
      { ...creation, mandate: { ...creation.mandate, mayActivate: true } },
      {
        ...creation,
        mandate: { ...creation.mandate, mayChangeOwnMandate: true },
      },
      {
        ...creation,
        mandate: { ...creation.mandate, mayReviewExactCandidate: false },
      },
      { ...creation, name: "" },
      { ...creation, name: "x".repeat(121) },
      { ...creation, reason: "" },
      { kind: "change_mandate", text: "Je m’accorde des droits" },
      { kind: "create_agent", text: "Examinateur créé" },
    ]
  ) {
    await rejects(
      () =>
        new MuseAgents({ runner: async () => result(invalid) }).decide(context),
      /schema/,
    );
    await rejects(() => {
      // Appel brut sans `kind` : le transport valide l'input contre l'outil
      // nommé, puis refuse après l'unique réparation (UNKNOWN_TOOL inclus).
      const { kind, ...input } = invalid;
      const fake = createClaudeToolsFake(() => ({
        toolUse: { name: kind, input },
      }));
      return new ClaudeAgents({
        apiKey: "fixture-key",
        model: "fixture-model",
        fetch: fake.fetch,
      }).decide(context);
    }, /schema/);
  }
  deepStrictEqual(context, before);
});

Deno.test("adaptation receives readable scope and structured failure, then returns a narrow proposal", async () => {
  const hostContext: ChatContext = {
    ...context,
    messages: [...context.messages, {
      id: "failed-invocation",
      role: "tool",
      text: "Lecture refusée par le périmètre réseau.",
      at: "now",
    }],
    mandate: {
      id: "builder-v1",
      mayPropose: TOOL_KINDS,
      mayInvoke: "active-catalog-only",
      mayReview: false,
      mayActivate: false,
      network: { allowedHosts: ["example.org"] },
      supportedChanges: [{
        kind: "propose_mandate_change",
        requestedRights: "addNetworkHosts",
        description: "Proposer des hôtes publics exacts supplémentaires.",
      }],
    },
    lastToolFailure: {
      code: "NETWORK_SCOPE_DENIED",
      message: "Hôte hors périmètre autorisé.",
      retryable: false,
      toolId: "active-reader",
      url: "https://docs.example.net/guide",
      missingPermission: { kind: "network-host", host: "docs.example.net" },
      allowedHosts: ["example.org"],
    },
  };
  const proposal: ChatDecision = {
    kind: "propose_mandate_change",
    text: "La lecture requiert l’admission de cet hôte supplémentaire.",
    reason: "Le courtier refuse l’hôte demandé pour cette lecture.",
    requestedRights: { addNetworkHosts: ["docs.example.net"] },
  };
  // Native observations carry the exact failure once, outside the opening brief.
  const observedFailure = {
    status: "failed",
    code: "NETWORK_SCOPE_DENIED",
    value: { succeeded: false, failure: hostContext.lastToolFailure },
  };
  const previousResult = {
    id: "failed-read",
    result: JSON.stringify(observedFailure),
    isError: true,
  };
  hostContext.toolCallHistory = [{
    assistantBlocks: [{
      type: "tool_use",
      id: previousResult.id,
      name: "invoke_tool",
      input: {
        text: "Read the guide",
        toolId: "active-reader",
        input: { url: "https://docs.example.net/guide" },
      },
    }],
    results: [previousResult],
  }];
  const before = structuredClone(hostContext);
  const inspectPrompt = (
    brief: unknown,
    pin: Record<string, unknown> | undefined,
    instruction: string,
    observation: string,
  ) => {
    deepStrictEqual(brief, {
      activeTools: [],
      input: { id: "m", role: "user", text: "Lis https://example.org/" },
    });
    deepStrictEqual(pin?.mandate, hostContext.mandate);
    deepStrictEqual(JSON.parse(observation), observedFailure);
    for (
      const expected of [
        "exact allowedHosts",
        "only a supported variant",
        "After failure follow its code, context and recovery",
        "A network denial is not a parser defect",
        "Propose a missing exact host only if the mandate permits it",
        "A person's bare DNS domain denotes its HTTPS page",
        "Do not retry unchanged arguments against an unchanged failure",
        "Required human admission is a separate command, not chat consent",
      ]
    ) ok(instruction.includes(expected), expected);
    equal(instruction.includes("casys.ai"), false);
  };
  const muse = new MuseAgents({
    runner: async (run) => {
      const prompt = JSON.parse(run.prompt);
      deepStrictEqual(prompt.history, [{
        completedToolCalls: [previousResult],
      }]);
      inspectPrompt(
        prompt.context,
        musePinCard(prompt.instruction),
        prompt.instruction,
        prompt.history[0].completedToolCalls[0].result,
      );
      return result(proposal);
    },
  });
  const claudeFake = createClaudeToolsFake((view) => {
    const observations = view.body.messages.flatMap((message) =>
      message.content.filter((block) => block.type === "tool_result")
    );
    equal(observations.length, 1);
    equal(observations[0]!.tool_use_id, previousResult.id);
    equal(observations[0]!.is_error, true);
    inspectPrompt(
      view.context,
      view.pinCard,
      view.instruction,
      String(observations[0]!.content),
    );
    const change = view.body.tools.find((tool) =>
      tool.name === "propose_mandate_change"
    )!;
    const rights = (change.input_schema as {
      properties: {
        requestedRights: {
          anyOf: Array<{
            required: string[];
            additionalProperties: boolean;
            properties: { addNetworkHosts: { type: string } };
          }>;
        };
      };
    }).properties.requestedRights.anyOf;
    deepStrictEqual(
      rights.map((branch) => branch.required),
      [
        ["mayAdmitOwnCandidates"],
        ["grantModelEditing"],
        ["operatorAuthority"],
        ["addNetworkHosts"],
        ["setUrlSelectionMode"],
      ],
    );
    equal(rights[3]!.additionalProperties, false);
    equal(rights[3]!.properties.addNetworkHosts.type, "array");
    const schemaText = JSON.stringify(view.body.tools);
    for (
      const unsupported of [
        "oneOf",
        "pattern",
        "minItems",
        "maxItems",
        "uniqueItems",
      ]
    ) {
      equal(schemaText.includes(unsupported), false);
    }
    return { decision: proposal };
  });
  const claude = new ClaudeAgents({
    apiKey: "fixture-key",
    model: "fixture-model",
    fetch: claudeFake.fetch,
  });
  deepStrictEqual(await muse.decide(hostContext), proposal);
  deepStrictEqual(await claude.decide(hostContext), proposal);
  equal(claudeFake.views.length, 1);
  deepStrictEqual(hostContext, before);
});

Deno.test("both providers locally reject wildcard, combined, and overly broad network requests", async () => {
  const proposal = {
    kind: "propose_mandate_change",
    text: "Demande réseau limitée.",
    reason: "Lire la page demandée.",
    requestedRights: { addNetworkHosts: ["docs.example.net"] },
  };
  for (
    const requestedRights of [
      { addNetworkHosts: ["*"] },
      { addNetworkHosts: ["*.example.net"] },
      { addNetworkHosts: ["https://docs.example.net/"] },
      { addNetworkHosts: ["docs.example.net:443"] },
      { addNetworkHosts: ["127.0.0.1"] },
      { addNetworkHosts: ["localhost"] },
      { addNetworkHosts: [] },
      { addNetworkHosts: ["docs.example.net", "docs.example.net"] },
      {
        addNetworkHosts: Array.from(
          { length: 9 },
          (_, n) => `host${n}.example.net`,
        ),
      },
      { addNetworkHosts: ["docs.example.net"], mayAdmitOwnCandidates: true },
      { addNetworkHosts: ["docs.example.net"], mayActivate: true },
      { addNetworkHosts: ["docs.example.net"], allowAllNetwork: true },
      { allowedHosts: ["docs.example.net"] },
      { addNetworkHosts: ["docs.example.net"], removeNetworkHosts: [] },
    ]
  ) {
    const invalid = { ...proposal, requestedRights };
    await rejects(() =>
      new MuseAgents({
        runner: async () => result(invalid),
      }).decide(context), /schema/);
    await rejects(() => {
      const { kind, ...input } = invalid;
      const fake = createClaudeToolsFake(() => ({
        toolUse: { name: kind, input },
      }));
      return new ClaudeAgents({
        apiKey: "fixture-key",
        model: "fixture-model",
        fetch: fake.fetch,
      }).decide(context);
    }, /schema/);
  }
});

Deno.test("delegated builder admission is an actual separate digest-bound decision", async () => {
  const authority = {
    builderId: "builder-registered",
    mandateRevision: 2,
    configurationRevision: 4,
    mayAdmitOwnCandidates: true as const,
  };
  const verdict: ReviewDecision = {
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason: "Contrat respecté et preuves de tests examinées.",
  };
  const prompts: Array<Record<string, unknown>> = [];
  const muse = new MuseAgents({
    runner: async (run) => {
      prompts.push(JSON.parse(run.prompt));
      return result(verdict);
    },
  });
  deepStrictEqual(await muse.admit(candidate, tests, authority), verdict);
  deepStrictEqual(prompts[0]!.authorityContext, authority);
  deepStrictEqual(prompts[0]!.candidate, candidate);
  deepStrictEqual(prompts[0]!.tests, tests);
  deepStrictEqual(prompts[0]!.contract, TOOL_CONTRACTS[0]);
  equal(prompts[0]!.context, undefined);
  ok(
    String(prompts[0]!.instruction).includes(
      "Il ne s’agit pas d’une revue indépendante",
    ),
  );
  const admitFake = createClaudeToolsFake((view) => {
    equal(view.body.max_tokens, 2048);
    // L'admission décide par l'outil unique de revue, jamais en texte libre.
    deepStrictEqual(view.toolNames, ["review_decision"]);
    const payload = view.payload as unknown as {
      authorityContext: unknown;
      candidateDigest: string;
    };
    deepStrictEqual(payload.authorityContext, authority);
    equal(payload.candidateDigest, candidate.digest);
    return { decision: verdict };
  });
  const claude = new ClaudeAgents({
    apiKey: "fixture-key",
    model: "fixture-model",
    fetch: admitFake.fetch,
  });
  deepStrictEqual(await claude.admit(candidate, tests, authority), verdict);
  equal(admitFake.views.length, 1);
  for (
    const malformed of [
      { ...verdict, candidateDigest: "different" },
      { ...verdict, verdict: "activate" },
      { ...verdict, grantOwnRights: true },
    ]
  ) {
    await rejects(() =>
      new MuseAgents({
        runner: async () => result(malformed),
      }).admit(candidate, tests, authority), /digest mismatch|schema/);
  }
  const count = prompts.length;
  for (
    const invalid of [
      { ...authority, builderId: "" },
      { ...authority, mayAdmitOwnCandidates: false },
      { ...authority, mandateRevision: -1 },
      { ...authority, configurationRevision: 1.5 },
    ]
  ) {
    await rejects(
      () => muse.admit(candidate, tests, invalid as typeof authority),
      /authority context/,
    );
  }
  await rejects(
    () =>
      muse.admit(
        { ...candidate, kind: "shell" } as unknown as Candidate,
        tests,
        authority,
      ),
    /Unsupported/,
  );
  equal(prompts.length, count);
});

Deno.test("registered reviewer request carries its exact host mandate and identity", async () => {
  const reviewer = {
    reviewerId: "reviewer-created-by-human-command",
    mandate: {
      mayReviewExactCandidate: true as const,
      mayAdmitReviewedCandidates: true as const,
      mayActivate: false as const,
    },
  };
  let calls = 0;
  const agent = new MuseAgents({
    runner: async (run) => {
      calls++;
      const prompt = JSON.parse(run.prompt);
      equal(prompt.reviewerId, reviewer.reviewerId);
      deepStrictEqual(prompt.mandate, reviewer.mandate);
      equal(prompt.authorityContext, undefined);
      ok(prompt.instruction.includes("mayAdmitReviewedCandidates"));
      return result({
        candidateDigest: candidate.digest,
        verdict: "refuse",
        reason: "Refus motivé",
      });
    },
  });
  equal((await agent.review(candidate, tests, reviewer)).verdict, "refuse");
  equal(calls, 1);
  for (
    const invalid of [
      { ...reviewer, reviewerId: "" },
      { ...reviewer, mandate: { ...reviewer.mandate, mayActivate: true } },
      {
        ...reviewer,
        mandate: { ...reviewer.mandate, mayReviewExactCandidate: false },
      },
    ]
  ) {
    await rejects(
      () => agent.review(candidate, tests, invalid as typeof reviewer),
      /authority context/,
    );
  }
  equal(calls, 1);
});

Deno.test("exact URL selection and bounded relative SysML proposals are locally validated", async () => {
  const revisionContext: ChatContext = {
    ...context,
    modelEditing: {
      targetedEdits: false,
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
        operations: ["replace-source"],
        grants: [{ file: "models/configuration.sysml", qualifiedRoots: [] }],
      },
    },
  };
  const sourceProposal: ChatDecision = {
    kind: "propose_sysml_revision",
    text: "Proposition de modèle",
    reason: "Ajuster le comportement natif",
    baseVersion: "commit-digest",
    sources: { "models/configuration.sysml": "package Fixture {}" },
  };
  const urlProposal: ChatDecision = {
    kind: "propose_mandate_change",
    text: "Sélection URL",
    reason: "Choisir un hôte autorisé",
    requestedRights: { setUrlSelectionMode: "authorized-host" },
  };
  for (
    const value of [sourceProposal, urlProposal, {
      ...urlProposal,
      requestedRights: { setUrlSelectionMode: "user-provided" as const },
    }]
  ) {
    deepStrictEqual(
      await new MuseAgents({ runner: async () => result(value) }).decide(
        revisionContext,
      ),
      value,
    );
    const decided = await new ClaudeAgents({
      apiKey: "fixture-key",
      model: "fixture-model",
      fetch: createClaudeToolsFake(() => ({ decision: value })).fetch,
    }).decide(revisionContext);
    // Le transport recanonise `sources` en carte à prototype nul
    // (agents.ts) : comparaison sur une copie à prototype ordinaire.
    deepStrictEqual(
      decided.kind === "propose_sysml_revision"
        ? { ...decided, sources: { ...decided.sources } }
        : decided,
      value,
    );
  }
  const invalid = [
    { ...urlProposal, requestedRights: { setUrlSelectionMode: "any" } },
    {
      ...urlProposal,
      requestedRights: {
        setUrlSelectionMode: "authorized-host",
        mayAdmitOwnCandidates: true,
      },
    },
    { ...sourceProposal, approved: true },
    { ...sourceProposal, baseVersion: "" },
    { ...sourceProposal, sources: {} },
    { ...sourceProposal, sources: { "model.sysml": "x".repeat(100001) } },
    {
      ...sourceProposal,
      sources: Object.fromEntries(
        Array.from({ length: 17 }, (_, n) => [`m${n}.sysml`, "package X {} "]),
      ),
    },
    ...[
      "../model.sysml",
      "models/../model.sysml",
      "/model.sysml",
      "C:/model.sysml",
      "models\\model.sysml",
      "models//model.sysml",
      "./model.sysml",
      "model.ts",
      "models/%2e%2e/model.sysml",
    ].map((path) => ({
      ...sourceProposal,
      sources: { [path]: "package X {}" },
    })),
  ];
  for (const value of invalid) {
    await rejects(
      () =>
        new MuseAgents({ runner: async () => result(value) }).decide(context),
      /schema/,
    );
    // Contexte avec révision admise : l'outil est offert, chaque forme
    // invalide échoue la canonisation ou la validation locale (INVALID_TOOL_INPUT).
    await rejects(() => {
      const record = value as unknown as Record<string, unknown>;
      const kind = record.kind as string;
      const { kind: _kind, ...rest } = record;
      const map = rest.sources as Record<string, string> | undefined;
      const input = map !== undefined && kind === "propose_sysml_revision"
        ? {
          ...rest,
          sources: Object.entries(map).map(([path, content]) => ({
            path,
            content,
          })),
        }
        : rest;
      const fake = createClaudeToolsFake(() => ({
        toolUse: { name: kind, input },
      }));
      return new ClaudeAgents({
        apiKey: "fixture-key",
        model: "fixture-model",
        fetch: fake.fetch,
      }).decide(revisionContext);
    }, /schema/);
  }
});

const authorityPolicy: OperatorAuthorityPolicy = {
  id: "research-network",
  revision: 1,
  elementId: "policy",
  sourceIds: [],
  enabled: true,
  recipients: ["native:research"],
  acts: ["addNetworkHosts"],
  networkHosts: ["example.org"],
  toolIds: [],
  maxDelegationDepth: 0,
  holderNativeId: "b",
  mandateNativeId: "m",
  systemId: "s",
};
const policyProposal: ChatDecision = {
  kind: "propose_mandate_change",
  text: "Request bounded authority",
  reason: "Let the person decide the policy",
  requestedRights: {
    operatorAuthority: {
      policyId: "research-network",
      expectedPolicyRevision: 0,
      enabled: true,
      recipients: ["native:research"],
      acts: ["addNetworkHosts"],
      networkHosts: ["example.org"],
      toolIds: [],
      maxDelegationDepth: 0,
    },
  },
};
const operatorDecision: ChatDecision = {
  kind: "decide_operator_change",
  text: "Approve the covered request",
  operatorId: "native:research",
  changeId: "change-1",
  expectedRevision: 0,
  policyId: "research-network",
  policyRevision: 1,
  verdict: "approve",
};
const delegatedContext: ChatContext = {
  ...context,
  operatorAuthority: {
    policies: [authorityPolicy],
    requests: [],
    awaitingPerson: [],
    awaitingPersonTruncated: false,
  },
};

for (const provider of ["Claude", "Muse"] as const) {
  const agent = (decision: ChatDecision) =>
    provider === "Claude"
      ? new ClaudeAgents({
        apiKey: "fixture",
        model: "fixture",
        fetch: createClaudeToolsFake(() => ({ decision })).fetch,
      })
      : new MuseAgents({ runner: async () => result(decision) });
  Deno.test(`${provider} transports operator authority decisions unchanged for the host to judge`, async () => {
    deepStrictEqual(
      await agent(policyProposal).decide(context),
      policyProposal,
    );
    deepStrictEqual(
      await agent(operatorDecision).decide(delegatedContext),
      operatorDecision,
    );
  });
}

Deno.test("a well-formed decide_operator_change without an admitted policy is refused, whatever the transport", async () => {
  equal(validateDecision(operatorDecision), true);
  for (
    const noPolicy of [
      context,
      {
        ...context,
        operatorAuthority: {
          policies: [],
          requests: [],
          awaitingPerson: [],
          awaitingPersonTruncated: false,
        },
      },
    ]
  ) {
    await rejects(
      () =>
        new MuseAgents({ runner: async () => result(operatorDecision) })
          .decide(noPolicy),
      /Invalid agent decision schema/,
    );
  }
});

Deno.test("the operator authority guidance is cached with its admitted context and stays stable across observations", async () => {
  const seen: { systemText: string; instruction: string }[] = [];
  const fake = createClaudeToolsFake((view) => {
    seen.push({ systemText: view.systemText, instruction: view.instruction });
    return { decision: { kind: "reply", text: "Ready" } };
  });
  const claude = new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    fetch: fake.fetch,
  });
  await claude.decide(context);
  await claude.decide(delegatedContext);
  await claude.decide({
    ...delegatedContext,
    messages: [...delegatedContext.messages, {
      id: "next",
      role: "user",
      text: "What is pending now?",
      at: "later",
    }],
    operatorAuthority: { ...delegatedContext.operatorAuthority!, requests: [] },
  });
  await claude.decide(context);
  equal(seen.length, 4);
  equal(seen[0]!.instruction.includes("decide_operator_change"), false);
  equal(seen[1]!.instruction.includes("decide_operator_change"), true);
  equal(seen[1]!.systemText.includes("decide_operator_change"), true);
  equal(seen[1]!.systemText, seen[2]!.systemText);
  equal(seen[0]!.systemText, seen[3]!.systemText);
  for (const view of fake.views) {
    deepStrictEqual(view.body.system.at(-1)!.cache_control, {
      type: "ephemeral",
    });
  }
});

Deno.test("a malformed decide_operator_change input is repaired through the native tool result", async () => {
  const fake = createClaudeToolsFake((view) =>
    view.isRepair ? { decision: operatorDecision } : {
      toolUse: {
        name: "decide_operator_change",
        input: { ...operatorDecision, kind: undefined, verdict: "accept" },
      },
    }
  );
  const decision = await new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    fetch: fake.fetch,
  }).decide(delegatedContext);
  deepStrictEqual(decision, operatorDecision);
  equal(fake.views.length, 2);
  equal(fake.views[1]!.repair?.code, "INVALID_TOOL_INPUT");
});

Deno.test("Muse batches preserve distinct call IDs with the filtered bounded JSON schema", async () => {
  const readContext: ChatContext = {
    ...context,
    modelTools: modelContextTools(),
  };
  const calls = [
    {
      id: "read-a",
      decision: {
        kind: "consult_model",
        text: "Inspect a",
        inputJson:
          '{"operation":"inspect","version":"commit:base","elementId":"a"}',
      },
    },
    {
      id: "read-b",
      decision: {
        kind: "consult_model",
        text: "Inspect b",
        inputJson:
          '{"operation":"inspect","version":"commit:base","elementId":"b"}',
      },
    },
  ];
  let runs = 0;
  const muse = new MuseAgents({
    runner: async (request) => {
      runs++;
      const validate = new Ajv({ strict: true }).compile(request.schema);
      ok(validate({ calls }), JSON.stringify(validate.errors));
      const schema = request.schema as {
        properties: {
          calls: {
            maxItems: number;
            items: { properties: { decision: typeof decisionSchema } };
          };
        };
      };
      equal(schema.properties.calls.maxItems, 8);
      const variants = schema.properties.calls.items.properties.decision.oneOf;
      ok(
        variants.some((variant) =>
          (variant.properties.kind as { const: string }).const ===
            "consult_model"
        ),
      );
      ok(
        !variants.some((variant) =>
          (variant.properties.kind as { const: string }).const ===
            "propose_sysml_edit"
        ),
      );
      return result({ calls });
    },
  });
  const batch = await muse.decideBatch(readContext);
  deepStrictEqual(batch.calls, calls);
  deepStrictEqual(batch.providerTurn, {
    inputMessageId: "m",
    brief: {
      context: {
        activeTools: [],
        input: { id: "m", role: "user", text: "Lis https://example.org/" },
      },
    },
  });
  equal(runs, 1);
  const previousResults = [
    { id: "read-a", result: '{"status":"succeeded","value":"a"}' },
    {
      id: "read-b",
      result: '{"status":"failed","code":"READ_FAILED"}',
      isError: true,
    },
  ];
  await new MuseAgents({
    runner: async (request) => {
      const prompt = JSON.parse(request.prompt);
      deepStrictEqual(prompt.history, [{
        completedToolCalls: previousResults,
      }]);
      ok(!("toolCallHistory" in prompt.context));
      ok(!("toolCallHistory" in prompt));
      equal(request.prompt.includes("claude-only"), false);
      equal(request.prompt.split("read-a").length - 1, 1);
      equal(request.prompt.split("read-b").length - 1, 1);
      return result({ calls: [{ id: "final", decision: answer }] });
    },
  }).decideBatch({
    ...readContext,
    toolCallHistory: [{
      assistantBlocks: [{ type: "opaque", signature: "claude-only" }],
      results: previousResults,
    }],
  });
  const firstTurn = {
    inputMessageId: "first-input",
    brief: {
      context: {
        input: { id: "first-input", role: "user", text: "My dossier is Alpha" },
      },
    },
  };
  const secondTurn = {
    inputMessageId: "second-input",
    brief: {
      context: {
        input: { id: "second-input", role: "user", text: "Keep that name" },
      },
    },
  };
  const acknowledged = {
    id: "acknowledged",
    result: '{"status":"succeeded","value":"Noted"}',
  };
  await new MuseAgents({
    runner: async (request) => {
      const prompt = JSON.parse(request.prompt);
      deepStrictEqual(prompt.history, [
        { turn: firstTurn, completedToolCalls: [previousResults[0]] },
        { completedToolCalls: [previousResults[1]] },
        { turn: secondTurn, completedToolCalls: [acknowledged] },
      ]);
      deepStrictEqual(prompt.context.input, {
        id: "latest-input",
        role: "user",
        text: "What is its name?",
      });
      equal(request.prompt.split("My dossier is Alpha").length - 1, 1);
      for (const id of ["read-a", "read-b", "acknowledged"]) {
        equal(request.prompt.split(id).length - 1, 1);
      }
      equal(request.prompt.includes("claude-only"), false);
      return result({ calls: [{ id: "final", decision: answer }] });
    },
  }).decideBatch({
    ...readContext,
    messages: [{
      id: "latest-input",
      role: "user",
      text: "What is its name?",
      at: "later",
    }],
    toolCallHistory: [
      {
        turn: firstTurn,
        assistantBlocks: [{ type: "opaque", signature: "claude-only" }],
        results: [previousResults[0]!],
      },
      { turn: firstTurn, assistantBlocks: [], results: [previousResults[1]!] },
      { turn: secondTurn, assistantBlocks: [], results: [acknowledged] },
    ],
  });
  for (
    const invalid of [
      { calls: [calls[0], { ...calls[1], id: calls[0]!.id }] },
      { calls: [{ decision: calls[0]!.decision }] },
      { calls, assistantBlocks: [{ type: "tool_use", id: "invented" }] },
      {
        calls: [{
          id: "unavailable",
          decision: {
            kind: "propose_sysml_edit",
            text: "Edit",
            reason: "Change",
            baseVersion: "commit:base",
            sourceDigest: "a".repeat(64),
            edits: [{ kind: "remove", elementId: "a" }],
          },
        }],
      },
    ]
  ) {
    await rejects(
      () =>
        new MuseAgents({ runner: async () => result(invalid) }).decideBatch(
          readContext,
        ),
      /Invalid .*batch schema|Invalid agent decision schema/,
    );
  }
});
