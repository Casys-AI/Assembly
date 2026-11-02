# Operator conversations and contracts

A system can have several operators without multiplying its business engines.
The workbench instantiates the same conversation engine for each concrete
occurrence of `ConversationSystem`. Each has a native identity, a session, a
catalogue, a flow and an admitted execution contract. Versioned SysML sources
are shared.

## One point of contact, separate entries

The main point of contact serves as the default human conversation. Another
operator can expose its own human entry if its model provides one. A specialist
can also receive only requests sent through a native `AgentInbox` entry.

The conversation list represents these possibilities. It does not create agents
or grant any rights. Pinning an operator keeps its conversation within reach; it
does not make its entry callable. Similarly, viewing a reviewer's decisions does
not automatically expose a human conversation with that reviewer.

A transmission is an admitted behaviour between a specific caller and target.
The recipient receives the transmitted objective and the evidence of its
admission. It does not receive other conversations' history. The return carries
the contributions belonging to this work, with its correlation, state and model
references.

## Shared sources and separately admitted contracts

The repository keeps a shared source history. Operators can propose changes from
the same base and have them integrated through the revision process. This
publication does not silently change their execution contracts.

Three decisions must be distinguished: accepting a source proposal, admitting
the operator roster held by the point of contact, and adopting a contract for a
given session. The first changes the accepted model. The next two authorise the
execution that was reviewed. Contracts can therefore refer to different
immutable source versions during a transition. Adopting a primary digest does
not imply consent to a new instruction or new rights for a specialist.

On restart, a session resumes its admitted contract. Inspecting current sources
can report an available version or a compilation failure. It must not recreate a
deleted operator or force through a change. A historical contract alone is not
enough to execute an action: the native read must still confirm that admitted
exact pin. A source-only HEAD advance with the same executable digest does not
force the session to abandon its retained version. Using the newer catalog
requires explicit adoption of its repository version at a safe boundary; no live
cross-version HEAD revocation mechanism is implied.

## Plans, waiting and the coordinator's responsibility

A closed plan contains its tasks, dependencies, targets and parameters before
its first effect. Native exposures are checked for the whole plan. Independent
tasks can advance in parallel; access to the same resource remains sequential.

The scheduler orders admitted work. It does not invent targets or turn a reply
into evidence of completion. A wait blocks the affected dependencies until an
explicit resumption and a reconciled result. Receipts and stable identifiers
make it possible to recognise work already performed without reissuing its
effects.

A dependency is not an implicit data transfer. To use a tool that another
operator has just built, the coordinator must first obtain its actual result,
then pass its references in a subsequent work item. The mechanism provides
neither a calendar, a perpetual loop nor execution of an unsupported envelope.

## Sharing code does not share authority

The catalogue visible in **Tools** gathers candidates from each owner. Two
occurrences with the same name or digest remain distinct: they can have
different local states and admissions.

Reusable publication requires an active artefact, its tests, its admission and a
native catalogue consistent with its bytes. An authorised lookup returns its
references. Import copies the exact code and preserves its provenance, then
follows the recipient's tests and promotion. The producer's network rights,
contracts and admission authority are not transferred with the code.

These mechanisms serve any system described by the supported primitives. The
[commercial-watch](../../../test/fixtures/commercial-watch/README.md) test
fixture gives them a concrete mission; it adds no execution path reserved for
that mission.

To operate a system, follow the
[multi-operator guide](../../how-to/operateurs/operer-plusieurs-agents.md). For
fields and routes, consult the
[conversation reference](../../reference/operateurs/operator-conversations.md).
