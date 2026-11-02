import { isSha256Hex } from "../../../domain/primitives/execution-digest.ts";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { getuid } from "node:process";
import { readModelProject } from "../../out/filesystem/model-project.ts";
import type { PostgresSystemScope } from "../../out/postgres/scope.ts";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const denied = () => new Error("Owned local control files are unavailable.");
export interface LocalControlProfile {
  scope: PostgresSystemScope;
  primaryOperatorId: string;
  origin: string;
}
export interface LocalCapabilityFile extends PostgresSystemScope {
  format: 1;
  origin: string;
  credentialId: string;
  expiresAt: string;
  capabilitySecret: string;
}
function currentUid(): number {
  if (typeof getuid !== "function") throw denied();
  return getuid();
}
async function ownedDirectory(path: string) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== currentUid() ||
    (stat.mode & 0o022) !== 0
  ) throw denied();
}
async function ownedJSON(path: string, privateMode = false): Promise<unknown> {
  // Numeric Node open flags alone do not enforce no-follow on every supported
  // Deno host. Bind the inspected regular file to the opened descriptor before
  // reading, then verify that the named file still has that identity.
  const named = await lstat(path, { bigint: true });
  if (!named.isFile() || named.isSymbolicLink()) throw denied();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat({ bigint: true });
    if (
      !stat.isFile() || stat.dev !== named.dev || stat.ino !== named.ino ||
      stat.uid !== BigInt(currentUid()) || stat.size < 2n ||
      stat.size > 16384n ||
      (stat.mode & 0o022n) !== 0n ||
      privateMode && (stat.mode & 0o777n) !== 0o600n
    ) throw denied();
    const bytes = new Uint8Array(16385);
    let size = 0;
    while (size < bytes.byteLength) {
      const { bytesRead } = await file.read(
        bytes,
        size,
        bytes.byteLength - size,
        size,
      );
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > 16384) throw denied();
    const current = await lstat(path, { bigint: true });
    if (
      !current.isFile() || current.isSymbolicLink() ||
      current.dev !== stat.dev || current.ino !== stat.ino ||
      current.uid !== stat.uid || current.mode !== stat.mode
    ) throw denied();
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
    );
  } finally {
    await file.close();
  }
}
/** Named profile paths/IDs come from the existing system launcher, not DTOs.
 * The persisted owner is a locator; actual rights are reread from PostgreSQL. */
export async function readLocalControlProfile(options: {
  dataDir: string;
  projectDir: string;
  systemId: string;
  origin: string;
}): Promise<LocalControlProfile> {
  if (
    !UUID.test(options.systemId) ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(options.origin)
  ) throw denied();
  await ownedDirectory(resolve(options.dataDir));
  await ownedDirectory(resolve(options.projectDir));
  const named = await ownedJSON(
    join(options.dataDir, "..", "system.json"),
    true,
  ) as {
    format?: number;
    id?: string;
    port?: number;
  };
  if (
    !named || named.format !== 2 || named.id !== options.systemId ||
    !Number.isSafeInteger(named.port) || named.port! < 1024 ||
    named.port! > 65535 ||
    options.origin !== `http://127.0.0.1:${named.port}`
  ) throw denied();
  const manifest = await ownedJSON(
    join(options.projectDir, "model-project.json"),
  ) as { id?: string };
  const project = await readModelProject(options.projectDir);
  if (manifest.id !== project.id) throw denied();
  const locator = await ownedJSON(
    join(options.dataDir, "main-runtime-owner.json"),
    true,
  ) as {
    format?: number;
    projectId?: string;
    systemId?: string;
    operatorId?: string;
  };
  const projectId = `git:${project.id}`;
  if (
    !locator ||
    Object.keys(locator).sort().join() !==
      "format,operatorId,projectId,systemId" ||
    locator.format !== 1 || locator.projectId !== projectId ||
    locator.systemId !== options.systemId ||
    typeof locator.operatorId !== "string" || !locator.operatorId.trim() ||
    locator.operatorId.includes("\0")
  ) throw denied();
  return {
    scope: { projectId, systemId: options.systemId },
    primaryOperatorId: locator.operatorId,
    origin: options.origin,
  };
}
export function assertLocalCapabilityFile(
  value: unknown,
  profile: LocalControlProfile,
): asserts value is LocalCapabilityFile {
  const row = value as LocalCapabilityFile;
  if (
    !row || typeof row !== "object" || Array.isArray(row) ||
    Object.keys(row).sort().join() !==
      "capabilitySecret,credentialId,expiresAt,format,origin,projectId,systemId" ||
    row.format !== 1 || row.projectId !== profile.scope.projectId ||
    row.systemId !== profile.scope.systemId ||
    row.origin !== profile.origin || !UUID.test(row.credentialId) ||
    !isSha256Hex(row.capabilitySecret) ||
    typeof row.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(row.expiresAt))
  ) throw denied();
}
export async function readLocalCapabilityFile(
  path: string,
  profile: LocalControlProfile,
) {
  await ownedDirectory(dirname(resolve(path)));
  const value = await ownedJSON(path, true);
  assertLocalCapabilityFile(value, profile);
  return value;
}
/** Reserve the explicit output before issuance; never replace an existing file. */
export async function reserveLocalCapabilityFile(path: string) {
  const parent = dirname(resolve(path));
  await ownedDirectory(parent);
  const canonicalPath = join(await realpath(parent), basename(path));
  const file = await open(
    canonicalPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  const owned = await file.stat();
  return {
    path: canonicalPath,
    async save(value: LocalCapabilityFile) {
      await file.writeFile(JSON.stringify(value) + "\n");
      await file.sync();
    },
    async removeOwned() {
      const current = await lstat(canonicalPath).catch(() => null);
      if (current?.dev === owned.dev && current.ino === owned.ino) {
        await unlink(canonicalPath);
      }
    },
    close: () => file.close(),
  };
}
