# APE pattern status in the workbench

Code reviewed on October 25, 2026, at `73b3ed6`. This reference distinguishes an
existing mechanism, its representation in the model and the work still open. It
awards neither an APE compliance label nor a new test result. Dated
qualification reports remain evidence for their own scenarios.

The [pattern classification](patterns-mecanismes-et-guidage.md) explains what
belongs to mechanisms, design choices and guidance.

## Existing mechanisms and scope

| Entry                                       | Present in the workbench                                                                                               | Limit or open follow-up                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1.1 Deterministic Envelope                  | Scheduled Jobs; the `deterministic` envelope of a `CaseType`.                                                          | No generic `Checkpoint` primitive with enumerated responses; enhancements are frozen.                                        |
| 1.2 Event-Triggered Reassessment            | Watches awakened by `Every` or UTC `DailyAt`, a `watchResult` result and conditional notification.                     | No `accept after`, `ModelEvent`, webhook or generic proposal expiration; extensions are frozen.                              |
| 1.3 Conversational Case Management          | Requests separate from the session, with an objective, budget, opening provenance and closure state.                   | A work response does not transfer Case custody; generic move and closure types remain to be completed.                       |
| 2.1 Proposal–Admission–Execution Separation | Tool proposal, admission and activation; source proposal, acceptance and adoption; mandate changes.                    | No universal component governs every arbitrary effect.                                                                       |
| 2.2 Fail-Closed Admission                   | Rejection of non-executable constructs; assertions and admissions before the relevant operations.                      | Output assertions do not precede the effect; the host does not establish the internal guarantees of an external service.     |
| 2.3 Evidence-Gated Admission                | Tests/review of the exact candidate and correlated observations of verified work.                                      | No generic `EvidenceContract` covering freshness, subject and adjudication.                                                  |
| 2.4 Closed-Catalog Selection                | Selection among active tools and exposed behaviors, followed by call admission.                                        | Tool kinds and some rights remain engine-specific constructs.                                                                |
| 2.5 Closed-Catalog Planning                 | Closed DAG, full validation and admission before dispatch, persistent receipts and recovery.                           | Plan bounds are in TypeScript; no generic `PlanContract`.                                                                    |
| 2.6 Exact-Action Approval                   | Admission of the exact candidate and approval receipt for mandate changes.                                             | No generic receipt for every effect with authenticated identity, validity period and single consumption.                     |
| 3.1 Decision-to-Effect Traceability         | Case events, work receipts and provenance linked to structure.                                                         | The decision → admission → operation → attempt → observation identity chain remains to be unified.                           |
| 3.2 Instance-Bound Controls                 | Adopted executable contract, operator instruction and pinned initial skills.                                           | Fixed adapter instructions lie outside the pin; the digest of a downloaded skill can be optional.                            |
| 3.3 Process Version Governance              | Publication and adoption are separate; adoption incompatible with an ongoing promotion is rejected.                    | No explicit disposition for each open Case or general coexistence of its earlier contracts.                                  |
| 3.4 Verified-Effect Closure                 | `WorkResultContract`, correlated observation and comparison before closing the relevant work.                          | Covers only work to which this contract is attached.                                                                         |
| 3.5 Convergent Recovery                     | Completed tasks are not reissued; correlated recovery and persistent reservations.                                     | No generic multi-effect ledger with compensation and reconciliation handoff.                                                 |
| 3.6 Budget-Bounded Loop                     | Reservation and consumption of agent invocations per Case; suspension on exhaustion.                                   | Does not bound tokens, provider calls, tools, cost or duration.                                                              |
| 4.1 Operator Identity & Mandate             | Request operators, narrow mandates, delegated editing and administration; Main Operator declared in the initial model. | Generic grants remain open; delegation to Main Operator is integrated, but publication is not wired.                         |
| 4.2 Centralized Supervision                 | Directed `BehaviorAccess` links, inbox, receipts and commissioned work.                                                | No `ReplyContract`, response deadline or generic overload signal.                                                            |
| 4.3 Mandate-Based Escalation                | Mandate-change request and separate decision, without self-granting.                                                   | No generic `EscalationRoute` with a deadline and fallback; delegation wiring remains open.                                   |
| 4.4 Acknowledged Handoff                    | Opening a Request and work receipts.                                                                                   | These do not constitute a handoff; the custody contract and ledger are absent.                                               |
| 5.1 Context Separation                      | Context policy, distinct contributions and evidence reread by reference.                                               | Does not by itself provide independent working memory for each Case.                                                         |
| 5.2 Governed Memory Promotion               | Candidate capture, review, admission, recall and withdrawal.                                                           | Self-admission is an explicit policy, not independent review; typed-value migration remains open.                            |
| 6.1 Unenforced Confirmation                 | Distinction between an agreement message and an admission command.                                                     | Generic model-doctor rule not delivered.                                                                                     |
| 6.2 Capabilities Beyond Mandate             | Rights matrix; diagnostic limited to skill hosts outside the mandate.                                                  | No general comparison of every accessible capability with a typed grant.                                                     |
| 6.3 Unverified Accountability               | `NO_ACCOUNTABLE_OWNER` diagnostic, without demonstrated acceptance of accountability.                                  | The `accountableHumanDeclared` fact is currently fixed at `false`; owner authority is distinct from accepted accountability. |

## The current model doctor

[`lintModelDiagnostics`](../../../src/domain/model/policies/diagnostics.ts)
emits five codes from the facts produced by
[`projectModelDiagnosticFacts`](../../../src/adapters/model/diagnostics/source.ts).
It does not freely scan SysML text to infer effects.

| Code                        | Current scope                                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOOP_WITHOUT_BUDGET`       | Executable conversation or plan without `workBudgetPolicy`; `warning`, `absent`.                                                                                |
| `SELF_ADMINISTERED`         | `admissionMode = builder` for tool promotion; `info`, `present`. Does not yet inspect memory or mandate self-admission.                                         |
| `NO_ACCOUNTABLE_OWNER`      | `warning`, `indeterminate`. Facts currently carry `accountableHumanDeclared: false`; this is not the discovery of an absence through analysis of an assignment. |
| `EFFECT_NOT_VERIFIED`       | Exposed behaviors for tool reuse, memory and skills without a contract covering the behavior and caller. This is not a check on every arbitrary effect.         |
| `CAPABILITY_BEYOND_MANDATE` | Hosts declared by the skill policy and absent from the network mandate.                                                                                         |

The [validation reference](validation-du-modele.md) describes fields, APIs and
masks. The attention service aggregates the matrix, board and model doctor; its
presence does not mean that every planned rule is implemented.

## What the latest integrations change

The envelope is carried by `CaseType.envelope`. The initial system's legacy
`envelopeKind`, `envelopePattern` and `envelopeRevision` attributes remain for
digest compatibility.
[Conversational Case management](../../explanation/operateurs/gestion-conversationnelle-des-cases.md)
distinguishes the channel, Case and invocation. The
[Case schedule](../../../src/domain/work/value-objects/case-schedule.ts) and
[`CaseScheduler`](../../../src/application/work/cases/scheduling.ts) support the
current schedules. Watch notifications are data marked as untrusted. The product
freeze on Jobs/Watches does not remove this code or prevent Main Operator from
proposing them for a recurring need.

The initial operator is named **Main Operator** in
[`system.sysml`](../../../models/system.sysml) and
[`configuration.sysml`](../../../models/configuration.sysml). Operator creation
is no longer limited to the reviewer. `designerScopeId` remains a technical
identifier; it is not the agent's displayed name.

Delegated-decision functions and `OperatorAuthorityPolicy` are in main.
Publication of this policy is still absent from
[`SourceModel`](../../../src/adapters/model/sources/source-model.ts) dispatch.
Claiming that this flow is operational would therefore be false. Wiring, review
and a real trial are still required. Delegated model editing and administration
form a separate mechanism, already documented in their guides.

## Interpretation sources and evidence

- [PAE and fail-closed admission](../../explanation/evolution/proposition-admission-execution.md):
  controls and operation order;
  [`executeFlow`](../../../src/domain/model/execution/flow.ts) evaluates input
  assertions before the action, then all assertions after its non-suspended
  return.
- [Closed plans](../execution/work-plans.md): bounds, admission, persistence and
  recovery; source in [`plans.ts`](../../../src/domain/work/entities/plans.ts)
  and [`executor.ts`](../../../src/application/work/plans/executor.ts).
- [Verified closure](../execution/resultats-verifies.md) and
  [budget](../execution/budget-de-travail.md): contracts and limits.
- [Context separation](../../explanation/contexte-et-memoire/separation-du-contexte.md)
  and
  [memory promotion](../../explanation/contexte-et-memoire/promotion-gouvernee-de-la-memoire.md):
  contributions, status and admission authority.
- [Revisions and history](../evolution/revisions-et-historique.md): publication,
  adoption and digests;
  [`model-adoption.ts`](../../../src/application/work/runtime/model-adoption.ts):
  rejection of incompatible adoption.

The October 22 inventory remains a historical record. Dated qualification
reports establish only their own scenarios; the existence of source or a test
does not constitute a new execution of that test.
