import { isNamespacePartOccurrence } from "../../../../../../domain/model/policies/model-occurrence.ts";
import { sameProductName } from "../../../../../../domain/model/sysml-product-names.ts";
import { canonical } from "../../../../../../domain/primitives/canonical-json.ts";
import {
  type NativeSpaceControlPolicy,
  SpaceControlPolicyError,
  spaceControlPolicyFields,
} from "../../../../../../domain/governance/policies/space-execution-policy.ts";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../../domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../../../../../domain/shared-kernel/model-identity.ts";
import type { NativeLiteral } from "../../../../../../domain/model/records/native-literal.ts";
import { compileOwnerAuthority } from "./owner-authority.ts";
import { compileModelPolicyRoot } from "./model-policy-root.ts";

const typeName = "AssemblyAuthority::SpaceControlPolicy";
const fields = {
  id: "String",
  revision: "Integer",
  enabled: "Boolean",
  acts: "String",
} as const;
const references = [
  ["holder", "PartUsage", "AssemblyCore::HumanOperator"],
  ["mandate", "ItemUsage", "AssemblyAuthority::Mandate"],
  ["issuer", "PartUsage", "AssemblyAuthority::RootAuthority"],
  ["allowedOperator", "PartUsage", "AssemblyCore::SoftwareOperator"],
] as const;

/** Native CAP-3 grant only. No role, visibility, RootGrant or legacy fallback.
 * Reads one selected native system; a foreign policy grants no act here. */
export function compileSpaceControlPolicy(
  snapshot: ModelSnapshot,
  literals: NativeLiteral[],
  identity: ModelIdentity,
): NativeSpaceControlPolicy | undefined {
  const fail = (condition: unknown, detail: string): void => {
    if (!condition) throw new SpaceControlPolicyError(detail);
  };
  const byId = new Map(
    snapshot.elements.map((element) => [element.id, element]),
  );
  fail(byId.size === snapshot.elements.length, "duplicate native identity");
  const definitions = snapshot.elements.filter((element) =>
    sameProductName(element.qualifiedName, typeName)
  );
  if (!definitions.length) return undefined;
  fail(
    definitions.length === 1 && definitions[0]!.metaclass === "PartDefinition",
    "one policy definition required",
  );
  const definition = definitions[0]!;
  const member = (owner: string, name: string): ElementRecord => {
    const found = snapshot.elements.filter((element) =>
      element.ownerId === owner && element.name === name
    );
    fail(found.length === 1, `one member ${name} required`);
    return found[0]!;
  };
  const singleton = (element: ElementRecord) =>
    ["", "1", "1..1"].includes(element.multiplicity);
  fail(
    snapshot.elements.filter((element) => element.ownerId === definition.id)
      .length === 8,
    "unsupported definition members",
  );
  for (const [name, scalar] of Object.entries(fields)) {
    const base = member(definition.id, name), type = byId.get(base.typeIds[0]!);
    const names = type
      ? new Set([type.qualifiedName])
      : new Set(literals.flatMap((literal) =>
        literal.typeIds.flatMap((id, index) =>
          id === base.typeIds[0] ? [literal.typeNames[index] ?? ""] : []
        )
      ));
    fail(
      base.metaclass === "AttributeUsage" && base.typeIds.length === 1 &&
        names.size === 1 && names.has(`ScalarValues::${scalar}`),
      `invalid declared scalar ${name}`,
    );
  }
  const sourceIds = [definition.id];
  for (const [name, metaclass, target] of references) {
    const ref = member(definition.id, name),
      targets = snapshot.elements.filter((element) =>
        sameProductName(element.qualifiedName, target)
      );
    fail(
      targets.length === 1 && ref.isReference && ref.metaclass === metaclass &&
        ref.typeIds.length === 1 &&
        ref.typeIds[0] === targets[0]!.id && singleton(ref) &&
        targets[0]!.metaclass ===
          (name === "mandate" ? "ItemDefinition" : "PartDefinition"),
      `invalid reference ${name}`,
    );
    sourceIds.push(ref.id, targets[0]!.id);
  }
  const derives = (
    element: ElementRecord,
    type: string,
    seen = new Set<string>(),
  ): boolean => {
    sourceIds.push(element.id);
    if (sameProductName(element.qualifiedName, type)) return true;
    if (seen.has(element.id)) return false;
    seen.add(element.id);
    return [...element.typeIds, ...element.generalIds].some((id) => {
      const parent = byId.get(id);
      return !!parent && derives(parent, type, seen);
    });
  };
  const occurrences = snapshot.elements.filter((element) =>
    element.ownerId === identity.systemId &&
    element.typeIds.includes(definition.id)
  );
  fail(occurrences.length <= 1, "duplicate or ambiguous system policy");
  if (!occurrences.length) return undefined;
  const occurrence = occurrences[0]!;
  fail(
    occurrence.metaclass === "PartUsage" && !occurrence.isReference &&
      occurrence.typeIds.length === 1 && singleton(occurrence),
    "concrete singleton policy required",
  );
  const system = byId.get(occurrence.ownerId);
  fail(
    system && system.metaclass === "PartUsage" &&
      (!system.isReference ||
        isNamespacePartOccurrence(system, byId.get(system.ownerId))) &&
      singleton(system) &&
      derives(system, "AssemblyLiveBuilder::ConversationSystem"),
    "policy belongs to a concrete conversation system",
  );
  const owner = compileOwnerAuthority(snapshot, literals, system!.id);
  fail(
    owner.ownerSource === "modeled",
    "explicit modeled local owner required",
  );
  const operator = member(system!.id, "builder");
  fail(
    operator.metaclass === "PartUsage" && !operator.isReference &&
      singleton(operator) &&
      operator.id === identity.builderId &&
      derives(operator, "AssemblyCore::SoftwareOperator"),
    "source-owned software operator required",
  );
  fail(
    snapshot.elements.filter((element) => element.ownerId === occurrence.id)
      .length === 4,
    "unsupported occurrence members",
  );
  const values: Record<string, unknown> = {},
    evidence = [...sourceIds, occurrence.id, system!.id, operator.id];
  for (const [name, kind] of Object.entries(fields)) {
    const base = member(definition.id, name),
      attribute = member(occurrence.id, name);
    const matches = literals.filter((literal) =>
        literal.owner === occurrence.id && literal.name === name
      ),
      literal = matches[0];
    fail(
      matches.length === 1 && literal && literal.attributeId === attribute.id &&
        literal.literalId &&
        literal.kind === `Literal${kind}` &&
        attribute.metaclass === "AttributeUsage" &&
        canonical(attribute.redefinedIds) === canonical([base.id]) &&
        canonical(attribute.typeIds) === canonical(base.typeIds) &&
        canonical(literal.typeIds) === canonical(base.typeIds) &&
        canonical(literal.typeNames) === canonical([`ScalarValues::${kind}`]),
      `invalid typed literal ${name}`,
    );
    if (kind === "Integer") {
      fail(
        /^[1-9][0-9]*$/.test(literal!.value),
        "positive policy revision required",
      );
    }
    if (kind === "Boolean") {
      fail(
        ["true", "false"].includes(literal!.value),
        "explicit Boolean value required",
      );
    }
    values[name] = kind === "Integer"
      ? Number(literal!.value)
      : kind === "Boolean"
      ? literal!.value === "true"
      : literal!.value;
    evidence.push(base.id, attribute.id, literal!.literalId, ...base.typeIds);
  }
  const actsSource = String(values.acts);
  try {
    values.acts = JSON.parse(actsSource);
  } catch {
    fail(false, "invalid acts JSON");
  }
  fail(JSON.stringify(values.acts) === actsSource, "noncanonical acts JSON");
  const contents = spaceControlPolicyFields({
    id: values.id,
    revision: values.revision,
    enabled: values.enabled,
    acts: values.acts,
  });
  for (
    const [name, target] of [
      ["holder", [owner.operatorNativeId]],
      ["mandate", [owner.operatorNativeId, owner.mandateNativeId]],
      ["issuer", [
        owner.operatorNativeId,
        owner.mandateNativeId,
        owner.rootAuthorityNativeId,
      ]],
      ["allowedOperator", [operator.id]],
    ] as const
  ) {
    const feature = member(definition.id, name);
    const touching = snapshot.connectors.filter((connector) =>
      connector.metaclass === "BindingConnectorAsUsage" &&
      connector.ends.some((end) =>
        // Qualification or a deeper reference must not hide another binding
        // touching this exact occurrence feature from the ambiguity check.
        end.chain.some((part, index) =>
          part.id === occurrence.id &&
          end.chain[index + 1]?.id === feature.id
        )
      )
    );
    fail(
      touching.length === 1 && touching[0]!.ownerId === system!.id &&
        touching[0]!.ends.length === 2 &&
        touching[0]!.ends.some((end) =>
          canonical(end.chain.map((part) => part.id)) ===
            canonical([occurrence.id, feature.id])
        ) &&
        touching[0]!.ends.some((end) =>
          canonical(end.chain.map((part) => part.id)) === canonical(target)
        ),
      `invalid or foreign ${name} binding`,
    );
    evidence.push(touching[0]!.id);
  }
  const rootAuthority = compileModelPolicyRoot(
    snapshot,
    definition,
    occurrence,
    owner,
  );
  fail(rootAuthority, "explicit root issuer required");
  return {
    ...contents,
    elementId: occurrence.id,
    systemId: system!.id,
    holderNativeId: owner.operatorNativeId,
    mandateNativeId: owner.mandateNativeId,
    issuerRootNativeId: owner.rootAuthorityNativeId,
    operatorIds: [operator.id],
    rootAuthority: rootAuthority!,
    sourceIds: [...new Set([...evidence, ...rootAuthority!.sourceIds])].sort(),
  };
}
