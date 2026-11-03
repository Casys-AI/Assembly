import assert from "node:assert/strict";
import {
  AuthorityInvariantError,
  legacyOwnerAuthority,
} from "../../../../../../domain/governance/authority.ts";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../../domain/model/records/snapshot.ts";
import { compileModelPolicyRoot } from "./model-policy-root.ts";

function fixture() {
  const owner = {
    ...legacyOwnerAuthority("system"),
    ownerSource: "modeled" as const,
  };
  const element = (
    id: string,
    overrides: Partial<ElementRecord> = {},
  ): ElementRecord => ({
    id,
    name: id,
    qualifiedName: id,
    metaclass: "PartUsage",
    ownerId: "system",
    typeIds: [],
    generalIds: [],
    redefinedIds: [],
    direction: "",
    multiplicity: "",
    isReference: false,
    doc: "",
    ...overrides,
  });
  const definition = element("policy-definition", {
    metaclass: "PartDefinition",
  });
  const occurrence = element("policy");
  const rootType = element("root-type", {
    qualifiedName: "ASEAuthority::RootAuthority",
    metaclass: "PartDefinition",
  });
  const issuer = element("issuer", {
    ownerId: definition.id,
    isReference: true,
    typeIds: [rootType.id],
    multiplicity: "0..1",
  });
  const snapshot: ModelSnapshot = {
    rootId: "root",
    invocations: [],
    patternIds: [],
    elements: [definition, occurrence, rootType, issuer],
    connectors: [
      {
        id: "binding",
        name: "",
        ownerId: "system",
        metaclass: "BindingConnectorAsUsage",
        ends: [
          {
            chain: [{ id: occurrence.id, name: "policy" }, {
              id: issuer.id,
              name: "issuer",
            }],
          },
          {
            chain: [{ id: owner.operatorNativeId, name: "owner" }, {
              id: owner.mandateNativeId,
              name: "ownerMandate",
            }, { id: owner.rootAuthorityNativeId, name: "rootAuthority" }],
          },
        ],
      },
    ],
  };
  return { owner, definition, occurrence, snapshot };
}

Deno.test("model policy root requires the modeled owner's exact issuer binding", () => {
  const { snapshot, definition, occurrence, owner } = fixture();
  const result = compileModelPolicyRoot(
    snapshot,
    definition,
    occurrence,
    owner,
  )!;
  assert.equal(result.rootAuthorityNativeId, owner.rootAuthorityNativeId);
  assert(result.sourceIds.includes("binding"));
  for (
    const mode of ["missing", "duplicate", "wrong-root", "wrong-owner"] as const
  ) {
    const bad = structuredClone(snapshot);
    if (mode === "missing") bad.connectors = [];
    if (mode === "duplicate") {
      bad.connectors.push({ ...bad.connectors[0]!, id: "other" });
    }
    if (mode === "wrong-root") {
      bad.connectors[0]!.ends[1]!.chain[2]!.id = "other-root";
    }
    if (mode === "wrong-owner") {
      bad.connectors[0]!.ends[1]!.chain[0]!.id = "other-owner";
    }
    assert.throws(
      () => compileModelPolicyRoot(bad, definition, occurrence, owner),
      (error) =>
        error instanceof AuthorityInvariantError &&
        error.code === "AUTHORITY_INVARIANT" && error.invariant === 1,
    );
  }
});

Deno.test("legacy model policies preserve their unextended authority encoding", () => {
  const { snapshot, definition, occurrence } = fixture();
  snapshot.connectors = [];
  assert.equal(
    compileModelPolicyRoot(
      snapshot,
      definition,
      occurrence,
      legacyOwnerAuthority("system"),
    ),
    undefined,
  );
});

Deno.test("Assembly policy roots preserve the owner's exact native binding", () => {
  const f = fixture();
  const legacy = compileModelPolicyRoot(
    f.snapshot,
    f.definition,
    f.occurrence,
    f.owner,
  );
  f.snapshot.elements.find((element) => element.id === "root-type")!
    .qualifiedName = "AssemblyAuthority::RootAuthority";
  assert.deepEqual(
    compileModelPolicyRoot(f.snapshot, f.definition, f.occurrence, f.owner),
    legacy,
  );
  f.snapshot.elements.push({
    ...f.snapshot.elements.find((element) => element.id === "root-type")!,
    id: "competing-legacy-root",
    qualifiedName: "ASEAuthority::RootAuthority",
  });
  assert.throws(
    () =>
      compileModelPolicyRoot(f.snapshot, f.definition, f.occurrence, f.owner),
    AuthorityInvariantError,
  );
});
