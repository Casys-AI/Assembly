/** Values read from native expressions; this is not an expression evaluator. */
interface SourceScalar {
  kind: "LiteralString" | "LiteralBoolean" | "LiteralInteger" | "LiteralReal";
  /** Same scalar encoding as sourceLiterals, including boolean/number strings. */
  value: string;
}
interface SourceEnum {
  kind: "enum";
  enumId: string;
  enumQualifiedName: string;
  literal: string;
}
export type SourceValue =
  | SourceScalar
  | SourceEnum
  | { kind: "sequence"; items: (SourceScalar | SourceEnum)[] }
  | { kind: "reference"; elementId: string; qualifiedName: string }
  | { kind: "unsupported"; reason: string };

export interface SourceValueEntry {
  owner: string;
  name: string;
  featureId: string;
  expressionId: string;
  featureValueId: string;
  qualifiedName: string;
  typeIds: string[];
  typeNames: string[];
  /** Effective maximum cardinality; unknown disables legacy string readers. */
  multiplicity: "single" | "many" | "unknown";
  location?: { document: string; line: number; column: number };
  value: SourceValue;
}

type Raw = Record<string, unknown>;
/** Reject malformed endpoints instead of dropping them from a sequence. */
export function valueRefs(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : value == null ? [] : [value];
  return entries.map((entry) => {
    if (
      !entry || typeof entry !== "object" || Array.isArray(entry) ||
      typeof entry["@id"] !== "string" || !entry["@id"]
    ) throw new Error("Malformed native value reference");
    return entry["@id"];
  });
}

export function sourceExpressionReader(
  byId: ReadonlyMap<string, Raw>,
  valuesByFeature: ReadonlyMap<string, Raw[]>,
): (expressionId: string) => SourceValue {
  const one = (value: unknown, context: string): string => {
    const ids = valueRefs(value);
    if (ids.length !== 1) throw new Error(`${context}: expected one endpoint`);
    return ids[0];
  };
  const element = (id: string): Raw => {
    const result = byId.get(id);
    if (!result) throw new Error(`Unresolved native value element ${id}`);
    return result;
  };
  const named = (value: unknown, context: string): string => {
    if (typeof value !== "string" || !value) {
      throw new Error(`${context}: missing native name`);
    }
    return value;
  };
  const argumentsOf = (expression: Raw): string[] => {
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
  };
  const read = (id: string, seen: Set<string>): SourceValue => {
    if (seen.has(id)) throw new Error(`Cyclic native value expression ${id}`);
    if (seen.size >= 128) {
      throw new Error(`Native value nesting exceeds 128 at ${id}`);
    }
    const expression = element(id);
    const kind = expression["@type"];
    // Toolkit represents the empty sequence `()` as NullExpression.
    if (kind === "NullExpression") return { kind: "sequence", items: [] };
    if (
      kind === "LiteralString" || kind === "LiteralBoolean" ||
      kind === "LiteralInteger" || kind === "LiteralReal"
    ) {
      const value = expression.value;
      const valid = kind === "LiteralString"
        ? typeof value === "string"
        : kind === "LiteralBoolean"
        ? typeof value === "boolean"
        : typeof value === "number" && Number.isFinite(value) &&
          (kind !== "LiteralInteger" || Number.isSafeInteger(value));
      if (!valid) throw new Error(`Invalid ${kind} value at ${id}`);
      return { kind, value: String(value) };
    }
    if (kind === "FeatureReferenceExpression") {
      const referentId = one(expression.referent, `referent of ${id}`);
      const referent = element(referentId);
      if (referent["@type"] === "EnumerationUsage") {
        const enumId = one(referent.owner, `enum owner of ${referentId}`);
        const enumeration = element(enumId);
        // EnumerationUsage also represents named values in packages and parts.
        // Only a member of an EnumerationDefinition is an enum literal.
        if (enumeration["@type"] === "EnumerationDefinition") {
          return {
            kind: "enum",
            enumId,
            enumQualifiedName: named(enumeration.qualifiedName, enumId),
            literal: named(referent.declaredName, referentId),
          };
        }
      }
      return {
        kind: "reference",
        elementId: referentId,
        qualifiedName: named(referent.qualifiedName, referentId),
      };
    }
    if (kind === "OperatorExpression" && expression.operator === ",") {
      const items: (SourceScalar | SourceEnum)[] = [];
      for (const [index, argument] of argumentsOf(expression).entries()) {
        try {
          const item = read(argument, new Set([...seen, id]));
          if (item.kind === "reference" || item.kind === "unsupported") {
            throw new Error(`Unsupported sequence item ${item.kind}`);
          }
          // Comma concatenates sequences, including explicit nested parentheses.
          if (item.kind === "sequence") items.push(...item.items);
          else items.push(item);
        } catch (error) {
          throw new Error(
            `Sequence ${id} item[${index}]: ${(error as Error).message}`,
          );
        }
      }
      return { kind: "sequence", items };
    }
    throw new Error(
      `Unsupported native value ${String(kind)}${
        kind === "OperatorExpression"
          ? ` operator ${String(expression.operator)}`
          : ""
      } at ${id}`,
    );
  };
  return (id) => {
    try {
      return read(id, new Set());
    } catch (error) {
      return { kind: "unsupported", reason: (error as Error).message };
    }
  };
}
