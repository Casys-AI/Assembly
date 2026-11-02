# Model projections

These routes serve the admitted model as JSON projections and PlantUML exports.
The host reads a commit from the Git repository. It projects the board, views
and diagrams with SysML Toolkit, and the authority matrix from the compiled
artefact. The frontend reads the board and authority matrix for System pages.
For each read, this reference describes the request, response, cache, errors and
execution. It also describes the `model-version` event.

Repository reads (history and files by commit) are covered in
[revisions and history](../evolution/revisions-et-historique.md). Doctor
diagnostics are in
[model validation](../bibliotheque-ape/validation-du-modele.md). The pinned
Toolkit bundle is in [local SysML tools](toolkit-local.md).

## Routes

| Method and path                   | Parameters                    | Response                                           | Cache with `version` |
| --------------------------------- | ----------------------------- | -------------------------------------------------- | -------------------- |
| `GET /api/model/board`            | Optional `version`            | `ModelBoard`, schema `ase.board/1`                 | Immutable            |
| `GET /api/model/authority-matrix` | Optional `version`            | `AuthorityMatrix`, schema `ase.authority-matrix/1` | Immutable            |
| `GET /api/model/attention`        | Optional `version`            | `ModelAttention`, schema `ase.model-attention/1`   | `no-cache` and ETag  |
| `GET /api/model/views`            | Optional `version`            | `ModelViewList`                                    | Immutable            |
| `GET /api/model/views/diagram`    | Required `version` and `view` | `{toolkit, view}`                                  | Immutable            |
| `GET /api/model/views/plantuml`   | Required `version` and `view` | PlantUML text (`text/plain`)                       | Immutable            |
| `model-version` event             | None                          | `ModelVersionEvent`                                | Not applicable       |

The event travels over the `GET /api/events` SSE stream. All six `GET` routes
are reads. The server listens on `127.0.0.1`
([main.ts:778](../../../src/main.ts#L778)). They do not apply
[`requireLocalJsonCommand`](../../../src/infrastructure/http/local-security.ts#L13),
the host, origin and content-type check for commands.

## Request

### Requested version

A version is an immutable commit: `commit:` followed by 40 lowercase hexadecimal
digits. A branch name is rejected
([revision-id.ts:5](../../../src/domain/shared-kernel/revision-id.ts#L5)).

- Without a parameter, the route reads the repository’s admitted head. Diagram
  and PlantUML reads do not support reading the head.
- With `?version=<version>`, it reads that commit.
- The parameter set is strict: `version` alone, or `version` and `view` for a
  diagram or PlantUML. Unknown or repeated parameters are rejected.
- `view` is the `id` of a summary from `GET /api/model/views`, in the form
  `<groupe>:<nom qualifié>`. It must be URL-encoded.
- Only `GET` is allowed. `HEAD` is rejected like other methods.

The shared handler is
[versioned-model-http.ts:10](../../../src/adapters/in/http/versioning/handler.ts#L10).
The diagram adds its second parameter in
[model-views-http.ts:19](../../../src/adapters/in/http/model/views.ts#L19). It
checks, in order: the method, parameter set, version format, then a non-empty
`view`.

### Head

The head is the commit returned by `repository.current()`. A single read is
shared by the four non-diagram routes. An in-progress read is reused, and a
result is retained for one second
([model-board-reader.ts:9](../../../src/adapters/model/projections/board-reader.ts#L9)).
An error is never retained. The read head may therefore lag Git by one second.

A successful head response carries the `x-model-version` header. It identifies
the commit actually read. Subsequent reads of this commit may use `?version=`
and then benefit from the cache.

## Responses

Each domain type is authoritative. This section explains what it carries,
including details not apparent from its name.

### Board

[`ModelBoard`](../../../src/domain/model/records/board.ts#L337): `schema`,
`meta`, `columns`, `links`, `index`.

- `columns`: the board’s columns, identified by
  [`BoardColumnId`](../../../src/domain/model/records/board.ts#L21) (`team`,
  `cando`, `rules`, `guarantees`, `information`). Each element is a
  [`BoardItem`](../../../src/domain/model/records/board.ts#L233) with a closed
  `kind`.
- `links`: relationships between displayed elements
  ([`BoardLink`](../../../src/domain/model/records/board.ts#L271)).
- `index`: the identifier of every displayed item, with its column and card.
- Every displayed item carries `file` and `line`, plus `col` when known. `col`
  counts UTF-16 units from 1, like the Toolkit.
- Values are typed. No JSON is transported inside a string.

[`meta`](../../../src/domain/model/records/board.ts#L306) carries `model`,
`mode`, `toolkit.version`, `sourceDigest`, `modeRule`, `anchors`, `linkLabels`,
`counts`, `packages`, `diagnostics`, `fieldSources`, `timingMs` and `digest`.
`model` is `model`: the reader does not pass a project name
([model-board-reader.ts:48](../../../src/adapters/model/projections/board-reader.ts#L48)).
It sends no options to the Toolkit, so the projection uses `ase` mode
([toolkit-board.ts:760](../../../src/adapters/out/sysml-toolkit/projections/board.ts#L760)).
The `generic` mode cannot be reached through HTTP.

Board diagnostics never cause a read to fail. The board is served with its
reported defect.

| Code                                                                 | Severity  | Meaning                                                                                                 |
| -------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| `ANCHOR_UNRESOLVED`                                                  | `info`    | An expected Assembly definition is missing. Without an operator definition, all five columns are empty. |
| `SHAPE_TRUNCATED`                                                    | `error`   | The model outline exceeds 200,000 nodes.                                                                |
| `ROOT_PART_WITHOUT_OPERATOR`                                         | `info`    | A root part without an operator is not displayed in Team.                                               |
| `ELEMENT_NOT_SHOWN`                                                  | `info`    | An element belongs to no column. At most forty per read.                                                |
| `LINK_ENDPOINT_NOT_SHOWN`                                            | `info`    | A relationship has an endpoint that is not displayed.                                                   |
| `PANEL_RECURSION_TRUNCATED`                                          | `info`    | A self-containing part, or a part nested twelve levels deep, is displayed as a leaf.                    |
| `BRANCH_SOURCE_SUPPLEMENTED`                                         | `info`    | The Toolkit supplies an empty decision-branch source; the preceding node replaces it.                   |
| `FLOW_EDGE_UNRESOLVED`                                               | `warning` | A succession has an endpoint outside its action.                                                        |
| `INVALID_BOARD_STRING_LIST`                                          | `warning` | A model string list is not a JSON array of strings.                                                     |
| `INVALID_MODEL_EDIT_GRANTS`                                          | `error`   | Edit grants are not canonical.                                                                          |
| `DUPLICATE_ID`                                                       | `error`   | Two displayed items share an identifier.                                                                |
| `DUPLICATE_LINK_ID`, `LINK_ENDPOINT_UNKNOWN`, `THING_WITHOUT_SOURCE` | `error`   | Projection invariants. `meta.counts.invariants` counts checks and violations.                           |

### Authority matrix

[`AuthorityMatrix`](../../../src/domain/governance/records/authority-matrix.ts#L332)
describes the grants declared at a commit. Execution still passes through the
host’s controls. It carries `schema`, `version` and the following fields.

- `model`: `name` (the project identifier), `sourceDigest`, `toolkit` (the
  engine version that compiled the artefact), `authoritySchema` (`legacy-v1` or
  `owner-modeled`) and `units` (each unit’s `system` and `executionDigest`).
- `groups`: families, with their labels and order.
- `rows`: software or human operators, with their role (`builder`, `reviewer`,
  `owner`).
- `columns`: grants grouped by family (`tools`, `admission`, `mandate`, `model`,
  `memory-skills`, `behaviors`). The column identifier is a closed union
  ([`MatrixColumn`](../../../src/domain/governance/records/authority-matrix.ts#L275)).
- `cells`: one
  [cell](../../../src/domain/governance/records/authority-matrix.ts#L205) per
  applicable row and column. It carries `state` (`allowed`, `propose-only`,
  `denied`, `inherited`, `delegated`), `basis` (`declared`, `closed-world` or
  `host-rule`), `sources`, `via`, `scope` and `codes`.
- `delegations`, `diagnostics`, `caveats`, `summary` and `digest` complete the
  matrix.

A unit may carry several operators, such as builder and reviewer. A join with
Team therefore uses the row identifier `MatrixRow.id`, rather than the `unit`
field alone. The “one row per operator” contract does not imply a unique
operator per unit.

An absent cell means “not applicable”, rather than “denied”. `caveats` states
the read limitations, always in this order: `ADOPTED_VERSION_ONLY`,
`ALLOWED_IS_DECLARED_NOT_EXECUTED`, `ABSENT_CELL_IS_NOT_APPLICABLE` and
`OWNER_CELLS_ARE_HOST_RULES_BEFORE_LOT_3`.

A cell with `via.kind: "host-rule"` cites `enforcedAt`, a symbolic name. It
resolves to an exported host symbol
([host-anchors.ts](../../../test/support/host-anchors.ts)). No file coordinates
are encoded in it.

Matrix diagnostics carry
[`MatrixDiagnosticCode`](../../../src/domain/governance/records/authority-matrix.ts#L303)
codes. If `summary.coordinates.mismatches` is non-zero, the projection is
rejected with `SOURCE_COORDINATE_MISMATCH` and no matrix is served.

### Attention

[`ModelAttention`](../../../src/domain/model/records/attention.ts#L35) lists
points requiring a person: `schema`, `version`, `count`, `items`, `digest`.
`count` always equals `items.length`.

An [item](../../../src/domain/model/records/attention.ts#L26) carries `code`,
`severity`, `source`, `context`, `recovery` and `target` (`page`, and
`elementId` if known). It contains no sentence to display.

The route executes no projection. It reads the matrix, board and doctor
diagnostics in parallel through their services, and composes the list
([model-attention.ts:221](../../../src/application/model/projections/attention.ts#L221)).
Its deadlines are those of these three reads.

Each source produces its own items:

- `authority-matrix`, page `rights`: matrix diagnostics of severity `warning` or
  `error`, under their own codes. Also `TOOL_SELF_APPROVAL` (`warning`): a
  software operator builds tools and may admit them, while no operator can
  review a candidate.
- `board`, page `requirements`: `REQUIREMENT_WITHOUT_OWNER` (`warning`), a
  requirement that nobody satisfies, and `CONSTRAINT_INACTIVE` (`info`), a
  constraint whose `inForce` is not true.
- `doctor`, page `team`: unmasked doctor diagnostics of severity `warning` or
  `error`.

Items are sorted by severity, source, code, page, element, context, then
`recovery`
([model-attention.ts:85](../../../src/domain/model/records/attention.ts#L85)). A
healthy model produces `items: []` and `count: 0`.

An unresponsive source does not cause the list to fail. An infrastructure
failure becomes an `ATTENTION_SOURCE_UNAVAILABLE` item (`warning`), with context
`{source, failureCode, message?}`, and the other sources are still read.
Infrastructure failures include `TOOLKIT_TIMEOUT`, a code ending in
`_UNAVAILABLE`, `_UPSTREAM_FAILURE` or `_TOOLKIT_FAILED`, and an error without a
code. Any other coded error (`NOT_FOUND`, `INVALID_*`, `MODEL_VERSION_MISMATCH`)
causes the read to fail with its own status
([model-attention.ts:55](../../../src/application/model/projections/attention.ts#L55)).

### Views

[`ModelViewList`](../../../src/domain/model/records/diagram-views.ts#L82):
`toolkit` (the Toolkit version), `views`, `diagnostics`, `digest`. A
[summary](../../../src/domain/model/records/diagram-views.ts#L61) carries `id`,
`title`, `kind`, `group`, `element`, `nodes` and `edges`. It does not carry the
graph.

The list applies these rules
([toolkit-views.ts:301](../../../src/adapters/out/sysml-toolkit/projections/views.ts#L301)):

| Model element               | Group         | Kind              | View retained if          |
| --------------------------- | ------------- | ----------------- | ------------------------- |
| `PartUsage` under a package | `structure`   | `interconnection` | It has more than one node |
| `ActionDefinition`          | `behavior`    | `action`          | It has an edge            |
| `StateDefinition`           | `state`       | `state`           | It has a transition       |
| `ViewUsage`                 | `declared`    | `tree`            | It exposes an element     |
| Root package                | `definitions` | `tree`            | It has more than one node |

The list follows the order `structure`, `behavior`, `state`, `declared`,
`definitions`. An excluded view does not appear. List `diagnostics` never fail
the read:

| Code                 | Severity  | Meaning                                                |
| -------------------- | --------- | ------------------------------------------------------ |
| `VIEW_UNPROJECTABLE` | `warning` | The Toolkit could not project the view. It is omitted. |
| `VIEW_EMPTY`         | `warning` | A declared view exposes no element. It is omitted.     |
| `SHAPE_TRUNCATED`    | `error`   | The model outline exceeds 20,000 nodes.                |

<a id="diagramme-dune-vue"></a>

### Diagram of a view

The response is `{toolkit, view}`. `view` is a
[`ModelView`](../../../src/domain/model/records/diagram-views.ts#L71): the
summary and its `diagram` (`nodes`, `edges`). Identifiers and positions come
from the Toolkit.

- A node carries `id`, `kind`, `name`, `rows` and, as applicable, `typeName`,
  `metaclass`, `qname`, `stereo`, `nodeKind`, `parent`, `conjugated`, `file`,
  `line` and `col`. `name` is the declared name, never the composite label
  `nom : Type`.
- An edge carries `kind`, `source`, `target` and, as applicable, `id`, `label`,
  `guard`, `directed`, `metaclass`, `qname`, `sourcePath` and `targetPath`.
- The body does not contain `digest`: it is used only for the ETag.

The diagram is recomputed on demand from the list summary. An unknown view fails
before opening a Toolkit session
([model-views-reader.ts:112](../../../src/adapters/model/projections/views/readers.ts#L112)).

The local `0.10.10+ase.2` bundle fixes the implicit-source defect in transitions
and the omission of `TransitionUsage` elements from the action graph, reproduced
in the official Toolkit 0.10.10 and tracked in
[upstream issue 13](https://github.com/Open-MBEE/sysml-toolkit/issues/13). Edges
and guards come from the patched Toolkit, without regex reconstruction in the
viewer. The patch, verified bundle and provenance are retained in
[vendor/sysml-toolkit](../../../vendor/sysml-toolkit/README.md). A decision with
no outgoing branch in another projection is still flagged by the page; its
absence does not prove that the branch is absent from the source.

### File highlighting

`GET /api/model/sources/tokens?version=<commit>&path=<chemin>` reads the exact
file from that commit. The `{version, path, legend, tokens}` response contains
the native legend and `{line, start, length, type}` tokens: line and start are
zero-based counts in UTF-16 units, and `type` indexes the legend.

The Toolkit syntax LSP runs in the shared native child process and projection
queue, without a workspace or library attached to the LSP server. The scheduler
preserves FIFO order within each class and gives authoring/checking operations
priority over queued projections. The read does not compile the model. Responses
are conditional through ETag, with a 16-document cache; files are bounded to 256
KiB and responses to 50,000 tokens. A missing path or invalid version is
rejected. Files retains the raw text when highlighting is unavailable, and never
applies tokens from a different version, file or text.

### PlantUML for a view

`GET /api/model/views/plantuml?version=<commit>&view=<id>` returns text produced
by the Toolkit’s `toPlantuml`, as `text/plain; charset=utf-8`. Version and view
are required, with the same strict checks as for the diagram. An unknown view is
rejected before opening a session.

The read is triggered on demand, without generation alongside the list or
diagram. The reader computes a SHA-256 digest of the text for the ETag; a
successful response is immutable for that commit and view. The client panel
supports copy and download; it does not execute a PlantUML engine.

## Cache and version

### HTTP headers

All responses carry `x-content-type-options: nosniff`.

| Response                                                | `cache-control`                       | `etag` | `x-model-version` |
| ------------------------------------------------------- | ------------------------------------- | ------ | ----------------- |
| With `version`: board, matrix, views, diagram, PlantUML | `public, max-age=31536000, immutable` | Yes    | No                |
| With `version`: attention                               | `no-cache`                            | Yes    | No                |
| Without parameters (head)                               | `no-store`                            | No     | Yes               |
| Error                                                   | `no-store`                            | No     | No                |

The ETag is the digest in quotation marks. With `version`, an `If-None-Match`
that names it (alone, in a list, as `*` or in weak `W/` form) receives `304`
with no body and the same cache headers. A head read ignores `If-None-Match`. An
absent or non-string digest, or one outside `[A-Za-z0-9:_-]{1,128}`, never
becomes an ETag: the response remains `no-store`
([versioned-json.ts:23](../../../src/adapters/in/http/versioning/responses.ts#L23)).

Attention is not immutable. Its body depends on doctor masks, read again on each
request, and may contain a temporary unavailability item. The browser therefore
revalidates it every time. A mask changes the items, and therefore the ETag
([attention.ts](../../../src/adapters/in/http/model/attention.ts)).

### Digests

| Route     | Digest (ETag source)                                                              |
| --------- | --------------------------------------------------------------------------------- |
| Board     | `meta.digest`: SHA-256 of `{columns, links, index}`. `meta.timingMs` is excluded. |
| Matrix    | `digest`: the body’s `executionDigest`, without `model.name`.                     |
| Attention | `digest`: SHA-256 of `{version, items}`.                                          |
| Views     | `digest`: SHA-256 of `{toolkit, views, diagnostics}`.                             |
| Diagram   | SHA-256 of `{toolkit, view}`, outside the body.                                   |
| PlantUML  | SHA-256 of the text.                                                              |

For the board, the same sources produce the same digest. The list and diagram
digests are computed once per projection, never per request.

### Process caches

A service caches each commit’s projection. Concurrent reads of the same key
share one computation. A failure is removed: the next read recomputes it. Above
capacity, the least recently read key is evicted, never an ongoing computation
([versioned-read.ts:25](../../../src/application/model/projections/versioned-read.ts#L25)).

| Service                   | Key             | Capacity |
| ------------------------- | --------------- | -------- |
| `ModelBoardService`       | Commit          | 16       |
| `AuthorityMatrixService`  | Commit          | 32       |
| `ModelViewListService`    | Commit          | 16       |
| `ModelViewDiagramService` | Commit and view | 32       |

`AuthorityMatrixService` rejects a matrix that does not carry the requested
version (`MODEL_VERSION_MISMATCH`,
[authority-matrix.ts:22](../../../src/application/governance/authority-matrix.ts#L22)).
`ModelAttentionService` caches nothing: it recomposes the list on each read from
the other services’ caches. It only retains the latest count per version for the
event (32 versions).

### Retained timeouts

The service does not cache a failure. After a `TOOLKIT_TIMEOUT`, the reader
retains it for 30 seconds per version (per version and view for a diagram), for
at most 16 keys. During that time, it responds without calling the Toolkit, with
the remaining delay in `context.retryAfterMs`
([toolkit-versioned-reader.ts:8](../../../src/adapters/out/sysml-toolkit/projections/versioned-reader.ts#L8)).

The matrix makes an exception for a projection that has not started: it is not
retained. The error then carries `started: false` and `retryAfterMs: 1000`
([toolkit-versioned-reader.ts:62](../../../src/adapters/out/sysml-toolkit/projections/versioned-reader.ts#L62)).

## Errors

An error always has the shape `{code, context, recovery}`, with
`cache-control: no-store`. `code` uses uppercase letters, digits and
underscores, at most 64 characters: clients read the code, not the sentence.
`recovery` is the host’s instruction, in English.

`context` contains `version` (or `selection: "head"` if the head has not been
read), `message` when present, then error-specific context. A missing or
malformed code is replaced with the route’s default code. Without `recovery`,
the host provides one based on the code
([versioned-json.ts:80](../../../src/adapters/in/http/versioning/responses.ts#L80)).

Status follows from the code, in this order:

1. The route’s default code, `INVALID_REPOSITORY` or a code beginning with
   `INVALID_PROJECTION_`: `500`.
2. A code ending with `NOT_FOUND`: `404`.
3. A code ending with `TIMEOUT`, `UNAVAILABLE` or `UPSTREAM_FAILURE`: `502`.
4. Another code beginning with `INVALID_`: `400`.
5. Anything else: `500`.

The default code is `MODEL_BOARD_FAILED`, `AUTHORITY_MATRIX_FAILED`,
`MODEL_ATTENTION_FAILED` or `MODEL_VIEWS_FAILED`, depending on the route.

`TOOLKIT_TIMEOUT` and `PROJECTION_QUEUE_UNAVAILABLE` add `Retry-After`, in
seconds, equal to `context.retryAfterMs` rounded up to the next second.

| Code                                                       | Status | Cause                                                                                                     |
| ---------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `METHOD_NOT_ALLOWED`                                       | 405    | A method other than `GET`. `Allow: GET` header. `context.method`.                                         |
| `INVALID_REQUEST`                                          | 400    | Rejected parameter set, or empty `view`. `context.parameters`.                                            |
| `INVALID_VERSION`                                          | 400    | `version` is not an immutable commit. `context.version`.                                                  |
| `NOT_FOUND`                                                | 404    | The commit does not exist, or the repository is uninitialised. `recovery` points to `/api/model-history`. |
| `VIEW_NOT_FOUND`                                           | 404    | `view` is not in the list for this commit. `context.view`.                                                |
| `INVALID_REPOSITORY`                                       | 500    | The commit’s Git snapshot is missing or tampered with.                                                    |
| `TOOLKIT_TIMEOUT`                                          | 502    | Deadline exceeded. `context`: `timeoutMs`, `started`, `retryAfterMs`.                                     |
| `PROJECTION_QUEUE_UNAVAILABLE`                             | 502    | Matrix queue full. `context`: `retryAfterMs`, `queued`, `limit`.                                          |
| `TOOLKIT_WORKER_UNAVAILABLE`                               | 502    | The native Toolkit child process failed or stopped.                                                       |
| `TOOLKIT_VIEW_API_UNAVAILABLE`                             | 502    | Toolkit does not expose `toGraph`, `viewInfo` or `outline`.                                               |
| `PROJECTION_PROCESS_UNAVAILABLE`                           | 502    | The matrix process failed: error exit, unread input or launch failure.                                    |
| `TOOLKIT_BUNDLE_DRIFT`                                     | 500    | The Toolkit bundle no longer matches its pinned fingerprint.                                              |
| `MODEL_BOARD_TOOLKIT_FAILED`, `MODEL_VIEWS_TOOLKIT_FAILED` | 500    | Toolkit failed without its own code. `context.message` and `context.diagnostics` provide details.         |
| `MODEL_VERSION_MISMATCH`                                   | 500    | The projection does not describe the requested commit.                                                    |
| `INVALID_PROJECTION_INPUT`, `INVALID_PROJECTION_PROVIDER`  | 500    | The compiled artefact exceeds bounds, or its engine is unsupported.                                       |
| `SOURCE_COORDINATE_MISMATCH`                               | 500    | Compiled coordinates do not match the pinned sources.                                                     |

On the attention route, a source infrastructure failure becomes an item (see
above), rather than one of these errors.

## `model-version` event

The host sends the `model-version` event on `GET /api/events`
([main.ts:696](../../../src/main.ts#L696)). It uses the same stream as `state`,
`conversations` and `cases`. A client receives it on connection, then on every
change.

```json
{
  "head": "commit:IDENTIFIANT",
  "sourceDigest": "DIGEST_DES_SOURCES",
  "proposals": { "pending": 1, "digest": "DIGEST_DU_JOURNAL" },
  "attention": { "count": 3 }
}
```

[`ModelVersionEvent`](../../../src/application/model/revisions/version-events.ts#L9):

- `head` is the admitted head, never the version of an isolated proposal.
  `sourceDigest` is its source digest.
- `proposals.pending` counts `preparing`, `proposed` and `accepting` proposals.
  `proposals.digest` is the SHA-256 of all journal proposals, sorted by
  identifier: `id`, `status`, `sourceDigest`, `proposalVersion` and
  `acceptedVersion`.
- `attention.count` is the `count` from `GET /api/model/attention` for `head`,
  as computed. The field is optional. **Its absence does not mean zero**: the
  count is unknown, and the client reads the route.

The host rebuilds the event after every observed repository transition
(initialisation, proposal, acceptance, refusal, publication or source update)
and after an adoption. It sends the event only when it differs from the previous
one: a comment without an effect on the model or journal remains silent
([model-version-events.ts:106](../../../src/application/model/revisions/version-events.ts#L106)).
If a connection’s initial read fails, only this event is omitted.

Building the event never waits for attention computation. If the count for
`head` is not ready, the host omits it, starts the computation in the background
and publishes a second event with `attention` when ready. Only one follow-up is
started per version. A failed computation is logged, and a later event may
restart it
([model-version-events.ts:83](../../../src/application/model/revisions/version-events.ts#L83)).
A count containing an `ATTENTION_SOURCE_UNAVAILABLE` item is not retained: the
field remains absent.

After a successful `POST /api/model/diagnostics/masks`, the head has not moved
but the count has changed. The host recomputes attention in the background, then
publishes again ([main.ts:283](../../../src/main.ts#L283)).

## `case-model-version` event

A Case's pages follow its own model over the same `GET /api/events` stream. A
stream opened with a Request session joins its owner's audience; a stream
without one, or whose session is no longer valid at delivery, receives none of
these events
([case-model-events.ts](../../../src/composition/case-model-events.ts)).

```json
{
  "schemaVersion": 1,
  "caseId": "CASE_ID",
  "branchVersion": "commit:IDENTIFIANT",
  "executionVersion": "commit:IDENTIFIANT"
}
```

The payload carries versions only, as an unversioned Case scope read would tell
them, and both sides validate its exact keys
([case-model-notifications.ts](../../../src/application/work/request-spaces/case-model-notifications.ts)).
The host reads a Case again after a successful Request write that answers for
it, after a committed adoption is restored in its runtime, and after its
operator's turn settles. It sends the event only when the Case's versions differ
from the last ones sent (the first observation in a process is sent), and only
to the Case owner's streams.

The workbench handles it in one place: it reads that Case's held scope again
without dropping it, and tells the Case's own model-live signal
(`caseModelLive`), which the Case boundary passes to its pages. Without a
version in the address, a Case's System and Model pages read its executing
version and follow that signal, as the main pages follow `model-version`. A new
Request session reopens the stream; a reconnection reads the shown Cases again.

## Execution

### Toolkit child process: board, views, diagrams, PlantUML and tokens

A shared scheduler executes the host's Toolkit operations in a native Deno child
process. It handles compilation, checking, queries, descriptions, targeted edits
and projections, one operation at a time. The child owns the Rust N-API addon,
its prepared library and native sessions; the parent exchanges requests and
results over versioned NDJSON on standard input and output.
`node:worker_threads` remains only a test-fixture transport, not the production
host. See the
[native process endpoint](../../../src/infrastructure/native/process-client.ts).

The scheduler preserves FIFO order within each class. Operations other than
projections take priority over queued projections, while each waiter retains its
total deadline
([worker-client.ts](../../../src/adapters/out/sysml-toolkit/worker-client.ts)).
The following bounds apply to board, views, diagrams, PlantUML and token reads:

| Bound                | Value                                                      | Scope                                                                                               |
| -------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Total deadline       | 15 s                                                       | Queue wait and execution (`SYSML_TOOLKIT_TIMEOUT_MS`).                                              |
| Projection execution | 3 s                                                        | Once started: board, views, diagram, PlantUML and tokens (`SYSML_TOOLKIT_PROJECTION_EXECUTION_MS`). |
| Queue length         | No configured count limit in this shared Toolkit scheduler | A request that waits too long expires with `TOOLKIT_TIMEOUT` and `started: false`.                  |

An active operation that exceeds its deadline causes the child process to be
terminated; its exit is observed before a replacement is dispatched. An expired
waiter does not interrupt the active operation. Reading the Git commit precedes
Toolkit queueing: it is not counted in the 15 seconds. The child loads the
pinned native Toolkit bundle and verifies its fingerprint again on every load.
See [local SysML tools](toolkit-local.md).

### Matrix process

The matrix does not use the shared Toolkit child process. It projects the
compiled artefact without compiling or opening a Toolkit session. Each
projection runs in a disposable Deno process
([authority-matrix-worker-client.ts:173](../../../src/adapters/out/sysml-toolkit/projections/authority-matrix/worker-client.ts#L173)).
Its queue is independent from the Toolkit queue: a slow matrix does not delay a
proposal.

| Bound               | Value                                                                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Total deadline      | 15 s, including queue wait and execution.                                                                                                                                                                      |
| Execution           | 10 s once started. Includes Git reads, validation and projection ([line 34](../../../src/adapters/out/sysml-toolkit/projections/authority-matrix/worker-client.ts#L34)).                                       |
| Queue               | One active projection and three queued ([line 27](../../../src/adapters/out/sysml-toolkit/projections/authority-matrix/worker-client.ts#L27)). The next fails immediately with `PROJECTION_QUEUE_UNAVAILABLE`. |
| Memory              | 512 MiB V8 heap ([line 26](../../../src/adapters/out/sysml-toolkit/projections/authority-matrix/worker-client.ts#L26)).                                                                                        |
| Process permissions | `--allow-read --allow-env`, without prompting.                                                                                                                                                                 |
| Artefact elements   | At most 20,000.                                                                                                                                                                                                |
| Transfers           | 32 MiB input, 8 MiB output, 64 KiB standard error.                                                                                                                                                             |

The process terminates after each projection. It receives the artefact through
standard input. Before projecting, it checks these three points
([process.ts](../../../src/adapters/out/sysml-toolkit/projections/authority-matrix/process.ts)):

- The source digest, recomputed inside the process, equals the pin that the host
  read separately from Git, otherwise `MODEL_VERSION_MISMATCH`.
- The artefact provider is the Toolkit compiler (`sysml-toolkit`), in
  `ase-toolkit-normalized-json-v1` format, and its version equals the engine’s.
  This engine is at least `0.10.10`: it need not equal the running engine.
  Otherwise `INVALID_PROJECTION_PROVIDER`.
- Executable units belong to the version and project, otherwise
  `MODEL_VERSION_MISMATCH`.

## Startup warm-up

Once the server is listening, the host starts four head reads
([main.ts:779](../../../src/main.ts#L779)). They start together without waiting
for one another:

| Read             | Effect                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| Board            | Fills the board cache.                                                                                |
| Attention        | Also fills matrix and board caches. A ready count can be included in the first `model-version` event. |
| View list        | Fills the list cache.                                                                                 |
| Authority matrix | Fills the matrix cache.                                                                               |

All four share the head read. A failure is logged as a warning and interferes
with neither startup nor the other reads. Diagrams are not warmed up.

## Measurements retained from the 24 October 2026 framing

These measurements are retained from the initial System and Model plan, present
before its reduction in commit `9c44d95`. They concern the models used then; the
plan specifies neither the machine load nor the exact commit of each
measurement. They were not rerun during documentation organisation.

| Read                                 | Retained measurement                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial-model board                  | 493 ms cold, 125 kB, 421 invariants checked, no violation                                                                                            |
| Initial-model matrix                 | 2,413 ms cold; 2 rows, 28 columns, 38 cells; 78 coordinates checked; `MEMORY_REVIEW_UNREACHABLE` and `REVISION_FLAG_WITHOUT_EDIT_POLICY` diagnostics |
| All demo-snapshot graphs             | 421 to 653 kB; reason to serve graphs on demand rather than all together                                                                             |
| Repeated board before handle release | RSS observed at 453 then 1,026 MB; the current test over thirty warm reads bounds its growth to 128 MiB                                              |

These numbers document cache, on-demand read and resource-release decisions.
Current contracts are those described above; any new qualification must name its
model, version and load.

## Outside these routes

The element → views index remains open. Work is proposed to revisit the
three-second projection bound.

The SysML page retains a warning for decisions with no outgoing branch and a
link to their versioned source.
