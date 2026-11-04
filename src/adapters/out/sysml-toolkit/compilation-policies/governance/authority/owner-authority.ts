import { productNameVariants } from "../../../../../../domain/model/sysml-product-names.ts";
import {
  AuthorityInvariantError,
  legacyOwnerAuthority,
  type OwnerAuthority,
} from "../../../../../../domain/governance/authority.ts";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../../domain/model/records/snapshot.ts";
import type { NativeLiteral } from "../../../../../../domain/model/records/native-literal.ts";

/** Lot 1 recognizes only the owner's root, leaving software grants unchanged. */
export function compileOwnerAuthority(
  snapshot: ModelSnapshot,
  literals: NativeLiteral[],
  systemId: string,
): OwnerAuthority {
  const byId = new Map(snapshot.elements.map((e) => [e.id, e]));
  const fail = (reason: string): never => {
    throw new AuthorityInvariantError(1, reason);
  };
  const hasType = (element: ElementRecord, qualifiedName: string) =>
    element.typeIds.some((id) => {
      const name = byId.get(id)?.qualifiedName ?? "";
      return productNameVariants(qualifiedName).some((alias) =>
        name === alias || name.endsWith(`::${alias}`)
      );
    });
  const members = (ownerId: string, metaclass: string, type: string) =>
    snapshot.elements.filter((element) =>
      element.ownerId === ownerId && element.metaclass === metaclass &&
      hasType(element, type)
    );
  const typedLiteral = (attribute: ElementRecord, scalar: string) => {
    const values = literals.filter((v) =>
      v.owner === attribute.ownerId && v.name === attribute.name
    );
    const value = values[0];
    if (
      values.length !== 1 || !value || !value.literalId ||
      value.attributeId !== attribute.id ||
      attribute.metaclass !== "AttributeUsage" ||
      attribute.typeIds.length !== 1 || value.typeIds.length !== 1 ||
      attribute.typeIds[0] !== value.typeIds[0] ||
      value.kind !== `Literal${scalar}` || value.typeNames.length !== 1 ||
      !(value.typeNames[0] === `ScalarValues::${scalar}` ||
        value.typeNames[0]!.endsWith(`::ScalarValues::${scalar}`))
    ) return undefined;
    return value;
  };
  // Only this typed direct integer literal reserves the name as a schema marker.
  // Historical business members with the same name retain their own meaning.
  const schema = snapshot.elements.filter((e) =>
    e.ownerId === systemId && e.name === "authoritySchema" &&
    typedLiteral(e, "Integer")
  );
  // The owner is a direct human operator holding a root-bearing mandate.
  // Business members (including homonyms) and nested systems cannot declare it.
  const owners = members(systemId, "PartUsage", "AssemblyCore::HumanOperator")
    .filter((operator) =>
      members(operator.id, "ItemUsage", "AssemblyAuthority::Mandate").some((
        mandate,
      ) =>
        members(mandate.id, "PartUsage", "AssemblyAuthority::RootAuthority")
          .length >
          0
      )
    );
  if (!owners.length) {
    if (schema.length) fail("EXPLICIT_AUTHORITY_ROOT_REQUIRED");
    return legacyOwnerAuthority(systemId);
  }
  const sourceIds = new Set<string>();
  const singleton = (element: ElementRecord) =>
    ["", "1", "1..1"].includes(element.multiplicity);
  const one = (elements: ElementRecord[], reason: string): ElementRecord => {
    if (elements.length !== 1) fail(reason);
    sourceIds.add(elements[0]!.id);
    return elements[0]!;
  };
  const definition = (qualifiedName: string, metaclass: string) =>
    one(
      snapshot.elements.filter((e) =>
        e.metaclass === metaclass &&
        productNameVariants(qualifiedName).some((alias) =>
          e.qualifiedName === alias || e.qualifiedName.endsWith(`::${alias}`)
        )
      ),
      `INVALID_AUTHORITY_TYPE:${qualifiedName}`,
    );
  const occurrence = (
    candidates: ElementRecord[],
    type: ElementRecord,
  ) => {
    const element = one(
      candidates,
      `MISSING_OR_AMBIGUOUS_OWNER_MEMBER:${type.qualifiedName}`,
    );
    if (
      element.isReference || !singleton(element) ||
      element.typeIds.length !== 1 || element.typeIds[0] !== type.id
    ) fail(`INVALID_OWNER_MEMBER:${type.qualifiedName}`);
    return element;
  };
  const humanType = definition("AssemblyCore::HumanOperator", "PartDefinition");
  const operatorType = definition("AssemblyCore::Operator", "PartDefinition");
  if (!humanType.generalIds.includes(operatorType.id)) {
    fail("INVALID_HUMAN_OPERATOR_SPECIALIZATION");
  }
  const mandateType = definition(
    "AssemblyAuthority::Mandate",
    "ItemDefinition",
  );
  const rootType = definition(
    "AssemblyAuthority::RootAuthority",
    "PartDefinition",
  );
  const grantType = definition(
    "AssemblyAuthority::RootGrant",
    "PartDefinition",
  );
  const owner = occurrence(owners, humanType);
  const mandate = occurrence(
    members(owner.id, "ItemUsage", "AssemblyAuthority::Mandate"),
    mandateType,
  );
  const root = occurrence(
    members(mandate.id, "PartUsage", "AssemblyAuthority::RootAuthority"),
    rootType,
  );
  const grant = occurrence(
    members(mandate.id, "PartUsage", "AssemblyAuthority::RootGrant"),
    grantType,
  );
  const field = (
    element: ElementRecord,
    name: string,
    scalar: string,
  ): string => {
    const attribute = one(
      snapshot.elements.filter((e) =>
        e.ownerId === element.id && e.name === name
      ),
      `MISSING_OR_AMBIGUOUS_OWNER_FIELD:${name}`,
    );
    const value = typedLiteral(attribute, scalar);
    if (!value) return fail(`INVALID_OWNER_FIELD:${name}`);
    sourceIds.add(value.literalId);
    sourceIds.add(value.typeIds[0]!);
    return value.value;
  };
  if (schema.length) {
    const system = byId.get(systemId);
    if (!system || field(system, "authoritySchema", "Integer") !== "2") {
      fail("UNSUPPORTED_AUTHORITY_SCHEMA");
    }
  }
  const holder = one(
    snapshot.elements.filter((e) =>
      e.ownerId === mandateType.id && e.name === "holder" &&
      e.metaclass === "PartUsage" && e.isReference &&
      singleton(e) &&
      e.typeIds.length === 1 && e.typeIds[0] === operatorType.id
    ),
    "INVALID_OWNER_HOLDER_FEATURE",
  );
  const issuer = one(
    snapshot.elements.filter((e) =>
      e.ownerId === grantType.id && e.name === "issuer" &&
      e.metaclass === "PartUsage" && e.isReference &&
      singleton(e) &&
      e.typeIds.length === 1 && e.typeIds[0] === rootType.id
    ),
    "INVALID_ROOT_ISSUER_FEATURE",
  );
  const equal = (a: string[], b: string[]) =>
    a.length === b.length && a.every((value, i) => value === b[i]);
  for (
    const binding of [
      {
        scope: systemId,
        left: [owner.id, mandate.id, holder.id],
        right: [owner.id],
      },
      { scope: mandate.id, left: [grant.id, issuer.id], right: [root.id] },
    ]
  ) {
    const candidates = snapshot.connectors.filter((c) =>
      c.metaclass === "BindingConnectorAsUsage" &&
      c.ends.some((end) =>
        end.chain.some((part) => part.id === binding.left.at(-1))
      ) && c.ends.some((end) =>
        end.chain.some((part) =>
          part.id === binding.left[0]
        )
      )
    );
    if (candidates.length !== 1) fail("MISSING_OR_AMBIGUOUS_ROOT_BINDING");
    const connector = candidates[0]!;
    const chains = connector.ends.map((end) =>
      end.chain.map((part) => part.id)
    );
    if (
      connector.ownerId !== binding.scope || chains.length !== 2 ||
      !(equal(chains[0]!, binding.left) && equal(chains[1]!, binding.right) ||
        equal(chains[1]!, binding.left) && equal(chains[0]!, binding.right))
    ) fail("INVALID_ROOT_BINDING");
    sourceIds.add(connector.id);
  }
  const mandateId = field(mandate, "id", "String");
  const rootAuthorityId = field(root, "id", "String");
  const rootGrantId = field(grant, "id", "String");
  const revision = field(mandate, "revision", "Integer");
  if (![mandateId, rootAuthorityId, rootGrantId].every((id) => id.trim())) {
    fail("EMPTY_OWNER_AUTHORITY_ID");
  }
  if (
    !/^[1-9][0-9]*$/.test(revision) || !Number.isSafeInteger(Number(revision))
  ) {
    fail("INVALID_OWNER_MANDATE_REVISION");
  }
  return {
    ownerSource: "modeled",
    systemId,
    operatorId: owner.name,
    operatorNativeId: owner.id,
    mandateId,
    mandateNativeId: mandate.id,
    mandateRevision: Number(revision),
    rootAuthorityId,
    rootAuthorityNativeId: root.id,
    rootGrantId,
    rootGrantNativeId: grant.id,
    sourceIds: [...sourceIds].sort(),
  };
}
