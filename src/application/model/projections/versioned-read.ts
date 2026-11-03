import { parseModelRevisionId } from "../../../domain/shared-kernel/revision-id.ts";
import { ModelRepositoryError } from "../repository.ts";
import type { VersionedReader } from "./ports/out/versioned-reader.port.ts";

type VersionedKeyValidator = (key: string) => void;

function defaultValidateKey(key: string): void {
  try {
    parseModelRevisionId(key);
  } catch {
    throw new ModelRepositoryError(
      "INVALID_REQUEST",
      "Invalid immutable model version",
    );
  }
}

/** Immutable projections share pending work by commit. Failed reads are evicted;
 * successful reads refresh recency in a bounded LRU, as in the board service.
 * A composite key (such as version plus view) opts into its own validator;
 * the default still requires a bare immutable commit. */
export class VersionedReadService<T> {
  #pending = new Map<string, Promise<T>>();
  #completed = new Map<string, T>();

  constructor(
    private readonly reader: VersionedReader<T>,
    private readonly capacity: number,
    private readonly validateKey: VersionedKeyValidator = defaultValidateKey,
  ) {}

  async read(version: string): Promise<T> {
    this.validateKey(version);
    const pending = this.#pending.get(version);
    if (pending) return await pending;
    if (this.#completed.has(version)) {
      const cached = this.#completed.get(version)!;
      this.#completed.delete(version);
      this.#completed.set(version, cached);
      return cached;
    }
    // In-flight work is never evicted by completed-cache LRU pressure. The
    // projector's queue bounds admission for distinct versions before loading.
    const computation = Promise.resolve().then(() => this.reader.read(version));
    this.#pending.set(version, computation);
    computation.then((value) => {
      this.#pending.delete(version);
      this.#completed.set(version, value);
      if (this.#completed.size > this.capacity) {
        this.#completed.delete(this.#completed.keys().next().value!);
      }
    }, () => {
      if (this.#pending.get(version) === computation) {
        this.#pending.delete(version);
      }
    });
    return await computation;
  }
}
