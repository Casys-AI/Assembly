import { sourceFacts, sourceRefs, sourceText } from "./source-facts.ts";
import {
  sourceExpressionReader,
  type SourceValueEntry,
  valueRefs,
} from "../value-objects/expressions.ts";
import { sourceMultiplicityReader } from "../value-objects/multiplicity.ts";
import type { SourceValueCompatibility } from "../value-objects/source-value-compatibility.ts";

/**
 * One entry per valued native feature, including expression input features.
 * Absence of a FeatureValue means no declared value, not an unsupported value.
 * Unknown expressions remain explicit; malformed feature endpoints are refused
 * with the FeatureValue identity because they cannot be attached to a feature.
 * This opt-in projection never changes sourceLiterals or artifact serialization.
 */
export function sourceValues(
  elements: Record<string, unknown>[],
  compatibility: SourceValueCompatibility,
): SourceValueEntry[] {
  const facts = sourceFacts(elements);
  const valuesByFeature = new Map<string, Record<string, unknown>[]>();
  for (const relation of elements) {
    if (facts.meta(relation) !== "FeatureValue") continue;
    try {
      const targets = valueRefs(relation.featureWithValue);
      if (targets.length !== 1 || !facts.byId.has(targets[0])) {
        throw new Error("expected one resolved featureWithValue");
      }
      const id = targets[0];
      const relations = valuesByFeature.get(id);
      if (relations) relations.push(relation);
      else valuesByFeature.set(id, [relation]);
    } catch (error) {
      throw new Error(
        `FeatureValue ${facts.id(relation)}: ${(error as Error).message}`,
      );
    }
  }
  const read = sourceExpressionReader(
    facts.byId,
    valuesByFeature,
    compatibility.arguments,
  );
  const multiplicity = sourceMultiplicityReader(
    facts.byId,
    facts.byOwner,
    compatibility.implicitUpper,
  );
  return [...valuesByFeature].map(([featureId, relations]) => {
    const feature = facts.byId.get(featureId)!;
    const relation = relations[0];
    const typeIds = facts.types(feature);
    const entry: SourceValueEntry = {
      owner: sourceRefs(feature.owner)[0] ?? "",
      name: facts.name(feature),
      featureId,
      expressionId: "",
      featureValueId: facts.id(relation),
      qualifiedName: sourceText(feature.qualifiedName),
      typeIds,
      typeNames: typeIds.map((id) =>
        sourceText(facts.byId.get(id)?.qualifiedName)
      ),
      multiplicity: "unknown",
      value: { kind: "unsupported", reason: "Missing native value" },
    };
    if (
      typeof feature["sysx:sourceDocument"] === "string" &&
      typeof feature["sysx:sourceLine"] === "number" &&
      typeof feature["sysx:sourceColumn"] === "number"
    ) {
      entry.location = {
        document: feature["sysx:sourceDocument"],
        line: feature["sysx:sourceLine"],
        column: feature["sysx:sourceColumn"],
      };
    }
    try {
      if (relations.length !== 1) {
        throw new Error(
          `Multiple FeatureValues: ${relations.map(facts.id).join(", ")}`,
        );
      }
      const expressions = valueRefs(relation.value);
      if (expressions.length !== 1) {
        throw new Error("Expected one native value expression");
      }
      entry.expressionId = expressions[0];
      entry.value = read(entry.expressionId);
      // Parentheses around a singleton disappear in native JSON. Preserve the
      // collection contract from native multiplicity, never from source text.
      entry.multiplicity = multiplicity(featureId);
      if (entry.multiplicity === "many") {
        if (entry.value.kind === "reference") {
          throw new Error(
            "Reference items in a multi-valued feature are unsupported",
          );
        }
        if (
          entry.value.kind !== "sequence" &&
          entry.value.kind !== "unsupported"
        ) entry.value = { kind: "sequence", items: [entry.value] };
      }
    } catch (error) {
      entry.value = { kind: "unsupported", reason: (error as Error).message };
    }
    return entry;
  });
}
