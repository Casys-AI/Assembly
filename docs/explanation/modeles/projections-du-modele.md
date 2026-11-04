# Why the model is read through versioned projections

System pages do not read `.sysml` files. They read **projections**: typed
documents calculated for a specific commit, including the board and rights
matrix. The Toolkit projects the board from sources. The matrix is projected
from the commit's compiled artifact. Model pages follow the same head
announcement. This document explains that choice, its costs and the limits that
remain. The
[projection reference](../../reference/modeles/projections-du-modele.md) gives
the routes and contracts. The [page rules](pages-system-et-model.md) explain how
they are used.

## Projections rather than sources

The Toolkit reads SysML at the projection boundary: pages do not build a second
interpretation of the sources.

- The [board contract](../../../src/domain/model/records/board.ts) types its
  values, closes its unions and reads no SysML.
  [`ToolkitModelBoardReader`](../../../src/adapters/out/sysml-toolkit/projections/board-reader.ts)
  produces it by reading the commit's sources and requesting a board from the
  Toolkit.
- The matrix starts from different material: the compiled artifact resolved for
  the commit. It is calculated in a process without a Toolkit runtime
  ([`process.ts`](../../../src/adapters/out/sysml-toolkit/projections/authority-matrix/process.ts)).
  Build resolution and compatibility reads belong to the repository, not the
  page.

A page draws these documents; it does not recover information from the SysML
text. The [view test](../../../test/integration/model-views_test.ts) also checks
that projectors do not reconstruct guards through `RegExp`, `.exec(` or
`decisionBranches`.

Any future editing from a page must go through
[`host-writer.ts`](../../../src/application/model/editing/host-writer.ts):
`applyEdits`, then `verifyEdits`. A projection is not permission to rewrite the
model text directly.

## One read per commit

A commit never changes, and neither does its pure projection. Attention is an
exception, described below. An explicit version is served as `immutable`, with
the projection fingerprint as its ETag; a client that already knows it receives
304 ([`responses.ts`](../../../src/adapters/in/http/versioning/responses.ts)).
The head is served as `no-store`, and the response names the commit read in
`x-model-version`
([`handler.ts`](../../../src/adapters/in/http/versioning/handler.ts)). Two pages
describing the same commit do not contradict each other: the matrix is requested
at the commit described by the board
([`useMatrix.ts`](../../../frontend/components/system/rights/useMatrix.ts)).

The source comment in
[`worker-client.ts`](../../../src/adapters/out/sysml-toolkit/projections/authority-matrix/worker-client.ts)
records matrix calculations of 0.7–1.9 s for the initial model under moderate
load, and about 3.1 s for the three-unit watch example. These are recorded
observations, not measurements rerun for this documentation or an SLA.

[`VersionedReadService`](../../../src/application/model/projections/versioned-read.ts)
avoids repeating reads:

- **In-flight reads.** Concurrent reads of the same version share one
  calculation. An in-flight read is never evicted.
- **Bounded LRU.** The outer
  [board service](../../../src/application/model/projections/board.ts) and
  [view-list service](../../../src/application/model/projections/views.ts)
  retain 16 commits; the
  [matrix service](../../../src/application/governance/authority-matrix.ts)
  retains 32, and diagram documents retain 32 commit/view pairs. Eviction costs
  another read, not an inconsistent version.
- **Failed reads are evicted.** The next read retries. A timeout has additional
  handling, described under “What this costs”.

These service caches are not the whole storage path. Production also wires
[`createCachedModelProjections`](../../../src/application/model/projections/cached-projections.ts)
to `ModelBuildStore` in
[`model-projections.ts`](../../../src/composition/model-projections.ts). Its
projection registry has a byte-bounded resident LRU, 64 MiB by default, and
persists encoded projections through the build store. A restart loses resident
values but can reuse verified persisted projections rather than necessarily
recalculating all of them. Projection kind, projector version, artifact and
parameters identify the derived value; version pins keep the requested commit
distinct from a value that happens to be reusable. The
[build-store reference](../../reference/modeles/magasin-des-builds.md) and
[native pipeline](pipeline-modele-natif.md) describe this separation.

After listening, the host prewarms the current board, attention, view list and
matrix. Failures in these background reads do not turn them into a startup
prerequisite. Current-version projection requests also start the required pure
reads in the background
([`model-projections.ts`](../../../src/composition/model-projections.ts),
[`cached-projections.ts`](../../../src/application/model/projections/cached-projections.ts)).

## A pinned, isolated and bounded native Toolkit

Production Toolkit work runs in a **Deno child process that loads the Rust N-API
addon**. The Worker transport retained in
[`worker-client.ts`](../../../src/adapters/out/sysml-toolkit/worker-client.ts)
is an integration-fixture seam, not the production engine. When an active
operation expires, the scheduler retires its computing process and waits for
termination, rather than merely abandoning a promise. A waiter that expires
before execution is removed without terminating another operation's process. The
parent does not load the `.node` module.

The child starts with explicit Deno read, write and FFI permissions for the
required application, package and private snapshot paths. It does not inherit
all of the parent's permissions, and it is not granted general network,
subprocess or environment access by that command. This is controlled native
computation, distinct from the sandbox for generated tool code
([`process-client.ts`](../../../src/infrastructure/native/process-client.ts),
[local models](modeles-locaux.md)).

**Pinned bytes.** The host binds the configured bundle to a startup fingerprint.
The [native loader](../../../src/adapters/out/sysml-toolkit/runtime/loader.ts)
checks the pinned package and addon bytes, materializes a verified private addon
snapshot and loads N-API. A different bundle is refused
(`TOOLKIT_BUNDLE_DRIFT`). There is no active WASM runtime or silent fallback. A
native panic invalidates the runtime and makes its result non-reusable; the
parent retires that process before later work starts in a new epoch
([`native-process.ts`](../../../src/adapters/out/sysml-toolkit/native-process.ts)).

**Released ownership.** Projectors release the sessions and element handles they
acquire, including after a failed read. The compatibility facade retains the
existing `free()` vocabulary over native session ownership; it does not create a
second SysML engine. Runtime and library state belong to the hosting child
process. The
[board integration test](../../../test/integration/model-board_test.ts) also
exercises thirty warm projections with a 128 MiB RSS-growth threshold, but it
samples the parent process. That threshold is not a qualification or memory
limit for the native child.

**One queue and an execution ceiling.** A Toolkit process executes one operation
at a time. Non-projection operations have priority over queued read projections.
The read kinds include `board`, `views`, `diagram`, `plantuml` and `tokens`. A
started projection receives at most 3 s of execution time; the default operation
deadline is 15 s including queueing
([`worker-client.ts`](../../../src/adapters/out/sysml-toolkit/worker-client.ts)).
A read must not occupy the authoring process for its entire default deadline.

**The matrix has its own path.** It does not use the Toolkit process. Each
calculation starts a disposable Deno process with a 512 MiB heap ceiling and
only read and environment permissions. Its execution ceiling is 10 s within a 15
s total budget including queueing. One calculation runs and three may wait; a
full queue responds with `PROJECTION_QUEUE_UNAVAILABLE` and `retryAfterMs`
([`worker-client.ts`](../../../src/adapters/out/sysml-toolkit/projections/authority-matrix/worker-client.ts)).
The code records why this separate path exists: the 3 s ceiling would reject
ordinary models.

### What this costs

- A started projection can delay writing for up to 3 s. Writing takes priority
  over the queue, not over a calculation already running.
- The Toolkit queue has no size bound; the matrix path does. Deadlines clear
  expired Toolkit work.
- An active operation's timeout terminates its computing process; the next
  operation loads the native runtime again from its verified installation.
- For the board and views, a version that exceeds its deadline is refused for 30
  s, even if calculation never started
  ([`versioned-reader.ts`](../../../src/adapters/out/sysml-toolkit/projections/versioned-reader.ts)).
  For the matrix, this refusal applies only if calculation started; otherwise
  the response asks the client to retry in one second
  ([`reader.ts`](../../../src/adapters/out/sysml-toolkit/projections/authority-matrix/reader.ts)).
  The HTTP route returns 502 with `Retry-After`
  ([`responses.ts`](../../../src/adapters/in/http/versioning/responses.ts)).
- Native compilation, board/view reads and editing still share the Toolkit
  scheduler. Persisted projections avoid repeated work when available; they do
  not make a new native calculation parallel.

## Why attention is not cached as a pure projection

Attention combines the matrix, board and model doctor
([model validation](../../reference/bibliotheque-ape/validation-du-modele.md)).
The first two already have caches, and composition is inexpensive
([`attention.ts`](../../../src/application/model/projections/attention.ts)).
Caching this combined document as immutable would produce stale answers:

- A “source unavailable” item is rebuilt on each read, so a restored source is
  healthy on the next read.
- Doctor masks are instance preferences reread each time: masking a code removes
  its item immediately.
- The route is never `immutable`: an explicit version carries `no-cache` with
  its ETag ([`attention.ts`](../../../src/adapters/in/http/model/attention.ts)).

The host retains only the **count** for at most 32 versions for its event, and
never a count containing an unavailable item. An absent count does not mean
zero. The event does not wait for this calculation: it starts in the background,
then the host publishes again. It also republishes after a mask change
([`version-events.ts`](../../../src/application/model/revisions/version-events.ts),
[`root.ts`](../../../src/composition/root.ts)).

## How the frontend follows the head

The host announces `model-version` on `/api/events` when the head advances, a
proposal is made or decided, and on each connection
([`events.ts`](../../../src/application/model/diagnostics/events.ts),
[`version-events.ts`](../../../src/application/model/revisions/version-events.ts);
contract in the
[validation reference](../../reference/bibliotheque-ape/validation-du-modele.md)).
An announcement without a change remains silent.

The workbench already owns this connection and passes each announcement to
`modelLive` ([`state.ts`](../../../frontend/lib/workbench/state.ts)). Pages
subscribe through `useModelLive`: the
[board](../../../frontend/components/system/board/useBoard.ts),
[files](../../../frontend/components/model/files/useFilesPage.ts),
[history](../../../frontend/components/model/usePageHistory.ts) and
[To decide](../../../frontend/components/decide/useRefreshOnOpen.ts). They do
not open another connection or poll the head. Three layers filter board updates:

- [`live.ts`](../../../frontend/lib/model/live.ts) reads only `head`. It ignores
  non-announcements and duplicate announcements.
- [`head-reader.ts`](../../../frontend/lib/model/head-reader.ts) rereads only
  when the reader follows the head but does not hold it, or its previous read
  failed. A read of the same commit already in flight answers the request; a
  read for an older head is discarded.
- [`versioned-store.ts`](../../../frontend/lib/model/versioned-store.ts) retains
  the displayed value until the response, and after a failure. It does not
  redraw when the same commit returns with the same fingerprint. It resets when
  another version is requested.

Files reuse `head-reader.ts`. The matrix, requested at a named version, does not
independently follow the head: it reads the new board's commit. Each reread uses
the new commit's immutable address, which the browser may cache
([`versioned-read.ts`](../../../frontend/lib/model/versioned-read.ts)). The
reconnect announcement catches up after a connection gap. For these pages, it
replaces periodic polling of the head.

## Known limits

- **Resident and persisted state have different lifetimes.** Restarting loses
  the in-memory service caches and native graph residency. Persisted pure
  projections and RDF may be reused, but native state may still need loading.
  The [native pipeline](pipeline-modele-natif.md) separates these costs.
- **A single Toolkit scheduler.** Persisted projection reuse does not remove
  serialized native work or its deadline limits. A compilation pool is not
  established by the presence of the native process transport.
- **The 3 s ceiling and 30 s refusal window** can affect ordinary models. Work
  to revisit them is proposed.
- **Event following does not cover everything.** The host still refreshes the
  legacy graph every 5 s
  ([`live-graph.ts`](../../../src/composition/live-graph.ts)), and the frontend
  polls proposal decisions every 30 s
  ([`state.ts`](../../../frontend/lib/workbench/state.ts)).
- **Not all event metadata is consumed.** The native SysML page reads view lists
  and diagrams
  ([`SysmlPage.tsx`](../../../frontend/components/model/diagrams/SysmlPage.tsx)),
  but `model-live.ts` still exposes only `head`; the announced attention count
  is not consumed through that model.
- **The semantic index has its own lifecycle.** The native semantic backend is
  wired into the host; it is no longer a missing native index component. Its
  existence does not mean every exhaustive RDF read is warm, inexpensive or
  qualified for arbitrary corpus sizes. See the
  [native-index reference](../../reference/modeles/index-semantique-natif.md).
