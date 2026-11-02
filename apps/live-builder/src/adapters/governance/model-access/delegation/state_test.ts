import { toolkitIntegrationEnabled } from "../../../../../test/support/toolkit-integration.ts";
import assert from "node:assert/strict";
import { ToolkitCompiler } from "../../../out/sysml-toolkit/compilation/compiler.ts";
import { loadInitialSources } from "../../../out/filesystem/initial-model-sources.ts";
import { sourceModelIdentity } from "../../../model/sources/source-model.ts";
import { delegationIdentity } from "./state.ts";
import type { ExecutableModel } from "../../../../domain/model/execution/executable-model.ts";

Deno.test({
  name: "delegation requires a concrete singleton native holder and mandate",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = await loadInitialSources(undefined, { information: false });
    const compiler = new ToolkitCompiler({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    });
    const projectId = "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf";
    const system = "AssemblyLiveBuilder::liveBuilder";
    for (const member of [undefined, "builder", "builderMandate"] as const) {
      const candidate = structuredClone(sources);
      if (member) {
        const original = candidate["configuration.sysml"]!;
        candidate["configuration.sysml"] = original.replace(
          new RegExp(`(\\b(?:part|item) ${member})\\s*:`),
          "$1 [0] :",
        );
        assert.notEqual(candidate["configuration.sysml"], original);
      }
      const revision = {
        ...await compiler.compile(candidate),
        version: "test",
      };
      const model = {
        identity: sourceModelIdentity(revision, projectId),
        mandate: { id: "builder-v1" },
        configuration: { builder: { mandateRevision: 1 } },
        policy: { mayProposeSysmlRevision: true },
      } as ExecutableModel;
      assert.equal(
        delegationIdentity(system, model, revision).mayProposeSysmlRevision,
        !member,
        member,
      );
    }
  },
});
