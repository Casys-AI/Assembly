# Budget-Bounded Loop

The work budget bounds cumulative agent invocations for a case beyond a single
conversation turn. The counter belongs to the durable scope referenced by the
**Case Request**: a new message or process restart does not reset it. Only the
resumption of a case predating Cases retains its historical
`SystemRuntimeState.id` scope. Every new Case, including tool bootstrap,
receives its own `scopeId`. Delegated tasks consume the central Case's budget.
Another Case has its own budget; this implementation provides no shared ceiling
across multiple cases. It is enabled by an explicitly admitted native policy.

An `AssemblyCases::CaseType` can also declare `maxInvocations`. If it coexists
with the historical policy, the effective ceiling is the smaller of the two and
preserves the existing registry's identity. Without that policy, the type's
ceiling provides the Case's reservation policy. Closure preserves its registry;
adopting a new model between Cases does not change its consumption. The next
reservation is established when the next Case opens.

For a Job or Watch, the Case remains durable, but the reservation scope is
specific to each run or wake. Its `maxInvocations` bounds that work, including
delegated invocations. Triggering it adds no rights to the owning agent's
mandate. See the
[Jobs and Watches reference](../../reference/operateurs/cases.md#jobs-et-watches-déclarés).

Delegated resumption preserves the central Case's identity and reads its
currently adopted budget policy again. A human response continuing that work
carries its receipt and follows the same rule. If the specialist has an open
local Request, a human instruction resumes that Request with its own objective
and budget. A closed central Case refuses any resumption. When a new Case
arrives, the specialist discards the previous Case's suspended cursor and
context.

## Building it in Assembly

The model declares an `APEWorkBudget::InvocationBudgetPolicy` directly under the
`ConversationSystem`. Local control admits and then adopts this policy; a
proposal alone supplies no credit. The engine reserves a unit before each
`AgentPort.decide`, `review` or `admit` invocation, then records its return or
failure. The durable registry and its concurrency control prevent reserving the
same balance twice.

A unit is an **invocation of this port**, not an HTTP request: one Muse
invocation can contain three internal model steps. Tools, tokens, euros, time
limits and quotas shared between operators are not bounded by this counter.
Technical per-turn limits continue to exist separately.

When the budget is exhausted, the engine suspends the flow at the exact point
reached, preserving the candidate and continuation. A compatible budget
revision, explicitly adopted, followed by a new message allows it to resume. An
uncertain result causes no automatic retry; a completed contribution does not
prove that the case's objective has been met.

## Act, inspect and verify

- [Bound a case](../../how-to/execution/borner-un-case.md): declare a small
  ceiling, inspect its adoption and handle the wait.
- [Budget contract](../../reference/execution/budget-de-travail.md): units,
  durable state, changes and limits.
- October 22 qualification: native path, resumptions, review and limits of the
  evidence.
- [Propose and adopt a revision](../../how-to/evolution/reviser-systeme.md):
  normal path for changing the executable contract.

The main sources are the [domain](../../../src/domain/work/policies/budget.ts),
[service](../../../src/application/work/budget/service.ts),
[invocation boundary](../../../src/application/work/budget/agent.ts) and
[native policy reader](../../../src/adapters/out/sysml-toolkit/compilation-policies/work/budget-policy.ts).
Their colocated tests cover replay and invariants, reservations and revisions,
failures around dispatch, and the SysML declaration respectively. These links
identify tests to inspect; this page is not an execution report.

The primary APE contract is
[Budget-Bounded Loop](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/control-3-6.mjs).
This implementation applies a local measurable unit; it does not qualify every
possible consumption dimension of the pattern.
