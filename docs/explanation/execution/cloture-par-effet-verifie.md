# Verified-Effect Closure

The pattern requires checking the expected result in its source of truth before
declaring the work successful. A receipt, a positive HTTP response or a
statement from the operator is not enough. The condition and authority for
reaching that conclusion belong to the contract established before execution.

## A business contract carried by the model

The calling system declares a `WorkResultContract`: expected values, the type of
facts to observe and a native constraint that compares them. It separately binds
access to the work and access to reading its result. The success criterion comes
from admitted SysML sources; the read adapter reports raw facts without choosing
what counts as business success.

The engine compiles this contract into schemas and a bounded expression tree. It
evaluates the constraint against the preserved expected values and the facts
read. Changing a criterion therefore does not require a new TypeScript business
rule, within the supported subset. This is not a general executor for SysML
`verification def` constructs.

Publishing a tool is a specialized example: the catalog reader cross-checks the
durable work journal, current native facts and admitted bytes. The
`AssemblyToolPublicationResult::PublicationExpectation` and
`AssemblyToolPublicationResult::PublicationObservation` types and the model
constraint express the publication condition. The comparison engine does not
carry a universal rule that an active tool is published. Another reader can
provide facts from another domain under a typed, admitted contract.

## Verification and progression

Execution preserves its technical state, including `completed`. Verification is
recorded separately in `resultVerification`. For a task with the contract,
dependencies and plan success wait for `verified`. A technically completed task
can therefore retain an open obligation. Tasks without a contract keep their
progression rule.

Native identities, the admitted version and correlation with the exact call
bound each observation. The reader's authority and fact provenance are checked
separately from the predicate: a satisfactory value sent by a reader that has
not been admitted does not become evidence. The registry of authorized
observation invocations preserves this boundary.

An explicit resumption observes completed or uncertain protected work again
without repeating its write. Persistent budget reservations prevent two
concurrent resumptions from consuming the same credit. A positive read can
resolve an effect whose acknowledgment was lost while preserving the absence of
a receipt. An unavailable source, contradiction or exhausted budget leaves the
result unverified and the obligation open.

## Scope and limits

The current contract accepts flat items with scalar values and bounded Boolean
constraints. Expected values and query parameters come from source literals or
direct scalar bindings from the admitted work input. Their resolution is
preserved before the effect and checked on resumption; changing the amount in a
new request therefore does not require rewriting its comparison rule. Computed
binding expressions, conversions and collections remain outside the profile. No
source text is executed through `eval`, and the contract embeds no arbitrary
TypeScript code.

Different native criteria let us examine the engine's generality; they do not
prove a real ERP integration. The mechanism is neither universal conversation
closure, an accepted handoff in the sense of **Acknowledged Handoff**, nor proof
of business quality beyond the selected criterion and source. Importing the
library grants no rights.

See the [contract](../../reference/execution/resultats-verifies.md) and
[guide](../../how-to/execution/verifier-un-resultat-de-travail.md). The primary
contract is
[Verified-Effect Closure](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/control-3-4.mjs)
in the APE book; this engine implements an explicit subset of it.
