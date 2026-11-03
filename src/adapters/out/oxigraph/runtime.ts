import { isSha256Hex } from "../../../domain/primitives/execution-digest.ts";
import { sha256Bytes } from "../../../domain/primitives/sha256-bytes.ts";
/** Runtime composition for the installed native semantic index. Verification
 * reads bytes only; the N-API module is loaded lazily in the child process. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DenoChildProcessRequester,
  OxigraphNativeIndex,
  ProcessSemanticIndexExecutor,
} from "./oxigraph.ts";
import {
  NAPI_CLI_VERSION,
  RUST_TOOLCHAIN_VERSION,
  TOOLKIT_NATIVE_PLATFORMS,
  type ToolkitNativePlatform,
  toolkitNativePlatform,
} from "../../sysml-toolkit-pin.ts";
import {
  resolveActiveNativePackageDirSync,
  semanticLegacyDirectory,
} from "../../../infrastructure/native/runtime-location.ts";

export const SEMANTIC_RUNTIME_VERSION = "0.1.0" as const;
export const SEMANTIC_OXIGRAPH_VERSION = "0.4.11" as const;
export const SEMANTIC_SPARGEBRA_VERSION = "0.3.5" as const;
const ADDON = "native/ase-semantic-index-napi.node";
const NAME = "ase-semantic-index-napi";
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

async function digest(bytes: Uint8Array): Promise<string> {
  return await sha256Bytes(Uint8Array.from(bytes));
}
async function directory(path: string): Promise<void> {
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error(`Expected regular directory: ${path}`);
  }
}
async function file(path: string, limit: number): Promise<Uint8Array> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink || info.size > limit) {
    throw new Error(`Expected bounded regular file: ${path}`);
  }
  const bytes = await Deno.readFile(path);
  if (bytes.length > limit) throw new Error(`File exceeds limit: ${path}`);
  return bytes;
}

export interface NativeSemanticIndexProvenance {
  version: typeof SEMANTIC_RUNTIME_VERSION;
  oxigraph: typeof SEMANTIC_OXIGRAPH_VERSION;
  sourceDigest: string;
  digest: string;
  platform: ToolkitNativePlatform;
}
export interface NativeSemanticIndexRuntime {
  native: OxigraphNativeIndex;
  close(): Promise<void>;
  provenance: NativeSemanticIndexProvenance;
  packageDirectory: string;
}

export async function openNativeSemanticIndex(
  options: {
    packageDirectory?: string;
    /** Chosen by host composition; reference requests cannot choose a store. */
    buildCachePath?: string;
  } = {},
): Promise<NativeSemanticIndexRuntime> {
  const platform = toolkitNativePlatform(Deno.build.os, Deno.build.arch);
  if (!platform) {
    throw new Error(
      `Unsupported semantic-index platform: ${Deno.build.os}-${Deno.build.arch}`,
    );
  }
  const packageDirectory = resolve(
    options.packageDirectory ?? resolveActiveNativePackageDirSync({
      toolchainsDirectory: fileURLToPath(
        new URL("../../../../.data/toolchains/", import.meta.url),
      ),
      runtime: "semantic-index",
      platform,
      legacyPackageDir: fileURLToPath(
        new URL(
          `../../../../.data/toolchains/${
            semanticLegacyDirectory(platform)
          }/package/`,
          import.meta.url,
        ),
      ),
    }),
  );
  try {
    await directory(packageDirectory);
    await directory(`${packageDirectory}/native`);
    const manifestBytes = await file(
      `${packageDirectory}/package.json`,
      1024 * 1024,
    );
    const buildBytes = await file(
      `${packageDirectory}/buildinfo.json`,
      1024 * 1024,
    );
    const manifest = JSON.parse(decoder.decode(manifestBytes));
    const build = JSON.parse(decoder.decode(buildBytes));
    const addonBytes = await file(
      `${packageDirectory}/${ADDON}`,
      256 * 1024 * 1024,
    );
    const addonSha256 = await digest(addonBytes);
    if (
      manifest?.name !== NAME ||
      manifest?.version !== SEMANTIC_RUNTIME_VERSION ||
      build?.schema !== 1 || build?.name !== NAME ||
      build?.version !== SEMANTIC_RUNTIME_VERSION ||
      build?.platform !== platform ||
      build?.target !== TOOLKIT_NATIVE_PLATFORMS[platform].target ||
      build?.abi !== "napi8" ||
      build?.rustc !== `rustc ${RUST_TOOLCHAIN_VERSION}` ||
      build?.napiCli !== NAPI_CLI_VERSION ||
      build?.oxigraph !== SEMANTIC_OXIGRAPH_VERSION ||
      build?.spargebra !== SEMANTIC_SPARGEBRA_VERSION ||
      !isSha256Hex(build?.sourceSha256) ||
      build?.addonFile !== ADDON || build?.addonSha256 !== addonSha256 ||
      build?.addonBytes !== addonBytes.length || addonBytes.length === 0
    ) {
      throw new Error(
        "Semantic-index package provenance or binary integrity mismatch",
      );
    }
    const provenance: NativeSemanticIndexProvenance = {
      version: SEMANTIC_RUNTIME_VERSION,
      oxigraph: SEMANTIC_OXIGRAPH_VERSION,
      sourceDigest: build.sourceSha256,
      digest: await digest(encoder.encode(JSON.stringify({
        "package.json": await digest(manifestBytes),
        "buildinfo.json": await digest(buildBytes),
        [ADDON]: addonSha256,
      }))),
      platform,
    };
    const requester = new DenoChildProcessRequester({
      addonPath: `${packageDirectory}/${ADDON}`,
      expectedAddonSha256: addonSha256,
      buildCachePath: options.buildCachePath,
    });
    const native = new OxigraphNativeIndex(
      new ProcessSemanticIndexExecutor(requester),
    );
    return {
      native,
      close: () => native.close(),
      provenance,
      packageDirectory,
    };
  } catch (error) {
    throw new Error(
      `Cannot open native semantic index at ${packageDirectory}: ${
        error instanceof Error ? error.message : String(error)
      }. Run deno run -A tools/setup-semantic-index.ts from the repository root; preserve or move an invalid existing installation before rebuilding.`,
      { cause: error },
    );
  }
}
