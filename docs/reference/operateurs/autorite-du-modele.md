# Model authority

This page describes the mechanisms present on 25 October 2026. The generic
capability and grant profile remains open.

## Owner and root

A system can declare an `AssemblyCore::HumanOperator` owner who holds an `item`
of type `AssemblyAuthority::Mandate`. This mandate contains a `RootAuthority`
and a `RootGrant`. Two native bindings identify the mandate holder and the
issuer of the root grant. The compiler requires unique occurrences, the expected
types, non-empty identities and a strictly positive integer revision.

The reserved marker is an `authoritySchema` attribute held directly by the
system, typed `ScalarValues::Integer`, with the literal `2`. It requires a
modeled owner. A business member with the same name but a different shape does
not become this marker. Version 2 identifies this mechanism; it does not claim
that a generic `Grant`/`Capability` profile is already implemented.

An older model without an explicit owner retains its
`ownerSource: "implicit-legacy"` provenance. Synthetic compatibility identities
grant no additional rights. For a modeled owner, `ownerSource` is `modeled` and
its identities participate in the executable contract.

## Decision receipt

`AuthorityExercise` records the identities of the system, owner, mandate, root
and grant, as well as the mandate revision. It adds `authoritySchema: 2`,
`action`, `baseModelDigest`, `outOfMandate` and, where applicable, `reason`. The
provenance identifies the state before the effect.

The typed actions are `mandate-change`, `candidate-admission`, `model-revision`,
`model-adoption` and `local-recovery`. Memory promotion and skill installation
have no distinct action in this receipt, even though the `RootGrant`
documentation lists these owner powers.

Local control does not authenticate a person. A receipt naming a human owner
proves neither that person's legal identity nor their actual acceptance of
responsibility.

<a id="publication-et-reprise"></a>

## Publication and recovery

Approving an evolution does not turn it into a grant merely by updating the
application journal. The publication commit carries its `ASE-Approval` receipt
and `ASE-Author` author. The publication and change index are linked by a Git
transaction; recovery looks for this receipt before retrying or rejecting the
decision.

Receipt edits are now host-writer operations discriminated by `op`. Older
`{ owner, name, value }` literals remain a historical read format. The receipt
also covers candidate activation. Checking the edits, compiled contract and
adopted pin prevents a recovered publication from being mistaken for a new
authorization. A stale base can still be rejected while no publication exists; a
recovered publication must be reconciled rather than rejected after the fact.

See the [model source writer](../evolution/ecrivain-des-sources.md) for locking,
preconditions, atomic publication and recovery errors, and
[revisions and history](../evolution/revisions-et-historique.md) for HTTP
commands.

## Three distinct delegation mechanisms

| Mechanism                                           | Power represented                                                | Current limit                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ModelEditPolicy`                                   | Source edits permitted to an operator                            | Bounded scope and operations; does not grant the right to give oneself new authority |
| `ModelAdministrationPolicy` and delegation registry | Delegated administration of editing rights                       | Provenance, depth, cycles, inclusion and revocation specific to this mechanism       |
| `OperatorAuthorityPolicy`                           | Main Operator decision on a recipient operator's network request | Publication through the shared writer; provider acceptance remains open              |

The last mechanism covers only `addNetworkHosts`, for exact recipients and
hosts, with `toolIds: []` and zero redelegation depth. A decision cites the
activated revision of its policy; the receipt adds the actor, policy, issuer,
requester, change, Case and requested rights. The policy carries no count, date
or Case-duration limit.

The publication path goes through `SourceModel` and the shared writer's typed
`publishOperatorAuthorityPolicy` operation. It checks the primary role before
preparation, requires the approved diff and verifies the recompiled policy and
its bindings. Receipts and recovery use the shared publication mechanism. The
former parallel producer and test-only double have been removed. The Git/Toolkit
path is scripted; it does not constitute acceptance of the provider experience
or the complete decision presentation.

For the editing mechanisms already available, see
[rights by mandate](../../how-to/operateurs/droits-edition-par-mandat.md) and
[delegated administration](../../how-to/operateurs/administration-deleguee.md).

## Invariants and limits

The library declares five requirements: an explicit root, inclusion of a
delegated grant, authorization against the prior state, separation between
proposal and grant, and authority checking at use. Existing mechanisms apply
them within their own scopes. `AuthorityInvariantError` currently types only
invariants 1 and 3; there is no general typed-grant engine. Comparing combined
powers after a merge remains future work.

`POST /api/model-revisions` and `POST /api/model-revisions/:id/decision` do not
accept `agentId`: these two commands use the owner authority of the primary
runtime. The adoption command does accept `agentId`. Changing a peer system's
root requires `recoveryReason` at both proposal and decision, with
`outOfMandate: true`. This recovery path creates no grant over the peer.
Renaming the root of a system with a modeled owner recreates its identity and
also requires this recovery path.

Current isolation protects the peer's root, not all its software rights. The
`protectedAuthority` signature also includes ordinary content; it cannot serve
unchanged as a global guard without prohibiting admitted edits. A peer-owner
route, rights isolation and finer-grained root grants remain planned work.

## Contract sources

- [SysML declarations](../../../models/authority.sysml).
- [Owner compilation](../../../src/adapters/out/sysml-toolkit/compilation-policies/governance/authority/owner-authority.ts):
  `compileOwnerAuthority`.
- [Receipt and invariants](../../../src/domain/governance/authority.ts):
  `AuthorityExercise`, `exerciseOwnerAuthority`, `AuthorityInvariantError`.
- [Source authorization](../../../src/application/governance/model-access/source-authorization.ts).
- [Decision policy](../../../src/domain/governance/policies/operator-authority-policy.ts):
  `delegatedAuthorityExercise`.
- [Policy compilation](../../../src/adapters/out/sysml-toolkit/compilation-policies/governance/authority/operator/policy.ts).
- [Declarations through the shared writer](../../../src/application/governance/operator-writer.ts).
