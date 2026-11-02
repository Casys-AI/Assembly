/** Historical loose record guard: prototypes are not inspected. */
export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
