# From a verified build to the native index

The model pipeline deliberately separates four things that are often confused:
published truth, reconstructible cache, transport between processes and the
query engine. This separation explains why KV does not “load” Oxigraph, why
finalization can refresh views before the RDF index, and why a warm cache does
not eliminate the entire cost of a native load.

The [cross-cutting decisions](#décisions-transverses) are recorded on this page.
The [index reference](../../reference/modeles/index-semantique-natif.md) gives
the exact identities, limits, states and
[qualification measurements](../../reference/modeles/index-semantique-natif.md#qualification-measurements).

## Four responsibilities, four lifetimes

### The build is the verified truth

A Git version supplies immutable sources. Compiling them produces a build
identified by the repository, source digest `S`, recipe `R`, build key `K` and
canonical artifact `A`. This chain links a read to what was actually published.

The index does not replace this truth. It cannot modify the model, grant a
mandate or become a new source of identity.

### KV stores a reconstructible projection

The projector transforms `A.elements` into deterministic N-Quads. The build
store keeps them as an immutable projection, compressed with Zstd by the Deno KV
adapter.

This copy is used after a restart or eviction. The preparation process and the
Oxigraph process open independent handles to the same host-configured store. The
server passes references, while these processes read the verified bytes. KV is
not an Oxigraph graph ready to query: it stores the material needed to recreate
one.

### Small references connect preparation and native loading

The main process and native process retain a small JSON control channel. The
previous experiment that put base64 N-Quads in this channel turned about 218 MB
of RDF into about 291 MB of text, in addition to copying and parsing costs. The
parent exhausted its memory before Rust could even index the data.

The production path now sends a build reference and descriptor to a separate,
bounded preparation process. That process reads the canonical artifact from KV
or the vault, validates it, derives the projection context and reuses or
produces the exact N-Quads. It returns a projection reference only after
verified persistence. The native process then reads that projection directly
from its configured KV, checks the expected digest and loads Oxigraph. The
parent does not decompress, hash or stage the RDF payload on this path.

Preparation and query execution use separate processes. A slow projection does
not occupy the native query queue; native loading itself remains serialized. The
existing awaited requests provide completion and failure signals. No
BroadcastChannel or KV watch is needed for correctness.

The private-file transport remains available to explicit byte-based callers and
tests. It retains its size, SHA, epoch and cleanup guarantees. Production does
not silently fall back to it when reference preparation fails.

### Oxigraph holds queryable state

The isolated process loads the Rust module through N-API and builds the build's
named graph. While this graph remains resident, LDkit and bounded SPARQL reads
can query it quickly. Eviction or restart destroys this working state, but not
the N-Quads stored in KV.

## What happens during finalization

```text
Git publication and build A
          │
          ├── new head announcement
          │      └── System, board, views and diagrams advance
          │
          └── first semantic read of the new build
                 ├── preparation process: verify A from KV or vault
                 ├── RDF absent: calculate → verified KV publication
                 └── native process: read KV reference → load → query
```

Finalization therefore does not systematically rebuild the RDF index. It makes
the new build addressable and triggers the projections needed by the views. The
exhaustive semantic path is requested when a semantic read needs it.

Three situations must be distinguished:

- **The same graph is still resident.** Neither projection nor loading is
  repeated.
- **The projection is persisted but the graph is absent.** The N-Quads are read
  from KV and loaded into Oxigraph again.
- **A new projection is needed.** A new `A`, a new projector version or a
  different library classification requires calculation, persistence and then
  loading.

Two commits may lead to the same `A`. In that case, the RDF projection can be
reused if its context is identical, even when the `S/R/K` provenance differs.
The native graph remains associated with the complete build so that two
histories do not accidentally become the same identity.

## Why the cache does not make loading instantaneous

The cache avoids **reprojection**, but not decompression, verification or
reconstruction of Oxigraph state. The reference path moves this work outside the
parent; it does not eliminate it. The first dependent consultation still awaits
the exact graph. Subsequent reads reuse its resident state until eviction or
process loss.

Responsiveness and waiting time are therefore separate properties: the server
can continue handling other work while a graph read is waiting for preparation.
An application being open does not mean that its index has been prepared. The
[measurement reference](../../reference/modeles/index-semantique-natif.md#qualification-measurements)
separates the observed preparation time from parent timer delay, and preserves
the limits of those observations.

<a id="why-the-important-views-remain-responsive"></a>

## Why views do not wait for RDF preparation

System, the board and diagrams use their own projections. They do not wait for
Oxigraph to load the complete RDF. When a new head is announced, an open diagram
requests its projection and rejects an older result that arrives late. A
historical read remains pinned.

The RDF preparation process also isolates its synchronous projection,
compression and verification from the server's event loop. The source-binding
checks still run in the parent; ordinary canonical inspections and application
startup have their own costs. Moving RDF preparation does not establish a
latency guarantee for the complete interface.

The product can thus show the new version before the exhaustive semantic
capabilities are warm. An index failure refuses dependent graph navigation with
a coded error; it does not silently return source-only success or undo the
published version.

## The remaining open limitation

The current RDF retains an exhaustive representation of the artifact. It is
faithful but large. A targeted read index could load fewer facts for the
questions the workbench actually asks, while keeping `A` as the complete truth.

This choice has not been made. It would require defining which facts are
covered, versioning the new projector and checking its readers. Reducing the
data without that contract would simply make information disappear silently.

<a id="décisions-transverses"></a>

## Cross-cutting decisions

### ARCH-NATIVE-001 — Git and the verified build remain the truth

Git retains the published version. `BuildRef(repositoryId, S, R, K, A)` links
the sources, recipe and canonical artifact. A projection or native graph is
derived and reconstructible; losing it does not modify the model or its
authority.

Consequences: the index publishes nothing, grants no rights and never becomes a
parallel identity registry.

### ARCH-NATIVE-002 — Consumers read versioned projections

System pages, diagrams, RDF and diagnostics each have a projection identity. A
consumer does not reread SysML text to reconstruct its own interpretation. A
head view may advance; an explicitly pinned historical view remains attached to
its version.

Consequences: finalization immediately announces the new head and starts view
projections in the background. It does not wait for the exhaustive RDF index to
be built.

### ARCH-NATIVE-003 — KV persists the projection; it does not transport it to the engine

`ModelBuildStore` keeps reconstructible N-Quads under
`(kind, projectorVersion, A)`. The Deno KV adapter uses KV Toolbox and
compresses blobs with Zstd and verifies their integrity. The byte-storage port
exchanges decompressed bytes; compressed storage remains an adapter detail.
Semantic preparation and native loading exchange immutable references, and each
consuming process verifies its own reads.

Consequences: a restart or native eviction can reuse the persisted RDF. KV is
neither the interprocess protocol nor Oxigraph's working memory.

<a id="arch-native-004--large-bytes-travel-through-a-verified-private-file"></a>

### ARCH-NATIVE-004 — Production semantic work exchanges stored references

The main process sends build and projection metadata through bounded request
protocols. A disposable preparer owns artifact decoding, RDF calculation and
verified persistence. The native query process owns projection decoding and
loading. Cache and vault locations come from host composition, never from an
agent request. Persisted projection and resident graph are distinct states.

Consequences: no large artifact or N-Quads payload crosses the parent on this
preparation path. The native acknowledgment is required before `ready`. Existing
private-file loads remain an explicit compatibility surface, with retirement
before cleanup after an ambiguous result.

### ARCH-NATIVE-005 — Native execution is isolated and N-API is the only active engine

SysML Toolkit and the semantic index use Rust modules exposed through N-API in
controlled processes. The host verifies the platform, manifest, provenance and
module SHA before use. A hard deadline can terminate the process; the next call
starts in a new epoch.

Consequences: there is no silent WASM fallback. A missing or invalid native
installation is a visible unavailability.

### ARCH-NATIVE-006 — The RDF projection and native graph have separate lifecycles

The RDF projection depends on `A`, the projector version, repository and
verified classification of library elements. `S`, `R` and `K` remain build
provenance, but do not change the N-Quads when these projection inputs are
identical. The resident graph is pinned to the complete `BuildRef`.

Consequences: a new build may reuse the same RDF bytes but must still load them
into its native graph. A change to `A` or projection context creates a new
projection.

### ARCH-NATIVE-007 — Semantic reads are bounded and evictable

Queries are read-only, tied to an already resolved build and bounded in
duration, results and bytes. The backend retains at most three resident graphs,
protects graphs being read and evicts an inactive graph before admitting another
one.

Consequences: eviction costs a reload, not data loss. Saturation or a timeout
produces an explicit error; it triggers neither SPARQL writes nor a remote
query.

## Responsibility boundaries

| Layer               | Responsibility                                                | Does not decide                  |
| ------------------- | ------------------------------------------------------------- | -------------------------------- |
| TypeScript domain   | `BuildRef`, `BuildElementRef`, `ProjectionRef` identities     | storage, processes, N-API        |
| Application         | build resolution, projection, admission and read limits       | KV format, temporary files       |
| KV adapter          | compression, integrity and reconstructible persistence        | model authority                  |
| Preparation process | verified artifact reads, deterministic RDF and KV publication | model authority                  |
| Control transport   | bounded references, replies and process lifetime              | projection identity              |
| N-API process       | Oxigraph loading, queries and release                         | Git publication, business rights |
| System/Model pages  | following the head or an explicit historical version          | building parallel semantics      |

## Out of scope and open decisions

- The current exhaustive RDF index is not required to refresh System or
  diagrams.
- A more targeted read index remains an option to decide. It would require a
  coverage contract, a new projector version and compatible readers; these
  decisions do not adopt it.
- CBOR and DuckDB are not part of this delivered pipeline.
- Startup/publication prewarming, UI availability and retry controls remain
  separate work in the index-readiness follow-up. This increment preserves
  on-demand, awaited reads.
- Measurements on a single corpus are neither an SLA nor a capacity guarantee
  for three graphs of the same size.
