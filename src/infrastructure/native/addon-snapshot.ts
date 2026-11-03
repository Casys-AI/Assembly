import { sha256Bytes as sha256 } from "../../domain/primitives/sha256-bytes.ts";
/** Engine-neutral private N-API snapshots. This module never loads native code. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class NativeAddonSnapshotError extends Error {
  readonly code: string = "NATIVE_ADDON_SNAPSHOT_UNAVAILABLE";
  readonly recovery = "PROVISION_PRIVATE_NATIVE_SNAPSHOT_DIRECTORY";
  constructor(cause: unknown) {
    super(
      "Cannot materialize verified native addon bytes; provision a private snapshotDirectory with read, write and ffi permission",
      { cause },
    );
    this.name = "NativeAddonSnapshotError";
  }
}

/** Kept below the existing toolchain FFI allowlist for direct SDK callers. */
export const DEFAULT_NATIVE_ADDON_SNAPSHOT_DIRECTORY = fileURLToPath(
  new URL("../../../.data/toolchains/", import.meta.url),
);

export interface NativeAddonSnapshotFileSystem {
  makeTempDir(options: { dir: string; prefix: string }): Promise<string>;
  chmod(path: string, mode: number): Promise<void>;
  open(path: string, options: Deno.OpenOptions): Promise<{
    write(bytes: Uint8Array): Promise<number>;
    close(): void;
  }>;
  lstat(path: string): Promise<{ isFile: boolean; isSymlink: boolean }>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  remove(path: string, options: { recursive: boolean }): Promise<void>;
  removeSync?(path: string, options: { recursive: boolean }): void;
}

/** Materialize bytes, never copy a mutable installation path. createNew refuses
 * existing files and symlinks, the private 0700 directory hides its random path,
 * and the final regular file is read-only before it can reach require(). */
export interface NativeAddonSnapshot {
  readonly path: string;
  remove(): Promise<void>;
  removeSync?(): void;
}

export async function materializeNativeAddonSnapshot(
  addonBytes: Uint8Array<ArrayBuffer>,
  digest: string,
  directory = DEFAULT_NATIVE_ADDON_SNAPSHOT_DIRECTORY,
  fs: NativeAddonSnapshotFileSystem = Deno,
): Promise<NativeAddonSnapshot> {
  // Own the buffer before the first await, including for direct SDK callers.
  const bytes = addonBytes.slice();
  let privateDirectory: string | undefined;
  try {
    privateDirectory = await fs.makeTempDir({
      dir: resolve(directory),
      prefix: `native-${digest.slice(0, 16)}-`,
    });
    await fs.chmod(privateDirectory, 0o700);
    const path = `${privateDirectory}/addon.node`;
    const file = await fs.open(path, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = await file.write(bytes.subarray(offset));
        if (written <= 0) {
          throw new Error("Native snapshot write made no progress");
        }
        offset += written;
      }
    } finally {
      file.close();
    }
    const stat = await fs.lstat(path);
    if (!stat.isFile || stat.isSymlink) {
      throw new Error("Native snapshot must be a newly created regular file");
    }
    await fs.chmod(path, 0o400);
    if (await sha256(await fs.readFile(path)) !== await sha256(bytes)) {
      throw new Error("Native snapshot differs from its verified bytes");
    }
    const ownedDirectory = privateDirectory;
    let removal: Promise<void> | undefined;
    return {
      path,
      remove: () => removal ??= fs.remove(ownedDirectory, { recursive: true }),
      ...(fs.removeSync
        ? {
          removeSync: () => fs.removeSync!(ownedDirectory, { recursive: true }),
        }
        : {}),
    };
  } catch (error) {
    if (privateDirectory) {
      await fs.remove(privateDirectory, { recursive: true }).catch(() =>
        undefined
      );
    }
    throw new NativeAddonSnapshotError(error);
  }
}
