import { AsyncLocalStorage } from "node:async_hooks";

/** Host I/O capability, never model authority. All publishers and queue claims
 * for one authoritative Git repository must resolve the same canonical file. */
export interface RepositoryWriterLock {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
  /** Fail closed unless this async call chain currently holds the OS lock. */
  assertHeld(): void;
}

interface HeldLock {
  readonly canonicalPath: string;
  active: boolean;
}
const held = new AsyncLocalStorage<readonly HeldLock[]>();

/** Uses the existing writer.lock file; no second lock or SQL-only fallback.
 * Resolve only host-selected state directories, never a dossier-supplied path. */
export async function repositoryWriterLock(
  stateDir: string,
): Promise<RepositoryWriterLock> {
  const file = await Deno.open(`${stateDir}/writer.lock`, {
    create: true,
    read: true,
    write: true,
  });
  file.close();
  const canonicalPath = await Deno.realPath(`${stateDir}/writer.lock`);
  const current = () =>
    held.getStore()?.some((proof) =>
      proof.active && proof.canonicalPath === canonicalPath
    ) ?? false;
  return {
    assertHeld() {
      if (!current()) {
        throw new Error(
          "Repository writer OS lock is not held by this operation",
        );
      }
    },
    async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
      // Reentrant only within a live host capability chain for the same file.
      if (current()) return await operation();
      const lock = await Deno.open(canonicalPath, { read: true, write: true });
      let locked = false;
      const proof: HeldLock = { canonicalPath, active: false };
      try {
        await lock.lock(true);
        locked = true;
        proof.active = true;
        return await held.run([...(held.getStore() ?? []), proof], operation);
      } finally {
        // Detached async descendants cannot reuse a released proof.
        proof.active = false;
        try {
          if (locked) await lock.unlock();
        } finally {
          lock.close();
        }
      }
    },
  };
}
