# Build service, projections and vault

The service is assembled in
[`model-backend.ts`](../../../src/composition/model-backend.ts) with the Git
repository, KV store, vault and durable writer. Projection readers are assembled
in [`model-projections.ts`](../../../src/composition/model-projections.ts);
[`root.ts`](../../../src/composition/root.ts) connects their notifications. This
wiring does not constitute overall acceptance of the delivery. S/R/K/A
identities and the KV store remain described in the
[build store](magasin-des-builds.md).

## Build service

[`ModelBuildService`](../../../src/application/model/builds/service.ts)
orchestrates the storage, vault, compilation and materialization ports:

- `ensure(compiled, recipe)` stores the compact canonical bytes (the domain's
  `artifactPayload`) under A through the store's verified put and returns the
  `BuildDescriptor`. It never compiles.
- `resolve(descriptor, sources)` checks the strict descriptor, sources S, recipe
  R and key K on every call. An already-verified private snapshot can then
  answer from memory; each call receives a fresh copy. Otherwise, reading
  follows the KV cache, vault and reconstruction, checking the size, SHA-256,
  canonical form and materialization compatibility of the bytes read.
- Reconstruction takes place only if the injected compiler declares exactly the
  descriptor's recipe, and reconstructed A must be identical
  (`BUILD_OUTPUT_MISMATCH` otherwise). A missing recipe produces
  `BUILD_RECIPE_UNAVAILABLE`, distinct from Git repository corruption:
  historical builds remain readable from their verified vault bytes and are
  never recompiled under another recipe.
- Concurrent resolutions are shared only for the same complete verified
  descriptor. Reconstruction across processes is bounded by the store lease,
  with a verified put before release. A failed resolution is evicted.

The service separately bounds resolutions in progress and retained snapshots.
The weighted cache defaults to 64 MiB; the workbench composition gives it 512
MiB, configurable through `buildMemoryCacheBytes`. A Release-opening measurement
on 4 November 2026 used two source builds weighing approximately 147.8 and 164.0
MiB under the conservative estimator. They need about 311.9 MiB together; the
former 256 MiB composition budget made them evict each other during repeated
source inspections. The 512 MiB budget accommodates this observed pair with
headroom; larger working sets still follow the weighted LRU eviction policy.
This weight represents neither the V8 heap nor the process RSS; in-flight reads
and references outside the cache have their own lifetimes. `clearMemory()`
forces subsequent reads to verify storage again and prevents reads from an
earlier generation from repopulating it.

<a id="dual-read-git-format"></a>

## Compatible Git formats

[`revision-format.ts`](../../../src/adapters/out/git/revision-format.ts) writes
`.assembly-build-ref.json` for new descriptors. It permanently reads
`.ase-build-ref.json` descriptors and historical `.ase-build.json` inline
snapshots. More than one build entry in a commit produces
`BUILD_FORMAT_AMBIGUOUS`; none produces `BUILD_FORMAT_MISSING`. Encoding a
descriptor produces one entry; legacy history and build fingerprints are never
rewritten.

The production backend always supplies the build service and writes the
canonical descriptor entry. The low-level repository API still supports its
historical inline writer when no build service is injected; this compatibility
mode does not rename or reconstruct old artifacts.

## Projections

[`ModelProjectionRegistry`](../../../src/application/model/projections/cached-projections.ts)
uses the kind, projector version, A and canonical parameters as its key. Its
memory cache is
[weighted by bytes](../../../src/application/support/weighted-lru.ts),
computation is shared, and `pending/ready/failed` statuses are published to SSE
subscribers. Registry status reports `ready` only while the encoded bytes remain
resident. The versioned read facade separately tracks requested and available
model versions for current projections: a slow read of an older version never
replaces a newer current request.

The cache retains encoded bytes and decodes a fresh object on each read. It
retains neither runtime state nor authority. The application cache in
[`cached-projections.ts`](../../../src/application/model/projections/cached-projections.ts)
manages projection pins and optional persistence in the KV store.
[`model-projections.ts`](../../../src/composition/model-projections.ts) supplies
the concrete `board`, `authority-matrix`, `views`, `view-diagram` and `plantuml`
readers. RDF and SHACL projections use their own services. Live tracking in
System and the viewer does not depend on loading the RDF index; an explicitly
pinned historical query retains its version.

## Vault and retention

[`FileBuildVault`](../../../src/adapters/out/filesystem/build-vault.ts) retains
`<A>.zst` in the injected directory: Zstd level 3 with checksum, temporary-file
write, fsync, rename and directory fsync. Every read checks SHA-256 == A again.
The current composition uses `.assembly/runtime/builds/vault/` for a new local
project. A project already using `.ase/runtime` keeps its original directory and
repository identity. Competing `.assembly` and `.ase` layouts are refused before
opening a store; the application does not select or migrate user data.

The current backend collects reachable artifacts from the repository and tries
to preserve them in the vault on startup. It returns missing artifacts and
`evictionPermitted: false`. It does not plan cache evictions. Logical KV
reservations and quotas do not promise a physical size limit for the SQLite
file.

## Repair and shutdown

The KV store repairs an entry without deleting it first, preventing two
concurrent repairers from erasing each other's work. `putProjection` reads the
entry again before trusting its metadata; altered metadata remains repairable. A
corrupt entry's reservation remains counted until its repair has been verified.

Backend shutdown waits for the writer, clears compilation and build caches, then
closes the durable queue and KV, even after an intermediate failure. Global
Toolkit scheduler shutdown belongs to the host's final shutdown and does not
occur on every backend shutdown. Unit tests and targeted integrations qualify
these mechanisms; the interrupted general native campaign must not be presented
as entirely successful.
