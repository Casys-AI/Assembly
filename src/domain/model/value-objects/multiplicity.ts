import type { SourceValueCompatibility } from "./source-value-compatibility.ts";
import { valueRefs } from "./expressions.ts";

type Raw = Record<string, unknown>;

/** Resolve upper bounds, including only established contextual defaults.
 * Implied library subset/typing relationships are not declaration contracts.
 * Local bounds override inherited bounds; multiple inherited restrictions
 * intersect. An unresolved explicit contract is refused, never guessed single.
 */
export function sourceMultiplicityReader(
  byId: ReadonlyMap<string, Raw>,
  byOwner: ReadonlyMap<string, Raw[]>,
  implicitUpper: SourceValueCompatibility["implicitUpper"],
): (featureId: string) => "single" | "many" | "unknown" {
  const element = (id: string): Raw => {
    const result = byId.get(id);
    if (!result) {
      throw new Error(`Unresolved native multiplicity element ${id}`);
    }
    return result;
  };
  const upperBound = (rangeId: string): number => {
    const range = element(rangeId);
    if (range["@type"] !== "MultiplicityRange") {
      throw new Error(`Unsupported native multiplicity ${rangeId}`);
    }
    const upperIds = valueRefs(range.upperBound);
    const bounds = valueRefs(range.bound);
    if (upperIds.length > 1 || bounds.length > 2) {
      throw new Error("Ambiguous native multiplicity upper bound");
    }
    const upperId = upperIds[0] ?? bounds.at(-1);
    if (!upperId) throw new Error("Missing native multiplicity upper bound");
    const upper = element(upperId);
    if (upper["@type"] === "LiteralInfinity") return Infinity;
    if (
      upper["@type"] === "LiteralInteger" &&
      typeof upper.value === "number" && Number.isSafeInteger(upper.value) &&
      upper.value >= 0
    ) return upper.value;
    throw new Error(`Unsupported native multiplicity upper bound ${upperId}`);
  };
  const inheritedUpper = (
    id: string,
    seen: Set<string>,
  ): number | undefined => {
    if (seen.has(id)) throw new Error(`Cyclic native multiplicity at ${id}`);
    if (seen.size >= 128) {
      throw new Error(`Native multiplicity nesting exceeds 128 at ${id}`);
    }
    const feature = element(id);
    const ranges = new Set([
      ...valueRefs(feature.multiplicity),
      ...(byOwner.get(id) ?? []).filter((child) =>
        child["@type"] === "MultiplicityRange"
      ).map((child) => String(child["@id"])),
    ]);
    if (ranges.size > 1) {
      throw new Error(`Ambiguous native multiplicity at ${id}`);
    }
    if (ranges.size) return upperBound([...ranges][0]);

    const parents = new Set([
      ...valueRefs(feature.redefines),
      ...valueRefs(feature.redefinedFeature),
      ...valueRefs(feature.subsets),
      ...valueRefs(feature.subsettedFeature),
    ]);
    let hasSubsetting = parents.size > 0;
    const relationIds = new Set([
      ...valueRefs(feature.ownedRedefinition),
      ...valueRefs(feature.ownedSubsetting),
      ...valueRefs(feature.ownedReferenceSubsetting),
      ...valueRefs(feature.ownedTyping),
      ...valueRefs(feature.ownedSpecialization),
      ...valueRefs(feature.ownedRelationship),
    ]);
    for (const relationId of relationIds) {
      const relation = element(relationId);
      if (relation.isImplied === true) continue;
      const kind = relation["@type"];
      if (
        kind === "Redefinition" || kind === "Subsetting" ||
        kind === "ReferenceSubsetting"
      ) hasSubsetting = true;
      const fields = kind === "Redefinition"
        ? ["redefinedFeature", "subsettedFeature", "general", "target"]
        : kind === "Subsetting" || kind === "ReferenceSubsetting"
        ? ["subsettedFeature", "referencedFeature", "general", "target"]
        : kind === "FeatureTyping" || kind === "ConjugatedPortTyping"
        ? ["type", "general", "target"]
        : [];
      if (!fields.length) continue;
      const targets = new Set(
        fields.flatMap((field) => valueRefs(relation[field])),
      );
      if (targets.size !== 1) {
        throw new Error(`Ambiguous native multiplicity parent ${relationId}`);
      }
      for (const target of targets) parents.add(target);
    }
    // Derived typing can retain a feature type even without an owned typing.
    // Missing library types cannot supply a bound; their names also cannot
    // satisfy the legacy reader's explicit String type check.
    for (const typeId of valueRefs(feature.type)) {
      if (byId.has(typeId)) parents.add(typeId);
    }
    let upper: number | undefined;
    for (const parent of parents) {
      const bound = inheritedUpper(parent, new Set([...seen, id]));
      if (bound !== undefined) upper = Math.min(upper ?? Infinity, bound);
    }
    if (upper !== undefined) return upper;
    return implicitUpper(feature, byId, hasSubsetting);
  };
  return (id) => {
    const upper = inheritedUpper(id, new Set());
    return upper === undefined ? "unknown" : upper > 1 ? "many" : "single";
  };
}
