import type { SourceValueEntry } from "./expressions.ts";

export type SourceValueReadErrorCode =
  | "MISSING_VALUE"
  | "DUPLICATE_VALUE"
  | "UNSUPPORTED_VALUE"
  | "INVALID_TYPE"
  | "INVALID_JSON"
  | "ENUM_MISMATCH"
  | "INVALID_ENUM_LITERAL";

function describe(entry: SourceValueEntry): string {
  const location = entry.location;
  const position = location
    ? `${location.document}:${location.line}:${location.column} `
    : "";
  return `${position}${
    entry.qualifiedName || `${entry.owner}::${entry.name}`
  } (${entry.featureId})`;
}

/** A failed policy read retains the source feature and all ambiguous candidates. */
export class SourceValueReadError extends Error {
  constructor(
    readonly code: SourceValueReadErrorCode,
    readonly ownerId: string,
    readonly featureName: string,
    entries: readonly SourceValueEntry[],
    reason: string,
  ) {
    const context = entries.length
      ? entries.map(describe).join("; ")
      : `${ownerId}::${featureName}`;
    super(`${context}: ${reason}`);
    this.name = "SourceValueReadError";
  }
}

interface ExpectedSourceEnum {
  enumQualifiedName: string;
  literals: readonly string[];
}

/** Legacy encodings are selected by the calling policy, never by content. */
interface SourceValueReadOptions {
  legacy?: "json";
}
export interface SourceEnumReadOptions {
  legacy?: "json" | "literal";
}

/** Read native values or explicitly requested legacy String policy attributes.
 * Lookup is exact and scoped to the owner. No absent, ambiguous or unsupported
 * value is coerced to a policy default.
 */
export function sourceValueReaders(entries: readonly SourceValueEntry[]) {
  const owners = new Map<string, Map<string, SourceValueEntry[]>>();
  for (const entry of entries) {
    const names = owners.get(entry.owner) ?? new Map();
    const matches = names.get(entry.name) ?? [];
    matches.push(entry);
    names.set(entry.name, matches);
    owners.set(entry.owner, names);
  }
  const required = (ownerId: string, name: string): SourceValueEntry => {
    const matches = owners.get(ownerId)?.get(name) ?? [];
    if (matches.length !== 1) {
      throw new SourceValueReadError(
        matches.length ? "DUPLICATE_VALUE" : "MISSING_VALUE",
        ownerId,
        name,
        matches,
        matches.length
          ? `Expected one value, found ${matches.length}`
          : "Missing source value",
      );
    }
    const entry = matches[0]!;
    if (entry.value.kind === "unsupported") {
      throw error(entry, "UNSUPPORTED_VALUE", entry.value.reason);
    }
    return entry;
  };
  const error = (
    entry: SourceValueEntry,
    code: SourceValueReadErrorCode,
    reason: string,
  ): SourceValueReadError =>
    new SourceValueReadError(code, entry.owner, entry.name, [entry], reason);
  const json = (entry: SourceValueEntry, source: string): unknown => {
    try {
      return JSON.parse(source);
    } catch {
      throw error(entry, "INVALID_JSON", "Invalid legacy JSON string");
    }
  };
  const requireLegacyString = (
    entry: SourceValueEntry,
    encoding: SourceEnumReadOptions["legacy"],
  ): void => {
    if (!encoding) {
      throw error(
        entry,
        "INVALID_TYPE",
        "Legacy String reading requires an explicit encoding",
      );
    }
    if (
      entry.multiplicity !== "single" || entry.typeNames.length !== 1 ||
      entry.typeNames[0] !== "ScalarValues::String"
    ) {
      throw error(
        entry,
        "INVALID_TYPE",
        "Legacy reading requires a single-valued String feature",
      );
    }
  };
  return {
    /** A native Natural literal, never a String or an evaluated expression. */
    natural(ownerId: string, name: string): number {
      const entry = required(ownerId, name);
      if (
        entry.multiplicity !== "single" || entry.typeNames.length !== 1 ||
        entry.typeNames[0] !== "ScalarValues::Natural" ||
        entry.value.kind !== "LiteralInteger"
      ) {
        throw error(
          entry,
          "INVALID_TYPE",
          "Expected a single native Natural literal",
        );
      }
      const value = Number(entry.value.value);
      if (
        !Number.isSafeInteger(value) || value < 0 ||
        entry.value.value !== String(value)
      ) {
        throw error(
          entry,
          "INVALID_TYPE",
          "Natural value exceeds the supported integer range",
        );
      }
      return value;
    },
    /** Preserve native/legacy sequence order, duplicates and empty strings. */
    stringList(
      ownerId: string,
      name: string,
      options: SourceValueReadOptions = {},
    ): string[] {
      const entry = required(ownerId, name);
      const value = entry.value;
      if (value.kind === "sequence") {
        return value.items.map((item, index) => {
          if (item.kind !== "LiteralString") {
            throw error(
              entry,
              "INVALID_TYPE",
              `Expected string at sequence item ${index}, got ${item.kind}`,
            );
          }
          return item.value;
        });
      }
      if (value.kind !== "LiteralString") {
        throw error(
          entry,
          "INVALID_TYPE",
          `Expected a string sequence or legacy JSON string, got ${value.kind}`,
        );
      }
      requireLegacyString(entry, options.legacy);
      const parsed = json(entry, value.value);
      if (!Array.isArray(parsed)) {
        throw error(entry, "INVALID_TYPE", "Expected a legacy JSON array");
      }
      return parsed.map((item: unknown, index: number) => {
        if (typeof item !== "string") {
          throw error(
            entry,
            "INVALID_TYPE",
            `Expected string at legacy JSON array item ${index}`,
          );
        }
        return item;
      });
    },

    /** Return the literal spelling. Legacy strings have no enum identity; an
     * expected vocabulary validates them without fabricating that identity.
     */
    enumValue(
      ownerId: string,
      name: string,
      expected?: ExpectedSourceEnum,
      options: SourceEnumReadOptions = {},
    ): string {
      const entry = required(ownerId, name);
      const value = entry.value;
      let literal: string;
      if (value.kind === "enum") {
        if (
          expected && value.enumQualifiedName !== expected.enumQualifiedName
        ) {
          throw error(
            entry,
            "ENUM_MISMATCH",
            `Expected enum ${expected.enumQualifiedName}, got ${value.enumQualifiedName} (${value.enumId})`,
          );
        }
        literal = value.literal;
      } else if (value.kind === "LiteralString") {
        requireLegacyString(entry, options.legacy);
        const parsed = options.legacy === "json"
          ? json(entry, value.value)
          : value.value;
        if (typeof parsed !== "string") {
          throw error(entry, "INVALID_TYPE", "Expected a legacy enum string");
        }
        literal = parsed;
      } else {
        throw error(
          entry,
          "INVALID_TYPE",
          `Expected an enum or legacy string, got ${value.kind}`,
        );
      }
      if (expected && !expected.literals.includes(literal)) {
        throw error(
          entry,
          "INVALID_ENUM_LITERAL",
          `Unknown literal ${
            JSON.stringify(literal)
          } for ${expected.enumQualifiedName}`,
        );
      }
      return literal;
    },
  };
}
