export function hasOnlyKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) =>
      required.includes(key) || optional.includes(key)
    );
}

export function assertClosedRecord(
  value: Record<string, unknown>,
  allowed: readonly string[],
  rejectUnexpectedKey: (key: string) => never,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) rejectUnexpectedKey(key);
  }
}
