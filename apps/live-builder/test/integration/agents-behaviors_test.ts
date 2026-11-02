// ClaudeAgents is exercised through the real provider interface; the only
// double is the shared Anthropic transport fake.
// deno-lint-ignore-file require-await
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import {
  ClaudeAgents,
  MuseAgents,
} from "../../src/adapters/out/llm-providers/agents.ts";
import { validateDecision } from "../../src/adapters/out/llm-providers/output-validation.ts";
import { createClaudeToolsFake } from "../support/claude-tools-fake.ts";
import type { ChatContext } from "../../src/domain/work/dialogue.ts";
import type { NativeBehaviorContract } from "../../src/domain/model/execution/native-contracts.ts";

const behavior: NativeBehaviorContract = {
  id: "native:note-access",
  name: "Conserver une note",
  description: "Consigner les faits fournis sous leur identifiant existant.",
  targetNativeId: "native:note-flow",
  targetTypeId: "native:NoteCase",
  inputTypeId: "native:NoteInput",
  callerNativeId: "native:builder",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      entryId: { type: "string" },
      payload: { type: "string" },
    },
    required: ["entryId", "payload"],
  },
  sourceIds: ["native:note-access", "native:note-flow", "native:NoteInput"],
};
const context: ChatContext = {
  messages: [{
    id: "user-note",
    role: "user",
    text: "Consigne la note N-1 avec le texte fourni.",
    at: "2026-10-21T00:00:00Z",
  }],
  activeTools: [],
  candidates: [],
  modelVersion: {
    digest: "a".repeat(64),
    repositoryVersion: "branch:source-version",
  },
  modeledBehaviors: [behavior],
};
const invocation = {
  kind: "invoke_behavior" as const,
  text: "Je transmets les faits au comportement déclaré.",
  behaviorId: behavior.id,
  inputJson: JSON.stringify({ entryId: "N-1", payload: "État observé : あ" }),
};

Deno.test("modeled behavior decisions keep a closed bounded transport without coercing native facts", () => {
  const unchanged = structuredClone(invocation);
  ok(validateDecision(unchanged));
  deepStrictEqual(unchanged, invocation);
  // Parsing and validation against the native inputSchema belong to the host.
  // The provider transport carries the exact JSON text, without a static domain schema.
  ok(validateDecision({ ...invocation, inputJson: "{}" }));
  ok(validateDecision({ ...invocation, inputJson: "x".repeat(65_536) }));
  for (
    const invalid of [
      { ...invocation, kind: "invoke_note" },
      { ...invocation, behaviorId: "" },
      { ...invocation, inputJson: "" },
      { ...invocation, inputJson: { entryId: "N-1" } },
      { ...invocation, inputJson: "x".repeat(65_537) },
      { ...invocation, targetNativeId: behavior.targetNativeId },
      { ...invocation, granted: true },
      { kind: invocation.kind, behaviorId: behavior.id, inputJson: "{}" },
    ]
  ) {
    const before = structuredClone(invalid);
    equal(validateDecision(invalid), false);
    deepStrictEqual(invalid, before);
  }
});

Deno.test("Claude receives the admitted generic catalog and returns the unchanged behavior call", async () => {
  const fake = createClaudeToolsFake((view) => {
    const received = view.context as unknown as ChatContext;
    deepStrictEqual(received.modeledBehaviors, [behavior]);
    deepStrictEqual(received.modelVersion, context.modelVersion);
    equal(received.activeTools.length, 0);
    // The decision schema now travels as one native tool per authorized
    // kind: `kind` is the tool name, so the input schema carries the variant
    // without `kind`.
    const tool = view.body.tools.find((entry) =>
      entry.name === "invoke_behavior"
    );
    ok(tool, "invoke_behavior tool offered");
    const schema = tool.input_schema as {
      additionalProperties: boolean;
      properties: Record<string, unknown>;
      required: string[];
    };
    equal(schema.additionalProperties, false);
    equal(
      (schema.properties.inputJson as { type: string }).type,
      "string",
    );
    deepStrictEqual(Object.keys(schema.properties).sort(), [
      "behaviorId",
      "inputJson",
      "text",
    ]);
    deepStrictEqual([...schema.required].sort(), [
      "behaviorId",
      "inputJson",
      "text",
    ]);
    for (
      const phrase of [
        "modeledBehaviors",
        "behaviorId exact",
        "inputSchema natif",
        "anciens messages",
        "N'invente jamais",
        "sans nouvelle demande de l'utilisateur",
      ]
    ) ok(view.instruction.includes(phrase), phrase);
    // The invocation guidance has no model-specific vocabulary or thresholds.
    const behaviorInstruction = view.instruction.slice(
      view.instruction.indexOf("L'hôte peut fournir modeledBehaviors"),
    );
    ok(
      behaviorInstruction.length > 0,
      "L'hôte peut fournir modeledBehaviors",
    );
    equal(/refund|remboursement|5000|2000/i.test(behaviorInstruction), false);
    return { decision: invocation };
  });
  const agent = new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    fetch: fake.fetch,
  });
  deepStrictEqual(await agent.decide(context), invocation);
  equal(fake.requests.length, 1);
});

Deno.test("local validation rejects malformed modeled calls even when the Claude transport is permissive", async () => {
  for (
    const invalid of [
      { ...invocation, inputJson: "x".repeat(65_537) },
      { ...invocation, inputJson: { entryId: "N-1" } },
      { ...invocation, approvedByHost: true },
    ]
  ) {
    // Raw tool call: the transport validates the input against the offered
    // tool schema and repairs once before refusing with an explicit code.
    const record = invalid as unknown as Record<string, unknown>;
    const { kind: _kind, ...input } = record;
    const fake = createClaudeToolsFake(() => ({
      toolUse: { name: "invoke_behavior", input },
    }));
    const agent = new ClaudeAgents({
      apiKey: "fixture",
      model: "fixture",
      fetch: fake.fetch,
    });
    await rejects(
      () => agent.decide(context),
      /invalid tool decision schema after repair \(INVALID_TOOL_INPUT\)/,
    );
    equal(fake.requests.length, 2);
    equal(fake.views[1]?.isRepair, true);
    equal(fake.views[1]?.repair?.code, "INVALID_TOOL_INPUT");
  }
});

Deno.test("Muse shares the generic behavior decision schema and the exact source catalog", async () => {
  const agent = new MuseAgents({
    runner: async (request) => {
      const prompt = JSON.parse(request.prompt);
      deepStrictEqual(
        prompt.context.modeledBehaviors,
        context.modeledBehaviors,
      );
      deepStrictEqual(prompt.context.modelVersion, context.modelVersion);
      ok(JSON.stringify(request.schema).includes("invoke_behavior"));
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          schema_version: 1,
          payload_schema_version: 1,
          stream: { kind: "session", id: "fixture" },
          payload_type: "run.terminal.completed",
          payload: {
            kind: "run_terminal",
            command_id: "fixture",
            run_stream: { kind: "run", id: "fixture" },
            terminal: "completed",
            text: JSON.stringify(invocation),
          },
        }) + "\n",
        stderr: "",
      };
    },
  });
  deepStrictEqual(await agent.decide(context), invocation);
});
