/** Bounded immutable-pin cache. Verification runs for every caller, including hits. */
export class PinnedExecutableCache<T> {
  readonly #entries = new Map<string, Promise<T>>();
  constructor(readonly capacity: number) {}

  async read(
    key: string,
    load: () => Promise<T>,
    verify: (value: T) => void,
  ): Promise<T> {
    let pending = this.#entries.get(key);
    if (!pending) {
      pending = load();
      this.#entries.set(key, pending);
      if (this.#entries.size > this.capacity) {
        this.#entries.delete(this.#entries.keys().next().value!);
      }
    }
    let value: T;
    try {
      value = await pending;
    } catch (error) {
      if (this.#entries.get(key) === pending) this.#entries.delete(key);
      throw error;
    }
    verify(value);
    return structuredClone(value);
  }
}
