import { canonicalProductName } from "../../../../../../domain/model/sysml-product-names.ts";
import { compileOwnerAuthority } from "./owner-authority.ts";
import type { NativeLiteral } from "../../../../../../domain/model/records/native-literal.ts";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../../domain/model/records/snapshot.ts";
import { AuthorityInvariantError } from "../../../../../../domain/governance/authority.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function fixture() {
  const elements: ElementRecord[] = [];
  const literals: NativeLiteral[] = [];
  const add = (
    id: string,
    ownerId: string,
    name: string,
    metaclass: string,
    type?: string,
  ) => {
    const element: ElementRecord = {
      id,
      ownerId,
      name,
      metaclass,
      qualifiedName: name,
      typeIds: type ? [type] : [],
      generalIds: [],
      redefinedIds: [],
      isReference: false,
      direction: "",
      multiplicity: "",
      doc: "",
    };
    elements.push(element);
    return element;
  };
  add("system", "package", "system", "PartUsage");
  add("operator-type", "package", "ASECore::Operator", "PartDefinition");
  add("human-type", "package", "ASECore::HumanOperator", "PartDefinition")
    .generalIds = ["operator-type"];
  add("mandate-type", "package", "ASEAuthority::Mandate", "ItemDefinition");
  add("root-type", "package", "ASEAuthority::RootAuthority", "PartDefinition");
  add("grant-type", "package", "ASEAuthority::RootGrant", "PartDefinition");
  add("holder", "mandate-type", "holder", "PartUsage", "operator-type")
    .isReference = true;
  add("issuer", "grant-type", "issuer", "PartUsage", "root-type").isReference =
    true;
  add("owner", "system", "owner", "PartUsage", "human-type");
  add("mandate", "owner", "ownerMandate", "ItemUsage", "mandate-type");
  add("root", "mandate", "rootAuthority", "PartUsage", "root-type");
  add("grant", "mandate", "rootGrant", "PartUsage", "grant-type");
  const field = (owner: string, name: string, value: string | number) => {
    const scalar = typeof value === "string" ? "String" : "Integer";
    const attributeId = `${owner}-${name}`;
    add(attributeId, owner, name, "AttributeUsage", `${scalar}-type`);
    literals.push({
      owner,
      name,
      attributeId,
      literalId: `${attributeId}-literal`,
      kind: `Literal${scalar}`,
      value: String(value),
      typeIds: [`${scalar}-type`],
      typeNames: [`ScalarValues::${scalar}`],
    });
  };
  field("system", "authoritySchema", 2);
  field("mandate", "id", "owner");
  field("mandate", "revision", 1);
  field("root", "id", "root");
  field("grant", "id", "root-grant");
  const snapshot: ModelSnapshot = {
    rootId: "package",
    elements,
    connectors: [
      {
        id: "holder-binding",
        name: "",
        metaclass: "BindingConnectorAsUsage",
        ownerId: "system",
        ends: [["owner", "mandate", "holder"], ["owner"]].map((ids) => ({
          chain: ids.map((id) => ({ id, name: id })),
        })),
      },
      {
        id: "issuer-binding",
        name: "",
        metaclass: "BindingConnectorAsUsage",
        ownerId: "mandate",
        ends: [["grant", "issuer"], ["root"]].map((ids) => ({
          chain: ids.map((id) => ({ id, name: id })),
        })),
      },
    ],
    invocations: [],
    patternIds: [],
  };
  return { snapshot, literals, add, field };
}

Deno.test("owner compiler records exact native root provenance and preserves absent-owner legacy", () => {
  const f = fixture();
  const authority = compileOwnerAuthority(f.snapshot, f.literals, "system");
  assert(
    authority.ownerSource === "modeled" &&
      authority.rootGrantNativeId === "grant",
  );
  assert(
    authority.sourceIds.includes("holder-binding") &&
      authority.sourceIds.includes("system-authoritySchema-literal"),
  );
  f.add("other-human", "system", "reviewerHuman", "PartUsage", "human-type");
  assert(
    compileOwnerAuthority(f.snapshot, f.literals, "system").operatorNativeId ===
      "owner",
  );
  const legacy = compileOwnerAuthority(
    { ...f.snapshot, elements: [], connectors: [] },
    [],
    "legacy",
  );
  assert(
    legacy.ownerSource === "implicit-legacy" && legacy.systemId === "legacy",
  );
  assert(legacy.sourceIds.length === 0);
});

Deno.test("owner compiler recognizes structural types independently of usage names", () => {
  const f = fixture();
  for (
    const [id, name] of [
      ["owner", "custodian"],
      ["mandate", "custody"],
      ["root", "origin"],
      ["grant", "permission"],
    ]
  ) {
    f.snapshot.elements.find((e) => e.id === id)!.name = name!;
  }
  f.field("system", "owner", "commercial team");
  f.add("record", "system", "businessRecord", "ItemUsage");
  f.field("record", "owner", "Alice");
  const authority = compileOwnerAuthority(f.snapshot, f.literals, "system");
  assert(authority.ownerSource === "modeled");
  assert(authority.operatorId === "custodian");
  assert(authority.mandateNativeId === "mandate");
  assert(authority.rootAuthorityNativeId === "root");
  assert(authority.rootGrantNativeId === "grant");
});

Deno.test("owner compiler ignores business names and authority below the owner position", () => {
  const f = fixture();
  f.snapshot.elements = f.snapshot.elements.filter((e) =>
    e.name !== "authoritySchema"
  );
  f.add("record", "system", "businessRecord", "ItemUsage");
  f.snapshot.elements.find((e) => e.id === "owner")!.ownerId = "record";
  f.field("system", "owner", "commercial team");
  f.field("record", "rootAuthority", "business value");
  assert(
    compileOwnerAuthority(f.snapshot, f.literals, "system").ownerSource ===
      "implicit-legacy",
  );
  f.snapshot.elements = f.snapshot.elements.filter((e) =>
    ["system", "system-owner", "record", "record-rootAuthority"].includes(e.id)
  );
  f.field("record", "owner", "Alice");
  assert(
    compileOwnerAuthority(f.snapshot, f.literals, "system").ownerSource ===
      "implicit-legacy",
  );
});

Deno.test("owner compiler reserves only a direct typed integer authoritySchema literal", () => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      const attribute = f.snapshot.elements.find((e) =>
        e.id === "system-authoritySchema"
      )!;
      attribute.typeIds = ["String-type"];
      Object.assign(f.literals.find((v) => v.name === "authoritySchema")!, {
        kind: "LiteralString",
        value: "sales-v1",
        typeIds: ["String-type"],
        typeNames: ["ScalarValues::String"],
      });
    },
    (f) => {
      f.snapshot.elements.find((e) => e.id === "system-authoritySchema")!
        .metaclass = "PartUsage";
    },
    (f) => {
      f.snapshot.elements.find((e) => e.id === "system-authoritySchema")!
        .ownerId = "record";
      f.literals.find((v) => v.name === "authoritySchema")!.owner = "record";
    },
    (f) => {
      f.literals = f.literals.filter((v) => v.name !== "authoritySchema");
    },
    (f) => {
      f.literals.find((v) => v.name === "authoritySchema")!.kind =
        "LiteralString";
    },
    (f) => {
      f.literals.find((v) => v.name === "authoritySchema")!.typeNames = [
        "Business::Integer",
      ];
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    assert(
      compileOwnerAuthority(f.snapshot, f.literals, "system").ownerSource ===
        "modeled",
      `Business homonym must not invalidate modeled authority: ${mutate}`,
    );
    f.snapshot.elements = f.snapshot.elements.filter((e) => e.id !== "owner");
    assert(
      compileOwnerAuthority(f.snapshot, f.literals, "system").ownerSource ===
        "implicit-legacy",
      `Business homonym must not require modeled authority: ${mutate}`,
    );
  }
});

Deno.test("owner compiler refuses partial declarations, foreign issuer and nonsingleton authority", () => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      f.snapshot.elements = f.snapshot.elements.filter((e) => e.id !== "owner");
    },
    (f) => {
      f.snapshot.elements.find((e) => e.id === "owner")!.typeIds = [
        "operator-type",
      ];
    },
    (f) => {
      f.snapshot.elements.find((e) => e.id === "owner")!.isReference = true;
    },
    (f) => {
      f.snapshot.connectors[1]!.ends[1]!.chain[0]!.id = "foreign-root";
    },
    (f) => {
      f.snapshot.connectors.pop();
    },
    (f) => {
      f.snapshot.connectors.push({
        ...structuredClone(f.snapshot.connectors[1]!),
        id: "contradictory-root-binding",
        ownerId: "owner",
      });
    },
    (f) => {
      f.literals.find((v) => v.name === "revision")!.value = "0";
    },
    (f) => {
      f.literals.find((v) => v.name === "authoritySchema")!.value = "1";
    },
    (f) => {
      f.add("other-root", "mandate", "anotherRoot", "PartUsage", "root-type");
    },
  ];
  for (const id of ["owner", "mandate", "root", "grant", "holder", "issuer"]) {
    for (const multiplicity of ["0", "0..1", "2", "1..*"]) {
      mutations.push((f) => {
        f.snapshot.elements.find((e) => e.id === id)!.multiplicity =
          multiplicity;
      });
    }
  }
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    let rejected = false;
    try {
      compileOwnerAuthority(f.snapshot, f.literals, "system");
    } catch (error) {
      assert(
        error instanceof AuthorityInvariantError &&
          error.code === "AUTHORITY_INVARIANT" && error.invariant === 1,
        String(error),
      );
      rejected = true;
    }
    assert(rejected, String(mutate));
  }
});

Deno.test("Assembly owner declarations retain legacy native authority identities", () => {
  const f = fixture();
  const before = JSON.stringify(f.snapshot);
  const legacy = compileOwnerAuthority(f.snapshot, f.literals, "system");
  const current = structuredClone(f.snapshot);
  for (const element of current.elements) {
    element.qualifiedName = canonicalProductName(element.qualifiedName);
  }
  const actual = compileOwnerAuthority(current, f.literals, "system");
  assert(JSON.stringify(actual) === JSON.stringify(legacy));
  assert(
    JSON.stringify(f.snapshot) === before,
    "Legacy facts changed during lookup",
  );
  current.elements.push({
    ...current.elements.find((element) => element.id === "human-type")!,
    id: "competing-legacy-type",
    qualifiedName: "ASECore::HumanOperator",
  });
  let refused = false;
  try {
    compileOwnerAuthority(current, f.literals, "system");
  } catch (error) {
    refused = error instanceof AuthorityInvariantError;
  }
  assert(refused, "Competing product library identities must remain ambiguous");
});
