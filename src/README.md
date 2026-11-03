# Find the APE patterns in the code

Identifiers and titles follow the **Agentic Process Engineering** book's
catalogue, `html-edition/pattern-system-opening-content.json`, reviewed on 22
October 2026. This map connects patterns to the mechanisms present in Assembly;
it does not certify their complete implementation.

## Read the directory structure

`domain/` defines values, policies and invariants. `application/` applies use
cases and defines their ports. `adapters/` implements those ports for the model,
providers, persistence and HTTP. `infrastructure/` holds technical services
shared by every context: clock, logging, SSE, the native process client.
`composition/` builds the adapters and use cases at startup, called from
`main.ts`. The [code boundaries](../CONTRIBUTING.md#frontières-du-code) say what
each folder may import. The [SysML constructs](../models/README.md) carry the
native contracts; their declarations do not prove that an execution occurred.

A dedicated module uses the pattern's title: `context-separation.ts` and
`governed-memory-promotion.ts`. Objects and functions describe the concrete
mechanism: `DecisionContextPolicy`, `projectDecisionContext`, `MemoryRecord`,
`review`. A shared component keeps its role: `SystemRuntime`,
`WorkPlanExecutor`, `admitBehaviorCall`. Its comment identifies the patterns it
contributes to.

`SystemRuntime` drives a system session with its participating operators. It
combines several patterns. It is neither a standalone pattern nor a synonym for
an operator.

The business module groups identify their business owner. Domain objects use
role folders, such as `memory/entities/memory-record.ts` and
`shared-kernel/revision-id.ts`, with one canonical definition per concept.
Catalog state uses `records/` until a domain root actually owns its transitions.
Application and adapter folders group actual use-case and technical families. In
`adapters/`, `in/` and `out/<system>/` are grouped by technical system, while
`work/`, `model/`, `governance/` and `skills/` are grouped by context and build
on `out/`. File names use that context: runtime, compilation and projections
belong to one `adapters/out/sysml-toolkit/` family, while semantic preparation
and native index execution have separate owners.

The execution ensemble stays together under `adapters/work/runtime`.
[postgres-ledger.ts](adapters/work/runtime/postgres-ledger.ts) owns durable run
selection;
[wait-evidence-ledger.ts](adapters/work/runtime/wait-evidence-ledger.ts) owns
its immutable wait and consumption receipts. The fenced official saver remains
in `postgres-ledger.ts`; checkpoint proof adaptation and the explicit historical
decoder live in
[checkpoint-wait-evidence.ts](adapters/work/runtime/checkpoint-wait-evidence.ts).
Delivery acceptance alone is not consumption. The native trace and product
journal remain distinct: since R4b, new native observations go to the
append-only `ExecutionNativeObservation` journal
([native-observation.ts](adapters/work/runtime/native-observation.ts)), not to
checkpoints.

## Catalogue mapping

| Canonical pattern                                                  | Entry points                                                                                                                                                                                                                | Scope of these mechanisms                                                                                                             |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **1.3 Conversational Case Management**                             | [system.ts](application/work/runtime/system.ts), [conversations.ts](application/work/operators/conversations.ts), [conversation.sysml](../models/conversation.sysml)                                                        | Persistent conversation, choices, waiting and resumption. Waiting does not close a case.                                              |
| **2.1 Proposal–Admission–Execution Separation**                    | [system.ts](application/work/runtime/system.ts), [governance.ts](domain/governance/policies/governance.ts), [pae.sysml](../models/pae.sysml)                                                                                | Separate capability proposal, admission and activation; a later tool call is a different operation.                                   |
| **2.2 Fail-Closed Admission** and **2.4 Closed-Catalog Selection** | [behavior-call-admission.ts](application/governance/behavior-call-admission.ts), [invocation.ts](application/work/behaviors/invocation.ts)                                                                                  | Exposure, caller, version, input contract and executor for a specific call. Its target flow still controls the business rules.        |
| **2.5 Closed-Catalog Planning**                                    | [plans.ts](domain/work/entities/plans.ts), [executor.ts](application/work/plans/executor.ts), [plan.ts](./application/work/plans/plan-behavior.ts)                                                                          | Plan admitted before dispatch. Construction work is a local extension to the book's read-only plan.                                   |
| **3.1 Decision-to-Effect Traceability**                            | [journal.ts](application/work/operators/journal.ts), [system.ts](application/work/runtime/system.ts)                                                                                                                        | Correlations between contributions, calls, reported results and versions. A receipt alone does not prove the business effect.         |
| **3.2 Instance-Bound Controls**                                    | [executable-model.ts](domain/model/execution/executable-model.ts), [behavior-call-admission.ts](application/governance/behavior-call-admission.ts)                                                                          | Adopted contract and versions checked before progression; the model being displayed is not necessarily the one being executed.        |
| **3.3 Process Version Governance**                                 | [service.ts](application/model/revisions/service.ts), [system.ts](application/work/runtime/system.ts), [repository.ts](adapters/out/git/repository.ts)                                                                      | Proposing, admitting and adopting a revision remain distinct. A commit does not implicitly migrate open cases.                        |
| **3.4 Verified-Effect Closure**                                    | [verified-effect-closure.ts](domain/work/policies/verified-effect-closure.ts), [result-policy.ts](adapters/out/sysml-toolkit/compilation-policies/work/result-policy.ts), [executor.ts](application/work/plans/executor.ts) | Typed native contract, bounded business predicate and admitted observation; plan dependencies conditioned on verification.            |
| **3.6 Budget-Bounded Loop**                                        | [budget.ts](domain/work/policies/budget.ts), [service.ts](application/work/budget/service.ts), [agent.ts](application/work/budget/agent.ts)                                                                                 | Persistent counter, reservation and suspension per case; current unit: agent port invocation.                                         |
| **4.1 Operator Identity & Mandate**                                | [mandates.ts](domain/governance/mandates.ts), [governance.ts](domain/governance/policies/governance.ts), [operator-entry.ts](domain/model/records/operator-entry.ts)                                                        | Holders, versions and native permissions. The structured editing policy bounds files and roots; the `scope` text remains descriptive. |
| **4.2 Centralized Supervision**                                    | [conversations.ts](application/work/operators/conversations.ts), [operator-workspace.ts](adapters/work/operator-workspace.ts), [operator-inbox.ts](./application/work/behaviors/operator-inbox.ts)                          | Operators, authorized links and correlated contributions. A response does not transfer responsibility for the case.                   |
| **5.1 Context Separation**                                         | [context-separation.ts](domain/work/policies/context-separation.ts), [separation.ts](application/work/context/separation.ts), [information.ts](./application/model/consultation/context-information.ts)                     | Context preparation, provenance and access to evidence. Consulting information does not grant it authority.                           |
| **5.2 Governed Memory Promotion**                                  | [governed-memory-promotion.ts](domain/memory/governed-memory-promotion.ts), [governed-memory-promotion.ts](application/memory/governed-memory-promotion.ts), [memory-store.ts](adapters/out/postgres/memory-store.ts)       | Candidate notes, review/admission, recall and withdrawal. Local implementation; no independent review between owners.                 |

For **4.1 Operator Identity & Mandate**,
[model-delegation.ts](domain/governance/policies/model-delegation.ts) resolves
granting and redelegation rights, which are distinct from exercising a right.
[operations.ts](adapters/governance/model-access/administration/operations.ts)
builds the exact proposal and checks it again at admission; the
[administration guide](../docs/how-to/operateurs/administration-deleguee.md)
describes bounds and revocations.

## Keep names explicit

- Write the **number and full canonical title** in each dedicated module's
  comment and in explanation headings. Copy the title from the catalogue without
  inventing a new abbreviation.
- Distinguish the pattern, its bounded implementation and a shared mechanism.
  `admitBehaviorCall` admits a call; it does not certify an entire behavior.
- `PAE` means Proposal–Admission–Execution; `APE` denotes the method. Prefix a
  use case number with “use case”: **3.1 Task Automation** is not the **3.1
  Decision-to-Effect Traceability** pattern.
- A work receipt is not **4.4 Acknowledged Handoff**. Completing a contribution
  is not **3.4 Verified-Effect Closure**. Entries **6.1 to 6.3** are warning
  signs to examine, not services to instantiate.
- Preserve native identities and admitted versions. An editorial name change
  does not authorize any migration of existing projects.

The [pattern explanations](../docs/README.md#ape-patterns-at-work) detail the
implementations. The
[APE classification](../docs/reference/bibliotheque-ape/patterns-mecanismes-et-guidage.md)
describes the 21 patterns and three warning signs. Dated reports retain the
observations for their version; they are not this map of the current code.

## Migration conventions (frozen at lot 0)

The tree is organised by reason to change. Git history records where each file
came from.

- `domain/` ranks by business language; `application/` ranks by intention (a
  family's services and mechanisms are called directly, with no blanket handler
  layer in front); `adapters/` ranks by the external system adapted;
  `infrastructure/` holds transverse technical services once.
- Kebab-case paths; `commands/`, `queries/`, `ports/in/*.port.ts`,
  `ports/out/*.port.ts` where a family needs them. A
  `handlers/<verb>-handler.ts` exists only where production code calls it.
  Finding the owner, its contracts and its tests wins over uniformity.
- A command is an admitted mutation with a durable effect; a query is a read
  with none. Boundary errors are closed coded errors
  `{code, context, recovery}`.
- `src/adapters/sysml-toolkit-pin.ts` never moves. A worker never moves without
  its client and fixtures. Persisted fields, symbols and encodings are never
  renamed by a move.
- Every moved file recomputes its `import.meta.url`-derived paths and proves
  them with its loader/runtime test in the same lot.
