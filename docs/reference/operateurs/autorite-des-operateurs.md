# Authority of Request operators

Code state as of 25 October 2026, `73b3ed6`. The Main Operator composes the
system and proposes operators to handle Requests. A proposal grants no rights:
publication follows a decision on the exact change.

Operator creation, its first Request, provenance and recovery are integrated.
The network-host policy integration of 26 October publishes the policy through
the shared writer, with an exact diff and checks on the recompiled model. The
Git/Toolkit flow now uses `SourceModel` without a publication test double, with
a scripted provider. Local presentation of policies and receipts is implemented
locally; provider acceptance remains open. The dated reports preserve the
results and limits of the earlier state. Sub-operators in Request branches (lot
4.8e) were added on 1 November 2026 from the code; see
[Sub-operators in a Request branch](#sub-operators-in-a-request-branch).

## Creating an operator and its first Request

`propose_agent_creation`, with `role: "operator"`, receives a name and a closed
specification: `instruction`, `networkHosts`,
`requestType: {name, maxInvocations}` and `firstRequest: {objective}`. The limit
is an integer from 1 to 100. No free-form mandate or operator-supplied SysML
fragment is accepted. Creation is reserved for the configured primary contact,
checked before proposal and publication. The historical `mayCreateReviewer`
field remains the right that makes this proposal eligible; it does not replace
human admission.

The created operator can propose read tools, invoke its admitted catalogue and
request a network extension. Its tools require human admission. It receives no
editing rights, creation rights, or mutable memory or skills. An extension
request is never a grant.

A creation grant has two forms, set by `OperatorCreationPolicy.mode` (SysML
`attribute mode : String`). Under `autonomous` (the historical form, also the
meaning of an absent `mode`), the holder creates alone within its bound: the
human-approved grant is the prior approval, and the resulting self-approval —
actor equal to requester, refused everywhere else — exists only under this form.
Under `per-creation`, every creation is a routed change decided by someone else;
the requester never approves its own. A creator cannot pass on a more autonomous
form than its own: an `autonomous` grant under a `per-creation` parent is
refused. Provisioning, counting and decision of a Request-branch team member are
in [Sub-operators in a Request branch](#sub-operators-in-a-request-branch).

The `AssemblyCases::CaseType` belongs to that operator's system:
`owner = builder`, `behavior = conversation`, `envelope = "conversational"`,
with an explicit limit. The first Request has the stable identifier
`operator-request:<changeId>`. Its owner is the operator; its `openedBy` is the
Main Operator. `openedFrom` retains the originating change, conversation and
scope. Replaying creation does not open a second Request. Registration only
initializes the new units.

## Granting targeted editing rights

The `propose_mandate_change.requestedRights.grantModelEditing` variant receives
`{file, root, operations}`. Operations are `set-value`, `rename`,
`insert-member` and `remove`; `replace-source` is excluded. The file and root
must exist and match. The root stays within the requesting system and excludes
its authority declarations. An existing editing policy prevents this initial
grant.

The `ModelEditPolicy` instance binds the `builder`, its `builderMandate` and
`owner.ownerMandate.rootAuthority`. The check runs again before publication. An
editing grant does not bypass mandate protection; it does not allow arbitrary
unit creation or self-assignment of rights.

<a id="proposition-diff-et-décision-humaine"></a>

## Proposal, diff and human decision

The recorded change carries `requestedBy` and exactly one active scope: `caseId`
or `designerScopeId`. The latter technical identifier denotes the design
conversation; it does not determine the operator's display name. A proposal
without a scope is refused. The lock limiting each operator to one pending
proposal is explicit (`CHANGE_PENDING`).

In `GET /api/conversations`, `proposalContext.changes` retains the full change:
identity, kind, state, origin, `baseRevision`, `baseModelDigest`, `diff` and,
after publication, `publishedCommit` and the decision receipt. The diff contains
a title, author, Git base and digests, affected files, unified patch and
addition/deletion counts. It describes the prepared sources; the base is an
existing commit, not an invented proposal commit.

The human command is:

```http
POST /api/conversations/:agentId/changes/:changeId/decision
Content-Type: application/json
```

```json
{ "expectedRevision": 42, "configurationRevision": 2, "verdict": "approve" }
```

`expectedRevision` is the conversation revision, and `configurationRevision`
comes from `change.baseRevision`. The verdict is `approve` or `refuse`. No
`caseId` is received in this body: the host rereads the persisted scope and
selects its invocation before adoption, feedback and resumption. The response
`202 {"accepted":true}` does not prove that the work is complete. The historical
`POST /api/decisions` route with `kind: "change"` also reads the recorded
change.

Publication preserves the exact content shown. A newer HEAD is compatible only
if the prepared change remains applicable and faithful to the diff. The receipt
and durable recovery are described in
[Revisions and history](../evolution/revisions-et-historique.md).

## Request, escalation and closure

A person can continue an open Request owned by the operator through
`POST /api/conversations/:agentId/messages`, with `caseId`. This exception does
not open the operator's general thread to the person. Message forms and bounds
are described in
[Conversations and tools](operator-conversations.md#commandes-humaines).

An authority request is escalated with its change and Case. Main Operator
messages can contain `operatorNotice`:

- `authority-escalation`: change, requester, Case, recipient,
  `decisionAuthority: "human"` and reason;
- `request-completed`: Case, owner, opener, state `closed-done` or
  `closed-abandoned`, and result.

The `message.caseId` is the origin on the Main Operator's side; the Case in the
notice is the operator's. A notice is an untrusted observation, bounded on
receipt, and never a decision. It starts no turn, with one exception: an
`authority-escalation` whose route designates the Main Operator starts exactly
one turn in its current design conversation, in a branch as in main, because a
decision waits for it. `request-completed` never starts a turn: the Main
Operator reads it at its next turn. Stable delivery identifiers allow catch-up
at startup; a replay or restart adds no turn.

Closing with `done` refuses changes that are still pending. `abandoned` closes
them without fabricating authority or a receipt. An approved continuation that
has not resumed can be recovered, but its turn restarts only if the admitted
digest is still current. A Case's birth pin does not protect it against later
revocation.

## Delegated decision policy

The code compiles `AssemblyAuthority::OperatorAuthorityPolicy`, linked through
`holder`, `mandate` and `issuer` to the holder, its mandate and the root
authority. It carries `id`, `revision`, `enabled`, `recipients`, `acts`,
`networkHosts`, `toolIds`, `maxDelegationDepth`. Lists are canonical JSON in
String attributes. A subsequent revision is a new occurrence; compilation
refuses gaps, duplicates, holder changes and ambiguous references. The latest
revision prevails.

Implemented bounds: exact native recipients, `addNetworkHosts` as the only act,
exact hosts without wildcards, `toolIds = []`, `maxDelegationDepth = 0`. The
policy carries no counter, expiry or Case scope. It is not yet a temporary
mandate.

A policy request uses
`propose_mandate_change.requestedRights.operatorAuthority`:
`{policyId, expectedPolicyRevision, enabled, recipients, acts, networkHosts,
toolIds, maxDelegationDepth}`.
Creation expects revision 0; subsequent revisions require the current revision
and all bounds. `enabled: false` revokes the policy. `SourceModel` routes this
input to the shared writer. The preview preserves the exact diff; a new
publication without a diff or without a receipt from the prior owner is refused.
The policy and its bindings are checked after compilation.

`decide_operator_change` receives `operatorId`, `changeId`, `expectedRevision`,
`policyId`, `policyRevision` and `verdict`. Here, `expectedRevision` is the
change's base revision. The callback is bound to the primary runtime. The
workspace selects the recorded change and its invocation; free-form reasons in
notices do not participate in the authority calculation.

Exercise requires an active policy at the exact revision, its holder as the
actor, another requesting operator among its recipients, a mandate change
originating in a Request, and only covered hosts. The policy is reread at
decision time, then on the locked publication base. A delegated refusal must
also stay within the bounds; otherwise the request remains with the person.
Revocation prevents subsequent exercise without removing hosts already granted.

The decided change carries `authority: "builder"`. Its
`authorityExercise.delegation` identifies the actor, policy/revision/element,
issuing authority, requester, change, Case and exact rights. The Git receipt
retains this provenance. A replay under another actor or policy is refused.
Admission of an operator's own tools through `admissionAuthority = builder`
remains a separate mechanism.

### Branch Operators

A Branch Operator (BO) shares its native ID with the Main Operator. To give the
Main Operator authority over the BO of one Case, its proposal adds
`recipientCaseId` to `operatorAuthority` (or `toolAdmission`) and puts the BO's
native ID in `recipients`. The host resolves the Case's verified opening, writes
its space as `recipientExecutionSpaceId` (SysML `recipientSpace`) and does not
store the Case. An unknown, closed or foreign Case gives
`INVALID_AUTHORITY_POLICY` with `context.recipientCaseId`. The operator never
sends a space; the BO's native ID as a recipient is accepted only with such a
Case. One policy names one Case.

Every BO request reaches the Main Operator as a notice. Its decision context
lists, under `operatorAuthority`:

- `requests`: the BO requests whose current route designates it, which it may
  decide with `decide_operator_change`;
- `awaitingPerson`: the requests that wait for the person (`human-decision` or
  `needs-resolution` with its `code`), newest first, at most 20, with
  `awaitingPersonTruncated`. They are read-only: the Main Operator never decides
  them and tells the person to decide on the relayed card or on the Case card.

Both lists come from one recomputed walk of the open Requests per read; nothing
is cached. Without any policy, `awaitingPerson` is still listed and
`decide_operator_change` is not offered.

The Main Operator's decision for a BO is recorded with Main's current policy in
one fenced step, then published in the BO's branch and adopted for the BO. The
branch publication compares the change's receipt with that recorded decision,
not with Main's later policy: a revocation after the record withdraws nothing.

## Sub-operators in a Request branch

A BO can create sub-operators that join its Case. The team is the BO plus at
most three members: `MAX_BRANCH_TEAM`. What the space does with a team
(admission, listing, publication) is in
[Team in a space](cases.md#team-in-a-space).

### Asking for the creation right

A BO without an enabled creation policy can ask for its own right with
`propose_mandate_change.requestedRights.operatorCreation`:

```json
{
  "networkHosts": ["example.org"],
  "maxChildren": 3,
  "mode": "per-creation"
}
```

The request is confined to its own Request branch. `maxChildren` is an integer
from 1 to 3, counted across the whole team; the hosts must already belong to the
BO's network scope. `mode` is required: `autonomous` or `per-creation`. The host
fixes the holder and a delegation depth of zero. Members cannot use this path to
request the BO's right, and an existing enabled policy prevents another request
even when its capacity is exhausted.

The pending change appears on the existing Case card, with its bounds and mode,
and is relayed in Main's thread. The person decides. Receiving the notice gives
Main no decision authority; its network decision policy does not cover this
grant. Approval publishes an `OperatorCreationPolicy` in the BO's branch and
adopts it before creation becomes available. Main's branch is unchanged.

This command provides first-grant and re-grant requests only. It supplies no
withdrawal command. Once a policy with `enabled: false` has been separately
admitted and adopted, its disabled state blocks future creations while retaining
existing members and their creation records. A later grant request creates a new
policy and keeps those historical policy identities.

The host announces an acceptance wait only after the pending change is recorded.
A failed preparation returns its coded refusal to the BO; it does not announce a
pending card. The historical creation form without `operator.kind` and the
legacy `mayCreateReviewer` flag supply no branch creation authority.

### Proposing and provisioning

The BO proposes a member with `propose_agent_creation`, `role: "operator"` and
`operator.kind: "request-team-member"`: `instruction`, `provision` and an
optional `creationGrant`. It supplies no requester, parent, origin or Request:
the host does.

`provision` is required and has no default. It carries `budget`
(`maxAgentDecisions`, `maxToolProposals`, `maxFlowSteps`), `networkHosts`,
`mayPropose` and `mayInvokeActiveCatalog`. It may also grant `mayConsultModel`
and `mayProposeSysmlRevision`; each defaults to false when omitted and is
bounded independently by the creator's admitted right. Network-host proposal
capability is separate: `mayAddNetworkHosts: true` must be explicitly
provisioned and is allowed only when the creator has it; omission means false.
Each value stays within the creator's own admitted value: a budget no higher,
hosts within the creator's own and the grant's `networkHosts`, proposal kinds
within the creator's, catalogue invocation only if the creator has it. A value
above fails with `AUTHORITY_OUT_OF_BOUNDS`; `context.field` names it
(`budget.maxFlowSteps`, `networkHosts`, `mayPropose`, `mayInvokeActiveCatalog`,
`mayAddNetworkHosts`, `mayConsultModel` or `mayProposeSysmlRevision`), beside
`requested` and `creator`. Model-read and revision rights cannot exceed the
creator's corresponding rights. Revision authority requires model-read
authority; a provision that requests revision while omitting or refusing read is
invalid. In the default source Main has both rights. The Branch Operator uses
the same source-owned policy as that operator in Main: execution-space identity
does not grant or remove authority. An independently created Request operator
starts with read but no revision right; a team member starts with neither unless
explicitly provisioned within its creator's rights. The creator's own bounds are
read-only in its `operatorCreation` context. Creating a member gives the creator
no authority over it: hierarchy grants nothing.

Without `creationGrant`, a member has no creation right. A grant it carries must
stay within the creator's: strictly smaller `maxDelegationDepth`, no larger
`maxChildren`, hosts within the creator's grant.

### Counting in a branch

Read in a branch, a creation policy counts the whole branch team, whoever
created each member. The bound is `min(maxChildren, 3)` and it applies in that
branch only. Children inherited from `main` or from a Release do not count. A
policy held by the Main Operator in `main` has its native ID as holder, which
the BO shares: it therefore applies on every BO, each counting its own team.
Withdrawing the right blocks the next creations and never removes a member that
exists. Already decided creations reserve capacity until adoption and
continuation finish. Recovery resumes those decisions before considering new
creations and rechecks the count under the decision transaction. Truncation
never displaces an already admitted member.

### Deciding a creation

The destination is always the requester's branch (see
[Team in a space](cases.md#team-in-a-space)).

- **`autonomous`.** The BO proposes and its turn waits on the pending change.
  Once the turn has ended, the host decides under the grant, with the
  host-internal `request-creation-grant` authority (no session), then publishes
  in the branch and adopts. The Main Operator and the person are not asked. The
  creator resumes its original input before accepting another contribution
  (`AGENT_BUSY` while this decided creation's continuation is pending).
- **`per-creation`.** The creation reaches the Main Operator as an
  `authority-escalation` notice, with `decisionAuthority: "human"` and
  `changeKind: "operator-creation"`. The person decides on the Case card, or on
  the same card relayed in the Main Operator's thread. Approval publishes and
  adopts as above.
- **Refusal.** A fourth member is refused before anything is recorded or
  written. The bound raises `AUTHORITY_OUT_OF_BOUNDS`; the BO's proposal
  receives it as `PROPOSAL_NOT_AUTHORIZED` (its message names the remaining
  capacity), as every creation outside its grant.

### Escalation from a team

The bridge routes an authority request from the runtime of its requester: the BO
or a verified team member. Another requester is refused with
`OPENING_PROOF_MISMATCH` (check `team`), without a notice. The Main Operator's
context lists the team of each branch Request, read-only:
`requestOpening.requests[].team` holds `{operatorId, name, parentOperatorId}`
for each member. The BO receives a decision context and tool only when an active
explicit policy names an admitted member in this Request. If its context proof
is unavailable, the turn receives a coded decision error and can continue; it
receives no decision tool. Every actual decision revalidates its authority.

### Orders to a sub-operator

A member accepts any caller that its source model explicitly exposes to its
inbox (`BehaviorAccess`), inside its originating Request. When the caller is not
the parent, the parent receives one `subordinate-order` notice, after the order
was accepted:

- ID `subordinate-order:<invocationId>`, so a replay stores it once;
- `invocationId`, `caseId`, `subordinate`, `orderedBy` (the caller's
  `operatorId`) and `summary`, bounded text that is data, never an instruction;
- delivered to the parent's Case thread without waking it; the Request's own
  thread folds it into its “··· n steps” line, and Activity lists it as “… gave
  … an order”.

The notice never blocks the order and decides nothing. Replaying an accepted
order retries notice delivery without re-delivering the order; the deterministic
notice ID prevents duplicates. Failed delivery is logged with its code, context
and recovery instruction.

### Not delivered

The caller's PostgreSQL/Toolkit witnesses passed for member proposals, delegated
member publication/adoption and Main orders; round 3 full branch qualification
remains pending. The round 3 authority witness passed (1/1). Human BO refusal
reruns passed case-network-permission (2/2) and network-refusal (1/1). The
member-creation correction has unit and basic newborn binding witnesses; parent
adoptions and refusal were observed. The latest native grant witness remains
red: the child was approved and published, but its adoption dossier was not
prepared within 120 seconds under load. Cost and latency investigation moves to
lot 2. Member source context reads the member, BO and journal in one
transaction, with fresh checks before and after; 23/23 units passed. The BO
explicit-policy end-to-end witness remains open. A relayed uncovered member
request is informational until the person's decision scope is clarified. The
existing human BO contract remains unchanged. The remaining limits are listed in
[Current limits of Request spaces](cases.md#current-limits-of-request-spaces).

For member creation, a diagnosed adoption failure compares the member's retained
R to B after a BO sibling has advanced the shared source to A: the comparison
sees two new system roots although A→B publishes one child. The fix carries an
optional immutable publication base A, anchored to the source receipt and
authority, source digest and native compilation, with replay and native fences;
the member retains pin R. Its invariants passed 23 units; the native grant
witness remains red as described above.

## Delegated admission of an exact candidate

`AssemblyAuthority::ToolAdmissionPolicy` is a grant distinct from the network
policy. It binds the Main Operator, its mandate and the issuing authority, with
fields `id`, `revision`, `enabled`, `recipients`, `toolKinds` and
`maxDelegationDepth = 0`. Recipients are exact native identities of other
operators; tool kinds come from `TOOL_KINDS`. This grant gives no editing or
file-access rights.

### Prerequisite for older models

An older model without the native `AssemblyAuthority::ToolAdmissionPolicy`
definition retains its historical digest and local admissions. It does not
advertise the `toolAdmission` grant request: its writer cannot publish it. This
capability becomes available when the definition has been added to the sources,
then validated and adopted through the normal model revision flow. Sources are
not automatically migrated or rewritten.

The person decides the closed
`propose_mandate_change.requestedRights.toolAdmission` proposal, which contains
`{policyId, expectedPolicyRevision, enabled, recipients, toolKinds,
maxDelegationDepth}`.
It follows the same preview, writer, publication and adoption flow as the
network policy. A missing or disabled policy revision grants no exercise. Unused
definitions do not alter historical executable digests.

The grant must be adopted before candidate preparation. The proposal records the
applicable policies; a candidate prepared earlier gains no retroactive right.
Adopting a new version does not requalify tests under a changed contract: new
preparation is required for delegation. `context.operatorToolAdmission` presents
the Main Operator's policies and a lightweight list of covered candidates. The
Main Operator calls `inspect_operator_candidate` for a single candidate, with
`operatorId`, `candidateId`, `candidateDigest`, `expectedRevision`, `caseId`,
`policyId` and `policyRevision`. The host supplies the actor's identity.
Inspection checks the recipient's pin, the open Request, tests, contract and
catalogue base; code, contract and tests remain observed data.

`decide_operator_candidate` takes the exact reference returned by that
inspection, then adds `verdict` and `reason`. Approval or refusal follows the
recipient's native continuation. `requiredAuthority` and the local admission
mode remain `human`; valid evidence supplies effective `delegate` authority for
this decision only. No second human approval is required before shared
activation and resumption of the same Request.

The `AdmissionRecord` receipt carries `authority: "delegate"` and the actual
actor. `authorityExercise.candidateDelegation` retains the exact
policy/revision/element, issuing authority, owner, candidate/digest, kind,
Request, tests and contract. `authorityExercise.delegation` keeps its network
meaning. The policy and this evidence are checked before the durable intent,
then under the publication lock. Revocation blocks a new effect; an exact,
already-attested publication remains reconcilable after revocation, without new
exercise or a second catalogue entry.

An operator resumes only after the workspace and its registry are ready. Each
new delegated publication reserves the Case with the host, including a retry
after interruption. It does not select another work item's Case or budget.
Closing with `done` still allows an already-admitted intent to finish;
abandonment only allows confirmation of an effect that has already been
published. A decision marker without admission creates no new effect in a closed
Request.

## Reading policies and receipts

Network proposals expose their bounds in the shared diff card. Delegated
decisions show the decision-maker and exact policy from the recorded receipt,
with their Request and commit. The card's byline reads “Decided by … · rule … ·
rev. n” (“you” for the person under their own mandate, the operator's name under
a delegating policy), and an inspector lists the exact identities. The card's
state is one of **To decide**, **Applying**, **Applied**, **Declined** or
**Superseded**; the host's own statuses never reach the page. A notice alone
produces neither this attribution nor a decision.

`GET /api/model-revisions?agentId=...` adds
`runtime.sourceRights.operatorAuthorityPolicies`, compiled from current sources
and filtered by native holder. `toolAdmissionPolicies` exposes candidate
admission grants in the same way. The frontend checks freshness and version
consistency before announcing current state; an old execution version does not
prove that a policy remains active. Model version announcements reread the
relevant holder, with one subscription shared by its cards and cleanup when the
last card is removed.

Model Activity/Revisions also presents the retained receipt when it can link it
exactly to the published commit, change and owner. Missing evidence remains
absent. This historical receipt does not acquire a policy's current status from
another version.

## Sources and errors

Authority business errors carry `code`, `context` and `recovery`:
`CHANGE_PENDING`, `CASE_SCOPE_MISSING`, `CASE_NOT_OWNED`, `CASE_CLOSED`,
`CASE_BUSY`, `STALE_CONVERSATION`, `STALE_CHANGE`, `PUBLICATION_NOT_APPLICABLE`,
`PUBLICATION_FAILED` and the receipt/already-applied publication errors.
Delegation adds, among others, `INVALID_AUTHORITY_POLICY`,
`AUTHORITY_POLICY_FORBIDDEN`, `AUTHORITY_POLICY_STALE`,
`AUTHORITY_REQUEST_STALE`, `AUTHORITY_OUT_OF_BOUNDS`,
`AUTHORITY_RECEIPT_MISMATCH`. Read errors grant no rights and remain distinct
from decision refusals.

Sources for this reference:

- [`operator-authority.ts`](../../../src/domain/governance/operator-authority.ts)
  and
  [`operator-authority-policy.ts`](../../../src/domain/governance/policies/operator-authority-policy.ts):
  closed requests and delegated exercise;
- [`tool-admission-policy.ts`](../../../src/domain/governance/policies/tool-admission-policy.ts):
  prior grant, inspection scope and exact candidate receipt;
- [`operator-creation-policy.ts`](../../../src/domain/governance/policies/operator-creation-policy.ts):
  creation forms, branch count and provision bounds;
- [`request-space-authority-bridge.ts`](../../../src/application/governance/request-space-authority-bridge.ts)
  and
  [`request-change-decision.ts`](../../../src/application/work/request-spaces/request-change-decision.ts):
  routing and decision of a Request-branch change;
- [`mandate-change-decisions.ts`](../../../src/application/governance/mandate-change-decisions.ts)
  and
  [`conversations.ts`](../../../src/application/work/operators/conversations.ts):
  provenance, decision and recovery;
- [`runtime.ts`](../../../src/application/work/cases/runtime.ts): tracking and
  closure;
- [`source-model.ts`](../../../src/application/model/source-model.ts) and
  [`writer.ts`](../../../src/application/governance/operator-writer.ts):
  preparation and publication;
- [`conversations.ts`](../../../src/adapters/in/http/work/conversations.ts):
  commands.
