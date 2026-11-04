import assert from "node:assert/strict";
import { createClaudeToolsFake } from "../../../../test/support/claude-tools-fake.ts";
import type { ChatContext } from "../../../application/work/conversation/chat-context.ts";
import type { ChatDecision } from "../../../application/work/conversation/chat-decision.ts";
import { ClaudeAgents } from "./agents.ts";
import { validateDecision } from "./output-validation.ts";

Deno.test("evolution transport accepts only closed operator commands without host authority fields", () => {
  const choices: ChatDecision[] = [
    {
      kind: "prepare_operator_evolution",
      text: "Prepare",
      reason: "Clarify",
      editJson:
        '{"edits":[{"kind":"set-value","elementId":"instruction","expression":"new"}]}',
    },
    {
      kind: "decide_operator_evolution",
      text: "Accept",
      dossierId: "dossier",
      decision: "accept",
    },
    {
      kind: "decide_operator_evolution",
      text: "Cancel",
      dossierId: "dossier",
      decision: "cancel",
    },
    { kind: "adopt_operator_evolution", text: "Arm", dossierId: "dossier" },
  ];
  for (const choice of choices) {
    assert.equal(validateDecision(choice), true);
    for (
      const extra of [
        { actorId: "Main" },
        { finalizerActorId: "Main" },
        { origin: { requestId: "other" } },
        { sources: { "raw.sysml": "raw" } },
        { targets: ["other"] },
        { authority: "root" },
        { baseVersion: "HEAD" },
      ]
    ) {
      assert.equal(validateDecision({ ...choice, ...extra }), false);
    }
  }
  assert.equal(validateDecision({ ...choices[1], decision: "publish" }), false);
});

Deno.test("provider tools expose evolution acts only under corresponding host capabilities", async () => {
  for (const allowed of [undefined, "prepare", "accept", "adopt"] as const) {
    const context: ChatContext = {
      messages: [],
      activeTools: [],
      candidates: [],
      ...(allowed
        ? {
          operatorEvolution: {
            policy: {} as NonNullable<
              ChatContext["operatorEvolution"]
            >["policy"],
            capabilities: {
              prepare: allowed === "prepare",
              accept: allowed === "accept",
              adopt: allowed === "adopt",
            },
            dossiers: [],
            truncated: false,
          },
        }
        : {}),
    };
    const fake = createClaudeToolsFake(() => ({
      toolUse: { name: "reply", input: { text: "Observed" } },
    }));
    const agent = new ClaudeAgents({
      apiKey: "fixture",
      model: "fixture",
      fetch: fake.fetch,
    });
    assert.deepEqual(await agent.decide(context), {
      kind: "reply",
      text: "Observed",
    });
    assert.equal(fake.views.length, 1);
    const view = fake.views[0]!;
    const scenario = allowed ?? "no evolution capability";
    assert.equal(
      view.toolNames.includes("prepare_operator_evolution"),
      allowed === "prepare",
      `${scenario}: prepare tool availability`,
    );
    assert.equal(
      view.toolNames.includes("decide_operator_evolution"),
      allowed === "accept",
      `${scenario}: accept tool availability`,
    );
    assert.equal(
      view.toolNames.includes("adopt_operator_evolution"),
      allowed === "adopt",
      `${scenario}: adopt tool availability`,
    );
    for (
      const phrase of [
        "Do not wait for your own adoption",
        'exactly {kind:"set-type",elementId,typeName}',
        "explicitly admitted set-type operation",
      ]
    ) {
      assert.equal(
        view.instruction.includes(phrase),
        !!allowed,
        `${scenario}: instruction contains ${phrase}`,
      );
    }
  }
});
