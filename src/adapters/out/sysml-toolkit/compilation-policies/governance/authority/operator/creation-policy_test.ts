import assert from "node:assert/strict";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../../../domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../../../../../../domain/shared-kernel/model-identity.ts";
import { compileOperatorCreationPolicies } from "./creation-policy.ts";

function fixture(product = "Assembly") {
  const elements: ElementRecord[] = [];
  const add = (
    id: string,
    qualifiedName: string,
    metaclass: string,
    ownerId = "root",
    typeIds: string[] = [],
  ) => {
    const element: ElementRecord = {
      id,
      qualifiedName,
      metaclass,
      ownerId,
      typeIds,
      name: qualifiedName.split("::").at(-1)!,
      isReference: false,
      redefinedIds: [],
      generalIds: [],
      direction: "",
      doc: "",
      multiplicity: "",
    };
    elements.push(element);
    return element;
  };
  const policyName = `${product}Authority::OperatorCreationPolicy`;
  add("policy", policyName, "PartDefinition");
  for (const scalar of ["String", "Integer", "Boolean"]) {
    add(scalar, `ScalarValues::${scalar}`, "DataType");
  }
  add("software", `${product}Core::SoftwareOperator`, "PartDefinition");
  add("mandate-type", `${product}Core::ConfiguredMandate`, "ItemDefinition");
  add("root-authority", `${product}Authority::RootAuthority`, "PartDefinition");
  for (
    const [name, kind] of Object.entries({
      id: "String",
      revision: "Integer",
      enabled: "Boolean",
      networkHosts: "String",
      maxChildren: "Integer",
      maxDelegationDepth: "Integer",
    })
  ) add(name, `${policyName}::${name}`, "AttributeUsage", "policy", [kind]);
  for (
    const [name, kind, type] of [
      ["holder", "ReferenceUsage", "software"],
      ["mandate", "ItemUsage", "mandate-type"],
      ["issuer", "PartUsage", "root-authority"],
      ["parent", "PartUsage", "policy"],
    ]
  ) {
    const feature = add(name!, `${policyName}::${name}`, kind!, "policy", [
      type!,
    ]);
    feature.isReference = true;
    if (name === "parent") feature.multiplicity = "0..1";
  }
  const snapshot: ModelSnapshot = {
    rootId: "root",
    elements,
    connectors: [],
    invocations: [],
    patternIds: [],
  };
  const identity: ModelIdentity = {
    projectId: "unit",
    editingContextId: "unit",
    rootId: "root",
    systemId: "system",
    builderId: "builder",
    catalogId: "catalog",
  };
  return { snapshot, identity };
}

Deno.test("an unused native creation policy grants nothing and validates its closed typed declaration", () => {
  for (const product of ["Assembly", "ASE"]) {
    const f = fixture(product);
    assert.deepEqual(
      compileOperatorCreationPolicies(f.snapshot, [], f.identity),
      [],
    );
    for (
      const name of [
        "id",
        "revision",
        "enabled",
        "networkHosts",
        "maxChildren",
        "maxDelegationDepth",
      ]
    ) {
      const broken = fixture(product);
      broken.snapshot.elements.find((element) => element.name === name)!
        .typeIds = ["software"];
      assert.throws(
        () =>
          compileOperatorCreationPolicies(broken.snapshot, [], broken.identity),
        /scalar declaration/,
      );
    }
    for (const name of ["holder", "mandate", "issuer", "parent"]) {
      const broken = fixture(product);
      broken.snapshot.elements.find((element) => element.name === name)!
        .isReference = false;
      assert.throws(
        () =>
          compileOperatorCreationPolicies(broken.snapshot, [], broken.identity),
        /declaration/,
      );
    }
    const repeated = structuredClone(f);
    repeated.snapshot.elements.push({
      ...repeated.snapshot.elements[0]!,
      id: "second-definition",
    });
    assert.throws(
      () =>
        compileOperatorCreationPolicies(
          repeated.snapshot,
          [],
          repeated.identity,
        ),
      /unique/,
    );
    const many = structuredClone(f);
    many.snapshot.elements.find((element) => element.name === "parent")!
      .multiplicity = "0..*";
    assert.throws(
      () => compileOperatorCreationPolicies(many.snapshot, [], many.identity),
      /optional singleton/,
    );
    const foreignScalar = structuredClone(f);
    foreignScalar.snapshot.elements.find((element) => element.id === "String")!
      .qualifiedName = "Business::String";
    assert.throws(
      () =>
        compileOperatorCreationPolicies(
          foreignScalar.snapshot,
          [],
          foreignScalar.identity,
        ),
      /scalar declaration/,
    );
  }
});

Deno.test("the creation policy definition accepts the optional mode attribute and rejects a mistyped one", () => {
  const withMode = fixture();
  withMode.snapshot.elements.push({
    id: "mode",
    qualifiedName: "AssemblyAuthority::OperatorCreationPolicy::mode",
    metaclass: "AttributeUsage",
    ownerId: "policy",
    typeIds: ["String"],
    name: "mode",
    isReference: false,
    redefinedIds: [],
    generalIds: [],
    direction: "",
    doc: "",
    multiplicity: "",
  });
  assert.deepEqual(
    compileOperatorCreationPolicies(withMode.snapshot, [], withMode.identity),
    [],
  );
  const broken = structuredClone(withMode);
  broken.snapshot.elements.find((element) => element.name === "mode")!
    .typeIds = ["software"];
  assert.throws(
    () => compileOperatorCreationPolicies(broken.snapshot, [], broken.identity),
    /scalar declaration mode/,
  );
});

Deno.test("native creation scalar identity survives omitted standard-library DataTypes", () => {
  const { snapshot, identity } = fixture();
  snapshot.elements = snapshot.elements.filter((element) =>
    element.metaclass !== "DataType"
  );
  const literals = ["String", "Integer", "Boolean"].map((kind) => ({
    owner: "native-carrier",
    name: kind,
    attributeId: `carrier-${kind}`,
    literalId: `literal-${kind}`,
    kind: `Literal${kind}`,
    value: kind === "String" ? "value" : kind === "Integer" ? "1" : "true",
    typeIds: [kind],
    typeNames: [`ScalarValues::${kind}`],
  }));
  assert.deepEqual(
    compileOperatorCreationPolicies(snapshot, literals, identity),
    [],
  );
  const altered = structuredClone(literals);
  altered[0]!.typeNames = ["Business::String"];
  assert.throws(
    () => compileOperatorCreationPolicies(snapshot, altered, identity),
    /scalar declaration id/,
  );
});
