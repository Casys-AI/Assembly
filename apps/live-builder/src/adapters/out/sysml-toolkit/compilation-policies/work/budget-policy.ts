import { sameProductName } from "../../../../../domain/model/sysml-product-names.ts";
import { isNamespacePartOccurrence } from "../../../../../domain/model/policies/model-occurrence.ts";
/** Compile the optional, source-owned cumulative invocation budget. */
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../domain/model/records/snapshot.ts";
import type { NativeWorkBudgetPolicy } from "../../../../../domain/model/execution/native-contracts.ts";
import type { ModelIdentity } from "../../../../../domain/work/dialogue.ts";
import type { NativeLiteral } from "./execution-model.ts";

export type { NativeWorkBudgetPolicy } from "../../../../../domain/model/execution/native-contracts.ts";
export const MAX_NATIVE_WORK_BUDGET_LIMIT = 1_000_000;
const fields = {
  id: "String",
  revision: "Integer",
  unit: "String",
  limit: "Integer",
  onExhausted: "String",
  exhaustionRecipient: "String",
} as const;
function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Invalid native work budget: ${message}`);
}
export function compileWorkBudgetPolicy(
  snapshot: ModelSnapshot,
  literals: NativeLiteral[],
  identity: ModelIdentity,
): NativeWorkBudgetPolicy | undefined {
  const packages = snapshot.elements.filter((e) =>
    e.qualifiedName === "APEWorkBudget"
  );
  if (!packages.length) return undefined;
  requireValue(
    packages.length === 1 && packages[0]!.metaclass === "Package",
    "package",
  );
  const byId = new Map(snapshot.elements.map((e) => [e.id, e]));
  requireValue(byId.size === snapshot.elements.length, "duplicate identity");
  const definitions = snapshot.elements.filter((e) =>
    e.qualifiedName === "APEWorkBudget::InvocationBudgetPolicy"
  );
  requireValue(
    definitions.length === 1 &&
      definitions[0]!.metaclass === "PartDefinition" &&
      definitions[0]!.ownerId === packages[0]!.id,
    "definition",
  );
  const definition = definitions[0]!;
  const members = snapshot.elements.filter((e) => e.ownerId === definition.id);
  requireValue(
    members.length === Object.keys(fields).length &&
      new Set(members.map((e) => e.name)).size === members.length,
    "exact declaration fields",
  );
  for (const [name, scalar] of Object.entries(fields)) {
    const matches = members.filter((e) => e.name === name);
    requireValue(matches.length === 1, `declaration ${name}`);
    const member = matches[0]!;
    requireValue(
      member.metaclass === "AttributeUsage" &&
        member.typeIds.length === 1 &&
        (!byId.has(member.typeIds[0]!) ||
          byId.get(member.typeIds[0]!)!.qualifiedName ===
            `ScalarValues::${scalar}`),
      `declaration type ${name}`,
    );
  }
  const occurrences = snapshot.elements.filter((e) =>
    e.typeIds.includes(definition.id)
  );
  // Library definitions alone must not alter an existing executable contract.
  if (!occurrences.length) return undefined;
  const namespaceOccurrence = (element: ElementRecord) =>
    isNamespacePartOccurrence(element, byId.get(element.ownerId));
  const system = byId.get(identity.systemId),
    operator = byId.get(identity.builderId);
  requireValue(
    system?.metaclass === "PartUsage" &&
      (!system.isReference || namespaceOccurrence(system)) &&
      system.typeIds.length === 1 &&
      sameProductName(
        byId.get(system.typeIds[0]!)?.qualifiedName,
        "AssemblyLiveBuilder::ConversationSystem",
      ),
    "conversation system",
  );
  requireValue(
    operator?.metaclass === "PartUsage" && !operator.isReference &&
      operator.ownerId === system.id && operator.typeIds.length === 1,
    "operator owner",
  );
  // Select the nearest conversation system, preserving independent dossiers in
  // a shared snapshot. Orphan/type-owned occurrences are never a valid policy.
  const local = occurrences.filter((occurrence) => {
    const seen = new Set<string>();
    let owner = byId.get(occurrence.ownerId);
    while (owner) {
      requireValue(!seen.has(owner.id), "cyclic policy ownership");
      seen.add(owner.id);
      if (owner.id === system.id) return true;
      if (
        owner.typeIds.some((id) =>
          sameProductName(
            byId.get(id)?.qualifiedName,
            "AssemblyLiveBuilder::ConversationSystem",
          )
        )
      ) return false;
      owner = byId.get(owner.ownerId);
    }
    requireValue(false, "owned operator policy");
  });
  if (!local.length) return undefined;
  requireValue(local.length === 1, "one policy per system");
  const occurrence = local[0]!;
  requireValue(
    occurrence.metaclass === "PartUsage" && !occurrence.isReference &&
      occurrence.typeIds.length === 1 && occurrence.ownerId === system.id,
    "owned operator policy",
  );
  const attributes = snapshot.elements.filter((e) =>
    e.ownerId === occurrence.id
  );
  requireValue(
    attributes.length === members.length &&
      attributes.every((e) => Object.hasOwn(fields, e.name)),
    "exact instance fields",
  );
  requireValue(
    literals.filter((l) => l.owner === occurrence.id).length === members.length,
    "exact instance literals",
  );
  const sourceIds = new Set([
    packages[0]!.id,
    definition.id,
    system.id,
    operator.id,
    occurrence.id,
  ]);
  const seen = new Set<string>();
  const values: Record<string, string> = {};
  for (const [name, scalar] of Object.entries(fields)) {
    const base = members.find((e) => e.name === name)!;
    const own = attributes.filter((e) => e.name === name),
      found = literals.filter((l) =>
        l.owner === occurrence.id && l.name === name
      );
    requireValue(own.length === 1 && found.length === 1, `literal ${name}`);
    const attribute = own[0]!, literal = found[0]!;
    requireValue(
      attribute.metaclass === "AttributeUsage" &&
        attribute.typeIds.length === 1 &&
        attribute.typeIds[0] === base.typeIds[0] &&
        attribute.redefinedIds.length === 1 &&
        attribute.redefinedIds[0] === base.id &&
        literal.attributeId === attribute.id && !!literal.literalId &&
        !seen.has(literal.literalId) && literal.kind === `Literal${scalar}` &&
        literal.typeIds.length === 1 &&
        literal.typeIds[0] === base.typeIds[0] &&
        literal.typeNames.length === 1 &&
        literal.typeNames[0] === `ScalarValues::${scalar}`,
      `typed literal ${name}`,
    );
    seen.add(literal.literalId);
    for (
      const id of [base.id, base.typeIds[0]!, attribute.id, literal.literalId]
    ) sourceIds.add(id);
    values[name] = literal.value;
  }
  const integer = (name: string, min: number, max: number) => {
    const raw = values[name]!, value = Number(raw);
    requireValue(
      /^(0|[1-9][0-9]*)$/.test(raw) && Number.isSafeInteger(value) &&
        value >= min && value <= max,
      `integer ${name}`,
    );
    return value;
  };
  requireValue(
    values.id!.length > 0 && values.id!.length <= 128 &&
      values.id!.trim() === values.id &&
      !Array.from(values.id!).some((character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ),
    "id",
  );
  requireValue(
    values.unit === "agent-invocation" && values.onExhausted === "wait" &&
      values.exhaustionRecipient === "local-control",
    "closed profile",
  );
  return {
    id: values.id!,
    revision: integer("revision", 1, Number.MAX_SAFE_INTEGER),
    unit: "agent-invocation",
    limit: integer("limit", 0, MAX_NATIVE_WORK_BUDGET_LIMIT),
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
    elementId: occurrence.id,
    sourceIds: [...sourceIds].toSorted(),
  };
}
