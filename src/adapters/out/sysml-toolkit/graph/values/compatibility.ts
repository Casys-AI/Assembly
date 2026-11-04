import type { SourceValueCompatibility } from "../../../../../domain/model/value-objects/source-value-compatibility.ts";
import { valueRefs } from "../../../../../domain/model/value-objects/expressions.ts";

export const toolkitSourceValueCompatibility: SourceValueCompatibility = {
  arguments(expression, valuesByFeature, element, one) {
    const arguments_ = valueRefs(expression.argument);
    const inputs = valueRefs(expression.input);
    if (!inputs.length) return arguments_;
    // Toolkit 0.10.10 truncates `argument` to two entries for n-ary comma.
    // Ordered native input features retain every argument's FeatureValue.
    const complete = inputs.map((id, index) => {
      const input = element(id);
      if (
        one(input.owner, `sequence input ${index}`) !== expression["@id"] ||
        input.direction !== "in"
      ) throw new Error(`Invalid sequence input ${index} (${id})`);
      const values = valuesByFeature.get(id) ?? [];
      if (values.length !== 1) {
        throw new Error(`Sequence input ${index} (${id}): expected one value`);
      }
      return one(values[0].value, `sequence input ${index} (${id})`);
    });
    if (
      arguments_.length > complete.length ||
      arguments_.some((id, index) => id !== complete[index])
    ) throw new Error("Sequence argument/input order disagrees");
    return complete;
  },
  implicitUpper(feature, byId, hasSubsetting) {
    // SysML 2.0 §7.6.3: only structural usages owned by a definition/usage,
    // without explicit subsetting/redefinition, have an implicit [1..1].
    // Toolkit 0.10.10 leaves multiplicity null even in this case. Resolve the
    // owner's native metaclass; a missing owner or a package proves no such
    // default. Evaluate this at each inherited feature, not at its type.
    const ownerIds = valueRefs(feature.owner);
    const owner = ownerIds.length === 1 ? byId.get(ownerIds[0]) : undefined;
    if (
      !hasSubsetting &&
      [
        "AttributeUsage",
        "EnumerationUsage",
        "ItemUsage",
        "PartUsage",
        "PortUsage",
      ]
        .includes(String(feature["@type"])) &&
      /(?:Definition|Usage)$/.test(String(owner?.["@type"]))
    ) return 1;
    return undefined;
  },
};
