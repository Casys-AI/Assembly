# Concurrent revisions between operators

This contract connects operator sessions to the workbench's normal repository.
The monitoring case is used to qualify these mechanisms; it defines neither a
special profile nor a second engine. The SysML sources, compiled artifact and
versioned compiled graph must describe the same admitted version.

## Division of work

- Sessions, per-agent conversations, task distribution and envelopes: the
  workbench operator implementation.
- Repository, branches, comparison, merging, CAS and revision screens:
  `SemanticRepository` and its read/command adapters.
- Both surfaces share the contracts below; entry-point adaptations must be
  coordinated before restarting the server.

## Repository contract

Identities come from the repository resolved by the host. The strings
`branch:<identifiant>` and `commit:<identifiant>` passed here designate
immutable commits, never the moving name `main`.

```ts
const head = await repository.current();
const proposal = await repository.propose({
  baseVersion: head.version,
  sources: proposedSources,
  author: operatorId,
  reason,
});

const proposalVersion = proposal.proposalVersion;
const comparison = await repository.graphDiff(head.version, proposalVersion!);

const admitted = await repository.accept({
  id: proposal.id,
  expectedVersion: reviewedHeadVersion,
  author: decidingOperatorId,
});
```

`sources` is the complete tree proposed to the repository. The HTTP proposal
adapter accepts partial files and fills them in from the base; a session calling
the repository directly must perform this composition explicitly. Files omitted
from the repository's complete tree are deletions. Sources are compiled and
validated before the branch becomes available for review.

`author` retains provenance; it grants no authorization. The application flow
checks the operator, its native action, its mandate and the model version before
any proposal or decision. Text returned by a provider cannot independently
select an authorized identity.

## Concurrent publication

Two sessions can prepare proposals from the same base S0. Proposal branches
remain distinct. Repository writes are serialized by its shared lock; sessions
do not acquire an independent write connection to the database.

After A is admitted on S0, the current repository becomes S1. B can retain S0 as
its proposal base. Its admission must review S1 and supply
`expectedVersion: S1`; the repository then merges **S0, S1 and B**, compiles the
result, verifies the publication and returns S2. An independent change must be
preserved in S2.

Rejections remain explicit:

- `STALE_REVISION`: the reviewed head has changed. Read and review the context
  again before making another decision; do not silently replace the CAS.
- `SOURCE_CONFLICT`: the changes cannot be merged. Keep the proposal and the
  conflict without automatically choosing a winner.
- Compilation or validation failure: no new admitted version.

Internal design writes use another contract:
`updateSystemSources(update, author, { publication?, verify? })`. It reads the
head again under the same shared lock, prepares sources from that base, compiles
them, then calls `verify` on the compiled candidate before creating the commit.
Preparation, compilation and verification remain under the lock; optimistic
publication with replay is planned work, not current behavior.

`publication` carries the receipt of an approved evolution. The commit and
receipt reference are published in the same Git transaction, with a CAS on the
head. If this `changeId` already has an identical receipt, the repository
returns its revision without calling the transformation again; a different
receipt is rejected. `verify` receives the parent version because the candidate
commit does not yet exist.

A candidate tool's proposal and stages live in runtime state. They no longer
create design commits. After admission, activation publishes its native
declaration through the verified writer with its receipt; revocation can later
remove that declaration. A transformation with no change does not create a
commit but still runs `verify`. An approved publication must change the sources,
except for the idempotent recovery of a candidate activation.

Port types are in [repository.ts](../../../src/application/model/repository.ts),
and the transaction is in
[repository.ts](../../../src/adapters/out/git/repository.ts).

This callback is reserved for internal adaptations: it must not run an LLM call,
tool test, external effect or another repository command. It is not replayed
after a failure. `publishSystemSources(sources, expectedVersion,
author)`
remains a publication of already-prepared sources with strict CAS; `accept`
always requires the version that was actually reviewed.

Model acceptance and adoption of the executable contract are distinct. A session
retains the version to which its execution is attached; publishing another
version grants it no retroactive rights. Inspection and adoption can target its
native `agentId` in the
[revision and history commands](revisions-et-historique.md#adoption-du-contrat-exécutable).
The expected digest and commit designate that contract alone; unselected
sessions retain their admitted pins. The workspace prepares reconciliation
before calling targeted adoption and reserves commands during this flow.

## Comparison and merging

`graphDiff(from, to)` compares the compiled documents in Git. This repository
capability is distinct from the Revisions page, which presents commits with
their source diff in Git format. It no longer displays the historical selector
between text and elements/relationships. Compilation artifacts and metadata are
not component changes.

Current publication merging remains a three-way source merge followed by full
compilation. It handles independent changes in separate files and compatible
textual hunks in the same file. It can still produce a textual conflict between
two structurally independent changes that are close together in the text.

Native structured merging must not be described as active: merging only IR
documents would leave sources and the artifact inconsistent. Introducing it
requires a defined transformation from structural changes to SysML sources,
followed by the same validation before admission.

The 24 October 2026 study compares textual merging, Toolkit operation replay,
deltas and RDF. It also documents counterexamples that prevent the replay
prototypes from being presented as a qualified mechanism. Successful compilation
or an equal application digest does not, by itself, prove that both intentions
were preserved.

## Multi-agent qualification

The 22 October 2026 concurrency report uses a fresh test database and distinct
authors:

1. Two proposals prepared from S0 modify different elements.
2. The coordinator reviews and admits their results; S2 preserves both.
3. Two new proposals change the same property from the same base.
4. The second admission returns a conflict; the head and case remain available
   for inspection without a silent overwrite.

This evidence does not replace running the three agents. The complete flow must
use normal sessions, declared actions and communications, with observable
results and author identities.

The envelope is selected per operator in the model. The coordinator can use the
conversational envelope with the human; specialists can follow a prescribed flow
or converse with the coordinator. A deterministic flow can include LLM
judgments. The presence of a Deterministic Envelope type in the library does not
prove that its flow is executed: the corresponding native flow must actually be
supported.
