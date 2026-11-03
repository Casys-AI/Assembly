import { errorMessage } from "../../../domain/primitives/error-message.ts";
import { sha256Bytes as sha256 } from "../../../domain/primitives/sha256-bytes.ts";
/** Durable vault of verified build bytes (W2g): `<dir>/<A>.zst`.
 *
 * Builds whose recipe is no longer executable survive only as these bytes;
 * they are never recompiled under a newer recipe. Writes are atomic:
 * temp file in the same directory, fsync, rename, directory fsync. Reads
 * decompress and verify sha256 == A; an absent file reads as `null`,
 * never as a hit. The filesystem is a narrow injected port so unit tests
 * exercise ordering and hashes without touching a real directory.
 */
import {
  constants as zlibConstants,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

import {
  type CodecTimingObserver,
  observeCodec,
} from "../../../infrastructure/codec-timing.ts";
import type { ModelBuildVaultPort } from "../../../application/model/builds/ports/out/build-vault.port.ts";

const HEX64 = /^[0-9a-f]{64}$/;
const VAULT_FILE = /^([0-9a-f]{64})\.zst$/;

export type FileBuildVaultErrorCode =
  | "BUILD_BLOB_CORRUPT"
  | "BUILD_BLOB_CONFLICT"
  | "BUILD_STORE_UNAVAILABLE"
  | "BUILD_STORE_INVALID_INPUT";

const VAULT_RECOVERY: Record<FileBuildVaultErrorCode, string> = {
  BUILD_BLOB_CORRUPT:
    "Restore this vault file from backup, or rebuild under the exact recipe and put it again; put rewrites an unreadable entry.",
  BUILD_BLOB_CONFLICT:
    "Keep the existing immutable entry; recompute the digest from the exact uncompressed bytes.",
  BUILD_STORE_UNAVAILABLE:
    "Ensure the vault directory exists and is writable, then retry.",
  BUILD_STORE_INVALID_INPUT:
    "Fix the caller: digests are 64 lowercase hex characters.",
};

export class FileBuildVaultError extends Error {
  readonly recovery: string;
  constructor(
    readonly code: FileBuildVaultErrorCode,
    readonly context: Readonly<Record<string, unknown>>,
    message: string,
  ) {
    super(message);
    this.name = "FileBuildVaultError";
    this.recovery = VAULT_RECOVERY[code];
  }
}

export interface VaultFileSystem {
  mkdirp(dir: string): Promise<void>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  syncFile(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  syncDirectory(dir: string): Promise<void>;
  /** `null` only when the file does not exist. */
  readFile(path: string): Promise<Uint8Array | null>;
  listNames(dir: string): Promise<string[]>;
  removeFile(path: string): Promise<boolean>;
  sizeOf(path: string): Promise<number | null>;
}

function isNotFound(error: unknown): boolean {
  return typeof (error as { code?: unknown })?.code === "string" &&
    (error as { code: string }).code === "ENOENT";
}

/** Real filesystem over node:fs; directory fsync is best-effort only for
 * platforms that reject syncing a directory handle outright. */
export const nodeVaultFileSystem: VaultFileSystem = {
  async mkdirp(dir) {
    await mkdir(dir, { recursive: true });
  },
  async writeFile(path, bytes) {
    await writeFile(path, bytes);
  },
  async syncFile(path) {
    const handle = await open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async syncDirectory(dir) {
    let handle;
    try {
      handle = await open(dir, "r");
      await handle.sync();
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") {
        throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
  async readFile(path) {
    try {
      return new Uint8Array(await readFile(path));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },
  async listNames(dir) {
    try {
      return await readdir(dir);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  },
  async removeFile(path) {
    try {
      await rm(path);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  },
  async sizeOf(path) {
    try {
      return (await stat(path)).size;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },
};

function exactBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function compress(
  bytes: Uint8Array,
  observer?: CodecTimingObserver,
): Uint8Array {
  return observeCodec(
    observer,
    "zstd.vault.compress-with-copy",
    bytes.byteLength,
    () =>
      exactBytes(zstdCompressSync(bytes, {
        params: {
          [zlibConstants.ZSTD_c_compressionLevel]: 3,
          [zlibConstants.ZSTD_c_checksumFlag]: 1,
        },
      })),
  );
}

function assertDigest(digest: string): void {
  if (!HEX64.test(digest)) {
    throw new FileBuildVaultError(
      "BUILD_STORE_INVALID_INPUT",
      { digest, reason: "Expected 64 lowercase hex characters" },
      `Invalid vault digest: ${digest}`,
    );
  }
}

function unavailable(operation: string, cause: unknown): FileBuildVaultError {
  return new FileBuildVaultError(
    "BUILD_STORE_UNAVAILABLE",
    {
      operation,
      cause: errorMessage(cause),
    },
    `Build vault unavailable during ${operation}`,
  );
}

export interface FileBuildVaultOptions {
  readonly directory: string;
  readonly fs?: VaultFileSystem;
  /** Temp-file suffix source; tests inject a fixed value. */
  readonly createTempId?: () => string;
  readonly observeCodecTiming?: CodecTimingObserver;
}

export interface VaultEntry {
  readonly artifactDigest: string;
  readonly compressedBytes: number;
}

export class FileBuildVault implements ModelBuildVaultPort {
  readonly #directory: string;
  readonly #fs: VaultFileSystem;
  readonly #createTempId: () => string;
  readonly #observeCodecTiming?: CodecTimingObserver;

  constructor(options: FileBuildVaultOptions) {
    if (!options.directory) {
      throw new FileBuildVaultError(
        "BUILD_STORE_INVALID_INPUT",
        { reason: "directory is required" },
        "Build vault directory is required",
      );
    }
    this.#directory = options.directory.replace(/\/+$/, "") || "/";
    this.#fs = options.fs ?? nodeVaultFileSystem;
    this.#createTempId = options.createTempId ?? (() => crypto.randomUUID());
    this.#observeCodecTiming = options.observeCodecTiming;
  }

  get directory(): string {
    return this.#directory;
  }

  #pathFor(digest: string): string {
    assertDigest(digest);
    return `${this.#directory}/${digest}.zst`;
  }

  async getVerified(digest: string): Promise<Uint8Array | null> {
    const path = this.#pathFor(digest);
    let compressed: Uint8Array | null;
    try {
      compressed = await this.#fs.readFile(path);
    } catch (error) {
      throw unavailable("get.read", error);
    }
    if (compressed === null) return null;
    let bytes: Uint8Array;
    try {
      bytes = observeCodec(
        this.#observeCodecTiming,
        "zstd.vault.decompress-with-copy",
        compressed.byteLength,
        () => exactBytes(zstdDecompressSync(compressed)),
      );
    } catch (cause) {
      throw new FileBuildVaultError(
        "BUILD_BLOB_CORRUPT",
        { digest, stage: "decompress", cause: String(cause) },
        `Vault entry failed zstd decompression: ${digest}`,
      );
    }
    const actual = await sha256(bytes);
    if (actual !== digest) {
      throw new FileBuildVaultError(
        "BUILD_BLOB_CORRUPT",
        { digest, stage: "verify", actualSha256: actual },
        `Vault entry sha256 mismatch: ${digest}`,
      );
    }
    return bytes;
  }

  /** True only when the entry reads back verified under A. */
  async verify(digest: string): Promise<boolean> {
    try {
      return await this.getVerified(digest) !== null;
    } catch {
      return false;
    }
  }

  async has(digest: string): Promise<boolean> {
    try {
      return await this.#fs.sizeOf(this.#pathFor(digest)) !== null;
    } catch (error) {
      throw unavailable("has", error);
    }
  }

  /** Idempotent atomic store. A verified existing entry is kept
   * (`stored: false`); an unreadable one is replaced by the rename itself
   * — there is no delete-then-write window for concurrent repairers. */
  async putVerified(
    digest: string,
    bytes: Uint8Array,
  ): Promise<{ stored: boolean; bytes: number; digest: string }> {
    const path = this.#pathFor(digest);
    const actual = await sha256(bytes);
    if (actual !== digest) {
      throw new FileBuildVaultError(
        "BUILD_BLOB_CONFLICT",
        { digest, actualSha256: actual },
        `Refusing to vault bytes whose sha256 differs from key: ${digest}`,
      );
    }
    try {
      if (await this.getVerified(digest) !== null) {
        return { stored: false, bytes: bytes.byteLength, digest };
      }
    } catch (error) {
      if (
        !(error instanceof FileBuildVaultError) ||
        error.code !== "BUILD_BLOB_CORRUPT"
      ) throw error;
      // Corrupt entry under its own A: replaced atomically below.
    }
    const tempPath = `${path}.tmp.${this.#createTempId()}`;
    try {
      await this.#fs.mkdirp(this.#directory);
      await this.#fs.writeFile(
        tempPath,
        compress(bytes, this.#observeCodecTiming),
      );
      await this.#fs.syncFile(tempPath);
      await this.#fs.rename(tempPath, path);
      await this.#fs.syncDirectory(this.#directory);
    } catch (error) {
      await this.#fs.removeFile(tempPath).catch(() => undefined);
      if (error instanceof FileBuildVaultError) throw error;
      throw unavailable("put", error);
    }
    // Verified put: re-read through the same hash gate before announcing.
    try {
      const back = await this.getVerified(digest);
      if (back === null || back.byteLength !== bytes.byteLength) {
        throw new Error("vault read-back missing or short");
      }
    } catch (error) {
      await this.#fs.removeFile(path).catch(() => undefined);
      throw new FileBuildVaultError(
        "BUILD_BLOB_CORRUPT",
        { digest, stage: "put-verify", cause: String(error) },
        `Vault put verification failed: ${digest}`,
      );
    }
    return { stored: true, bytes: bytes.byteLength, digest };
  }

  async list(): Promise<readonly VaultEntry[]> {
    let names: string[];
    try {
      names = await this.#fs.listNames(this.#directory);
    } catch (error) {
      throw unavailable("list", error);
    }
    const entries: VaultEntry[] = [];
    for (const name of names.sort()) {
      const match = VAULT_FILE.exec(name);
      if (!match) continue;
      const size = await this.#fs.sizeOf(`${this.#directory}/${name}`)
        .catch((error) => {
          throw unavailable("list.stat", error);
        });
      if (size !== null) {
        entries.push({ artifactDigest: match[1]!, compressedBytes: size });
      }
    }
    return entries;
  }

  /** Retention execution only; planners decide, this just removes. */
  async remove(digest: string): Promise<boolean> {
    try {
      return await this.#fs.removeFile(this.#pathFor(digest));
    } catch (error) {
      throw unavailable("remove", error);
    }
  }
}
