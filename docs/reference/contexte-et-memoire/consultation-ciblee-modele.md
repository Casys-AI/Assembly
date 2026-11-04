# Targeted SysML model consultation

This reference describes progressive model consultation by an operator preparing
a revision. It distinguishes the context sent to the agent, reading the
repository and validating the complete system.

The
[Context Separation](../../explanation/contexte-et-memoire/separation-du-contexte.md)
page places this mechanism among the other decision-context surfaces and links
its contracts, guides and evidence.

## Principle and compatibility

Consultation is a standard host capability for operators whose admitted model
grants `mayConsultModel`. It allows them to search for an element, inspect its
relations and load files progressively. A read right can be granted without
`mayProposeSysmlRevision`; proposing revisions requires the read right.

Stored models retain their versions and declared flows. For a historical policy
without `mayConsultModel`, the read right falls back to its existing
`mayProposeSysmlRevision` value. An explicitly declared read value takes
precedence. Changing the default flow of a new system does not alter an existing
pin. An operator retains the same source-owned policy in Main and in a Request
space.

The initial context contains a compact model view and an exact version. Files
enter the context on demand, after an explicit read. A search result or element
record identifies the code to read; it is not the complete content of a file to
replace.

## Call contract

The catalog visible in **Tools** and the agent's context present exactly six
tools: `model.search`, `model.inspect`, `model.references`, `model.read_source`
and `model.unload_sources` and `model.query`. They belong to the relevant
operator and appear alongside the other available tools. They do not require
creating or admitting a candidate JavaScript module.

Each record presents its description and parameters. In a historical view, the
catalog comes from the displayed snapshot: currently available tools are not
added retroactively to an old record.

To call them, the agent returns a `consult_model` decision with `text` and the
input serialized in `inputJson`. The host performs the consultation during the
choice phase, supplies the result, then requests another decision. Read
permission, operator identity, project and admitted execution version remain
subject to checks. No arbitrary WOQL query is exposed to the agent.

Results are recorded as `model-context` observations. Successful reads carry
their source version and the operator's execution context; a refusal describes
its operation and reason. These observations prove neither modification nor
adoption of the model.

Each consultation and each final choice consumes one decision within the
existing `maxAgentDecisions` limit. Consultation does not create an unlimited
call loop. A request must therefore target its searches and load useful files
before proposing a change.

All operations require `operation` and `version`. Copy `version` from
`modelContext.version` without substituting the execution version or a moving
branch name. Additional fields are rejected; each operation accepts only the
selectors below.

| Operation        | Specific fields                            | Result                                                                                                                      |
| ---------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `search`         | `query?`, `offset?`, `limit?`              | Matching elements with identity, name, metaclass and source location when available.                                        |
| `inspect`        | `elementId`, `offset?`, `limit?`, `graph?` | Selected element, owner, immediate members and direct-relation neighbors, with exact excerpts when ranges and budget allow. |
| `references`     | `elementId`, `offset?`, `limit?`, `graph?` | Stored normalized relations involving the element, with the roles of their endpoints.                                       |
| `read_source`    | `path`                                     | Loads the complete file into the selection; receipt containing version, path, digest, character count and `loaded: true`.   |
| `unload_sources` | `path?`                                    | Removes the specified file, or all selected files when `path` is absent; receipt with `unloadedPaths`.                      |
| `query`          | `expression`, `mode?`                      | Toolkit evaluation by default; bounded pinned SPARQL SELECT/ASK when `mode: "sparql"`.                                      |

Source pages carry `offset`, `limit`, `total`, `truncated` and, when another
page exists, `nextOffset`. `truncated` means the response does not contain all
matches, including when it starts after the first page. `nextOffset` means there
is a next page. Traverse the pages before concluding that all matches have been
examined.

`search` looks for all words in `query`, case-insensitively, within identifiers,
names, qualified names and metaclasses. Words are separated by spaces and
matched by substring inclusion. Search uses neither semantic ranking nor
free-text documentation. Omit `query` or supply empty text to browse the catalog
page by page.

An inspection distinguishes why each entry is present: `selected`, `owner`,
`owned` or `dependency`. It exposes its
`selected-owner-owned-and-direct-relations` coverage. The reference list exposes
`stored-normalized-relations`; it does not claim exhaustive system impact
analysis. A relation can also report `endpointsTruncated`.

## Graph selectors and continuation

`inspect` and `references` also require the exact native semantic index. Their
successful `semantic` evidence carries the source version, full `build`
(`repositoryId`, `sourceDigest`, `recipeDigest`, `buildKey`, `artifactDigest`)
and full `projection` (`kind`, `projectorVersion`, `artifactDigest`,
`projectionDigest`). This derived evidence grants no edit or execution rights.

```json
{
  "operation": "inspect",
  "version": "<modelContext.version>",
  "elementId": "<discovered native id>",
  "offset": 0,
  "limit": 5,
  "graph": { "direction": "out", "property": "ownedMember", "limit": 20 }
}
```

Every graph field is optional. `direction` is `out` for inspect and `in` for
references by default; either operation accepts either direction. `property` is
the exact case-sensitive Toolkit property name. Graph page size defaults to 20,
with a maximum of 50. These selectors do not change canonical source pagination:
its top-level `offset`, `limit`, `total`, `truncated` and `nextOffset` remain
independent from `semantic.neighborPage`.

Follow `semantic.neighborPage.nextCursor` by supplying `graph.cursor` with the
same immutable version, element, direction and property. The cursor also binds
the full build, projection and element scope. Two commits sharing one build
cannot share a cursor. Page size may change. A cursor is opaque and grants no
access; all authority and version guards run again on every call. Malformed or
mismatched cursors are refused.

The graph reader orders properties and list positions deterministically.
Repeated list endpoints retain distinct `occurrence` identities and `position`
values; direct scalar references appear once. A lookahead row establishes
continuation, including when the last page is exactly full. `complete: true`
means the page exhausts this filtered neighborhood. `nativeTruncated: true`
separately reports native row/byte bounds; it is never disguised as exhaustive
coverage. A byte bound that returns no rows has no continuation cursor: narrow
the property rather than repeating an empty page.

Each neighbor carries its verified build element `ref`, native id and scope.
When a user element maps to source, `source` contains the exact `version`,
`sourceDigest`, `elementId`, `path` and optional UTF-8 byte `range`. Follow that
native id with inspect/references or load that path with read_source, using the
same source pin. `sourceUnavailable: "library"` identifies a normative library
node; `"unmapped"` identifies a node without a verified source mapping. Neither
an IRI nor an unmapped endpoint becomes an edit target.

If index preparation or reading fails, navigation is refused with `code`,
`version`, every known build/projection field and `recovery`. There is no
source-only success result. Independent search and read_source remain available.
The host never recompiles a historical recipe to satisfy graph navigation. For
what to expect during the first consultation and how to retain its pin, see
[preparation and changes in the graph guide](../../how-to/contexte-et-memoire/explorer-graphe-modele.md#understand-preparation-and-changes).

## Toolkit and SPARQL query modes

`query` requires an expression of at most 4096 characters. Omitting `mode`, or
using `"toolkit"`, preserves the existing KerML evaluator and result shape.
Using `"sparql"` selects the semantic index; there is no fallback between modes.
The result carries the exact version, source digest, full build and projection,
effective limits and a typed SELECT (`form: "solutions"`, `variables`, `rows`,
`truncated`) or ASK (`form: "boolean"`, `value`) result. SELECT supports joins,
filters and aggregates. Execution permits at most 50 bindings, 65,536 result
bytes and a 5,000 ms query deadline, including query queue residence. Source
preparation time is separate. Native truncation is explicit.

The RDF projection uses `ase: <urn:ase:vocab:>` for `nativeId`, `metaclass`,
`name` and `qualifiedName`, and `prop: <https://www.omg.org/spec/SysML#>` for
exact Toolkit properties such as `owner` and `ownedMember`. RDF types are
`https://www.omg.org/spec/SysML#<encoded-class>`. User element IRIs are
`urn:ase:model:<encoded-repository>:<encoded-native-id>`; library IRIs are
`urn:ase:library:<encoded-native-id>`. Use returned identities instead of
constructing editable targets from these strings. List predicates
`urn:ase:vocab:list:<encoded-property>` lead to `ase:occurrence` nodes carrying
`ase:index` and `ase:value`; ordinary `prop:` edges are sets and do not count
repeated list occurrences.

```sparql
PREFIX ase: <urn:ase:vocab:>
PREFIX prop: <https://www.omg.org/spec/SysML#>
SELECT ?ownerName (COUNT(?member) AS ?members) WHERE {
  ?owner ase:name ?ownerName ; prop:ownedMember ?member .
  ?member ase:metaclass "PartUsage" .
  FILTER(STRSTARTS(?ownerName, "Example"))
} GROUP BY ?ownerName
```

Writes, network `SERVICE`, client-selected `FROM`/`FROM NAMED` datasets and
unsupported graph result forms are refused. The native AST admission and
killable native query deadline remain in force. Agent-supplied LDkit code is
never executed; LDkit lenses remain host-side views.

## Initial-view content

`modelContext` contains the version, `sourceDigest`, the `files` inventory,
`roots`, read limits and already loaded files in `loadedSources`. Each inventory
file carries its path, SHA-256, length in characters and length in bytes. Roots
carry their own `total` and `truncated`; they provide orientation.

`modelSources` retains the version and bounded publication metadata. Its
`sources` object starts empty in this workflow, then contains only loaded files.
An empty object means no file is selected, not that the model is empty.

## Consultation example before a proposal

These objects show `consult_model` inputs to serialize in `inputJson`. Replace
angle-bracketed values with data from the context or actual results. For
example, the transport decision for the following search has this form:

```json
{
  "kind": "consult_model",
  "text": "I am looking for the mandate elements before preparing the change.",
  "inputJson": "{\"operation\":\"search\",\"version\":\"<modelContext.version>\",\"query\":\"mandate\",\"limit\":20}"
}
```

The content of `inputJson`, shown here without escaping, is:

```json
{
  "operation": "search",
  "version": "<modelContext.version>",
  "query": "mandate",
  "limit": 20
}
```

Use a result identifier to inspect its neighborhood:

```json
{
  "operation": "inspect",
  "version": "<same version>",
  "elementId": "<returned identifier>"
}
```

`references` accepts the same selector. Then load the exact file identified by
the inspection, along with any other file needed for the change:

```json
{
  "operation": "read_source",
  "version": "<same version>",
  "path": "<returned path>"
}
```

After the receipt, the next decision context contains this file in
`modelSources.sources`. The agent can then prepare the change and propose the
complete contents of changed files, using that same base version. It can unload
a file that is no longer needed by calling `unload_sources` with its `path` and
the same `version`.

## Versions and source selection

Consultation pins a source version for the user's request and the relevant
operator. Subsequent operations must use that exact version. Another operator or
a concurrent publication does not silently move the working base. A new request
resets the selection and takes a new current base. A change to the admitted
executable digest also resets this selection. The working set is held in memory;
it is not a persisted editing session.

The consultation source version and admitted execution version have distinct
roles. The former identifies the content examined to prepare a proposal. The
latter determines the mandate and behaviors that can actually be invoked.
Reading a new source, publishing a proposal or accepting its design does not
grant its adoption for execution.

`read_source` adds an exact file to the working selection. The call receipt
describes this read; the text is supplied in `modelSources.sources` in the next
decision context. It remains available during the request without copying the
file into every receipt. `unload_sources` removes files from this selection. It
deletes neither repository sources nor previously recorded messages.

Selected files are transmitted in full. Limits can refuse a load; they do not
silently truncate a file to make it editable. Source text retains its UTF-8
content.

`range` locations use 1-based lines and columns, columns in **UTF-8 bytes**, and
an exclusive end boundary. They must not be interpreted as JavaScript string
indices. Inspection associates an excerpt with a path, a range and the source
file's SHA-256. Without an exact range or sufficient budget, it returns a
summary with `sourceUnavailable`; it does not fabricate an excerpt from the
graph.

## Limits and refusals

The reader's effective values are exposed in `modelContext.limits`. Defaults
are:

| Limit                             | Value                                                       |
| --------------------------------- | ----------------------------------------------------------- |
| Results per page                  | Default 20, from 1 to 50.                                   |
| Page start `offset`               | Default 0, from 0 to 1,000,000.                             |
| Search text                       | Optional, at most 200 characters.                           |
| File read in full                 | 131,072 bytes, or 128 KiB.                                  |
| Excerpts in an `inspect` response | 24,576 bytes total, or 24 KiB.                              |
| Initial-view roots                | At most 50.                                                 |
| Endpoints returned per relation   | At most 50, with a notice when the list is partial.         |
| Reader cache                      | Four immutable revisions, evicting the least recently used. |

`read_source` takes neither `offset` nor `limit`: it does not return a file
portion to substitute for the complete file. An oversized file is rejected.
Inspection retains an element's identity when its excerpt exceeds the budget;
`sourceUnavailable: "source-budget"` indicates this. The owner is deliberately
returned as a summary, with `summary-only`, to avoid injecting its entire
submodel.

The adapter configuration limits the selected sources to 120,000 characters per
operator. `modelContext.maxLoadedCharacters` gives the effective value. A load
that would exceed it is rejected without adding the file. Explicitly unloading
files that are no longer needed frees space. This selection is also subject to
the model's total context budget; these two limits are distinct.

Do not bypass access, parameter or version refusals with invented identifiers or
a version chosen from history. Use data from the current catalog and context. An
empty search result or partial inspection does not authorize replacing a file
without reading it.

| Refusal                                                       | Useful next step                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Version differs from the context                              | Use exactly `modelContext.version` from the current request.                                           |
| Element or file absent from this revision                     | Check the selector with `search` or the `files` inventory.                                             |
| Ambiguous/invalid source origin or range                      | Correct provenance; no substitute excerpt is fabricated.                                               |
| File exceeds the read limit                                   | Review module size or reader configuration; unloading other files does not change this per-file limit. |
| Selected sources exceed the cap                               | Unload files that are no longer needed, then retry the load.                                           |
| Missing revision permission or incompatible execution version | Check the admitted model's mandate and its adoption before retrying.                                   |

## Proposal and validation

Targeted consultation preserves the `propose_sysml_revision` contract:

- `baseVersion` uses exactly `modelSources.version`;
- `sources` contains the complete contents of only modified or added files;
- files omitted from the proposal remain those of the base;
- declared identities and references must be preserved unless a change is
  explicitly requested.

The host refuses to modify an existing file that is absent from the current
selection. Adding a new file remains possible. An unloaded file must therefore
be read again before it can be proposed as a modified file.

The host reconstructs all sources from this base and the proposed files, then
compiles and validates the complete system. Review, acceptance, publication
conflicts and adoption remain governed by the
[revision contract](../evolution/multi-agent-revisions.md). Consultation does
not write to the compiled graph or introduce a generic structural patch.

## Scope of the first version

This version reduces the sources injected into agent decisions. The reader still
builds its in-memory index from a complete verified repository revision. Its
cache is bounded; the server still reads the complete revision from the local
Git repository.

Search and inspection use elements and relations produced by the compiler. They
do not reconstruct an approximate graph with a language model or add embeddings,
a vector database or a new library. A search helps locate entry points; a
partial result list does not prove the absence of other dependencies.

A targeted read in the local Git repository could later replace loading the
complete index while preserving the same consultation contract and version. This
read optimization is not implemented by this version.

Technical contract and compilation checks do not measure an agent's editing
quality. The mere presence of the mechanism implies no token-reduction
percentage, latency gain or evaluation result with an LLM provider.

<a id="qualification-du-22-octobre-2026"></a>

## Qualification on 22 October 2026

The two scenarios in
[`model-context-execution_test.ts`](../../../test/integration/model-context-execution_test.ts)
passed with real OpenSysML, TerminusDB, operator workspaces and DuckDB. The
`ClaudeAgents` client builds its normal requests, but its transport receives
deterministic simulated responses. No real LLM provider is called; this check
verifies context flow and editing preconditions, not an autonomous agent's
search or editing quality.

The two profiles are an older system without an information policy and the
current profile. In each:

1. The five standard tools are available without adding a SysML source or
   exposure. The initial context contains the inventory, with
   `modelSources.sources` empty.
2. The `search → inspect → read_source → propose_sysml_revision` sequence takes
   four decisions. Only the file read enters the working selection.
3. The repository head advances during the request because of an independent
   change. Reads and the proposal retain the base pinned at the start.
4. A second request starts from the new head and performs
   `read_source → unload_sources → reply` in three decisions. The unloaded file
   body does not reappear from journal receipts.
5. Test acceptance recompiles and preserves the concurrent `core.sysml` change
   alongside the proposed `configuration.sysml` change. Execution retains its
   admitted policy: accepting sources does not automatically adopt the new
   budget.

Each scenario uses a unique TerminusDB database, deleted after the test, and a
temporary directory. The tests do not modify an existing working instance.

To reproduce this check from the repository root, with the compiler installed
and TerminusDB available:

```sh
OPENSYSML_BIN="$PWD/.data/toolchains/opensysml-v0.10.1/sysml" \
ASSEMBLY_SEMANTIC_INTEGRATION=1 \
.data/toolchains/deno-v2.9.7/deno test --no-prompt \
  --allow-read --allow-write --allow-env --allow-run \
  --allow-net=127.0.0.1,localhost --allow-ffi=./node_modules \
  test/integration/model-context-execution_test.ts
```

`TERMINUSDB_URL` and `TERMINUSDB_PASSWORD` select the local service
configuration. The test is skipped if `OPENSYSML_BIN` is missing or
`ASSEMBLY_SEMANTIC_INTEGRATION` is not `1`; a skipped test does not count as a
pass. A server elsewhere also requires adjusting the network permission.

### Final verification of the increment

| Check                                   | Recorded result                                                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src` unit suite                        | 437 tests passed.                                                                                                      |
| Frontend suite                          | 146 tests passed.                                                                                                      |
| Full integration run                    | 278 tests passed and 2 failed on assertions predating the new consultation workflow.                                   |
| Reruns after correcting both assertions | Agents group: 17 tests passed; information: 2; skills: 1. The full global suite was not rerun after these corrections. |
| Frontend build                          | 5 routes and 8 assets produced.                                                                                        |
| Code checks                             | Type checking, lint and format passed.                                                                                 |

The targeted reruns verify the corrections in the affected groups. These results
are not presented as a single run of 280 passing integrations.

An export containing only the commit's scope, without the checkout's other
changes, also passes type checking and the 437 unit tests. In that export, the
unit command requires `--allow-env=MCP_SYSON_URL`: the legacy SysON adapter
reads this variable on import. Without this permission, five test modules fail
to load. Changing that adapter belongs to another workstream and is not included
here; this test permission triggers no SysON call.

On local instance `4314`, the **Accueil → Outils → Paramètres** (Home → Tools →
Settings) workflow was checked with the real catalog: five model consultations
and one existing tool, with the same identifiers, names and owner as
`/api/operator-tools`. Desktop and mobile views show no horizontal overflow; no
console warning or error was observed. This check sent no message, executed no
tool and triggered no mutation request.

Local instances `4311` and `4314` were restarted with no active execution. The
comparison before and after restart preserved their source versions, digests and
messages. This observation concerns that qualification environment; it is
neither a model migration nor additional adoption.

The `deno task test:unit`, `deno task ui:test` and `deno task ui:build` tasks
reproduce the corresponding groups. For native integrations, enable the
variables and permissions described above. This increment's tests, including the
provider client's simulated requests, do not evaluate a real LLM.

## Implementation points

- [Consultation contracts](../../../src/domain/model/consultation/context.ts).
- [Revision reader and UTF-8 locations](../../../src/application/model/consultation/source-reader.ts).
- [Authorization, version and source selection](../../../src/application/model/consultation/context-information.ts).
- [Proposal control](../../../src/application/work/runtime/system.ts).
- [Tool display](../../../frontend/components/conversations/AgentContextPanel.tsx).
