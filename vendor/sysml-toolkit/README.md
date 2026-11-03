# SysML Toolkit patched for Assembly — native distribution

This directory preserves the provenance of the local **0.10.10+ase.2** build
used by Assembly. It is not an official Open-MBEE release. The active
installation is now **native (N-API)**: the `native/toolkit` addon is built from
the exact sources below and installed with the pinned standard library. No WASM
artifact is vendored, installed or loaded by the active paths. The official
0.10.10 installation remains distinct.

The patch addresses
[upstream issue #13](https://github.com/Open-MBEE/sysml-toolkit/issues/13):

- conditional transitions with an implicit source receive a semantic Membership
  to the previous eligible occurrence, also used by their internal succession;
  explicit sources are not replaced;
- the action graph represents `TransitionUsage` elements with their identities
  and guards; PlantUML uses the same semantic source.

The implicit-source correction does not rewrite the compact model or the SysML
text. Source lookup respects the existing computation bounds. The previous
behavior of explicitly chained sources is preserved. The distribution also
corrects reconstruction of `else` branches during the
`toCompactJson`/`toFullJson` → `Session.fromInterchangeJson` round trip (see the
repository history for the detailed dated evidence).

## Contents

- `sysml-toolkit-source-0.10.10+ase.2.tgz`: complete, exact source tree of
  `8b541ae`, in Git archive format (the `spec-refs/SysML-v2-Release` and
  `spec-refs/apollo-11-sysml-v2` submodule directories are empty, as in a Git
  archive; building the addon's native crates does not require their corpora).
  Workspace crates not used by the addon, including the historical WASM wrapper,
  remain inert source code.
- `sysml-toolkit-stdlib-0.10.10+ase.2.tgz`: pinned standard library (`stdlib/`)
  and licenses/notices, with bytes identical to the reviewed distribution.
- `source.bundle` and the four `.patch` files: reviewed patch provenance (the
  bundle requires the upstream base below).
- `manifest.json`: digests of the two archives, addon identity, declared
  platforms and a record of the removed WASM archive.

## Provenance

- Upstream base: `339ef0e073d06e553e81c079755ddfcd224e4b92` (v0.10.10).
- Transition patch: `f63b234e72fc634232e24c46a89487df442954f3`.
- JSON round-trip patch: `c465376482489b9ac5098c7d663e20238061da93`.
- Identified local build: `8b541ae04beedde6f28f4a3966f8acd039584327`.

## Rebuild and install

The supported path is the setup task, which verifies both archives, extracts the
sources to `.data/toolchains/sysml-toolkit-source-0.10.10+ase.2`, builds the
addon with exact Rust **1.98.1** and `@napi-rs/cli` **3.10.9** (private caches
and targets under `.data/toolchains/`), and then installs the native package
under `.data/toolchains/sysml-toolkit-native-v0.10.10+ase.2/package`:

```sh
deno task model:toolkit:setup
export SYSML_TOOLKIT_DIR=$PWD/.data/toolchains/sysml-toolkit-native-v0.10.10+ase.2/package
```

`ASE_RUST_BIN_DIR` may point to the pinned toolchain's `bin` directory if
`cargo`/`rustc` on PATH are not at 1.98.1; any other version is explicitly
rejected. Declared platforms: `darwin-arm64`, `darwin-x64`, `linux-x64-gnu`,
`linux-arm64-gnu`; an undeclared platform fails without fallback. The
napi-generated loader (`index.js`, which contains a WASI fallback) is neither
installed nor imported: only the pinned `.node` file is loaded, after its bytes
have been verified. Rebuilds are not promised to be byte-for-byte identical; the
digest actually loaded is checked at startup and passed to the compilation
recipe.

## WASM history

The `sysml-wasm-0.10.10+ase.2.tgz` archive (digests in `manifest.json`) was
removed from the active distribution. Its bytes and the compiled artifacts it
produced remain **historical data**: they are kept outside the product path,
read from their verified bytes, and their hashes are neither changed nor
reinterpreted under the native recipe.
