/** Counts Unicode code points, as JSON Schema `maxLength`/`minLength` do. */
export function characterCount(value: string): number {
  let count = 0;
  for (const _character of value) count++;
  return count;
}
