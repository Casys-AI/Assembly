/** Native profile smoke check. It does not qualify the end-to-end Request flow. */
import assert from "node:assert/strict";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { validateSourceExecutable } from "../../src/adapters/model/sources/source-model.ts";
import {
  openRequestValueFixture,
  requestValueContextPolicy,
  requestValueSources,
} from "../fixtures/request-value-profile.ts";
import { validateContextPolicy } from "../../src/domain/work/policies/context-separation.ts";

Deno.test("Request value source profile opts all four operators into existing context projection only", async () => {
  validateContextPolicy({
    kind: "separated-context",
    pattern: "5.1",
    ...requestValueContextPolicy,
  });
  const sources = await requestValueSources();
  const configuration = sources["configuration.sysml"]!;
  assert(sources["context.sysml"]!.includes("part def DecisionContextPolicy"));
  assert.equal(
    configuration.match(/part policy : APEContext::DecisionContextPolicy/g)
      ?.length,
    4,
  );
  for (
    const system of [
      "liveBuilder",
      "researchOwner",
      "permissionsOperator",
      "constraintsOperator",
    ]
  ) {
    assert(configuration.includes(`"request-value-context-${system}-v1"`));
  }
  for (const [field, value] of Object.entries(requestValueContextPolicy)) {
    assert.equal(
      configuration.split(`attribute :>> ${field} = ${value};`).length - 1,
      4,
    );
  }
  assert(!configuration.includes("APEContext::ReadContextEvidence"));
  assert(!configuration.includes("APESkills::"));
  assert(!configuration.includes("APEMemory::"));
  assert(configuration.includes("perm-net with no dependencies"));
  assert(configuration.includes("resume:true"));
  assert(configuration.includes("same complete tasksJson graph"));
  assert(configuration.includes("do not prepare a tool or read a page"));
});

Deno.test({
  name: "Request value profile compiles the owner and two bounded operators",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const fixture = await openRequestValueFixture(
      Deno.env.get("SYSML_TOOLKIT_DIR")!,
    );
    try {
      await fixture.primary.initialize();
      const head = await fixture.repository.current();
      for (
        const name of [
          "liveBuilder",
          "researchOwner",
          "permissionsOperator",
          "constraintsOperator",
        ]
      ) {
        const model = await validateSourceExecutable(
          head,
          fixture.projectId,
          `AssemblyLiveBuilder::${name}`,
        );
        assert(model.contextPolicy);
        assert.equal(model.contextPolicy.kind, "separated-context");
        assert.equal(model.contextPolicy.pattern, "5.1");
        assert.equal(
          model.contextPolicy.id,
          `request-value-context-${name}-v1`,
        );
        assert.equal(model.contextPolicy.revision, 1);
        for (
          const [field, value] of Object.entries(requestValueContextPolicy)
        ) {
          assert.equal(
            model
              .contextPolicy[field as keyof typeof requestValueContextPolicy],
            value,
          );
        }
        assert(model.contextPolicy.sourceIds.length > 0);
        assert.equal(model.memoryPolicy, undefined);
        assert.equal(model.skillPolicy, undefined);
        assert.equal(model.initialSkills, undefined);
        assert.deepEqual(model.configuration.network?.allowedHosts, []);
        assert.equal(model.catalog.length, 0);
        assert.equal(
          model.policy.mayProposeSysmlRevision,
          name === "liveBuilder",
        );
        assert.equal(
          model.policy.urlSelectionMode,
          name.endsWith("Operator") ? "authorized-host" : "user-provided",
        );
        assert(
          !model.behaviors?.some((entry) => entry.name === "ConsulterPreuve"),
        );
        assert.equal(model.operatorAuthorityPolicies?.length ?? 0, 0);
        assert.equal(model.toolAdmissionPolicies?.length ?? 0, 0);
      }
      const owner = await validateSourceExecutable(
        head,
        fixture.projectId,
        "AssemblyLiveBuilder::researchOwner",
      );
      assert.equal(
        owner.caseTypes?.find((entry) => entry.name === "ResearchRequest")
          ?.maxInvocations,
        40,
      );
      assert(
        owner.operatorEntries?.some((entry) => entry.kind === "work-plan"),
      );
      assert(owner.behaviors?.some((entry) => entry.name === "Execute plan"));
      for (
        const name of ["permissions contribution", "constraints contribution"]
      ) {
        assert(owner.behaviors?.some((entry) => entry.name === name));
      }
      for (const name of ["permissionsOperator", "constraintsOperator"]) {
        const model = await validateSourceExecutable(
          head,
          fixture.projectId,
          `AssemblyLiveBuilder::${name}`,
        );
        assert.equal(model.policy.urlSelectionMode, "authorized-host");
        assert.deepEqual(model.configuration.network?.allowedHosts, []);
        assert(model.operatorEntries?.some((entry) => entry.kind === "inbox"));
      }
    } finally {
      await fixture.closeBackend();
      await Deno.remove(fixture.directory, { recursive: true });
    }
  },
});
