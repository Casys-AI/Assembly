/** Pure native distribution pin shared by installation and runtime selection.
 *
 * The Toolkit identity is unchanged (reviewed local build 0.10.10+ase.2 from
 * exact sources 8b541ae over upstream 339ef0e). Only the transport changed:
 * the active distribution is now the N-API addon built from those same
 * sources, plus the byte-identical pinned standard library. No WASM artifact
 * is part of the active pin; historical WASM bytes stay conserved as data
 * outside this product path (build retention owns them).
 */
export const TOOLKIT_RELEASE = "0.10.10+ase.2";
export const TOOLKIT_UPSTREAM_COMMIT =
  "339ef0e073d06e553e81c079755ddfcd224e4b92";
export const TOOLKIT_COMMIT = "8b541ae04beedde6f28f4a3966f8acd039584327";

/** Name written in the installed native package.json by the setup. */
export const TOOLKIT_PACKAGE_NAME = "ase-sysml-toolkit-native";
/** napi binaryName of the addon crate (native/toolkit/package.json). */
export const TOOLKIT_ADDON_NAME = "ase-toolkit-napi";
/** N-API feature level the addon is compiled against (Cargo features). */
export const TOOLKIT_NAPI_ABI = "napi8";

/** Pinned build tools. An env override may locate a toolchain, never re-version it. */
export const RUST_TOOLCHAIN_VERSION = "1.98.1";
export const NAPI_CLI_VERSION = "3.10.9";

/** Complete exact source tree 8b541ae (git-archive witness; submodules empty,
 * as in a git archive — building the addon crates does not need their corpora).
 * Unused workspace crates (including the WASM wrapper crate) stay inert
 * sources; the addon depends only on the native transform/model/syntax/viz/
 * lsp/parser/cbor crates. */
export const TOOLKIT_SOURCE_ARCHIVE_SHA256 =
  "8e890d8346656a4dbd50065d657779c40c7f13750ba5e9a09b4779a0dfa61e7c";
export const TOOLKIT_SOURCE_ARCHIVE_BYTES = 3721322;
export const TOOLKIT_SOURCE_ARCHIVE_PATH =
  `vendor/sysml-toolkit/sysml-toolkit-source-${TOOLKIT_RELEASE}.tgz`;
export const TOOLKIT_BUNDLED_SOURCE_ARCHIVE = new URL(
  `../../${TOOLKIT_SOURCE_ARCHIVE_PATH}`,
  import.meta.url,
);
/** Spot-checked extracted files; the archive hash above covers every byte. */
export const TOOLKIT_SOURCE_SPOT_FILES: Readonly<Record<string, string>> = {
  "Cargo.toml":
    "9466e7e2e8ace111450a8384b701dc77111fc5307c365481a2657c19229f6f0f",
  "Cargo.lock":
    "c815cb6e3f16fd4e07c5a6bd25728348a52441ca2345c2dd98e61eb323b5e09b",
};

/** Pinned standard library + licences, byte-identical to the reviewed build. */
export const TOOLKIT_STDLIB_ARCHIVE_SHA256 =
  "46394459346976cd8f64bdf654f80ae2e23fbac818f1235a97e8f8736b037ff6";
export const TOOLKIT_STDLIB_ARCHIVE_BYTES = 11919639;
export const TOOLKIT_STDLIB_ARCHIVE_PATH =
  `vendor/sysml-toolkit/sysml-toolkit-stdlib-${TOOLKIT_RELEASE}.tgz`;
export const TOOLKIT_BUNDLED_STDLIB_ARCHIVE = new URL(
  `../../${TOOLKIT_STDLIB_ARCHIVE_PATH}`,
  import.meta.url,
);
export const TOOLKIT_STDLIB_FILES: Readonly<Record<string, string>> = {
  "stdlib/manifest.json":
    "4363dcb41c3286daa4359c2c834742f1c34dadb983870b2d1cabba496079b3fa",
  "stdlib/sysml-library.json.gz":
    "04cbfb6549c7cd7ff2cc23f4ed0d6b9126c6a5ecab71a068b0fb87c6f94413bf",
  "stdlib/sysml-library.libcache.gz":
    "83def0ef6846631048d1707798951c02435f7e2ef403b5361b6b132b35909768",
  "stdlib/sysml-library.prepared.gz":
    "4d728d5796b5eb14d882bb827d773a59c07c8469c6bd4a41de3d09a607bc1c1a",
};
export const TOOLKIT_LICENSE_FILES: Readonly<Record<string, string>> = {
  "LICENSE": "c741fcb705b7f3f80058e69560b8ec5a8ba4b1ab9fab255044ddf2b48ae6b800",
  "LICENSE-EPL-2.0":
    "0becf16567beb77fa252b7664631dd177c8f9a1889e48995b45379c7130e5303",
  "THIRD-PARTY-NOTICES.md":
    "76e86cfa333e4cb2bc41d15b4db81bc5a669445394ac5be06e6829ce1daeeea0",
};

/** Declared platforms: Rust target triple and installed addon file name.
 * N-API `--platform` naming: `<binaryName>.<platform>.node`. An undeclared
 * platform fails explicitly; there is no fallback loader. */
export const TOOLKIT_NATIVE_PLATFORMS = {
  "darwin-arm64": {
    target: "aarch64-apple-darwin",
    addonFile: `${TOOLKIT_ADDON_NAME}.darwin-arm64.node`,
  },
  "darwin-x64": {
    target: "x86_64-apple-darwin",
    addonFile: `${TOOLKIT_ADDON_NAME}.darwin-x64.node`,
  },
  "linux-x64-gnu": {
    target: "x86_64-unknown-linux-gnu",
    addonFile: `${TOOLKIT_ADDON_NAME}.linux-x64-gnu.node`,
  },
  "linux-arm64-gnu": {
    target: "aarch64-unknown-linux-gnu",
    addonFile: `${TOOLKIT_ADDON_NAME}.linux-arm64-gnu.node`,
  },
} as const;
export type ToolkitNativePlatform = keyof typeof TOOLKIT_NATIVE_PLATFORMS;

/** Map Deno host facts to a declared platform, or undefined when undeclared. */
export function toolkitNativePlatform(
  os: string,
  arch: string,
): ToolkitNativePlatform | undefined {
  if (os === "darwin" && arch === "aarch64") return "darwin-arm64";
  if (os === "darwin" && arch === "x86_64") return "darwin-x64";
  if (os === "linux" && arch === "x86_64") return "linux-x64-gnu";
  if (os === "linux" && arch === "aarch64") return "linux-arm64-gnu";
  return undefined;
}

/** Package-relative path of the addon binary for a declared platform. */
export function toolkitAddonPath(platform: ToolkitNativePlatform): string {
  return `native/${TOOLKIT_NATIVE_PLATFORMS[platform].addonFile}`;
}

export const TOOLKIT_DIRECTORY = `sysml-toolkit-native-v${TOOLKIT_RELEASE}`;
/** Exact source checkout the addon Cargo.toml references by relative path. */
export const TOOLKIT_SOURCE_DIRECTORY =
  `sysml-toolkit-source-${TOOLKIT_RELEASE}`;
export const TOOLKIT_DEFAULT_PACKAGE = new URL(
  `../../.data/toolchains/${TOOLKIT_DIRECTORY}/package`,
  import.meta.url,
);
