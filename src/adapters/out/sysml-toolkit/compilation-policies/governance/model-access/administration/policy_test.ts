import { toolkitIntegrationEnabled } from "../../../../../../../../test/support/toolkit-integration.ts";
import assert from "node:assert/strict";
import { AuthorityInvariantError } from "../../../../../../../domain/governance/authority.ts";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../../../domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../../../../../../domain/shared-kernel/model-identity.ts";
import { compileModelAdministrationPolicy } from "./policy.ts";
import { ToolkitCompiler } from "../../../../compilation/compiler.ts";
import {
  sourceLiterals,
  sourceSnapshot,
} from "../../../../../../../domain/model/projections/source-facts.ts";
import { loadInitialSources } from "../../../../../filesystem/initial-model-sources.ts";
import {
  sourceModelIdentity,
} from "../../../../../../../domain/model/records/source-identity.ts";

/** Insert inside the concrete liveBuilder; no existing project gets this grant. */
export const modelAdministrationPolicyFixture = `
part modelAdministrationPolicy : AssemblyModelAdministration::ModelAdministrationPolicy {
  attribute :>> id = "admin-policy-v1";
  attribute :>> revision = 1;
  attribute :>> operations = "[\\"set-value\\",\\"insert-member\\"]";
  attribute :>> recipients = "[\\"AssemblyLiveBuilder::mandatePeer\\"]";
  attribute :>> maxRedelegationDepth = 2;
  attribute :>> grants = "[{\\"file\\":\\"configuration.sysml\\",\\"qualifiedRoots\\":[\\"AssemblyLiveBuilder::liveBuilder\\"]}]";
}
bind modelAdministrationPolicy.holder = builder;
bind modelAdministrationPolicy.mandate = builderMandate;
bind modelAdministrationPolicy.issuer = owner.ownerMandate.rootAuthority;
`;
Deno.test({
  name:
    "native model administration policy compiles real native bindings and rejects altered authority",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = await loadInitialSources(undefined, { information: false });
    sources["model-administration.sysml"] = await Deno.readTextFile(
      new URL(
        "../../../../../../../../models/model-administration.sysml",
        import.meta.url,
      ),
    );
    sources["configuration.sysml"] = sources["configuration.sysml"]!.replace(
      "part liveBuilder : ConversationSystem {",
      `part liveBuilder : ConversationSystem {${modelAdministrationPolicyFixture}`,
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
    const policy = compileModelAdministrationPolicy(
      snapshot,
      literals,
      identity,
    )!;
    assert.equal(policy.rootAuthority?.ownerSource, "modeled");
    const rootBinding = structuredClone(snapshot);
    rootBinding.connectors = rootBinding.connectors.filter((connector) =>
      !connector.ends.some((end) =>
        end.chain[0]?.id === policy.elementId && end.chain[1]?.name === "issuer"
      )
    );
    assert.throws(
      () => compileModelAdministrationPolicy(rootBinding, literals, identity),
      (error) =>
        error instanceof AuthorityInvariantError && error.invariant === 1,
    );
    assert.equal(policy.holderNativeId, identity.builderId);
    assert.equal(policy.mandateRevision, 1);
    assert.equal(policy.maxRedelegationDepth, 2);
    assert.deepEqual(policy.recipients, ["AssemblyLiveBuilder::mandatePeer"]);
    assert(policy.sourceIds.includes(policy.elementId));
    assert(policy.sourceIds.includes(policy.holderNativeId));
    assert(policy.sourceIds.includes(policy.mandateNativeId));
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
          () =>
            compileModelAdministrationPolicy(nonsingleton, literals, identity),
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
      () => compileModelAdministrationPolicy(nested, literals, identity),
      /singleton/,
    );
    const zeroSource = {
      ...sources,
      "configuration.sysml": sources["configuration.sysml"]!.replace(
        "::ModelAdministrationPolicy {",
        "::ModelAdministrationPolicy [0] {",
      ),
    };
    const zeroCompiled = await new ToolkitCompiler({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    }).compile(zeroSource);
    assert.throws(
      () =>
        compileModelAdministrationPolicy(
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
      compileModelAdministrationPolicy(
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
      () => compileModelAdministrationPolicy(noBinding, literals, identity),
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
      () => compileModelAdministrationPolicy(duplicated, literals, identity),
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
      () => compileModelAdministrationPolicy(wrongHolder, literals, identity),
      /wrong holder/,
    );
    const wrongMandate = structuredClone(snapshot);
    const mandateEnd = wrongMandate.connectors.find((connector) =>
      connector.ends.some((end) => end.chain[0]?.id === policy.elementId) &&
      connector.ends.some((end) =>
        end.chain.length === 1 && end.chain[0]?.id === policy.mandateNativeId
      )
    )!.ends.find((end) => end.chain.length === 1)!;
    mandateEnd.chain[0]!.id = identity.builderId;
    assert.throws(
      () => compileModelAdministrationPolicy(wrongMandate, literals, identity),
      /wrong holder or mandate/,
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
      () => compileModelAdministrationPolicy(misplaced, literals, identity),
      /misplaced/,
    );
    for (
      const [field, value, error] of [
        ["operations", '["all"]', /operations/],
        ["operations", '["set-value","set-value"]', /operations/],
        [
          "grants",
          '[{"file":"../escape.sysml","qualifiedRoots":["Example"]}]',
          /path|name|source/i,
        ],
        [
          "grants",
          '[{"file":"configuration.sysml","qualifiedRoots":["Example::*"]}]',
          /root/,
        ],
        ["recipients", "[]", /recipients/],
        ["recipients", '["AssemblyLiveBuilder::*"]', /recipient/],
        ["recipients", '["AssemblyLiveBuilder::"]', /recipient/],
        [
          "recipients",
          '["AssemblyLiveBuilder::mandatePeer", "Other::peer"]',
          /canonical/,
        ],
        [
          "recipients",
          '["AssemblyLiveBuilder::mandatePeer","::AssemblyLiveBuilder::mandatePeer"]',
          /duplicate/,
        ],
        [
          "recipients",
          '["AssemblyLiveBuilder::mandatePeer","\\u0027AssemblyLiveBuilder\\u0027::\\u0027mandatePeer\\u0027"]',
          /canonical|duplicate/,
        ],
        [
          "recipients",
          JSON.stringify([
            "AssemblyLiveBuilder::mandatePeer",
            "'AssemblyLiveBuilder'::'mandatePeer'",
          ]),
          /duplicate/,
        ],
        ["recipients", JSON.stringify(["a".repeat(1025)]), /recipient/],
        ["recipients", "[1]", /recipient/],
        ["maxRedelegationDepth", "-1", /maxRedelegationDepth/],
        ["maxRedelegationDepth", "9", /maxRedelegationDepth/],
        ["maxRedelegationDepth", "1.5", /maxRedelegationDepth/],
        ["maxRedelegationDepth", "02", /maxRedelegationDepth/],
        ["revision", "0", /revision/],
      ] as const
    ) {
      const bad = structuredClone(literals);
      bad.find((literal) =>
        literal.owner === policy.elementId && literal.name === field
      )!.value = value;
      assert.throws(
        () => compileModelAdministrationPolicy(snapshot, bad, identity),
        error,
        `${field}: ${value}`,
      );
    }
    for (const depth of ["0", "8"]) {
      const valid = structuredClone(literals);
      valid.find((literal) =>
        literal.owner === policy.elementId &&
        literal.name === "maxRedelegationDepth"
      )!.value = depth;
      assert.equal(
        compileModelAdministrationPolicy(snapshot, valid, identity)!
          .maxRedelegationDepth,
        Number(depth),
      );
    }
    const mistyped = structuredClone(literals);
    mistyped.find((literal) =>
      literal.owner === policy.elementId &&
      literal.name === "maxRedelegationDepth"
    )!.kind = "LiteralString";
    assert.throws(
      () => compileModelAdministrationPolicy(snapshot, mistyped, identity),
      /typed literal maxRedelegationDepth/,
    );
    const extraField = structuredClone(snapshot);
    extraField.elements.push({
      ...extraField.elements.find((element) =>
        element.ownerId === policy.elementId
      )!,
      id: "unsupported-administration-field",
      name: "mayEdit",
    });
    assert.throws(
      () => compileModelAdministrationPolicy(extraField, literals, identity),
      /unsupported occurrence fields/,
    );
  },
});

Deno.test("absent administration declaration grants no authority; orphan and duplicate facts fail closed", () => {
  const identity: ModelIdentity = {
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    builderId: "builder",
    catalogId: "catalog",
  };
  const snapshot: ModelSnapshot = {
    rootId: "root",
    elements: [],
    connectors: [],
    invocations: [],
    patternIds: [],
  };
  assert.equal(
    compileModelAdministrationPolicy(snapshot, [], identity),
    undefined,
  );
  const orphan: ElementRecord = {
    id: "orphan",
    name: "ModelAdministrationPolicy",
    metaclass: "PartDefinition",
    ownerId: "missing",
    qualifiedName: "ASEModelAdministration::ModelAdministrationPolicy",
    typeIds: [],
    direction: "",
    generalIds: [],
    isReference: false,
    redefinedIds: [],
    multiplicity: "",
    doc: "",
  };
  snapshot.elements.push(orphan);
  assert.throws(
    () => compileModelAdministrationPolicy(snapshot, [], identity),
    /orphan/,
  );
  snapshot.elements.push({ ...orphan });
  assert.throws(
    () => compileModelAdministrationPolicy(snapshot, [], identity),
    /duplicate element identity/,
  );
});
