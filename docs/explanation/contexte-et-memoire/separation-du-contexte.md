# Context Separation

In Assembly, the context supplied to a decision distinguishes current facts,
applicable instructions, journal observations and sources consulted for a
change. Their presence in the same agent request does not give them the same
authority, lifetime or write permissions.

The pattern's name is **Context Separation**. Its
[book chapter](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/transverse-5-1.mjs)
defines the reference contract. This page describes Assembly's implementation
and its limits; it does not claim general conformance to the pattern.

## Surfaces used by a decision

| Surface                  | Implementation in Assembly                                                                                      | Use and limit                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current state and rights | Mandate, execution policy, catalogs and `admittedModelVersion` prepared by the host.                            | Determine permitted actions; an older message does not replace them.                                                                                    |
| Durable journal          | Messages and observations retained by the case, with their identities and execution references.                 | Records what was requested or observed. Its projection does not rewrite this evidence.                                                                  |
| Decision context         | `projectDecisionContext` applies the `APEContext::DecisionContextPolicy` policy when instantiated and admitted. | Selects useful messages and details, marks omissions and refuses a context whose required data does not fit.                                            |
| Consulted design sources | `modelContext` inventory, exact base and working files in `modelSources.sources`.                               | Prepare a proposal from an immutable revision; their version does not replace the admitted execution version.                                           |
| Work instructions        | `modelingGuidance` advice and explicitly loaded skill versions.                                                 | Guide the operator under their provenance; their content grants no permission.                                                                          |
| Guidance from memory     | `memoryGuidance`, supplied according to local notes' rights, status and validity.                               | Recalling a candidate does not make it admitted guidance. This transition belongs to [Governed Memory Promotion](promotion-gouvernee-de-la-memoire.md). |

There is no common write permission across these surfaces. A mandate change
follows its revision path; a note follows its promotion path; a journal read
remains limited to the authorized operator's journal.

## Available mechanisms

### Journal projection and access to evidence

The model may declare a policy for recency, excerpt size, item count and total
context size. The preparer retains the current request, authority facts and
selected source files. For shortened or omitted details, it retains exact
references to journal messages with their SHA-256 and the reason for omission.

`APEContext::ReadContextEvidence` returns a message by identity and digest,
within the caller's conversation only. This evidence read requires its own
admitted exposure. Explicitly requested detail is retained in the next decision
or refused if it exceeds the limits; it is not presented as a new current
observation.

Since D1, the journal retains the entire accepted message within the input bound
of 100,000 UTF-16 units. Context projection is separate: historical messages
follow `maxMessageCharacters`; the current request remains whole while the total
projection fits, then receives the same marked shortening. An exact read by
identity and digest remains subject to the 262,144-byte return limit and to
`maxContextCharacters`; it fails explicitly if the text does not fit. See
[text bounds](../../reference/developpement/bornes-de-texte.md).

Representation limits are **JSON characters**, not tokens or a monetary budget.
Without a native projection policy, the historical journal handling still
applies.

### Progressive consultation of the SysML model

Every operator allowed to propose a revision has five standard tools by default:
search, inspect, consult references, read a file and unload sources. They are
visible in the catalog and available in existing systems without a SysML
migration.

A request starts with an inventory, an exact source base and an empty selection.
`read_source` loads the whole file from this base into the next context. A new
request resets the selection; concurrent publication does not silently change
the base of a request in progress. Unloading a file removes its working copy
without deleting the source or history.

A proposal must use this base. An existing file must be loaded before it is
modified. The host then reconstructs the full model for compilation and revision
checks. This standard consultation is separate from the optional journal
projection policy and the native reading of evidence.

### Instructions and memory

Skills have a versioned catalog and a separate loading selection. Their texts
arrive once in the successful native load result with their identity and digest;
the stable provider prefix contains only the index. Source-modeled page
selectors allow bounded reads of large instructions. Unloading a skill deletes
neither its installation nor past messages. Size policies may refuse a selection
that is too large.

Memory notes retain their own status. Recalling a candidate serves to examine
it; reusable guidance passes through the controls of
[Governed Memory Promotion](promotion-gouvernee-de-la-memoire.md). Loading a
source or skill does not perform this promotion.

## Using and evolving this implementation

- [Modeling context and memory](../../how-to/contexte-et-memoire/modeliser-contexte-et-memoire.md)
  describes instantiating and adopting policies, guidance and evidence reading.
- [Proposing, comparing and adopting a revision](../../how-to/evolution/reviser-systeme.md)
  describes model consultation before modification.
- [Installing, loading and unloading skills](../../how-to/contexte-et-memoire/gerer-les-skills.md)
  describes instruction selection.

The
[targeted consultation reference](../../reference/contexte-et-memoire/consultation-ciblee-modele.md)
provides the five contracts, limits, UTF-8 positions, versions and refusals. The
[baseline reference](../../reference/contexte-et-memoire/socle-initial-et-skills.md)
describes the initial policy and skill values.

## Code and contracts

| Responsibility                                    | Sources                                                                                                                                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projection policy, guidance and evidence reading  | [`models/context.sysml`](../../../models/context.sysml), [`context-separation.ts`](../../../src/domain/work/policies/context-separation.ts), [`policy.ts`](../../../src/adapters/work/information/policy.ts).                           |
| Decision context preparation                      | [`separation.ts`](../../../src/application/work/context/separation.ts), called from [`system.ts`](../../../src/application/work/runtime/system.ts).                                                                                     |
| Journal evidence reading and local rights         | [`behavior.ts`](../../../src/application/work/context/information-behavior.ts).                                                                                                                                                         |
| Contracts, reading and selection of SysML sources | [`context.ts`](../../../src/domain/model/consultation/context.ts), [`source.ts`](../../../src/application/model/consultation/source-reader.ts), [`information.ts`](../../../src/application/model/consultation/context-information.ts). |
| Loading skill instructions                        | [`context-skills.ts`](../../../src/application/skills/context-skills.ts), [`behavior.ts`](../../../src/application/skills/behavior.ts).                                                                                                 |

## Evidence and limits

The initial context and memory qualification of 22 October documents projection,
exact evidence and policy changes. Its measurements apply to the archive
examined; they do not measure the cost of current requests.

The
[targeted consultation qualification](../../reference/contexte-et-memoire/consultation-ciblee-modele.md#qualification-du-22-octobre-2026)
covers old and current systems, exact loading, a base retained despite
concurrent publication and the separation between acceptance and adoption. It
uses real services and a simulated agent transport. Checking the catalog on the
local instance is evidence of display and navigation, not an assessment of an
LLM provider's reasoning.

The main tests are in
[`separation_test.ts`](../../../src/application/work/context/separation_test.ts),
[`source_test.ts`](../../../src/application/model/consultation/source-reader_test.ts),
[`information_test.ts`](../../../src/application/model/consultation/context-information_test.ts)
and
[`model-context-execution_test.ts`](../../../test/integration/model-context-execution_test.ts).

The limits remain explicit:

- Model search and inspection are bounded; they do not guarantee an exhaustive
  assessment of a change's impacts.
- The reader still loads an entire revision on the server to build its in-memory
  index. Sources sent to the agent are selected; the server reads the full
  revision in the local Git repository.
- Provenance metadata establishes a datum's recorded origin, not the correctness
  of every interpretation of its content.
- Context grants no additional permission, admission or case closure. These
  responsibilities remain separate in
  [Proposal–Admission–Execution Separation](../evolution/proposition-admission-execution.md)
  and
  [Conversational Case Management](../operateurs/gestion-conversationnelle-des-cases.md).

[Back to explanations](../../README.md#explanation).
