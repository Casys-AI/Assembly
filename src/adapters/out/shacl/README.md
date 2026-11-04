# Parameterized native SHACL-SPARQL diagnostics

This adapter evaluates two advisory constraints on the complete pinned native
model graph. It does not implement general SHACL Core or full SHACL 1.2. The
versioned Turtle file stays separate from model storage. Its supported profile
contains exactly two named NodeShapes, each with Warning severity and one SELECT
constraint. Targets are compiler associations supplied through `graphContext`,
not SHACL target declarations. No verdict triples, overlay, or second model
store are created.

`SourceModelDiagnosticsReader` projects admitted executable systems, their exact
exposed plans and SkillPolicies. Each unit association carries `elementId`,
`kind`, `ownerSystemId` and an optional `budgetPolicyId`; each capability
carries `policyElementId`, `ownerSystemId`, `allowedHostsAttributeId` and an
optional `networkHostsAttributeId`. These attribute identities are resolved once
from the admitted source snapshot names and exact owners, including native
redefinitions. Missing allowed-host provenance is refused. A shared plan retains
every admitted owner. Fact booleans and host differences are used only by the
TypeScript oracle. Source locations remain in the facts used to map query
findings.

The budget constraint binds `?this`, `?ownerSystem` and `?budgetPolicy`. It
checks the referenced occurrence's exact owner and InvocationBudgetPolicy type.
The host constraint binds `?this`, `?ownerSystem`, `?allowedHostsAttribute` and
the optional `?networkHostsAttribute`, reads actual AttributeUsage /
FeatureValue / LiteralString paths and computes a set difference with NOT
EXISTS. The grouped provenance query checks attribute types and exact owners;
constraints read their FeatureValue/LiteralString values directly without
traversing names or redefinitions. An absent network attribute is an empty
mandate: the outer filter checks its binding before the NOT EXISTS match, so an
unrelated attribute cannot supply that missing mandate. No source text is
parsed. It compares primitive JSON-array string members exactly, including
escaped text; there is no wildcard, regex or host normalization interpretation.

Model classes and properties use the portable OpenMBEE/OMG SysML vocabulary
`https://www.omg.org/spec/SysML#`. Primitive members of JSON string arrays use
the Assembly extension `urn:ase:vocab:string-array-member:value`, while the
original JSON literal remains intact. A portable consumer can derive this
extension from the literal without changing the model.

The query transformation is adapted from Casys's OpenClaw SysML export plugin's
AST admission and recursive VALUES prebinding. It does not reuse plugin rules or
its synchronous WASM store. Every independent group, UNION branch, subquery and
EXISTS/NOT EXISTS scope receives the association table. Prebound variables
cannot be reassigned or supplied by query-owned VALUES. SELECT must explicitly
project `?this`, including subqueries. Dataset clauses, SERVICE, MINUS, GROUP
BY, HAVING, aggregates, LIMIT/OFFSET, custom IRI functions and nondeterministic
functions are refused.

A grouped provenance read refuses absent model identities. Then each active
constraint runs once for all its associations through the awaited native query
callback. Generated queries must fit the native 65,536-byte UTF-8 input limit
before dispatch. Thus 10,000 associations is only an upper bound: identifier
lengths and recursive VALUES tables can reach the byte ceiling first, producing
a coded error with actual/maximum bytes and recovery guidance. Constraints are
never split or truncated to bypass that ceiling. The endpoint validates the full
selected version and has no caller scope selector. An overflow requires review
of the profile or model revision before retrying the same request. Each query is
bounded to 10,000 result rows, 4 MiB output and 5 seconds; native process limits
also apply. Truncated provenance or constraint results, unsupported result
forms, unknown focus associations and failures produce coded errors and are not
cached. The backend graph lease spans all awaited operations and cannot mutate
the graph or grant execution rights.

Immutable cache addressing covers the complete BuildRef, ProjectionRef, compiler
context and source facts, exact shapes bytes, association projector, engine
(including Oxigraph and SPARQLjs versions), options and query limits. Reports
include the projection and context digest. Corrupt cache bytes are refused,
never silently recomputed. Existing diagnostics, remedies and source locations
remain compatible with the principal Doctor; user masks remain outside reports.

The principal Doctor still executes five TypeScript rules in production. Its
budget and host rules overlap with this two-constraint report during migration;
it is not merely a test oracle. The old SHACL Core engine and verdict-graph
projector are gone. Toolkit validation, executable-model admission and runtime
authority/budget enforcement have separate responsibilities.
