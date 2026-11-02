import assert from "node:assert/strict";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  sourceModelIdentity,
  validateSourceExecutable,
} from "../../src/adapters/model/sources/source-model.ts";

import { compileSpaceControlPolicy } from "../../src/adapters/out/sysml-toolkit/compilation-policies/governance/authority/space-execution-policy.ts";
import {
  sourceLiterals,
  sourceSnapshot,
} from "../../src/adapters/model/projections/graph/source.ts";

Deno.test({
  name:
    "Toolkit compiles explicit native space control, hashes its contents, and preserves policy-free models",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const compiler = new ToolkitCompiler({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    });
    const sources = await loadInitialSources(undefined, { information: false });
    const projectId = "git:cdc1ab4f-083e-533c-90ca-953c38b63a92";
    const compile = async (input: Record<string, string>, version: string) =>
      await validateSourceExecutable({
        ...await compiler.compile(input),
        version,
      }, projectId);
    // Four bounded source compilations: explicit, disabled, absent, ambiguous.
    // No runtime, credentials, admissions, provider, DB or source publication.
    const model = await compile(sources, "test:space-policy-enabled");
    const policy = model.spaceControlPolicy!;
    assert(policy);
    assert.equal(policy.enabled, true);
    assert.equal(policy.holderNativeId, model.ownerAuthority!.operatorNativeId);
    assert.equal(policy.mandateNativeId, model.ownerAuthority!.mandateNativeId);
    assert.equal(
      policy.issuerRootNativeId,
      model.ownerAuthority!.rootAuthorityNativeId,
    );
    assert.equal(policy.systemId, model.identity.systemId);
    assert.deepEqual(policy.operatorIds, [model.identity.builderId]);
    assert.deepEqual(policy.acts, [
      "execute-conversation",
      "open-request",
      "retain-release",
      "revoke-execution",
    ]);
    for (const id of policy.sourceIds) {
      assert(model.version.sourceIds.includes(id));
    }
    const occurrence = sources["configuration.sysml"]!.match(
      / {8}part requestControl : AssemblyAuthority::SpaceControlPolicy \{[\s\S]*?\n {8}\}/,
    )?.[0];
    assert(occurrence, "Future seed must declare this grant explicitly");
    const disabled = {
      ...sources,
      "configuration.sysml": sources["configuration.sysml"]!.replace(
        occurrence,
        occurrence.replace(":>> enabled = true", ":>> enabled = false"),
      ),
    };
    const changed = await compile(disabled, "test:space-policy-disabled");
    assert.equal(changed.spaceControlPolicy!.enabled, false);
    assert.equal(changed.spaceControlPolicy!.revision, policy.revision);
    assert.notEqual(
      changed.version.digest,
      model.version.digest,
      "Permission content changes must affect the native model digest without a revision bump",
    );
    const withoutOccurrence = sources["configuration.sysml"]!.replace(
      occurrence,
      "",
    )
      .replace(/^ {8}bind requestControl\.[^\n]+\n/gm, "");
    const legacy = await compile({
      ...sources,
      "configuration.sysml": withoutOccurrence,
    }, "test:space-policy-absent");
    assert.equal(legacy.spaceControlPolicy, undefined);
    assert.equal(
      legacy.ownerAuthority!.ownerSource,
      "modeled",
      "Existing root authority alone must not supply CAP-3",
    );
    assert.notEqual(legacy.version.digest, model.version.digest);
    assert.equal(
      sources["configuration.sysml"]!.includes(occurrence),
      true,
      "Compilation preparation must not mutate the source bundle",
    );

    // This redundant same-target binding uses only real source symbols. The
    // native Toolkit must accept it before our bounded policy projection refuses.
    const configuration = sources["configuration.sysml"]!;
    const packageEnd = configuration.lastIndexOf("\n}");
    assert(packageEnd >= 0);
    const ambiguous = {
      ...sources,
      "configuration.sysml": configuration.slice(0, packageEnd) +
        "\n    bind liveBuilder.requestControl.holder = liveBuilder.owner;\n" +
        configuration.slice(packageEnd),
    };
    const compiled = await compiler.compile(ambiguous);
    const revision = {
      ...compiled,
      version: "test:space-policy-qualified-binding",
    };
    const identity = sourceModelIdentity(revision, projectId);
    const snapshot = sourceSnapshot(compiled.elements, identity.rootId);
    const control = snapshot.elements.find((element) =>
      element.ownerId === identity.systemId && element.name === "requestControl"
    )!;
    assert(control);
    const holder = snapshot.elements.find((element) =>
      element.ownerId === control.typeIds[0] && element.name === "holder"
    )!;
    assert(holder);
    const touching = snapshot.connectors.filter((connector) =>
      connector.metaclass === "BindingConnectorAsUsage" &&
      connector.ends.some((end) =>
        end.chain.some((part, index) =>
          part.id === control.id && end.chain[index + 1]?.id === holder.id
        )
      )
    );
    assert.equal(
      touching.length,
      2,
      "Both local and package-qualified bindings must be present in real native facts",
    );
    assert(
      touching.some((connector) =>
        connector.ownerId !== identity.systemId &&
        connector.ends.some((end) =>
          end.chain.length > 2 && end.chain[0]?.id === identity.systemId
        )
      ),
      "Native witness must retain the qualified endpoint",
    );
    assert.throws(
      () =>
        compileSpaceControlPolicy(
          snapshot,
          sourceLiterals(compiled.elements),
          identity,
        ),
      /invalid or foreign holder binding/,
    );
    await assert.rejects(
      () => validateSourceExecutable(revision, projectId),
      /invalid or foreign holder binding/,
    );
  },
});
