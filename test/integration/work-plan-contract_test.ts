import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { ClaudeAgents } from "../../src/adapters/out/llm-providers/agents.ts";
import { createClaudeToolsFake } from "../support/claude-tools-fake.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { availableBehaviors } from "../../src/application/governance/behavior-call-admission.ts";
import type { NativeBehaviorContract } from "../../src/domain/model/execution/native-contracts.ts";
import type { ChatContext } from "../../src/domain/work/dialogue.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");

function assertPlanContract(behavior: NativeBehaviorContract) {
  const properties = behavior.inputSchema.properties as Record<
    string,
    { description?: string }
  >;
  const tasks = properties.tasksJson!.description;
  ok(tasks, "Native task field documentation was lost during compilation");
  for (
    const fragment of [
      "1 to 32",
      "exactly four required fields",
      "no extra fields",
      "id:",
      "behaviorId:",
      "input:",
      "dependsOn:",
      "modeledBehaviors",
      "inputSchema",
      '"dependsOn":[]',
    ]
  ) ok(tasks.includes(fragment), `Missing task format: ${fragment}`);
  const example = tasks.match(/\[\{"id":"task-1"[^\n]+\}\]/)?.[0];
  ok(example, "Native description must contain a complete JSON task example");
  deepStrictEqual(Object.keys(JSON.parse(example)[0]).sort(), [
    "behaviorId",
    "dependsOn",
    "id",
    "input",
  ]);
  ok(properties.resume!.description?.includes("requires planId"));
  ok(properties.resume!.description?.includes("same tasksJson graph"));
  ok(properties.planId!.description?.includes("persisted plan receipt"));
  ok(properties.planId!.description?.includes("new chat"));
}

Deno.test({
  name:
    "native work-plan field descriptions reach Claude without complete model sources",
  ignore: !toolkitIntegrationEnabled,
  fn: async () => {
    const directory = new URL(
      "../fixtures/commercial-watch/",
      import.meta.url,
    );
    const sources: Record<string, string> = {};
    for await (const entry of Deno.readDir(directory)) {
      if (entry.isFile && entry.name.endsWith(".sysml")) {
        sources[entry.name] = await Deno.readTextFile(
          new URL(entry.name, directory),
        );
      }
    }
    equal(
      sources["work-plans.sysml"],
      await Deno.readTextFile(
        new URL("../../models/work-plans.sysml", import.meta.url),
      ),
      "The example must use the same generic plan contract as the library",
    );
    const revision = {
      ...await new ToolkitCompiler({ packageDir: packageDir! }).compile(
        sources,
      ),
      version: "branch:work-plan-contract-test",
    };
    const model = await validateSourceExecutable(
      revision,
      "git:ebba4399-d616-58b8-862a-310fa3744034",
      "AssemblyLiveBuilder::liveBuilder",
    );
    const modeledBehaviors = await availableBehaviors(model, {
      supports: () => Promise.resolve(true),
      invoke: () =>
        Promise.reject(new Error("No behavior dispatch in schema test")),
    });
    const plan = modeledBehaviors.find((behavior) =>
      behavior.name === "PlanifierTravail"
    );
    ok(plan, "The source-admitted plan exposure must be available");
    assertPlanContract(plan);
    const context: ChatContext = {
      modelVersion: model.version,
      modeledBehaviors,
      messages: [],
      activeTools: [],
      candidates: [],
    };
    const fake = createClaudeToolsFake((view) => {
      equal(Object.hasOwn(view.context!, "modelSources"), false);
      const exposed =
        (view.context!.modeledBehaviors as NativeBehaviorContract[])
          .find((behavior) => behavior.id === plan.id);
      ok(exposed, "Compiled behavior was lost on the real agent transport");
      deepStrictEqual(exposed.inputSchema, plan.inputSchema);
      assertPlanContract(exposed);
      return { decision: { kind: "reply", text: "Contract received" } };
    });
    const agent = new ClaudeAgents({
      apiKey: "fixture",
      model: "fixture",
      fetch: fake.fetch,
    });
    equal((await agent.decide(context)).kind, "reply");
    equal(fake.requests.length, 1);
  },
});
