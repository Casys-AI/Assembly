# Administer editing rights through a mandate

This extension of **Operator Identity & Mandate** distinguishes the right to
edit, the right to grant permission and the right to pass on that administrative
authority. It uses the **Proposal–Admission–Execution Separation** workflow.

The administrator's mandate determines which recipients it can authorize, and
which operations and scopes it can pass on. A granted permission is bound to the
recipient's exact mandate. An available capability or the name “administrator”
is not enough to grant these rights.

## Declare the initial authority

The owner introduces and admits the
[model-administration.sysml](../../../models/model-administration.sysml)
definition, then an occurrence in the administrator's system:

```sysml
part administration : AssemblyModelAdministration::ModelAdministrationPolicy {
    attribute :>> id = "collection-administration";
    attribute :>> revision = 1;
    attribute :>> operations = "[\"set-value\",\"rename\"]";
    attribute :>> grants = "[{\"file\":\"mission.sysml\",\"qualifiedRoots\":[\"Work::collection\"]}]";
    attribute :>> recipients = "[\"Project::coordinator\",\"Project::collector\"]";
    attribute :>> maxRedelegationDepth = 1;
}
bind administration.holder = builder;
bind administration.mandate = builderMandate;
```

Recipients identify exact `ConversationSystem` occurrences; their operators and
mandates are resolved in the same model version. Arrays use canonical JSON, as
in the editing policy. The `mayProposeSysmlRevision` capability must also be
active for the affected operators. The definition alone grants no rights to new
or existing projects.

This policy grants the right to grant permissions, without granting the right to
edit. Editing requires a separate editing policy or a delegation that authorizes
it.

## Grant and redelegate

An authorized operator has the internal `propose_model_delegation` decision. It
carries the version and source digest it consulted, a reason and a structured
operation:

```json
{
  "kind": "grant",
  "id": "collection-coordinator-1",
  "targetSystem": "Project::coordinator",
  "operations": ["set-value"],
  "grants": [
    { "file": "mission.sysml", "qualifiedRoots": ["Work::collection"] }
  ],
  "mayEdit": false,
  "recipients": ["Project::collector"],
  "maxRedelegationDepth": 0
}
```

After admission and adoption, the coordinator can grant the collector editing
rights within these limits. It uses `mayEdit: true`, `recipients: []` and
`maxRedelegationDepth: null` for a recipient that can edit but cannot pass on
rights.

An administrative depth of `0` only authorizes granting rights to perform
operations. Each transfer of administrative authority strictly reduces the
depth; the initial depth is bounded at eight. A child's operations, file/root
pairs and recipients must be included in those of its parent. Self-grants and
cycles back to an ancestor are rejected.

The host supplies the issuer's identity, recipient's mandate, parent and parent
digest. The operator cannot supply this authority metadata in its response. The
result is a Git proposal to review through the usual revision workflow. A
proposal grants no permission and does not automatically change the adopted
runtime version.

## Revoke and check the chain

An issuer that is still authorized can propose revoking a direct delegation:

```json
{ "kind": "revoke", "id": "collection-coordinator-1" }
```

The registry retains a revoked entry and its identity cannot be reused. Changing
or removing the initial authority remains an owner action. Revoking or changing
a parent deactivates its incompatible descendants; their records remain
available for inspection and the project continues to load.

Rights are recomputed from the current admitted sources at every proposal,
admission and recovery of an interrupted publication. An editing proposal
created before its parent was revoked therefore cannot be admitted with the old
authorization. An old runtime contract cannot bypass this check.

## Sources and limits

The root policy is a SysML declaration bound to the operator and mandate. Grants
and revocations are retained in `model-delegations.sysml`, in a SysML attribute
containing a canonical JSON registry. This file is part of Git versions and
exports. Assembly's engine interprets this contract; the permissions are not
universal SysML authorization semantics.

The administration path reconstructs an exact change to this registry and
verifies that the other sources remain identical. Ordinary edits, even those
authorized over a broad scope, cannot change this registry, administrative
policies or executable controls.

This version concerns SysML editing rights. Network, invocation and tool
admission rights retain their separate contracts. It accepts only one active
incoming delegation per recipient: an evolution requires revocation followed by
a new grant. An existing direct editing policy remains administered by the
owner; the delegated path does not implicitly replace it. Concurrent registry
changes may require explicit reconciliation before admission.

## Verify the implementation

- [Bounds and chain resolution](../../../src/domain/governance/policies/model-delegation.ts).
- [Root policy compilation](../../../src/adapters/out/sysml-toolkit/compilation-policies/governance/model-access/administration/policy.ts).
- [Construction and validation of the exact operation](../../../src/application/governance/model-access/administration/operations.ts).
- [Real Toolkit and Git scenario](../../../test/integration/model-delegation_test.ts).

Normal tests are deterministic and make no AI provider calls.

The 23 October 2026 qualification report preserves the recorded run and its
limits; it does not qualify later revisions.
