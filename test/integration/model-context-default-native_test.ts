import { ExplicitTooling } from "../support/explicit-tooling.ts";
/** Real compiler + standard context consultation, without source migration or DB. */
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import assert from "node:assert/strict";
import { ModelContextInformation } from "../../src/application/model/consultation/context-information.ts";
import { ModelContextReader } from "../../src/application/model/consultation/source-reader.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const projectId = "git:4e8f3d0e-8a66-5704-bcec-e67d7b8d859e";

for (const information of [false, true]) {
  Deno.test({
    name:
      `standard model consultation loads exact sources without changing the ${
        information ? "current" : "legacy"
      } native model`,
    ignore: !toolkitIntegrationEnabled,
    async fn() {
      const sources = await loadInitialSources(undefined, { information });
      assert.equal(sources["model-context.sysml"], undefined);
      const native = await new ToolkitCompiler({ packageDir: packageDir! })
        .compile(
          sources,
        );
      const revision = {
        ...native,
        version: "commit:model-context-default-test",
      };
      const model = await validateSourceExecutable(revision, projectId);
      assert.equal(model.policy.mayProposeSysmlRevision, true);
      if (!information) {
        assert.equal(model.behaviors, undefined);
        assert.equal(model.operatorEntries?.length ?? 0, 0);
      }
      const original = structuredClone(model);
      const reader = new ModelContextReader({
        current: () => Promise.resolve(revision),
        at: (version) => {
          assert.equal(version, revision.version);
          return Promise.resolve(revision);
        },
      });
      const service = new ModelContextInformation({
        toolingQuery: () => new ExplicitTooling().query(),
        projectId,
        resolveCallerModel: (callerId, version) => {
          assert.equal(callerId, model.identity.builderId);
          assert.equal(version.digest, model.version.digest);
          assert.equal(
            version.repositoryVersion,
            model.version.repositoryVersion,
          );
          return Promise.resolve(model);
        },
        reader,
      });
      const initial = await service.read(model);
      assert.deepEqual(initial.modelSources!.sources, {});
      assert(
        initial.modelContext!.files.some((file) =>
          file.path === "configuration.sysml"
        ),
      );
      const receipt = await service.consultModel(model, {
        operation: "read_source",
        version: revision.version,
        path: "configuration.sysml",
      });
      assert.equal("content" in (receipt.result as object), false);
      const loaded = await service.read(model);
      assert.deepEqual(Object.keys(loaded.modelSources!.sources), [
        "configuration.sysml",
      ]);
      assert.equal(
        loaded.modelSources!.sources["configuration.sysml"],
        revision.sources["configuration.sysml"],
      );
      assert.deepEqual(model, original);
      assert.deepEqual(revision.sources, sources);
    },
  });
}
