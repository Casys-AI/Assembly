import {
  bindPolicyReferences,
  typedPolicyLiterals,
} from "../../../../../../../domain/model/policies/typed-policy-facts.ts";
import {
  canonicalProductName,
  sameProductName,
} from "../../../../../../../domain/model/sysml-product-names.ts";
/** Compile opt-in administration authority from typed native facts and exact bindings. */
import type { NativeModelAdministrationPolicy } from "../../../../../../../domain/model/execution/native-contracts.ts";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../../../domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../../../../../../domain/shared-kernel/model-identity.ts";
import type { NativeLiteral } from "../../../../../../../domain/model/records/native-literal.ts";
import { compileNativeAuthority } from "../../../work/execution-model.ts";
import {
  parseModelEditGrants,
  parseModelEditOperations,
  validateModelEditPolicyIdentity,
} from "../../../../../../../domain/governance/model-access/model-edit-policy.ts";
import { parseSysmlQualifiedName } from "../../../../../../../domain/model/value-objects/sysml-qualified-name.ts";
import { isNamespacePartOccurrence } from "../../../../../../../domain/model/policies/model-occurrence.ts";
import { compileModelPolicyRoot } from "../../authority/model-policy-root.ts";

export function compileModelAdministrationPolicy(
  snapshot: ModelSnapshot,
  literals: NativeLiteral[],
  identity: ModelIdentity,
): NativeModelAdministrationPolicy | undefined {
  const byId = new Map(
    snapshot.elements.map((element) => [element.id, element]),
  );
  const fail = (condition: unknown, message: string): void => {
    if (!condition) {
      throw new Error(`Invalid native model administration policy: ${message}`);
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
    sameProductName(element.qualifiedName, "AssemblyModelAdministration")
  );
  if (!packages.length) {
    fail(
      !snapshot.elements.some((element) =>
        canonicalProductName(element.qualifiedName).startsWith(
          "AssemblyModelAdministration::",
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
    "AssemblyModelAdministration::ModelAdministrationPolicy",
    "PartDefinition",
  );
  fail(definition.ownerId === packages[0]!.id, "definition owner");
  const fields = {
    id: "String",
    revision: "Integer",
    operations: "String",
    grants: "String",
    recipients: "String",
    maxRedelegationDepth: "Integer",
  } as const;
  const members = snapshot.elements.filter((element) =>
    element.ownerId === definition.id
  );
  fail(
    members.length === 8 ||
      (members.length === 9 &&
        members.some((member) => member.name === "issuer")),
    "unsupported declaration fields",
  );
  const holder = exact(
    "AssemblyModelAdministration::ModelAdministrationPolicy::holder",
    "ReferenceUsage",
  );
  const mandate = exact(
    "AssemblyModelAdministration::ModelAdministrationPolicy::mandate",
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
      `AssemblyModelAdministration::ModelAdministrationPolicy::${name}`,
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
  fail(owned.length === 6, "unsupported occurrence fields");
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
  fail(/^[0-8]$/.test(values.maxRedelegationDepth!), "maxRedelegationDepth");
  const recipients: unknown = JSON.parse(values.recipients!);
  fail(
    Array.isArray(recipients) && recipients.length > 0 &&
      recipients.length <= 128 &&
      JSON.stringify(recipients) === values.recipients,
    "canonical recipients",
  );
  const recipientNames = new Set<string>();
  for (const recipient of recipients as unknown[]) {
    const segments = typeof recipient === "string" && recipient.length <= 1024
      ? parseSysmlQualifiedName(recipient)
      : undefined;
    fail(
      segments && !segments.some((segment) => segment.includes("*")),
      "exact recipient qualified name",
    );
    const key = JSON.stringify(segments);
    fail(!recipientNames.has(key), "duplicate recipient");
    recipientNames.add(key);
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
    operations: parseModelEditOperations(values.operations!),
    grants: parseModelEditGrants(values.grants!),
    recipients: recipients as string[],
    maxRedelegationDepth: Number(values.maxRedelegationDepth),
  };
}
