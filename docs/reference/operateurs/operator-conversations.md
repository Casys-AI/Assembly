# Operator conversations and tools

These contracts expose the operator sessions declared by the admitted model.
Reading them does not start an agent. Types are defined in
[`conversations.ts`](../../../src/domain/work/records/conversations.ts); local
transport is implemented by
[`conversations.ts`](../../../src/adapters/in/http/work/conversations.ts).

## Reads

| Route                     | Response                |
| ------------------------- | ----------------------- |
| `GET /api/conversations`  | `ConversationsSnapshot` |
| `GET /api/operator-tools` | `OperatorToolsSnapshot` |

Both routes reject query parameters. Their JSON responses carry
`Cache-Control: no-store`.

`ConversationsSnapshot` contains:

| Field            | Type and meaning                                               |
| ---------------- | -------------------------------------------------------------- |
| `systemId`       | Identity of this workbench's main session                      |
| `defaultAgentId` | Operator selected by default                                   |
| `version`        | Read identity of the aggregate; this is not a command revision |
| `conversations`  | Array of the conversations described below                     |

Each conversation has the following fields:

| Field                    | Type and meaning                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `agentId`, `nativeId`    | Native identities of the operator                                                             |
| `name`, `responsibility` | Label and instruction from its admitted contract                                              |
| `primary`                | Identifies the main point of contact                                                          |
| `canSend`                | Permission to send a human instruction in this thread                                         |
| `runtimeOwned?`          | `true` for an executable session; `false` for a recorded review audit without its own session |
| `readOnlyReason?`        | Explanation for a thread without human input                                                  |
| `revision`               | Integer revision of this session, used by commands                                            |
| `busy`, `phase`          | Activity and current state of the session                                                     |
| `messages`               | Messages recorded in this session                                                             |
| `modelDigest`            | Digest of the executable contract admitted by this operator                                   |
| `repositoryVersion?`     | Immutable source version corresponding to that contract                                       |

A reviewer audit thread may appear in this aggregate. It presents recorded
review traces and does not allow human input.

`OperatorToolsSnapshot` contains `systemId`, `version` and `tools`. Each `tools`
entry contains `agentId`, `agentName`, its session's `revision` and its complete
`candidate`. An occurrence is keyed by the pair `(agentId, candidate.id)`:
identical names or digests do not merge tools belonging to two owners. This
aggregate includes candidates at different construction stages; it does not mean
that they are all callable.

The existing SSE stream `GET /api/events` emits a `conversations` event
containing the same `ConversationsSnapshot`, when opened and whenever changes
occur. The aggregate version can invalidate the catalog read. There is no
additional SSE stream per agent.

Independent Requests use the same stream with a private advisory event:

```text
event: request-conversations-invalidated
data: {"schemaVersion":1,"caseId":"<request-id>"}
```

The host resolves the Request's owner and revalidates the receiving session
before delivery. The event contains no messages or execution permission. The
host closes only the affected stream when its session is explicitly invalid,
allowing the existing reconnection and session-recovery paths to run. A
temporary lookup failure grants no access and does not close other sessions. The
client rereads `GET /api/conversations?caseId=<request-id>` under its current
session for an actively displayed Request or an open Request supplying Dock
decisions. An unheld identity can refresh the scoped collection, but does not
directly trigger a conversation read.

Notifications follow persisted runtime changes, including recorded progress and
failure; they do not represent uncommitted LLM tokens. On reconnection or when
the browser comes back online, the client reconciles its held conversations and
Request collection. Returning online does not renew an already-ready session or
require another event stream. This is current-state recovery, without a durable
SSE replay journal or periodic conversation polling.

<a id="commandes-humaines"></a>

## Human commands

`POST /api/conversations/{agentId}/messages` receives:

```json
{
  "text": "Consigne destinée à cet opérateur",
  "expectedRevision": 12
}
```

`text` must be nonempty after leading and trailing whitespace is removed. The
supplied string is limited to 100,000 UTF-16 units (`String.length`) before
trimming; the forwarded text is `text.trim()`. See the
[text limits](../developpement/bornes-de-texte.md).

Two optional selections are mutually exclusive: `newConversation: true` opens a
new Case; `caseId` resumes a Case. `caseId` contains at most 256 UTF-16 units,
with no leading or trailing whitespace, `/` or control character. Without a
selection, the message targets the permanent design conversation. General input
requires `canSend: true`; a person may also continue an open Request owned by
the operator by supplying its `caseId`. The application checks the revision and
reserves the session before submitting the message to the normal engine.

`POST /api/conversations/{agentId}/decisions` expects exactly:

```json
{
  "candidateId": "identite-du-candidat",
  "candidateDigest": "digest-exact-du-candidat",
  "expectedRevision": 12,
  "verdict": "approve",
  "reason": "Justification de la décision"
}
```

The verdict is `approve` or `refuse`. The reason contains 1 to 2,000 characters.
The candidate must belong to the targeted operator and retain the digest that
was read. The decision enters that operator's existing admission control:
`canSend: false` alone does not block human admission provided for by its model,
and `canSend: true` grants no admission right.

These commands require an `application/json` object with no extra fields and a
nonnegative integer revision. The body is limited to 524,288 bytes. An admitted
command responds with `202` and `{"accepted":true}` and, for a message selecting
a Case, its `caseId` when returned by the application. This response does not
assert that the work is complete.

| Status | Reasons for rejection by the conversations transport           |
| ------ | -------------------------------------------------------------- |
| `400`  | Malformed JSON, fields, identity, text or revision             |
| `403`  | Foreign origin or human input not exposed                      |
| `404`  | Owning operator or candidate absent                            |
| `405`  | Incorrect method; the `Allow` header gives the expected method |
| `409`  | Busy session, stale revision or changed candidate              |
| `413`  | Body too large                                                 |
| `415`  | Incorrect content type                                         |

Errors are returned as `{"error":"…"}`. A stale revision requires a fresh read;
the transport does not replay the command automatically. Origin checks are local
and do not authenticate a human identity.

Mandate-change and operator-creation proposals have their own decision route:
`POST /api/conversations/:agentId/changes/:changeId/decision`. Their revisions,
provenance and Request resumption are described in
[Operator authority](autorite-des-operateurs.md#proposition-diff-et-décision-humaine).

## Inspecting and adopting a contract

`GET /api/model-revisions?agentId={agentId}` retains the global proposals and
source version, but inspects the requested runtime. Its `runtime` property
distinguishes `active`, `available` and `executable`. Without `agentId`, the
target is the main runtime.

`POST /api/model-version/adopt` accepts:

```json
{
  "agentId": "identite-native-de-l-operateur",
  "expectedDigest": "empreinte-executable-lue",
  "expectedVersion": "branch:version-immuable-lue"
}
```

`expectedDigest` is required. `agentId` and `expectedVersion` are optional for
compatibility; supplying the source version that was read makes the target
explicit. Adoption checks the available contract and its version before changing
the targeted session. An unknown identifier is rejected. A busy session or a
version different from the one inspected is rejected with `409`.

Adopting the main contract does not admit the other operators' contracts. A
decision on a source proposal, its merge and executable adoption remain separate
operations. See
[Concurrent revisions between operators](../evolution/multi-agent-revisions.md).

## Work and reuse between operators

Work between operators goes through an admitted `BehaviorAccess` to a native
`AssemblyWork::AgentInbox` occurrence, with the closed input `{text: String}`.
There is no HTTP route for freely sending work to an agent by choosing its name.
The engine retains the caller, target, correlation, invocation and model
version. The recipient receives the objective; the histories of other
conversations are not forwarded to it.

The work receipt has a `completed`, `waiting` or `failed` status, along with the
revision, recipient version, messages and candidate identities associated with
that contribution. A `waiting` receipt remains a wait even when the transport
call has returned. Dependency execution and explicit resumption are described in
[Closed work plans](../execution/work-plans.md).

The receipt may also carry `artifacts`, limited to the candidates from this
contribution. These observations retain their tests, admission, provenance and
native version; they grant no invocation right to the receipt's recipient.
`completed` closes a technical contribution: the returned content must still
establish whether its objective was met.

An admission decision can resume the native continuation that still belongs to
this work. The journal then records a new correlated receipt, limited to that
continuation's messages. Explicit plan resumption rereads this receipt without
resending the objective. Several decisions may be needed before the work ends.
An interruption without a final receipt produces a failure, not a success
inferred from the presence of an active tool. A new human or forwarded
contribution can supersede the earlier suspended work; their messages are not
mixed.

The `AssemblyWork::ListPublishedTools` and `AssemblyWork::ReuseTool` occurrences
must also be allocated and exposed by the admitted sources. The former takes
`{}` and returns descriptors of the artifacts that are actually active:
`sourceAgentId`, `candidateId`, `digest`, `name`, `description` and `kind`. The
latter takes exactly `{sourceAgentId, candidateId, digest}`.

Import preserves the source artifact's bytes and digest, with its provenance,
but creates a local candidate. Recipient testing, admission and activation
remain necessary. Reading the catalog and seeing a tool in the interface
transfer neither a mandate nor network rights.

## Context provided to an operator's judgment

`admittedModelVersion` identifies its actually admitted contract.
`sourceProposals` contains the current native statuses of its own proposals
only, including `acceptedVersion` when present. Source acceptance remains
separate from contract adoption. Two different source versions may retain the
same executable digest.

`modelSources.publishedRevisions` accompanies the accepted-source snapshot. It
contains at most 32 commits from the main lineage and 64 associations with
accepted proposals. The bounds are announced by `limit` and `proposalLimit`, and
`truncated` signals an omission. Each commit retains its version, digest, author
and date, with `proposals: [{id, author}]` when one or more accepted proposals
correspond to it. No other still-pending private proposal is exposed. An
identifier's absence from the operator's own proposals therefore does not deny
its publication in the shared model. This publication does not replace adoption
of its contract.

`activeTools` describes only its locally invocable catalog. `artifacts` adds
local observations of tests and admission, without the code. `localStage` is the
recorded state; `activationConfirmed` also requires native confirmation of the
exact artifact and its bytes. Receipts from other operators are correlated
observations, not an extension of this catalog.

The technical evidence in `execution.sourceIds` remains in the retained journal.
It is removed from the copy of messages provided to judgment; the digest,
action, source version and correlations are preserved.

## Claude provider budget

Output budgets (`ANTHROPIC_DECISION_MAX_TOKENS`) and effort (`ANTHROPIC_EFFORT`)
are described in
[decision transport to the Claude API](../execution/transport-claude.md#configuration).

## Publishing an approved change

A mandate-change proposal remains `pending` until Git publication. The
`authorityExercise` receipt, base, adopted pin and decision date are retained in
the canonical `ASE-Approval` trailer, before `ASE-Author`. The
`refs/ase/approved-changes/<id>` reference is created in the same transaction as
the admitted branch advances; it indexes the commit that serves as proof.

Startup, a new proposal and a decision reconcile publications not yet present in
local state. The lookup uses the reference or, if missing, an unbounded Git
search on the author trailer. No source transformation is replayed. Closure
retains the published receipt and adopts the model only if the current pin is
still the one in the receipt. Any subsequent adoption or revocation is
preserved.

Without a commit, an error leaves the proposal available for refusal. With a
commit, refusal fails with `PUBLICATION_ALREADY_APPLIED` and requests a reload
(`reload`). Old approvals with incomplete journals are closed when their commit
is found; otherwise they return to `pending` and their journal is removed. There
is no longer a separate command to resume approval.
