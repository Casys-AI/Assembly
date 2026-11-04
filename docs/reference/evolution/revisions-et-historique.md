# Revisions and history

This reference describes the workbench’s local commands. For usage, see
[revise the system](../../how-to/evolution/reviser-systeme.md). For the
distinction between an admitted model and execution, see
[SysML and execution](../../explanation/execution/sysml-et-execution.md).

## Identities and versions

| Value                                       | Meaning                                                                                                                                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`, `baseVersion`, `expectedVersion` | Immutable reference to a model-repository commit, in the form `branch:<identifiant>` or `commit:<identifiant>`. In a version returned by Assembly, the `branch:` prefix denotes a commit identifier, not the moving name `main`. |
| `sourceDigest`                              | SHA-256 fingerprint of the exact compiled sources.                                                                                                                                                                               |
| `runtime.available`                         | Execution reference compiled from the currently accepted model.                                                                                                                                                                  |
| `runtime.active`                            | Reference to the contract adopted for the instance’s effects.                                                                                                                                                                    |
| `runtime.*.digest`                          | Executable-contract fingerprint; distinct from the source fingerprint.                                                                                                                                                           |
| `runtime.*.repositoryVersion`               | Model commit associated with this execution reference.                                                                                                                                                                           |
| Application `revision`                      | Integer identifying a scoped state stored in PostgreSQL; this number is not a model commit.                                                                                                                                      |

<a id="lecture-du-dépôt-de-modèles"></a>

## Reading the model repository

| Method and path                                         | Result                                                                                                                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/model-sources`                                | `{version, sourceDigest, sources}` for the current model. `sources` is a dictionary of relative paths and SysML contents.                                                         |
| `GET /api/model-sources?version=<version>`              | The same fields for an immutable commit.                                                                                                                                          |
| `GET /api/model-revisions`                              | `{version, sourceDigest, proposals, agentId, runtime}` for the main operator. `runtime` contains `available`, `active`, `executable` and, if contract compilation fails, `error`. |
| `GET /api/model-revisions?agentId=<identité-native>`    | The same repository and proposals; `agentId` and `runtime` refer only to the selected operator.                                                                                   |
| `GET /api/model-revisions/:id`                          | The record for a specific proposal.                                                                                                                                               |
| `GET /api/model-history`                                | `{headVersion, commits, truncated}` for the actual ancestry of `main`, read from an immutable HEAD.                                                                               |
| `GET /api/model-files[?version=<version>]`              | Last commit to change each file present in the requested version (HEAD by default).                                                                                               |
| `GET /api/model-diff?from=<version>&to=<version>`       | Complete textual comparison of two commits’ sources. `from=empty` compares the target with an empty tree.                                                                         |
| `GET /api/model-graph-diff?from=<version>&to=<version>` | Structured comparison of the Git compiled documents for model elements, relationships and endpoints between the same commits.                                                     |

A history commit contains `version`, `parents`, `author`, `message`,
`createdAt`, `sourceDigest`, `parsedAuthor`, `files`, `additions` and
`deletions`. `parsedAuthor` carries `kind` (`owner`, `agent`, `ase`, `host`,
`unknown`) and `ref`. Optional `proposalId` links a proposed or accepted version
to its proposal record. `ModelChangedFile` entries carry `path`, `status`
(`added`, `modified`, `deleted`, `renamed`), `additions`, `deletions` and
`previousPath` for a rename. Git counts are relative to the first admitted
parent, with rename detection (`-M`). `parentVersion` is present when the first
parent also contains a model-source tree. The technical schema root and
unaccepted proposal branches are not presented as published model commits.

`parsedAuthor` is a display aid produced by `parseModelAuthor`. The raw `author`
field remains the attribution reference:

| Raw author                  | `kind`    | `ref`                                                                                                                                                                      |
| --------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local-owner`               | `owner`   | `local-owner`                                                                                                                                                              |
| `local-control`             | `host`    | `local-control`                                                                                                                                                            |
| `ase`                       | `ase`     | `ase`                                                                                                                                                                      |
| `agent:<nativeId>`          | `agent`   | `<nativeId>`, non-empty, without spaces or colons                                                                                                                          |
| `ase:provision-instance-id` | `ase`     | `provision-instance-id`                                                                                                                                                    |
| `ase:<opération>:<id>`      | `ase`     | `<opération>:<id>`; operation among `approved-change`, `activate-candidate`, `record-candidate`, `record-stage-observation`; non-empty identifier without spaces or colons |
| Any other value             | `unknown` | Unchanged raw author                                                                                                                                                       |

`GET /api/model-history?limit=1..200` bounds the number of commits (100 by
default). Unknown parameters, repeated limits and limits outside this range are
rejected with `400`. There is no pagination; `truncated: true` indicates
incomplete ancestry.

History is **read-only**: it computes metadata from Git sources without checking
the `.ase-build.json` snapshot. A tampered or missing snapshot therefore does
not stop `history()` from presenting the commit; `at()` and `current()` remain
authoritative and reject an invalid snapshot. `proposalId` links are read from
the current journal without a write lock, recovery or snapshot reads. They may
change independently of commits. Proposal records are written to a synced
temporary file, then atomically renamed to `.json`; temporary files are ignored.
An unreadable record is omitted with the `PROPOSAL_JOURNAL_RECORD_SKIPPED`
diagnostic. This view may therefore be incomplete; recovery and decisions remain
strict.

`GET /api/model-files` returns `{version, files}` for HEAD;
`?version=commit:<40 hex minuscules>` pins an immutable version. Each entry
contains `path` and `lastChange: {version, createdAt, message}`. The message is
the first line of the commit body, identical to the history message, even for a
multiline reason. An explicit version uses an ETag and immutable caching; HEAD
and errors use `no-store`. A malformed version returns `400`. A missing object
or an object that is not a commit returns `404`, with
`{code, context: {message}, recovery}`.

The diff response contains `fromVersion`, `toVersion`, `fromSourceDigest`,
`toSourceDigest`, `patch`, `files`, `additions` and `deletions`. Each file has
its `path`, `kind` (`added`, `changed`, `deleted`) and line counts. `patch` uses
Git diff format. It compares SysML texts, rather than providing a semantic
diagram diff.

Two file summaries coexist: `ModelChangedFile` (Git history) and
`SourceFileDiff` (text comparison). The mapping is `status: added` →
`kind: added`, `modified` → `changed`, `deleted` → `deleted`. `renamed` has no
single equivalent in `SourceFileDiff`: Git may summarise a pure rename as
`+0/-0`, while the textual diff shows a deletion followed by an addition, with
different totals. Aligning these presentations remains open; their counts are
not interchangeable.

The **Model > Revisions** page displays the selected commit’s textual diff
against its first parent containing model sources, or an empty tree if it has no
such parent. A proposal is compared with its `baseVersion`. **Unified** and
**Split** change the layout of the same diff. The page provides neither free
base selection nor a structured comparison of elements and relationships. Both
diff routes remain available to API clients.

The structured diff compares the compiled documents from the two Git commits,
then presents `ElementV0`, `RelationshipV0` and `EndpointV0` IR documents. Each
change carries its document identity `id`, its SysML identity `nativeId`, its
category and its before/after fields. An endpoint carries the SysML identity of
its owning relationship. Sources, compilation artefacts, build markers and
provenance documents remain outside this diff; model libraries are not filtered
out if they actually changed.

The response carries `engine: "Git"`, `fromVersion`, `toVersion`,
`sourceDigests`, `changes`, exact `counts` and `truncated`. At most one hundred
IR changes are returned. If the list is partial, counts remain complete and
`truncated` tells the client. `from=empty` compares the target version with an
empty set of documents. This API does not correspond to a panel on the current
Revisions page.

Comparisons remain reads. They do not compile sources, accept proposals or adopt
contracts. Acceptance retains its textual merge followed by validation; native
structured graph merging is not yet used to publish the model.

## Release tags and exact source selection

Publication, retained closure and current Request availability are independent
observations. Selected inspection, after existing access checks, may add
view-only `openingAvailability` (`unchecked`, `ready`, `unavailable`) and
sanitized `openingIssues`. List and save do not perform host preflight. A
Release that a Request can start from shows **Ready** in the catalogue and in
its inspection, with a **New Request from this Release** link that preselects it
in the **Start from** selector of the Requests page. The tooltip reads “Ready at
last check”: readiness is never persisted as a grant or continuously live
assurance, and a fresh opening repeats its checks. Skill prerequisite metadata
remains historical dependency evidence, not proof that an exact local bundle is
absent. No second approval, allocation or mutation occurs from reading
readiness. The UX qualification of 30 October 2026 recorded a bounded proof for
one selected published Main Release.

A new Model Release selects an eligible branch and an exact `commit:<40 hex>`
source. The authenticated, scoped local command `POST /api/saved-systems/tags`
accepts `{ "source": { "branch": ..., "sourceVersion": ... } }` and returns
`{ "tags": [...] }` for available tags resolving to that exact source. Each
binding identifies the tag name, raw ref object ID and peeled commit ID. The
inventory is bounded and excludes tags already claimed by a Release; it is not a
general repository tag browser.

`POST /api/saved-systems/save` takes `saveKey`, `name`, `purpose`, `source` and
`tag: { mode: "existing" | "create", name }`. Fresh commands require a tag; a
previously accepted untagged command can be retried unchanged. The server checks
current authority, source visibility and tag binding. A new tag is created
without overwriting an existing ref; the selected source and tag identity remain
part of the same recoverable command. Tag metadata is a publication relation,
not a change to historical manifests or an execution permission.

An accepted Release can remain pending or incomplete until its assets and tag
are confirmed. Inspection reports current tag availability independently from
asset availability. A moved or deleted tag does not retarget the saved source. A
qualifying `TAG_UNAVAILABLE` refusal before tag acceptance can produce a
terminal `conflict` record for the original save key and tag; the record remains
visible. Other errors need not have such a terminal record. Reads never resubmit
a command; explicit retry uses the original key and payload. Historical untagged
records remain readable without a fabricated tag. Request releases remain
constrained to the eligible unchanged B0 base until evolved-source admission and
provenance are separately qualified.

**30 October 2026, current implementation checkpoint:** that B0-only limitation
is the earlier qualified baseline. The current code adds optional versioned
source-admission evidence for the verified current Request source, independent
of execution adoption, while preserving legacy B0 bytes/digests. Accepted exact
commands recover historically after later source movement; new acceptance must
still select the current admitted source. Physical unadmitted Git movement is
not source admission or a replacement selection. Native whole-closure and actual
A1 browser qualification remain pending. Implementation is not acceptance or
deployment.

The UI and persistence changes are implemented locally. This does not establish
owner acceptance or deployment.

## Writing and deciding

The following requests expect `Content-Type: application/json`. Unexpected
fields are rejected.

### Source proposal

`POST /api/model-revisions`

```json
{
  "baseVersion": "branch:<commit-lu>",
  "reason": "Raison de la modification",
  "sources": {
    "configuration.sysml": "<contenu complet du fichier modifié>"
  }
}
```

The admitted model must permit `mayProposeSysmlRevision`. Its execution policy
must also grant model read authority: compilation requires it for revision
authority, with historical policies that omit `mayConsultModel` retaining their
previous read authority. The available contract must already be adopted and the
instance must be idle. Supplied files replace their entire contents in the
specified base; omitted files are retained. The DTO accepts adding a file, but
does not support explicitly deleting an entire file. SysML Toolkit validation
and executable-contract validation precede the reviewable proposal. Response:
`201` and the proposal record.

Statuses are `preparing`, `proposed`, `accepting`, `accepted`, `rejected`.
Transient states allow an interrupted operation to resume.

### Accepting or refusing a design

`POST /api/model-revisions/:id/decision`

```json
{
  "verdict": "approve",
  "expectedVersion": "branch:<main-examiné>",
  "sourceDigest": "<sha256-de-la-proposition-examinée>"
}
```

`verdict` is `approve` or `refuse`. A non-empty `reason` field is optional. The
command requires a `proposed` proposal, its exact fingerprint and the reviewed
current model. An old proposal base triggers a three-way source merge, then full
validation again. A conflict blocks publication. Successful acceptance returns,
among other fields, `accepted: true`, `version`, `sourceDigest`, `runtime` and
**`executionAdopted: false`**.

<a id="adoption-du-contrat-exécutable"></a>

### Adopting the executable contract

`POST /api/model-version/adopt`

```json
{
  "agentId": "<identité-native-de-l’opérateur>",
  "expectedDigest": "<digest-du-contrat-disponible-examiné>",
  "expectedVersion": "branch:<commit-des-sources-examinées>"
}
```

This separate command adopts the chosen operator’s available contract. Response:
`{adopted: true, agentId, runtime}`. Without `agentId`, it targets the main
operator. Without `expectedVersion`, the server pins the commit from its own
inspection; the interface always supplies the explicitly reviewed commit. The
digest and commit are checked again by the runtime control before changing its
contract.

Other operators retain their admitted contracts and source pins. The workspace
reserves commands during preparation, targeted adoption and reconciliation; new
worker authority never follows from the main operator’s digest alone. Source
acceptance and contract adoption are not interchangeable.

In **Model > Revisions**, **Put in service** appears below the `main` commit for
operators whose available contract is executable and differs from the active
contract. The control names the targeted operator; if there are several,
**Operator** selects among them. This choice concerns adoption only and filters
neither history nor proposals. Conversations without a runtime
(`runtimeOwned: false`), including recorded audit threads, are excluded. A
read-only peer session may own a runtime: being “read-only” alone therefore does
not exclude it.

The `running` marker comes from `runtime.active.repositoryVersion`, for each
operator whose runtime has been read. It may remain on an earlier commit if a
source revision did not change the executable digest: the interface then offers
no adoption. A runtime read error is shown as such, without assuming the
operator uses `main`.

### Deciding on a mandate revision proposed in chat

`POST /api/conversations/:agentId/changes/:changeId/decision`

```json
{
  "expectedRevision": 42,
  "configurationRevision": 2,
  "verdict": "approve"
}
```

Here, `expectedRevision` is the conversation revision and
`configurationRevision` is the base revision of the proposal. A decision in a
Request adds `?space=requests` and a `caseId` to the body (see
[Cases](../operateurs/cases.md#reading-and-talking-to-a-request-in-its-space)).
For this governance command, approval applies the bounded native change, rereads
and validates the model, then adopts the new configuration before any chat
resumes. This specialised workflow differs from generic SysML file acceptance
above. The historical `POST /api/decisions` route with `kind: "change"` remains
a local control; the card in the chat no longer calls it. The change, its diff
and the recorded receipt are described in
[Operator authority](../operateurs/autorite-des-operateurs.md#proposition-diff-et-décision-humaine).

Decisions are local controls. They do not authenticate a human identity. POSTs
whose `Origin` differs, or whose `Sec-Fetch-Site` is `cross-site`, are rejected.

## Application history and views

| Method and path                               | Result                                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /api/state`                              | Current state: conversation, configuration, operators, mandates, candidates and events.                           |
| `GET /api/history`                            | `{currentRevision, revisions}`; each entry describes a recorded revision and whether its projection is available. |
| `GET /api/history/:revision`                  | `{state, projection}` for the recorded state; `404` if absent.                                                    |
| `GET /api/events`                             | SSE stream of application states.                                                                                 |
| `GET /model?page=revisions`                   | Revisions page, with Commits and Proposals lists.                                                                 |
| `GET /model?commit=<version>`                 | Selects a commit, compared with its first parent containing model sources.                                        |
| `GET /model?proposal=<id>`                    | Selects a proposal, compared with its base.                                                                       |
| `GET /model?modelVersion=<version>`           | Read-only Fresh page for a commit’s model, without following present events over SSE.                             |
| `GET /api/model-graph?modelVersion=<version>` | Native JSON projection used by this page; no current activity is added to the declared scenario.                  |

`/revisions` remains an alias for the Model place. The historical `from`
parameter no longer selects the base displayed on the Revisions page; use the
diff API routes to compare two arbitrary versions.

Git stores sources, build descriptors and commits; the build store/vault retain
the compiled bytes. PostgreSQL stores accepted application states and recorded
projections. History covers observations persisted by the application; it cannot
reconstruct an event that the host never recorded.

### Projection and activity fingerprints

`GET /api/model-graph` supplies the current projection; the `revision=<numéro>`
parameter queries a recorded state. Two fingerprints remain independent:

- `projectionDigest` identifies the native projection and its configuration and
  catalogue annotations. It excludes the conversation journal. This presentation
  fingerprint is distinct from the Git source version and the admitted
  execution-contract digest.
- `activityDigest` identifies the observed activity window added to the read
  result in `graph.executionSequences`. A message may change this fingerprint
  without changing the native projection fingerprint.

The `GET /api/model-events` stream distinguishes `model` and `model-activity`
events. A journal change updates the feed; it does not rebuild other diagrams
whose native fingerprint is unchanged. A `model` event is also sent on recovery
from a read error.

New projections recorded in PostgreSQL do not duplicate the journal in their
graph. A historical query enriches a copy from the recorded state, preserving
the stored projection’s exact digest. Older snapshots that already included
activity are not rewritten: `projectionDigestScope: "legacy-with-activity"`
reports this provenance in the response and interface. New captures use the
`"native"` scope.

## Limits and errors

| Check                              | Limit                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| HTTP body for revision commands    | 8,500,000 bytes                                                                                |
| Source-proposal or decision reason | 4,000 characters                                                                               |
| Compiled source tree               | 1 to 64 files; 1 MiB per file; 8 MiB total                                                     |
| Source path                        | Relative, `.sysml` extension, at most 240 characters; no `.` or `..` segment or case collision |
| Diff computation                   | 1 second total; maximum edit length 20,000 per computation; patch at most 2 MiB                |
| Native structured diff read        | At most 10,000 changed documents; 100 IR changes displayed; synthetic empty base               |

Exceeding a diff limit produces an error; no partial result is presented as a
complete comparison.

For revision commands, `400` indicates rejected input or validation, `403` a
rejected origin or permission, `404` a missing reference, `409` a stale version,
conflict or running execution, `413` an oversized body, `415` an incorrect
content type and `502` an upstream failure reported by the repository.

Writes to the same database pass through a shared Assembly writer, queue and OS
lock. Every writer for that database must use the same `semantic-model`
directory. External writes that bypass this lock are not covered by this
guarantee.

Contract sources:
[HTTP controller](../../../src/adapters/in/http/model/revisions.ts),
[repository](../../../src/adapters/out/git/repository.ts),
[identities and authors](../../../src/domain/model/records/revision.ts),
[Revisions page](../../../frontend/components/model/revisions/RevisionsPage.tsx),
[versions put in service](../../../frontend/lib/model/revisions/history.ts),
[compiler](../../../src/adapters/out/sysml-toolkit/compilation/compiler.ts),
[diff](../../../src/application/model/revisions/source-diff.ts),
[HTTP routes](../../../src/adapters/in/http/app.ts),
[composition root](../../../src/composition/root.ts).
