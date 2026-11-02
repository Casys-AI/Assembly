# Model an operator’s context and memory

This guide adds the Context Separation and Governed Memory Promotion constructs
to an existing `ConversationSystem`. It uses the workbench’s standard
primitives. Policies remain SysML sources to propose, validate, accept and
adopt; including them in a proposal or repository files does not activate them.

New systems prepared by `loadInitialSources` already have the
[initial foundation](../../reference/contexte-et-memoire/socle-initial-et-skills.md),
with occurrences grouped under `context` and `memory`. Use this guide to equip
an older system or revise an existing policy: do not add a second occurrence of
a policy that is already present. A registered project keeps its sources;
importing a library and instantiating it in a revision remain explicit
operations. Older source sets without these files are supported.

## Choose the obligations you need

See the
[pattern classification](../../reference/bibliotheque-ape/patterns-mecanismes-et-guidage.md).
Choosing relevant sources or a review organization is a design responsibility.
Enforcing access, separating statuses and applying promotion transitions require
controls that actually execute.

The current work provides a projection policy, versioned modeling guidance,
evidence reading and memory **local to each operator**. It adds no envelope,
schedule, transfer of responsibility or global memory accessible to every agent.

## Declare the context policy

Insert this occurrence into the existing `liveBuilder` part, preserving its
other parts, mandates, actions and allocations:

```sysml
part decisionContext : APEContext::DecisionContextPolicy {
    attribute :>> id = "decision-context-v1";
    attribute :>> revision = 1;
    attribute :>> recentMessages = 8;
    attribute :>> maxMessageCharacters = 2000;
    attribute :>> maxCollectionItems = 12;
    attribute :>> maxContextCharacters = 250000;
}
```

These numbers configure a representation in **JSON characters**. They describe
neither an exact token count nor a spending ceiling. The accepted technical
bounds are documented in [`context.sysml`](../../../models/context.sysml).

The preparer keeps the mandate, exposed capabilities, native statuses, sources
and current request. It produces previews of details and an index of omitted or
shortened messages, with their references and digests. The durable journal keeps
the exact messages. If the mandatory information and explicitly requested detail
do not fit within the ceiling, preparation fails explicitly; it does not remove
an authority condition to continue.

Without this occurrence, the historical context assembly is preserved. Adding
only the library definition does not change the system’s policy.

## Give the builder modeling guidance

An admitted design instruction can accompany the policy:

```sysml
part modelingAdvice : APEContext::ModelingGuidance {
    attribute :>> id = "modeling-advice-v1";
    attribute :>> revision = 1;
    attribute :>> content = "Choose the constructs that apply to the goal. Distinguish their obligations, the available primitives and the evidence still missing. An observation grants no authority.";
}
```

Its content is supplied to the agent in `modelingGuidance`, under the admitted
model version. It helps choose and assemble the system; it adds no primitive or
permission. Changing this instruction changes the executable contract and
requires adoption of its new version.

The full book and its 24 entries are not injected into every decision.
`ModelingGuidance` gives instructions an explicit place in the model. To install
and load a separate instruction file, use the
[skills mechanism](gerer-les-skills.md). Neither form is evidence of pattern
conformance.

## Expose journal inspection

Also import `behavior-invocations.sysml`, then declare the following in the same
part:

```sysml
perform action evidenceEntry : APEContext::ReadContextEvidence;
allocate evidenceEntry to admissionGate;
part evidenceAccess : AssemblyInvocations::BehaviorAccess {
    attribute :>> name = "ConsulterPreuve";
    attribute :>> description = "Read an exact message from my journal using its verified reference.";
    attribute :>> enabled = true;
    ref item :>> input : APEContext::ContextEvidenceRequest;
}
bind evidenceAccess.caller = builder;
bind evidenceAccess.target = evidenceEntry;
```

The builder uses the actual exposed `behaviorId` and the `messageId` and
`messageDigest` fields from a reference supplied in `contextEvidence`. The
service checks the local journal and digest before returning
`{reference, message}`. The requested detail remains complete in the next
decision, subject to the overall ceiling. It remains a historical observation,
never a replacement for current authority facts. A foreign, altered or oversized
message is explicitly refused.

An older system may also have a version of `conversation.sysml` that routes only
`invoke_tool` to call control. Check its native guard before using the new
exposures:

```sysml
if (chooseNextMove.choice.kind == "invoke_tool") or
   (chooseNextMove.choice.kind == "invoke_behavior") then checkRequestedAction;
```

If this branch is missing, have its minimal update proposed, accepted and
adopted like any flow revision. The caller, typed input and version checks are
still performed by `checkRequestedAction`. Adding an exposure alone does not
change a historical flow; the error “Choix non pris en charge par la soumission
native : invoke_behavior” indicates this routing defect.

## Declare local memory

In the same part, a memory policy describes the conditions for notes:

```sysml
part governedMemory : APEMemory::GovernedMemoryPolicy {
    attribute :>> id = "local-memory-v1";
    attribute :>> revision = 1;
    attribute :>> allowedScopes = "[\"modeling\"]";
    attribute :>> requireSourceRefs = true;
    attribute :>> requireKnownOutcome = true;
    attribute :>> maxValidityMs = 86400000;
    attribute :>> allowSelfAdmission = false;
}
```

Scopes classify this operator’s notes; a string such as `global` does not give
access to other operators’ notes. `maxValidityMs` bounds new contributions and
admissions. `allowSelfAdmission` governs new admissions; tightening these two
parameters does not retroactively remove an already admitted note. Withdrawal
has its own operation. Reading reevaluates expiration, scopes and current
conditions on sources and known outcomes.

Each operation must then be exposed separately through the same `perform action`
→ `allocate ... to admissionGate` → `BehaviorAccess` assembly:

| Native action               | Request type                       | Permission or result                                             |
| --------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| `APEMemory::CaptureMemory`  | `APEMemory::CaptureMemoryRequest`  | Contribute a candidate note                                      |
| `APEMemory::RecallMemory`   | `APEMemory::RecallMemoryRequest`   | Read notes within its scope without changing their status        |
| `APEMemory::ReviseMemory`   | `APEMemory::ReviseMemoryRequest`   | Revise a candidate while checking its exact version              |
| `APEMemory::ReviewMemory`   | `APEMemory::ReviewMemoryRequest`   | Admit, request a revision or refuse under the applicable mandate |
| `APEMemory::WithdrawMemory` | `APEMemory::WithdrawMemoryRequest` | Withdraw an exact note from current use                          |

The requests and their fields are described in
[`memory.sysml`](../../../models/memory.sysml). Their native descriptions are
passed in the builder’s call schemas.

Exposing capture does not expose admission or reading. Mutating existing content
also requires permission to read it. In this first implementation, operations
are local and the caller is the native owner. With `allowSelfAdmission=false`,
that operator therefore cannot admit its own notes. To exercise delegated
self-admission, the value `true` and the review exposure must have been
explicitly admitted in the model. This is not an independent review.
Cross-operator review is not implemented by this work.

## Check promotion

A contribution supplies `id` and `contentJson`. The latter contains exactly
`text`, `origin`, `scope`, `validUntil` and `outcome`. `origin.decisionId`
contains the bare identifier of a real assistant decision message in the local
journal, with no prefix. `sourceRefs` and `outcome.evidenceRefs` take the form
`message:<identifier>`. A `known` outcome keeps its summary and references to
recorded native observations; a string asserting an outcome does not replace
those links.

`validUntil` uses an ISO date with an explicit time zone (`Z` or a `±HH:MM`
offset) and, if fractional seconds are supplied, one to three decimal places.
For example: `2026-10-22T12:00:00.000Z`. The date must also respect the model’s
maximum duration; this format example grants no permanent validity.

The expected workflow is:

1. Capture an observation. The receipt says `candidate`.
2. Recall it. It remains a candidate and does not enter `memoryGuidance`.
3. Request authorized admission for the exact revision and digest.
4. Observe the usable note in `memoryGuidance` at the next decision, only if
   local inspection is exposed.
5. Withdraw it, then check that it is absent from usable guidance, including
   after a restart and replay of an older request.

Writes preserve their history, use a revision/digest CAS and a unique invocation
correlation. Replay does not turn a withdrawal into a new admission. Responses
to agents contain compact views: the full history and content of earlier
operations remain internal. Withdrawing a note does not erase observations
already present in the conversation journal.

## Review and adopt the revision

Follow the [normal revision workflow](../evolution/reviser-systeme.md).
Validation compiles the sources, policies, exposures and allocations. Accepting
a new policy in the repository does not change a running operator’s contract:
its next decision is blocked if the executable digest has changed, until
explicit adoption.

The production tests are
[`information-policy_test.ts`](../../../test/integration/information-policy_test.ts)
and
[`information-execution_test.ts`](../../../test/integration/information-execution_test.ts),
supplemented by tests for the domain, preparer, binding and memory store. The AI
model transport is simulated there; they qualify the mechanisms, not a model’s
ability to discover this design on its own.
