# Conversational Case Management

Assembly implements a bounded part of this envelope: an operator continues the
same case across contributions, chooses the next permitted action, receives the
observed result and may wait for another contribution. Messages and events stay
in the durable conversation and carry `caseId` to identify the work case. The
**Case Request** is this same conversational case, now separate from the
session: its objective, owner, origin, creation version, budget and status are
persisted with the system state.

The admitted `conversation` occurrence selects its action definition from the
[conversation model](../../../models/conversation.sysml). The historical
`ConversationCase` remains supported; `ConsultingConversationV1` provides the
explicit `operator-command-v1` profile. Configuration, allocations and limits
come from the [system model](../../../models/configuration.sysml). This page
describes the implemented path; it does not claim conformance to the entire
pattern.

## Following the case

1. **Read the case.** `ReadCaseState` supplies the current case for the next
   choice. The host retains the session and rereads the admitted execution
   contract.
2. **Choose what comes next.** The default revision 2 flow proceeds directly to
   `ChooseNextMove`, which assigns a judgment to the operator: reply, request a
   call or propose a change. Available rights and capabilities come from the
   admitted model.
3. **Check, then observe.** A tool or behavior call passes through
   `CheckRequestedAction`, followed by authorized execution or refusal. The
   recorded result returns to the case before the next choice. A proposal
   follows its separate validation and admission path. Internal commands use the
   profiles' explicit `ExecuteOperatorCommand` action and return their outcome
   to the flow. When an authority-escalation notice wakes the designated
   operator and its delegated decision is recorded successfully, the flow waits
   for input without issuing a further assistant reply. Other command outcomes
   return through observation for another choice. A person-opened decision turn
   keeps its ordinary reply path. A quiet preamble does not end the waking turn:
   termination follows the recorded delegated decision, and any queued provider
   calls after it are cancelled with explicit receipts. A command refusal,
   failure or turn limit without that recorded result follows the ordinary flow
   and its limits. This route requires a newly compiled contract declaring the
   command's `submission` output; existing admitted pins retain their original
   behavior.
4. **Wait for input.** After a reply, or while waiting for an external decision,
   `AwaitCaseInput` suspends the flow. Another contribution allows it to resume
   under its retained admitted model pin.

The model's successions, guards and bindings determine these transitions. The
[runtime adapter](../../../src/adapters/work/runtime/native-graph.ts) compiles
them to LangGraph nodes and edges; LangGraph schedules transitions and owns
interrupts and checkpoints. The
[conversation service](../../../src/application/work/conversation/turn.ts)
supplies host primitives and records observations. A request or admission alone
does not prove that the requested effect succeeded.

## Consulting the model during a choice

[Targeted consultation](../../reference/contexte-et-memoire/consultation-ciblee-modele.md)
provides additional information needed by `ChooseNextMove`. Search, inspection,
reading and unloading are available on demand when the admitted policy grants
`mayConsultModel`. Reading may be granted alone; proposing revisions also
requires this read right.

A `consult_model` decision is dispatched by `ExecuteOperatorCommand` under
`operator-command-v1`: the host checks the request and records its result, then
the modeled route returns through observation before another choice. The
historical flow without this explicit command action refuses that decision. This
targeted read is distinct from `ConsultDeclaredModelSource`: a private or
retained older flow can declare that step, which the host executes on the exact
admitted version. Its success and failure branches are explicit. A declared read
grants no targeted read right, and existing pins retain their declared behavior.

Every new provider decision at `ChooseNextMove`, including a consultation
request, consumes the same `maxAgentDecisions` budget. Its value comes from the
admitted execution policy, with no additional provider budget reserved for
reads. The `maxFlowSteps` bound separately controls the executed path.
Consultation contracts, refusals and limits are detailed in its reference.

## Waiting, resumption and versions

At suspension, LangGraph retains flow values and the next action in a
checkpoint; production persists checkpoints and execution receipts in
PostgreSQL. Resumption requires the exact admitted model, invocation and
contribution. Completed effect receipts prevent replay of recorded work; an
uncertain effect requires reconciliation. A checkpoint alone cannot guarantee
exactly-once external effects.

Explicit adoption can retire a verified empty input wait and authorize a
successor under the new model. Retained work or an unfinished promotion can
block adoption; a new source version does not silently rebind an existing
checkpoint. Historical `conversationCursor` fields remain compatibility data.

The source version consulted to prepare a revision and the admitted execution
version have different roles. Admission into the local Git repository does not
automatically change a session's rights. The
[revision guide](../../how-to/evolution/reviser-systeme.md) describes the
passage from proposal to source acceptance and contract adoption.

Waiting keeps the Case open. A local command can close it as completed
(`closed-done`) or abandoned (`closed-abandoned`). The agent's instructions ask
it to propose closure only when the person explicitly requests it. This closure
decision alone is not independent evidence of the expected effect. The next
piece of work opens a new Case in the same conversation. A shared durable
allocator assigns a unique number to every Case in the system. The link to the
model adopted at creation is retained as provenance; explicit adoption updates
the runtime contract once retained execution permits it. This implementation
does not provide an accepted transfer of custody of the Case and its
obligations. A delegated contribution and its correlated receipt do not
constitute an **Acknowledged Handoff**.

Tasks assigned to specialists remain in the central agent's Case, with its
objective, budget and their receipt. The entry point chooses the invocation's
scope: a human instruction resumes the open local Request; a delegation carries
the central Case explicitly. Without a local Request, a human response to
delegated work retains its receipt and scope. Closing a local Case targets its
identity independently of the latest delegation.

Each candidate retains the `caseId` written at creation, outside its digest.
Completing a Case remains refused while a candidate is pending. Abandonment
moves its nonterminal candidates to `failed` with the reason `Case abandoned`,
updates their catalog stage and clears their associated continuations and budget
suspensions. Another Case cannot resume them.

Preparing initial tools opens a system Request with origin `initialization` and
its own optional budget. It closes the Request on success or failure; restarting
abandons an interrupted bootstrap. A preparation already completed opens no new
Case. An older state without Cases remains readable: when an open case resumes,
a Request marked `migratedFrom: legacy-dossier` preserves the existing
reservation scope and historical journals. This one-time migration also writes
its candidates' membership. A historical specialist with a pending continuation
receives this local Request from the work receipt: its caller and text are
retained as origin and objective. A historical plan may link to it if its caller
owns it, regardless of the allocated number. A candidate or continuation without
an explicit scope fails with `CASE_SCOPE_MISSING`, its context and recovery
guidance, before any budget access. The
[Cases reference](../../reference/operateurs/cases.md) describes this
separation, the APIs and the partial implementation of Jobs and Watches. A Job
or Watch owns a durable Case declared in the model; each of its runs or wakes
has its own budget, while a Request retains the cumulative budget of its
conversational case.

## Paths and evidence to consult

| Need                                                                                  | Entry point                                                                                                                               |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Exercise dialogue, proposals and resumption after admission                           | [Mandate evolution tutorial](../../tutorials/evolution/evolution-mandat.md)                                                               |
| Understand separate cases and operator contracts                                      | [Conversations and contracts](conversations-et-contrats-operateurs.md)                                                                    |
| Check compiled branches, bindings, refusals and bounds                                | [Flow contract tests](../../../src/domain/model/execution/flow_test.ts)                                                                   |
| Check production checkpoints, delivery and effect recovery                            | [PostgreSQL runtime tests](../../../test/integration/postgres-production-runtime_test.ts)                                                 |
| Check native contributions and their resumption without repeating recorded work       | [Operator work tests](../../../src/application/work/runtime/work_test.ts)                                                                 |
| Check the shared budget for choices and consultations                                 | [Model context tests](../../../src/application/work/runtime/model-context_test.ts)                                                        |
| Check how compiled sources affect executed controls                                   | [Execution from SysML tests](../../../test/integration/source-execution_test.ts)                                                          |
| Consult the historical qualification of 22 October 2026 with OpenSysML and TerminusDB | [Targeted consultation qualification](../../reference/contexte-et-memoire/consultation-ciblee-modele.md#qualification-du-22-octobre-2026) |

Mechanism tests and integration trials have different scopes. The qualification
report identifies transports replaced by test doubles and the prerequisites for
real trials; their presence in the repository is not an execution result for a
particular system.

The **Deterministic Envelope** and **Event-Triggered Reassessment** envelopes
have a partial implementation in the engine: scheduled Jobs, timer-triggered
Watches, history and budgets per run. This does not qualify every deterministic
route or reassessment on external events. Jobs and Watches are frozen for the
Request-focused demo; proposing them for a recurring need remains allowed. See
[Requests, Jobs and Watches](requests-jobs-et-watches.md) and the
[Cases reference](../../reference/operateurs/cases.md).

[Back to the Assembly documentation](../../README.md).
