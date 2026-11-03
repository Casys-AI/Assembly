/** Byte-weighted LRU cache. Pure application code: no storage, no clock.
 *
 * Recency is insertion/access order. `set` evicts least-recently used
 * completed entries until byte and entry-count limits fit. Empty values are
 * charged one byte; the independent entry cap bounds retained metadata.
 * An entry heavier than the
 * whole capacity is refused (`false`) rather than emptying the cache.
 * Values are stored by reference under an immutability contract: callers
 * that need mutation isolation store encoded bytes and decode per read
 * (see model-projections) instead of cloning object graphs.
 */

interface WeightedLruOptions<V> {
  /** Total byte capacity, must be a positive safe integer. */
  readonly maxBytes: number;
  /** Independent metadata bound; defaults to min(maxBytes, 10_000) entries. */
  readonly maxEntries?: number;
  /** Weight of one entry when `set` gets no explicit weight.
   * Default: byte length for Uint8Array values, otherwise 1. */
  readonly weigh?: (key: string, value: V) => number;
}

interface WeightedLruStats {
  readonly entries: number;
  readonly bytes: number;
  readonly maxBytes: number;
}

interface Entry<V> {
  value: V;
  weight: number;
}

function defaultWeigh<V>(_key: string, value: V): number {
  return value instanceof Uint8Array ? value.byteLength : 1;
}

function checkWeight(weight: number, key: string): number {
  if (!Number.isSafeInteger(weight) || weight < 0) {
    throw new RangeError(
      `Invalid LRU entry weight for ${key}: expected a safe integer >= 0`,
    );
  }
  // Even an empty value retains a map entry and key.
  return Math.max(1, weight);
}

export class WeightedLruCache<V> {
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #weigh: (key: string, value: V) => number;
  readonly #entries = new Map<string, Entry<V>>();
  #bytes = 0;

  constructor(options: WeightedLruOptions<V>) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
      throw new RangeError(
        "Invalid LRU capacity: expected a positive safe integer (maxBytes)",
      );
    }
    const maxEntries = options.maxEntries ?? Math.min(options.maxBytes, 10_000);
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError(
        "Invalid LRU entry capacity: expected a positive safe integer",
      );
    }
    this.#maxEntries = maxEntries;
    this.#maxBytes = options.maxBytes;
    this.#weigh = options.weigh ?? defaultWeigh;
  }

  /** Refresh recency and return the value, or `undefined` on a miss. */
  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  /** Read without touching recency. */
  peek(key: string): V | undefined {
    return this.#entries.get(key)?.value;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  /** Store `value` under `key`, evicting LRU entries until it fits.
   * Zero weights are charged one byte. Returns `false` (and stores nothing)
   * when the entry alone exceeds the
   * capacity. Replacing a key re-weights it and makes it most recent. */
  set(key: string, value: V, weight?: number): boolean {
    const weighed = checkWeight(
      weight ?? this.#weigh(key, value),
      key,
    );
    if (weighed > this.#maxBytes) return false;
    const prior = this.#entries.get(key);
    if (prior !== undefined) {
      this.#bytes -= prior.weight;
      this.#entries.delete(key);
    }
    while (
      this.#bytes + weighed > this.#maxBytes ||
      this.#entries.size >= this.#maxEntries
    ) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#bytes -= this.#entries.get(oldest)!.weight;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, { value, weight: weighed });
    this.#bytes += weighed;
    return true;
  }

  delete(key: string): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    this.#entries.delete(key);
    this.#bytes -= entry.weight;
    return true;
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  /** Keys from least to most recently used. */
  keys(): string[] {
    return [...this.#entries.keys()];
  }

  stats(): WeightedLruStats {
    return {
      entries: this.#entries.size,
      bytes: this.#bytes,
      maxBytes: this.#maxBytes,
    };
  }
}
