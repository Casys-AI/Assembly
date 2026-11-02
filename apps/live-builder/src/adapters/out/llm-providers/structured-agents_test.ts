import { equal, rejects } from "node:assert/strict";
import type { ChatContext } from "../../../domain/work/dialogue.ts";
import { modelContextTools } from "../../../domain/model/consultation/context.ts";
import { StructuredAgents } from "./structured-agents.ts";
import { buildProviderTools } from "./provider-tools.ts";

class RecordingAgents extends StructuredAgents {
  readonly label = "recording";
  tools: string[] = [];
  batched = false;
  response?: unknown;
  protected call(
    _prompt: string,
    schema: object,
  ): Promise<unknown> {
    this.tools = buildProviderTools(schema).map((tool) => tool.name);
    const decision = { kind: "reply", text: "Observed" };
    return Promise.resolve(
      this.response ??
        (this.batched ? { calls: [{ id: "reply", decision }] } : decision),
    );
  }
}

for (const tools of [undefined, [], modelContextTools()]) {
  for (const batched of [false, true]) {
    Deno.test(`${batched ? "batch" : "scalar"} provider exposes consult_model only with available model read tools (${tools?.length ?? "absent"})`, async () => {
      const agent = new RecordingAgents();
      agent.batched = batched;
      const context: ChatContext = {
        messages: [],
        activeTools: [],
        candidates: [],
        modelTools: tools,
      };
      if (batched) await agent.decideBatch(context);
      else await agent.decide(context);
      equal(agent.tools.includes("consult_model"), !!tools?.length);
    });
  }
}

Deno.test("an unavailable consultation cannot be returned through a generic structured provider", async () => {
  const agent = new RecordingAgents();
  agent.response = {
    kind: "consult_model",
    text: "Forged read",
    inputJson: "{}",
  };
  await rejects(
    () => agent.decide({ messages: [], activeTools: [], candidates: [] }),
    /Invalid agent decision schema/,
  );
});
