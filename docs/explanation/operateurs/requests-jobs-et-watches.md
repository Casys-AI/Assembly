# Requests, Jobs and Watches

A Case gives work an identity. A conversation is one way to advance it; a
schedule is another. Separating the two preserves the objective, provenance and
observations when work waits for a contribution or wakes up later.

## One design conversation, several Requests

The main operator in the initial model is named **Main Operator**. It designs
the system with the person and creates the operators responsible for Requests.
Its design conversation persists outside any Case. A Request is a separate
conversation with its objective, owner and budget. Several Requests can remain
open, with only one turn executing at a time per operator.

A specialist contributes to the caller's Case. Its receipt links the task to
that Case without constituting an acknowledged handoff: responsibility and
obligations do not change holders. Current limits on resumption and abandonment
across several runtimes remain in place.

## Three forms, different implementation states

| Form    | APE envelope                   | Principle                                                 | Current implementation                                                                                                                        |
| ------- | ------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Request | Conversational Case Management | A contribution advances the same case.                    | Dialogue, waits, resumption and budget. An operator can abandon a Request; closing it as done is an authenticated command with no button now. |
| Job     | Deterministic Envelope         | A scheduled declaration starts a behaviour.               | Typed schedules, execution history and manual start; not a qualification of every route, branch and decision in the Deterministic Envelope.   |
| Watch   | Event-Triggered Reassessment   | The same case reassesses its source and reports a change. | Timed wakes, structured result and durable notification; no external event connector.                                                         |

The envelope is declared on the `CaseType` occurrence. The engine nevertheless
retains conversational primitives: importing a library or naming an envelope is
not enough to make a behaviour executable.

On 24 October 2026, the demo was refocused on Requests; Jobs and Watches are
frozen. On 25 October, Erwan retained the main operator's ability to propose a
Job or Watch for a recurring need. Such a proposal authorises no further
development and proves no end-to-end operation.

## Why a durable declaration goes through the model

A Job or Watch is created when its declaration is adopted, after source
acceptance. Scheduled deadlines add executions to the same durable Case. Each
execution or wake receives its budget; it does not renew credit with every
message. The owner's mandate, tools and grants continue to apply.

Pause, resume and stop act on execution and are traced without changing the
model. The deadline advances before the call to avoid a burst of catch-up runs
after interruption. A Watch notification remains untrusted observed data,
distinct from an instruction or the main operator's words. Its durable queue and
identity allow deduplication on receipt.

## Provenance is not a migration policy

The Case retains the model under which it was created. Today, adoption changes
the runtime's contract, including for its open Cases; `modelPin` does not pin
their execution to the earlier version. The explicit choice between continuing,
migrating, replacing or suspending remains to be designed with the Process
Version Governance pattern.

The [Case reference](../../reference/operateurs/cases.md) describes the APIs,
schedules, controls and limits. The
[desktop guide](../../how-to/atelier/parcourir-le-bureau-et-les-cases.md)
describes navigation.
