# Product and architecture decisions, 23–25 October 2026

This document records product and architecture decisions from October 23–25,
2026. It distinguishes an agreed direction from its implementation. Contracts
are in the reference documentation.

## The product and its audiences — October 23, 2026

The workshop serves people who design agentic systems and people who use them.
Designers must be able to read, version and share the model; users must benefit
from its traceability without having to work with SysML. These audiences do not
impose two fixed technical roles.

SysML sources must remain raw, shareable and readable outside Assembly. Assembly
executes its validated contract. Model portability therefore does not mean that
Assembly already executes all of SysML, or that an external viewer reproduces
the host's effects. The
[boundary between SysML and execution](../execution/sysml-et-execution.md)
describes this separation.

Work continues in this repository. Paper Trader and the historical customer
support slice are no longer the demonstrators to extend. The interface and
product documentation use English. This rule changes neither persisted
identifiers nor the language a person chooses in the chat.

## Requests and operators — October 24 and 25, 2026

The demo focuses on Requests. Jobs and Watches remain frozen on the product
side: their pages and mechanisms do not become work to resume by default. On
October 25, Erwan nevertheless confirmed that an operator may propose them for a
recurring need: “it is right to propose that, I think, even if it is not
actually implemented at the moment” (translated from French). A proposed
solution is therefore not proof that it works.

The main operator designs the system with the person and creates operators to
handle Requests. Since October 25, its visible name has been **Main Operator**:
the name “Designer” caused confusion. Internal identifiers such as
`designerScopeId` remain technical identifiers. Existing systems retain the name
carried by their own model.

All these actors are operators. The Main Operator's central position gives it no
implicit authority. The agreed direction is for it to decide requests covered by
a delegation granted by the person, with everything else escalated to that
person. Temporary delegation — one request, one Case, a number of decisions or a
duration — remains an open need. Merging the first delegation work package on
October 25 does not implement it or close its checks.

## Sources, execution and projections — October 24, 2026

SysML Toolkit is the entry point for reading and modifying SysML. Host edits
must go through the verified writer, followed by controlled publication. This
direction rules out adding a second text-editing path to bypass the writer; it
does not claim that all historical cleanup is complete.

The Toolkit is required at startup: its absence is an error, not a reason to
provide an incomplete proposal or one without a diff. The
[installation guide](../../how-to/modeles/activer-toolkit-local.md) explains the
`TOOLKIT_REQUIRED` refusal and how to resolve it.

The model describes the admitted design. Execution state, including candidate
progress, remains in the runtime; activation is the step that publishes a tool
to the catalogue. Git keeps design versions. Views and indexes are projections
of them, identified by the version they represent. See the
[concurrent publication contract](../../reference/evolution/multi-agent-revisions.md).

## Cache and query graph — October 24 and 25, 2026

### Toolkit integration retained when reviewing the backlog

On October 25, Erwan confirmed **NAPI-RS** as the direction to retain for the
SysML Toolkit integration. The Toolkit's role, the verified writer and
publication controls remain the same. This choice does not replace validation of
the transport or its performance.

The integration is now in `main`: the workshop's and viewer's active paths use
the Rust Toolkit through N-API in an isolated process. The October 26 validation
report keeps its conditions and limitations; it does not establish overall
acceptance.

### Storage and derived indexes

The selected build-storage design is a Deno KV store behind a port, preparing to
move the large compiled artifact out of Git without losing the ability to read
old revisions. The build store is now connected to reads and writes: service,
descriptors, projections and vault. The
[build-service contract](../../reference/modeles/service-des-builds.md)
distinguishes the current format from legacy reads; old revisions are not
rewritten.

Oxigraph Rust through N-API is integrated for the RDF/SPARQL index. It is fed by
the interchange graph compiled by SysML Toolkit, without a second SysML parser
or an RDF service or Docker instance to start. The index remains derived and
reconstructible; it neither publishes sources directly nor grants any rights.

LDkit is the selected typed reader, and SHACL is used for the pattern doctor's
rules. These components are connected in the native stack; their dated
validation does not close acceptance, other-platform validation, or the memory
and RDF-coverage questions. The concurrency study explains why experimental RDF
merging does not replace controlled source publication.

## What remains in a plan — October 25, 2026

Implemented features become Diátaxis documentation: usage in guides, contracts
in references, and rationale in explanations. An open plan keeps its remaining
work; a completed plan disappears once its lasting content has been transferred
and its links updated. Studies and audits retain their dates and limitations in
research documents.

These decisions were reconciled with plans and session notes when transferred on
October 25, against code `73b3ed6`. They do not grant permanent authorization to
execute future work packages: a question calls for an answer, and proposed
improvements remain subject to a decision.
