# APE patterns: mechanisms, design choices and guidance

This reference helps a builder construct a system with APE patterns. It
distinguishes what the agent chooses, what the model must declare and what the
engine must enforce. It does not make all 24 entries mandatory or award a
compliance label.

The **21 patterns and three warning signs** come from the
[book catalogue](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/pattern-system-opening-content.json).
Each row links to its primary chapter. These links assume that the two
repositories are adjacent. Current availability is described in the
[pattern status as of October 25](etat-des-patterns.md). The October 22
inventory remains a historical record with its tests. The classification below
does not mean that every construct exists.

## How to read the classification

- **Mechanism**: the stated property requires a controlled operation, retained
  state or a check at the relevant boundary. An instruction alone cannot
  establish it. A mechanism can reuse primitives; each pattern does not require
  an additional TypeScript service or module.
- **Hybrid**: the organizational or policy choice is largely the builder's, but
  some commitments require executed mechanisms.
- **Diagnostic**: an inspection question and tests of actual paths, with no
  component to add to the system.

Good practice is therefore not a category opposed to mechanisms. It guides
selection, parameters and composition. For example, requesting independent
review is a choice; preventing activation that bypasses that review is a
control. A SysML description can document the former and parameterize the latter
only if the engine can consume it.

## Classification of the 24 entries

The boundary to enforce below identifies the obligation to implement **if the
system claims this property**, not its current availability. Evidence consists
of example tests to qualify on the chosen assembly.

### Envelopes

| Entry and primary character                                                                                                                                                       | Choice and contract in the model                                                                  | Enforced boundary and evidence sought                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [1.1 Deterministic Envelope](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/envelope-1-1-reading.mjs) — hybrid, deferred         | Fixed route, checkpoints where judgment is useful, permitted responses, branches and termination. | The route progresses only on an admitted response; an invalid response follows the declared rejection or recovery path. No new 1.1 template in this work package.                                       |
| [1.2 Event-Triggered Reassessment](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/pattern-1-2-reading-v2.mjs) — hybrid, deferred | Relevant events, return conditions, frequency and scope of reassessment.                          | Bounded scheduling, stable identity across attempts and renewed admission against current state. Recovering an earlier choice does not skip admission. No 1.2 scheduler in this work package.           |
| [1.3 Conversational Case Management](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/envelope-1-3-reading.mjs) — hybrid           | Dialogue initiative, available means, Case information, assistance and authorized next steps.     | The same Case and its mandate survive exchanges; every effect passes its check. Recovery after waiting must neither lose a request nor repeat an uncertain effect. Waiting and closure remain distinct. |

### Local mechanisms

| Entry and primary character                                                                                                                                                        | Choice and contract in the model                                                                                         | Enforced boundary and evidence sought                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [2.1 Proposal–Admission–Execution Separation](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/local-mechanism-2-1.mjs) — mechanism | Proposal, base, exact values, admission and execution responsibilities. Three responsibilities do not mean three agents. | Execution concerns the admitted operation. Changing a material value or the base requires the prescribed recheck before the effect.                                                                     |
| [2.2 Fail-Closed Admission](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/local-mechanism-2-2.mjs) — mechanism                   | Required facts, applicable policy and path after rejection.                                                              | Every route to the effect requires a positive verdict. Missing facts, unavailable controls and direct calls remain blocked; concurrent admissions do not exceed a shared limit.                         |
| [2.3 Evidence-Gated Admission](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/local-mechanism-2-3.mjs) — mechanism                | Evidence requirements fixed before selecting observations: subject, sources, freshness and conflicts.                    | The bundle is compared with this contract and the proposal. A fresh observation about another subject, a missing item or an unresolved contradiction does not yield a positive verdict.                 |
| [2.4 Closed-Catalog Selection](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/local-mechanism-2-4.mjs) — mechanism                | Applicable catalogue, arguments, scope, preconditions, effects and withdrawal. The agent chooses the useful entry.       | Selection creates no grant. An absent or withdrawn entry, or a call on an object outside the mandate, is rejected at the service.                                                                       |
| [2.5 Closed-Catalog Planning](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/local-mechanism-2-5.mjs) — hybrid                    | The agent proposes reads and dependencies; DAG contract, bounds and required or optional results.                        | The entire plan is admitted before dispatch. Cycles, unknown actions and invalid references are rejected before calls. The book covers reads; an extension to writes must name the additional controls. |
| [2.6 Exact-Action Approval](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/local-mechanism-2-6.mjs) — mechanism                   | Effects requiring approval, authorized approver, material values, scope and validity.                                    | The service checks the receipt bound to the exact content and, where prescribed, consumes it once. Test modification after review, revocation and concurrent double submission.                         |

### Controls

| Entry and primary character                                                                                                                                        | Choice and contract in the model                                                                        | Enforced boundary and evidence sought                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [3.1 Decision-to-Effect Traceability](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/control-3-1.mjs) — mechanism | Case, decision, operation and attempt identities; trace producers and readers.                          | Events are appended with explicit links to the verdict, receipt and observation. Recovery preserves the operation and distinguishes the attempt. A retrievable trace need not be copied in full into every context. |
| [3.2 Instance-Bound Controls](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/control-3-2.mjs) — mechanism         | Closed set of material controls and versions applicable to the Case.                                    | Compare the expected pin with the components actually loaded before progress and on recovery. A registry showing the correct version is insufficient; a material mismatch must block progress.                      |
| [3.3 Process Version Governance](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/control-3-3.mjs) — hybrid         | Admission of a version and a separate decision for open Cases: continue, replace, migrate or hold.      | Apply the authorized disposition, preserve history and verify the resulting state. Publishing or merging a version does not silently migrate Cases; an unknown effect prevents assuming that they are inert.        |
| [3.4 Verified-Effect Closure](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/control-3-4.mjs) — mechanism         | Required result, source of truth, correlation, closure condition and authorized role.                   | A correlated read establishes the result. A transport receipt, completed call or `completed` contribution does not close a Case whose effect is unverified.                                                         |
| [3.5 Convergent Recovery](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/control-3-5.mjs) — hybrid                | Required effects, conditions, authoritative sources, recovery, compensation and permitted intervention. | A ledger tracks each effect. Confirm those present, complete those absent, handle partial effects and inspect unknown ones before reissue. Successful effects are not repeated to restart a work package.           |
| [3.6 Budget-Bounded Loop](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/control-3-6.mjs) — mechanism             | Stable scope, ceilings, measured consumption, any bounded overrun and disposition on exhaustion.        | The persistent balance is checked before continuation; concurrent reservations prevent double spending. Recovery or a new chat does not reset the counter. Visible metrics alone bound nothing.                     |

### Operators

| Entry and primary character                                                                                                                                  | Choice and contract in the model                                                                                             | Enforced boundary and evidence sought                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [4.1 Operator Identity & Mandate](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/topology-4-1.mjs) — hybrid | Position, mission, principal, versioned mandate, means, private memory, quotas and assistance.                               | Bind runs to this identity and enforce scope, isolation and revocation on actual access. A persona, LLM model or instruction does not constitute the mandate.                                                                      |
| [4.2 Centralized Supervision](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/topology-4-2.mjs) — hybrid     | Choice of a point of contact, supervised positions, directed links, message classes and expected responses.                  | Check source, target, channel and recipient, then keep failure, delivery and response distinct. The supervisor does not automatically receive its correspondents' rights or Case custody.                                          |
| [4.3 Mandate-Based Escalation](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/topology-4-3.mjs) — hybrid    | Competence boundaries, destinations, reason, permitted information and expected next step. The number of levels is a choice. | The route is authorized; the recipient acts under its own mandate. Agreement to an escalation does not replace effect admission or acceptance of a handoff.                                                                        |
| [4.4 Acknowledged Handoff](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/topology-4-4.mjs) — mechanism     | Use when Case custody must change: brief, recipient, identities, expiration, return and verifier.                            | The ledger changes custodian only after correlated acceptance of a request that is still eligible. A timeout followed by late acceptance does not produce two custodians. An ordinary consultation does not require this transfer. |

### Context and memory

| Entry and primary character                                                                                                                                     | Choice and contract in the model                                                                                                                                                                              | Enforced boundary and evidence sought                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [5.1 Context Separation](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/transverse-5-1.mjs) — hybrid           | Useful surfaces and permitted uses; distinguish reference state, shared guidance, applicable instructions, observations and temporary copies. Identify producer, owner, version, status, scope and freshness. | The preparer supplies qualified context for a decision. An earlier read retains its status and does not replace the new authoritative state; advice grants no rights; a temporary copy is not promoted by its presence in context. |
| [5.2 Governed Memory Promotion](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/transverse-5-2.mjs) — mechanism | Candidate notes, original decision, sources, known or pending outcome, scope, validity, and separately authorized contributors and admitters.                                                                 | Separate admission grants access to shared use. Consulting, capturing or retrieving a candidate does not promote it. Admitting a note revises neither a skill nor a mandate; those objects retain their own change route.          |

Chapters 5.1 and 5.2 provide the reference contracts. Item, action, field and
primitive names actually supported must be read in the repository's library at
the version in use. This document does not prescribe an as-yet-unknown API for
storage, context selection or promotion. Volume reduction can be a policy of
5.1; it does not replace source qualification. Promotion in 5.2 does not mean
compression.

### Warning signs

| Entry                                                                                                                                              | Diagnostic use and limit                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [6.1 Unenforced Confirmation](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/warning-6-1.mjs)     | Follow the approved object through to the service; test receipt absence, expiration, mismatch, revocation and replay on accessible paths. A displayed confirmation does not establish enforcement; a possible defect does not prove a historical effect. |
| [6.2 Capabilities Beyond Mandate](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/warning-6-2.mjs) | Compare mandate and access in the inspected session: tools, technical identities, network and files. Distinguish a present capability, usable access and an observed effect; do not attribute the host's rights to the agent.                            |
| [6.3 Unverified Accountability](https://github.com/Casys-AI/agentic-process-engineering/blob/main/html-edition/part-iv-chapters/warning-6-3.mjs)   | Verify an assignment accepted by the person or organization accountable for the result, then its ability to intervene and its continuity. A SysML field, approval or handoff does not create that commitment.                                            |

## Practices that enrich the model without a new primitive

The builder can improve a design with the means already available:

- define a precise mission and mandate rather than add an agent for each logical
  PAE responsibility;
- retain a coordinator and two specialists, with authorized links and defined
  responses, without creating a shared channel that grants access to every
  thread;
- select useful reads and their dependencies in an existing closed plan rather
  than code a particular monitoring scenario in TypeScript;
- instantiate a promotion with independent review where the risk justifies it,
  reusing the available actions and controls;
- define expected results, sources and the next step on uncertainty, stating
  honestly which remain descriptive because no primitive is available;
- document the reasons for a choice and rejected alternatives without turning
  that explanation into a guard that grants rights.

These practices become enforced obligations only when the system chooses them as
a contract and has an effective interpretation of it. The engine remains
responsible for generic operations, checks before effects, transport and
persistence; policy values and modifiable assemblies should remain in admitted
SysML as far as possible.

## Usage contract for a builder

For an ordinary request, the builder starts from the objective and admitted
system, then selects useful constructs. It need not ask the user to choose among
24 patterns. The guide supplies four separate elements:

1. **Design guide**: conditions of application, alternatives and examples from
   the book. It helps with choices; consulting it grants no rights.
2. **System contract**: selected obligations, scope, parameters,
   responsibilities and versions. These take shape in the SysML assembly.
3. **Available primitives**: elements interpreted by the engine, types and known
   rejections. A free declaration or a `satisfy` does not add a primitive.
4. **Evidence**: tests and traces of the built version, including the happy
   path, relevant rejections and limits. Compilation does not prove a durable
   effect.

Before proposing a revision, the builder states the expected behavior, changed
SysML elements, reused primitives and properties that remain descriptive. A
missing capability must be identified as such. Creating it through a governed
route can be a separate proposal; it must not be simulated by a pattern name.

After admission, merge and adoption under delegated rights, qualification
exercises the normal path on the chosen version. One controlled test establishes
the mechanism; another can establish that the builder can choose and assemble
constructs from an objective. The result must separate this evidence and retain
human or development interventions.

The expected wording is “this path prevents this operation under these
conditions, with these tests.” An import, annotation or green test suite does
not turn it into “APE compliant.”
