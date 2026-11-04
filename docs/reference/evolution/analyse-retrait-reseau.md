# Network Impact consultation across versions

`ase-network-impact-v1` compares a native operator O's two direct network routes
to an exact host H: web reading and HTTPS skill installation. It retains every
first-parent transition between two commits, including a temporary withdrawal
followed by restoration. Removing H from the web scope leaves the independent
skill policy visible.

The maintained entry point is the bounded `consult_model` operation. It belongs
to the consultation of large models and retains the native index references
without establishing global acceptance or changing their proposed priority.
There is no dedicated UI.

The offline JSON CLI and its closed DuckDB file reader were retired on 29
October 2026 as part of PG-5. The live consultation remains available through
host-selected PostgreSQL owner handles. Historical reports and fixture data are
preserved; the former command is no longer supported.

## Inputs and bounds

The project must already contain its Assembly Git repository and historical
build bytes in the vault. Endpoints must be immutable
`commit:<40 lowercase hexadecimal characters>` identities. O is the exact native
builder ID; a display name is insufficient. H must be an exact canonical public
DNS host, without a URL, port, wildcard or trailing dot.

The host supplies technical limits; requests cannot choose evidence files or
raise those limits. Missing or unavailable authorized evidence produces explicit
issues. Consumers must inspect coverage even when the comparison returns a
result.

| Limit             | Default | Technical ceiling |
| ----------------- | ------: | ----------------: |
| `maxVersions`     |      32 |               128 |
| `maxSnapshots`    |      64 |               256 |
| `maxRecords`      |  10,000 |            50,000 |
| `maxPayloadBytes` |  16 MiB |            16 MiB |
| `maxTotalBytes`   | 128 MiB |           256 MiB |
| `timeoutMs`       |  30,000 |           300,000 |

These limits are protections, not latency or retention commitments. The analysis
service forwards its deadline and caller cancellation to its readers. Native
synchronous instructions already in progress cannot be preempted midway;
asynchronous steps check cancellation.

## Agent consultation

An admitted operator with model consultation permission can use
`operation: "network_impact"` when that capability is exposed in
`context.modelTools`. The host chooses the evidence sources and technical
ceilings. Source-reading permission alone is not execution-history authority.
This increment covers only the calling operator's own history; `operatorId` must
equal the admitted caller's exact native builder ID. A Main Operator has no
exception for another operator's history.

The initial comparison uses the current request's consultation pin in `version`,
independently of the immutable historical endpoints:

```json
{
  "operation": "network_impact",
  "version": "commit:cccccccccccccccccccccccccccccccccccccccc",
  "action": "compare",
  "operatorId": "native-operator-id",
  "host": "raw.githubusercontent.com",
  "fromVersion": "commit:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "toVersion": "commit:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}
```

The response contains a bounded summary, counts, coverage and an opaque
`analysisRef`. It does not place the complete report in agent feedback. Follow
that reference with `action: "details"`, the same consultation `version`, and
one of the views `versions`, `transitions`, `witnesses`, `evidence` or `issues`.
A page advertises its total and any `nextCursor`; pass that cursor unchanged
with the same reference and view. Page sizes can shrink to fit the available
response budget. A single item that cannot fit is refused explicitly rather than
truncated into a misleading observation.

References are isolated by project, admitted caller and contract, consultation
pin, request identity and host-resolved evidence scope. They expire and remain
valid only while the same admitted consultation authority is current. Foreign,
expired or stale references are refused before another source read. There is no
agent-selected database path, source list, SQL or history grant.

Live reads use the existing PostgreSQL owner handles. Analysis does not
initialize missing stores or run migrations. Payload sizes and snapshot counts
are checked before materialization. Each source exposes its own available
revision bounds as of its read, plus coverage of the payloads actually
materialized. A budget can leave that materialization partial; `complete` and
issues report this separately from `revisionBounds`. These independently
captured bounds do not assert a cross-store atomic snapshot. Subsequent writes
do not alter the captured result or its pages.

A future extension must let Main inspect several explicitly covered
sub-operators through a dedicated authorization contract. That contract must
bind callers, targets and evidence scopes explicitly; role names and source
permissions cannot supply the grant. That direction is required, but this
increment grants no inter-operator inspection.

## Calculated facts and witnesses

`frames` contains the revisions traversed, their source digest, available build
identity, calculated executable contract digest, paths and guards. These static
frames establish model facts; they do not establish that a contract executed.
The verified compiled artifact passes through production
`validateSourceExecutables`, with no additional SysML parser.

For web reading, the reader establishes the host ceiling, invocation mandate,
active native catalog and URL selection mode. Operational tool bytes and the
actual invocation input remain conditional. For skills, it establishes O's own
policy, its host ceiling and the local native installation exposure. The URL,
received content, installation limits and expected digest remain invocation
conditions. The exposure predicate is shared with `SkillsBehavior`.

Witnesses identify native elements, metaclasses, qualified names and available
source coordinates. Mandate bindings use the exact holder and native mandate
identities; free source text is excluded. Each guard retains at most 128 unique
witness IDs, and each path retains at most 128 deduplicated witnesses. Any
truncation adds `WITNESS_LIMIT`, including the revision and guard or channel
identity, and makes the comparison indeterminate. Coordinates and display names
remain inspectable without turning a source-line shift into a route change.
`consumer` names an implemented consumption link, not a native SysML
relationship. Instruction text is never included.

`transitions` preserves before/after values and paths independently for web and
skills. Changes are `permission-revoked`, `permission-granted`, `route-changed`,
`unchanged` or `indeterminate`. `directAccessAfter` is `possible`, `blocked` or
`unknown` for these two routes only. A conditional route proves neither an
attempt nor receipt.

An unknown historical recipe, unavailable or invalid build, unresolved operator,
missing route or projection failure prevents an established withdrawal
conclusion. Any calculated paths remain inspectable, but the transition is
indeterminate. An empty derived list never proves absence of access.

The inclusive interval follows first parents. When its version budget is
reached, the accessible suffix nearest the destination is returned with
`reason: version-limit`; no artificial endpoint diff skips omitted revisions. If
the starting revision is not on that lineage, the reason is
`from-not-on-first-parent`. Merge parents remain visible as provenance; side
branches are not traversed. Unavailable endpoints leave incomplete coverage and
an explicit issue.

## Observations and joins

The live reader uses authorized PostgreSQL owner handles and bounds snapshot,
record and byte counts before loading payloads. It extracts metadata and
deduplicates observations without mutating their source records. Repeated
messages and events are deduplicated by system, journal kind and record ID.
Divergent representations of one identity produce an issue and lose network
attribution.

`evidenceRead.sources` maps opaque source IDs to `kind` (`state` or `skills`)
and a zero-based `inputIndex` within the host-selected sources. Sources expose
their independent `revisionBounds` and `complete` status. The bounds describe
revisions available as of that source read, not a promise that every payload in
that interval was materialized; limits and issues describe partial reads. Paths
are not exposed. Each evidence item's `sourceIds` retains its originating
sources, including duplicates found in multiple owners; source-specific issues
carry `sourceId`. This preserves a verifiable input mapping after deduplication.

| `kind`                         | What the record establishes                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `network-refused`              | A refusal for H is recorded.                                                        |
| `page-received`                | A structured page result for H is recorded.                                         |
| `attempt-unconfirmed`          | A failure associated with H is recorded without established receipt.                |
| `skill-downloaded`             | The initial operation and immutable HTTPS skill provenance agree for H.             |
| `skill-operation-unattributed` | An operation exists, but its own provenance does not establish its host.            |
| `context-only`                 | A call or flow passage is declared; this context does not establish network access. |

A local bundled installation is not a download. Replaying an invocation creates
no new operation. Reinstalling an immutable skill may retain only its initial
provenance; a subsequent operation does not inherit that download proof.

The network authority holder must be established. A catalog action's performer
is not that holder. The current snapshot's model never substitutes for the
version recorded in evidence. `exact-version` requires O, the recorded version
and contract digest to agree within the calculated interval. A historical
reference outside the interval or an inconsistent reference remains
`unresolved`; it does not trigger an unbounded historical read.

Web evidence containing only a contract digest cannot establish its authority
holder from the contract alone: its recorded version is also required. It
remains unresolved and is excluded from claims attributed to O. In particular,
no current-snapshot actor is substituted to manufacture an O-attributed
`contract-only` match.

Where the exact actor is independently established and only the contract
identity matches, `contract-only` lists compatible revisions without inventing
the observation's version. `policyAtRecordedVersion` remains `unknown` in that
case. Context-only evidence and operations without an attributed host also
retain `unknown`. Exact skill evidence selects the recorded skill host policy,
independently of the web host policy.

A page received under a contract whose permission has since been removed does
not rewrite the evidence or establish a violation: an invocation already started
retains its initial scope. Evidence exposes metadata only: identities, time,
references, host, code and recorded scope. Message text, page content, full
URLs, tool code, skill instructions and secrets are excluded. `startOrder`
remains `unknown`: existing journals establish neither actual HTTP start nor its
ordering against a withdrawal. Redirect hops and failures before journal
persistence are not exhaustively recorded.

## Coverage and qualification

`calculationComplete` requires complete lineage and established facts for both
routes at every traversed revision. `modelReadComplete` and `versionsComplete`
separate those dimensions. `recordsReadComplete` describes reads of configured
evidence sources; an issue or truncation leaves it false. It does not mean that
all real access was journaled. `networkObservationComplete` is always `false`
and `indirectAccess` is `not-covered`. Indirect delegation is outside this path.

The agent integration reuses the running workspace's repository and authorized
owner handles. Analysis starts no recovery, compiler, migration or business
transport. Its verified build reader may refill the existing derived KV cache
from persisted vault bytes after checking their identities. This cache warming
does not rebuild historical models or change immutable sources, rights,
admissions, input journals, digests or N-Quads export rules. Build compatibility
checks are shared with the production backend. This path does not claim a new
qualification of the Oxigraph index.

The controlled qualification in `test/integration/network-impact_test.ts` uses
four model commits compiled with the real Toolkit: web withdrawal, skill
withdrawal and restoration. It persists PostgreSQL snapshots through the owner
handles, records a runner refusal without transport and a page-result journal
fixture, and exercises the real skill service and downloader with simulated
transport, replay and reinstallation. It covers historical or missing
provenance, budgets and a missing build. Git and build-vault input file hashes
are compared. The offline CLI subprocess is no longer part of this
qualification.

To retain the validated four-version JSON report for inspection, set
`ASSEMBLY_NETWORK_IMPACT_QUALIFICATION_REPORT` to an absolute, unused file path
in an existing output directory before running this test. The file is created
exclusively after the input hash checks; default tests retain no report or
corpus. The optional artifact contains report metadata, not page or skill text.

Colocated application tests cover comparisons, joins, independent recorded skill
policy selection, limits and an uncooperative reader stopped by the deadline.
The colocated `live-evidence-extraction_test.ts` preserves complete page-result
checks, consistent refusal metadata, provenance, deduplication, immutable
captures and content exclusion. Live reader tests cover cancellation, timeouts,
source bounds and partial reads; PostgreSQL adapter tests cover persisted
snapshots and their decoding budgets. Model and Git readers retain their own
suites. Run native qualification with explicit
`ASSEMBLY_SEMANTIC_INTEGRATION=1`, `ASSEMBLY_POSTGRES_TEST_URL`,
`SYSML_TOOLKIT_DIR` and `nice -n 15`, following
[CONTRIBUTING.md](../../../CONTRIBUTING.md).

The native consultation qualification in
`test/integration/network-impact-consultation_test.ts` keeps state and skill
stores open while consulting the same four model versions. It checks bounded
summary and detail transport, own-history refusal, source bounds, input
fingerprints and stable pages after subsequent writes. Colocated tests cover
reference isolation, expiry, changed requests and contracts, effective
capability exposure and response budgets.

These test descriptions identify maintained coverage; they are not a claim that
a new campaign has passed. Controlled qualification remains distinct from a user
execution campaign. It establishes neither unrecorded HTTP start, a provider
campaign, universal delegation coverage nor global acceptance of large-model
consultation or of the native index.
