# Local SysML tools

SysML Toolkit is the provider for internal model tools. It loads a version’s
sources into a local Rust session through N-API to query them, describe an
element and prepare targeted changes. The application port separates these
operations from compilation, publication and execution.

## Configuration

| Option              | Default                                  | Effect                                                  |
| ------------------- | ---------------------------------------- | ------------------------------------------------------- |
| `SYSML_TOOLKIT_DIR` | Active package under `.data/toolchains/` | `package` directory containing the SDK and its library. |

The default path is resolved from the application code. An active pointer
selects the verified platform package; without it, the historical
`sysml-toolkit-native-v0.10.10+ase.2/package` path remains the fallback. The
[activation guide](../../how-to/modeles/activer-toolkit-local.md) uses
`apps/live-builder` as the working directory for installation commands.

Toolkit provides compilation for the admission workflow and the model tools. Git
stores sources and versions. The Assembly engine interprets the admitted
contract.

## Installed bundle

The `ase-sysml-toolkit-native` package uses the patched Toolkit `0.10.10+ase.2`,
revision `8b541ae04beedde6f28f4a3966f8acd039584327`. The source and library
archives, their sizes, SHA-256 hashes and licences are listed in the
[distribution manifest](../../../vendor/sysml-toolkit/manifest.json). The seven
library/licence files retain the same pinned bytes.

The active package contains `native/<platform addon>.node`, `package.json`,
`buildinfo.json`, licences and files under `stdlib/`. It contains no WASM
runtime. `release.json`, beside the package, records the installed files’
hashes. `buildinfo.json` also records tool versions, upstream archives and the
N-API bridge source digest. The bundle fingerprint covers the bytes actually
loaded, rather than a version name alone.

## Installation contract

`deno task setup` from the repository root installs both precompiled native
runtimes by default. Git and Deno 2.9.7 suffice; it runs no Rust or npm command.
The tracked `vendor/native-runtimes/catalog.json` binds each archive to its
platform, bridge sources and SHA-256 hashes of all files. The catalog authorizes
bytes before extraction; bundle-supplied checksums alone do not establish
provenance.

Private Releases require a `GITHUB_TOKEN` or `GH_TOKEN` with read access.
Transport uses the authenticated GitHub API; tokens are never sent to arbitrary
URLs. Denied access, a missing catalog or a target without a bundle produces an
actionable error without an implicit build. The catalog is currently empty: the
first publication has not happened. A local archive can be supplied for a trial
but must still be authorized by the selected catalog.

Use explicit source mode, `deno task setup:source`, to install now. It builds
the bridges in `native/toolkit` and `native/semantic-index` with Rust 1.98.1 and
`@napi-rs/cli` 3.10.9. Node/npm are required; npm may fetch the pinned CLI.
`ASSEMBLY_RUST_BIN_DIR` selects Rust binaries without changing the required
version. Toolkit and library source archives remain under
`vendor/sysml-toolkit/`.

Source builds have their own fingerprinted installation directory, with a
`-source` suffix. Both installers can therefore recover from a removed or
changed catalog entry without reauthorizing or replacing the old distributed
package. Source mode does not call the distribution installer for this recovery.
Only a successfully verified source build updates the active pointer. That
source cache is then reusable by source and default setup without compilation or
catalog access; an invalid cache remains an explicit refusal. See the
[source recovery steps](../../how-to/modeles/activer-toolkit-local.md#recover-when-a-bundle-leaves-the-catalog).

`vendor/rust/` contains a shared deterministic archive of the 117 registry
crates in both `Cargo.lock` files, their manifest and Cargo checksums. The
installer checks the locks and archive before extraction, then every vendored
file. Cargo configuration replaces crates.io with this tree and enforces offline
mode; builds use `--frozen`. A changed crate or divergent lock is refused.
Extracted sources and build targets are separate. Their fingerprints appear in
provenance; this does not guarantee byte-for-byte reproducible binaries.

The installer takes a lock and verifies the package and its receipt. It reuses a
valid installation without building or extracting sources. New installations
include the platform and source fingerprint; incompatible old installations are
retained. A divergent package at the expected destination is an explicit refusal
naming the path to examine, without overwriting it. A new installation is
assembled and verified in a sibling directory, then published by renaming it.
The active pointer changes only after successful verification. The loader opens
the `.node` directly without importing the JavaScript loader generated by
napi-rs.

Global setup accepts `--source`, `--catalog=`, `--toolkit-bundle=`,
`--semantic-bundle=` and `--toolchains-dir=`. Individual scripts accept
`--bundle=` for their own archive. Individual source mode also accepts
`--source-archive=`, `--stdlib-archive=`, `--rust-bin-dir=` and `--crate-dir=`.
Archive copies must match the pin exactly. See the
[local guide](../../how-to/modeles/activer-toolkit-local.md) for commands.

## Prepare a distribution

From `apps/live-builder`, after verified source setup, use the returned paths to
prepare a new candidate directory:

```sh
deno run --no-prompt --allow-read --allow-write tools/package-native-runtimes.ts \
  --toolkit-package /path/toolkit/package \
  --semantic-package /path/semantic-index/package \
  --output-dir .data/native-candidate \
  --repository superWorldSavior/assembly --tag native-runtimes-v1
```

The packager preserves Rust licenses/notices present in the vendor tree and the
117 crate manifests in both bundles. Some crates declare their license in
`Cargo.toml` without a separate text; their index records this. The output
contains two deterministic archives, `catalog.json`, `SHA256SUMS` and a
preparation report. It neither writes the tracked catalog nor publishes a
Release.

`tools/qualify-native-runtimes.ts` reinstalls authorized archives, then reads an
actual typed user value in Toolkit and runs an Oxigraph query. In `build` mode,
`native-runtimes.yml` performs this read and the native contracts on all four
runners, then assembles eight qualified archives and their reports in the
`native-qualified-release` artifact.

Before the first publication, review the generated catalog entries and add them
to the tracked catalog, preserving other Releases. The target tag must exist on
the commit containing this catalog. A separate `promote` dispatch, with the
successful preparation run ID and tag, checks reports, run provenance, current
sources, catalog and bytes before creating the Release. An existing Release is
never overwritten. Local preparation and `build` mode neither authorize nor
trigger publication.

## Tool contract

Heavy operations share a child process that retains the native runtime and
library; each operation opens its own session. The scheduler bounds pending
calls and their deadlines. A timeout or panic poisons the instance: the parent
waits for the process to terminate before reusing the lane. The HTTP server and
events remain in the parent. The native host has no network permission.

Provenance collection retains the real path and bundle digest. Every new host
verifies the files again before loading them. A redirected link, changed bytes
or an inaccessible file causes `TOOLKIT_BUNDLE_DRIFT`, even at the same version.
Changing the package requires stopping and restarting the server. Local
qualification covers macOS ARM64. The distribution workflow builds macOS
ARM64/x64 and Linux ARM64/x64 GNU on native runners, separating builds, native
contracts and manual promotion. A target enters the catalog only after
successful qualification; an absent target stays unavailable. The generated-tool
sandbox uses macOS mechanisms: corresponding positive cases run on macOS, while
Linux refusals are tested on Linux. A workflow definition proves neither its
execution nor qualification of another platform.

The internal `model.query` tool is called through `consult_model` with
`operation: "query"`, the requested `version` and an `expression`. This
expression is an SDK KerML query; the interface does not provide a complete
SPARQL engine. The expression limit is 4,096 characters and the JSON result
limit is 65,536 bytes. An overly broad query must be narrowed.

`propose_sysml_edit` prepares the following four operations:

| `kind`          | Edit fields               | Proposed effect       |
| --------------- | ------------------------- | --------------------- |
| `set-value`     | `elementId`, `expression` | Assign a value.       |
| `rename`        | `elementId`, `name`       | Rename a declaration. |
| `insert-member` | `elementId`, `text`       | Insert a member.      |
| `remove`        | `elementId`               | Remove a declaration. |

The request contains `baseVersion`, `sourceDigest`, `reason` and the `edits`
list. Every `elementId` must be the native identity in that version’s compiled
model. A query result may also provide `toolkitElementId`, the identity within
the Toolkit session: it cannot replace `elementId` in an edit. The host maps the
two identities only when the qualified declaration is unique and can be located
in the exact sources of the queried version. If `elementId` is `null`, the
result can still be inspected but cannot be an edit target.

The host checks the source declaration before editing. These identities and
their mapping do not guarantee a persistent identity after a rename.

The result is a set of sources proposed to the admission workflow. It does not
directly write a version into Git. Revision merging, stale-base detection and
the publication decision remain the responsibility of the
[revision workflow](../evolution/revisions-et-historique.md).

## Qualification limits

SDK diagnostics and queries do not prove complete SysML v2 conformance. Assembly
checks verify the facts needed for the executed contract.

The shipped manifest declares `libraryUnresolvedReferences: 6`. This counter
alone cannot attribute a session’s unresolved reference to the library or user
sources. Complete diagnostics must be retained to investigate a failure.

## Historical qualification on 22 October 2026

> This first qualification used the retired backend. The following numbers
> describe that trial and do not qualify the current Git + Toolkit backend.

The integration was checked in a dedicated worktree, with Deno 2.9.7, SysML
Toolkit 0.10.10, OpenSysML 0.10.1 and TerminusDB 12.0.8. A disposable TerminusDB
instance, separate from open workbenches, was used for the trials.

| Check                                                             | Result     |
| ----------------------------------------------------------------- | ---------- |
| Application, test and script type checks and lint                 | Passed     |
| Unit tests, including installer                                   | 482 passed |
| Existing integration scenarios                                    | 5 passed   |
| SDK integration and targeted workflow through to the repository   | 2 passed   |
| Worker isolation, error and interruption of an infinite WASM loop | 3 passed   |
| Historical SysON client import regression                         | 2 passed   |

The agent workflow uses real structured-decision decoding, `SystemRuntime`, the
operator workspace, Toolkit, the OpenSysML compiler and the repository. Only the
decision-provider transport is simulated: no LLM call was made. Two decisions
query and then propose an edit to a quoted Unicode name, with no source file
loaded into context. The proposal changes neither HEAD nor the adopted runtime
version. All four targeted operations were exercised with the real SDK.

An additional trial with two Deno processes and two native authors sharing the
same repository and `writer.lock` checks these two cases:

- Two independent changes: one acceptance, one `STALE_REVISION` refusal, then an
  explicit reconciliation that preserves both values.
- Two changes to the same target: after reading the new HEAD, `SOURCE_CONFLICT`
  preserves the head and the unaccepted proposal record.

These trials prove the local scenarios exercised. They do not yet measure
throughput for 10 or 50 agents or qualify crash recovery, distributed writers or
general semantic merging. The independent Astra review reports no remaining
P1/P2 finding after the qualified-name correction. Historical SysON client
formatting remains separate from the functional check.
