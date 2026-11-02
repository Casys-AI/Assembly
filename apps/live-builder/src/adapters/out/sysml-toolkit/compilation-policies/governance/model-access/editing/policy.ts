import {
  bindPolicyReferences,
  typedPolicyLiterals,
} from "../../typed-policy-facts.ts";
import {
  canonicalProductName,
  sameProductName,
} from "../../../../../../../domain/model/sysml-product-names.ts";
/** Compile opt-in editing authority from typed native facts and exact bindings. */
import type { NativeModelEditPolicy } from "../../../../../../../domain/model/execution/native-contracts.ts";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../../../domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../../../../../../domain/work/dialogue.ts";
import type { NativeLiteral } from "../../../work/execution-model.ts";
import { compileNativeAuthority } from "../../../work/execution-model.ts";
import {
  parseModelEditGrants,
  parseModelEditOperations,
  validateModelEditPolicyIdentity,
} from "../../../../../../../domain/governance/policies/model-edit-policy.ts";
import { isNamespacePartOccurrence } from "../../../../../../../domain/model/policies/model-occurrence.ts";
import { compileModelPolicyRoot } from "../../authority/model-policy-root.ts";

export function compileModelEditPolicy(
  snapshot: ModelSnapshot,
  literals: NativeLiteral[],
  identity: ModelIdentity,
): NativeModelEditPolicy | undefined {
  const byId = new Map(
    snapshot.elements.map((element) => [element.id, element]),
  );
  const fail = (condition: unknown, message: string): void => {
    if (!condition) {
      throw new Error(`Invalid native model edit policy: ${message}`);
    }
  };
  fail(byId.size === snapshot.elements.length, "duplicate element identity");
  const exact = (qualifiedName: string, metaclass: string): ElementRecord => {
    const found = snapshot.elements.filter((element) =>
      sameProductName(element.qualifiedName, qualifiedName) &&
      element.metaclass === metaclass
    );
    fail(found.length === 1, qualifiedName);
    return found[0]!;
  };
  const packages = snapshot.elements.filter((element) =>
    sameProductName(element.qualifiedName, "AssemblyModelEditing")
  );
  if (!packages.length) {
    fail(
      !snapshot.elements.some((element) =>
        canonicalProductName(element.qualifiedName).startsWith(
          "AssemblyModelEditing::",
        )
      ),
      "orphan declaration",
    );
    return undefined;
  }
  fail(
    packages.length === 1 && packages[0]!.metaclass === "Package",
    "package",
  );
  const definition = exact(
    "AssemblyModelEditing::ModelEditPolicy",
    "PartDefinition",
  );
  fail(definition.ownerId === packages[0]!.id, "definition owner");
  const fields = {
    id: "String",
    revision: "Integer",
    operations: "String",
    grants: "String",
  } as const;
  const members = snapshot.elements.filter((element) =>
    element.ownerId === definition.id
  );
  fail(
    members.length === 6 ||
      (members.length === 7 &&
        members.some((member) => member.name === "issuer")),
    "unsupported declaration fields",
  );
  const holder = exact(
    "AssemblyModelEditing::ModelEditPolicy::holder",
    "ReferenceUsage",
  );
  const mandate = exact(
    "AssemblyModelEditing::ModelEditPolicy::mandate",
    "ItemUsage",
  );
  for (
    const [member, type, metaclass] of [[
      holder,
      "AssemblyCore::SoftwareOperator",
      "PartDefinition",
    ], [mandate, "AssemblyCore::ConfiguredMandate", "ItemDefinition"]] as const
  ) {
    const target = exact(type, metaclass);
    fail(
      member.ownerId === definition.id && member.isReference &&
        member.typeIds.length === 1 && member.typeIds[0] === target.id,
      "reference typing",
    );
  }
  const sources = new Set([
    packages[0]!.id,
    definition.id,
    holder.id,
    mandate.id,
    identity.systemId,
  ]);
  const bases = new Map<string, ElementRecord>();
  for (const name of Object.keys(fields)) {
    const base = exact(
      `AssemblyModelEditing::ModelEditPolicy::${name}`,
      "AttributeUsage",
    );
    fail(
      base.ownerId === definition.id && base.typeIds.length === 1,
      "scalar declaration",
    );
    bases.set(name, base);
    sources.add(base.id);
    sources.add(base.typeIds[0]!);
  }
  const system = byId.get(identity.systemId);
  fail(system?.typeIds.length === 1, "system");
  const singleton = (element: ElementRecord) =>
    ["", "1", "1..1"].includes(element.multiplicity);
  const local: ElementRecord[] = [];
  for (
    const occurrence of snapshot.elements.filter((element) =>
      element.typeIds.includes(definition.id)
    )
  ) {
    fail(
      occurrence.metaclass === "PartUsage" && !occurrence.isReference &&
        occurrence.typeIds.length === 1 && singleton(occurrence),
      "singleton concrete occurrence",
    );
    let owner = byId.get(occurrence.ownerId);
    const seen = new Set<string>();
    while (owner && owner.typeIds[0] !== system!.typeIds[0]) {
      fail(
        !seen.has(owner.id) && owner.metaclass === "PartUsage" &&
          !owner.isReference && owner.typeIds.length <= 1 && singleton(owner),
        "misplaced occurrence",
      );
      seen.add(owner.id);
      owner = byId.get(owner.ownerId);
    }
    fail(
      owner && owner.metaclass === "PartUsage" &&
        (!owner.isReference ||
          isNamespacePartOccurrence(owner, byId.get(owner.ownerId))) &&
        owner.typeIds.length === 1 && singleton(owner),
      "misplaced or non-singleton system occurrence",
    );
    if (owner!.id === identity.systemId) local.push(occurrence);
  }
  fail(local.length <= 1, "duplicate occurrence");
  if (!local.length) return undefined;
  const occurrence = local[0]!;
  // The selected system can itself be nested under a zero/optional/multiple
  // part. Every containing part must denote one concrete occurrence as well.
  let ancestor = byId.get(system!.ownerId);
  const ancestry = new Set<string>();
  while (ancestor && !/^(Library)?Package$/.test(ancestor.metaclass)) {
    fail(
      !ancestry.has(ancestor.id) && ancestor.metaclass === "PartUsage" &&
        singleton(ancestor) && ancestor.typeIds.length <= 1 &&
        (!ancestor.isReference ||
          isNamespacePartOccurrence(ancestor, byId.get(ancestor.ownerId))),
      "non-singleton or non-concrete system ancestry",
    );
    ancestry.add(ancestor.id);
    sources.add(ancestor.id);
    ancestor = byId.get(ancestor.ownerId);
  }
  fail(ancestor, "missing system namespace");
  sources.add(occurrence.id);
  const owned = snapshot.elements.filter((element) =>
    element.ownerId === occurrence.id
  );
  fail(owned.length === 4, "unsupported occurrence fields");
  const values: Record<string, string> = {};
  for (const [name, scalar] of Object.entries(fields)) {
    const attributes = owned.filter((element) => element.name === name);
    const matches = literals.filter((literal) =>
      literal.owner === occurrence.id && literal.name === name
    );
    fail(attributes.length === 1 && matches.length === 1, `literal ${name}`);
    const attribute = attributes[0]!,
      literal = matches[0]!,
      base = bases.get(name)!;
    fail(
      typedPolicyLiterals(attribute, base, literal, scalar, true, literals),
      `typed literal ${name}`,
    );
    sources.add(attribute.id);
    sources.add(literal.literalId);
    values[name] = literal.value;
  }
  const authority = compileNativeAuthority(snapshot, literals, identity);
  const rootAuthority = compileModelPolicyRoot(
    snapshot,
    definition,
    occurrence,
    authority.ownerAuthority,
  );
  for (
    const [feature, target] of [[holder, identity.builderId], [
      mandate,
      authority.builderMandate.nativeId,
    ]] as const
  ) {
    const connector = bindPolicyReferences(
      snapshot,
      occurrence.id,
      feature.id,
      identity.systemId,
      target,
      fail,
      {
        ambiguous: "ambiguous reference binding",
        invalid: "wrong holder or mandate binding",
      },
    );
    sources.add(connector.id);
    sources.add(target);
  }
  fail(/^[1-9][0-9]*$/.test(values.revision!), "revision");
  const revision = Number(values.revision);
  validateModelEditPolicyIdentity(values.id!, revision);
  return {
    id: values.id!,
    revision,
    elementId: occurrence.id,
    ...(rootAuthority ? { rootAuthority } : {}),
    sourceIds: [
      ...new Set([
        ...sources,
        ...authority.builderMandate.sourceIds,
        ...(rootAuthority?.sourceIds ?? []),
      ]),
    ]
      .sort(),
    holderNativeId: identity.builderId,
    mandateNativeId: authority.builderMandate.nativeId,
    mandateId: authority.builderMandate.id,
    mandateRevision: authority.builderMandate.version,
    operations: parseModelEditOperations(values.operations!),
    grants: parseModelEditGrants(values.grants!),
  };
}
