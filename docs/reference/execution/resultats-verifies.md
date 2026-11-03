# Verified results — Verified-Effect Closure

This reference describes the bounded generic `verified-effect-closure/v2`
contract. It is not a test report.

## Native contract

`APEVerifiedEffectClosure::WorkResultContract`, defined in
[verified-effect-closure.sysml](../../../models/verified-effect-closure.sysml),
is a direct occurrence within the caller's `ConversationSystem`.

| Field             | Condition                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `work`            | Reference to the work's `BehaviorAccess`.                                                      |
| `observation`     | Separate reference to the admitted read access.                                                |
| `expected`        | Typed item containing the expected values, resolved before the work.                           |
| `observed`        | Typed item reference describing the facts read; its type is the reader's declared output type. |
| `input`           | Optional reference with the same type as the work input, bound to its exact access.            |
| `query`           | Optional typed item, with parameters compatible with the reader's input.                       |
| `condition`       | Native Boolean constraint comparing `expected` and `observed`.                                 |
| `maxObservations` | Integer from 1 to 8.                                                                           |

Compilation preserves identities, schemas, expected values, the predicate tree
and `sourceIds`. Accesses, allocations and types remain subject to native
admission. Importing definitions alone grants nothing.

## Supported subset

Items are flat, with at most 32 scalar fields of type `String`, `Boolean`,
`Integer` or `Real`. Schemas forbid additional properties. Validation checks
types, required fields and compiled scalar bounds. Collections, nested objects
and implicit conversions are outside this profile.

The expression accepts literals, direct `expected.champ` and `observed.champ`
paths, `not`, `and`, `or`, `implies`, `==`, `!=`, `<`, `>`, `<=` and `>=`.
Logical operands are Boolean; equality requires compatible types; ordered
comparisons are numeric. The tree is limited to 256 nodes and a depth of 32.
Unsupported elements are rejected during contract validation, never evaluated as
arbitrary source code. At runtime, an invalid contract or predicate raises its
error; it is not converted to an `unknown` effect. A missing or uncorrelated
observation, or one whose values do not support a conclusion, can produce
`unknown`. A valid predicate produces `verified` or `contradicted` according to
the observed facts.

Values in `expected` and `query` come from native literals or direct bindings
from a scalar field of `input`. This reference must be bound to the exact `work`
access input and have the same type. Bindings preserve their identities in
`valueBindings`; their values are resolved from the admitted input before any
effect, then retained with the plan. Execution and persistence recompute this
resolution and reject changed expectations or a resume with different
parameters.

A field cannot have both a literal and a binding, or multiple bindings. Cycles,
unrelated sources, multiple cardinalities and different types are rejected.
Computed bindings, implicit conversions and nested paths remain outside the
profile. The engine does not execute general `verification def` constructs.

## Observation and authority

The observation envelope carries the caller, `workInvocationId`,
`workBehaviorId`, `workInputDigest`, model version, availability, source and its
revision, followed by `values`, the typed raw facts. Correlation fields are
reserved for the host. Query parameters cannot replace them. The
`ObservationInvocationRegistry` accepts only readers supplied by the host
through `ObservationInvocationPort`, marked with the `readOnlyObservation`
symbol. A native declaration cannot grant this marker. Admission and correlation
bind the read to the exact invocation; provenance and authority are not inferred
from a reader's verdict.

The comparison checks immutable correlation, availability, provenance and the
schema before evaluating the model constraint. The adapter reports the facts;
the native predicate decides whether they satisfy the required result. An
operator's assertion or the `artifacts` field of a production receipt does not
replace this read.

The specialized `AssemblyWork::InspectWorkArtifacts` reader cross-checks the
durable journal, a fresh native catalog and the admitted bytes/digests. Its
profile of 19 scalar publication facts is one possible adapter.
`AssemblyToolPublicationResult::PublicationQuery` carries the `artifactName`
parameter. The `AssemblyToolPublicationResult::PublicationExpectation` and
`AssemblyToolPublicationResult::PublicationObservation` types and their
predicate express this case in the model; they do not limit the generic contract
to tools.

## Persistence and recovery

`resultContract`, `observationInvocation` and `resultVerification` remain
separate from the receipt and the task's technical state. Statuses are
`pending`, `verified`, `unknown`, `contradicted` and `exhausted`. History
retains timestamped observations, errors and consumed attempts, including when
the final status is `exhausted`.

With a contract, dependencies and plan success require `verified`. An explicit
resume observes completed or uncertain protected work without reissuing its
write. The persistent budget and its CAS reservations are not reset; a
reservation without a response does not return its credit. If a positive read
resolves an effect whose receipt is missing, the `interrupted` technical state
and missing receipt are preserved. An unverified obligation remains open.

Journals from the old v1 profile remain loadable for consultation. Executing or
saving them under the v2 contract requires explicit readmission; no silent
conversion or historical rewrite occurs. Historical digests are not rewritten;
input whitespace already lost cannot be reconstructed to invent a correlation.

See the [explanation](../../explanation/execution/cloture-par-effet-verifie.md).
