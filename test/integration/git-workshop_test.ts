import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { NativeModelSourceAuthorization } from "../../src/adapters/governance/model-access/source-authorization.ts";
import { mandateSources } from "../fixtures/model-edit-mandate.ts";
/** Entire agent-proposal path against real Toolkit and an isolated Git
 * repository. The recording agent supplies a decision; no external model or
 * generated tool is invoked by this qualification. */
import assert from "node:assert/strict";
import { SystemRuntime } from "../support/system-runtime.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import {
  SourceModel,
  validateSourceExecutable,
} from "../../src/adapters/model/sources/source-model.ts";
import type { SystemRuntimeState } from "../../src/domain/work/dialogue.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
Deno.test({
  name:
    "agent SysML file proposal reaches a validated isolated branch without changing admitted execution",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({ prefix: "ase-workshop-agent-" });
    const projectId = `git:${crypto.randomUUID()}`;
    const sourceCompiler = new ToolkitCompiler({ packageDir: packageDir! });
    const repository = await GitModelRepository.open({
      projectDir: directory,
      sourceAuthorization: new NativeModelSourceAuthorization(projectId),
      compiler: {
        compile: async (sources) => {
          const compiled = await sourceCompiler.compile(sources);
          await validateSourceExecutable({
            ...compiled,
            version: "compile-gate",
          }, projectId);
          return compiled;
        },
        recipe: () => sourceCompiler.recipe(),
      },
    });
    // Isolate the historical source-proposal path from optional information services.
    const model = new SourceModel({
      tooling: new SysmlToolkitAdapter({ packageDir: packageDir! }),
      repository,
      projectId,
      initialSources: await mandateSources({ raw: true }),
    });
    let persisted: SystemRuntimeState | null = null;
    let agentCalls = 0;
    const forbidden = () => {
      throw new Error(
        "No external effect is permitted in source-proposal qualification",
      );
    };
    const service = new SystemRuntime({
      model,
      agents: {
        label: "Recording agent",
        decide: (context) => {
          agentCalls++;
          assert.equal(context.executionPolicy?.mayProposeSysmlRevision, true);
          assert(context.modelSources?.version);
          const source = context.modelSources.sources["mission.sysml"]!;
          assert(source.includes("attribute value : Integer = 1;"));
          return Promise.resolve({
            kind: "propose_sysml_revision" as const,
            text: "Voici une révision à examiner.",
            reason: "Qualification isolée de la proposition par agent",
            baseVersion: context.modelSources.version,
            sources: {
              "mission.sysml": source.replace(
                "attribute value : Integer = 1;",
                "attribute value : Integer = 8;",
              ),
            },
          });
        },
        review: forbidden,
      },
      runner: { test: forbidden, run: forbidden },
      store: {
        load: () => Promise.resolve(structuredClone(persisted)),
        save: (state, expected) => {
          assert.equal(persisted?.revision ?? null, expected);
          persisted = structuredClone(state);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      },
    });
    try {
      await service.initialize();
      const before = await repository.current();
      const admittedDigest = service.snapshot.executionModel!.version.digest;
      await service.submit(
        "Propose une mise à jour de la donnée déléguée, sans l'appliquer.",
      );
      await service.idle();
      assert.equal(agentCalls, 1);
      const proposals = await repository.listProposals();
      assert.equal(proposals.length, 1);
      assert.equal(proposals[0]!.status, "proposed");
      assert.equal(proposals[0]!.baseVersion, before.version);
      assert.equal((await repository.current()).version, before.version);
      assert.equal(
        service.snapshot.executionModel!.version.digest,
        admittedDigest,
      );
      assert.equal(
        service.snapshot.executionModel!.policy.maxAgentDecisions,
        7,
      );
      assert(
        service.snapshot.events.some((event) =>
          event.kind === "model-revision-proposed"
        ),
      );
      const proposed = await repository.at(proposals[0]!.proposalVersion!);
      assert.equal(
        (await model.validateRevision(proposed)).policy.maxAgentDecisions,
        7,
      );
      assert(
        proposed.sources["mission.sysml"]!.includes(
          "attribute value : Integer = 8;",
        ),
      );
      assert.equal(service.snapshot.candidates.length, 0);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});
