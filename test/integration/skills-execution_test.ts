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
import {
  type PostgresTestDatabase,
  postgresTestEnabled,
} from "../support/postgres.ts";
import type { DecisionInformationPort } from "../../src/application/work/context/information-ports.ts";
import type { ChatDecision } from "../../src/application/work/conversation/chat-decision.ts";
import type { SkillMetadata } from "../../src/domain/skills/entities/skill.ts";
import type { SkillLoadReceipt } from "../../src/domain/skills/context-skills.ts";
import type { BehaviorInvocationResult } from "../../src/domain/work/execution/modeled-behavior.ts";

Deno.test({
  name:
    "skills return exact instructions through loading and persist their selection across scoped workspace restart",
  ignore: !toolkitIntegrationEnabled || !postgresTestEnabled,
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
      // This download scenario explicitly admits its remote skill source;
      // the ordinary new-system foundation retains a closed network policy.
      sources["configuration.sysml"] = sources["configuration.sysml"]!
        .replace(
          'attribute :>> allowedHosts = "[]";',
          'attribute :>> allowedHosts = "[\\"raw.githubusercontent.com\\"]";',
        );
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
      let phase = "initial", step = 0, bundledText = "";
      let seed: SkillMetadata, remote: SkillMetadata;
      let expectedBehaviorId = "";
      const captured: string[] = [];
      let failure: unknown;
      const fake = createClaudeToolsFake((view) => {
        try {
          captured.push(phase);
          assert(view.context && view.pinCard);
          assert.deepEqual(view.context.activeTools, []);
          assert.deepEqual(
            (view.pinCard.mandate as { network: { allowedHosts: string[] } })
              .network.allowedHosts,
            [],
          );
          // Loaded instructions are native results, never repeated in the card
          // or opening brief. Historical results remain in the transcript.
          for (const marker of [bundledMarker, remoteMarker]) {
            assert(!view.systemText.includes(marker));
            assert(!JSON.stringify(view.context).includes(marker));
          }
          const first = step++ === 0;
          const invoke = (
            name: string,
            input: Record<string, unknown>,
          ): ChatDecision => {
            const behaviors = view.pinCard!.behaviors as Array<
              { id: string; name: string }
            >;
            const behavior = behaviors.find((entry) => entry.name === name);
            assert(behavior, `Missing admitted behavior ${name}`);
            expectedBehaviorId = behavior.id;
            return {
              kind: "invoke_behavior",
              behaviorId: behavior.id,
              inputJson: JSON.stringify(input),
              text: name,
            };
          };
          let observed: Partial<SkillLoadReceipt> & {
            skills?: SkillMetadata[];
            range?: { offset: number; characters: number };
            next?: Record<string, unknown>;
          } = {};
          if (!first) {
            const [assistant, response] = view.body.messages.slice(-2);
            assert.equal(assistant.role, "assistant");
            assert.equal(response.role, "user");
            const calls = assistant.content.filter((b) =>
              b.type === "tool_use"
            );
            const results = response.content.filter((b) =>
              b.type === "tool_result"
            );
            assert.equal(calls.length, 1);
            assert.equal(results.length, 1);
            assert.equal(results[0].tool_use_id, calls[0].id);
            assert.equal(calls[0].name, "invoke_behavior");
            assert.equal(
              (calls[0].input as { behaviorId: string }).behaviorId,
              expectedBehaviorId,
            );
            const receipt = JSON.parse(String(results[0].content));
            assert.equal(receipt.status, "succeeded");
            assert.equal(receipt.truncated, undefined);
            const value = receipt.value as BehaviorInvocationResult;
            assert.equal(value.behaviorId, expectedBehaviorId);
            observed = value.result as typeof observed;
            if (phase !== "load-remote" && !(phase === "initial" && step > 2)) {
              assert.equal(observed.content, undefined);
              assert(!JSON.stringify(observed).includes(remoteMarker));
              assert(!JSON.stringify(observed).includes(bundledMarker));
            }
          }
          let result: ChatDecision = {
            kind: "reply",
            text: `Recorded phase ${phase}.`,
          };
          if (phase === "initial") {
            if (first) result = invoke("ListerSkills", {});
            else if (step === 2) {
              seed = observed.skills!.find((s) =>
                s.id === "assembly-modeling"
              )!;
              assert(seed);
              assert.equal(seed.loaded, true);
              result = invoke("ChargerSkill", {
                id: seed.id,
                expectedDigest: seed.digest,
                offset: 0,
                limit: 4096,
              });
            } else {
              assert.equal(observed.skill!.loaded, true);
              assert.equal(observed.range!.offset, bundledText.length);
              assert.equal(observed.range!.characters, bundledContent.length);
              assert.equal(typeof observed.content, "string");
              bundledText += observed.content;
              if (observed.next) result = invoke("ChargerSkill", observed.next);
              else assert.equal(bundledText, bundledContent);
            }
          } else if (phase === "install") {
            if (first) {
              result = invoke("InstallerSkill", {
                id: "remote-skill",
                url: remoteUrl,
              });
            } else {
              remote = observed.skill!;
              assert.equal(remote.id, "remote-skill");
              assert.equal(remote.loaded, false);
              assert.equal(remote.source.location, remoteUrl);
            }
          } else if (phase === "load-remote") {
            if (first) {
              result = invoke("ChargerSkill", {
                id: remote.id,
                expectedDigest: remote.digest,
                offset: 0,
                limit: 4096,
              });
            } else {
              assert.equal(observed.skill!.loaded, true);
              assert.equal(observed.content, remoteContent);
              assert.equal(observed.next, undefined);
            }
          } else if (phase === "unload-bundled" || phase === "unload-remote") {
            const selected = phase === "unload-bundled" ? seed : remote;
            if (first) {
              result = invoke("DechargerSkill", {
                id: selected.id,
                expectedDigest: selected.digest,
              });
            } else if (step === 2) {
              assert.equal(observed.skill!.id, selected.id);
              assert.equal(observed.skill!.loaded, false);
              result = invoke("ListerSkills", {});
            } else {
              assert.equal(
                observed.skills!.find((s) => s.id === selected.id)!.loaded,
                false,
              );
            }
          } else {
            if (first) result = invoke("ListerSkills", {});
            else {
              assert(observed.skills!.every((s) => !s.loaded));
              assert.equal(
                observed.skills!.find((s) => s.id === seed.id)!.digest,
                seed.digest,
              );
              if (phase === "restart-no-content") {
                assert.equal(
                  observed.skills!.find((s) => s.id === remote.id)!.digest,
                  remote.digest,
                );
              }
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
        assert.equal(current!.service.snapshot.budgetSuspension, undefined);
        assert(
          captured.includes(name),
          `No provider request captured for ${name}`,
        );
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
      assert(captured.filter((name) => name === "unload-remote").length >= 2);
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
