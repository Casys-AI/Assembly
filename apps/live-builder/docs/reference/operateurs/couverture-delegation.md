# Delegation coverage for the Main Operator

Delegation coverage reviewed at `c6b5564` on 25 October 2026, updated locally on
26 October for the publication integration of the network-host policy and for
inter-operator admission of tools. This matrix distinguishes mechanisms, their
conditions and remaining gaps; it is not acceptance of the delegated flow.

The reference flow creates Request operators, allows them to prepare and test
tools, handles their mandate needs, then uses the admitted tools. A general
change to SysML sources can also require revision acceptance and contract
adoption. Jobs, Watches, memory and skills per Case remain outside this flow;
this matrix does not qualify them.

The matrix also covers the creation of sub-operators in a Request branch (D9),
which a Branch Operator performs under its own grant rather than the Main
Operator's.

The chosen target is an explicit initial grant by the person, followed by
ordinary Main Operator decisions within its scope. The name "Main Operator"
grants no rights by itself. The initial grant, its revocation by the person and
local recovery remain distinct from ordinary delegated decisions.

## Decision matrix

"Available" describes a mechanism in the code under its preconditions; it does
not mean that an existing system has the required policy. Expected evidence
concerns the application's normal flow.

| Ref. | Act                                             | Current decision-maker                                             | Target and scope                                                            | Current mechanism or gap                                                                             | Expected acceptance evidence                                                                       |
| ---- | ----------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| D0   | Grant or revoke initial authority               | Person, owner's authority                                          | The person sets recipients and powers that can be passed on                 | Separate policies; no universal grant covering every decision                                        | Exact grant, receipt, effective revocation before the next exercise                                |
| D1   | Create a Request operator                       | Main Operator proposes; person approves                            | Main Operator decides within a previously granted creation envelope         | Proposal and creation connected; delegated approval missing                                          | Unique creation and first Request, bounded initial rights, no human click after the grant          |
| D2   | Add network hosts to another operator           | Person; Main Operator decision provided by the network-host policy | Native recipients and exact hosts, `addNetworkHosts` only                   | Exercise integrated; publication connected locally through the shared writer                         | Grant through the normal flow, delegated decision, publication and resumption of the same Request  |
| D3   | Change other mandate rights                     | Person approves the proposal                                       | Main Operator only for explicitly granted acts and bounds                   | No network-host-policy act for own admission, URL selection or initial editing grant                 | Each covered act tested; out-of-scope and self-grants refused                                      |
| D4   | Admit another operator's candidate              | Person; Main Operator under ToolAdmissionPolicy                    | Bounded recipients and kinds; exact operator, candidate, digest and Request | Local implementation: inspection, delegated decision and shared activation; provider acceptance open | Candidate tests checked, exact admission, one published catalogue and resumed Request              |
| D5   | Prepare a SysML edit                            | Authorized operator proposes                                       | Main Operator or an operator with the required operations, files and roots  | `ModelEditPolicy` and delegated edits available; no implicit acceptance power                        | Bounded proposal; forbidden roots, revocation and stale base refused                               |
| D6   | Prepare a grant or revocation of editing rights | Authorized administrator proposes                                  | Main Operator within its administration envelope                            | `ModelAdministrationPolicy` available for preparation; acceptance/adoption separate                  | Exact inclusion, recipient, depth and parent; no right acquired before admission                   |
| D7   | Accept and publish a general SysML revision     | Owner's local command                                              | Main Operator under an existing revision decision power                     | Delegated acceptance missing; an editing policy does not grant it                                    | Exact version and content, receipt from the prior authority, execution still on its pin            |
| D8   | Adopt a new execution contract                  | Local command of the targeted runtime's owner                      | Main Operator under an existing adoption power                              | Delegated adoption missing; distinct from D7                                                         | Exact runtime, digest and version, authority of the previous pin, controlled revocation and replay |
| D9   | Create a sub-operator in a Request branch       | BO grant: the host if `autonomous`, the person if `per-creation`   | At most 3 per branch; each provisioned value within the creator's own       | BO creations delivered in both forms; member creation and member change missing                      | Published in the branch only; fourth and over-provisioned refused; members kept on revocation      |

## Verified points in the code

### D0–D3: mandates, creation and network

Creation is reserved for the registered Main Operator, checked before preview
and publication by `requireRegisteredDesigner` in
[`mandate-change-decisions.ts`](../../../src/application/governance/mandate-change-decisions.ts).
`SystemGovernance.decideChange` in
[`governance.ts`](../../../src/domain/governance/policies/governance.ts)
distinguishes a human decision from delegated exercise. The ability to propose
creation is not approval of that creation.

[`MandateRequestedRights`](../../../src/domain/governance/records/pending-change.ts)
distinguishes `operatorAuthority`, `toolAdmission`, `grantModelEditing`,
`mayAdmitOwnCandidates`, `addNetworkHosts` and `setUrlSelectionMode`. The
network-host policy covers only `addNetworkHosts`:

- `acts: ["addNetworkHosts"]`, `toolIds: []`, `maxDelegationDepth: 0`;
- exact native recipient and holder, no self-recipient;
- request recorded on a Case, containing only covered hosts;
- current policy and exact revision, with no wildcard or implicit authorization
  of subdomains.

These checks are in
[`operator-authority-policy.ts`](../../../src/domain/governance/policies/operator-authority-policy.ts),
notably `delegatedAuthorityExercise`. Exercise and publication reread the
policy; revocation prohibits both a new approval and a new delegated refusal.
Reconciling an already-attested publication is not a new exercise.

`SourceModel.#prepareApprovedChange` now routes `operatorAuthority` to
[`operatorAuthorityRequests`](../../../src/adapters/governance/authority/operator/writer.ts),
variant `publishOperatorAuthorityPolicy`. The writer produces an `authority`
insertion with one member expectation and eight literal expectations. Primary
role prevalidation and compiled-policy checks remain on the host; a new
publication requires the presented diff. The former parallel producer and the
test-only model double have been removed. The
[network-host policy integration flow](../../../test/integration/operator-authority-policy_test.ts)
uses `SourceModel`, Git and Toolkit directly, with a scripted provider.

### D4: tool admission and activation

A Request operator's initial model requires human admission:
[`template.ts`](../../../src/domain/governance/operator-template.ts).
`mayAdmitOwnCandidates` authorizes the builder of its own system. A configured
reviewer also examines that system's candidate; neither route gives the Main
Operator admission of another operator's candidates. The local implementation of
inter-operator admission adds a separate `ToolAdmissionPolicy` grant, published
by the shared writer: native Main holder, native recipients, tool kinds and
delegation depth zero. The grant and its adoption must precede preparation; the
policies and exact contract are captured with the candidate. The unused
definition preserves the historical digest.

The Main Operator discovers lightweight references, inspects the exact
candidate's code, contract and tests, then decides. The host captures its
identity and invalidates the inspection after use or a request change. The
`decideCandidate` command in
[`conversations.ts`](../../../src/application/work/operators/conversations.ts)
now also routes this delegated principal to the exact owner. The
`candidateDelegation` receipt is distinct from network delegation and local
builder admission; `requiredAuthority` remains human.

Tests qualify a candidate; they do not grant admission.
[`promotion-flow.ts`](../../../src/application/work/candidates/promotion-flow.ts)
and
[`SystemGovernance.admission`](../../../src/domain/governance/policies/governance.ts)
check local or delegated authority and the exact decision.
[`promotion.ts`](../../../src/application/work/candidates/promotion.ts) checks
the base, digest and tests before recording admission and the durable activation
intent.

Before a new effect, publication rechecks the delegated receipt and policy in
the current sources, including under the Git lock. Revocation blocks a new
exercise; an already-attested effect remains reconcilable. Recovery retains the
durable Request, receipt, budget and intent, without selecting an old Case or
repeating a Main Operator decision.

After this admission, the host publishes the SysML catalogue and verifies its
binding:
[`SourceModel.activateCandidate`](../../../src/adapters/model/sources/source-model.ts)
and [`activation.ts`](../../../src/application/work/candidates/activation.ts).
The catalogue is adopted automatically if the executable contract's digest
remains identical. This path has no second publication approval. This activation
does not prove a general power to adopt a changed contract in D8.

### D5–D8: editing, administration, acceptance and adoption

`ModelEditPolicy` bounds editing exercise by operations, files and roots.
`createOperatorEditAuthorization` and `NativeModelSourceAuthorization.validate`
in
[`source-authorization.ts`](../../../src/adapters/governance/model-access/source-authorization.ts)
check rights during preparation and at acceptance. An ordinary edit cannot turn
into a change to authority or the delegation registry.

`ModelAdministrationPolicy` is a separate power to propose grants/revocations of
editing rights.
[`operations.ts`](../../../src/adapters/governance/model-access/administration/operations.ts)
and
[`model-delegation.ts`](../../../src/domain/governance/policies/model-delegation.ts)
check recipients, inclusion of operations and roots, parent, depth and the
absence of loops or self-assignment. The
[`proposals.ts`](../../../src/application/work/conversation/proposals.ts) path
prepares a proposal; it does not yet grant the rights.

For D7, [`revisions.ts`](../../../src/adapters/in/http/model/revisions.ts)
accepts with `author: "local-control"` and a `model-revision` owner receipt,
then returns `executionAdopted: false`. For D8,
[`adoptModelVersion`](../../../src/application/work/runtime/model-adoption.ts)
captures the authority of the already-admitted pin before replacement and checks
the digest/version. Choosing an `agentId` at adoption selects the runtime; it is
not a delegated act by the Main Operator. Neither command has the intended
delegated decision contract.

### D9: sub-operators in a Request branch

The BO creates a member under a creation policy that the branch reads like any
other. The two forms, the provisioning bounds, the count of three and the
decision paths are in the
[authority reference](autorite-des-operateurs.md#sub-operators-in-a-request-branch);
this section records only what the code checks and what it leaves open.

- [`operator-creation-policy.ts`](../../../src/domain/governance/policies/operator-creation-policy.ts):
  `assertCreationWithinPolicy` refuses a fourth member and an out-of-bound
  `provision`; `creationAuthorityExercise` refuses a self-approval under
  `per-creation`; `creationMode` gives the form.
- Under `autonomous`, the host decides under the grant once the BO's turn has
  ended. Under `per-creation`, the person decides on the Case card. Neither path
  gives the Main Operator a decision.
- Not delivered: creation by a member, a member's change and the BO deciding for
  a sub-operator. They are listed in
  [Current limits of Request spaces](cases.md#current-limits-of-request-spaces).

## Evidence and limits

Local suites check, among other things, network-host policy bounds, request
retention after a delegated refusal, receipts, replay and revocation:

- [`operator-authority-policy_test.ts`](../../../src/domain/governance/policies/operator-authority-policy_test.ts),
  [`governance_test.ts`](../../../src/domain/governance/policies/governance_test.ts),
  [`mandate-change-decisions_test.ts`](../../../src/application/governance/mandate-change-decisions_test.ts),
  [`operator-authority_test.ts`](../../../src/application/work/runtime/operator-authority_test.ts);
- [`model-delegation_test.ts`](../../../src/domain/governance/policies/model-delegation_test.ts),
  [`delegation_test.ts`](../../../src/application/work/runtime/delegation_test.ts),
  [`revisions_test.ts`](../../../src/adapters/in/http/model/revisions_test.ts),
  [`model-version_test.ts`](../../../src/application/work/runtime/model-version_test.ts),
  [`model-adoption_test.ts`](../../../src/application/work/runtime/model-adoption_test.ts);
- [`activation_test.ts`](../../../src/application/work/candidates/activation_test.ts)
  for activation intent and fidelity of the published candidate.

These local tests replace neither the real writer nor provider acceptance. No
server or interface test was launched for this matrix. The NAPI-RS/cache study
remains independent.

Verification of this initial scope with Deno 2.9.7: the ten unit suites cited
above pass, **152 tests, no failures**. This result describes the initial scope.
The Git/Toolkit network-host policy flow was subsequently run for the
integration, separately from a provider test; its evidence and limits are
tracked in the Operators plan.

The inter-operator admission implementation adds
[`tool-admission-policy_test.ts`](../../../src/domain/governance/policies/tool-admission-policy_test.ts),
[`tool-admission_test.ts`](../../../src/application/work/runtime/tool-admission_test.ts)
and the
[real delegated admission flow](../../../test/integration/tool-admission-policy_test.ts).
The latter assembles SourceModel, Git, Toolkit, sandbox and reopened
DuckDB/workspace with a scripted provider. The central Case is checked
separately through registry/driver composition; the real flow uses a local
Request. Provider acceptance and full delegation from D1 to D8 remain open.

Branch-team creation (D9) adds
[`operator-creation-policy_test.ts`](../../../src/domain/governance/policies/operator-creation-policy_test.ts)
and the PostgreSQL
[witness](../../../test/integration/postgres-request-branch-team_test.ts), which
composes the real writer, Git, Toolkit and queue with a scripted provider. This
page records no run of either.

An ordinary decision that is still human, or a missing integration, prevents a
claim of full delegation, even when human fallback allows the Request to finish.
