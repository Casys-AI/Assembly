/** Install the verified precompiled semantic index; source builds are explicit.
 * Generated napi JS (including WASI fallback) is never installed.
 * Source and binary hashes describe provenance, not reproducible machine code. */
import { readAssemblyEnv } from "../src/infrastructure/environment.ts";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NAPI_CLI_VERSION,
  RUST_TOOLCHAIN_VERSION,
  TOOLKIT_NATIVE_PLATFORMS,
  type ToolkitNativePlatform,
  toolkitNativePlatform,
} from "../src/adapters/sysml-toolkit-pin.ts";
import {
  semanticLegacyDirectory,
  semanticNativeDirectory,
  writeActiveNativePointer,
} from "../src/infrastructure/native/runtime-location.ts";
import {
  type CommandRunner,
  type NativeDistributionRunner,
  parseRustcVersion,
  type PrepareRustVendor,
  sha256,
} from "./setup-sysml-toolkit.ts";

export const SEMANTIC_INDEX_VERSION = "0.1.0";
export const SEMANTIC_INDEX_ADDON_FILE = "native/ase-semantic-index-napi.node";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_FILE_BYTES = 256 * 1024 * 1024;

async function file(path: string): Promise<Uint8Array> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink || info.size > MAX_FILE_BYTES) {
    throw new Error(`Expected bounded regular file: ${path}`);
  }
  return await Deno.readFile(path);
}
async function directory(path: string): Promise<void> {
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error(`Expected regular directory: ${path}`);
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Includes Cargo.lock before build; missing locks and symlink sources fail. */
export async function semanticIndexSourceFingerprint(
  crateDir: string,
): Promise<string> {
  await directory(crateDir);
  const names = ["Cargo.toml", "Cargo.lock", "build.rs", "package.json"];
  const visit = async (relative: string): Promise<void> => {
    await directory(`${crateDir}/${relative}`);
    for await (const entry of Deno.readDir(`${crateDir}/${relative}`)) {
      const path = `${relative}/${entry.name}`;
      if (entry.isSymlink) throw new Error(`Symlink source refused: ${path}`);
      if (entry.isDirectory) await visit(path);
      else if (entry.isFile) names.push(path);
      else throw new Error(`Special source refused: ${path}`);
    }
  };
  await visit("src");
  const hashes: Record<string, string> = {};
  for (const name of names.sort()) {
    hashes[name] = await sha256(await file(`${crateDir}/${name}`));
  }
  return await sha256(encoder.encode(JSON.stringify(hashes)));
}

export interface SemanticIndexBuildInfo {
  schema: 1;
  name: "ase-semantic-index-napi";
  version: typeof SEMANTIC_INDEX_VERSION;
  platform: ToolkitNativePlatform;
  target: string;
  abi: "napi8";
  rustc: string;
  napiCli: string;
  oxigraph: "0.4.11";
  spargebra: "0.3.5";
  sourceSha256: string;
  addonFile: typeof SEMANTIC_INDEX_ADDON_FILE;
  addonSha256: string;
  addonBytes: number;
  /** Provenance du vendor Cargo commun, en mode source uniquement. */
  rustVendorSha256?: string;
  rustVendorManifestSha256?: string;
}

export async function verifySemanticIndexPackage(
  packageDir: string,
  platform: ToolkitNativePlatform,
  sourceSha256: string,
): Promise<SemanticIndexBuildInfo> {
  await directory(packageDir);
  await directory(`${packageDir}/native`);
  const manifest = JSON.parse(
    decoder.decode(await file(`${packageDir}/package.json`)),
  );
  const info = JSON.parse(
    decoder.decode(await file(`${packageDir}/buildinfo.json`)),
  ) as SemanticIndexBuildInfo;
  const bytes = await file(`${packageDir}/${SEMANTIC_INDEX_ADDON_FILE}`);
  if (
    manifest.name !== "ase-semantic-index-napi" ||
    manifest.version !== SEMANTIC_INDEX_VERSION ||
    info.schema !== 1 || info.name !== manifest.name ||
    info.version !== manifest.version ||
    info.platform !== platform ||
    info.target !== TOOLKIT_NATIVE_PLATFORMS[platform].target ||
    info.abi !== "napi8" || info.rustc !== `rustc ${RUST_TOOLCHAIN_VERSION}` ||
    info.napiCli !== NAPI_CLI_VERSION || info.oxigraph !== "0.4.11" ||
    info.spargebra !== "0.3.5" ||
    info.sourceSha256 !== sourceSha256 ||
    info.addonFile !== SEMANTIC_INDEX_ADDON_FILE ||
    info.addonSha256 !== await sha256(bytes) ||
    info.addonBytes !== bytes.length || bytes.length === 0
  ) {
    throw new Error(
      "Semantic-index package provenance or binary integrity mismatch",
    );
  }
  return info;
}

export interface SemanticIndexInstallOptions {
  toolchainsDirectory?: string;
  /** `precompiled` par défaut ; `source` est le seul chemin de compilation. */
  mode?: "precompiled" | "source";
  catalogPath?: string;
  bundlePath?: string;
  fetcher?: typeof fetch;
  distributionRunner?: NativeDistributionRunner;
  prepareVendor?: PrepareRustVendor;
  addonCrateDir?: string;
  rustBinDir?: string;
  platform?: ToolkitNativePlatform;
  runner?: CommandRunner;
  env?: (name: string) => string | undefined;
}

async function defaultDistributionRunner(
  request: Parameters<NativeDistributionRunner>[0],
): Promise<string> {
  const { installNativeDistribution } = await import(
    "./native-distribution.ts"
  );
  return await installNativeDistribution(request);
}

async function defaultPrepareVendor(
  options: Parameters<PrepareRustVendor>[0],
): Promise<Awaited<ReturnType<PrepareRustVendor>>> {
  const { ensureRustVendor } = await import("./setup-rust-vendor.ts");
  return await ensureRustVendor(options);
}

const defaultRunner: CommandRunner = async (request) => {
  const out = await new Deno.Command(request.program, {
    args: request.args,
    cwd: request.cwd,
    env: request.env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  };
};

/** An existing installation is verified and reused, never silently replaced.
 * Builds run in the caller process; this function creates no detached work. */
export async function installSemanticIndex(
  options: SemanticIndexInstallOptions = {},
): Promise<string> {
  const platform = options.platform ??
    toolkitNativePlatform(Deno.build.os, Deno.build.arch);
  if (!platform) {
    throw new Error(
      `Unsupported semantic-index platform ${Deno.build.os}-${Deno.build.arch}`,
    );
  }
  const readEnv = (name: string) => {
    try {
      return (options.env ?? ((key) => Deno.env.get(key)))(name);
    } catch {
      return undefined;
    }
  };
  const root = resolve(
    options.toolchainsDirectory ??
      fileURLToPath(new URL("../.data/toolchains/", import.meta.url)),
  );
  const crateDir = resolve(
    options.addonCrateDir ??
      fileURLToPath(new URL("../native/semantic-index/", import.meta.url)),
  );
  const mode = options.mode ?? "precompiled";
  if (mode !== "precompiled" && mode !== "source") {
    throw new Error(`Unknown semantic-index installation mode: ${mode}`);
  }
  await Deno.mkdir(root, { recursive: true });
  await directory(root);
  const sourceSha256 = await semanticIndexSourceFingerprint(crateDir);
  const sourcePackage = JSON.parse(
    decoder.decode(await file(`${crateDir}/package.json`)),
  );
  if (
    sourcePackage.name !== "ase-semantic-index-napi" ||
    sourcePackage.version !== SEMANTIC_INDEX_VERSION ||
    sourcePackage.devDependencies?.["@napi-rs/cli"] !== NAPI_CLI_VERSION
  ) throw new Error("Semantic-index npm source pin mismatch");
  const cargoToml = decoder.decode(await file(`${crateDir}/Cargo.toml`));
  if (
    !/oxigraph\s*=\s*\{\s*version\s*=\s*"=0\.4\.11"/.test(cargoToml) ||
    !/spargebra\s*=\s*\{\s*version\s*=\s*"=0\.3\.5"/.test(cargoToml)
  ) throw new Error("Semantic-index Rust source pin mismatch");
  const distributedName = semanticNativeDirectory(platform, sourceSha256);
  const distributedTarget = `${root}/${distributedName}`;
  const sourceName = `${distributedName}-source`;
  const sourceTarget = `${root}/${sourceName}`;
  const targetName = mode === "source" ? sourceName : distributedName;
  const target = `${root}/${targetName}`;
  const legacyName = semanticLegacyDirectory(platform);
  const legacyTarget = `${root}/${legacyName}`;
  const lockPath = `${target}.install.lock`;
  let lock: Deno.FsFile;
  try {
    lock = await Deno.open(lockPath, { createNew: true, write: true });
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      throw new Error(`Semantic-index installation locked: ${lockPath}`);
    }
    throw error;
  }
  let staging: string | undefined;
  try {
    await lock.write(encoder.encode(JSON.stringify({ pid: Deno.pid })));
    const activate = async (
      directoryName: string,
      packageDir: string,
    ): Promise<string> => {
      if (await semanticIndexSourceFingerprint(crateDir) !== sourceSha256) {
        throw new Error("Semantic-index source changed during installation");
      }
      await writeActiveNativePointer(
        root,
        "semantic-index",
        platform,
        directoryName,
      );
      return packageDir;
    };
    const distributionRunner = options.distributionRunner ??
      defaultDistributionRunner;
    const installPrecompiled = async (
      directoryName: string,
      dir: string,
    ): Promise<string> => {
      const packageDir = await distributionRunner({
        runtime: "semantic-index",
        platform,
        sourceSha256,
        toolchainsDirectory: root,
        targetDirectory: dir,
        ...(options.catalogPath ? { catalogPath: options.catalogPath } : {}),
        ...(options.bundlePath ? { bundlePath: options.bundlePath } : {}),
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        env: (key) => readEnv(key),
        verifyPackage: (packageDir) =>
          verifySemanticIndexPackage(packageDir, platform, sourceSha256),
      });
      return await activate(directoryName, packageDir);
    };
    // Les nouvelles cibles exigent leur reçu ; seul le chemin legacy peut
    // utiliser son buildinfo sans reçu. Une distribution reste liée au catalogue.
    const reuseKind = async (
      dir: string,
    ): Promise<"verified" | "distribution"> => {
      await directory(dir);
      let receipt: Record<string, unknown> | undefined;
      try {
        receipt = JSON.parse(
          decoder.decode(await file(`${dir}/release.json`)),
        );
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        if (dir !== legacyTarget) {
          throw new Error(
            `Semantic-index installation receipt is required: ${dir}/release.json`,
            { cause: error },
          );
        }
      }
      if (receipt !== undefined) {
        if (
          receipt === null || typeof receipt !== "object" ||
          Array.isArray(receipt)
        ) {
          throw new Error(
            "Semantic-index installation receipt must be a valid object",
          );
        }
        if ("bundle" in receipt) return "distribution";
        if (
          receipt.schema !== 1 || receipt.runtime !== "semantic-index" ||
          receipt.platform !== platform ||
          receipt.sourceSha256 !== sourceSha256
        ) {
          throw new Error(
            "Semantic-index package provenance or binary integrity mismatch",
          );
        }
      }
      await verifySemanticIndexPackage(
        `${dir}/package`,
        platform,
        sourceSha256,
      );
      return "verified";
    };
    // Le cache source reste utilisable même si son ancien bundle a été retiré
    // du catalogue. Son namespace exige toujours un reçu source vérifiable.
    if (await exists(sourceTarget)) {
      const kind = await reuseKind(sourceTarget);
      if (kind !== "verified") {
        throw new Error(
          `Semantic-index source installation receipt must describe a source build: ${sourceTarget}/release.json`,
        );
      }
      return await activate(sourceName, `${sourceTarget}/package`);
    }
    if (await exists(distributedTarget)) {
      const kind = await reuseKind(distributedTarget);
      if (kind === "verified") {
        // Compatibilité avec les reçus source antérieurs au namespace séparé.
        return await activate(distributedName, `${distributedTarget}/package`);
      }
      if (mode === "precompiled") {
        return await installPrecompiled(distributedName, distributedTarget);
      }
      // En mode source, le bundle est préservé sans consulter sa distribution.
    }
    if (await exists(legacyTarget)) {
      const kind = await reuseKind(legacyTarget).catch(() => undefined);
      if (kind === "verified") {
        return await activate(legacyName, `${legacyTarget}/package`);
      }
      if (kind === "distribution" && mode === "precompiled") {
        return await installPrecompiled(legacyName, legacyTarget);
      }
      // Legacy divergente ou distribuée : conservée, la cible source est distincte.
    }
    if (mode === "precompiled") {
      return await installPrecompiled(distributedName, distributedTarget);
    }
    const runner = options.runner ?? defaultRunner;
    const run = async (
      program: string,
      args: string[],
      env?: Record<string, string>,
    ) => {
      const out = await runner({ program, args, cwd: crateDir, env });
      if (out.code !== 0) {
        throw new Error(
          `Semantic-index command failed: ${program} ${
            args.slice(0, 3).join(" ")
          }: ${(out.stderr || out.stdout).slice(-2000)}`,
        );
      }
      return out.stdout;
    };
    const rustBinDir = options.rustBinDir ??
      readAssemblyEnv("ASSEMBLY_RUST_BIN_DIR", readEnv);
    const cargo = rustBinDir ? `${resolve(rustBinDir)}/cargo` : "cargo";
    const rustc = rustBinDir ? `${resolve(rustBinDir)}/rustc` : "rustc";
    if (
      parseRustcVersion(await run(rustc, ["--version"])) !==
        RUST_TOOLCHAIN_VERSION
    ) {
      throw new Error(
        `Pinned rustc ${RUST_TOOLCHAIN_VERSION} is required; set ASSEMBLY_RUST_BIN_DIR`,
      );
    }
    if (
      !new RegExp(`^cargo ${RUST_TOOLCHAIN_VERSION.replaceAll(".", "\\.")}\\b`)
        .test((await run(cargo, ["--version"])).trim())
    ) throw new Error(`Pinned cargo ${RUST_TOOLCHAIN_VERSION} is required`);
    await run("node", ["--version"]);
    const cacheRoot = `${root}/.semantic-index-native-cache`;
    const env: Record<string, string> = {
      RUSTC: rustc,
      CARGO: cargo,
      ...(rustBinDir
        ? { PATH: `${resolve(rustBinDir)}${delimiter}${readEnv("PATH") ?? ""}` }
        : {}),
      CARGO_HOME: `${cacheRoot}/cargo-home`,
      CARGO_TARGET_DIR: `${cacheRoot}/target`,
      CARGO_TERM_COLOR: "never",
      CARGO_NET_OFFLINE: "true",
      npm_config_cache: `${cacheRoot}/npm`,
    };
    for (
      const path of [env.CARGO_HOME, env.CARGO_TARGET_DIR, env.npm_config_cache]
    ) await Deno.mkdir(path, { recursive: true });
    const npm = [
      "exec",
      "--yes",
      `--package=@napi-rs/cli@${NAPI_CLI_VERSION}`,
      "--",
      "napi",
    ];
    const cli = (await run("npm", [...npm, "--version"], env)).trim();
    if (
      cli !== NAPI_CLI_VERSION && cli !== `@napi-rs/cli ${NAPI_CLI_VERSION}`
    ) throw new Error(`Pinned napi CLI ${NAPI_CLI_VERSION} is required`);
    // Aucun accès registre : le vendor commun vérifié couvre les deux locks.
    const vendor = await (options.prepareVendor ?? defaultPrepareVendor)({
      toolchainsDirectory: root,
      lockfiles: {
        toolkit: resolve(crateDir, "../toolkit/Cargo.lock"),
        "semantic-index": `${crateDir}/Cargo.lock`,
      },
    });
    staging = await Deno.makeTempDir({
      dir: root,
      prefix: ".semantic-index-install-",
    });
    const outputDir = `${staging}/output`;
    await Deno.mkdir(outputDir);
    await run("npm", [
      ...npm,
      "build",
      "--release",
      "--platform",
      "--target",
      TOOLKIT_NATIVE_PLATFORMS[platform].target,
      "--output-dir",
      outputDir,
      "--js",
      "index.js",
      "--dts",
      "index.d.ts",
      "--",
      "--frozen",
      "--config",
      vendor.cargoConfig,
    ], env);
    if (await semanticIndexSourceFingerprint(crateDir) !== sourceSha256) {
      throw new Error("Semantic-index source changed during build");
    }
    const candidates: string[] = [];
    for await (const entry of Deno.readDir(outputDir)) {
      if (entry.name.endsWith(".node")) candidates.push(entry.name);
    }
    if (
      candidates.length !== 1 ||
      candidates[0] !== `ase-semantic-index-napi.${platform}.node`
    ) {
      throw new Error(
        "Semantic-index build must produce exactly one fresh .node addon for the requested platform",
      );
    }
    const bytes = await file(`${outputDir}/${candidates[0]}`);
    if (!bytes.length) {
      throw new Error("Semantic-index build produced an empty addon");
    }
    const packageDir = `${staging}/package`;
    await Deno.mkdir(`${packageDir}/native`, { recursive: true });
    await Deno.writeFile(`${packageDir}/${SEMANTIC_INDEX_ADDON_FILE}`, bytes);
    await Deno.writeTextFile(
      `${packageDir}/package.json`,
      JSON.stringify(
        {
          name: "ase-semantic-index-napi",
          version: SEMANTIC_INDEX_VERSION,
          private: true,
          license: "MIT",
        },
        null,
        2,
      ) + "\n",
    );
    const info: SemanticIndexBuildInfo = {
      schema: 1,
      name: "ase-semantic-index-napi",
      version: SEMANTIC_INDEX_VERSION,
      platform,
      target: TOOLKIT_NATIVE_PLATFORMS[platform].target,
      abi: "napi8",
      rustc: `rustc ${RUST_TOOLCHAIN_VERSION}`,
      napiCli: NAPI_CLI_VERSION,
      oxigraph: "0.4.11",
      spargebra: "0.3.5",
      sourceSha256,
      addonFile: SEMANTIC_INDEX_ADDON_FILE,
      addonSha256: await sha256(bytes),
      addonBytes: bytes.length,
      rustVendorSha256: vendor.archiveSha256,
      rustVendorManifestSha256: vendor.manifestSha256,
    };
    await Deno.writeTextFile(
      `${packageDir}/buildinfo.json`,
      JSON.stringify(info, null, 2) + "\n",
    );
    await verifySemanticIndexPackage(packageDir, platform, sourceSha256);
    // Rename only after full verification. The generated output directory is
    // excluded, so fallback JS cannot enter the installed distribution.
    const installDir = `${staging}/install`;
    await Deno.mkdir(installDir);
    await Deno.rename(packageDir, `${installDir}/package`);
    await Deno.writeTextFile(
      `${installDir}/release.json`,
      JSON.stringify(
        {
          schema: 1,
          runtime: "semantic-index",
          platform,
          sourceSha256,
          rustVendor: {
            archiveSha256: vendor.archiveSha256,
            manifestSha256: vendor.manifestSha256,
          },
        },
        null,
        2,
      ) + "\n",
      { createNew: true },
    );
    await Deno.rename(installDir, target);
    return await activate(targetName, `${target}/package`);
  } finally {
    if (staging) {
      await Deno.remove(staging, { recursive: true }).catch(() => {});
    }
    lock.close();
    await Deno.remove(lockPath);
  }
}

if (import.meta.main) {
  const options: SemanticIndexInstallOptions = {};
  for (const arg of Deno.args) {
    if (arg === "--source") options.mode = "source";
    else if (arg.startsWith("--catalog=")) {
      options.catalogPath = arg.slice("--catalog=".length);
    } else if (arg.startsWith("--bundle=")) {
      options.bundlePath = arg.slice("--bundle=".length);
    } else if (arg.startsWith("--toolchains-dir=")) {
      options.toolchainsDirectory = arg.slice("--toolchains-dir=".length);
    } else if (arg.startsWith("--rust-bin-dir=")) {
      options.rustBinDir = arg.slice("--rust-bin-dir=".length);
    } else if (arg.startsWith("--crate-dir=")) {
      options.addonCrateDir = arg.slice("--crate-dir=".length);
    } else throw new Error(`Unknown semantic-index setup argument: ${arg}`);
  }
  console.log(await installSemanticIndex(options));
}
