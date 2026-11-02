/** Install the verified precompiled SysML toolkit, or explicitly build sources.
 *
 * Source-mode inputs are the verified vendor archives (exact 8b541ae sources
 * and the byte-identical pinned stdlib) and the shared offline Cargo vendor.
 * The source setup extracts the sources to
 * the checkout the addon Cargo.toml already references, builds
 * native/toolkit with the pinned Rust/napi toolchain into private caches,
 * and installs a native package (.node + stdlib + real manifests) under a
 * new toolchain directory. No WASM is built, installed or executed; the
 * napi-generated JS loader (WASI fallback) is never copied into the package.
 * Byte-for-byte binary reproducibility is not claimed.
 */
import { readAssemblyEnv } from "../src/infrastructure/environment.ts";
import { fileURLToPath } from "node:url";
import { delimiter, resolve } from "node:path";

import {
  toolkitNativeDirectory,
  writeActiveNativePointer,
} from "../src/infrastructure/native/runtime-location.ts";
import {
  NAPI_CLI_VERSION,
  RUST_TOOLCHAIN_VERSION,
  TOOLKIT_ADDON_NAME,
  TOOLKIT_BUNDLED_SOURCE_ARCHIVE,
  TOOLKIT_BUNDLED_STDLIB_ARCHIVE,
  TOOLKIT_COMMIT,
  TOOLKIT_DIRECTORY,
  TOOLKIT_LICENSE_FILES,
  TOOLKIT_NAPI_ABI,
  TOOLKIT_NATIVE_PLATFORMS,
  TOOLKIT_PACKAGE_NAME,
  TOOLKIT_RELEASE,
  TOOLKIT_SOURCE_ARCHIVE_BYTES,
  TOOLKIT_SOURCE_ARCHIVE_PATH,
  TOOLKIT_SOURCE_ARCHIVE_SHA256,
  TOOLKIT_SOURCE_DIRECTORY,
  TOOLKIT_STDLIB_ARCHIVE_BYTES,
  TOOLKIT_STDLIB_ARCHIVE_PATH,
  TOOLKIT_STDLIB_ARCHIVE_SHA256,
  TOOLKIT_STDLIB_FILES,
  TOOLKIT_UPSTREAM_COMMIT,
  toolkitAddonPath,
  type ToolkitNativePlatform,
  toolkitNativePlatform,
} from "../src/adapters/sysml-toolkit-pin.ts";

const MAX_TAR_BYTES = 256 * 1024 * 1024;
const MAX_TAR_ENTRIES = 8192;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export async function sha256(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
        throw new Error("Toolkit archive exceeds its size limit");
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

function tarText(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function tarNumber(bytes: Uint8Array): number {
  const value = tarText(bytes).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("Invalid toolkit TAR number");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) {
    throw new Error("Toolkit TAR size overflow");
  }
  return number;
}
export interface TarEntry {
  path: string;
  directory: boolean;
  bytes: Uint8Array;
}

export interface ReadTarOptions {
  maxBytes?: number;
  maxEntries?: number;
}

/** The pinned vendor archives use USTAR files/directories; no links or extensions. */
export function readToolkitTar(
  bytes: Uint8Array,
  options: ReadTarOptions = {},
): TarEntry[] {
  const maxBytes = options.maxBytes ?? MAX_TAR_BYTES;
  const maxEntries = options.maxEntries ?? MAX_TAR_ENTRIES;
  if (bytes.length > maxBytes || bytes.length % 512 !== 0) {
    throw new Error("Invalid toolkit TAR length");
  }
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!bytes.subarray(offset).every((byte) => byte === 0)) {
        throw new Error("Unexpected data after toolkit TAR end");
      }
      return entries;
    }
    if (!tarText(header.subarray(257, 263)).startsWith("ustar")) {
      throw new Error("Unsupported toolkit TAR format");
    }
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (checksum !== tarNumber(header.subarray(148, 156))) {
      throw new Error("Toolkit TAR header checksum mismatch");
    }
    const type = header[156];
    if (![0, 48, 53].includes(type) || tarText(header.subarray(157, 257))) {
      throw new Error("Toolkit TAR links and special entries are refused");
    }
    const directory = type === 53;
    const prefix = tarText(header.subarray(345, 500));
    const name = tarText(header.subarray(0, 100));
    const path = `${prefix ? `${prefix}/` : ""}${name}`.replace(/\/$/, "");
    if (
      !/^[A-Za-z0-9._/+@()-]+$/.test(path) ||
      path.startsWith("/") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      seen.has(path)
    ) throw new Error(`Unsafe or duplicate toolkit TAR path: ${path}`);
    seen.add(path);
    if (seen.size > maxEntries) {
      throw new Error("Too many toolkit archive entries");
    }
    const size = tarNumber(header.subarray(124, 136));
    const end = offset + 512 + size;
    if (end > bytes.length || (directory && size !== 0)) {
      throw new Error("Truncated or invalid toolkit TAR entry");
    }
    entries.push({ path, directory, bytes: bytes.subarray(offset + 512, end) });
    offset = Math.ceil(end / 512) * 512;
  }
  throw new Error("Toolkit TAR end marker is missing");
}

async function regularFile(
  path: string,
  maxBytes = MAX_TAR_BYTES,
): Promise<Uint8Array> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink) {
    throw new Error(`Not a regular file: ${path}`);
  }
  if (info.size > maxBytes) {
    throw new Error(`Toolkit file is too large: ${path}`);
  }
  return await Deno.readFile(path);
}

async function verifiedArchive(
  path: string,
  expectedBytes: number,
  expectedSha256: string,
  subject: string,
): Promise<TarEntry[]> {
  const compressed = await regularFile(path, expectedBytes);
  if (
    compressed.length !== expectedBytes ||
    await sha256(compressed) !== expectedSha256
  ) throw new Error(`Toolkit ${subject} archive checksum or size mismatch`);
  const tar = await readBounded(
    new Blob([Uint8Array.from(compressed)]).stream().pipeThrough(
      new DecompressionStream("gzip"),
    ),
    MAX_TAR_BYTES,
  );
  return readToolkitTar(tar);
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

export interface CommandRequest {
  program: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}
export interface CommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
}
/** Injectable command seam: unit/integration fakes never build real Rust. */
export type CommandRunner = (
  request: CommandRequest,
) => Promise<CommandOutcome>;

const defaultRunner: CommandRunner = async (request) => {
  const output = await new Deno.Command(request.program, {
    args: request.args,
    ...(request.cwd ? { cwd: request.cwd } : {}),
    ...(request.env ? { env: request.env } : {}),
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
};

async function runChecked(
  runner: CommandRunner,
  request: CommandRequest,
  subject: string,
): Promise<CommandOutcome> {
  const outcome = await runner(request);
  if (outcome.code !== 0) {
    throw new Error(
      `Toolkit ${subject} failed (${request.program} ${
        request.args.slice(0, 3).join(" ")
      }...): ${outcome.stderr.slice(-2000) || outcome.stdout.slice(-2000)}`,
    );
  }
  return outcome;
}

/** Exact pinned version from `rustc --version` output, or undefined. */
export function parseRustcVersion(output: string): string | undefined {
  const match = /^rustc (\d+\.\d+\.\d+)(?:\s|$)/m.exec(output.trim());
  return match?.[1];
}

/** Hash build inputs by stable relative name; generated outputs never participate. */
export async function addonSourceFingerprint(
  crateDir: string,
): Promise<string> {
  const names = new Set([
    "Cargo.toml",
    "Cargo.lock",
    "build.rs",
    "package.json",
  ]);
  const visit = async (directory: string, prefix = ""): Promise<void> => {
    for await (const entry of Deno.readDir(directory)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (["target", "node_modules", ".git", ".cache"].includes(entry.name)) {
        continue;
      }
      if (entry.isSymlink) {
        throw new Error(
          `Refusing symlink in toolkit bridge source tree: ${path}`,
        );
      }
      if (entry.isDirectory) {
        await visit(`${directory}/${entry.name}`, path);
      } else if (entry.name.endsWith(".rs")) {
        names.add(path);
      }
    }
  };
  await visit(crateDir);
  const manifest: Record<string, string> = {};
  for (const path of [...names].sort()) {
    manifest[path] = await sha256(await regularFile(`${crateDir}/${path}`));
  }
  // Include the installed distribution pin as well as the crate's package pin.
  manifest["@ase/sysml-toolkit-pin.ts"] = await sha256(
    await regularFile(
      fileURLToPath(
        new URL("../src/adapters/sysml-toolkit-pin.ts", import.meta.url),
      ),
    ),
  );
  return await sha256(encoder.encode(JSON.stringify(manifest)));
}

export interface NativeBuildInfoInput {
  platform: ToolkitNativePlatform;
  addonFile: string;
  addonSha256: string;
  addonBytes: number;
  bridgeSourceSha256: string;
  /** Provenance du vendor Cargo commun, en mode source uniquement. */
  rustVendorSha256?: string;
  rustVendorManifestSha256?: string;
}

/** Deterministic installed package.json (fields the loader validates). */
export function nativePackageJson(): Record<string, unknown> {
  return {
    name: TOOLKIT_PACKAGE_NAME,
    version: TOOLKIT_RELEASE,
    toolkitCommit: TOOLKIT_COMMIT,
    description:
      "SysML v2 / KerML toolkit as a native N-API addon for Assembly (no WASM)",
    license: "MIT AND Apache-2.0 AND EPL-2.0",
    private: true,
  };
}

/** Deterministic buildinfo: real hashes/versions only, no timestamp, so the
 * bundle fingerprint describes content and tools rather than build time. */
export function nativeBuildInfo(
  input: NativeBuildInfoInput,
): Record<string, unknown> {
  return {
    toolkitVersion: TOOLKIT_RELEASE,
    toolkitCommit: TOOLKIT_COMMIT,
    upstreamCommit: TOOLKIT_UPSTREAM_COMMIT,
    addon: TOOLKIT_ADDON_NAME,
    addonFile: input.addonFile,
    addonSha256: input.addonSha256,
    addonBytes: input.addonBytes,
    bridgeSourceSha256: input.bridgeSourceSha256,
    platform: input.platform,
    target: TOOLKIT_NATIVE_PLATFORMS[input.platform].target,
    abi: TOOLKIT_NAPI_ABI,
    rustc: `rustc ${RUST_TOOLCHAIN_VERSION}`,
    napiCli: NAPI_CLI_VERSION,
    sourceArchiveSha256: TOOLKIT_SOURCE_ARCHIVE_SHA256,
    stdlibArchiveSha256: TOOLKIT_STDLIB_ARCHIVE_SHA256,
    ...(input.rustVendorSha256
      ? { rustVendorSha256: input.rustVendorSha256 }
      : {}),
    ...(input.rustVendorManifestSha256
      ? { rustVendorManifestSha256: input.rustVendorManifestSha256 }
      : {}),
  };
}

/** Vérification d'intégrité et de provenance du package toolkit installé. */
export async function verifyToolkitPackage(
  directory: string,
  platform: ToolkitNativePlatform,
  bridgeSourceSha256: string,
  expectedFiles?: Readonly<Record<string, string>>,
): Promise<void> {
  for (
    const path of [directory, `${directory}/stdlib`, `${directory}/native`]
  ) {
    const info = await Deno.lstat(path);
    if (!info.isDirectory || info.isSymlink) {
      throw new Error(`Not a regular toolkit directory: ${path}`);
    }
  }
  const pinned = { ...TOOLKIT_STDLIB_FILES, ...TOOLKIT_LICENSE_FILES };
  for (const [path, expected] of Object.entries(pinned)) {
    if (await sha256(await regularFile(`${directory}/${path}`)) !== expected) {
      throw new Error(`Toolkit file checksum mismatch: ${path}`);
    }
  }
  const manifest = JSON.parse(
    decoder.decode(await regularFile(`${directory}/package.json`)),
  );
  if (
    manifest.name !== TOOLKIT_PACKAGE_NAME ||
    manifest.version !== TOOLKIT_RELEASE ||
    manifest.toolkitCommit !== TOOLKIT_COMMIT
  ) {
    throw new Error("Toolkit package identity differs from the pin");
  }
  const build = JSON.parse(
    decoder.decode(await regularFile(`${directory}/buildinfo.json`)),
  );
  const addonRelative = toolkitAddonPath(platform);
  const addonBytes = await regularFile(`${directory}/${addonRelative}`);
  if (
    build.toolkitVersion !== TOOLKIT_RELEASE ||
    build.toolkitCommit !== TOOLKIT_COMMIT ||
    build.target !== TOOLKIT_NATIVE_PLATFORMS[platform].target ||
    build.abi !== TOOLKIT_NAPI_ABI ||
    build.addonSha256 !== await sha256(addonBytes) ||
    build.addonBytes !== addonBytes.length ||
    build.bridgeSourceSha256 !== bridgeSourceSha256 ||
    build.sourceArchiveSha256 !== TOOLKIT_SOURCE_ARCHIVE_SHA256 ||
    build.stdlibArchiveSha256 !== TOOLKIT_STDLIB_ARCHIVE_SHA256
  ) {
    throw new Error("Toolkit build identity differs from the pin");
  }
  if (expectedFiles) {
    for (const [path, expected] of Object.entries(expectedFiles)) {
      if (
        await sha256(await regularFile(`${directory}/${path}`)) !== expected
      ) {
        throw new Error(`Toolkit file checksum mismatch: ${path}`);
      }
    }
  }
}

/** Empreintes des fichiers du package, pour le catalogue du packageur. */
export async function hashToolkitPackageFiles(
  directory: string,
  platform: ToolkitNativePlatform,
): Promise<Record<string, string>> {
  const names = [
    "package.json",
    "buildinfo.json",
    ...Object.keys(TOOLKIT_LICENSE_FILES),
    ...Object.keys(TOOLKIT_STDLIB_FILES),
    toolkitAddonPath(platform),
  ];
  const hashes: Record<string, string> = {};
  for (const name of names) {
    hashes[name] = await sha256(await regularFile(`${directory}/${name}`));
  }
  return hashes;
}

async function ensureSources(
  toolchainsRoot: string,
  sourceArchivePath: string,
): Promise<string> {
  const target = `${toolchainsRoot}/${TOOLKIT_SOURCE_DIRECTORY}`;
  const entries = await verifiedArchive(
    sourceArchivePath,
    TOOLKIT_SOURCE_ARCHIVE_BYTES,
    TOOLKIT_SOURCE_ARCHIVE_SHA256,
    "source",
  );
  const verifyTree = async (directory: string) => {
    const expectedPaths = new Set(entries.map((entry) => entry.path));
    for (const entry of entries) {
      const info = await Deno.lstat(`${directory}/${entry.path}`);
      if (
        info.isSymlink || (entry.directory ? !info.isDirectory : !info.isFile)
      ) {
        throw new Error(`Toolkit source type mismatch: ${entry.path}`);
      }
      if (
        !entry.directory &&
        await sha256(await regularFile(`${directory}/${entry.path}`)) !==
          await sha256(entry.bytes)
      ) {
        throw new Error(
          `Toolkit source checksum mismatch: ${entry.path}. Preserve or move the source checkout and rerun setup to extract the pinned archive.`,
        );
      }
    }
    const visit = async (root: string, prefix = ""): Promise<void> => {
      for await (const entry of Deno.readDir(root)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        // Some archives omit explicit parent directory entries.
        const implicitDirectory = entry.isDirectory &&
          entries.some((expected) => expected.path.startsWith(`${path}/`));
        if (
          entry.isSymlink || (!expectedPaths.has(path) && !implicitDirectory)
        ) {
          throw new Error(
            `Unlisted toolkit source entry: ${path}. Preserve or move the source checkout and rerun setup to extract the pinned archive.`,
          );
        }
        if (entry.isDirectory) await visit(`${root}/${entry.name}`, path);
      }
    };
    await visit(directory);
  };
  let existing: Deno.FileInfo | undefined;
  try {
    existing = await Deno.lstat(target);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (existing) {
    if (!existing.isDirectory || existing.isSymlink) {
      throw new Error(`Refusing unexpected toolkit source checkout: ${target}`);
    }
    await verifyTree(target);
    return target;
  }
  const staging = await Deno.makeTempDir({
    dir: toolchainsRoot,
    prefix: `.${TOOLKIT_SOURCE_DIRECTORY}-`,
  });
  try {
    const inner = `${staging}/tree`;
    await Deno.mkdir(inner, { recursive: true });
    await writeEntries(inner, entries);
    await verifyTree(inner);
    await Deno.rename(inner, target);
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => undefined);
  }
  return target;
}

/** Résultat du vendor Cargo commun, préparé hors réseau en mode source. */
export interface PreparedRustVendor {
  directory: string;
  archiveSha256: string;
  manifestSha256: string;
  cargoConfig: string;
}

/** Seam injectable du vendor : la production vérifie `vendor/rust/`. */
export type PrepareRustVendor = (options: {
  toolchainsDirectory: string;
  lockfiles: Record<string, string>;
}) => Promise<PreparedRustVendor>;

/** Seam structurelle vers `installNativeDistribution` (import différé : pas de cycle). */
export interface NativeDistributionRequest {
  runtime: "toolkit" | "semantic-index";
  platform: ToolkitNativePlatform;
  sourceSha256: string;
  toolchainsDirectory: string;
  targetDirectory: string;
  catalogPath?: string;
  bundlePath?: string;
  fetcher?: typeof fetch;
  env?: (key: string) => string | undefined;
  verifyPackage: (packageDir: string) => Promise<unknown>;
}
export type NativeDistributionRunner = (
  request: NativeDistributionRequest,
) => Promise<string>;

export interface InstallOptions {
  toolchainsDirectory?: string;
  /** `precompiled` par défaut ; `source` est le seul chemin de compilation. */
  mode?: "precompiled" | "source";
  catalogPath?: string;
  bundlePath?: string;
  fetcher?: typeof fetch;
  distributionRunner?: NativeDistributionRunner;
  prepareVendor?: PrepareRustVendor;
  /** Override the vendored archives with identical verified local copies. */
  sourceArchive?: string;
  stdlibArchive?: string;
  /** Directory holding pinned cargo/rustc; default: ASSEMBLY_RUST_BIN_DIR (ASE_RUST_BIN_DIR alias), else PATH. */
  rustBinDir?: string;
  /** Addon crate directory; default: native/toolkit beside this app. */
  addonCrateDir?: string;
  platform?: ToolkitNativePlatform;
  runner?: CommandRunner;
  env?: (name: string) => string | undefined;
}

async function defaultDistributionRunner(
  request: NativeDistributionRequest,
): Promise<string> {
  const { installNativeDistribution } = await import(
    "./native-distribution.ts"
  );
  return await installNativeDistribution(request);
}

async function defaultPrepareVendor(options: {
  toolchainsDirectory: string;
  lockfiles: Record<string, string>;
}): Promise<PreparedRustVendor> {
  const { ensureRustVendor } = await import("./setup-rust-vendor.ts");
  return await ensureRustVendor(options);
}

function readEnv(
  options: InstallOptions,
  name: string,
): string | undefined {
  try {
    return (options.env ?? ((key) => Deno.env.get(key)))(name);
  } catch {
    return undefined;
  }
}

export async function installToolkit(
  options: InstallOptions = {},
): Promise<string> {
  const platform = options.platform ??
    toolkitNativePlatform(Deno.build.os, Deno.build.arch);
  if (!platform) {
    throw new Error(
      `No native sysml-toolkit addon is declared for ${Deno.build.os}-${Deno.build.arch}; declared: ${
        Object.keys(TOOLKIT_NATIVE_PLATFORMS).join(", ")
      }`,
    );
  }
  const runner = options.runner ?? defaultRunner;
  const mode = options.mode ?? "precompiled";
  if (mode !== "precompiled" && mode !== "source") {
    throw new Error(`Unknown toolkit installation mode: ${mode}`);
  }
  const root = resolve(
    options.toolchainsDirectory ??
      fileURLToPath(new URL("../.data/toolchains/", import.meta.url)),
  );
  await Deno.mkdir(root, { recursive: true });
  const crateDir = resolve(
    options.addonCrateDir ??
      fileURLToPath(new URL("../native/toolkit/", import.meta.url)),
  );
  // Missing Cargo.lock is an error: build inputs must exist before hashing.
  const bridgeSourceSha256 = await addonSourceFingerprint(crateDir);
  const distributedName = toolkitNativeDirectory(platform, bridgeSourceSha256);
  const distributedTarget = `${root}/${distributedName}`;
  const sourceName = `${distributedName}-source`;
  const sourceTarget = `${root}/${sourceName}`;
  const targetName = mode === "source" ? sourceName : distributedName;
  const target = `${root}/${targetName}`;
  const legacyTarget = `${root}/${TOOLKIT_DIRECTORY}`;
  const lockPath = `${target}.install.lock`;
  let lock: Deno.FsFile;
  try {
    lock = await Deno.open(lockPath, { createNew: true, write: true });
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      throw new Error(
        `Toolkit installation is locked; inspect ${lockPath} before retrying`,
      );
    }
    throw error;
  }
  let staging: string | undefined;
  let buildOutput: string | undefined;
  try {
    await lock.write(encoder.encode(JSON.stringify({ pid: Deno.pid })));
    const sourceArchivePath = options.sourceArchive
      ? resolve(options.sourceArchive)
      : fileURLToPath(TOOLKIT_BUNDLED_SOURCE_ARCHIVE);
    const stdlibArchivePath = options.stdlibArchive
      ? resolve(options.stdlibArchive)
      : fileURLToPath(TOOLKIT_BUNDLED_STDLIB_ARCHIVE);
    // The addon Cargo.toml references the source checkout by a path relative
    // to the crate (../../.data/toolchains/<source dir>): always extract the
    // pinned sources to that exact location, wherever the package installs.
    const sourceRoot = resolve(crateDir, "../../.data/toolchains");

    const activate = async (
      directoryName: string,
      packageDir: string,
    ): Promise<string> => {
      if (await addonSourceFingerprint(crateDir) !== bridgeSourceSha256) {
        throw new Error("Toolkit bridge source changed during installation");
      }
      await writeActiveNativePointer(root, "toolkit", platform, directoryName);
      return packageDir;
    };
    const distributionRunner = options.distributionRunner ??
      defaultDistributionRunner;
    const installPrecompiled = async (): Promise<string> => {
      const packageDir = await distributionRunner({
        runtime: "toolkit",
        platform,
        sourceSha256: bridgeSourceSha256,
        toolchainsDirectory: root,
        targetDirectory: target,
        ...(options.catalogPath ? { catalogPath: options.catalogPath } : {}),
        ...(options.bundlePath ? { bundlePath: options.bundlePath } : {}),
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        env: (key) => readEnv(options, key),
        verifyPackage: (packageDir) =>
          verifyToolkitPackage(packageDir, platform, bridgeSourceSha256),
      });
      return await activate(targetName, packageDir);
    };
    // Un reçu source suit ses propres champs ; un reçu de distribution est
    // toujours recoupé avec le catalogue suivi par l'installateur dédié.
    const reuseBySourceReceipt = async (
      directory: string,
    ): Promise<"source" | "distribution" | undefined> => {
      let receipt: Record<string, unknown>;
      try {
        receipt = JSON.parse(
          decoder.decode(await regularFile(`${directory}/release.json`)),
        );
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return undefined;
        throw error;
      }
      if (typeof receipt !== "object" || receipt === null) return undefined;
      if ("bundle" in receipt) return "distribution";
      if (
        receipt.release !== TOOLKIT_RELEASE ||
        receipt.commit !== TOOLKIT_COMMIT ||
        receipt.platform !== platform ||
        receipt.bridgeSourceSha256 !== bridgeSourceSha256 ||
        receipt.sourceArchiveSha256 !== TOOLKIT_SOURCE_ARCHIVE_SHA256 ||
        receipt.stdlibArchiveSha256 !== TOOLKIT_STDLIB_ARCHIVE_SHA256 ||
        !receipt.files || typeof receipt.files !== "object"
      ) {
        throw new Error(
          `Refusing to replace existing toolkit installation: ${directory}. Build inputs or receipt differ; preserve or move this installation and rerun setup to rebuild.`,
        );
      }
      await verifyToolkitPackage(
        `${directory}/package`,
        platform,
        bridgeSourceSha256,
        receipt.files as Record<string, string>,
      );
      return "source";
    };
    const existingKindAt = async (
      directory: string,
    ): Promise<"source" | "distribution" | undefined> => {
      let info: Deno.FileInfo;
      try {
        info = await Deno.lstat(directory);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return undefined;
        throw error;
      }
      if (!info.isDirectory || info.isSymlink) {
        throw new Error(
          `Refusing unexpected existing toolkit installation: ${directory}`,
        );
      }
      const kind = await reuseBySourceReceipt(directory);
      if (!kind) {
        throw new Error(
          `Refusing to replace existing toolkit installation: ${directory}. Build inputs or receipt differ; preserve or move this installation and rerun setup to rebuild.`,
        );
      }
      return kind;
    };
    const recoveredKind = await existingKindAt(sourceTarget);
    if (recoveredKind === "source") {
      return await activate(sourceName, `${sourceTarget}/package`);
    }
    if (recoveredKind === "distribution") {
      throw new Error(
        `Refusing a distribution receipt in the source cache: ${sourceTarget}`,
      );
    }
    // Les anciens builds source restent réutilisables ; les bundles sont
    // préservés et ignorés en mode source, même sans entrée au catalogue.
    const existingKind = await existingKindAt(distributedTarget);
    if (existingKind === "source") {
      return await activate(distributedName, `${distributedTarget}/package`);
    }
    if (existingKind === "distribution" && mode === "precompiled") {
      return await installPrecompiled();
    }
    // Réemploi legacy possible sans extraire les sources du toolkit.
    try {
      const legacyInfo = await Deno.lstat(legacyTarget);
      if (legacyInfo.isDirectory && !legacyInfo.isSymlink) {
        const legacyKind = await reuseBySourceReceipt(legacyTarget).catch(
          () => undefined,
        );
        if (legacyKind === "source") {
          return await activate(
            TOOLKIT_DIRECTORY,
            `${legacyTarget}/package`,
          );
        }
        if (legacyKind === "distribution" && mode === "precompiled") {
          const packageDir = await distributionRunner({
            runtime: "toolkit",
            platform,
            sourceSha256: bridgeSourceSha256,
            toolchainsDirectory: root,
            targetDirectory: legacyTarget,
            ...(options.catalogPath
              ? { catalogPath: options.catalogPath }
              : {}),
            ...(options.bundlePath ? { bundlePath: options.bundlePath } : {}),
            ...(options.fetcher ? { fetcher: options.fetcher } : {}),
            env: (key) => readEnv(options, key),
            verifyPackage: (packageDir) =>
              verifyToolkitPackage(
                packageDir,
                platform,
                bridgeSourceSha256,
              ),
          });
          return await activate(TOOLKIT_DIRECTORY, packageDir);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }

    if (mode === "precompiled") return await installPrecompiled();

    await Deno.mkdir(sourceRoot, { recursive: true });
    await ensureSources(sourceRoot, sourceArchivePath);

    // Pinned toolchain: an override locates binaries, never re-versions them.
    const rustBinDir = options.rustBinDir ??
      readAssemblyEnv("ASSEMBLY_RUST_BIN_DIR", (key) => readEnv(options, key));
    const cargo = rustBinDir ? `${resolve(rustBinDir)}/cargo` : "cargo";
    const rustc = rustBinDir ? `${resolve(rustBinDir)}/rustc` : "rustc";
    const rustcOutcome = await runChecked(
      runner,
      { program: rustc, args: ["--version"] },
      "rustc probe",
    );
    const rustcVersion = parseRustcVersion(rustcOutcome.stdout);
    if (rustcVersion !== RUST_TOOLCHAIN_VERSION) {
      throw new Error(
        `Pinned Rust ${RUST_TOOLCHAIN_VERSION} is required; found ${
          rustcVersion ?? rustcOutcome.stdout.trim() ?? "unknown"
        } via ${rustc}. Set ASSEMBLY_RUST_BIN_DIR to the pinned toolchain bin directory.`,
      );
    }
    const cargoOutcome = await runChecked(
      runner,
      { program: cargo, args: ["--version"] },
      "cargo probe",
    );
    if (
      !new RegExp(`^cargo ${RUST_TOOLCHAIN_VERSION.replaceAll(".", "\\.")}\\b`)
        .test(cargoOutcome.stdout.trim())
    ) throw new Error(`Pinned cargo ${RUST_TOOLCHAIN_VERSION} is required`);
    const nodeOutcome = await runChecked(
      runner,
      { program: "node", args: ["--version"] },
      "node probe",
    );

    const cacheRoot = `${root}/.sysml-toolkit-native-cache-v${TOOLKIT_RELEASE}`;
    const cargoHome = `${cacheRoot}/cargo-home`;
    const cargoTarget = `${cacheRoot}/cargo-target`;
    const npmCache = `${cacheRoot}/npm`;
    for (const dir of [cargoHome, cargoTarget, npmCache]) {
      await Deno.mkdir(dir, { recursive: true });
    }
    const buildEnv: Record<string, string> = {
      RUSTC: rustc,
      CARGO: cargo,
      ...(rustBinDir
        ? {
          PATH: `${resolve(rustBinDir)}${delimiter}${
            readEnv(options, "PATH") ?? ""
          }`,
        }
        : {}),
      CARGO_HOME: cargoHome,
      CARGO_TARGET_DIR: cargoTarget,
      CARGO_TERM_COLOR: "never",
      npm_config_cache: npmCache,
    };
    const npmExec = [
      "exec",
      "--yes",
      `--package=@napi-rs/cli@${NAPI_CLI_VERSION}`,
      "--",
      "napi",
    ];
    const napiOutcome = await runChecked(
      runner,
      {
        program: "npm",
        args: [...npmExec, "--version"],
        cwd: crateDir,
        env: buildEnv,
      },
      "napi CLI probe",
    );
    const napiVersion = napiOutcome.stdout.trim();
    if (
      napiVersion !== NAPI_CLI_VERSION &&
      napiVersion !== `@napi-rs/cli ${NAPI_CLI_VERSION}`
    ) {
      throw new Error(
        `Pinned @napi-rs/cli ${NAPI_CLI_VERSION} is required; probe printed: ${napiOutcome.stdout.trim()}`,
      );
    }

    // Aucun accès registre : le vendor commun vérifié couvre les deux locks.
    const vendor = await (options.prepareVendor ?? defaultPrepareVendor)({
      toolchainsDirectory: root,
      lockfiles: {
        toolkit: `${crateDir}/Cargo.lock`,
        "semantic-index": resolve(crateDir, "../semantic-index/Cargo.lock"),
      },
    });
    buildEnv.CARGO_NET_OFFLINE = "true";
    const triple = TOOLKIT_NATIVE_PLATFORMS[platform].target;
    buildOutput = await Deno.makeTempDir({
      dir: root,
      prefix: ".sysml-toolkit-build-",
    });
    await runChecked(
      runner,
      {
        program: "npm",
        args: [
          ...npmExec,
          "build",
          "--release",
          "--platform",
          "--target",
          triple,
          "--output-dir",
          buildOutput,
          "--js",
          "index.js",
          "--dts",
          "index.d.ts",
          "--",
          "--frozen",
          "--config",
          vendor.cargoConfig,
        ],
        cwd: crateDir,
        env: buildEnv,
      },
      "napi build",
    );
    if (await addonSourceFingerprint(crateDir) !== bridgeSourceSha256) {
      throw new Error(
        "Toolkit bridge build inputs changed during the build; rerun setup with stable sources.",
      );
    }
    await ensureSources(sourceRoot, sourceArchivePath);
    const addonFile = TOOLKIT_NATIVE_PLATFORMS[platform].addonFile;
    const candidates: string[] = [];
    for await (const entry of Deno.readDir(buildOutput)) {
      if (entry.name.endsWith(".node")) candidates.push(entry.name);
    }
    if (candidates.length !== 1 || candidates[0] !== addonFile) {
      throw new Error(
        "Toolkit build must produce exactly one fresh .node addon for the requested platform",
      );
    }
    const addonBytes = await regularFile(`${buildOutput}/${addonFile}`);
    if (addonBytes.length === 0) {
      throw new Error(
        `Native addon build produced an empty file: ${addonFile}`,
      );
    }
    const addonSha256 = await sha256(addonBytes);

    const stdlibEntries = await verifiedArchive(
      stdlibArchivePath,
      TOOLKIT_STDLIB_ARCHIVE_BYTES,
      TOOLKIT_STDLIB_ARCHIVE_SHA256,
      "stdlib",
    );

    staging = await Deno.makeTempDir({
      dir: root,
      prefix: `.sysml-toolkit-native-v${TOOLKIT_RELEASE}-`,
    });
    const packageDir = `${staging}/package`;
    await Deno.mkdir(`${packageDir}/native`, { recursive: true });
    await writeEntries(packageDir, stdlibEntries);
    await Deno.writeFile(
      `${packageDir}/${toolkitAddonPath(platform)}`,
      addonBytes,
      { createNew: true },
    );
    await Deno.writeTextFile(
      `${packageDir}/package.json`,
      `${JSON.stringify(nativePackageJson(), null, 2)}\n`,
      { createNew: true },
    );
    await Deno.writeTextFile(
      `${packageDir}/buildinfo.json`,
      `${
        JSON.stringify(
          nativeBuildInfo({
            platform,
            addonFile,
            addonSha256,
            addonBytes: addonBytes.length,
            bridgeSourceSha256,
            rustVendorSha256: vendor.archiveSha256,
            rustVendorManifestSha256: vendor.manifestSha256,
          }),
          null,
          2,
        )
      }\n`,
      { createNew: true },
    );
    await verifyToolkitPackage(packageDir, platform, bridgeSourceSha256);
    const files = await hashToolkitPackageFiles(packageDir, platform);
    await Deno.writeTextFile(
      `${staging}/release.json`,
      `${
        JSON.stringify(
          {
            release: TOOLKIT_RELEASE,
            commit: TOOLKIT_COMMIT,
            platform,
            target: triple,
            bridgeSourceSha256,
            sourceArchive: TOOLKIT_SOURCE_ARCHIVE_PATH,
            sourceArchiveBytes: TOOLKIT_SOURCE_ARCHIVE_BYTES,
            sourceArchiveSha256: TOOLKIT_SOURCE_ARCHIVE_SHA256,
            stdlibArchive: TOOLKIT_STDLIB_ARCHIVE_PATH,
            stdlibArchiveBytes: TOOLKIT_STDLIB_ARCHIVE_BYTES,
            stdlibArchiveSha256: TOOLKIT_STDLIB_ARCHIVE_SHA256,
            files,
            rustVendor: {
              archiveSha256: vendor.archiveSha256,
              manifestSha256: vendor.manifestSha256,
            },
            tools: {
              rustc: rustcOutcome.stdout.trim(),
              cargo: cargoOutcome.stdout.trim(),
              node: nodeOutcome.stdout.trim(),
              napiCli: NAPI_CLI_VERSION,
            },
          },
          null,
          2,
        )
      }\n`,
      { createNew: true },
    );
    await Deno.rename(staging, target);
    staging = undefined;
    return await activate(targetName, `${target}/package`);
  } finally {
    if (staging) await Deno.remove(staging, { recursive: true });
    if (buildOutput) await Deno.remove(buildOutput, { recursive: true });
    lock.close();
    await Deno.remove(lockPath);
  }
}

if (import.meta.main) {
  const options: InstallOptions = {};
  for (const arg of Deno.args) {
    if (arg === "--source") options.mode = "source";
    else if (arg.startsWith("--catalog=")) {
      options.catalogPath = arg.slice("--catalog=".length);
    } else if (arg.startsWith("--bundle=")) {
      options.bundlePath = arg.slice("--bundle=".length);
    } else if (arg.startsWith("--source-archive=")) {
      options.sourceArchive = arg.slice("--source-archive=".length);
    } else if (arg.startsWith("--stdlib-archive=")) {
      options.stdlibArchive = arg.slice("--stdlib-archive=".length);
    } else if (arg.startsWith("--toolchains-dir=")) {
      options.toolchainsDirectory = arg.slice("--toolchains-dir=".length);
    } else if (arg.startsWith("--rust-bin-dir=")) {
      options.rustBinDir = arg.slice("--rust-bin-dir=".length);
    } else if (arg.startsWith("--crate-dir=")) {
      options.addonCrateDir = arg.slice("--crate-dir=".length);
    } else throw new Error(`Unknown toolkit setup argument: ${arg}`);
  }
  console.log(
    `SysML toolkit ${TOOLKIT_RELEASE} (native) ready: ${await installToolkit(
      options,
    )}`,
  );
}
