import { sha256Bytes as sha256 } from "../../../domain/primitives/sha256-bytes.ts";
import { deepStrictEqual, equal } from "node:assert/strict";

import {
  FileBuildVault,
  FileBuildVaultError,
  type VaultFileSystem,
} from "./build-vault.ts";

class FakeFs implements VaultFileSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly ops: string[] = [];
  mkdirp(dir: string): Promise<void> {
    this.ops.push(`mkdirp:${dir}`);
    return Promise.resolve();
  }
  writeFile(path: string, bytes: Uint8Array): Promise<void> {
    this.ops.push(`write:${path}`);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.files.set(path, copy);
    return Promise.resolve();
  }
  syncFile(path: string): Promise<void> {
    this.ops.push(`sync-file:${path}`);
    return Promise.resolve();
  }
  rename(from: string, to: string): Promise<void> {
    this.ops.push(`rename:${from}->${to}`);
    const bytes = this.files.get(from);
    if (!bytes) return Promise.reject(new Error(`missing ${from}`));
    this.files.set(to, bytes);
    this.files.delete(from);
    return Promise.resolve();
  }
  syncDirectory(dir: string): Promise<void> {
    this.ops.push(`sync-dir:${dir}`);
    return Promise.resolve();
  }
  readFile(path: string): Promise<Uint8Array | null> {
    const bytes = this.files.get(path);
    if (!bytes) return Promise.resolve(null);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return Promise.resolve(copy);
  }
  listNames(dir: string): Promise<string[]> {
    const prefix = `${dir}/`;
    return Promise.resolve(
      [...this.files.keys()].filter((p) => p.startsWith(prefix)).map((p) =>
        p.slice(prefix.length)
      ),
    );
  }
  removeFile(path: string): Promise<boolean> {
    this.ops.push(`remove:${path}`);
    return Promise.resolve(this.files.delete(path));
  }
  sizeOf(path: string): Promise<number | null> {
    return Promise.resolve(this.files.get(path)?.byteLength ?? null);
  }
}

async function fixture() {
  const bytes = new TextEncoder().encode('{"v":1,"elements":["x","y"]}');
  const digest = await sha256(bytes);
  const fs = new FakeFs();
  const vault = new FileBuildVault({
    directory: "/vault",
    fs,
    createTempId: () => "fixed",
  });
  return { bytes, digest, fs, vault, path: `/vault/${digest}.zst` };
}

Deno.test("file vault writes atomically (temp, fsync, rename, dir sync) and verifies A", async () => {
  const { bytes, digest, fs, vault, path } = await fixture();
  const put = await vault.putVerified(digest, bytes);
  equal(put.stored, true);
  const writeOps = fs.ops.filter((op) => !op.startsWith("remove"));
  deepStrictEqual(writeOps, [
    "mkdirp:/vault",
    `write:${path}.tmp.fixed`,
    `sync-file:${path}.tmp.fixed`,
    `rename:${path}.tmp.fixed->${path}`,
    "sync-dir:/vault",
  ]);
  equal(fs.files.has(`${path}.tmp.fixed`), false);
  deepStrictEqual(await vault.getVerified(digest), bytes);
  equal(await vault.verify(digest), true);
  equal(await vault.has(digest), true);
  const again = await vault.putVerified(digest, bytes);
  equal(again.stored, false);
  const listed = await vault.list();
  equal(listed.length, 1);
  equal(listed[0]?.artifactDigest, digest);
});

Deno.test("file vault reads absence as null and refuses wrong-digest bytes", async () => {
  const { bytes, digest, vault } = await fixture();
  equal(await vault.getVerified(digest), null);
  equal(await vault.verify(digest), false);
  let code = "";
  try {
    await vault.putVerified(digest, new TextEncoder().encode("other"));
  } catch (error) {
    if (error instanceof FileBuildVaultError) code = error.code;
    else throw error;
  }
  equal(code, "BUILD_BLOB_CONFLICT");
  equal(await vault.getVerified(digest), null);
  void bytes;
});

Deno.test("file vault detects byte corruption and repairs it in place", async () => {
  const { bytes, digest, fs, vault, path } = await fixture();
  await vault.putVerified(digest, bytes);
  const stored = fs.files.get(path)!;
  stored[stored.length - 1] = stored[stored.length - 1]! ^ 0xff;
  let code = "";
  try {
    await vault.getVerified(digest);
  } catch (error) {
    if (error instanceof FileBuildVaultError) code = error.code;
    else throw error;
  }
  equal(code, "BUILD_BLOB_CORRUPT");
  const repaired = await vault.putVerified(digest, bytes);
  equal(repaired.stored, true);
  deepStrictEqual(await vault.getVerified(digest), bytes);
  equal(await vault.remove(digest), true);
  equal(await vault.getVerified(digest), null);
});
