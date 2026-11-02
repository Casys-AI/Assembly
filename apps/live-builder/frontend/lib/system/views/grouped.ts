/**
 * `items` by `key`, in the order each key first appears, and each group in the
 * order of its items: the same input always makes the same groups.
 */
export function grouped<T>(
  items: readonly T[],
  key: (item: T) => string,
): [string, T[]][] {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const held = out.get(name);
    if (held) held.push(item);
    else out.set(name, [item]);
  }
  return [...out];
}
