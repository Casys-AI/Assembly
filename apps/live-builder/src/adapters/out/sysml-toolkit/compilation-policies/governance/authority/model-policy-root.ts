import { sameProductName } from "../../../../../../domain/model/sysml-product-names.ts";
import {
  AuthorityInvariantError,
  type OwnerAuthority,
} from "../../../../../../domain/governance/authority.ts";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../../domain/model/records/snapshot.ts";

/** Existing JSON envelopes remain unchanged; their issuer is a native binding. */
export function compileModelPolicyRoot(
  snapshot: ModelSnapshot,
  definition: ElementRecord,
  occurrence: ElementRecord,
  owner: OwnerAuthority,
): OwnerAuthority | undefined {
  if (owner.ownerSource === "implicit-legacy") return undefined;
  const fail = (condition: unknown, reason: string): void => {
    if (!condition) throw new AuthorityInvariantError(1, reason);
  };
  const issuer = snapshot.elements.filter((element) =>
    element.ownerId === definition.id && element.name === "issuer"
  );
  const rootType = snapshot.elements.filter((element) =>
    sameProductName(
      element.qualifiedName,
      "AssemblyAuthority::RootAuthority",
    ) &&
    element.metaclass === "PartDefinition"
  );
  fail(
    issuer.length === 1 && rootType.length === 1 &&
      issuer[0]!.metaclass === "PartUsage" && issuer[0]!.isReference &&
      issuer[0]!.typeIds.length === 1 &&
      issuer[0]!.typeIds[0] === rootType[0]!.id &&
      ["", "1", "1..1", "0..1", "?"].includes(issuer[0]!.multiplicity),
    "policy-root-issuer-missing-or-invalid",
  );
  const same = (actual: readonly string[], expected: readonly string[]) =>
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
  const feature = [occurrence.id, issuer[0]!.id];
  const bindings = snapshot.connectors.filter((connector) =>
    connector.metaclass === "BindingConnectorAsUsage" &&
    connector.ends.some((end) =>
      same(end.chain.map((part) => part.id), feature)
    )
  );
  fail(bindings.length === 1, "policy-root-binding-missing-or-ambiguous");
  const binding = bindings[0]!;
  fail(
    binding.ownerId === owner.systemId && binding.ends.length === 2 &&
      binding.ends.some((end) =>
        same(end.chain.map((part) => part.id), [
          owner.operatorNativeId,
          owner.mandateNativeId,
          owner.rootAuthorityNativeId,
        ])
      ),
    "policy-root-issuer-mismatch",
  );
  return {
    ...owner,
    sourceIds: [...new Set([...owner.sourceIds, issuer[0]!.id, binding.id])]
      .sort(),
  };
}
