# Model build identities and store

Contract status as of 26 October 2026: the build store, service and vault are
connected. The backend opens a project-specific `KvModelBuildStore` at
`.assembly/runtime/builds/cache.kv` and a durable vault at
`.assembly/runtime/builds/vault` for new projects. Existing `.ase/runtime`
projects retain that layout and identity; competing layouts are refused. The Git
repository, build service, writer and projections share these identities without
confusing a rebuildable cache with durable retention. The
[native semantic index](index-semantique-natif.md) uses the same narrow port for
its RDF projections. The [build service](service-des-builds.md) describes the
wiring, dual Git reader, view projections and retention; this page remains the
reference for identities and the KV store.

## Identities

| Name                  | What it identifies                             |
| --------------------- | ---------------------------------------------- |
| `S`, `sourceDigest`   | The source tree, ordered by code units         |
| `R`, `recipeDigest`   | The exact compiler recipe                      |
| `K`, `buildKey(S, R)` | The inputs of a build                          |
| `A`, `artifactDigest` | The canonical uncompressed bytes of its output |

The recipe includes the recipe schema, Toolkit bundle version and digest,
format, and versions of the normalizer, IR, artifact schema and engine. Any
future option that changes compilation must be included in it.
`ModelCompiler.recipe()` requires bundle provenance.

Digest `A` covers `{v, provider?, engineVersion, elements}`. Compression is a
storage representation; it does not change identity. The `ase-model-build`
descriptor contains the repository identity, `S`, the recipe with `R`, `K`, `A`
and the byte length. The Git repository retains it, the build service verifies
the bytes and their materialization, and the writer publishes from the prepared
handoff rather than compiling under another recipe.

Canonical ordering does not depend on the process locale: the relevant legacy
call sites pin their collator, and sources use code-unit ordering. Reference
fixtures must detect an output change made without changing the recipe.
Qualification on Linux x86_64 before using a shared cache remains open.

Sources: [identities](../../../src/domain/model/value-objects/build.ts),
[sources](../../../src/domain/model/value-objects/sources.ts),
[Toolkit recipe](../../../src/adapters/out/sysml-toolkit/compilation/compiler.ts),
[determinism tool](../../../tools/verify-build-determinism.ts).

## Store port

The
[application port](../../../src/application/model/builds/ports/out/build-store.port.ts)
does not depend on Deno KV. It exchanges uncompressed bytes.

| Operation                                         | Contract                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `has(A)`                                          | True only for a complete entry marked by its metadata                                             |
| `get(A)`                                          | Verified bytes; a missing or incomplete entry produces `BUILD_BLOB_MISSING`                       |
| `put(A, bytes)`                                   | Verifies the digest, writes, then reads back; an identical verified entry returns `stored: false` |
| `hasProjection`, `getProjection`, `putProjection` | The same contract family, by kind, projector version and artifact key                             |
| `acquireLease(key, owner, ttlMs)`                 | Acquires or reacquires a lease through CAS; returns false if another owner has a live lease       |
| `releaseLease(key, owner)`                        | Releases only the named owner's lease                                                             |
| `sweep()`                                         | Removes orphaned chunks and expired leases when explicitly called                                 |
| `stats()`                                         | Counts blobs, projections, leases, uncompressed bytes and quota                                   |
| `close()`                                         | Closes the store handle                                                                           |

The projection key accepts an artifact digest or `legacy:<digest>`. A projection
under the same identity is immutable. A storage error must not be presented as a
simple cache miss.

`BuildStoreError` carries `code`, `context` and a `recovery` hint. Codes:
`BUILD_BLOB_CORRUPT`, `BUILD_BLOB_MISSING`, `BUILD_BLOB_CONFLICT`,
`BUILD_STORE_UNAVAILABLE`, `BUILD_STORE_BUSY`, `BUILD_STORE_QUOTA_EXCEEDED`,
`BUILD_STORE_INVALID_INPUT`.

## Deno KV adapter

[The constructor](../../../src/adapters/out/deno-kv/kv-store.ts) receives a
`path`, an optional quota and an injectable clock. The production composition
sets the path under `.assembly/runtime/builds` in the project; there is no
`ASSEMBLY_BUILD_CACHE_DIR` or legacy `ASE_BUILD_CACHE_DIR` variable.

The adapter uses the `blob` module of `@kitsonk/kv-toolbox` 0.31.0 and Zstd
level 3 with a checksum. `deno.json` enables `unstable: ["kv"]`. If
`Deno.openKv` is unavailable, opening fails with `BUILD_STORE_UNAVAILABLE`.

The native semantic consumer additionally uses the adapter-specific
`getProjectionBounded` reader. It checks declared uncompressed size before blob
reads, bounds compressed input while reading chunks, and passes an output limit
to Zstd. A dedicated read-budget error maps to `INDEX_QUERY_LIMIT` at the native
boundary; malformed metadata and corrupt content retain their storage errors.
The generic store port and ordinary `getProjection` calls are unchanged.

Storage rules are:

1. Copy the bytes to an `ArrayBuffer` of exactly the required length before
   calling kv-toolbox, including for a subarray or shared `Buffer`.
2. Read ordinary blobs through `getAsBlob`, decompress, then verify their
   integrity. Bounded consumers iterate chunks into one capped buffer; they do
   not repeatedly concatenate the complete payload or use per-chunk `get` calls.
3. Report `put` as successful only after verified readback. Metadata marks
   completeness; an interrupted write remains invisible to `has` and is rejected
   by `get`.
4. Reject different content under the same digest or projection identity.
   Unreadable entries can be repaired under their identity, subject to the
   qualifications below.
5. Retry SQLite lock errors recognized by `retryBusy`, with a bounded budget of
   200 attempts.
6. Determine lease validity from `expiresAt`, then acquire the lease by CAS on
   the `versionstamp`. Physical KV expiration is not the lease contract.
7. Never sweep on opening: another process may be in the middle of a `put`.
   `sweep` requires that no write be in progress in another handle.

Current keys: `format`, `build/blob/A`, `proj-bytes/outputDigest`,
`proj-meta/kind/projectorVersion/artifactKey`, `lease/key`, `use/A` and
`write-epoch`. Legacy physical keys `proj/...` remain readable. A lease owner is
stored in its value, not its key.

This store remains intended for rebuildable data. `FileBuildVault` separately
retains irreplaceable verified bytes under `<A>.zst`, with atomic writes,
synchronization and verification of `A` on read. The retention policy determines
what must enter this vault; the cache replaces neither Git nor the vault.

## Qualified repairs and concurrency

The earlier repair reservations have been addressed: concurrent repairers of the
same digest no longer erase each other's work, corrupt projection metadata is
read back before repair, and `retryBusy` has deterministic tests for success,
non-retry and exhaustion. The quota uses a `write-epoch` and retains a
reservation after an ambiguous failure so that the same bytes are not reused
while another writer may still be active.

The integration tests and their support are versioned:
[kv-model-build-store_test.ts](../../../test/integration/kv-model-build-store_test.ts)
and [kv-writer.ts](../../../test/support/kv-writer.ts). They cover exact bytes,
interrupted writes, multiprocess access, leases and corruption, among other
cases. Their presence does not constitute a new execution during this
documentation pass. The native pipeline report retains the runs and their
limits.
