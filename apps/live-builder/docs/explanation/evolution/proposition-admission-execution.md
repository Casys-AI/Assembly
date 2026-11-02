# Proposal–Admission–Execution Separation

[Back to explanations](../../README.md#explanation)

PAE separates proposing work, the decision that authorizes it, and execution of
the admitted operation. These responsibilities can be distributed across
existing components; they do not require three agents. The
[canonical chapter](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/local-mechanism-2-1.mjs)
defines the pattern; this page summarizes its current application in Assembly.

Two paths need to be read separately: promoting a tool and evolving the system's
SysML sources. In both cases, proposing a change grants no additional rights.

## Promoting a tool

The builder submits a candidate with its code and contract. The normal path is
`propose → test → admit → activate`, with a refusal branch. When a reviewer is
configured, a `review` step sits between testing and admission.

| Step                    | Component or responsibility                  | Result and control                                                                                                                             |
| ----------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `propose`               | Authorized builder                           | Creates an identified candidate with a digest of its content and its catalog base. The capability type must fall within the builder's mandate. |
| `test`                  | Host test environment                        | Tests the exact candidate against the available contract. Failed tests lead to refusal.                                                        |
| `review`, if configured | Reviewer designated by the model             | Returns a verdict tied to the exact candidate, tests and contract. A rejected review does not proceed to admission.                            |
| `admit`                 | Admission control under configured authority | Checks the decision applicable to the examined digest. A pending decision does not allow activation.                                           |
| `activate`              | Catalog and host adapter                     | Applies the authorized promotion, reads the native state again and marks the tool active only after confirming the exact candidate.            |
| `refuse`                | Admission control                            | Keeps the refusal in the case and leaves the candidate outside the active catalog. An integrity error causes failure without activation.       |

Reusable actions are in [`pae.sysml`](../../../models/pae.sysml). The initial
assembly, its allocations and the variant without a reviewer are in
[`configuration.sysml`](../../../models/configuration.sysml). The reviewed
variant uses
[`configuration-reviewed-promotion.sysml`](../../../models/configuration-reviewed-promotion.sysml)
and
[`configuration-reviewer.sysml`](../../../models/configuration-reviewer.sysml).

Here, executing the admitted change means **activating it in the catalog**.
Subsequent use of the tool is another operation: the
[`conversation.sysml`](../../../models/conversation.sysml) flow checks its
selection, digest, arguments and mandate before the call. An active tool
therefore does not prove that it has been used or that its use succeeded.

## Who can decide

The normal configuration waits for a human admission command targeting the exact
candidate. A chat message expressing agreement does not replace that command. An
admitted mandate revision can delegate admission of the builder's own tested
candidates to the builder, or add a reviewer with the right to review and admit
the examined candidate. The reviewer is optional; delegated self-admission is
not an independent review.

The model sets allocations, policy and mandates. The
[`SystemRuntime`](../../../src/application/work/runtime/system.ts) service and
[`SystemGovernance`](../../../src/domain/governance/policies/governance.ts)
apply these conditions to actual decisions. Activation is still performed by the
host. To follow the evolution of these rights in the interface, see the
[mandate tutorial](../../tutorials/evolution/evolution-mandat.md).

## Preserved identities and preconditions

Before activation, the host checks, among other things, the candidate's
recomputed digest, successful tests, current catalog base and the absence of an
active tool with the same name. The decision must concern that candidate and
come from the expected authority. When a review is required, its provenance
includes the reviewer, native action, model digest, tests and contract examined.

Resuming a promotion preserves its context and cursor. It requires a flow
compatible with the admitted version. A newly available executable version
blocks decisions and effects until it has been explicitly adopted. A source
advance that preserves the same executable digest does not force adoption to
continue using the retained immutable version. Using that advance's changed
catalog requires explicit adoption of its exact repository version at a safe
boundary. The native read that checks an invocation confirms the admitted exact
pin; it does not overlay repository HEAD onto that historical model.

The digests refer to different objects: the candidate digest binds the code to
its decision; `baseCatalogRevision` identifies its catalog base; the source
commit and executable contract digest identify the selected design and
execution. Their detailed contract remains in
[Revisions and history](../../reference/evolution/revisions-et-historique.md).

## Evolving SysML sources

The [revision guide](../../how-to/evolution/reviser-systeme.md) describes the
commands and screens. Three decisions must remain distinct:

1. **Propose.** The operator must hold `mayProposeSysmlRevision` and
   `mayConsultModel`. It consults an exact source version and reads every
   existing file it changes in full. Its proposal contains the reason, that
   `baseVersion`, and the complete content of changed or added files. Other
   files are preserved; the proposal passes validation before it can be
   examined.
2. **Accept or reject the design.** The command examines the proposal digest and
   current head. If that head has advanced, acceptance performs a three-way
   source merge followed by validation again. A conflict blocks publication.
   Acceptance publishes the design and returns `executionAdopted: false`.
3. **Adopt for execution.** A separate command targets the examined operator,
   contract digest and source version. Other operators retain their admitted
   contract. Publishing sources does not grant them the new rights those sources
   describe.

[Targeted consultation](../../reference/contexte-et-memoire/consultation-ciblee-modele.md)
prepares the proposal without systematically loading the whole model into the
agent's context. It decides neither acceptance nor adoption. Merge rules and
version coexistence are detailed in
[Concurrent revisions between operators](../../reference/evolution/multi-agent-revisions.md).

## Refusing when admission cannot decide — Fail-Closed Admission

Fail-closed admission is part of the engine's primitives. A native construct it
cannot execute is refused at load time; a behavior or tool call passes admission
again before the effect. The engine provides no mode in which indeterminate
admission silently authorizes the call.

In [`executeFlow`](../../../src/domain/model/execution/flow.ts), assertions that
concern only inputs are evaluated before the handler. When the handler returns
without suspending, all assertions are evaluated against the preserved inputs
and the outputs. An output assertion therefore cannot be described as a check
that precedes the effect.

This guarantee covers the interpreted subset and admitted boundaries. It does
not establish idempotence or the internal controls of an external service called
by a tool. Future doctor rules must distinguish these opaque boundaries from the
invariants the engine already enforces.

## Checking the path

- [`source-execution_test.ts`](../../../test/integration/source-execution_test.ts)
  exercises compiled flows: changing a guard or assertion, explicit review and
  refusal of invalid native evidence.
- [`review-native-integration_test.ts`](../../../test/integration/review-native-integration_test.ts)
  connects reviewed promotion to the model adapters and service.
- [`governance_test.ts`](../../../src/domain/governance/policies/governance_test.ts)
  covers mandate decisions and admission of the exact candidate.
- [`model-context-execution_test.ts`](../../../test/integration/model-context-execution_test.ts)
  covers targeted consultation, a proposal on its preserved base despite
  concurrent publication, and acceptance without automatic adoption.

These links identify tests to inspect or run; they are not a new execution
report. The mandate report preserves the scope of its dated trial.

This path is a supported subset. It establishes neither exhaustive compliance
with APE compositions, authentication of a human approver, nor verified closure
of the case. The
[pattern classification](../../reference/bibliotheque-ape/patterns-mecanismes-et-guidage.md)
separates intended properties, available mechanisms and their evidence.
