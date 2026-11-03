# Delegate a SysML editing scope

This implementation of **Operator Identity & Mandate** controls the internal
model-writing tools. It contributes to **Proposal–Admission–Execution
Separation**: an authorized proposal remains a proposal; merging and adopting it
are separate decisions.

## Declare the delegation

The admitted execution policy must grant `mayProposeSysmlRevision` and model
read authority through `mayConsultModel`. For historical policies that omit
`mayConsultModel`, read authority follows the retained revision right. The right
to edit also requires an `AssemblyModelEditing::ModelEditPolicy`, bound to the
builder and its mandate in the same `ConversationSystem`. The historical text
field `scope` grants no editing rights.

The definition is in [model-editing.sysml](../../../models/model-editing.sysml).
It is supplied to new projects without giving them implicit permission. An owner
can admit a policy such as this one in the project's complete sources:

```sysml
part editPolicy : AssemblyModelEditing::ModelEditPolicy {
    attribute :>> id = "collector-model-editing";
    attribute :>> revision = 1;
    attribute :>> operations = "[\"set-value\",\"rename\",\"insert-member\",\"remove\"]";
    attribute :>> grants = "[{\"file\":\"mission.sysml\",\"qualifiedRoots\":[\"Work::collection\"]}]";
}
bind editPolicy.holder = builder;
bind editPolicy.mandate = builderMandate;
```

Place this example **inside** the system declaration, beside `builder` and
`builderMandate`. `mission.sysml` must contain the exact declaration
`Work::collection`. Arrays use canonical JSON without unnecessary whitespace.
File/root pairs stay together: a right over a root in one file does not
authorize that root in another.

The available operations are `set-value`, `rename`, `insert-member`, `remove`
and `replace-source`. The last one authorizes the tool that proposes complete
files, with the same scope checks. It does not grant the right to change the
whole file.

Each operator owns its policy and bindings. To revoke its rights, the owner
removes the policy, narrows its operations or roots, or disables the capability.
The owner increments the revision when changing a policy. Even a content change
without a revision increment invalidates old proposals through the policy
digest.

## What the check verifies

The host derives the proposer's identity from the admitted system. The agent
supplies neither its authority identity nor a list of permissions to trust. The
repository retains the holder, mandate, policy and their revisions with the
proposal.

Before recording the proposal, the complete model produced by the editor is
compiled. The check independently locates the authorized roots in the sources
before and after the edit, then verifies that **all text outside them remains
identical**. It does not rely only on the requested element or the diff reported
by the editor.

For example, renaming an element in `Work::collection` may rewrite a reference
in `Work::analysis`. If this second root is not part of the delegation, the
whole proposal is rejected. Other files, and comment or import changes outside
the scope, are checked as well.

At admission, the repository merges with the current version and checks the
complete result again. It rereads current rights, rejects a modified or revoked
delegation, then publishes only if the expected Git head is still unchanged.
Recovery of an interrupted publication repeats this check before restoring a
publication that had not taken place.

## Explicit limits of this version

- Roots must exist before and after, with the same name, owner and declaration
  type. Renaming or removing **the root of the grant** is rejected; renaming or
  removing its descendants remains possible.
- Added, removed or moved files, ambiguous or overlapping roots, and
  unverifiable source positions are rejected.
- Rights cover editor operations and their scope. The check guarantees that all
  changes remain confined; it does not claim to prove that a faulty editor made
  only one semantic change inside an authorized root.
- A delegated edit cannot change mandates, policies, executable flows, contracts
  and exposures, or the active catalogue. The check compares every system's
  runtime contracts and the catalogue before and after.
  [Delegated administration](administration-deleguee.md) has a separate path to
  grant or revoke editing rights within the mandate's limits; it does not
  authorize unrestricted policy changes.
- The runtime digest retains native identities. A compiler-generated identity
  change can therefore cause a conservative refusal; it never relaxes rights.

## Local owner and existing data

The local revision-proposal API represents an owner action. It constructs the
`local-owner` authority itself and rejects fields that attempt to supply it in
the request. This path can introduce a policy into a project that does not yet
have one. The proposal must then be admitted and the version explicitly adopted.
The local interface does not authenticate a remote human identity.

Operator tools always use their mandates. They cannot select this owner path in
their JSON. Existing projects and their admitted versions are not rewritten to
grant new rights.

These controls apply to internal model tools. They are not a filesystem sandbox
for a developer who directly owns the Git repository or the host process's
permissions.

## Read the code and verify

- [Domain policy](../../../src/domain/governance/policies/model-edit-policy.ts)
  and
  [native compilation](../../../src/adapters/out/sysml-toolkit/compilation-policies/governance/model-access/editing/policy.ts).
- [Before/after confinement](../../../src/adapters/governance/model-access/editing/scope.ts).
- [Proposer authority and protected controls](../../../src/adapters/governance/model-access/source-authorization.ts).
- [Git publication and recovery](../../../src/adapters/out/git/repository.ts).
- [Deterministic tests with Toolkit](../../../test/integration/model-edit-mandate_test.ts).
- [Explicit AI qualification](../../../tools/qualify-model-edit-mandate.ts), run
  separately from normal tests and limited to two provider calls.

The deterministic tests prove refusals even when the agent directly attempts a
forbidden operation. The AI trial checks use of context and tools; it does not
replace these controls.
