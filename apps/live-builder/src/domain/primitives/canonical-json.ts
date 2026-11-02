/** Semantic IR canonical encoding; distinct from execution digest encoding. */

/** Locale-independent string order for derived lists; never localeCompare. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value as Record<string, unknown>).filter((key) =>
      (value as Record<string, unknown>)[key] !== undefined
    ).sort().map((key) =>
      JSON.stringify(key) + ":" +
      canonical((value as Record<string, unknown>)[key])
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}
