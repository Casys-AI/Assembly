/** Real native bootstrap, workspace, HTTPS adapter and durable stores. Only the
 * provider and remote HTTP transports are doubles; no LLM is contacted. */
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import assert from "node:assert/strict";
import { ClaudeAgents } from "../../src/adapters/out/llm-providers/agents.ts";
import { createClaudeToolsFake } from "../support/claude-tools-fake.ts";
import {
  loadInitialSources,
} from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { openOperatorWorkspace } from "../support/operator-workspace.ts";
import { HttpsSkillDownloader } from "../../src/adapters/out/http-client/download.ts";
import { DenoToolRunner } from "../../src/adapters/out/sandbox/runner.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../../src/application/work/behaviors/invocation.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { openPostgresRuntimeFixture } from "../support/postgres-runtime-fixture.ts";
import type { PostgresTestDatabase } from "../support/postgres.ts";
import type { DecisionInformationPort } from "../../src/application/work/context/information-ports.ts";
import type {
  ChatContext,
  ChatDecision,
} from "../../src/domain/work/dialogue.ts";

Deno.test({
  name:
    "default Assembly skill reaches the provider only while loaded and survives scoped workspace restart",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "assembly-skills-execution-",
    });
    let current: {
      service: SystemRuntime;
      workspace: Awaited<ReturnType<typeof openOperatorWorkspace>>;
      postgres: Awaited<ReturnType<typeof openPostgresRuntimeFixture>>;
    } | undefined;
    let database: PostgresTestDatabase | undefined;
    try {
      const sources = await loadInitialSources();
      const bundledContent = await Deno.readTextFile(
        new URL("../../skills/assembly-modeling/SKILL.md", import.meta.url),
      );
      const bundledMarker = "## Faire évoluer le modèle";
      const remoteMarker = "UNIQUE_DOWNLOADED_SKILL_INSTRUCTIONS_20261022";
      const remoteContent =
        `---\nname: remote-skill\ndescription: A downloaded instruction example.\n---\n${remoteMarker}\n`;
      const remoteUrl =
        "https://raw.githubusercontent.com/example/skills/pinned/SKILL.md";
      let downloads = 0;
      const download = new HttpsSkillDownloader({
        fetch(input) {
          assert.equal(String(input), remoteUrl);
          downloads++;
          return Promise.resolve(
            new Response(remoteContent, {
              headers: { "content-type": "text/markdown" },
            }),
          );
        },
      });
      let phase = "initial", step = 0;
      const captured: Array<
        { phase: string; wire: string; context: ChatContext }
      > = [];
      let failure: unknown;
      const fake = createClaudeToolsFake((view) => {
        try {
          const serialized = JSON.stringify(view.body);
          const context = view.context as unknown as ChatContext;
          captured.push({ phase, wire: serialized, context });
          assert(context.skills && context.contextEvidence);
          assert.equal(context.activeTools.length, 0);
          assert.deepEqual(context.mandate!.network.allowedHosts, []);
          const first = step++ === 0;
          const invoke = (
            name: string,
            input: Record<string, unknown>,
          ): ChatDecision => {
            const behavior = context.modeledBehaviors!.find((b) =>
              b.name === name
            );
            assert(behavior, `Missing admitted behavior ${name}`);
            return {
              kind: "invoke_behavior",
              behaviorId: behavior.id,
              inputJson: JSON.stringify(input),
              text: name,
            };
          };
          let result: ChatDecision = {
            kind: "reply",
            text: `Recorded phase ${phase}.`,
          };
          if (phase === "initial") {
            assert.equal(context.skills.loaded[0]!.content, bundledContent);
            assert(
              !JSON.stringify(context.modelSources).includes(bundledMarker),
            );
            assert(serialized.includes(bundledMarker));
          } else if (phase === "unload-bundled") {
            const seed = context.skills.catalog.find((s) =>
              s.id === "assembly-modeling"
            )!;
            if (first) {
              result = invoke("DechargerSkill", {
                id: seed.id,
                expectedDigest: seed.digest,
              });
            } else {assert(
                !serialized.includes(bundledMarker),
                "Unloaded seed leaked outside the loaded collection",
              );}
          } else {
            assert(
              !serialized.includes(bundledMarker),
              "Restart reloaded bundled instructions",
            );
            if (phase === "install") {
              assert(
                !serialized.includes(remoteMarker),
                "Installation injected instruction bytes",
              );
              if (first) {
                result = invoke("InstallerSkill", {
                  id: "remote-skill",
                  url: remoteUrl,
                });
              } else {assert.equal(
                  context.skills.catalog.find((s) => s.id === "remote-skill")!
                    .loaded,
                  false,
                );}
            } else if (phase === "load-remote") {
              const remote = context.skills.catalog.find((s) =>
                s.id === "remote-skill"
              )!;
              if (first) {
                result = invoke("ChargerSkill", {
                  id: remote.id,
                  expectedDigest: remote.digest,
                });
              } else {assert.equal(
                  context.skills.loaded[0]!.content,
                  remoteContent,
                );}
            } else if (phase === "unload-remote") {
              const remote = context.skills.catalog.find((s) =>
                s.id === "remote-skill"
              )!;
              if (first) {
                result = invoke("DechargerSkill", {
                  id: remote.id,
                  expectedDigest: remote.digest,
                });
              } else {assert(
                  !serialized.includes(remoteMarker),
                  "Unloaded downloaded skill leaked in provider JSON",
                );}
            } else {
              assert.equal(context.skills.loaded.length, 0);
              assert(!serialized.includes(remoteMarker));
            }
          }
          return {
            decision: result,
            id: `skills-${captured.length}`,
            model: "transport-double",
          };
        } catch (error) {
          failure = error;
          throw error;
        }
      });
      const agent = new ClaudeAgents({
        apiKey: "transport-double-only",
        model: "transport-double",
        fetch: fake.fetch,
      });
      const open = async () => {
        const postgres = await openPostgresRuntimeFixture({
          dataDir: directory,
          database,
          ...(database ? {} : { sources }),
        });
        database = postgres.database;
        try {
          const model = postgres.backend.model;
          const repository = postgres.repository;
          const store = postgres.primary.state;
          const executors: BehaviorInvocationPort[] = [];
          const information: { current?: DecisionInformationPort } = {};
          const service = new SystemRuntime({
            ...postgres.runtimePorts,
            agents: agent,
            model,
            store,
            runner: new DenoToolRunner(),
            behaviors: new BehaviorInvocationRegistry(executors),
            information: {
              read(model, messages) {
                assert(information.current);
                return information.current.read(model, messages);
              },
              consultModel(model, input, messages) {
                assert(information.current?.consultModel);
                return information.current.consultModel(model, input, messages);
              },
              consultAdmittedModelSource(model, input, messages, budget) {
                assert(information.current?.consultAdmittedModelSource);
                return information.current.consultAdmittedModelSource(
                  model,
                  input,
                  messages,
                  budget,
                );
              },
            },
          });
          await service.initialize(undefined, {
            resumeContinuations: false,
            resumeCandidateContinuations: false,
          });
          const workspace = await openOperatorWorkspace({
            ...postgres.workspacePorts,
            createSourceModel: postgres.backend.createSourceModel,
            primaryHistory: store,
            tooling: postgres.backend.tooling,
            primary: service,
            primaryModel: model,
            repository,
            agents: agent,
            directory,
            executors,
            skillDownload: download,
          });
          information.current = workspace.information;
          await postgres.start(workspace);
          return { service, postgres, workspace };
        } catch (error) {
          await postgres.close();
          throw error;
        }
      };
      const close = async () => {
        await current?.postgres.close({ retainDatabase: true });
        current = undefined;
      };
      const run = async (name: string) => {
        phase = name;
        step = 0;
        await current!.service.submit(name);
        await current!.postgres.idle(current!.service);
        if (failure) throw failure;
        assert.equal(current!.service.snapshot.error, undefined);
      };
      current = await open();
      assert(current.service.snapshot.executionModel!.memoryPolicy);
      await run("initial");
      await run("unload-bundled");
      await close();
      current = await open();
      await run("restart");
      await run("install");
      await run("load-remote");
      await run("unload-remote");
      await close();
      current = await open();
      await run("restart-no-content");
      assert.equal(downloads, 1);
      assert.equal(current.service.snapshot.candidates.length, 0);
      assert(captured.filter((c) => c.phase === "unload-remote").length >= 2);
    } finally {
      try {
        await current?.postgres.close();
      } finally {
        await database?.close();
      }
      await Deno.remove(directory, { recursive: true });
    }
  },
});
