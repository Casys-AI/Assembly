/** Adversarial tests own mutable data; production DTOs remain readonly. */
export type MutableTestSnapshot<T> = T extends
  string | number | boolean | bigint | symbol | null | undefined ? T
  : T extends object
    ? { -readonly [Key in keyof T]: MutableTestSnapshot<T[Key]> }
  : T;
export function mutableTestSnapshot<T>(value: T): MutableTestSnapshot<T> {
  return structuredClone(value) as MutableTestSnapshot<T>;
}
