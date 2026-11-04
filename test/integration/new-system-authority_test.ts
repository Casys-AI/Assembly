import {
  sourceCompilation,
  sourceEvolutionCompilation,
} from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { createSourceModel } from "../../src/composition/source-model-services.ts";
import { SYSML_TOOLKIT_VERSION } from "../../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import { MemorySourceRepository } from "../support/memory-source-repository.ts";
import { applyApprovedSourceChange } from "../support/approved-source-change.ts";
import assert from "node:assert/strict";
import {
  createNamedSystem,
  preparedSources,
  workspacePaths,
} from "../../tools/system-workspace.ts";
import {
  readModelProject,
  readProjectSources,
} from "../../src/adapters/out/filesystem/model-project.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { resolveModelEdits } from "../../src/domain/model/editing/source-index.ts";
import { NativeModelSourceAuthorization } from "../../src/application/governance/model-access/source-authorization.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { SystemGovernance } from "../../src/domain/governance/policies/governance.ts";
import type { ChatDecision } from "../../src/application/work/conversation/chat-decision.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

/** Only source storage is doubled; compilation and authorization are real.
 * Named-system provisioning itself creates no Git repository or commits. */

Deno.test({
  name:
    "new named system: default sources permit ordinary editing and configured owner decisions without recovery",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({ prefix: "ase-new-authority-" });
    try {
      // Exercise the exact preparation and creation functions used by `system create`.
      const seed = await preparedSources({});
      await createNamedSystem({
        root: directory,
        name: "fresh-authority",
        sources: seed,
      });
      const paths = workspacePaths(directory, "fresh-authority");
      const project = await readModelProject(paths.project);
      const sources = await readProjectSources(paths.sources);
      assert.deepEqual(sources, seed);
      const projectId = `git:${project.id}`;
      const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
      const compiler = new ToolkitCompiler({ packageDir });
      const repository = new MemorySourceRepository(compiler);
      const adapter = createSourceModel({
        tooling: new SysmlToolkitAdapter({ packageDir }),
        repository,
        projectId,
        initialSources: sources,
      });
      const identity = await adapter.initialize();
      const model = await adapter.readExecutableModel(identity);
      assert.equal(model.ownerAuthority?.ownerSource, "modeled");
      const receipt = exerciseOwnerAuthority(model, "model-revision");
      assert.equal(receipt.outOfMandate, false);
      const current = await repository.current();
      const edited = await new SysmlToolkitAdapter({ packageDir }).edit(
        current.sources,
        resolveModelEdits(current, [{
          kind: "insert-member",
          elementId: identity.systemId,
          text: "attribute ordinaryValue : ScalarValues::Integer = 1;",
        }]),
      );
      assert.equal(edited.provider.version, SYSML_TOOLKIT_VERSION);
      const candidate = await compiler.compile(edited.sources);
      const authorizer = new NativeModelSourceAuthorization(
        projectId,
        sourceCompilation,
        sourceEvolutionCompilation,
      );
      for (const phase of ["proposal", "acceptance"] as const) {
        await authorizer.validate({
          authority: current,
          before: current,
          after: candidate,
          author: "local-owner",
          authorization: { kind: "local-owner", authorityExercise: receipt },
          phase,
          ...(phase === "acceptance"
            ? { decisionAuthorityExercise: receipt }
            : {}),
        });
      }
      await repository.publishSystemSources(edited.sources, current.version);
      assert(
        (await repository.current()).elements.some((element) =>
          element.qualifiedName ===
            "AssemblyLiveBuilder::liveBuilder::ordinaryValue"
        ),
      );
      const requests: Extract<ChatDecision, {
        kind: "propose_mandate_change" | "propose_agent_creation";
      }>[] = [
        {
          kind: "propose_mandate_change",
          text: "A network scope decision is required.",
          reason: "Permit the requested public source",
          requestedRights: { addNetworkHosts: ["example.org"] },
        },
        {
          kind: "propose_mandate_change",
          text: "A URL selection decision is required.",
          reason: "Allow URL selection inside the approved host scope",
          requestedRights: { setUrlSelectionMode: "authorized-host" },
        },
        {
          kind: "propose_mandate_change",
          text: "An admission delegation decision is required.",
          reason: "Delegate admission of tested own candidates",
          requestedRights: { mayAdmitOwnCandidates: true },
        },
        {
          kind: "propose_agent_creation",
          text: "A reviewer creation decision is required.",
          role: "reviewer",
          name: "Fresh system reviewer",
          reason: "Assign independent review and admission",
          mandate: {
            mayReviewExactCandidate: true,
            mayAdmitReviewedCandidates: true,
          },
        },
      ];
      for (const request of requests) {
        const before = await adapter.readExecutableModel(identity);
        const governance = SystemGovernance.fromExecutable(before);
        const proposed = governance.propose(
          request,
          crypto.randomUUID(),
          "2026-10-24T00:00:00Z",
          {
            requestedBy: before.identity.builderId,
            designerScopeId: "authority-fixture:designer",
          },
        );
        const approved = governance.decideChange(
          proposed.id,
          proposed.baseRevision,
          true,
          "2026-10-24T00:01:00Z",
        );
        assert.equal(approved.authorityExercise?.ownerSource, "modeled");
        assert.equal(approved.authorityExercise?.outOfMandate, false);
        assert.equal(approved.authorityExercise?.reason, undefined);
        const after = await applyApprovedSourceChange(
          adapter,
          identity,
          approved,
          before.version.digest,
        );
        assert.equal(
          after.configuration.revision,
          before.configuration.revision + 1,
        );
        assert.equal(
          after.ownerAuthority?.rootAuthorityId,
          receipt.rootAuthorityId,
        );
        if (request.kind === "propose_agent_creation") {
          assert.equal(after.configuration.reviewer?.name, request.name);
          assert.equal(
            after.configuration.builder.admissionAuthority,
            "reviewer",
          );
        } else if ("addNetworkHosts" in request.requestedRights) {
          assert.deepEqual(after.configuration.network?.allowedHosts, [
            "example.org",
          ]);
        } else if ("setUrlSelectionMode" in request.requestedRights) {
          assert.equal(after.policy.urlSelectionMode, "authorized-host");
        } else {
          assert.equal(
            after.configuration.builder.admissionAuthority,
            "builder",
          );
        }
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});
