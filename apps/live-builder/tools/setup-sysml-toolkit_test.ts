import assert from "node:assert/strict";
import {
  nativeBuildInfo,
  nativePackageJson,
  parseRustcVersion,
  readToolkitTar,
} from "./setup-sysml-toolkit.ts";
import {
  NAPI_CLI_VERSION,
  RUST_TOOLCHAIN_VERSION,
  TOOLKIT_COMMIT,
  TOOLKIT_SOURCE_ARCHIVE_BYTES,
  TOOLKIT_SOURCE_ARCHIVE_SHA256,
  TOOLKIT_STDLIB_ARCHIVE_BYTES,
  TOOLKIT_STDLIB_ARCHIVE_SHA256,
} from "../src/adapters/sysml-toolkit-pin.ts";

/** Minimal USTAR fixtures exercise extraction boundaries without filesystem access. */
function archive(
  entries: Array<{
    path: string;
    text?: string;
    type?: string;
    link?: string;
    size?: number;
  }>,
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    const text = encoder.encode(entry.text ?? "");
    const field = (offset: number, value: string) =>
      header.set(encoder.encode(value), offset);
    field(0, entry.path);
    field(
      124,
      (entry.size ?? text.length).toString(8).padStart(11, "0") + "\0",
    );
    header.fill(32, 148, 156);
    field(156, entry.type ?? "0");
    field(157, entry.link ?? "");
    field(257, "ustar\0");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    field(148, checksum.toString(8).padStart(6, "0") + "\0 ");
    chunks.push(header);
    const body = new Uint8Array(Math.ceil(text.length / 512) * 512);
    body.set(text);
    chunks.push(body);
  }
  chunks.push(new Uint8Array(1024));
  const result = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

Deno.test("toolkit TAR reads root-relative files and directories without altering bytes", () => {
  const entries = readToolkitTar(archive([
    { path: "crates/", type: "5" },
    { path: "Cargo.toml", text: "[workspace]\n" },
    { path: "stdlib/manifest.json", text: '{"units":96}' },
  ]));
  assert.equal(entries[0].directory, true);
  assert.equal(entries[1].path, "Cargo.toml");
  assert.equal(new TextDecoder().decode(entries[1].bytes), "[workspace]\n");
  assert.equal(entries[2].path, "stdlib/manifest.json");
});

Deno.test("toolkit TAR refuses traversal, absolute paths, aliases and duplicate files", () => {
  for (
    const path of [
      "../escape",
      "crates/../escape",
      "/absolute/file",
      "crates/./file",
      "crates//file",
      "crates\\file",
    ]
  ) {
    assert.throws(() => readToolkitTar(archive([{ path }])), /path/);
  }
  assert.throws(() =>
    readToolkitTar(archive([
      { path: "Cargo.toml" },
      { path: "Cargo.toml" },
    ])), /duplicate/);
});

Deno.test("toolkit TAR refuses links, extension headers and special entries", () => {
  for (const type of ["1", "2", "3", "4", "6", "x", "g", "L"]) {
    assert.throws(() =>
      readToolkitTar(archive([
        { path: "Cargo.toml", type, link: "../../elsewhere" },
      ])), /links and special/);
  }
});

Deno.test("toolkit TAR refuses corrupt headers, truncated files and trailing entries", () => {
  const corrupt = archive([{ path: "Cargo.toml", text: "valid" }]);
  corrupt[0] ^= 1;
  assert.throws(() => readToolkitTar(corrupt), /checksum/);
  assert.throws(() =>
    readToolkitTar(archive([
      { path: "Cargo.toml", text: "short", size: 8192 },
    ])), /Truncated/);
  const trailing = archive([]);
  trailing[512] = 1;
  assert.throws(() => readToolkitTar(trailing), /after toolkit TAR end/);
  assert.throws(() => readToolkitTar(new Uint8Array(511)), /length/);
  assert.throws(
    () =>
      readToolkitTar(
        archive([{ path: "a" }, { path: "b" }]),
        { maxEntries: 1 },
      ),
    /Too many/,
  );
});

Deno.test("rustc version parsing accepts only the pinned release shape", () => {
  assert.equal(
    parseRustcVersion("rustc 1.98.1 (48a229cea 2026-09-01)"),
    "1.98.1",
  );
  assert.equal(
    parseRustcVersion("rustc 1.98.1 (48a229cea 2026-09-01)"),
    RUST_TOOLCHAIN_VERSION,
  );
  assert.equal(parseRustcVersion("cargo 1.98.1"), undefined);
  assert.equal(parseRustcVersion("garbage"), undefined);
  for (const suffix of ["-nightly", "-dev", "-beta.1", "+custom"]) {
    assert.equal(parseRustcVersion(`rustc 1.98.1${suffix} (fake)`), undefined);
  }
  assert.equal(parseRustcVersion("rustc 1.98.1"), RUST_TOOLCHAIN_VERSION);
  assert.notEqual(
    parseRustcVersion("rustc 1.96.1 (homebrew)"),
    RUST_TOOLCHAIN_VERSION,
  );
});

Deno.test("installed manifests are deterministic and carry the real pin", () => {
  const manifest = nativePackageJson();
  assert.equal(manifest.name, "ase-sysml-toolkit-native");
  assert.equal(manifest.version, "0.10.10+ase.2");
  assert.equal(manifest.toolkitCommit, TOOLKIT_COMMIT);
  const build = nativeBuildInfo({
    platform: "darwin-arm64",
    addonFile: "ase-toolkit-napi.darwin-arm64.node",
    addonSha256: "a".repeat(64),
    addonBytes: 123,
    bridgeSourceSha256: "b".repeat(64),
  });
  assert.equal(build.target, "aarch64-apple-darwin");
  assert.equal(build.abi, "napi8");
  assert.equal(build.bridgeSourceSha256, "b".repeat(64));
  assert.equal(build.rustc, `rustc ${RUST_TOOLCHAIN_VERSION}`);
  assert.equal(build.napiCli, NAPI_CLI_VERSION);
  assert.equal(build.sourceArchiveSha256, TOOLKIT_SOURCE_ARCHIVE_SHA256);
  assert.equal(build.stdlibArchiveSha256, TOOLKIT_STDLIB_ARCHIVE_SHA256);
  // No timestamp or host path leaks into the fingerprinted build identity.
  assert.equal(
    Object.keys(build).some((key) => /at$|path|dir/i.test(key)),
    false,
  );
  assert.equal(TOOLKIT_SOURCE_ARCHIVE_BYTES > 0, true);
  assert.equal(TOOLKIT_STDLIB_ARCHIVE_BYTES > 0, true);
});
