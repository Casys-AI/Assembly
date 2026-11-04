import { persistedOrder } from "../../../../../../../domain/primitives/persisted-order.ts";
import { isNamespacePartOccurrence } from "../../../../../../../domain/model/policies/model-occurrence.ts";
import { sameProductName } from "../../../../../../../domain/model/sysml-product-names.ts";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../../../domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../../../../../../domain/shared-kernel/model-identity.ts";
import type { NativeLiteral } from "../../../../../../../domain/model/records/native-literal.ts";
import { compileNativeAuthority } from "../../../work/execution-model.ts";
import { compileModelPolicyRoot } from "../model-policy-root.ts";
import { OperatorAuthorityError } from "../../../../../../../domain/governance/operator-authority-error.ts";
import { validateOperatorCreationGrant } from "../../../../../../../domain/governance/operator-authority.ts";
import type { OperatorCreationPolicy } from "../../../../../../../domain/governance/policies/operator-creation-policy.ts";
import { canonical } from "../../../../../../../domain/primitives/canonical-json.ts";

/** Only typed native declarations and bindings supply creation authority. */
export function compileOperatorCreationPolicies(
  snapshot: ModelSnapshot,
  literals: NativeLiteral[],
  identity: ModelIdentity,
): OperatorCreationPolicy[] {
  const fail = (condition: unknown, message: string): void => {
    if (!condition) {
      throw new OperatorAuthorityError("INVALID_AUTHORITY_POLICY", message);
    }
  };
  const byId = new Map(
    snapshot.elements.map((element) => [element.id, element]),
  );
  fail(byId.size === snapshot.elements.length, "Duplicate native identity");
  const definitions = snapshot.elements.filter((element) =>
    sameProductName(
      element.qualifiedName,
      "AssemblyAuthority::OperatorCreationPolicy",
    )
  );
  if (!definitions.length) return [];
  fail(
    definitions.length === 1 && definitions[0]!.metaclass === "PartDefinition",
    "Creation policy definition must be unique",
  );
  const definition = definitions[0]!;
  const member = (ownerId: string, name: string): ElementRecord => {
    const matches = snapshot.elements.filter((element) =>
      element.ownerId === ownerId && element.name === name
    );
    fail(matches.length === 1, `Expected exact creation policy member ${name}`);
    return matches[0]!;
  };
  const fields = {
    id: "String",
    revision: "Integer",
    enabled: "Boolean",
    networkHosts: "String",
    maxChildren: "Integer",
    maxDelegationDepth: "Integer",
  } as const;
  /** Absent: the historical autonomous form. Pre-4.8e libraries declare no mode. */
  const optionalFields = { mode: "String" } as const;
  const declared = {
    ...fields,
    ...(snapshot.elements.some((element) =>
        element.ownerId === definition.id && element.name === "mode"
      )
      ? optionalFields
      : {}),
  };
  const features = ["holder", "mandate", "issuer", "parent"];
  fail(
    snapshot.elements.filter((element) => element.ownerId === definition.id)
      .length === Object.keys(declared).length + features.length,
    "Unsupported creation policy definition members",
  );
  for (const [name, kind] of Object.entries(declared)) {
    const attribute = member(definition.id, name);
    const typeId = attribute.typeIds[0]!;
    const suppliedType = byId.get(typeId);
    // Native snapshots omit standard-library DataTypes; literal tuples retain
    // their exact native IDs and qualified type names, including unused types.
    const names = suppliedType
      ? new Set([suppliedType.qualifiedName])
      : new Set(literals.flatMap((literal) =>
        literal.typeIds.flatMap((id, index) =>
          id === typeId ? [literal.typeNames[index] ?? ""] : []
        )
      ));
    fail(
      attribute.metaclass === "AttributeUsage" &&
        attribute.typeIds.length === 1 && names.size === 1 &&
        names.has(`ScalarValues::${kind}`),
      `Invalid creation scalar declaration ${name}`,
    );
  }
  for (
    const [name, type, metaclass] of [
      ["holder", "AssemblyCore::SoftwareOperator", "ReferenceUsage"],
      ["mandate", "AssemblyCore::ConfiguredMandate", "ItemUsage"],
      ["issuer", "AssemblyAuthority::RootAuthority", "PartUsage"],
      ["parent", "AssemblyAuthority::OperatorCreationPolicy", "PartUsage"],
    ]
  ) {
    const feature = member(definition.id, name!);
    fail(
      feature.isReference && feature.metaclass === metaclass &&
        feature.typeIds.length === 1 &&
        sameProductName(byId.get(feature.typeIds[0]!)?.qualifiedName, type!),
      `Invalid creation policy ${name} declaration`,
    );
  }
  fail(
    ["0..1", "?"].includes(member(definition.id, "parent").multiplicity),
    "Creation parent must be optional singleton",
  );
  const policies: OperatorCreationPolicy[] = [];
  for (
    const occurrence of snapshot.elements.filter((element) =>
      element.metaclass === "PartUsage" &&
      element.typeIds.includes(definition.id) &&
      element.id !== member(definition.id, "parent").id
    )
  ) {
    fail(
      occurrence.metaclass === "PartUsage" && !occurrence.isReference &&
        occurrence.typeIds.length === 1 &&
        ["", "1", "1..1"].includes(occurrence.multiplicity),
      `Creation policy must be concrete singleton: ${occurrence.qualifiedName} ${occurrence.metaclass} ref=${occurrence.isReference} types=${occurrence.typeIds.length} multiplicity=${occurrence.multiplicity}`,
    );
    const system = byId.get(occurrence.ownerId);
    fail(
      system?.metaclass === "PartUsage",
      "Creation policy must belong to a native operator system",
    );
    const selected = {
      ...identity,
      systemId: system!.id,
      systemQualifiedName: system!.qualifiedName,
      builderId: member(system!.id, "builder").id,
      catalogId: member(system!.id, "catalog").id,
      reviewerId: snapshot.elements.find((element) =>
        element.ownerId === system!.id && element.name === "reviewer" &&
        element.metaclass === "PartUsage"
      )?.id,
    };
    const native = compileNativeAuthority(snapshot, literals, selected);
    fail(
      native.ownerAuthority.ownerSource === "modeled",
      "Creation requires modeled root authority",
    );
    const present = {
      ...fields,
      ...(snapshot.elements.some((element) =>
          element.ownerId === occurrence.id && element.name === "mode"
        )
        ? optionalFields
        : {}),
    };
    fail(
      snapshot.elements.filter((element) => element.ownerId === occurrence.id)
        .length === Object.keys(present).length,
      "Unsupported creation policy occurrence members",
    );
    const values: Record<string, string | number | boolean> = {};
    const sourceIds = [
      definition.id,
      occurrence.id,
      ...native.builderMandate.sourceIds,
    ];
    for (const [name, kind] of Object.entries(present)) {
      const base = member(definition.id, name),
        attribute = member(occurrence.id, name);
      const matches = literals.filter((literal) =>
        literal.owner === occurrence.id && literal.name === name
      );
      const literal = matches[0];
      fail(
        base.metaclass === "AttributeUsage" && base.typeIds.length === 1 &&
          matches.length === 1 && literal?.attributeId === attribute.id &&
          !!literal.literalId && literal.kind === `Literal${kind}` &&
          attribute.metaclass === "AttributeUsage" &&
          canonical(attribute.redefinedIds) === canonical([base.id]) &&
          canonical(attribute.typeIds) === canonical(base.typeIds) &&
          canonical(literal.typeIds) === canonical(base.typeIds) &&
          canonical(literal.typeNames) === canonical([`ScalarValues::${kind}`]),
        `Invalid creation literal ${name}`,
      );
      values[name] = kind === "Integer"
        ? Number(literal!.value)
        : kind === "Boolean"
        ? literal!.value === "true"
        : literal!.value;
      sourceIds.push(base.id, attribute.id, literal!.literalId);
    }
    fail(
      typeof values.id === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(values.id) &&
        Number.isSafeInteger(values.revision) && Number(values.revision) >= 1,
      "Invalid creation policy identity",
    );
    let hosts: unknown;
    try {
      hosts = JSON.parse(String(values.networkHosts));
    } catch {
      fail(false, "Invalid creation hosts");
    }
    fail(
      JSON.stringify(hosts) === values.networkHosts,
      "Creation hosts must be canonical JSON",
    );
    const grant = validateOperatorCreationGrant({
      networkHosts: hosts,
      maxChildren: values.maxChildren,
      maxDelegationDepth: values.maxDelegationDepth,
      ...("mode" in values ? { mode: values.mode } : {}),
    });
    const binding = (name: string, optional = false): string | undefined => {
      const feature = member(definition.id, name);
      const matches = snapshot.connectors.filter((connector) =>
        connector.metaclass === "BindingConnectorAsUsage" &&
        connector.ends.some((end) =>
          canonical(end.chain.map((part) => part.id)) ===
            canonical([occurrence.id, feature.id])
        )
      );
      if (optional && !matches.length) return undefined;
      fail(
        matches.length === 1 && matches[0]!.ownerId === system!.id &&
          matches[0]!.ends.length === 2,
        "Missing or ambiguous creation policy binding",
      );
      const target = matches[0]!.ends.find((end) =>
        canonical(end.chain.map((part) => part.id)) !==
          canonical([occurrence.id, feature.id])
      );
      const targetId = target?.chain.at(-1)?.id;
      const actualTarget = targetId ? byId.get(targetId) : undefined;
      fail(
        target?.chain.length === 1 ||
          optional && target?.chain.length === 2 &&
            actualTarget?.ownerId === target.chain[0]!.id,
        "Creation binding must target an exact native identity",
      );
      sourceIds.push(
        feature.id,
        matches[0]!.id,
        ...(target?.chain.map((part) => part.id) ?? []),
      );
      return targetId;
    };
    fail(
      binding("holder") === selected.builderId &&
        binding("mandate") === native.builderMandate.nativeId,
      "Creation holder or mandate binding mismatch",
    );
    const parentPolicyElementId = binding("parent", true);
    const rootAuthority = compileModelPolicyRoot(
      snapshot,
      definition,
      occurrence,
      native.ownerAuthority,
    );
    fail(rootAuthority, "Creation policy requires explicit issuer");
    const children = snapshot.elements.filter((element) =>
      element.metaclass === "PartUsage" &&
      (!element.isReference ||
        isNamespacePartOccurrence(element, byId.get(element.ownerId))) &&
      literals.some((literal) =>
        literal.owner === element.id && literal.name === "creationPolicyId" &&
        literal.kind === "LiteralString" && literal.value === values.id
      ) && literals.some((literal) =>
        literal.owner === element.id &&
        literal.name === "creationParentOperatorId" &&
        literal.kind === "LiteralString" && literal.value === selected.builderId
      )
    ).map((element) => element.id).sort();
    // Capacity is encoded by this policy's children array. Its membership
    // provenance must not become an ancestor-authority dependency of another
    // holder: a sibling consumes only the creator's remaining capacity.
    policies.push({
      ...grant,
      id: String(values.id),
      revision: Number(values.revision),
      enabled: values.enabled === true,
      elementId: occurrence.id,
      holderNativeId: selected.builderId,
      mandateNativeId: native.builderMandate.nativeId,
      systemId: system!.id,
      rootAuthority,
      children,
      ...(parentPolicyElementId ? { parentPolicyElementId } : {}),
      sourceIds: [...new Set([...sourceIds, ...rootAuthority!.sourceIds])]
        .sort(),
    });
  }
  const latest = new Map<string, OperatorCreationPolicy>();
  for (const policy of policies.sort((a, b) => a.revision - b.revision)) {
    const previous = latest.get(policy.id);
    fail(
      policy.revision === (previous?.revision ?? 0) + 1 &&
        (!previous || previous.holderNativeId === policy.holderNativeId),
      "Creation revisions must be contiguous and cannot reassign a holder",
    );
    latest.set(policy.id, policy);
  }
  const resolve = (
    policy: OperatorCreationPolicy,
    visited = new Set<string>(),
  ): void => {
    fail(
      !visited.has(policy.elementId),
      "Creation authority chain contains a cycle",
    );
    visited.add(policy.elementId);
    if (!policy.parentPolicyElementId) return;
    const parent = policies.find((candidate) =>
      candidate.elementId === policy.parentPolicyElementId
    );
    fail(
      parent && parent.holderNativeId !== policy.holderNativeId &&
        parent.maxDelegationDepth > policy.maxDelegationDepth &&
        parent.maxChildren >= policy.maxChildren &&
        policy.networkHosts.every((host) =>
          parent.networkHosts.includes(host)
        ) &&
        ((policy.mode ?? "autonomous") !== "autonomous" ||
          (parent.mode ?? "autonomous") === "autonomous"),
      "Creation grant exceeds its exact parent",
    );
    const parentOperator = literals.filter((literal) =>
      literal.owner === policy.systemId &&
      literal.name === "creationParentOperatorId"
    );
    const parentPolicy = literals.filter((literal) =>
      literal.owner === policy.systemId && literal.name === "creationPolicyId"
    );
    fail(
      parentOperator.length === 1 &&
        parentOperator[0]!.kind === "LiteralString" &&
        parentOperator[0]!.value === parent!.holderNativeId &&
        parentPolicy.length === 1 &&
        parentPolicy[0]!.kind === "LiteralString" &&
        parentPolicy[0]!.value === parent!.id,
      "Creation grant must belong to the admitted child of its exact parent",
    );
    resolve(parent!, visited);
    const currentParent = latest.get(parent!.id)!;
    policy.enabled = policy.enabled && parent!.enabled &&
      currentParent.elementId === parent!.elementId && currentParent.enabled;
    policy.sourceIds = [
      ...new Set([
        ...policy.sourceIds,
        ...parent!.sourceIds,
        ...currentParent.sourceIds,
      ]),
    ].sort();
  };
  for (const policy of latest.values()) resolve(policy);
  // Validate the complete graph above, but project only this holder's rights
  // and capacity into its execution contract. A descendant's creation must not
  // change an ancestor's admitted digest merely by consuming its own capacity.
  return [...latest.values()].filter((policy) =>
    policy.holderNativeId === identity.builderId &&
    policy.systemId === identity.systemId
  ).sort((a, b) => persistedOrder(a.id, b.id));
}
