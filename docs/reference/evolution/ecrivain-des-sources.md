# Model source writer

Contract read from the code on 25 October 2026 (`73b3ed6`). This page describes
the host writer. Concurrent replay and the extensions still to implement remain
open.

## Preparation and verification

Declaration producers construct `HostEditRequest` values. The writer resolves
them against an immutable base and passes the changes to SysML Toolkit. It owns
neither a Git repository nor a lock.

- `applyEdits(tooling, base, requests, { compile? })` accepts 1 to 32 ordered
  requests. It returns the candidate sources and durable edit plan. `batch`
  groups, when specified, range from 0 to 31. An insertion can introduce the
  target of a later operation.
- Each durable target retains its native identifier, qualified name, metaclass,
  optional owner and the preimage of the member's text.
- `verifyEdits(candidate, edits, { base })` checks the final results, base
  preimages and preservation of declarations outside the targets. The base is
  omitted only when reading back an immutable publication.

Compilation alone is therefore insufficient: an edit that compiles but changes
the wrong member is rejected before publication.

Sources: [edit types](../../../src/domain/model/editing/host-edit.ts),
[preparation and verification](../../../src/application/model/editing/host-writer.ts).

## Operations and errors

| Host operation    | Content                                       |
| ----------------- | --------------------------------------------- |
| `setFeatureValue` | New scalar value for an attribute             |
| `insertMember`    | Member text, owner and read-back expectations |
| `replaceMember`   | Replacement of the targeted member            |
| `setFeatureType`  | New type for the target                       |
| `remove`          | Removal of the targeted member                |

An insertion expectation contains either a literal value or a member (qualified
name, metaclass, text or digest). An authority insertion specifies
`intent: "authority"` and retains a member expectation. Large declarations can
be stored losslessly as `gzip-base64` in the receipt.

This is not the agent tool's contract: `propose_sysml_edit` currently exposes
`set-value`, `rename`, `insert-member` and `remove`. Extending it to all Toolkit
operations remains in the plan.

`HostEditError` provides `code`, `context` (`opIndex`, operation, target) and
`recovery`. Current codes are `TARGET_MISSING`, `TARGET_AMBIGUOUS`,
`TARGET_MODIFIED`, `LITERAL_KIND_CHANGED`, `SPLICE_OUT_OF_SCOPE`,
`TOOLKIT_REFUSED`, `READ_BACK_MISMATCH`, `COMPILE_ERROR` and
`MIGRATION_DEPENDENT_REFERENCE`. Only `TARGET_MODIFIED` requires a reload; the
others reject the operation. This classification does not authorize silent
replay against another base.

## Git publication

The `updateSystemSources(update, author, { publication?, verify? })` port links
preparation to publication. Preparation, compilation and verification currently
run under the repository's exclusive lock.

1. Recover interrupted publications.
2. If a receipt is provided, look for a publication with the same `changeId`. An
   identical receipt returns the already published revision; a different receipt
   is rejected.
3. Read the head again, call the transformation against this base and compile
   the candidate.
4. Call `verify` on the compiled candidate before creating the commit.
5. Create the snapshot and move the head reference by compare-and-swap. The
   publication reference is created in the same Git transaction.

With no source change, the transformation creates no commit. Publication of an
approved change must change the sources; candidate activation has a separate
idempotent path.

The callback remains reserved for internal source preparation. It must not call
a language model, execute an external tool or call a repository command again.
Moving preparation outside the lock remains open.

Sources: [repository port](../../../src/application/model/repository.ts),
[Git repository](../../../src/adapters/out/git/repository.ts).

## Receipts and recovery

`ChangePublication` and `CandidateActivationPublication` retain published edits.
The compatibility reader accepts current operations as well as historical writer
operations, authority and scalar-edit formats. It projects this evidence to
verify the publication; it does not replay the operations. Older encodings and
digests remain readable.

The approval receipt is bounded to 65,536 bytes. Edit text has a separate limit.
The technical author identifies, in particular, `ase:approved-change:<changeId>`
or `ase:activate-candidate:<builderId>`; it does not replace the decision and
authority exercise recorded in the receipt.

The integrity anchor is the Git commit chain. A content hash alone is not an
operator signature. For decisions and authorizations, see
[model authority](../operateurs/autorite-du-modele.md).

Sources: [receipts](../../../src/domain/model/publication/change.ts),
[compatibility](../../../src/domain/model/publication/compatibility.ts),
[post-publication read-back](../../../src/application/model/source-model.ts).

## Candidates and activation

A candidate's state—proposal, test, review, activation or failure—lives in
runtime storage. The SysML catalog receives the tool at activation, in one
revision. A tool in the catalog is active by definition; views of candidates
still in progress must read runtime state separately.

The activation intent retains the `activating` stage and admitted model digest.
Admission, recovery, restart and abandonment triggers go through the same
service. Admission allows at most five publication attempts. Only failures
classified as transient retain the intent for a later trigger; an admission
precondition that has become false ends the attempt and requires a new proposal.

Older `ase:record-candidate` and `ase:record-stage-observation` commits remain
readable historical data; they no longer describe the current path.

Sources:
[activation rules](../../../src/domain/work/policies/candidate-activation.ts),
[orchestration](../../../src/application/work/candidates/activation.ts).

## Current limits

- Publication of an `operatorAuthority` policy is not yet connected to the
  single producer.
- Complete-source proposals are still merged by a three-way textual merge. The
  writer's preimages do not yet provide full concurrent replay of operations;
  this remains open.
- Bootstrap (`addPackageFragment`, `withInitialTools`) and one preview read
  retain textual processing. The "Toolkit as sole reader and writer" rule
  therefore remains a direction with these explicit exceptions.

`host-source-writer_test.ts`,
`test/integration/git-model-repository-compatibility_test.ts` and the promotion
tests contain the verification cases. This documentation pass read them; it did
not rerun the suites.
