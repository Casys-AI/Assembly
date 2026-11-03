import assert from "node:assert/strict";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { SourceModel } from "../../src/adapters/model/sources/source-model.ts";
import { MemorySourceRepository } from "../support/memory-source-repository.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { applyApprovedSourceChange } from "../support/approved-source-change.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { modelSourceDigest } from "../../src/domain/model/value-objects/sources.ts";

/** The fixture files are the exact f94e723 sources, not an inverse renaming of
 * current models. This qualifies a real old source family with today's readers. */
Deno.test({
  name:
    "native Assembly and frozen ASE models retain exact names, IDs and old edit references",
  ignore: !toolkitIntegrationEnabled,
  fn: async () => {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const projectId = "git:b32ea229-4d18-4614-81dc-15a948fc63d6";
    for (const legacy of [true, false]) {
      const sources = await loadInitialSources(
        legacy
          ? new URL("../fixtures/legacy-ase-model/", import.meta.url)
          : undefined,
        { information: false },
      );
      const family = legacy ? "ASE" : "Assembly";
      const before = await compiler.compile(sources);
      const sourceDigest = await modelSourceDigest(sources);
      const repository = new MemorySourceRepository(compiler);
      await repository.initialize(sources);
      const model = new SourceModel({ repository, tooling, projectId });
      const identity = await model.initialize();
      const executable = await model.readExecutableModel(identity);
      assert.equal(
        identity.systemQualifiedName,
        legacy ? undefined : "AssemblyLiveBuilder::liveBuilder",
      );
      assert.equal(
        before.elements.find((element) =>
          element.qualifiedName === `${family}LiveBuilder::liveBuilder`
        )?.["@id"],
        identity.systemId,
      );
      assert.deepEqual((await repository.current()).sources, sources);
      assert.equal(
        await modelSourceDigest((await repository.current()).sources),
        sourceDigest,
      );
      const reopened = new SourceModel({ repository, tooling, projectId });
      assert.deepEqual(await reopened.initialize(), identity);
      assert.equal(
        (await reopened.readExecutableModel(identity)).version.digest,
        executable.version.digest,
      );
      const repeated = await compiler.compile(sources);
      assert.equal(repeated.sourceDigest, before.sourceDigest);
      assert.equal(repeated.semanticDigest, before.semanticDigest);
      assert.equal(repeated.provenanceDigest, before.provenanceDigest);
      const change = {
        id: `compatibility-${family}`,
        kind: "mandate-change" as const,
        status: "approved" as const,
        baseRevision: executable.configuration.revision,
        baseModelDigest: executable.version.digest,
        authorityExercise: exerciseOwnerAuthority(executable, "mandate-change"),
        reason: "Qualify one approved edit without renaming existing libraries",
        requestedAt: "2026-10-26T00:00:00Z",
        requestedRights: { addNetworkHosts: ["casys.ai"] },
        authority: "human" as const,
        decidedAt: "2026-10-26T00:01:00Z",
      };
      await applyApprovedSourceChange(
        model,
        identity,
        change,
        executable.version.digest,
      );
      const edited = await repository.current();
      assert.equal(edited.sources["core.sysml"], sources["core.sysml"]);
      assert.equal(
        edited.sources["authority.sysml"],
        sources["authority.sysml"],
      );
      assert.equal(
        edited.elements.find((element) =>
          element.qualifiedName === `${family}LiveBuilder::liveBuilder`
        )?.["@id"],
        identity.systemId,
      );
      assert(
        !edited.sources["configuration.sysml"]!.includes(
          legacy ? "AssemblyCore::" : "ASECore::",
        ),
      );
      assert.equal(
        (await repository.at("memory:1")).sources["configuration.sysml"],
        sources["configuration.sysml"],
      );
      if (legacy) {
        const current = await model.readExecutableModel(identity);
        const reviewed = await applyApprovedSourceChange(model, identity, {
          id: "legacy-reviewer-creation",
          kind: "reviewer-creation",
          status: "approved",
          baseRevision: current.configuration.revision,
          baseModelDigest: current.version.digest,
          authorityExercise: exerciseOwnerAuthority(current, "mandate-change"),
          reason:
            "Qualify a newly inserted type in the existing legacy package",
          requestedAt: "2026-10-26T00:02:00Z",
          role: "reviewer",
          name: "AssemblyCore",
          mandate: {
            mayReviewExactCandidate: true,
            mayAdmitReviewedCandidates: true,
          },
          authority: "human",
          decidedAt: "2026-10-26T00:03:00Z",
        }, current.version.digest);
        assert.equal(reviewed.configuration.reviewer?.name, "AssemblyCore");
        const next = await repository.current();
        assert(
          next.sources["configuration.sysml"]!.includes(
            "promotion : ASELiveBuilder::ReviewedCapabilityPromotion",
          ),
        );
        assert.equal(next.sources["core.sysml"], sources["core.sysml"]);
      }
    }
  },
});
