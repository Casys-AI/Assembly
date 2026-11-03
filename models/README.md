# APE constructs in the SysML models

The public names below come from the
[APE book catalogue](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/pattern-system-opening-content.json).
The book paths assume the two repositories are adjacent. A module provides
definitions; importing it does not instantiate it or add an executor. The
implementations below are bounded by the contracts consumed by the workbench,
without certifying full compliance with the patterns.

| Canonical reference                                                                 | Source and preserved native identity                                                                           | Implementation and consuming code                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1.3 Conversational Case Management**                                              | [conversation.sysml](conversation.sysml), `ASEConversation::ConversationCase`                                  | Persistent conversational envelope, waiting and resumption; no generic verified closure or accepted handoff. [flow.ts](../src/domain/model/execution/flow.ts), [system-runtime.ts](../src/application/work/runtime/system.ts).                                                                                                                                                              |
| **2.1 Proposal–Admission–Execution Separation**, with **2.2 Fail-Closed Admission** | [pae.sysml](pae.sysml), `APEPromotion::ReviewedPromotion`                                                      | Proposal, trials, review, admission and then activation of an exact candidate. PAE abbreviates these responsibilities; APE denotes the framework. This module also contributes to the Task Automation and Change Control use cases. [execution-model.ts](../src/adapters/out/sysml-toolkit/compilation-policies/work/execution-model.ts), [flow.ts](../src/domain/model/execution/flow.ts). |
| **5.1 Context Separation**                                                          | [context.sysml](context.sysml), `APEContext::DecisionContextPolicy`                                            | Context preparation policy and admitted access to evidence for the current case. [context-separation.ts](../src/domain/work/policies/context-separation.ts), [context-separation.ts](../src/application/work/context/separation.ts).                                                                                                                                                        |
| **5.2 Governed Memory Promotion**                                                   | [memory.sysml](memory.sysml), `APEMemory::GovernedMemoryPolicy`                                                | Local candidate notes, recall, revision, admission and withdrawal; recalling a note does not promote it. [governed-memory-promotion.ts](../src/domain/memory/governed-memory-promotion.ts), [governed-memory-promotion.ts](../src/application/memory/governed-memory-promotion.ts), `GovernedMemoryPromotionService` service.                                                               |
| **3.4 Verified-Effect Closure**                                                     | [verified-effect-closure.sysml](verified-effect-closure.sysml), `APEVerifiedEffectClosure::WorkResultContract` | Calling system's contract: typed expected/observed items, native constraint and separate access to work and to its reading. [Contract and limits](../docs/reference/execution/resultats-verifies.md).                                                                                                                                                                                       |
| **3.6 Budget-Bounded Loop**                                                         | [work-budget.sysml](work-budget.sysml), `APEWorkBudget::InvocationBudgetPolicy`                                | Persistent budget of agent invocations per case; does not directly bound tokens or cost. [work-budget-policy.ts](../src/adapters/out/sysml-toolkit/compilation-policies/work/budget-policy.ts), [work-budget.ts](../src/application/work/budget/service.ts).                                                                                                                                |

## Delegated editing rights — 4.1

[model-editing.sysml](model-editing.sysml) defines the native
`ASEModelEditing::ModelEditPolicy` policy, bound to the holder and their
mandate. File/root pairs and operations bound writes; references rewritten by a
rename are also checked. Without an explicit policy, no editing right is
granted. See the
[delegation guide](../docs/how-to/operateurs/droits-edition-par-mandat.md).

[model-administration.sysml](model-administration.sysml) separately carries
granting and redelegation rights. Its holder may authorize the designated
recipients within the bounds of their mandate, without implicitly receiving an
editing right. Chains and revocations are checked at each effect; see the
[administration guide](../docs/how-to/operateurs/administration-deleguee.md).

## Related mechanisms

| Source                                                   | Reference and scope                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [work-plans.sysml](work-plans.sysml), `ASEWorkPlans`     | **2.5 Closed-Catalog Planning**: closed plan admitted before dispatch. The book covers read operations; the workbench's construction and proposal operations are an extension, subject to the controls specific to each effect. [work-plan-executor.ts](../src/application/work/plans/executor.ts).                                                  |
| [skills.sysml](skills.sysml), `APESkills`                | Versioned instructions contributing to **5.1 Context Separation**. Installing, loading and unloading remain distinct; a skill does not grant authority. [context-skills.ts](../src/application/skills/context-skills.ts).                                                                                                                            |
| [core.sysml](core.sysml), `ASECore`                      | Identities, mandates, contracts and candidates, especially for **4.1 Operator Identity & Mandate** and **2.1 Proposal–Admission–Execution Separation**. Shared types, without universal holder authentication. [execution-model.ts](../src/adapters/out/sysml-toolkit/compilation-policies/work/execution-model.ts).                                 |
| [behavior-invocations.sysml](behavior-invocations.sysml) | Exposed native call contracts, with admission specific to the call; contribute to **2.2 Fail-Closed Admission** and **3.2 Instance-Bound Controls**. [operator-entries.ts](../src/adapters/out/sysml-toolkit/compilation-policies/work/operator-entries.ts), [behavior-call-admission.ts](../src/application/governance/behavior-call-admission.ts). |

Package names, definitions and exposed operations are engine contracts. The APE
titles document their relationship to the book; they do not replace these
identities. Already admitted bundles remain their own source of truth. The
[initial foundation](../docs/reference/contexte-et-memoire/socle-initial-et-skills.md)
describes the actual loading and assembly; the library qualifications
distinguish available mechanisms from remaining obligations.

The [commercial-watch](../test/fixtures/commercial-watch/README.md) test fixture
contains copies of modules and a `sources.json` export. After changing its
sources, regenerate this export with its `qualify.ts` script according to the
fixture's instructions; the script compiles and then writes the bundle. Changing
the sources alone does not update the export.
