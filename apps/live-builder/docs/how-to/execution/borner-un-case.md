# Bound a Case's agent invocations

Use this guide to limit the cumulative agent invocations of a Case. The ceiling
persists across messages and restarts. Prepare the change in the system's
sources, then follow the
[revision, review and adoption process](../evolution/reviser-systeme.md).

## Add the policy

In the relevant `ConversationSystem`, add this occurrence directly, preserving
the system's other declarations:

```sysml
part invocationBudget : APEWorkBudget::InvocationBudgetPolicy {
    attribute :>> id = "dossier-invocations";
    attribute :>> revision = 1;
    attribute :>> unit = "agent-invocation";
    attribute :>> limit = 3;
    attribute :>> onExhausted = "wait";
    attribute :>> exhaustionRecipient = "local-control";
}
```

The [`work-budget.sysml`](../../../models/work-budget.sysml) library, which
defines `APEWorkBudget`, must be among the compiled sources. It is included in
the initial sources of new systems. For an older instance, include this file in
the revision proposal. A library definition alone creates no budget. The
three-unit ceiling is a small verification example, not a recommended setting
for every mission. One unit covers a `decide`, `review` or `admit` invocation;
it does not necessarily correspond to a single provider request.

Review the diff, accept the design, then adopt the exact executable contract. A
proposal alone grants no credit. Local admission and adoption carry the
authority to set the budget; the agent cannot grant itself an extension by
proposing a new value.

## Observe the ceiling

Send a bounded request, then inspect the Case's budget information: consumption,
reservations and balance. Decisions, reviews and admissions can use several
units within one message. Errors after dispatch count too. Tool calls are not a
unit of this budget.

On exhaustion, expect a `wait` disposition addressed to local control. The flow
keeps its candidate and continuation; waiting alone does not invalidate the
candidate. A completed contribution does not mean that the Case has achieved its
objective. Do not automatically retry an operation with an uncertain result.

## Grant an explicit extension

Once the budget is exhausted, the same agent can no longer produce the revision
through its chat. Local control must prepare it outside that chat, then use the
proposal, acceptance and adoption commands described in the
[revision reference](../../reference/evolution/revisions-et-historique.md). An
extension request does not itself authorise another invocation.

To continue the same Case, prepare a revision that preserves its identity:

```sysml
attribute :>> revision = 2;
attribute :>> limit = 5;
```

Replace the two corresponding values in the existing occurrence, review it and
then adopt that revision. The total ceiling becomes five; the three units
already committed are not erased. An open reservation remains committed. Then
send a new message to allow resumption. Adoption alone starts no work.

Do not remove the policy or change its `id` to bypass the stop. A limit below
the total already committed is refused. If the ledger is missing or cannot be
read, keep the Case waiting: a new message or restart does not restore credit.

Consult the [budget reference](../../reference/execution/budget-de-travail.md)
for fields, technical ceilings and measurement limits, and the
[Budget-Bounded Loop page](../../explanation/execution/boucle-bornee-par-budget.md)
for responsibilities and verification sources.
