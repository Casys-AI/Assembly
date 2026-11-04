import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { editPolicy } from "../fixtures/model-edit-mandate.ts";
/** Actual compiler, repository and operator workspace; the provider transport
 * alone is a recording double. Every project directory is unique and removed afterwards. */
import assert from "node:assert/strict";
import { ClaudeAgents } from "../../src/adapters/out/llm-providers/agents.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { openOperatorWorkspace } from "../support/operator-workspace.ts";
import { DenoToolRunner } from "../../src/adapters/out/sandbox/runner.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../../src/application/work/behaviors/invocation.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { openPostgresRuntimeFixture } from "../support/postgres-runtime-fixture.ts";
import { createClaudeToolsFake } from "../support/claude-tools-fake.ts";
import type { DecisionInformationPort } from "../../src/application/work/context/information-ports.ts";
import type { ChatContext } from "../../src/application/work/conversation/chat-context.ts";
import type { ChatDecision } from "../../src/application/work/conversation/chat-decision.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
for (const profile of ["legacy", "current"] as const) {
  Deno.test({
    name:
      `${profile} system uses default visible model tools, exact scoped sources and concurrent source proposals`,
    ignore: !toolkitIntegrationEnabled,
    async fn() {
      const directory = await Deno.makeTempDir({
        prefix: "ase-model-context-",
      });
      let postgres:
        | Awaited<ReturnType<typeof openPostgresRuntimeFixture>>
        | undefined;
      let workspace:
        | Awaited<ReturnType<typeof openOperatorWorkspace>>
        | undefined;
      try {
        const sources = await loadInitialSources(undefined, {
          information: profile === "current",
        });
        sources["configuration.sysml"] = sources["configuration.sysml"]!
          .replace(
            "part liveBuilder : ConversationSystem {",
            "part liveBuilder : ConversationSystem {" +
              editPolicy("Work::alpha", true),
          );
        sources["mission.sysml"] =
          `package Work { package alpha { private import ScalarValues::*; attribute value : Integer = 1; } }\n`;
        postgres = await openPostgresRuntimeFixture({
          dataDir: directory,
          sources,
        });
        const projectId = postgres.backend.projectId;
        const repository = postgres.repository;
        const model = postgres.backend.model;
        const marker = "ONLY_LOADED_CORE_SOURCE_20261022";
        let phase = "propose",
          step = 0,
          pinned = "",
          advanced = "",
          failure: unknown;
        let targetId = "";
        const captures: Array<
          { phase: string; wire: string; context: ChatContext }
        > = [];
        const consult = (
          context: ChatContext,
          operation: string,
          parameters: Record<string, unknown> = {},
        ): ChatDecision => ({
          kind: "consult_model",
          text: `Consultation ${operation}`,
          inputJson: JSON.stringify({
            operation,
            version: context.modelContext!.version,
            ...parameters,
          }),
        });
        const fake = createClaudeToolsFake(async (view) => {
          try {
            const wire = view.body;
            const context = view.context as unknown as ChatContext;
            captures.push({ phase, wire: JSON.stringify(wire), context });
            assert.equal(context.modelTools!.length, 6);
            assert(
              context.modelTools!.some((tool) =>
                tool.id === "model.read_source"
              ),
            );
            assert(context.modelContext && context.modelSources);
            assert.equal(
              context.modelContext.version,
              context.modelSources.version,
            );
            let decision: ChatDecision;
            const index = step++;
            if (phase === "propose") {
              if (index === 0) {
                pinned = context.modelContext.version;
                assert.deepEqual(context.modelSources.sources, {});
                assert(
                  !captures.at(-1)!.wire.includes(
                    "attribute :>> maxAgentDecisions = 7;",
                  ),
                );
                assert.equal(wire.max_tokens, 4096);
                decision = consult(context, "search", {
                  query: "Work::alpha::value",
                  limit: 20,
                });
              } else if (index === 1) {
                const observation = context.messages.at(-1)!.observation;
                assert.equal(observation!.kind, "model-context");
                const result = (observation!.value as {
                  result: {
                    items: Array<{ id: string; qualifiedName?: string }>;
                  };
                }).result;
                targetId = result.items.find((item) =>
                  item.qualifiedName?.includes(
                    "Work::alpha::value",
                  )
                )!.id;
                decision = consult(context, "inspect", {
                  elementId: targetId,
                });
              } else if (index === 2) {
                assert.equal(context.modelContext.version, pinned);
                assert.deepEqual(context.modelSources.sources, {});
                const observation = context.messages.at(-1)!.observation!
                  .value as {
                    status: string;
                    code: string;
                    version: string;
                  };
                // This legacy repository fixture has no exact semantic index.
                // Navigation is refused, while independent source reads remain available.
                assert.equal(observation.status, "refused");
                assert.equal(observation.code, "INDEX_UNAVAILABLE");
                assert.equal(observation.version, pinned);
                decision = consult(context, "read_source", {
                  path: "mission.sysml",
                });
              } else {
                assert.equal(index, 3);
                assert.equal(context.modelContext.version, pinned);
                assert.deepEqual(Object.keys(context.modelSources.sources), [
                  "mission.sysml",
                ]);
                assert.equal(
                  context.modelSources.sources["mission.sysml"],
                  sources["mission.sysml"],
                );
                assert.equal(wire.max_tokens, 16384);
                const head = await repository.current();
                const changed = await repository.publishSystemSources(
                  {
                    ...head.sources,
                    "core.sysml": head.sources["core.sysml"] +
                      `\n// ${marker}\n`,
                  },
                  head.version,
                  "independent-test-author",
                );
                advanced = changed.version;
                assert.notEqual(advanced, pinned);
                decision = {
                  kind: "propose_sysml_revision",
                  text: "Révision ciblée à examiner",
                  reason: "Qualification source ciblée",
                  baseVersion: pinned,
                  sources: {
                    "mission.sysml": context.modelSources
                      .sources["mission.sysml"]!.replace(
                        "attribute value : Integer = 1;",
                        "attribute value : Integer = 8;",
                      ),
                  },
                };
              }
            } else {
              assert.equal(context.modelContext.version, advanced);
              if (index === 0) {
                assert.deepEqual(context.modelSources.sources, {});
                decision = consult(context, "read_source", {
                  path: "core.sysml",
                });
              } else if (index === 1) {
                assert(
                  context.modelSources.sources["core.sysml"]!.includes(
                    marker,
                  ),
                );
                decision = consult(context, "unload_sources");
              } else {
                assert.equal(index, 2);
                assert.deepEqual(context.modelSources.sources, {});
                assert(
                  !captures.at(-1)!.wire.includes(marker),
                  "Unloaded full source leaked from the journal",
                );
                decision = { kind: "reply", text: "Consultation terminée" };
              }
            }
            return { decision };
          } catch (error) {
            failure = error;
            throw error;
          }
        });
        const agents = new ClaudeAgents({
          apiKey: "transport-double-only",
          model: "transport-double",
          fetch: fake.fetch,
        });
        const store = postgres.primary.state;
        const executors: BehaviorInvocationPort[] = [];
        const information: { current?: DecisionInformationPort } = {};
        const service = new SystemRuntime({
          ...postgres.runtimePorts,
          model,
          store,
          agents,
          runner: new DenoToolRunner(),
          behaviors: new BehaviorInvocationRegistry(executors),
          information: {
            read: (native, messages) =>
              information.current!.read(native, messages),
            consultModel: (native, input, messages) =>
              information.current!.consultModel!(native, input, messages),
            consultAdmittedModelSource: (native, input, messages, budget) =>
              information.current!.consultAdmittedModelSource!(
                native,
                input,
                messages,
                budget,
              ),
          },
        });
        await service.initialize(undefined, {
          resumeContinuations: false,
          resumeCandidateContinuations: false,
        });
        const original = await repository.current();
        const admittedDigest = service.snapshot.executionModel!.version.digest;
        workspace = await openOperatorWorkspace({
          ...postgres.workspacePorts,
          createSourceModel: postgres.backend.createSourceModel,
          primaryHistory: store,
          tooling: new SysmlToolkitAdapter({ packageDir: packageDir! }),
          primary: service,
          primaryModel: model,
          repository,
          agents,
          directory,
          executors,
        });
        assert.equal(
          (await repository.current()).version,
          original.version,
          "Installing default readers changed source history",
        );
        information.current = workspace.information;
        await postgres.start(workspace);
        assert.equal(service.snapshot.modelTools!.length, 6);
        assert.equal(
          workspace.conversations.catalogSnapshot.modelTools!.length,
          6,
        );
        await service.submit(
          "Propose une augmentation de la valeur métier, après consultation du modèle.",
        );
        await postgres.idle(service);
        if (failure) throw failure;
        assert.equal(service.snapshot.error, undefined);
        assert.equal(step, 4);
        assert.equal(
          service.snapshot.executionModel!.version.digest,
          admittedDigest,
        );
        const proposals = await repository.listProposals();
        assert.equal(proposals.length, 1);
        assert.equal(proposals[0]!.baseVersion, pinned);
        assert.equal(proposals[0]!.status, "proposed");
        assert.equal((await repository.current()).version, advanced);
        phase = "unload";
        step = 0;
        await service.submit("Consulte puis décharge le fichier core.");
        await postgres.idle(service);
        if (failure) throw failure;
        assert.equal(service.snapshot.error, undefined);
        assert.equal(step, 3);
        assert.equal(
          service.snapshot.events.filter((e) =>
            e.kind === "model-tool-completed"
          ).length,
          4,
        );
        assert.equal(
          service.snapshot.events.filter((e) => e.kind === "model-tool-refused")
            .length,
          1,
        );
        const accepted = await repository.accept({
          id: proposals[0]!.id,
          expectedVersion: advanced,
          author: "qualification-only",
          decisionAuthorityExercise: exerciseOwnerAuthority(
            await validateSourceExecutable(
              await repository.current(),
              projectId,
            ),
            "model-revision",
          ),
        });
        assert(accepted.version);
        const merged = await repository.current();
        assert(merged.sources["core.sysml"]!.includes(marker));
        assert(
          merged.sources["mission.sysml"]!.includes(
            "attribute value : Integer = 8;",
          ),
        );
        assert.equal(
          service.snapshot.executionModel!.policy.maxAgentDecisions,
          7,
        );
        console.log(JSON.stringify({
          profile,
          initialContextCharacters: JSON.stringify(captures[0]!.context).length,
          allSourceCharacters: Object.values(sources).reduce(
            (sum, text) => sum + text.length,
            0,
          ),
          providerCalls: captures.length,
        }));
      } finally {
        await postgres?.close();
        await Deno.remove(directory, { recursive: true });
      }
    },
  });
}
