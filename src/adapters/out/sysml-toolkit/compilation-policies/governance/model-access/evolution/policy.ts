import {
  canonicalProductName,
  sameProductName,
} from "../../../../../../../domain/model/sysml-product-names.ts";
/** Compile opt-in editing authority from typed native facts and exact bindings. */
import type { NativeEvolutionPolicy } from "../../../../../../../domain/model/evolution/policy.ts";
import { parseEvolutionGrants } from "../../../../../../../domain/model/evolution/policy.ts";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../../../domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../../../../../../domain/shared-kernel/model-identity.ts";
import type { NativeLiteral } from "../../../../../../../domain/model/records/native-literal.ts";
import { compileNativeAuthority } from "../../../work/execution-model.ts";
import {
  validateModelEditPolicyIdentity,
} from "../../../../../../../domain/governance/policies/model-edit-policy.ts";
import { isNamespacePartOccurrence } from "../../../../../../../domain/model/policies/model-occurrence.ts";
import { compileModelPolicyRoot } from "../../authority/model-policy-root.ts";

export function compileEvolutionPolicy(
  snapshot: ModelSnapshot,
  literals: NativeLiteral[],
  identity: ModelIdentity,
): NativeEvolutionPolicy | undefined {
  const byId = new Map(
    snapshot.elements.map((element) => [element.id, element]),
  );
  const fail = (condition: unknown, message: string): void => {
    if (!condition) {
      throw new Error(`Invalid native evolution policy: ${message}`);
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
    sameProductName(element.qualifiedName, "AssemblyEvolution")
  );
  if (!packages.length) {
    fail(
      !snapshot.elements.some((element) =>
        canonicalProductName(element.qualifiedName).startsWith(
          "AssemblyEvolution::",
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
    "AssemblyEvolution::EvolutionPolicy",
    "PartDefinition",
  );
  fail(definition.ownerId === packages[0]!.id, "definition owner");
  const fields = {
    id: "String",
    revision: "Integer",
    grants: "String",
  } as const;
  const members = snapshot.elements.filter((element) =>
    element.ownerId === definition.id
  );
  fail(
    members.length === 6 && members.some((member) => member.name === "issuer"),
    "unsupported declaration fields",
  );
  const holder = exact(
    "AssemblyEvolution::EvolutionPolicy::holder",
    "ReferenceUsage",
  );
  const mandate = exact(
    "AssemblyEvolution::EvolutionPolicy::mandate",
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
      `AssemblyEvolution::EvolutionPolicy::${name}`,
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
  fail(owned.length === 3, "unsupported occurrence fields");
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
      attribute.metaclass === "AttributeUsage" &&
        attribute.redefinedIds.length === 1 &&
        attribute.redefinedIds[0] === base.id &&
        attribute.typeIds.length === 1 &&
        attribute.typeIds[0] === base.typeIds[0] &&
        literal.attributeId === attribute.id && literal.literalId &&
        literals.filter((other) => other.literalId === literal.literalId)
            .length === 1 &&
        literal.kind === `Literal${scalar}` && literal.typeIds.length === 1 &&
        literal.typeIds[0] === base.typeIds[0] &&
        literal.typeNames.length === 1 &&
        literal.typeNames[0] === `ScalarValues::${scalar}`,
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
  fail(
    rootAuthority && rootAuthority.ownerSource === "modeled",
    "explicit native issuer required",
  );
  const equal = (a: string[], b: string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  for (
    const [feature, target] of [[holder, identity.builderId], [
      mandate,
      authority.builderMandate.nativeId,
    ]] as const
  ) {
    const chain = [occurrence.id, feature.id];
    const touching = snapshot.connectors.filter((connector) =>
      connector.metaclass === "BindingConnectorAsUsage" &&
      connector.ends.some((end) =>
        equal(end.chain.map((part) => part.id), chain)
      )
    );
    fail(touching.length === 1, "ambiguous reference binding");
    const connector = touching[0]!;
    fail(
      connector.ownerId === identity.systemId && connector.ends.length === 2 &&
        connector.ends.some((end) =>
          equal(end.chain.map((part) => part.id), [target])
        ),
      "wrong holder or mandate binding",
    );
    sources.add(connector.id);
    sources.add(target);
  }
  fail(/^[1-9][0-9]*$/.test(values.revision!), "revision");
  const revision = Number(values.revision);
  validateModelEditPolicyIdentity(values.id!, revision);
  const grants = parseEvolutionGrants(values.grants!);
  for (const grant of grants) {
    const target = byId.get(grant.targetNativeId);
    const owner = target && byId.get(target.ownerId);
    fail(
      target?.metaclass === "PartUsage" && target.name === "builder" &&
        !target.isReference && target.typeIds.length === 1 &&
        singleton(target) && owner?.metaclass === "PartUsage" &&
        singleton(owner) && owner.typeIds.length === 1 &&
        sameProductName(
          byId.get(owner.typeIds[0]!)?.qualifiedName,
          "AssemblyLiveBuilder::ConversationSystem",
        ),
      "grant target must be one concrete native operator",
    );
    sources.add(target!.id);
    sources.add(owner!.id);
    let ancestor = owner;
    const seen = new Set<string>();
    while (ancestor && !/^(Library)?Package$/.test(ancestor.metaclass)) {
      fail(
        !seen.has(ancestor.id) && ancestor.metaclass === "PartUsage" &&
          singleton(ancestor) && ancestor.typeIds.length <= 1 &&
          (!ancestor.isReference ||
            isNamespacePartOccurrence(ancestor, byId.get(ancestor.ownerId))),
        "grant target has non-concrete ancestry",
      );
      seen.add(ancestor.id);
      sources.add(ancestor.id);
      ancestor = byId.get(ancestor.ownerId);
    }
    fail(ancestor, "grant target has no native namespace");
  }
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
    grants,
  };
}
