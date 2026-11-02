import { toolkitIntegrationEnabled } from "../../../../../../../../test/support/toolkit-integration.ts";
import assert from "node:assert/strict";
import { AuthorityInvariantError } from "../../../../../../../domain/governance/authority.ts";
import { compileModelEditPolicy } from "./policy.ts";
import { ToolkitCompiler } from "../../../../compilation/compiler.ts";
import {
  sourceLiterals,
  sourceSnapshot,
} from "../../../../../../model/projections/graph/source.ts";
import { loadInitialSources } from "../../../../../filesystem/initial-model-sources.ts";
import {
  sourceModelIdentity,
} from "../../../../../../model/sources/source-model.ts";

/** Insert inside the concrete liveBuilder; no existing project gets this grant. */
export const modelEditPolicyFixture = `
part modelEditPolicy : AssemblyModelEditing::ModelEditPolicy {
  attribute :>> id = "edit-policy-v1";
  attribute :>> revision = 1;
  attribute :>> operations = "[\\"set-value\\",\\"insert-member\\"]";
  attribute :>> grants = "[{\\"file\\":\\"configuration.sysml\\",\\"qualifiedRoots\\":[\\"AssemblyLiveBuilder::liveBuilder\\"]}]";
}
bind modelEditPolicy.holder = builder;
bind modelEditPolicy.mandate = builderMandate;
bind modelEditPolicy.issuer = owner.ownerMandate.rootAuthority;
`;
Deno.test({
  name:
    "native model edit policy compiles real native bindings and rejects altered authority",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = await loadInitialSources(undefined, { information: false });
    sources["configuration.sysml"] = sources["configuration.sysml"]!.replace(
      "part liveBuilder : ConversationSystem {",
      `part liveBuilder : ConversationSystem {${modelEditPolicyFixture}`,
    );
    const compiled = await new ToolkitCompiler({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    }).compile(sources);
    const identity = sourceModelIdentity({
      ...compiled,
      version: "policy-test",
    }, "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf");
    const snapshot = sourceSnapshot(compiled.elements, identity.rootId);
    const literals = sourceLiterals(compiled.elements);
    const policy = compileModelEditPolicy(snapshot, literals, identity)!;
    assert.equal(policy.rootAuthority?.ownerSource, "modeled");
    const rootBinding = structuredClone(snapshot);
    rootBinding.connectors = rootBinding.connectors.filter((connector) =>
      !connector.ends.some((end) =>
        end.chain[0]?.id === policy.elementId && end.chain[1]?.name === "issuer"
      )
    );
    assert.throws(
      () => compileModelEditPolicy(rootBinding, literals, identity),
      (error) =>
        error instanceof AuthorityInvariantError && error.invariant === 1,
    );
    assert.equal(policy.holderNativeId, identity.builderId);
    assert.equal(policy.mandateRevision, 1);
    assert.deepEqual(policy.operations, ["set-value", "insert-member"]);
    assert.deepEqual(policy.grants, [{
      file: "configuration.sysml",
      qualifiedRoots: ["AssemblyLiveBuilder::liveBuilder"],
    }]);
    for (const multiplicity of ["0", "0..1", "2", "1..*", "?"]) {
      for (const targetId of [policy.elementId, identity.systemId]) {
        const nonsingleton = structuredClone(snapshot);
        nonsingleton.elements.find((element) => element.id === targetId)!
          .multiplicity = multiplicity;
        assert.throws(
          () => compileModelEditPolicy(nonsingleton, literals, identity),
          /singleton/,
        );
      }
    }
    const nested = structuredClone(snapshot);
    const nestedSystem = nested.elements.find((element) =>
      element.id === identity.systemId
    )!;
    nested.elements.push({
      ...nestedSystem,
      id: "zero-outer-part",
      name: "outer",
      qualifiedName: "AssemblyLiveBuilder::outer",
      typeIds: [],
      multiplicity: "0",
    });
    nestedSystem.ownerId = "zero-outer-part";
    assert.throws(
      () => compileModelEditPolicy(nested, literals, identity),
      /singleton/,
    );
    const zeroSource = {
      ...sources,
      "configuration.sysml": sources["configuration.sysml"]!.replace(
        "::ModelEditPolicy {",
        "::ModelEditPolicy [0] {",
      ),
    };
    const zeroCompiled = await new ToolkitCompiler({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    }).compile(zeroSource);
    assert.throws(
      () =>
        compileModelEditPolicy(
          sourceSnapshot(zeroCompiled.elements, identity.rootId),
          sourceLiterals(zeroCompiled.elements),
          identity,
        ),
      /singleton/,
    );
    const declarationOnly = {
      ...snapshot,
      elements: snapshot.elements.filter((element) =>
        element.id !== policy.elementId && element.ownerId !== policy.elementId
      ),
    };
    assert.equal(
      compileModelEditPolicy(
        declarationOnly,
        literals.filter((literal) => literal.owner !== policy.elementId),
        identity,
      ),
      undefined,
    );
    const noBinding = structuredClone(snapshot);
    noBinding.connectors = noBinding.connectors.filter((connector) =>
      !connector.ends.some((end) => end.chain[0]?.id === policy.elementId)
    );
    assert.throws(
      () => compileModelEditPolicy(noBinding, literals, identity),
      /binding/,
    );
    const duplicated = structuredClone(snapshot);
    duplicated.elements.push({
      ...duplicated.elements.find((element) =>
        element.id === policy.elementId
      )!,
      id: "duplicate-policy",
    });
    assert.throws(
      () => compileModelEditPolicy(duplicated, literals, identity),
      /duplicate occurrence/,
    );
    const wrongHolder = structuredClone(snapshot);
    const holderBinding = wrongHolder.connectors.find((connector) =>
      connector.ends.some((end) => end.chain[0]?.id === policy.elementId) &&
      connector.ends.some((end) =>
        end.chain.length === 1 && end.chain[0]?.id === identity.builderId
      )
    )!;
    const holderEnd = holderBinding.ends.find((end) =>
      end.chain.length === 1 && end.chain[0]?.id === identity.builderId
    )!;
    holderEnd.chain[0]!.id = identity.catalogId;
    assert.throws(
      () => compileModelEditPolicy(wrongHolder, literals, identity),
      /wrong holder/,
    );
    const misplaced = structuredClone(snapshot);
    misplaced.elements.find((element) => element.id === policy.elementId)!
      .ownerId = definitionId();
    function definitionId() {
      return snapshot.elements.find((element) =>
        element.qualifiedName === "AssemblyCore::SoftwareOperator"
      )!.id;
    }
    assert.throws(
      () => compileModelEditPolicy(misplaced, literals, identity),
      /misplaced/,
    );
    const bad = structuredClone(literals);
    bad.find((literal) =>
      literal.owner === policy.elementId && literal.name === "operations"
    )!.value = '["all"]';
    assert.throws(
      () => compileModelEditPolicy(snapshot, bad, identity),
      /operations/,
    );
  },
});
