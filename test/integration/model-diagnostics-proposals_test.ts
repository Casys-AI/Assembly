/** Real Toolkit proposals preserve diagnostic intent without adopting the revision. */
import {
  sourceCompilation,
  sourceEvolutionCompilation,
  sourceExecutablesCompilation,
} from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import assert from "node:assert/strict";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { NativeModelSourceAuthorization } from "../../src/application/governance/model-access/source-authorization.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { SourceModelDiagnosticsReader } from "../../src/application/model/diagnostics/source-diagnostics-reader.ts";
import { ModelDiagnosticsService } from "../../src/application/model/diagnostics/service.ts";
import { requireExistingDiagnosticAddresses } from "../../src/domain/model/value-objects/diagnostic-address.ts";
import {
  nativeId,
  openMandateFixture,
} from "../fixtures/model-edit-mandate.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");

Deno.test({
  name:
    "native diagnostics correction addresses survive raw and targeted proposal persistence",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const f = await openMandateFixture(packageDir!, {
      raw: true,
    });
    try {
      const base = await f.repository.current();
      const current = await f.primary.readExecutableModel(f.primaryIdentity);
      const service = new ModelDiagnosticsService(
        new SourceModelDiagnosticsReader(
          f.repository,
          f.projectId,
          sourceExecutablesCompilation,
        ),
        { list: () => Promise.resolve([]), set: () => Promise.resolve() },
      );
      const original = await service.list(base.version);
      const finding = original.diagnostics.find((entry) =>
        entry.code === "LOOP_WITHOUT_BUDGET" &&
        entry.qualifiedName === "AssemblyLiveBuilder::liveBuilder"
      );
      assert(finding?.elementId);
      const addresses = requireExistingDiagnosticAddresses([{
        code: finding.code,
        elementId: finding.elementId,
      }], original.diagnostics);
      const raw = await f.primary.proposeRevision(f.primaryIdentity, {
        baseVersion: base.version,
        reason: "Record a proposed invocation limit for the missing budget",
        addresses,
        sources: {
          "mission.sysml": base.sources["mission.sysml"]!.replace(
            "attribute value : Integer = 1;",
            "attribute value : Integer = 12;",
          ),
        },
      }, current.version.digest);
      const targeted = await f.primary.proposeEdit(f.primaryIdentity, {
        baseVersion: base.version,
        sourceDigest: base.sourceDigest,
        reason: "Record a proposed invocation limit with a targeted edit",
        addresses,
        edits: [{
          kind: "set-value",
          elementId: nativeId(base, "Work::alpha::value"),
          expression: "12",
        }],
      }, current.version.digest);
      // Addresses records intent. A scoped design value does not install
      // an execution control, which requires a separate authorized change.
      for (const proposal of [raw, targeted]) {
        assert.deepEqual(proposal.addresses, addresses);
        const stored = await f.repository.proposal(proposal.id);
        assert.deepEqual(stored.addresses, addresses);
        const proposed = await service.list(stored.proposalVersion!);
        assert(
          proposed.diagnostics.some((entry) =>
            entry.code === finding.code &&
            entry.qualifiedName === finding.qualifiedName
          ),
          "Diagnostic intent must not be mistaken for resolution",
        );
      }
      assert.equal((await f.repository.current()).version, base.version);
      assert.equal(
        (await service.list(base.version)).diagnostics.length,
        original.diagnostics.length,
      );
      const reopened = await GitModelRepository.open({
        projectDir: f.directory,
        compiler: new ToolkitCompiler({ packageDir: packageDir! }),
        sourceAuthorization: new NativeModelSourceAuthorization(
          f.projectId,
          sourceCompilation,
          sourceEvolutionCompilation,
        ),
      });
      assert.deepEqual(
        (await reopened.listProposals()).map((p) => p.addresses),
        [addresses, addresses],
      );
      assert.deepEqual(
        (await f.primary.readSourceProposals(f.primaryIdentity))
          .map((p) => p.addresses),
        [addresses, addresses],
      );
    } finally {
      await f.close();
    }
  },
});
