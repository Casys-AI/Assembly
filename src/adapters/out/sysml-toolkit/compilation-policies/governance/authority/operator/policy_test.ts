import { deepStrictEqual, throws } from "node:assert/strict";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../../../domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../../../../../../domain/shared-kernel/model-identity.ts";
import {
  assertOperatorAuthorityRecipients,
  compileOperatorAuthorityPolicies,
} from "./policy.ts";

const fields = [
  "id",
  "revision",
  "enabled",
  "recipients",
  "acts",
  "networkHosts",
  "toolIds",
  "maxDelegationDepth",
];
/** An unused definition: occurrences are compiled with the real Toolkit. */
function fixture(extra: string[] = []) {
  const elements: ElementRecord[] = [];
  const add = (
    id: string,
    qualifiedName: string,
    metaclass: string,
    ownerId = "root",
    typeIds: string[] = [],
    isReference = false,
  ) =>
    elements.push({
      id,
      qualifiedName,
      name: qualifiedName.split("::").at(-1)!,
      metaclass,
      ownerId,
      typeIds,
      direction: "",
      generalIds: [],
      redefinedIds: [],
      isReference,
      multiplicity: "",
      doc: "",
    });
  const definition = "ASEAuthority::OperatorAuthorityPolicy";
  add("policy", definition, "PartDefinition");
  add("scalar", "ScalarValues::String", "DataType");
  add("software", "ASECore::SoftwareOperator", "PartDefinition");
  add("mandate", "ASECore::ConfiguredMandate", "ItemDefinition");
  add("root-authority", "ASEAuthority::RootAuthority", "PartDefinition");
  for (const name of [...fields, ...extra]) {
    add(name, `${definition}::${name}`, "AttributeUsage", "policy", ["scalar"]);
  }
  add("holder", `${definition}::holder`, "ReferenceUsage", "policy", [
    "software",
  ], true);
  add("policy-mandate", `${definition}::mandate`, "ItemUsage", "policy", [
    "mandate",
  ], true);
  add("issuer", `${definition}::issuer`, "PartUsage", "policy", [
    "root-authority",
  ], true);
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
  return {
    snapshot,
    add,
    compile: () => compileOperatorAuthorityPolicies(snapshot, [], identity),
  };
}

Deno.test("4.8c C2: an operator authority definition may declare recipientSpace; legacy definitions compile without it", () => {
  deepStrictEqual(fixture().compile(), []);
  deepStrictEqual(fixture(["recipientSpace"]).compile(), []);
  throws(fixture(["recipientScope"]).compile, {
    code: "INVALID_AUTHORITY_POLICY",
    message: "Unsupported policy definition members",
  });
});

Deno.test("4.8e: a branch-scoped recipient need not exist in Main's source snapshot", () => {
  assertOperatorAuthorityRecipients(new Map(), "main-builder", {
    recipients: ["branch-member"],
    recipientExecutionSpaceId: "request-space",
  });
});

Deno.test("4.8e: relative and explicit-main recipients still require exact other local operators", () => {
  const f = fixture();
  f.add(
    "builder-type",
    "AssemblyLiveBuilder::ConversationBuilder",
    "PartDefinition",
  );
  for (const id of ["main-builder", "other-builder"]) {
    f.add(id, "System::builder", "PartUsage", "system", ["builder-type"]);
  }
  const elements = new Map(
    f.snapshot.elements.map((element) => [element.id, element]),
  );
  for (const scope of [{}, { recipientExecutionSpaceId: "main" }]) {
    assertOperatorAuthorityRecipients(elements, "main-builder", {
      recipients: ["other-builder"],
      ...scope,
    });
    for (const recipient of ["missing-member", "main-builder"]) {
      throws(
        () =>
          assertOperatorAuthorityRecipients(elements, "main-builder", {
            recipients: [recipient],
            ...scope,
          }),
        { code: "INVALID_AUTHORITY_POLICY" },
      );
    }
  }
});
