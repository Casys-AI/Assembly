import { deepStrictEqual, equal, throws } from "node:assert/strict";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../../domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../../../../../domain/shared-kernel/model-identity.ts";
import type { NativeLiteral } from "../../../../../../domain/model/records/native-literal.ts";
import { compileSpaceControlPolicy } from "./space-execution-policy.ts";
import {
  spaceControlActs,
  spaceControlPolicyFields,
} from "../../../../../../domain/governance/policies/space-execution-policy.ts";

function fixture() {
  const elements: ElementRecord[] = [], literals: NativeLiteral[] = [];
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
      name: name.split("::").at(-1)!,
      qualifiedName: name,
      metaclass,
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
  add("package", "", "Fixture", "Package");
  add(
    "system-type",
    "package",
    "AssemblyLiveBuilder::ConversationSystem",
    "PartDefinition",
  );
  add("system", "package", "Fixture::system", "PartUsage", "system-type");
  add("operator-type", "package", "AssemblyCore::Operator", "PartDefinition");
  add("human-type", "package", "AssemblyCore::HumanOperator", "PartDefinition")
    .generalIds = ["operator-type"];
  add(
    "software-type",
    "package",
    "AssemblyCore::SoftwareOperator",
    "PartDefinition",
  ).generalIds = ["operator-type"];
  add("builder", "system", "builder", "PartUsage", "software-type");
  add(
    "mandate-type",
    "package",
    "AssemblyAuthority::Mandate",
    "ItemDefinition",
  );
  add(
    "root-type",
    "package",
    "AssemblyAuthority::RootAuthority",
    "PartDefinition",
  );
  add(
    "grant-type",
    "package",
    "AssemblyAuthority::RootGrant",
    "PartDefinition",
  );
  add("owner-holder", "mandate-type", "holder", "PartUsage", "operator-type")
    .isReference = true;
  add("grant-issuer", "grant-type", "issuer", "PartUsage", "root-type")
    .isReference = true;
  add("owner", "system", "owner", "PartUsage", "human-type");
  add("mandate", "owner", "ownerMandate", "ItemUsage", "mandate-type");
  add("root", "mandate", "rootAuthority", "PartUsage", "root-type");
  add("grant", "mandate", "rootGrant", "PartUsage", "grant-type");
  for (const name of ["String", "Integer", "Boolean"]) {
    add(`${name}-type`, "package", `ScalarValues::${name}`, "DataType");
  }
  const field = (
    owner: string,
    name: string,
    value: string | number | boolean,
  ) => {
    const scalar = typeof value === "string"
      ? "String"
      : typeof value === "number"
      ? "Integer"
      : "Boolean";
    const attribute = add(
      `${owner}-${name}`,
      owner,
      name,
      "AttributeUsage",
      `${scalar}-type`,
    );
    literals.push({
      owner,
      name,
      attributeId: attribute.id,
      literalId: `${attribute.id}-literal`,
      kind: `Literal${scalar}`,
      value: String(value),
      typeIds: [`${scalar}-type`],
      typeNames: [`ScalarValues::${scalar}`],
    });
    return attribute;
  };
  field("system", "authoritySchema", 2);
  field("mandate", "id", "owner");
  field("mandate", "revision", 1);
  field("root", "id", "root");
  field("grant", "id", "root-grant");
  add(
    "policy-type",
    "package",
    "AssemblyAuthority::SpaceControlPolicy",
    "PartDefinition",
  );
  for (
    const [name, scalar] of [["id", "String"], ["revision", "Integer"], [
      "enabled",
      "Boolean",
    ], ["acts", "String"]]
  ) {
    add(
      `policy-${name}`,
      "policy-type",
      name!,
      "AttributeUsage",
      `${scalar}-type`,
    );
  }
  for (
    const [name, metaclass, type] of [
      ["holder", "PartUsage", "human-type"],
      ["mandate", "ItemUsage", "mandate-type"],
      ["issuer", "PartUsage", "root-type"],
      ["allowedOperator", "PartUsage", "software-type"],
    ]
  ) {
    add(`policy-${name}`, "policy-type", name!, metaclass!, type!).isReference =
      true;
  }
  add("control", "system", "requestControl", "PartUsage", "policy-type");
  for (
    const [name, value] of Object.entries({
      id: "control",
      revision: 1,
      enabled: true,
      acts: '["open-request","execute-conversation","revoke-execution"]',
    })
  ) {
    field("control", name, value).redefinedIds = [`policy-${name}`];
  }
  const snapshot: ModelSnapshot = {
    rootId: "package",
    elements,
    connectors: [],
    invocations: [],
    patternIds: [],
  };
  const bind = (id: string, ownerId: string, left: string[], right: string[]) =>
    snapshot.connectors.push({
      id,
      ownerId,
      name: "",
      metaclass: "BindingConnectorAsUsage",
      ends: [left, right].map((chain) => ({
        chain: chain.map((id) => ({ id, name: id })),
      })),
    });
  bind("owner-binding", "system", ["owner", "mandate", "owner-holder"], [
    "owner",
  ]);
  bind("grant-binding", "mandate", ["grant", "grant-issuer"], ["root"]);
  bind("control-holder", "system", ["control", "policy-holder"], ["owner"]);
  bind("control-mandate", "system", ["control", "policy-mandate"], [
    "owner",
    "mandate",
  ]);
  bind("control-issuer", "system", ["control", "policy-issuer"], [
    "owner",
    "mandate",
    "root",
  ]);
  bind("control-operator", "system", ["control", "policy-allowedOperator"], [
    "builder",
  ]);
  const identity: ModelIdentity = {
    projectId: "source-project",
    rootId: "package",
    editingContextId: "source-project/main",
    systemId: "system",
    builderId: "builder",
    catalogId: "catalog",
  };
  return {
    snapshot,
    literals,
    identity,
    add,
    field,
    element: (id: string) => elements.find((element) => element.id === id)!,
    value: (name: string) =>
      literals.find((literal) =>
        literal.owner === "control" && literal.name === name
      )!,
    binding: (id: string) =>
      snapshot.connectors.find((connector) => connector.id === id)!,
    compile: () => compileSpaceControlPolicy(snapshot, literals, identity),
  };
}
Deno.test("space policy absence or a foreign occurrence grants no current-source authority", () => {
  const unused = fixture();
  unused.snapshot.elements = unused.snapshot.elements.filter((element) =>
    element.id !== "control" && element.ownerId !== "control"
  );
  equal(
    compileSpaceControlPolicy(
      unused.snapshot,
      unused.literals,
      unused.identity,
    ),
    undefined,
  );
  const absent = fixture();
  absent.snapshot.elements = absent.snapshot.elements.filter((element) =>
    element.id !== "policy-type"
  );
  equal(
    compileSpaceControlPolicy(
      absent.snapshot,
      absent.literals,
      absent.identity,
    ),
    undefined,
  );
  const foreign = fixture();
  foreign.element("control").ownerId = "foreign-system";
  equal(foreign.compile(), undefined);
});
Deno.test("explicit space policy validates modeled owner/mandate/root/operator bindings and product aliases", () => {
  const f = fixture(), policy = f.compile()!;
  equal(policy.holderNativeId, "owner");
  equal(policy.mandateNativeId, "mandate");
  equal(policy.issuerRootNativeId, "root");
  deepStrictEqual(policy.operatorIds, ["builder"]);
  equal(policy.rootAuthority.ownerSource, "modeled");
  for (
    const id of [
      "control",
      "control-holder",
      "control-mandate",
      "control-issuer",
      "control-operator",
      "control-acts-literal",
      "owner-binding",
      "grant-binding",
    ]
  ) {
    equal(
      policy.sourceIds.includes(id),
      true,
      `Missing native source evidence ${id}`,
    );
  }
  // Package-owned PartUsage is referential by SysML default, without being an explicit alias.
  f.element("system").isReference = true;
  f.element("system").declaredReference = false;
  for (const element of f.snapshot.elements) {
    element.qualifiedName = element.qualifiedName.replace(/Assembly/g, "ASE");
  }
  deepStrictEqual(f.compile(), policy);
  f.value("enabled").value = "false";
  equal(f.compile()!.enabled, false);
});
Deno.test("space policy refuses ambiguous, wrongly typed and foreign native evidence", () => {
  for (
    const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.elements.push({
          ...f.element("policy-type"),
          id: "other-policy-type",
        });
      },
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.elements.push({
          ...f.element("control"),
          id: "other-control",
        });
      },
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.elements.push({ ...f.element("control") });
      },
      (f: ReturnType<typeof fixture>) => {
        f.element("policy-holder").typeIds = ["software-type"];
      },
      (f: ReturnType<typeof fixture>) => {
        f.element("policy-revision").typeIds = ["String-type"];
      },
      (f: ReturnType<typeof fixture>) => {
        f.element("control-enabled").redefinedIds = [];
      },
      (f: ReturnType<typeof fixture>) => {
        f.value("revision").kind = "LiteralString";
      },
      (f: ReturnType<typeof fixture>) => {
        f.value("revision").value = "0";
      },
      (f: ReturnType<typeof fixture>) => {
        f.value("enabled").value = "yes";
      },
      (f: ReturnType<typeof fixture>) => {
        f.value("acts").value = '["execute-conversation", "open-request"]';
      },
      (f: ReturnType<typeof fixture>) => {
        f.value("acts").value =
          '["execute-conversation","execute-conversation"]';
      },
      (f: ReturnType<typeof fixture>) => {
        f.value("acts").value = '["publish-model"]';
      },
      (f: ReturnType<typeof fixture>) => {
        f.literals.push({ ...f.value("acts") });
      },
      (f: ReturnType<typeof fixture>) => {
        f.binding("control-holder").ends[1]!.chain[0]!.id = "builder";
      },
      (f: ReturnType<typeof fixture>) => {
        f.binding("control-holder").ownerId = "foreign-system";
      },
      (f: ReturnType<typeof fixture>) => {
        f.binding("control-mandate").ends[1]!.chain = [{
          id: "mandate",
          name: "mandate",
        }];
      },
      (f: ReturnType<typeof fixture>) => {
        f.binding("control-issuer").ends[1]!.chain[2]!.id = "foreign-root";
      },
      (f: ReturnType<typeof fixture>) => {
        f.binding("control-operator").ends[1]!.chain[0]!.id =
          "foreign-operator";
      },
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.connectors.push({
          ...f.binding("control-operator"),
          id: "duplicate-binding",
        });
      },
      (f: ReturnType<typeof fixture>) => {
        f.element("owner").typeIds = ["software-type"];
      },
    ]
  ) {
    const f = fixture();
    mutate(f);
    throws(f.compile, /policy|authority|binding/i);
  }
});
Deno.test("space policy refuses qualified extra or replacement bindings for every control reference", () => {
  for (
    const [field, bindingId] of [
      ["holder", "control-holder"],
      ["mandate", "control-mandate"],
      ["issuer", "control-issuer"],
      ["allowedOperator", "control-operator"],
    ]
  ) {
    for (const variant of ["extra", "replacement", "reversed-extra"]) {
      const f = fixture();
      const qualified = structuredClone(f.binding(bindingId!));
      qualified.id = `qualified-${field}`;
      qualified.ownerId = "package";
      const endpoint = qualified.ends.find((end) =>
        end.chain[0]?.id === "control"
      )!;
      endpoint.chain.unshift({ id: "system", name: "system" });
      if (variant === "replacement") {
        f.snapshot.connectors = f.snapshot.connectors.filter((connector) =>
          connector.id !== bindingId
        );
      }
      if (variant === "reversed-extra") qualified.ends.reverse();
      f.snapshot.connectors.push(qualified);
      throws(f.compile, {
        code: "INVALID_SPACE_CONTROL_POLICY",
        message:
          `Invalid native space-control policy: invalid or foreign ${field} binding`,
      });
    }
  }
});
Deno.test("space control acts use one closed canonical set without manufacturing disabled or missing grants", () => {
  deepStrictEqual(spaceControlActs(["revoke-execution", "open-request"]), [
    "open-request",
    "revoke-execution",
  ]);
  for (
    const acts of [[], ["*"], ["open-request", "open-request"], [
      "publish-model",
    ], "open-request"]
  ) equal(spaceControlActs(acts), null);
  const changed = spaceControlPolicyFields({
    id: "policy",
    revision: 2,
    enabled: false,
    acts: ["revoke-execution"],
  });
  equal(changed.enabled, false);
  deepStrictEqual(changed.acts, ["revoke-execution"]);
});
