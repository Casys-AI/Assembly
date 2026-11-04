# Governed Memory Promotion

A recorded observation may become reusable guidance after an admission decision
on its exact content. In Assembly, this transition applies to **durable notes
local to each operator**. This page connects the pattern to its implementation;
the
[pattern reference](../../reference/bibliotheque-ape/patterns-mecanismes-et-guidage.md)
retains the reference contract and the distinction between an available
mechanism and pattern coverage.

## What is implemented

[`memory.sysml`](../../../models/memory.sysml) defines the policy and the five
actions `CaptureMemory`, `RecallMemory`, `ReviseMemory`, `ReviewMemory` and
`WithdrawMemory`. Occurrences and their admitted `BehaviorAccess` determine the
available operations. The
[`InformationBehavior`](../../../src/application/work/context/information-behavior.ts)
adapter checks the caller, version and exposure before constructing the
authority used by
[`GovernedMemoryPromotionService`](../../../src/application/memory/governed-memory-promotion.ts).

The following states and transitions are those of the service:

| Operation                                                                  | Recorded result                                                                                                                                                |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Capture](../../../src/application/memory/governed-memory-promotion.ts)    | Creates a `candidate` note with its content and provenance.                                                                                                    |
| [Revision](../../../src/application/memory/governed-memory-promotion.ts)   | Content in `candidate`, `revision-requested` or `rejected` state may be replaced under revision and digest control; the new content becomes `candidate` again. |
| [Review](../../../src/application/memory/governed-memory-promotion.ts)     | For an exact candidate: `admit` produces `admitted`, `request-revision` produces `revision-requested`, and `reject` produces `rejected`. A reason is required. |
| [Withdrawal](../../../src/application/memory/governed-memory-promotion.ts) | The exact version becomes `withdrawn` without erasing its previous versions.                                                                                   |
| [Recall](../../../src/application/memory/governed-memory-promotion.ts)     | Reads authorized notes, whether candidates or not, without changing their status.                                                                              |

An admitted or withdrawn note cannot be rewritten through `ReviseMemory`:
replacing it requires a new candidate. Expiration is a computed view
(`effectiveStatus: "expired"`), without writing a new revision. Only admitted,
unexpired notes compatible with the current policy have `usableAsGuidance: true`
in [`memoryView`](../../../src/domain/memory/governed-memory-promotion.ts).

The
[`PostgresGovernedMemoryStore`](../../../src/adapters/out/postgres/memory-store.ts)
stores notes, revisions and operation history under project, system, execution
space and operator scope. Writes check the expected revision and digest; the
same invocation cannot be reused for another write. Responses to agents expose
the current version and the history's length without disclosing the content of
all previous versions.

## Provenance and conditions of use

Content includes `text`, `origin`, `scope`, `validUntil` and `outcome`.
`origin.decisionId` identifies an actual assistant decision; `message:<id>`
references identify local journal messages. For a `known` outcome, evidence must
point to recorded tool observations. The
[workspace verifier](../../../src/application/memory/workspace-memory-provenance.ts)
resolves these links. It establishes provenance; it does not by itself prove the
correctness of the written conclusion.

`outcome: {status: "pending"}` retains an unknown outcome. Capture remains
possible with this status; admission refuses it if `requireKnownOutcome=true`.
When the policy allows admission with a pending outcome, admission does not
transform `pending` into `known`. The
[policy checks](../../../src/domain/memory/governed-memory-promotion.ts) also
verify scopes, expiry and required references.

Contribution, recall, revision, review and withdrawal permissions are distinct.
Changing an existing note also requires recall permission. Self-admission
requires both a review exposure and `allowSelfAdmission=true`; the service
checks contributors to earlier captures and revisions. The
[initial baseline](../../reference/contexte-et-memoire/socle-initial-et-skills.md)
sets this clause to `false`. Because the current adapter limits operations to
the local owner, that owner may contribute without being able to admit their own
notes. This implementation does not provide independent review between
operators.

## Policies and evolution

Follow the
[context and memory modeling guide](../../how-to/contexte-et-memoire/modeliser-contexte-et-memoire.md)
to instantiate the policy, expose operations and check conversation-flow
routing. A new system already has these constructs; an existing system retains
its admitted policies. Changing them follows
[revision, acceptance and adoption](../../how-to/evolution/reviser-systeme.md).

Recall retains the note's status: a candidate remains a candidate. Admission
applies to its exact revision and digest. Usable notes enter `memoryGuidance`;
withdrawal or expiration removes their guidance.
[`InformationBehavior.read`](../../../src/application/work/context/information-behavior.ts)
injects this guidance only when local recall is exposed.

Reading reevaluates scopes, expiration and current conditions for required
provenance or known outcomes. Tightening `allowSelfAdmission` or `maxValidityMs`
does not retroactively withdraw a note already admitted; withdrawal has its own
operation. Nor does withdrawal rewrite earlier conversations in which the note
was visible.

## Evidence and code entry points

| What to examine                                                  | Source or trial                                                                                                   |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| States, permissions, provenance, expiration, revision and replay | [Memory service tests](../../../src/application/memory/governed-memory-promotion_test.ts)                         |
| Native exposure, caller isolation and guidance injection         | [Information adapter tests](../../../src/application/work/context/information-behavior_test.ts)                   |
| Persistence, restart and concurrent writes                       | [PostgreSQL memory and skills tests](../../../test/integration/postgres-memory-skills_test.ts)                    |
| Conversation path and policy adoption                            | [Information execution test](../../../test/integration/information-execution_test.ts) and mechanism qualification |
| Recorded trial with a real provider                              | Chat verification of 22 October, with its conditions and evidence limits                                          |

These references qualify specific mechanisms and paths. They do not establish
exhaustive pattern coverage, shared global memory or independent review.

## Relationship to context and skills

[Context Separation](separation-du-contexte.md) organizes the information
presented to a decision and the evidence available for consultation. Memory
promotion decides which notes may become reusable guidance; it does not compress
the journal. [Skills](../../how-to/contexte-et-memoire/gerer-les-skills.md)
retain their own installation and loading operations. Admitting a note writes
neither a skill, a SysML source nor a mandate, and creates no additional right.
