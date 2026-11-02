/** Verified shared Cargo vendor tree for the two native addons.
 *
 * The tracked manifest under `vendor/rust/` authorizes the deterministic
 * `.tar.gz` (SHA-256 and size) before any extraction, the exact crate set
 * and per-file checksums of the extracted directory source, and the two
 * `Cargo.lock` files. Existing trees are validated and reused, never
 * overwritten: a divergent tree, lock or archive is refused and preserved.
 */
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readToolkitTar,
  sha256,
  type TarEntry,
} from "./setup-sysml-toolkit.ts";

export { sha256 };

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TAR_BYTES = 256 * 1024 * 1024;
const MAX_TAR_ENTRIES = 16384;
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_PATH = /^[A-Za-z0-9._/+@()-]+$/;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export interface RustVendorCrate {
  name: string;
  version: string;
  directory: string;
  checksum: string;
  crateBytes: number;
  files: Record<string, string>;
}

export interface RustVendorLockfilePin {
  path?: string;
  sha256: string;
  bytes: number;
}

export interface RustVendorManifest {
  schema: 1;
  archive: string;
  archiveSha256: string;
  archiveBytes: number;
  crateCount: number;
  fileCount: number;
  lockfiles: Record<string, RustVendorLockfilePin>;
  crates: RustVendorCrate[];
}

export interface RustVendorOptions {
  toolchainsDirectory?: string;
  vendorDirectory?: string;
  lockfiles?: Record<string, string>;
  archive?: string;
  manifest?: string;
}

export interface RustVendorResult {
  directory: string;
  archiveSha256: string;
  manifestSha256: string;
  cargoConfig: string;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        throw new Error("Rust vendor archive exceeds its size limit");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function regularFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink) {
    throw new Error(`Rust vendor ${label} is not a regular file: ${path}`);
  }
  if (info.size > maxBytes) {
    throw new Error(`Rust vendor ${label} is too large: ${path}`);
  }
  return await Deno.readFile(path);
}

async function expectDirectory(path: string, label: string): Promise<void> {
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error(`Rust vendor ${label} is not a regular directory: ${path}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") &&
    SAFE_PATH.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..");
}

/** Parse and strictly validate the tracked vendor manifest. */
export function parseRustVendorManifest(bytes: Uint8Array): RustVendorManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error("Rust vendor manifest is not valid UTF-8 JSON");
  }
  if (!isRecord(parsed) || parsed.schema !== 1) {
    throw new Error("Rust vendor manifest schema mismatch");
  }
  const manifest = parsed as unknown as RustVendorManifest;
  if (
    typeof manifest.archive !== "string" || !manifest.archive ||
    manifest.archive.includes("/") ||
    !HEX64.test(manifest.archiveSha256 ?? "") ||
    !Number.isSafeInteger(manifest.archiveBytes) ||
    manifest.archiveBytes <= 0 ||
    !Array.isArray(manifest.crates) || manifest.crates.length === 0 ||
    manifest.crateCount !== manifest.crates.length ||
    !isRecord(manifest.lockfiles) ||
    Object.keys(manifest.lockfiles).length === 0
  ) throw new Error("Rust vendor manifest header mismatch");
  let fileCount = 0;
  const directories = new Set<string>();
  let previous = "";
  for (const crate of manifest.crates) {
    if (
      !isRecord(crate) || typeof crate.name !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(crate.name) ||
      typeof crate.version !== "string" || !crate.version ||
      crate.version.includes("/") || crate.version.includes("\\") ||
      crate.directory !== `${crate.name}-${crate.version}` ||
      !HEX64.test(crate.checksum ?? "") ||
      !Number.isSafeInteger(crate.crateBytes) || crate.crateBytes <= 0 ||
      !isRecord(crate.files) || Object.keys(crate.files).length === 0 ||
      !("Cargo.toml" in crate.files)
    ) {
      throw new Error(
        `Rust vendor manifest crate mismatch: ${crate?.directory}`,
      );
    }
    if (directories.has(crate.directory) || crate.directory <= previous) {
      throw new Error("Rust vendor manifest crates are not sorted and unique");
    }
    directories.add(crate.directory);
    previous = crate.directory;
    const names = Object.keys(crate.files);
    if (names.join("\n") !== [...names].sort().join("\n")) {
      throw new Error(
        `Rust vendor manifest files are not sorted: ${crate.directory}`,
      );
    }
    for (const [path, hash] of Object.entries(crate.files)) {
      if (!safeRelativePath(path) || !HEX64.test(hash)) {
        throw new Error(
          `Rust vendor manifest file mismatch: ${crate.directory}/${path}`,
        );
      }
    }
    fileCount += names.length + 1;
  }
  if (manifest.fileCount !== fileCount) {
    throw new Error("Rust vendor manifest file count mismatch");
  }
  for (const [name, pin] of Object.entries(manifest.lockfiles)) {
    if (
      !/^[A-Za-z0-9_-]+$/.test(name) || !isRecord(pin) ||
      !HEX64.test(pin.sha256 ?? "") || !Number.isSafeInteger(pin.bytes) ||
      pin.bytes <= 0 || (pin.path !== undefined && typeof pin.path !== "string")
    ) throw new Error(`Rust vendor manifest lockfile mismatch: ${name}`);
  }
  return manifest;
}

export interface CargoLockRegistryCrate {
  name: string;
  version: string;
  checksum: string;
}

/** Registry crates of a `Cargo.lock`, parsed strictly enough to refuse
 * altered locks: quoted `name`/`version`/`source`/`checksum` only. */
export function parseCargoLockRegistryCrates(
  text: string,
): CargoLockRegistryCrate[] {
  const crates: CargoLockRegistryCrate[] = [];
  let current: Record<string, string> | undefined;
  const flush = () => {
    if (!current) return;
    if ((current.source ?? "").startsWith("registry+")) {
      if (
        !current.name || !current.version || !HEX64.test(current.checksum ?? "")
      ) throw new Error("Cargo.lock registry package is incomplete");
      crates.push({
        name: current.name,
        version: current.version,
        checksum: current.checksum,
      });
    } else if (current.name !== undefined && current.version === undefined) {
      throw new Error("Cargo.lock package is incomplete");
    }
    current = undefined;
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "[[package]]") {
      flush();
      current = {};
      continue;
    }
    if (!current) continue;
    const match = /^(name|version|source|checksum)\s*=\s*"([^"]*)"$/.exec(
      trimmed,
    );
    if (/^(name|version|source|checksum)\s*=/.test(trimmed)) {
      if (!match) {
        throw new Error(`Cargo.lock value is not a plain string: ${trimmed}`);
      }
      if (current[match[1]] !== undefined) {
        throw new Error(`Cargo.lock duplicate key: ${match[1]}`);
      }
      current[match[1]] = match[2];
    }
  }
  flush();
  return crates;
}

async function verifyLockfiles(
  manifest: RustVendorManifest,
  options: RustVendorOptions,
): Promise<void> {
  const provided = options.lockfiles ?? {};
  for (const name of Object.keys(provided)) {
    if (!(name in manifest.lockfiles)) {
      throw new Error(`Rust vendor lockfile is not in the manifest: ${name}`);
    }
  }
  const union = new Map<string, string>();
  for (const [name, pin] of Object.entries(manifest.lockfiles)) {
    const path = provided[name]
      ? resolve(provided[name])
      : pin.path
      ? fileURLToPath(new URL(`../${pin.path}`, import.meta.url))
      : undefined;
    if (!path) throw new Error(`Rust vendor lockfile path is missing: ${name}`);
    const bytes = await regularFile(path, MAX_LOCK_BYTES, `lockfile ${name}`);
    if (bytes.length !== pin.bytes || await sha256(bytes) !== pin.sha256) {
      throw new Error(
        `Rust vendor lockfile checksum or size mismatch: ${name} (${path}). ` +
          "Preserve the modified lock and restore the locked dependencies.",
      );
    }
    for (const crate of parseCargoLockRegistryCrates(decoder.decode(bytes))) {
      const key = `${crate.name}@${crate.version}`;
      if (union.has(key) && union.get(key) !== crate.checksum) {
        throw new Error(`Cargo.lock checksum conflict: ${key}`);
      }
      union.set(key, crate.checksum);
    }
  }
  if (union.size !== manifest.crates.length) {
    throw new Error(
      `Rust vendor crate set differs from the locks: ${union.size} locked, ${manifest.crates.length} in manifest`,
    );
  }
  for (const crate of manifest.crates) {
    if (union.get(`${crate.name}@${crate.version}`) !== crate.checksum) {
      throw new Error(
        `Rust vendor crate differs from the locks: ${crate.name} ${crate.version}`,
      );
    }
  }
}

/** Canonical `.cargo-checksum.json` content for a directory source crate. */
export function cargoChecksumJson(crate: RustVendorCrate): string {
  return JSON.stringify({ files: crate.files, package: crate.checksum });
}

/** Cargo configuration usable as `cargo --config <path>`. */
export function cargoConfigText(directory: string): string {
  return [
    "[source.crates-io]",
    'replace-with = "ase-vendored"',
    "",
    "[source.ase-vendored]",
    `directory = ${JSON.stringify(directory)}`,
    "",
    "[net]",
    "offline = true",
    "",
  ].join("\n");
}

async function validateVendorTree(
  directory: string,
  manifest: RustVendorManifest,
): Promise<void> {
  await expectDirectory(directory, "tree");
  const top = new Set<string>();
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isSymlink) {
      throw new Error(`Rust vendor tree symlink refused: ${entry.name}`);
    }
    top.add(entry.name);
  }
  const expectedTop = new Set(manifest.crates.map((crate) => crate.directory));
  if (
    top.size !== expectedTop.size ||
    [...top].some((name) => !expectedTop.has(name))
  ) {
    throw new Error(
      `Rust vendor tree entries differ from the manifest: ${directory}. ` +
        "Preserve or move this tree and rerun setup to extract the verified archive.",
    );
  }
  for (const crate of manifest.crates) {
    const crateDir = `${directory}/${crate.directory}`;
    await expectDirectory(crateDir, `crate ${crate.directory}`);
    const found = new Map<string, string>();
    const allowedDirectories = new Set<string>();
    for (const file of Object.keys(crate.files)) {
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i++) {
        allowedDirectories.add(parts.slice(0, i).join("/"));
      }
    }
    const visit = async (root: string, prefix: string): Promise<void> => {
      for await (const entry of Deno.readDir(root)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymlink) {
          throw new Error(
            `Rust vendor tree symlink refused: ${crate.directory}/${path}`,
          );
        }
        if (entry.isDirectory) {
          if (!allowedDirectories.has(path)) {
            throw new Error(
              `Rust vendor crate directories differ from the manifest: ${crate.directory}/${path}`,
            );
          }
          await visit(`${root}/${entry.name}`, path);
        } else if (entry.isFile) found.set(path, `${root}/${entry.name}`);
        else {throw new Error(
            `Rust vendor tree special entry refused: ${crate.directory}/${path}`,
          );}
      }
    };
    await visit(crateDir, "");
    const expected = new Set([
      ...Object.keys(crate.files),
      ".cargo-checksum.json",
    ]);
    if (
      found.size !== expected.size ||
      [...found.keys()].some((p) => !expected.has(p))
    ) {
      throw new Error(
        `Rust vendor crate files differ from the manifest: ${crate.directory}. ` +
          "Preserve or move this tree and rerun setup to extract the verified archive.",
      );
    }
    const checksumBytes = await regularFile(
      `${crateDir}/.cargo-checksum.json`,
      MAX_FILE_BYTES,
      "crate checksum",
    );
    if (decoder.decode(checksumBytes) !== cargoChecksumJson(crate)) {
      throw new Error(
        `Rust vendor crate checksum file mismatch: ${crate.directory}`,
      );
    }
    for (const [path, hash] of Object.entries(crate.files)) {
      const bytes = await regularFile(
        found.get(path)!,
        MAX_FILE_BYTES,
        "crate file",
      );
      if (await sha256(bytes) !== hash) {
        throw new Error(
          `Rust vendor crate file checksum mismatch: ${crate.directory}/${path}. ` +
            "Preserve or move this tree and rerun setup to extract the verified archive.",
        );
      }
    }
  }
}

function expectedArchiveFiles(
  manifest: RustVendorManifest,
): Map<string, string> {
  const expected = new Map<string, string>();
  for (const crate of manifest.crates) {
    for (const [path, hash] of Object.entries(crate.files)) {
      expected.set(`${crate.directory}/${path}`, hash);
    }
    expected.set(
      `${crate.directory}/.cargo-checksum.json`,
      cargoChecksumJson(crate),
    );
  }
  return expected;
}

async function verifyArchiveEntries(
  entries: TarEntry[],
  manifest: RustVendorManifest,
): Promise<void> {
  const expected = expectedArchiveFiles(manifest);
  const allowedDirs = new Set<string>();
  for (const path of expected.keys()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      allowedDirs.add(parts.slice(0, i).join("/"));
    }
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.directory) {
      if (!allowedDirs.has(entry.path)) {
        throw new Error(
          `Rust vendor archive directory is not in the manifest: ${entry.path}`,
        );
      }
      continue;
    }
    const wanted = expected.get(entry.path);
    if (wanted === undefined) {
      throw new Error(
        `Rust vendor archive file is not in the manifest: ${entry.path}`,
      );
    }
    const matches = entry.path.endsWith("/.cargo-checksum.json")
      ? decoder.decode(entry.bytes) === wanted
      : await sha256(entry.bytes) === wanted;
    if (!matches) {
      throw new Error(
        `Rust vendor archive file checksum mismatch: ${entry.path}`,
      );
    }
    seen.add(entry.path);
  }
  if (seen.size !== expected.size) {
    throw new Error("Rust vendor archive is missing manifest files");
  }
}

async function writeEntries(
  root: string,
  entries: readonly TarEntry[],
): Promise<void> {
  for (const entry of entries) {
    const path = `${root}/${entry.path}`;
    if (entry.directory) {
      await Deno.mkdir(path, { recursive: true });
    } else {
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeFile(path, entry.bytes, { createNew: true });
    }
  }
}

async function ensureCargoConfig(
  path: string,
  directory: string,
): Promise<void> {
  const content = cargoConfigText(directory);
  try {
    const info = await Deno.lstat(path);
    if (!info.isFile || info.isSymlink) {
      throw new Error(
        `Rust vendor cargo config is not a regular file: ${path}`,
      );
    }
    if (decoder.decode(await Deno.readFile(path)) === content) return;
    throw new Error(
      `Refusing divergent Rust vendor cargo config: ${path}. Preserve or move this configuration before retrying.`,
    );
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const temporary = `${path}.${crypto.randomUUID()}.next`;
  try {
    await Deno.writeTextFile(temporary, content, { createNew: true });
    await Deno.rename(temporary, path);
  } finally {
    await Deno.remove(temporary).catch(() => undefined);
  }
}

/** Verify the manifest, archive and locks, then extract the vendor tree
 * atomically or reuse the existing validated tree unchanged. */
export async function ensureRustVendor(
  options: RustVendorOptions = {},
): Promise<RustVendorResult> {
  const toolchainsDirectory = resolve(
    options.toolchainsDirectory ??
      fileURLToPath(new URL("../.data/toolchains/", import.meta.url)),
  );
  const vendorDirectory = resolve(
    options.vendorDirectory ?? `${toolchainsDirectory}/rust-vendor`,
  );
  const archivePath = resolve(
    options.archive ??
      fileURLToPath(
        new URL("../vendor/rust/rust-vendor.tar.gz", import.meta.url),
      ),
  );
  const manifestPath = resolve(
    options.manifest ??
      fileURLToPath(new URL("../vendor/rust/manifest.json", import.meta.url)),
  );
  const cargoConfig = `${vendorDirectory}.cargo-config.toml`;
  await Deno.mkdir(dirname(vendorDirectory), { recursive: true });
  const lockPath = `${vendorDirectory}.install.lock`;
  let lock: Deno.FsFile;
  try {
    lock = await Deno.open(lockPath, { createNew: true, write: true });
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      throw new Error(
        `Rust vendor installation is locked; inspect ${lockPath} before retrying`,
      );
    }
    throw error;
  }
  let staging: string | undefined;
  try {
    await lock.write(encoder.encode(JSON.stringify({ pid: Deno.pid })));
    const manifestBytes = await regularFile(
      manifestPath,
      MAX_MANIFEST_BYTES,
      "manifest",
    );
    const manifestSha256 = await sha256(manifestBytes);
    const manifest = parseRustVendorManifest(manifestBytes);
    if (manifest.archive !== basename(archivePath)) {
      throw new Error("Rust vendor manifest archive name mismatch");
    }
    const archiveBytes = await regularFile(
      archivePath,
      MAX_ARCHIVE_BYTES,
      "archive",
    );
    if (
      archiveBytes.length !== manifest.archiveBytes ||
      await sha256(archiveBytes) !== manifest.archiveSha256
    ) {
      throw new Error(
        "Rust vendor archive checksum or size mismatch. " +
          "Preserve the altered archive and restore the tracked vendor archive.",
      );
    }
    await verifyLockfiles(manifest, options);

    let existing = false;
    try {
      const info = await Deno.lstat(vendorDirectory);
      if (!info.isDirectory || info.isSymlink) {
        throw new Error(
          `Refusing unexpected Rust vendor tree: ${vendorDirectory}`,
        );
      }
      existing = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (existing) {
      await validateVendorTree(vendorDirectory, manifest);
      await ensureCargoConfig(cargoConfig, vendorDirectory);
      return {
        directory: vendorDirectory,
        archiveSha256: manifest.archiveSha256,
        manifestSha256,
        cargoConfig,
      };
    }

    const tar = await readBounded(
      new Blob([Uint8Array.from(archiveBytes)]).stream().pipeThrough(
        new DecompressionStream("gzip"),
      ),
      MAX_TAR_BYTES,
    );
    const entries = readToolkitTar(tar, {
      maxBytes: MAX_TAR_BYTES,
      maxEntries: MAX_TAR_ENTRIES,
    });
    await verifyArchiveEntries(entries, manifest);
    staging = await Deno.makeTempDir({
      dir: dirname(vendorDirectory),
      prefix: ".rust-vendor-",
    });
    const tree = `${staging}/tree`;
    await Deno.mkdir(tree, { recursive: true });
    await writeEntries(tree, entries);
    await validateVendorTree(tree, manifest);
    await Deno.rename(tree, vendorDirectory);
    await ensureCargoConfig(cargoConfig, vendorDirectory);
    return {
      directory: vendorDirectory,
      archiveSha256: manifest.archiveSha256,
      manifestSha256,
      cargoConfig,
    };
  } finally {
    if (staging) {
      await Deno.remove(staging, { recursive: true }).catch(() => undefined);
    }
    lock.close();
    await Deno.remove(lockPath).catch(() => undefined);
  }
}

if (import.meta.main) {
  const options: RustVendorOptions = {};
  const lockfiles: Record<string, string> = {};
  for (const arg of Deno.args) {
    if (arg.startsWith("--toolchains-dir=")) {
      options.toolchainsDirectory = arg.slice("--toolchains-dir=".length);
    } else if (arg.startsWith("--vendor-dir=")) {
      options.vendorDirectory = arg.slice("--vendor-dir=".length);
    } else if (arg.startsWith("--archive=")) {
      options.archive = arg.slice("--archive=".length);
    } else if (arg.startsWith("--manifest=")) {
      options.manifest = arg.slice("--manifest=".length);
    } else if (arg.startsWith("--lock=")) {
      const value = arg.slice("--lock=".length);
      const eq = value.indexOf("=");
      if (eq <= 0) throw new Error(`Invalid --lock argument: ${arg}`);
      lockfiles[value.slice(0, eq)] = value.slice(eq + 1);
    } else throw new Error(`Unknown Rust vendor setup argument: ${arg}`);
  }
  if (Object.keys(lockfiles).length) options.lockfiles = lockfiles;
  console.log(JSON.stringify(await ensureRustVendor(options)));
}
