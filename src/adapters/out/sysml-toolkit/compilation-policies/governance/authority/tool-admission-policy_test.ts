import { canonicalProductName } from "../../../../../../domain/model/sysml-product-names.ts";
import { deepStrictEqual, throws } from "node:assert/strict";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../../domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../../../../../domain/shared-kernel/model-identity.ts";
import type { NativeLiteral } from "../../../../../../domain/model/records/native-literal.ts";
import { compileToolAdmissionPolicies } from "./tool-admission-policy.ts";

const fields = {
  id: "String",
  revision: "Integer",
  enabled: "Boolean",
  recipients: "String",
  toolKinds: "String",
  maxDelegationDepth: "Integer",
} as const;
function fixture() {
  const elements: ElementRecord[] = [];
  const add = (
    id: string,
    qualifiedName: string,
    metaclass: string,
    ownerId = "root",
    typeIds: string[] = [],
  ) => {
    const value: ElementRecord = {
      id,
      qualifiedName,
      name: qualifiedName.split("::").at(-1)!,
      metaclass,
      ownerId,
      typeIds,
      direction: "",
      generalIds: [],
      redefinedIds: [],
      isReference: false,
      multiplicity: "",
      doc: "",
    };
    elements.push(value);
    return value;
  };
  add("policy", "ASEAuthority::ToolAdmissionPolicy", "PartDefinition");
  for (const scalar of ["String", "Integer", "Boolean", "Real"]) {
    add(`scalar-${scalar}`, `ScalarValues::${scalar}`, "DataType");
  }
  add("software", "ASECore::SoftwareOperator", "PartDefinition");
  add("mandate", "ASECore::ConfiguredMandate", "ItemDefinition");
  add("root-authority", "ASEAuthority::RootAuthority", "PartDefinition");
  for (const [name, scalar] of Object.entries(fields)) {
    add(
      name,
      `ASEAuthority::ToolAdmissionPolicy::${name}`,
      "AttributeUsage",
      "policy",
      [`scalar-${scalar}`],
    );
  }
  for (
    const [name, metaclass, typeId] of [
      ["holder", "ReferenceUsage", "software"],
      ["mandate", "ItemUsage", "mandate"],
      ["issuer", "PartUsage", "root-authority"],
    ]
  ) {
    add(
      `policy-${name}`,
      `ASEAuthority::ToolAdmissionPolicy::${name}`,
      metaclass!,
      "policy",
      [typeId!],
    ).isReference = true;
  }
  const snapshot: ModelSnapshot = {
    rootId: "root",
    elements,
    connectors: [],
    invocations: [],
    patternIds: [],
  };
  const identity: ModelIdentity = {
    projectId: "test",
    editingContextId: "test",
    rootId: "root",
    systemId: "system",
    builderId: "builder",
    catalogId: "catalog",
  };
  const literals: NativeLiteral[] = [];
  return { snapshot, identity, literals };
}
Deno.test("an unused tool admission definition validates every declared scalar type", () => {
  const f = fixture();
  deepStrictEqual(
    compileToolAdmissionPolicies(f.snapshot, f.literals, f.identity),
    [],
  );
  for (const [name, scalar] of Object.entries(fields)) {
    const bad = fixture();
    bad.snapshot.elements.find((element) => element.id === name)!.typeIds = [
      `scalar-${scalar === "String" ? "Boolean" : "String"}`,
    ];
    throws(
      () =>
        compileToolAdmissionPolicies(bad.snapshot, bad.literals, bad.identity),
      {
        code: "INVALID_AUTHORITY_POLICY",
        message: `Invalid declared scalar ${name}`,
      },
    );
  }
  const foreignString = fixture();
  foreignString.snapshot.elements.find((element) =>
    element.id === "scalar-String"
  )!
    .qualifiedName = "Business::String";
  throws(
    () =>
      compileToolAdmissionPolicies(
        foreignString.snapshot,
        foreignString.literals,
        foreignString.identity,
      ),
    { code: "INVALID_AUTHORITY_POLICY", message: "Invalid declared scalar id" },
  );
  const realRevision = fixture();
  realRevision.snapshot.elements.find((element) => element.id === "revision")!
    .typeIds = ["scalar-Real"];
  throws(
    () =>
      compileToolAdmissionPolicies(
        realRevision.snapshot,
        realRevision.literals,
        realRevision.identity,
      ),
    {
      code: "INVALID_AUTHORITY_POLICY",
      message: "Invalid declared scalar revision",
    },
  );
});
Deno.test("an unused tool admission definition requires an exact root authority issuer reference", () => {
  for (
    const mutate of [
      (f: ReturnType<typeof fixture>) =>
        f.snapshot.elements.find((element) => element.id === "policy-issuer")!
          .typeIds = ["software"],
      (f: ReturnType<typeof fixture>) =>
        f.snapshot.elements.find((element) => element.id === "policy-issuer")!
          .isReference = false,
      (f: ReturnType<typeof fixture>) =>
        f.snapshot.elements.find((element) => element.id === "policy-issuer")!
          .metaclass = "ReferenceUsage",
      (f: ReturnType<typeof fixture>) =>
        f.snapshot.elements.find((element) => element.id === "policy-issuer")!
          .multiplicity = "0..*",
      (f: ReturnType<typeof fixture>) =>
        f.snapshot.elements = f.snapshot.elements.filter((element) =>
          element.id !== "policy-issuer"
        ),
      (f: ReturnType<typeof fixture>) =>
        f.snapshot.elements = f.snapshot.elements.filter((element) =>
          element.id !== "root-authority"
        ),
    ]
  ) {
    const f = fixture();
    mutate(f);
    throws(
      () => compileToolAdmissionPolicies(f.snapshot, f.literals, f.identity),
      { code: "INVALID_AUTHORITY_POLICY" },
    );
  }
});
Deno.test("omitted library scalar definitions require unambiguous native type-name evidence", () => {
  const f = fixture();
  f.snapshot.elements = f.snapshot.elements.filter((element) =>
    element.metaclass !== "DataType"
  );
  for (const scalar of ["String", "Integer", "Boolean"]) {
    f.literals.push({
      owner: "native-holder",
      name: `proof-${scalar}`,
      attributeId: `attribute-${scalar}`,
      literalId: `literal-${scalar}`,
      kind: `Literal${scalar}`,
      value: "",
      typeIds: [`scalar-${scalar}`],
      typeNames: [`ScalarValues::${scalar}`],
    });
  }
  deepStrictEqual(
    compileToolAdmissionPolicies(f.snapshot, f.literals, f.identity),
    [],
  );
  const missing = structuredClone(f);
  missing.literals = missing.literals.filter((literal) =>
    literal.typeNames[0] !== "ScalarValues::Boolean"
  );
  throws(
    () =>
      compileToolAdmissionPolicies(
        missing.snapshot,
        missing.literals,
        missing.identity,
      ),
    {
      code: "INVALID_AUTHORITY_POLICY",
      message: "Invalid declared scalar enabled",
    },
  );
  const ambiguous = structuredClone(f);
  ambiguous.literals.push({
    ...ambiguous.literals[0]!,
    typeNames: ["ScalarValues::Real"],
  });
  throws(
    () =>
      compileToolAdmissionPolicies(
        ambiguous.snapshot,
        ambiguous.literals,
        ambiguous.identity,
      ),
    { code: "INVALID_AUTHORITY_POLICY", message: "Invalid declared scalar id" },
  );
  const mismatched = structuredClone(f);
  mismatched.snapshot.elements.find((element) => element.id === "enabled")!
    .typeIds = ["scalar-String"];
  throws(
    () =>
      compileToolAdmissionPolicies(
        mismatched.snapshot,
        mismatched.literals,
        mismatched.identity,
      ),
    {
      code: "INVALID_AUTHORITY_POLICY",
      message: "Invalid declared scalar enabled",
    },
  );
});
Deno.test("absence of the optional tool admission definition remains inert", () => {
  const f = fixture();
  f.snapshot.elements = f.snapshot.elements.filter((element) =>
    element.id !== "policy" && element.ownerId !== "policy"
  );
  deepStrictEqual(
    compileToolAdmissionPolicies(f.snapshot, f.literals, f.identity),
    [],
  );
});

Deno.test("Assembly tool admission declarations retain inert legacy behavior and reject competing identities", () => {
  const f = fixture();
  for (const element of f.snapshot.elements) {
    element.qualifiedName = canonicalProductName(element.qualifiedName);
  }
  deepStrictEqual(
    compileToolAdmissionPolicies(f.snapshot, f.literals, f.identity),
    [],
  );
  f.snapshot.elements.push({
    ...f.snapshot.elements.find((element) => element.id === "policy")!,
    id: "competing-legacy-policy",
    qualifiedName: "ASEAuthority::ToolAdmissionPolicy",
  });
  throws(
    () => compileToolAdmissionPolicies(f.snapshot, f.literals, f.identity),
    { code: "INVALID_AUTHORITY_POLICY" },
  );
});

Deno.test("4.8c C2: an optional recipientSpace declaration is a validated String; legacy definitions compile without it", () => {
  const declare = (scalar: string) => {
    const f = fixture();
    f.snapshot.elements.push({
      ...f.snapshot.elements.find((element) => element.id === "recipients")!,
      id: "recipientSpace",
      qualifiedName: "ASEAuthority::ToolAdmissionPolicy::recipientSpace",
      name: "recipientSpace",
      typeIds: [`scalar-${scalar}`],
    });
    return f;
  };
  const declared = declare("String");
  deepStrictEqual(
    compileToolAdmissionPolicies(
      declared.snapshot,
      declared.literals,
      declared.identity,
    ),
    [],
  );
  const wrong = declare("Boolean");
  throws(
    () =>
      compileToolAdmissionPolicies(
        wrong.snapshot,
        wrong.literals,
        wrong.identity,
      ),
    {
      code: "INVALID_AUTHORITY_POLICY",
      message: "Invalid declared scalar recipientSpace",
    },
  );
  const unknown = declare("String");
  unknown.snapshot.elements.find((element) => element.id === "recipientSpace")!
    .name = "recipientScope";
  throws(
    () =>
      compileToolAdmissionPolicies(
        unknown.snapshot,
        unknown.literals,
        unknown.identity,
      ),
    {
      code: "INVALID_AUTHORITY_POLICY",
      message: "Unsupported policy definition members",
    },
  );
});
