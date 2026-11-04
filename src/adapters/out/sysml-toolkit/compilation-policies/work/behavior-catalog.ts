import { persistedOrder } from "../../../../../domain/primitives/persisted-order.ts";
import { sameProductName } from "../../../../../domain/model/sysml-product-names.ts";
import { isNamespacePartOccurrence } from "../../../../../domain/model/policies/model-occurrence.ts";
/** Compile an operator's callable behaviors from exact native exposures.
 * This module validates representation and binding identity, never eligibility,
 * approval, effect, retry or closure predicates of any particular behavior. */
import type { ModelIdentity } from "../../../../../domain/shared-kernel/model-identity.ts";
import type { NativeBehaviorContract } from "../../../../../domain/model/execution/native-contracts.ts";
import type { EvolutionBehaviorDeclaration } from "../../../../../domain/model/evolution/semantic-effects.ts";
import type { ElementRecord } from "../../../../../domain/model/records/snapshot.ts";
import {
  sourceLiterals,
  sourceRefs,
  sourceSnapshot,
} from "../../../../../domain/model/projections/source-facts.ts";

export type { NativeBehaviorContract } from "../../../../../domain/model/execution/native-contracts.ts";
export interface BehaviorSourceRevision {
  version: string;
  elements: Record<string, unknown>[];
  sources: Record<string, string>;
}
const MAX_EXPOSURES = 32;
const MAX_FIELDS = 64;
const MAX_TOTAL_FIELDS = 128;
const MAX_DEPTH = 4;
const UNSAFE_NAMES = new Set(["__proto__", "prototype", "constructor"]);
function requireValue(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(message);
}
function equal(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

export function compileBehaviorCatalog(
  revision: BehaviorSourceRevision,
  identity: ModelIdentity,
  managedSystemIds: readonly string[] = [identity.systemId],
): NativeBehaviorContract[] {
  return compileBehaviorDeclarations(
    revision,
    identity,
    managedSystemIds,
    false,
  )
    .map(({ enabled: _enabled, ...contract }) => contract);
}

/** Evolution-only provenance. Disabled declarations must pass the same exact
 * binding/schema validation as callable ones before receiving any category.
 * The callable compiler deliberately retains its historical disabled fast path. */
export function compileBehaviorDeclarationProvenance(
  revision: BehaviorSourceRevision,
  identity: ModelIdentity,
): EvolutionBehaviorDeclaration[] {
  return compileBehaviorDeclarations(
    revision,
    identity,
    [identity.systemId],
    true,
  );
}

function compileBehaviorDeclarations(
  revision: BehaviorSourceRevision,
  identity: ModelIdentity,
  managedSystemIds: readonly string[],
  includeDisabled: boolean,
): EvolutionBehaviorDeclaration[] {
  requireValue(
    managedSystemIds.includes(identity.systemId) &&
      managedSystemIds.length === new Set(managedSystemIds).size,
    "Invalid managed invocation systems",
  );
  const packages = revision.elements.filter((element) =>
    element["@type"] === "Package" &&
    sameProductName(element.qualifiedName, "AssemblyInvocations")
  );
  if (!packages.length) return [];
  requireValue(packages.length === 1, "Ambiguous native invocation package");
  const snapshot = sourceSnapshot(revision.elements, identity.rootId);
  const elements = snapshot.elements;
  const byId = new Map(elements.map((element) => [element.id, element]));
  const namespaceOccurrence = (element: ElementRecord) =>
    isNamespacePartOccurrence(element, byId.get(element.ownerId));
  const rawById = new Map(
    revision.elements.map((element) => [String(element["@id"]), element]),
  );
  requireValue(
    byId.size === elements.length &&
      rawById.size === revision.elements.length,
    "Duplicate native behavior identity",
  );
  const one = (qualifiedName: string, metaclass: string): ElementRecord => {
    const found = elements.filter((element) =>
      sameProductName(element.qualifiedName, qualifiedName) &&
      element.metaclass === metaclass
    );
    requireValue(
      found.length === 1,
      "Expected one native behavior declaration " + qualifiedName,
    );
    return found[0]!;
  };
  const accessType = one(
    "AssemblyInvocations::BehaviorAccess",
    "PartDefinition",
  );
  requireValue(
    accessType.ownerId === packages[0]!["@id"],
    "Invocation type belongs to another package",
  );
  const memberNames = new Set([
    "name",
    "description",
    "enabled",
    "caller",
    "target",
    "input",
  ]);
  const declarations = elements.filter((element) =>
    element.ownerId === accessType.id
  );
  requireValue(
    declarations.length === memberNames.size &&
      new Set(declarations.map((element) => element.name)).size ===
        memberNames.size &&
      declarations.every((element) => memberNames.has(element.name)),
    "Unsupported native behavior access declaration",
  );
  const baseFeature = (name: string, meta: string, qualifiedType: string) => {
    const feature = one("AssemblyInvocations::BehaviorAccess::" + name, meta);
    requireValue(
      feature.ownerId === accessType.id && feature.isReference === true &&
        feature.typeIds.length === 1 &&
        sameProductName(
          rawById.get(feature.typeIds[0]!)?.qualifiedName,
          qualifiedType,
        ),
      "Invalid native invocation reference " + name,
    );
    return feature;
  };
  const callerBase = baseFeature(
    "caller",
    "PartUsage",
    "AssemblyCore::SoftwareOperator",
  );
  const targetBase = baseFeature("target", "ActionUsage", "Actions::Action");
  const inputBase = baseFeature("input", "ItemUsage", "Items::Item");
  const literals = sourceLiterals(revision.elements);
  const system = byId.get(identity.systemId);
  requireValue(
    system?.metaclass === "PartUsage" &&
      (!system.isReference || namespaceOccurrence(system)),
    "Missing native invocation system",
  );
  const physicalPath = (element: ElementRecord): string[] => {
    const path: string[] = [];
    const seen = new Set<string>();
    let current: ElementRecord | undefined = element;
    while (current && !/^(Library)?Package$/.test(current.metaclass)) {
      requireValue(
        !seen.has(current.id) && !/Definition$/.test(current.metaclass) &&
          (!current.isReference || namespaceOccurrence(current) ||
            current.metaclass === "PerformActionUsage"),
        "Behavior binding must target an actual native usage: " +
          current.qualifiedName,
      );
      seen.add(current.id);
      path.unshift(current.id);
      current = byId.get(current.ownerId);
    }
    requireValue(
      current && path.length > 0,
      "Native behavior usage has no model-owned context",
    );
    return path;
  };
  const pathSuffix = (path: string[], full: string[]) =>
    path.length > 0 && path.length <= full.length &&
    equal(path, full.slice(full.length - path.length));
  const specializes = (
    typeId: string,
    qualifiedName: string,
    seen = new Set<string>(),
  ): boolean => {
    if (seen.has(typeId)) return false;
    if (sameProductName(rawById.get(typeId)?.qualifiedName, qualifiedName)) {
      return true;
    }
    const type = byId.get(typeId);
    return !!type?.generalIds.some((general) =>
      specializes(general, qualifiedName, new Set([...seen, typeId]))
    );
  };
  const accesses = elements.filter((element) =>
    element.metaclass === "PartUsage" &&
    element.typeIds.includes(accessType.id) &&
    !(element.isReference && ["work", "observation"].includes(element.name) &&
      (byId.get(element.ownerId)?.qualifiedName ===
          "APEVerifiedEffectClosure::WorkResultContract" ||
        byId.get(element.ownerId)?.typeIds.some((id) =>
          byId.get(id)?.qualifiedName ===
            "APEVerifiedEffectClosure::WorkResultContract"
        )))
  );
  requireValue(
    accesses.length <= MAX_EXPOSURES,
    "Native behavior exposure limit exceeded",
  );
  const output: EvolutionBehaviorDeclaration[] = [];
  for (
    const access of accesses.toSorted((a, b) => persistedOrder(a.id, b.id))
  ) {
    const ids = new Set<string>([
      String(packages[0]!["@id"]),
      accessType.id,
      access.id,
    ]);
    requireValue(
      access.typeIds.length === 1 && !access.isReference,
      "Ambiguous native behavior exposure type",
    );
    requireValue(
      elements.filter((element) => element.ownerId === access.id).every((
        element,
      ) =>
        element.metaclass === "BindingConnectorAsUsage" ||
        memberNames.has(element.name)
      ),
      "Unsupported native behavior access member",
    );
    const accessPath = physicalPath(access);
    // Evidence is collected separately for each managed operator. A sibling's
    // occurrence never supplies local declaration provenance or authority.
    if (includeDisabled && !accessPath.includes(identity.systemId)) continue;
    requireValue(
      managedSystemIds.some((systemId) => accessPath.includes(systemId)),
      "Native behavior exposure is outside the managed system",
    );
    // A sibling unit is validated against its own caller and mandate by the
    // global executable validator. It never grants this unit an exposure.
    if (!accessPath.includes(identity.systemId)) continue;
    for (const id of accessPath) ids.add(id);
    const scalar = (name: string, type: "String" | "Boolean"): string => {
      const declaration = one(
        "AssemblyInvocations::BehaviorAccess::" + name,
        "AttributeUsage",
      );
      const found = literals.filter((literal) =>
        literal.owner === access.id && literal.name === name
      );
      requireValue(
        found.length === 1 && found[0]!.kind === "Literal" + type &&
          found[0]!.typeIds.length === 1 &&
          found[0]!.typeNames[0] === "ScalarValues::" + type,
        "Expected one typed native behavior value " + name,
      );
      const value = found[0]!;
      const attribute = byId.get(value.attributeId);
      requireValue(
        declaration.ownerId === accessType.id &&
          declaration.declaredReference !== true &&
          declaration.typeIds.length === 1 &&
          rawById.get(declaration.typeIds[0]!)?.qualifiedName ===
            "ScalarValues::" + type &&
          attribute?.ownerId === access.id &&
          attribute.redefinedIds.includes(declaration.id),
        "Behavior metadata must refine its native declaration " + name,
      );
      ids.add(declaration.id);
      ids.add(value.attributeId);
      ids.add(value.literalId);
      for (const id of value.typeIds) ids.add(id);
      for (const id of byId.get(value.attributeId)?.redefinedIds ?? []) {
        ids.add(id);
      }
      return value.value;
    };
    const name = scalar("name", "String");
    const description = scalar("description", "String");
    const enabled = scalar("enabled", "Boolean");
    requireValue(
      name.trim().length > 0 && name.length <= 120 &&
        description.trim().length > 0 && description.length <= 4000 &&
        ["true", "false"].includes(enabled),
      "Invalid native behavior metadata",
    );
    if (enabled === "false" && !includeDisabled) continue;
    try {
      const effective = (base: ElementRecord): ElementRecord => {
        const own = elements.filter((element) =>
          element.ownerId === access.id && element.name === base.name
        );
        requireValue(
          own.length <= 1,
          "Ambiguous native behavior reference " + base.name,
        );
        const feature = own[0] ?? base;
        requireValue(
          feature.metaclass === base.metaclass &&
            feature.isReference === true &&
            feature.typeIds.length === 1 &&
            (feature.id === base.id || feature.redefinedIds.includes(base.id)),
          "Invalid native behavior reference " + base.name,
        );
        ids.add(base.id);
        ids.add(feature.id);
        for (const typeId of feature.typeIds) ids.add(typeId);
        return feature;
      };
      const callerFeature = effective(callerBase);
      const targetFeature = effective(targetBase);
      const inputFeature = effective(inputBase);
      const referenceEnd = (chain: { id: string }[], feature: ElementRecord) =>
        chain.length >= 2 && chain.at(-1)!.id === feature.id &&
        pathSuffix(chain.slice(0, -1).map((segment) => segment.id), accessPath);
      const resolve = (feature: ElementRecord): ElementRecord => {
        const bindings = snapshot.connectors.filter((connector) =>
          connector.metaclass === "BindingConnectorAsUsage" &&
          connector.ends.some((end) => referenceEnd(end.chain, feature))
        );
        requireValue(
          bindings.length === 1 && bindings[0]!.ends.length === 2,
          "Missing or ambiguous native behavior binding " + feature.name,
        );
        const binding = bindings[0]!;
        const matching = binding.ends.filter((end) =>
          referenceEnd(end.chain, feature)
        );
        requireValue(
          matching.length === 1,
          "Self-bound native behavior reference",
        );
        const other = binding.ends.find((end) => end !== matching[0])!.chain;
        const target = other.length ? byId.get(other.at(-1)!.id) : undefined;
        requireValue(
          target,
          "Unresolved native behavior binding " + feature.name,
        );
        requireValue(
          pathSuffix(other.map((segment) => segment.id), physicalPath(target)),
          "Invalid native behavior binding context " + feature.name,
        );
        ids.add(binding.id);
        for (const end of binding.ends) {
          for (const segment of end.chain) ids.add(segment.id);
        }
        return target;
      };
      requireValue(
        !snapshot.connectors.some((connector) =>
          connector.metaclass === "BindingConnectorAsUsage" &&
          connector.ends.some((end) => referenceEnd(end.chain, inputFeature)) &&
          !(connector.ends.length === 2 &&
            connector.ends.filter((end) =>
              !referenceEnd(end.chain, inputFeature)
            ).every((end) => {
              const feature = byId.get(end.chain.at(-1)?.id ?? "");
              const owner = feature && byId.get(feature.ownerId);
              return feature?.name === "input" && feature.isReference &&
                feature.metaclass === "ItemUsage" &&
                owner?.metaclass === "PartUsage" && !owner.isReference &&
                owner.typeIds.length === 1 &&
                byId.get(owner.typeIds[0]!)?.qualifiedName ===
                  "APEVerifiedEffectClosure::WorkResultContract" &&
                feature.typeIds.length === 1 &&
                feature.typeIds[0] === inputFeature.typeIds[0];
            }) &&
            connector.ends.filter((end) =>
                !referenceEnd(end.chain, inputFeature)
              ).length === 1)
        ),
        "Behavior input is a schema reference, not bound mutable case facts",
      );
      const caller = resolve(callerFeature), target = resolve(targetFeature);
      requireValue(
        caller.metaclass === "PartUsage" && caller.typeIds.length === 1 &&
          specializes(caller.typeIds[0]!, "AssemblyCore::SoftwareOperator"),
        "Native behavior caller is not a software operator",
      );
      requireValue(
        specializes(
          caller.typeIds[0]!,
          String(rawById.get(callerFeature.typeIds[0]!)?.qualifiedName),
        ),
        "Native behavior caller violates its reference type",
      );
      requireValue(
        target.metaclass === "PerformActionUsage" &&
          target.typeIds.length === 1 &&
          byId.get(target.typeIds[0]!)?.metaclass === "ActionDefinition",
        "Native behavior target is not one performed action",
      );
      requireValue(
        targetFeature.typeIds[0] === targetBase.typeIds[0] ||
          specializes(
            target.typeIds[0]!,
            String(rawById.get(targetFeature.typeIds[0]!)?.qualifiedName),
          ),
        "Native behavior target violates its reference type",
      );
      // Exposures for another operator do not become this builder's authority.
      if (caller.id !== identity.builderId) continue;
      ids.add(caller.id);
      ids.add(caller.typeIds[0]!);
      ids.add(target.id);
      ids.add(target.typeIds[0]!);
      let totalFields = 0;
      const optional = (field: ElementRecord): boolean => {
        const raw = rawById.get(field.id)!;
        const ranges = sourceRefs(raw.multiplicity);
        const range = ranges.length === 1 ? rawById.get(ranges[0]!) : undefined;
        const lower = sourceRefs(range?.lowerBound);
        const upper = sourceRefs(range?.upperBound);
        if (!ranges.length && !lower.length && !upper.length) return false;
        requireValue(
          ranges.length === 1 && lower.length === 1 && upper.length === 1,
          "Unsupported native behavior input multiplicity " + field.name,
        );
        const low = rawById.get(lower[0]!), high = rawById.get(upper[0]!);
        requireValue(
          range?.["@type"] === "MultiplicityRange" &&
            sourceRefs(range.owner)[0] === field.id &&
            equal(sourceRefs(range.lowerBound), lower) &&
            equal(sourceRefs(range.upperBound), upper) &&
            low?.["@type"] === "LiteralInteger" &&
            high?.["@type"] === "LiteralInteger" &&
            typeof low.value === "number" && typeof high.value === "number" &&
            [0, 1].includes(low.value) && high.value === 1,
          "Unsupported native behavior input multiplicity " + field.name,
        );
        for (const id of [...ranges, ...lower, ...upper]) ids.add(id);
        return low.value === 0;
      };
      const schema = (
        typeId: string,
        ancestors = new Set<string>(),
        depth = 0,
      ): Record<string, unknown> => {
        requireValue(
          depth <= MAX_DEPTH && !ancestors.has(typeId),
          "Recursive or excessive native behavior input schema",
        );
        const type = byId.get(typeId);
        requireValue(
          type?.metaclass === "ItemDefinition",
          "Behavior input must refine one model-owned item definition",
        );
        requireValue(
          type.generalIds.every((general) =>
            rawById.get(general)?.qualifiedName === "Items::Item"
          ),
          "Unsupported inherited native behavior input schema",
        );
        ids.add(type.id);
        const fields = elements.filter((element) =>
          element.ownerId === type.id
        );
        requireValue(
          fields.length <= MAX_FIELDS &&
            fields.every((field) =>
              ["AttributeUsage", "ItemUsage"].includes(field.metaclass)
            ),
          "Unsupported native behavior input fields",
        );
        const properties: Record<string, unknown> = {};
        const required: string[] = [];
        for (
          const field of fields.toSorted((a, b) =>
            persistedOrder(a.name, b.name)
          )
        ) {
          requireValue(
            ++totalFields <= MAX_TOTAL_FIELDS &&
              /^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name) &&
              !UNSAFE_NAMES.has(field.name) &&
              !Object.hasOwn(properties, field.name) &&
              (field.metaclass === "AttributeUsage"
                ? field.declaredReference !== true
                : !field.isReference) &&
              field.typeIds.length === 1 &&
              field.redefinedIds.length === 0,
            "Unsafe or ambiguous native behavior input field " + field.name,
          );
          ids.add(field.id);
          ids.add(field.typeIds[0]!);
          const qualified = rawById.get(field.typeIds[0]!)?.qualifiedName;
          let value: Record<string, unknown>;
          if (field.metaclass === "ItemUsage") {
            value = schema(
              field.typeIds[0]!,
              new Set([...ancestors, typeId]),
              depth + 1,
            );
          } else if (qualified === "ScalarValues::String") {
            value = { type: "string", maxLength: 20_000 };
          } else if (qualified === "ScalarValues::Integer") {
            // This is JSON/JavaScript representation safety, not a domain bound.
            value = {
              type: "integer",
              minimum: Number.MIN_SAFE_INTEGER,
              maximum: Number.MAX_SAFE_INTEGER,
            };
          } else if (qualified === "ScalarValues::Boolean") {
            value = { type: "boolean" };
          } else {
            throw new Error(
              "Unsupported native behavior input scalar " + field.name,
            );
          }
          if (field.doc) value.description = field.doc;
          properties[field.name] = value;
          if (!optional(field)) required.push(field.name);
        }
        return {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        };
      };
      const inputTypeId = inputFeature.typeIds[0]!;
      requireValue(
        inputTypeId !== inputBase.typeIds[0],
        "Behavior input must refine one model-owned item definition",
      );
      const inputSchema = schema(inputTypeId);
      requireValue(
        !output.some((contract) => contract.name === name),
        "Ambiguous callable native behavior name",
      );
      output.push({
        id: access.id,
        name,
        description,
        targetNativeId: target.id,
        targetTypeId: target.typeIds[0]!,
        inputTypeId,
        callerNativeId: caller.id,
        inputSchema,
        sourceIds: [...ids].sort(),
        enabled: enabled === "true",
      });
    } catch (error) {
      // Historically disabled declarations may have no usable binding/schema.
      // Leave them unclassified rather than tightening ordinary compilation or
      // granting provenance to an unresolved declaration. Active errors retain
      // the same fail-closed validation as the callable catalog.
      if (includeDisabled && enabled === "false") continue;
      throw error;
    }
  }
  return output;
}
