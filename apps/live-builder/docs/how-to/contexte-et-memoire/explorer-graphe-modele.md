# Explore the model graph

Use the existing model tools to find declarations, follow their relations, ask
structural questions and read verified SysML sources. In chat, ask the operator
to perform this sequence and report its coverage. The operator must already have
the admitted authority for targeted model consultation; a graph result adds no
rights.

The
[consultation reference](../../reference/contexte-et-memoire/consultation-ciblee-modele.md)
is the complete call contract. This guide shows how to combine its tools. The
JSON examples are operation payloads sent as `inputJson` through the existing
`consult_model` action; they do not introduce another transport.

## Choose the right read

The six catalog tools keep distinct purposes:

| Tool                   | Use it to                                                                   |
| ---------------------- | --------------------------------------------------------------------------- |
| `model.search`         | Find elements by identifier, name, qualified name or metaclass.             |
| `model.inspect`        | Inspect an element, its canonical context and outgoing graph neighbors.     |
| `model.references`     | Read stored relations and, by default, incoming graph neighbors.            |
| `model.read_source`    | Load a verified complete source file into the working selection.            |
| `model.unload_sources` | Release selected files when they are no longer useful.                      |
| `model.query`          | Evaluate KerML with Toolkit, or explicitly query the RDF index with SPARQL. |

These are model facts. Declared rights, dependencies and calculated counts do
not establish that an invocation ran, a transition occurred or an effect was
verified. Consult runtime state and journal evidence for those questions.

## Follow an element to its source

Keep `modelContext.version` throughout the request. In the examples, replace
`<PIN>` with that exact value, `<ELEMENT_ID>` with a discovered native ID,
`<CURSOR>` with the returned graph cursor, and `<PATH>` with a verified returned
source path. None is a value to guess or copy from another installation.

1. **Search.** Call `model.search` with `operation: "search"`, the pinned
   `version` and useful `query` words. Search matches words within model names
   and identifiers; it does not search documentation semantically. Read further
   canonical pages with `nextOffset` if necessary.

2. **Inspect.** Pass a returned native ID as `elementId`:

   ```json
   {
     "operation": "inspect",
     "version": "<PIN>",
     "elementId": "<ELEMENT_ID>",
     "limit": 1,
     "graph": { "direction": "out", "limit": 20 }
   }
   ```

   Read the selected declaration and `semantic.neighbors`. Use a neighbor's
   `ref.nativeId` for another inspection. Its `iri` is the RDF identity for
   queries, not an interchangeable `elementId`.

3. **Find incoming relations.** Call `model.references` with the same version
   and element, optionally keeping canonical `limit: 1`. Omitting `graph`
   selects incoming neighbors with graph limit 20. A case-sensitive `property`
   filter can narrow either direction; take its exact name from returned graph
   data or the documented Toolkit vocabulary.

4. **Continue the actual graph page.** Copy `semantic.neighborPage.nextCursor`
   from the outgoing inspection:

   ```json
   {
     "operation": "inspect",
     "version": "<PIN>",
     "elementId": "<ELEMENT_ID>",
     "limit": 1,
     "graph": { "direction": "out", "limit": 2, "cursor": "<CURSOR>" }
   }
   ```

   Preserve the original element, direction and property filter. Page size may
   change. A references cursor belongs to its own selection.

5. **Read verified source.** Follow a mapped neighbor's `source.elementId` or
   call `model.read_source` with `operation: "read_source"`, the same `version`
   and `path: "<PATH>"` from its `source.path`. Check the receipt's digest and
   loaded status. `sourceUnavailable: "library"` or `"unmapped"` provides no
   editable source target. Use `model.unload_sources` to release the path later.

Every consultation consumes a decision within the request's existing budget.

## Track coverage separately

Canonical `offset`/`limit`/`total`/`truncated` and `nextOffset` describe source
records. Graph `neighborPage` describes the selected neighborhood: default 20,
maximum 50. `complete: false` can coexist with `nativeTruncated: false`; follow
its cursor before claiming exhaustion. Repeated list endpoints retain distinct
occurrence identities and positions.

SPARQL `LIMIT` bounds query solutions; native row/byte truncation is another
bound. It supplies no graph continuation cursor. If a native byte limit returns
zero neighbors and no cursor, narrow the property instead of repeating the empty
page.

Successful graph reads retain the exact version, full BuildRef and full
ProjectionRef. A cursor binds all of them, the element/scope and selectors.
Never reuse it across source versions, even when two commits share a build.

## Query or use a lens

Omit `mode`, or set `mode: "toolkit"`, for the existing KerML evaluator. For
example, `model.query` with `expression: "1 + 2"` evaluates through Toolkit.

Set `mode: "sparql"` and put this expression in `model.query` to count distinct
user-model PartUsage members per named user-model owner:

```sparql
PREFIX ase: <urn:ase:vocab:>
PREFIX prop: <urn:ase:vocab:prop:>
SELECT ?owner ?ownerName (COUNT(DISTINCT ?member) AS ?members)
WHERE {
  ?owner ase:name ?ownerName ; prop:ownedMember ?member .
  ?member ase:metaclass "PartUsage" .
  FILTER(STRSTARTS(STR(?owner), "urn:ase:model:"))
  FILTER(STRSTARTS(STR(?member), "urn:ase:model:"))
}
GROUP BY ?owner ?ownerName
ORDER BY DESC(?members) ?owner
LIMIT 10
```

This joins relations to metadata and filters out library IRIs. It counts
distinct endpoints, not repeated list occurrences; `LIMIT 10` selects groups,
not complete neighborhood coverage. Use returned IRIs when targeting particular
elements.

The agent route supports SELECT/ASK, with 4,096 expression characters, at most
50 bindings, 64 KiB and a five-second query deadline including queue residence.
Index preparation is separate. Writes, network SERVICE and client-selected
datasets are refused. Modes never fall back to each other.

LDkit lenses are typed host/backend views over a pinned model. The agent can
consume exposed views and query results; it executes no JavaScript or LDkit lens
code through these tools.

## Understand preparation and changes

Git pins SysML sources; Toolkit compilation produces a verified build. The
[native pipeline](../../explanation/modeles/pipeline-modele-natif.md) resolves
that exact build, derives a versioned RDF projection and loads the index.
Semantic reads never recompile a historical recipe. Persisted projections can be
reused; a cold load still takes time.

The first `model.inspect`, `model.references` or SPARQL `model.query` for a
build waits for preparation and native loading before returning. Keep the same
version pin while it runs. Preparation happens outside the server's main
process; this does not make the tool return before its graph is ready. The
five-second SPARQL deadline applies to the query phase, not to the whole first
consultation.

An open application is not an indication that its RDF index is already loaded.
There is currently no index-readiness indicator or public force-prewarm action.
Automatic preparation at startup and after publication, visible availability and
explicit retry controls remain in the readiness follow-up. For the internal
states and measured scope, use the
[index reference](../../reference/modeles/index-semantique-natif.md#states).

On refusal, retain `code`, every known pin and `recovery`. Narrow timed-out
queries; follow recovery guidance for busy reads within the request budget.
Navigation cannot report source-only success after index failure; independent
search/source reads remain available.

For changes, prepare an isolated candidate source set from the pinned SysML,
pass Toolkit compilation and contract/target checks, then use
[governed revision publication](../evolution/reviser-systeme.md). Publication
and execution adoption are separate. The index is a derived read surface, never
the primary writable model; graph discovery alone creates neither a proposal nor
authority to publish.
