# Native semantic index: contracts and lifecycle

This reference describes the path from a verified build to Oxigraph and LDkit
reads. It complements the
[pipeline explanation and decisions](../../explanation/modeles/pipeline-modele-natif.md).
Observed performance, versions and limits remain in the October 26 qualification
report.

## Identities

| Type              | Determining fields                                                           | Role                                   |
| ----------------- | ---------------------------------------------------------------------------- | -------------------------------------- |
| `BuildRef`        | `repositoryId`, `sourceDigest`, `recipeDigest`, `buildKey`, `artifactDigest` | Verified build and complete provenance |
| `BuildElementRef` | `build`, `nativeId`                                                          | Element of a specific build            |
| `ProjectionRef`   | `kind`, `projectorVersion`, `artifactDigest`, `projectionDigest`             | Bytes of a derived projection          |

`A`, or `artifactDigest`, authenticates the uncompressed canonical artifact. The
projection digest authenticates the N-Quads and must be distinct from `A`.

The RDF kind is `rdf-quads`. The projector's base version is `ase-rdf-quads-v2`.
Its contextual version adds the canonical digest of the repository and verified
library identifiers. `S`, `R` and `K` describe build provenance; they are not
inputs to the RDF bytes when `A` and the projection context are identical.

The persisted key is therefore conceptually:

```text
(kind = rdf-quads, contextualProjectorVersion, A)
```

The resident graph is addressed by the complete `BuildRef`. Reusing a projection
does not merge two build identities.

## Components

| Component                         | Contract                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `ModelSemanticIndexService`       | Ensures the projection, coalesces identical loads, bounds queries and queues            |
| `DeterministicRdfModelProjector`  | Produces N-Quads and their `ProjectionRef` from verified elements                       |
| `SemanticProjectionProcessClient` | Schedules bounded, disposable preparation processes and returns stored references       |
| `ModelBuildStore`                 | Stores and verifies immutable projections                                               |
| `KvModelBuildStore`               | Persists blobs in Deno KV via KV Toolbox, with Zstd level 3 and checksum                |
| `DenoChildProcessRequester`       | Sequences native operations, including stored-reference and explicit private-file loads |
| `OxigraphNativeIndex`             | Adapts the protocol to the application's native port                                    |
| `ase-semantic-index-napi`         | Loads, queries and releases Oxigraph graphs in Rust through N-API                       |
| `ModelSemanticBackend`            | Resolves versions, pins reads and bounds graph residency                                |
| `BoundModelReader` / LDkit        | Provides typed reads and bounded neighborhoods                                          |

The domain and application import neither KV, Deno nor N-API. These dependencies
remain in the adapters.

## Ensuring a projection

The production reference path follows this order:

1. Join an existing in-flight load for the same `BuildRef`, if any.
2. Return `ready` immediately if the engine confirms that the graph is loaded.
3. Bind the immutable repository header and descriptor, including S/R/K. Send
   the build and descriptor to the configured preparation process.
4. In that process, read verified artifact bytes from KV or the vault, check
   canonicality and compatibility, then derive the contextual projector version.
   No compilation or unused execution-model materialization is performed.
5. Read and verify the persisted projection in the preparation process.
6. If absent, coordinate with a lease, project, verify and persist it. Return
   only the immutable projection reference after persistence succeeds.
7. Ask the native process to read that reference from its configured KV. It
   checks the requested projection digest as well as store integrity, then loads
   the named graph.
8. Publish `ready` only after native verification of the digest and graph.

Only an absent logical RDF projection is a projection-cache miss. Malformed
metadata, corrupt bytes or published metadata with missing chunks remain
failures; they do not trigger silent reprojection. Artifact recovery is
separate: a missing, corrupt or temporarily unavailable artifact cache may use
the exact verified vault copy, without compiling or rewriting the artifact.

Explicit byte-based service callers and tests retain the existing projector and
private-file load path. Production composition chooses reference preparation; an
error does not switch it back to the byte path. The public awaited index API and
the exact RDF encoding are unchanged.

## States

These are internal index-service states. They are not yet a dedicated UI
indicator or an ongoing availability notification to agents. A dependent tool
call awaits its exact build; its final result or coded failure remains the
public consultation contract.

| State     | Meaning                                                   |
| --------- | --------------------------------------------------------- |
| `absent`  | No native graph confirmed for this build                  |
| `loading` | Projection or loading in progress                         |
| `ready`   | Verified projection and engine-confirmed graph            |
| `failed`  | The last load failed; `failureCode` identifies the family |

`status(build)` also queries the engine. A local `ready` pointer whose graph has
disappeared becomes `absent` again.

`release(build)` waits for a load already in progress, rejects queries still
queued for this build, releases the native graph and forgets the in-memory
state. Persisted bytes remain in the store.

## Residency and concurrency

The backend admits at most three resident graphs. An active operation pins its
graph. At capacity, the least recently touched inactive graph is released; if
all three are pinned, up to sixteen graph reads wait, after which admission
returns `INDEX_BUSY`.

The preparer has its own bounded process lane. Its computation and KV writes do
not occupy the native query process. Native loads remain serialized with native
operations; separation of preparation does not promise simultaneous loading and
query execution. A completed or terminated disposable preparer releases its own
KV handle. Shutdown closes preparation before the shared parent stores.

By default, the query service admits four concurrent native queries and
thirty-two waiting queries. The total deadline includes waiting and execution. A
read retains its pin until all queries it started have completed.

Residency qualification with five small versions proves eviction and reloading.
It does not prove that three graphs of the 218 MB corpus can coexist within the
available memory envelope.

## Query limits

| Limit          | Default | Hard ceiling |
| -------------- | ------: | -----------: |
| Results        |   1,000 |       10,000 |
| Returned bytes |   1 MiB |        8 MiB |
| Total duration |     5 s |         30 s |
| SPARQL text    |       — | 65,536 bytes |

The admitted forms are `SELECT`, `ASK`, `CONSTRUCT` and `DESCRIBE`. Updates,
`SERVICE`, `LOAD` and clauses selecting another dataset are rejected. A SPARQL
`LIMIT` does not replace execution bounds.

Typed inspection uses a budget of sixteen quads for the entity and its scalar
attributes. Neighborhoods are read separately, with a default page size of
twenty and a maximum of fifty.

## KV storage

The port exchanges uncompressed N-Quads. `KvModelBuildStore`:

- Compresses with Zstd level 3 and checksum.
- Reads blobs with `getAsBlob`, decompresses them and verifies integrity.
- Separates logical projection identity from its content-addressed physical
  blob.
- Rejects different bytes under an immutable identity.
- Uses a CAS lease to avoid redundant concurrent projections.

KV stores reconstructible data. It grants no rights. The interprocess protocol
carries references and acknowledgments; the referenced bytes are read locally by
the consumers. A persisted projection is not yet a resident native graph.

Cache and vault paths are fixed by host composition. Consumers use independent
handles; they do not share a `Deno.Kv` object. Opening local KV requires SQLite
filesystem access, so a consumer that performs no projection writes is not an
OS-level read-only database connection. Write permission is limited to the
configured cache file (and the native process's private runtime directory),
rather than its enclosing build directory. The durable vault is excluded from
that write grant. Both processes require the host-initialized cache. No process
runs an automatic sweep.

The native consumer uses the adapter's bounded projection reader. It refuses
oversized declared output before reading blob chunks, caps compressed input
accumulation, and limits Zstd output. Exceeding the native read budget produces
`INDEX_QUERY_LIMIT`; inconsistent metadata or bytes remain storage corruption.
The expected projection digest is still checked before native loading. Generic
`ModelBuildStore` reads keep their existing contract.

## Private transport

This transport remains for explicit byte-based `load` operations. The production
reference load does not stage RDF through the parent. A byte-based `load`
retains the `Uint8Array` in its queue reservation, then writes it to the process
epoch's private directory.

| Property              | Contract                                          |
| --------------------- | ------------------------------------------------- |
| Maximum payload size  | 256 MiB                                           |
| Write chunk size      | At most 1 MiB                                     |
| Creation              | Exclusive file, no link following, mode `0600`    |
| After synchronization | Read-only mode `0400`                             |
| Descriptor            | Controlled basename, size, SHA-256                |
| Read                  | Regular file, exact size, `O_NOFOLLOW`, exact SHA |
| Control message       | JSON no larger than 1 MiB, without RDF data       |

After a successful response with the correct epoch and request, the parent
removes the file. After failure or an ambiguous response, it terminates the
epoch and waits for the process to actually exit before cleaning its directory.
A timeout never allows a late response to succeed.

## N-API runtime

Before startup, the runtime verifies the platform, manifest, package version,
`napi8` ABI, Rust/NAPI/Oxigraph versions, source digest, and `.node` module size
and SHA. The module is then copied to a private epoch-specific directory and
loaded by the child process with bounded permissions.

There is no fallback. A missing installation, unsupported platform or
inconsistent provenance makes the index unavailable.

## Reuse scenarios

| Situation                                               | RDF projection                    | Oxigraph graph                |
| ------------------------------------------------------- | --------------------------------- | ----------------------------- |
| Repeated read, resident graph                           | Reused                            | Reused                        |
| Eviction or restart, intact cache                       | Read back and decompressed        | Reloaded                      |
| New build, same `A` and RDF context                     | Reused                            | Loaded for the new `BuildRef` |
| New `A`                                                 | Recomputed and persisted          | Loaded                        |
| New projector version or changed library classification | Recomputed under another identity | Loaded                        |

Finalization does not necessarily invoke this chain. System and diagram
projections have their own cycle and can advance before the first semantic read.

## Errors

| Code                       | Main meaning                                        |
| -------------------------- | --------------------------------------------------- |
| `INDEX_INVALID_INPUT`      | Invalid identity, text or limit                     |
| `INDEX_QUERY_REFUSED`      | SPARQL operation or dataset not admitted            |
| `INDEX_PROJECTION_MISSING` | Expected build, projection or graph absent          |
| `INDEX_PROJECTION_CORRUPT` | Inconsistent identity or digest                     |
| `INDEX_QUERY_LIMIT`        | Result or payload exceeds a bound                   |
| `INDEX_TIMEOUT`            | Total deadline exceeded; the worker may be recycled |
| `INDEX_BUSY`               | Residency, concurrency or queue at capacity         |
| `INDEX_UNAVAILABLE`        | Native runtime closed, absent or unable to load     |

Storage codes (`BUILD_BLOB_MISSING`, `BUILD_BLOB_CORRUPT`,
`BUILD_BLOB_CONFLICT`, `BUILD_STORE_UNAVAILABLE`, `BUILD_STORE_BUSY`,
`BUILD_STORE_QUOTA_EXCEEDED`) remain distinct from engine codes.

## Qualification measurements

### Stored-reference path observed on 26 October 2026

The implementation qualified before its integration was measured on a new copy
of the historical corpus: 6,686 elements, 892,085 quads and 218,305,255 RDF
bytes. The actual preparer, KV reader and native engine were used, with one
observation per phase.

| Measured phase                            |   Wall time | Maximum parent timer delay |
| ----------------------------------------- | ----------: | -------------------------: |
| Cold preparation, native load and `COUNT` | 5,767.81 ms |                    3.14 ms |
| Cached reload and `COUNT`                 | 2,688.21 ms |                   22.84 ms |

Both phases returned the same expected RDF digest and quad count. The parent
performed no artifact/RDF read or byte load during those phases. Native
reference requests were 753 bytes; preparation requests and replies were 1,115
and 331 bytes. Backend startup was measured separately and may still materialize
an artifact in the parent.

The timer detects delays in the parent's event loop; it is not a browser-render
or HTTP-response measurement. OS caches, JIT and GC were not controlled. These
observations establish neither a statistical speedup, an SLA nor the complete
publication-to-view latency.

### Earlier private-file path

The historical qualification recorded a first complete read of 8.080 s and a
cached reload of 3.971 s on a different code/measurement epoch. Its
approximately 34 ms resident ASK/SELECT observations describe simple queries,
not complete agent consultations. Keep those observations separate from the
reference-path run above.

## Missing surfaces

There is no public route to purge, rebuild or force prewarming of the index. No
operating guide should invent these actions. Building a targeted index remains
an open decision and does not change the current contract.

The asynchronous stored-reference increment is a foundation for the
index-readiness follow-up. It adds no startup/publication prewarming,
availability UI, retry control or notification bus. Callers still await their
exact build; a missing or failed index never silently degrades into a
source-only consultation.
