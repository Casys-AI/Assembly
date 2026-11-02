# Work budget: invocation contract

An optional policy bounds the cumulative `AgentPort.decide`, `review` and
`admit` invocations for a durable case (`SystemRuntimeState.id`). An invocation
consumes one unit, even if it fails after dispatch. It can encompass several
internal provider steps or requests: the unit does not measure HTTP requests,
tools, tokens, euros or elapsed time.

## Native declaration

An occurrence of `APEWorkBudget::InvocationBudgetPolicy` must be directly
contained in the relevant `ConversationSystem`. Definitions alone are inert.
Without a policy or a previous binding, no work limit is imposed automatically.

| Attribute             | Admitted value                                |
| --------------------- | --------------------------------------------- |
| `id`                  | Stable policy identity                        |
| `revision`            | Positive integer, incremented on modification |
| `unit`                | `"agent-invocation"`                          |
| `limit`               | Integer from 0 to 1,000,000                   |
| `onExhausted`         | `"wait"`                                      |
| `exhaustionRecipient` | `"local-control"`                             |

Source admission and adoption materialize the local control authorized to set
the budget. The operator does not receive this right by proposing the change.
Local control is the declared recipient of the wait; this provision performs no
transfer between operators.

## Durable balance and journal

The view exposes `budgetId`, `scopeId`, `unit`, `limit`, `consumed`, `reserved`,
`remaining`, `exhausted`, `suspended`, `onExhausted` and `exhaustionRecipient`.
`reason: "exhausted"` accompanies the suspension recorded on exhaustion. Totals
are reconstructed from policy, reservation, refusal and settlement events,
rather than accepted as arbitrary counters from storage.

Before invocation, an atomic reservation checks:

```text
consumed + reserved <= limit
remaining = limit - consumed - reserved
```

A return or failure settles the reservation as consumption. A crash can leave
the reservation open: its credit remains unavailable. It is not presumed free
because the worker disappeared. The case's durable marker and the admitted
contract maintain the binding to the registry; losing that registry blocks
further work without recreating a fresh budget. An unavailable or inconsistent
registry also prevents continuation.

Settlement is mandatory: its failure causes the call to fail. Once durable
settlement is acquired, failure to refresh the view is logged without losing the
response already paid for. `budgeted-agent.ts` has enforced this separation
since D3; a stale view does not mean settlement was skipped.

An increase requires a new revision and explicit adoption. It preserves
consumption and reservations. A limit below already committed units is rejected.
Removing the policy or changing its identity does not release the case from its
existing binding.

The initial binding establishes when this accounting starts. Adding a budget to
an existing case does not reconstruct its past invocations. The PostgreSQL
registry uses project, system, execution-space and operator scope; each Case
retains its own budget key within that scope.

## Stopping and resuming

Exhaustion records a wait for local control and preserves the flow position,
candidate and continuation. After adoption of a compatible budget with an
available balance, a new message can resume this work. Adoption does not trigger
an invocation automatically. An uncertain result remains distinct from a
definite failure; this budget does not authorize automatic reissuance.

Registry storage limits still apply: 100,000 events and 32 MiB. The syntactic
maximum of 1,000,000 units therefore does not guarantee that 1,000,000
invocations can be dispatched. Turn limits remain separate; no global multiagent
quota or shared memory is provided.

## Sources and tests

- [Invariants and replay](../../../src/domain/work/policies/budget.ts),
  [tests](../../../src/domain/work/policies/budget_test.ts).
- [Service and concurrency](../../../src/application/work/budget/service.ts),
  [tests](../../../src/application/work/budget/service_test.ts).
- [Boundary before dispatch](../../../src/application/work/budget/agent.ts),
  [tests](../../../src/application/work/budget/agent_test.ts).
- [Native extraction](../../../src/adapters/out/sysml-toolkit/compilation-policies/work/budget-policy.ts),
  [tests](../../../src/adapters/out/sysml-toolkit/compilation-policies/work/budget-policy_test.ts).
- [SysML policy](../../../models/work-budget.sysml).
- [Runtime integration](../../../src/application/work/runtime/work-budget_test.ts).
- [Real storage and concurrency](../../../test/integration/postgres-work-stores_test.ts).
- [Native sources, adoption and recovery](../../../test/integration/work-budget-execution_test.ts).

These tests check the mechanisms with their respective setups; their presence
proves neither financial consumption nor unlimited autonomy. The
[guide](../../how-to/execution/borner-un-case.md) describes the configuration
workflow.
