# Enable local SysML tools

SysML Toolkit compiles the current model and prepares targeted changes. Sources
and revisions are retained in Git.

## Install the pinned bundle

From `apps/live-builder`, with Deno 2.9.7, run:

```sh
deno task model:toolkit:setup
```

The command installs the precompiled bundle authorized for the platform and
current sources, without Rust or npm. Private Releases require a `GITHUB_TOKEN`
or `GH_TOKEN` with read access. The tracked catalog authorizes the archive and
every file before installation. The catalog is currently empty until the first
explicit publication: an absent target fails without implicit compilation.

To install now, use the explicit source path with Rust **1.98.1**, Node and npm:

```sh
deno task model:toolkit:setup:source
```

`ASSEMBLY_RUST_BIN_DIR` selects the pinned Rust binaries. The shared
`vendor/rust/` archive supplies crates for both locks: Cargo uses `--frozen`
offline; npm may fetch the pinned N-API CLI. Toolkit and library archives remain
under `vendor/sysml-toolkit/`.

The `package` path returned by setup contains the `.node`, provenance manifests,
standard library and licenses. An active pointer under `.data/toolchains/`
selects it. New installations include the platform and source fingerprint in
their path; old installations are retained. The loader opens the binary
directly, without a WASI fallback. Setup starts no service.

A second run verifies installed files and N-API bridge sources without building
or extracting sources. A divergent package at the expected destination is
refused and retained; an installation with another fingerprint stays beside the
new package. Move an installation used by a server only after stopping that
server. Existing data and Git revisions are preserved.

For an authorized local bundle, individual scripts accept `--catalog=` and
`--bundle=`. Setup for both runtimes takes separate `--toolkit-bundle=` and
`--semantic-bundle=` options. Source-mode options include `--source-archive=`,
`--stdlib-archive=`, `--toolchains-dir=` and `--rust-bin-dir=`. Archives must
retain the exact digests in their tracked manifest. The script does not select
another Toolkit version.

## Recover when a bundle leaves the catalog

If a previously installed bundle is removed from the catalog, or its authorized
entry changes, explicitly rebuild from source. From `apps/live-builder`, run:

```sh
deno task setup:source
```

This recovers both Toolkit and the semantic index without needing the old
Release entry or a GitHub token. Rust 1.98.1 and Node/npm are needed only when
there is no reusable source build; Cargo still uses the verified local vendor.
For Toolkit alone, use `deno task model:toolkit:setup:source`.

The source build uses a separate fingerprinted directory ending in `-source`.
The distributed package stays untouched. After successful verification, setup
selects the source package through its active pointer. Repeating source setup,
or running default setup afterward, reuses that verified source cache without
compiling or consulting the distribution catalog. A corrupt source cache is
refused and preserved rather than overwritten.

## Select an installation

The provider is installed and selected by default. To use the pinned native
package installed elsewhere, supply its `package` directory:

```sh
SYSML_TOOLKIT_DIR=/path/returned/by/setup/package deno task serve
```

The native binary, manifests and library must come from the same build. The
addon is platform dependent: local qualification covers macOS ARM64; the other
declared targets require their own builds and tests.

## Resolve a startup refusal

Toolkit is mandatory. Before opening the model or session store, the server
checks for `package.json` in the selected directory. If this package is missing,
it prints `TOOLKIT_REQUIRED`, the affected path and the recovery command, then
stops with exit code `2`.

Install from source with `deno task model:toolkit:setup:source` while the
catalog is empty (use `deno task model:toolkit:setup` after publication), or
correct `SYSML_TOOLKIT_DIR` to point to its `package` directory, then restart
the server. There is no degraded mode without Toolkit. The package's presence
does not by itself guarantee that all its files are valid: retain the
installation digest check described above.

## Have an operator prepare a change

Ask the operator to inspect the affected elements and their sources, then
propose a precise change against the version it read. For example:

> Find the affected attribute, check its declaration and prepare a proposal to
> change its value, preserving the other members.

Targeted edits produce new sources for the existing proposal workflow. The
operator can use `model.query` to read the model and `propose_sysml_edit` to
prepare an assignment, rename, member insertion or removal. The host checks the
base and affected sources; SysML Toolkit compiles and checks the proposal before
making it available for review. Then follow the guide to
[propose, compare and adopt a revision](../evolution/reviser-systeme.md).

The tools are internal to the application. Enabling them adds no MCP server and
does not change version storage. The provider's scope and limits are described
in the [local tools reference](../../reference/modeles/toolkit-local.md).
