# Cases: Requests, Jobs and Watches

Contracts present in `main` at `2bb799d0`, reread on 31 October 2026 for
[Request spaces](#request-spaces) and for the scope notes added to the other
sections. The [team of a Request space](#team-in-a-space) was added on 1
November 2026 from the code of lot 4.8e (branch
`claude/branch-teams-e4-20261101`). The remaining sections date from `73b3ed6`
(25 October 2026) and are corrected only where the code contradicts them. This
reference describes the code; it is not a report of a real-world trial. Jobs and
Watches remain frozen for the demo, which focuses on Requests. Proposing them
for a recurring need remains allowed; their partial implementation is
distinguished below from the outstanding work.

## Identity and scope

A Case carries `id`, a `number` durably allocated within the system, `type`
(`request`, `job`, `watch`), `objective`, `owner`, `openedBy`, `openedFrom`,
`modelPin`, `status`, `createdAt` and optionally `closedAt`, `closedBy`,
`verdict` and `budget`. `status` is `open`, `waiting`, `closed-done` or
`closed-abandoned`. The objective is a label bounded to 2,000 characters by
`String.length`; the full request text remains in its journal message.

`modelPin` retains the digest and, when available, the commit at creation. This
is immutable provenance. A Case executes the `executionModel` of its runtime,
which explicit adoption replaces. In the main space, the Cases of one owner
share that owner's runtime: the pin gives none of them a separate execution
engine. A Request opened from the interface has its own runtime and its own
branch, and its pin names the commit of its base (see
[Request spaces](#request-spaces)). The number comes from one system-wide
sequence, whether the Case lives in the main space or in its own. Choosing a
policy to continue, migrate or suspend open Cases still belongs to the Process
Version Governance pattern.

The Main Operator in the initial model designs the system with the person in a
perpetual conversation outside any Case. Its `open_request` decision opens a
Request in its own branch, as the Requests page does (see
[Opening by the Main Operator](#opening-by-the-main-operator)). The internal
identifiers `designer` and `designerScopeId` designate this design scope; they
are not display names.

A Request has its own history and budget. In the main space, work entrusted to a
specialist keeps the caller's Case and shares its budget; it transfers neither
Case ownership nor authority. A Request space has no specialist; its
sub-operators are a [team](#team-in-a-space) of the Request. Each runtime runs
one invocation at a time, and each space has its own runtime. The continuity
limits between Cases remain open.

The shared dispatcher runs up to 16 ordinary deliveries at once; excess
deliveries wait in pg-boss without a notice or refusal. Main in `main` has one
additional reserved worker; its identity in a branch uses ordinary capacity.

## In the SysML model

```sysml
package AssemblyCases {
    private import ScalarValues::*;

    enum def EnvelopeKind { conversational; deterministic; reassessment; }

    enum def ScheduleUnit { minute; hour; day; }
    attribute def Schedule;
    attribute def Every :> Schedule {
        attribute count : Natural;
        attribute unit : ScheduleUnit;
    }
    attribute def DailyAt :> Schedule {
        attribute hour : Natural;
        attribute minute : Natural;
    }

    part def CaseType {
        attribute envelope : EnvelopeKind;
        ref action behavior : Actions::Action;      // Case behavior
        ref part owner : AssemblyCore::SoftwareOperator; // Accountable operator
        attribute maxInvocations : Integer [0..1];  // Invocation budget (Budget-Bounded Loop)
        attribute schedule : Schedule [0..1];
    }
}
```

A system declares its Case types; each native `CaseType` occurrence carries its
envelope. Historical configuration remains readable and its contracts retain
their encoding. Importing the library without declaring an occurrence remains
inert.

## Request spaces

A Request opened from the Requests page or by the Main Operator runs in its own
**execution space**, on its own Git branch, in its own runtime. A Request opened
in the main space keeps running there: the first Request of an operator created
in main, or `newConversation:true` on a main route (see
[Parallel conversations](#parallel-conversations)). Main Requests opened by the
former main `open_request` stay readable and hidden.

### Access

Every space route except the host identity route needs a control session,
carried by the HttpOnly cookie `assembly-space-session` (64 hexadecimal
characters). Space commands also pass the local-command guard (see
[URL and local-command security](#url-and-local-command-security-phase-2)).

| Route                                     | Body                       | Result                                                               |
| ----------------------------------------- | -------------------------- | -------------------------------------------------------------------- |
| `POST /api/space-session/exchange`        | `{"capabilitySecret":"…"}` | Sets the cookie, valid for at most 30 minutes.                       |
| `POST /api/space-session/local`           | `{}`                       | Sets the same cookie. Available in the development environment only. |
| `GET /api/request-space-openings/context` | none                       | `{projectId, systemId}`: the host identity. No session, no grant.    |

### Opening

`POST /api/request-space-openings/open` takes exactly three fields. The host
owns every other value: no actor, scope, identifier or Git ref comes from the
body, which is bounded to 410,000 bytes.

| Field        | Constraint                                                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openingKey` | Caller-chosen idempotency key: `A-Z`, `a-z`, `0-9`, `_` or `-`, 1 to 128 characters.                                                                                                                 |
| `text`       | The request. Non-empty after trimming, at most 100,000 characters, no NUL. It is the Case's first message.                                                                                           |
| `source`     | `{"kind":"current-main"}` with an optional `expectedVersion` (`commit:` and 40 hexadecimal characters), or `{"kind":"release","releaseId":"…","digest":"…"}` with a 64-hexadecimal-character digest. |

The opening advances through six recorded phases, one step per transition:

| Phase             | Reached when                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `allocated`       | The opening exists with its identifiers and its Case number.                                     |
| `source-selected` | The base is resolved and recorded with its digest.                                               |
| `branch-ready`    | The branch ref exists at the base commit.                                                        |
| `runtime-ready`   | The space's runtime is provisioned, without any provider call, and its initial skills are ready. |
| `admitted`        | An execution admission is recorded.                                                              |
| `dispatched`      | The first message is queued for the Branch Operator.                                             |

- **Identifiers.** One transaction allocates the Case `number` from the system
  sequence and five fresh UUIDs: `caseId`, `executionSpaceId`, `branchId`, the
  opening `id` and the `initialContributionId` of the first message. The space
  is recorded as an `active` child of `main`.
- **Base.** With `current-main`, the base is the head of the admitted main
  history, checked against its verified source. A different `expectedVersion`
  gives `OPENING_CONFLICT`. With `release`, the base is the retained Release
  named by `releaseId`, whose digest equals `digest` and whose assets are
  verified. The base is recorded once. Recovery reads the recorded base, never
  the current main.
- **Eligible base.** The source must contain exactly one `request` CaseType that
  a `primary` operator owns and whose behavior is that operator's conversation
  flow. It must declare no scheduled CaseType: a Job or a Watch makes the base
  unavailable (`SOURCE_SCHEDULE_UNSUPPORTED`). Host requirements and retained
  assets are checked against the exact source before the branch is created.
- **Branch.** `refs/heads/requests/<branchId>` is created at the base commit,
  under the repository writer lock, with `git update-ref`. There is no checkout,
  no working tree and no HEAD switch, and `main` does not move. A ref that
  already names another commit gives `OPENING_CONFLICT`.
- **Admission.** It names the Branch Operator alone, with the act
  `conversation`, the source version, the operator's model digest and its
  retained tool resources. It lasts at most 24 hours. The host checks it again
  when it accepts a delivery and when an effect starts. A later team creation
  replaces it with one that also lists the team (see
  [Team in a space](#team-in-a-space)).
- **Idempotence and recovery.** The same `openingKey` with the same command
  returns the same opening and continues from its recorded phase. The same key
  with another command gives `OPENING_CONFLICT`, before any change.

The response is the opening view. `release` is `null` for `current-main`.

```text
{id, caseId, caseNumber, executionSpaceId, branchId, initialContributionId,
 phase, revision, sourceVersion, release, admissionId, issues}
```

Refusals have the form `{code, error}` with optional `context` and `recovery`:
HTTP 400 `INVALID_COMMAND`; 403 `FORBIDDEN` or `ADMISSION_REFUSED`; 409
`OPENING_CONFLICT`; 503 for any other code. An invalid control session is a 403
`FORBIDDEN` carrying `context.session: "invalid"`. A scoped action's 403 without
that marker does not invalidate the session or require reconnecting the event
stream.

A step that fails for another reason does not throw. The opening keeps the phase
it reached and the view returns one code in `issues`, without exception text.
Sending the same command again resumes it.

### Opening by the Main Operator

The Main Operator opens a branch Request from its design conversation with
`open_request`: `text`, `objective` (at most 2,000 characters, the Case's first
message), a stable `openingId` and `source`, either `{"kind":"current-main"}` or
`{"kind":"release","releaseId":"…","digest":"…"}` copied from its context. It
never names the operator: the Branch Operator is the source's unique Request
owner.

- **Authority.** The `open-request` act of the Main Operator's own mandate:
  `mayOpenRequests` on its `ConfiguredMandate`, absent by default in older
  libraries. The person is not asked. The space still belongs to the system's
  owner, whose current `SpaceControlPolicy` must admit the operator; otherwise
  `FORBIDDEN`, before anything is created.
- **No session.** The host issues a capability for the owner, discards its
  secret and creates no session row. Each phase re-reads that capability, the
  owner's control policy and the act. The person's own session later reads,
  decides and adopts in the space as in any of its Requests.
- **Identity.** The opening key is `main-` followed by the SHA-256 of the
  operator, conversation, design scope and `openingId`. The same `openingId`
  returns the same opening; another objective under it gives `OPENING_CONFLICT`.
  The recorded command carries the opener and its origin, inside the command
  digest. The Case's `openedBy` is the Main Operator.
- **Author.** The objective reaches the Branch Operator as the Main Operator's
  input, not the person's: its URLs are never a person's selection, and a host
  it names follows the network route (the Main Operator's mandate if it covers
  this BO, otherwise the person).
- **Result.** `{status:"opened", caseId, caseNumber, executionSpaceId, phase}`,
  with `issues` when a phase must be retried, or
  `{status:"refused", code, recovery}`. There is no HTTP route.

Its context (`requestOpening`) carries `canOpen`, the open branch Requests
(`caseId`, `caseNumber`, `operatorId`, `executionSpaceId`, `status`, `openedBy`
of `main-operator` or `person`, newest first, at most 20), the owner's retained
Releases, and the main Requests it opened before (`mainRequests`).
`resume_request` targets an open entry of either list. In a branch Request the
instruction reaches its operator as the Main Operator's input, under the same
authority as opening, keyed by `resumeId`; a retry with the same `resumeId`
sends nothing new.

### Branch Operator

The **Branch Operator** (BO) is the operator that runs a Request space. It is
the base's `primary` operator, the one that owns the Request CaseType (see
**Eligible base**). The role comes from the space, never from a name: the
conversation of a Request space names its principal "Branch Operator" in place
of the generic name "Main Operator". The interface then shows an invented
two-word name drawn from the Case, on the initials of its title; "Branch
Operator" stays in the tooltip of the Request header's chip. Custom names and
persisted identifiers are kept.

- **Declaration.** The BO executes the declaration of the primary operator at
  the pinned base commit, as compiled: instructions, mandate, tools and flows.
  It does not read the current main. Adoption can later replace its execution
  pin (see [What the BO can change](#what-the-bo-can-change-in-its-branch)).
- **Runtime.** One runtime per space, with the identifier
  `request:<executionSpaceId>:<operatorId>`. Its state, budget, memory, skills
  and plans live in stores scoped to the space and the operator. The host
  refuses these stores unless the space is `active` and belongs to the Case.
- **Case.** The Case is born with the BO as `owner`, the first message as its
  objective (bounded to 2,000 characters), and `modelPin` set to the BO's
  declaration at the base commit. Its `openedFrom` carries the runtime
  identifier, the opening `id` and the `initialContributionId`.
- **Concurrency.** Deliveries are serialized for each space and operator, so
  each operator runs one invocation at a time; a parked wait releases the slot.
  Spaces do not share a runtime. The shared worker pool bounds the total: up to
  16 ordinary deliveries at once, plus one reserved Main worker; further
  deliveries wait in the queue.

### Isolation

- **Writes.** A Request source write has a destination of kind `request`,
  resolved by the host: the ref `refs/heads/requests/<branchId>` and an
  `executionSpaceId` other than `main`. A destination that names `main` is
  refused (`WRITE_COMMAND_INVALID`). No public body can supply a destination.
- **Model.** The BO sees its exact pinned executable model, read-only. Through
  the model port, proposing an edit, activating a candidate and applying a
  change are refused (`FORBIDDEN`), and the source graph is unavailable. Only
  the preview of the BO's own network-host proposal is allowed.
- **Views.** `GET /api/case-model/:caseId` returns the read-only scope of a
  Case, shown below. Appending one of the model read paths of
  [`case-branch.ts`](../../../src/adapters/in/http/model/case-branch.ts), as in
  `/api/case-model/:caseId/api/model/board`, reads that view at the exact
  `version`. The optional `?version=commit:…` selects another commit of the
  branch history. The request resolves and authorizes the Case and the commit
  first. Any method other than GET gives 405, an invalid parameter gives 400,
  and an unresolvable Case, path or version gives 404, all with
  `CASE_MODEL_UNAVAILABLE`.

  ```text
  {caseId, branchId, executionSpaceId, branchVersion, version,
   executionVersion, baseVersion, release, readOnly: true}
  ```
- **Execution.** The runtime accepts a delivery only under a current admission.

### Reading and talking to a Request in its space

These routes need the control session and an exact `caseId`. A scoped selection
is terminal: it never falls back to the main runtime.

`GET /api/performance/provider-resources?caseId=:id` reads retained provider
observations for the exact Request and execution space through the read cutoff.
It includes correlated operators and model versions across the Request's
lifetime. The execution pin describes the current runtime; `expectedVersion`,
when supplied, checks that pin rather than selecting historical calls. Operator
groups use exact IDs, including former team members, and a null ID for
unattributed calls. Calls lacking Request correlation cannot be attributed;
physical call coverage is unknown and observed totals are lower bounds.

The response counts retained physical provider outcomes (`returned`, `failed`,
`timed-out`, `cancelled`), not business verdicts. Each usage unit provides an
observed subtotal, counts of present and missing values, and a state. A subtotal
is null if no value is known; missing usage is not zero. Cache breakdowns are
separate units and are not added to their parent. Provider elapsed time is the
sum of call latencies, not Request duration, since calls can overlap.

The total and each operator group have a `tokenSummary` with `total`,
`meanPerCall` and `cacheReadShare`, computed over their own calls. Total adds
input, output, cache creation and cache read tokens only when all four units are
known for every call; mean divides it by calls. Cache read share divides cache
read by input plus cache creation plus cache read. Missing data, overflow or no
calls produces null where the calculation is unavailable; mean and share are
also null for a zero denominator. The 5-minute and 1-hour cache creation
breakdowns are not added to their parent. Partial unit subtotals remain
available independently.

For a Request, `request` contains `durationMs` and `humanInterventions` with
`messages` and `decisions`. Duration is `Case.closedAt - Case.createdAt`, or
null while open. Messages are retained `user` messages with the exact Case ID,
excluding the opening message identified by its conversation and message IDs,
work, operator notices and observations. Decisions have the exact Case ID, human
authority and a recorded decision time; a decision counts even if publication is
pending, while automatic abandonment does not. The counts read the BO journal
and available team states; journal coverage is unknown. The lifecycle and team
states are read separately from the provider snapshot and cutoff, so they are
not one atomic snapshot. Case status, author and verdict remain on the Case, not
duplicated in these KPIs.

| Route                                                                                  | Result                                                                                                                    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/cases?space=requests`                                                        | `{systemId, cases}` for the owner's spaces in phase `runtime-ready`, `admitted` or `dispatched`.                          |
| `GET /api/cases/:id?space=requests`                                                    | `{systemId, case}`.                                                                                                       |
| `GET /api/conversations?caseId=:id`                                                    | The conversation snapshot of that Case: the BO and its team, each member with `operatorTeam`.                             |
| `POST /api/conversations/:agentId/messages?space=requests`                             | `{"text":"…","expectedRevision":42,"caseId":"…"}`. `agentId` must be the BO. `newConversation` is refused.                |
| `GET /api/conversations/:agentId/changes/:changeId/decision?space=requests&caseId=:id` | Status of a change decision.                                                                                              |
| `POST /api/conversations/:agentId/changes/:changeId/decision?space=requests`           | `{"caseId":"…","expectedRevision":42,"configurationRevision":3,"verdict":"approve"}`; `verdict` is `approve` or `refuse`. |
| `POST /api/conversations/:agentId/changes/:changeId/decision/resume?space=requests`    | `{"caseId":"…"}`; resumes a decision whose adoption was interrupted.                                                      |

The main runtime's scheduled Case actions `run`, `pause`, `resume` and `stop`
are refused with `INVALID_REQUEST_SELECTION` (HTTP 400) when `space` is present.
Scoped closure uses the Request's authenticated command below.

`POST /api/cases/:id/close?space=requests` accepts `outcome: "done"` with
`verdict: "accepted"` or `"rejected"`. Omitting the verdict returns
`CASE_VERDICT_REQUIRED`. The interface has no button for it since 3 November
2026: a closed Request shows only “Closed · …”, with “accepted by you” or
“rejected by you” when a verdict was recorded. Archiving is planned. `closedBy`
records the authenticated local control session's `ownerId`, not an inferred
human name. Internal closure records neither a person nor a verdict. An operator
response requesting `done` for a Request is refused at response validation; Job
and Watch behavior is unchanged.

### What the BO can change in its branch

The BO has five ways to change its branch today. Each uses the authority
described below.

- **Its instructions, by the person.** The routes
  `/api/request-source-revisions/propose`, `/accept` and `/resume` (all `POST`)
  publish a source revision to the branch. `propose` takes `caseId`,
  `expectedVersion`, `reason` and 1 to 64 `changes`, each with a `path` and a
  `text`. The routes `/api/request-runtime-adoption/eligibility`, `/prepare`,
  `/resume` and `/status` (all `POST`) then adopt it into the BO's runtime.
  Adoption accepts an instruction-only change: any other difference in the
  executable model is refused.
- **Network hosts, on a human decision.** The BO proposes a mandate change that
  adds 1 to 8 network hosts and nothing else. The person decides on the Case
  card with the decision route above, or on the same card relayed in the Main
  Operator's thread. Approval publishes the additive change to the branch and
  adopts it for the BO. Refusal is recorded and the BO resumes with it. Under a
  main mandate that names this BO, the Main Operator decides instead; see the
  [authority reference](autorite-des-operateurs.md).
- **Its creation right, on a human decision.** A BO without an enabled creation
  policy proposes `requestedRights.operatorCreation` through
  `propose_mandate_change`. The existing card shows the requested hosts, a
  whole-team limit of at most three members, and `autonomous` or `per-creation`
  mode. The hosts stay within the BO's own scope; the holder, branch and zero
  delegation depth are fixed by the host. The person decides on the Case card or
  its relay in Main's thread. Approval publishes and adopts the policy in this
  branch; it changes neither Main nor another Request. A proposal creates no
  right and no member. See
  [Asking for the creation right](autorite-des-operateurs.md#asking-for-the-creation-right).
- **Its team, by creation.** The BO proposes a sub-operator; its creation grant
  decides who approves (see the
  [authority reference](autorite-des-operateurs.md#sub-operators-in-a-request-branch)).
  The member is published in this branch only (see
  [Team in a space](#team-in-a-space)).
- **Software evolution.** The BO can prepare changes to its own behavior. This
  is wired in the host composition and not qualified end to end.

A person can save a Release from a Case branch, and a later Request can open
from it. No operation in this host merges a Case branch into `main`.

An acceptance wait is announced only after its pending change is recorded.
Unsupported changes or failed preparation return a coded refusal; they do not
produce a false waiting announcement. Once a disabled creation policy is
admitted and adopted, later creations are blocked and existing members remain.
The grant-request command itself provides no withdrawal operation.

### Team in a space

A space holds the BO and, once it has created them, at most three sub-operators
(`MAX_BRANCH_TEAM`). How a creation policy counts them and the rules for
creating a member (the two grant forms, explicit provisioning, escalation) are
in the
[authority reference](autorite-des-operateurs.md#sub-operators-in-a-request-branch).
This section describes what the space does with a team.

- **Publication.** A creation is published in the branch of its requester and
  adopted there. `main` and the other branches never move, and a member created
  in one Case does not exist in another. Until the creator's exact continuation
  resumes, a new input receives `AGENT_BUSY`; visible admission of the member
  alone does not mean the creator is ready for another message.
- **Admission.** The person's control policy still admits the BO alone. The
  space's admission lists `permissions.operatorIds = [BO, ...team]`, each member
  at its own model digest. `branchTeam` in
  [`request-spaces.ts`](../../../src/domain/work/request-spaces.ts) is the one
  function that produces the team: it keeps a pinned operator whose
  `operatorTeam.requestId` is the Case and whose creation receipt verifies, at
  most three. A member inherited from `main` or from a Release is not part of
  the team.
- **Talking.** The person talks to the BO only: a message to a member is refused
  (`agentId` must be the BO). Members work by contribution: the BO reaches a
  member through its inbox (`BehaviorAccess`, parent to child). A member's
  `operatorTeam` carries `parentOperatorId`, `requestOwnerId` and `requestId`;
  it confers no right.
- **Reading.** Besides the conversation list above,
  `GET /api/system/supervision` lists one `team` instance per member, with its
  `parent`; a member that cannot be read is an `unavailable` instance with its
  reason, never an omitted row. The interface reads the team from the
  conversation snapshot, not from this route: the Request's tree, Team and
  Rights show its members.
- **Orders.** A member accepts any caller its source model explicitly exposes to
  its inbox, inside its originating Request. When the caller is not the parent,
  the parent receives one `subordinate-order` notice after the order was
  accepted. The notice never blocks the order; its fields are in the
  [authority reference](autorite-des-operateurs.md#sub-operators-in-a-request-branch).
  The Request's own thread folds it into its “··· n steps” line; Activity lists
  it as “… gave … an order”.

### Current limits of Request spaces

These limits describe the present code. They are not the target design.

- **Team changes.** Member proposals and delegated decisions target the member's
  runtime and model. A BO receives a decision context and tool only under an
  active policy explicitly naming an admitted member. Context failure is a coded
  decision error and does not fail the BO's ordinary turn. Uncovered member
  requests are relayed as information pending clarification of the person's
  decision scope; member-human publication is not established. The existing 4.8b
  human BO contract is unchanged; its refusal reruns passed
  case-network-permission (2/2) and network-refusal (1/1) with PostgreSQL and
  Toolkit. Software evolution still refuses any target other than the BO.
- **Creation by a member.** A member's explicit creation grant is checked
  against the whole-team bound, with its persisted creation receipt used for
  admission. A member's executed source pin may precede the branch head: its
  native model digest must remain unchanged at the admitted source. A generated
  member may request network-host additions only with explicit
  `provision.mayAddNetworkHosts: true`, bounded by its creator's right; omission
  means false. Decided creations reserve capacity through recovery, and admitted
  members cannot be displaced by team truncation. The caller's member network
  publication/adoption witness passed; basic newborn member binding and parent
  adoptions were observed, as was refusal. The latest native grant witness
  remains red: the child was approved and published, but its adoption dossier
  was not prepared within 120 seconds under load; cost and latency investigation
  moves to lot 2. Member source context reads the member, BO and journal in one
  transaction, with fresh checks before and after (23/23 units). A diagnosed
  adoption failure occurs when the member retains R, a BO sibling advances the
  branch to A, and the member publishes one child at B: comparing R to B counts
  both new system roots. The fix carries an optional immutable publication base
  A, anchored to the source receipt and authority, source digest and native
  compilation, with replay and native fences; it retains the member pin R. Its
  invariants passed 23 units; the native grant witness remains red as described
  above.
- **BO after a member publication.** The BO keeps its own execution pin R. If a
  member advances admitted source A, the BO's network preview currently refuses
  A != R even if its model digest is unchanged. Extending the retained-model
  rule here also requires changing the human authority/publication contract;
  this verification round preserves that contract and leaves this limitation
  open.
- **Identical creations.** A duplicate instruction and provision in one Case is
  refused before another teammate is created.
- **Order from the Main Operator.** `resume_request` can name an admitted
  member; the host derives its space from the Case and records the Main
  crossing. Its BO receives a non-waking notice, including for a nested member.
  Replaying the accepted order retries a failed notice without duplicating the
  order or notice. The caller's existing end-to-end order witness passed; the
  retry correction has unit witnesses and awaits integration rerun.
- **Active-agent cap.** Ordinary deliveries use 16 workers; further deliveries
  wait in the queue. Main has the existing reserved lane.
- **Presentation.** A Request lists its team as a tree, with each member's
  panel. Team and Rights show members and their rights, and the creation of a
  member reads as a “New member” card.
- **Delegated acts.** The Main Operator decides a BO's request only for
  `addNetworkHosts`; every other kind waits for the person.
- **Lifecycle.** Closing and reusing spaces are not described here.

## Parallel conversations

These routes address the **main runtime**: the Main Operator's perpetual
conversation and the Requests opened in the main space. A Request in its own
space is reached through the
[scoped routes](#reading-and-talking-to-a-request-in-its-space) above.

The existing send routes accept a JSON object, with the existing origin checks
and non-empty text of 1 to 100,000 characters; the HTTP body is bounded to
524,288 bytes:

| Route                                       | Body                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `POST /api/messages` (central operator)     | `{"text":"Bonjour"}` or `{"text":"Suite","caseId":"session:case:12"}` |
| `POST /api/conversations/:agentId/messages` | `{"text":"Suite","expectedRevision":42,"caseId":"session:case:12"}`   |

The operator identity in the path must be encoded. `expectedRevision` is the
revision of that operator's runtime, supplied by `GET /api/conversations`, not a
Request-specific revision. The central route keeps its historical body without
`expectedRevision`; the host takes its current revision at reservation.

- With `caseId`: resume that open Request (`open` or `waiting`), owned by the
  target operator. An initialization Case, Job or Watch cannot receive this
  human message.
- Without `caseId` or `newConversation`: send to the designer's perpetual
  conversation without creating a Case.
- `"newConversation":true`: create a new Request in the main space, even if
  others are open. This first message is its request.
- `caseId` together with `newConversation:true` is refused. `null`, an empty
  identifier, `newConversation:false` and extra fields are refused. There is no
  fallback to a current Request or an ongoing delegation.
- Success: HTTP 202, `{"accepted":true}` for the designer;
  `{"accepted":true,"caseId":"…"}` for a created or resumed Request. The
  returned `caseId` is used for subsequent messages in that Request.

Business-level send refusals have the form
`{error: string, code: string, context: object, recovery: string}`:

| Code                 | HTTP | Context and recovery                                                                                                                                                                       |
| -------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CASE_NOT_FOUND`     | 404  | `{caseId, agentId}`; choose an open Request belonging to that operator or send `newConversation:true`.                                                                                     |
| `CASE_NOT_OWNED`     | 403  | `{caseId, agentId}`; same recovery, without transferring the Case.                                                                                                                         |
| `CASE_CLOSED`        | 409  | `{caseId, agentId}`; choose an open Request or create a new conversation.                                                                                                                  |
| `INVALID_CASE`       | 409  | `{caseId, agentId}`; the Case must be a conversational Request, outside initialization.                                                                                                    |
| `AGENT_BUSY`         | 409  | `{agentId, caseId?}`; `recovery` is exactly `retry after the current reply`. No message or Request is created, and there is no queue. This refusal takes precedence over a stale revision. |
| `INVALID_MESSAGE`    | 400  | Invalid selection or content; correct the body.                                                                                                                                            |
| `STALE_CONVERSATION` | 409  | Reload `GET /api/conversations` and resend with the operator's revision.                                                                                                                   |

The existing access, admission and closure checks still apply
(`READ_ONLY_AGENT`, `UNKNOWN_AGENT`, `MODEL_ADMISSION_BUSY`, `CASE_BUSY`, etc.).
Errors reported by the application expose their code; context and recovery may
be absent. The HTTP precheck for a read-only operator keeps HTTP 403 with
`{error: string}`. Transport errors (JSON, size, origin) keep their HTTP status
and `error` field.

To list conversations, `GET /api/cases` and the `cases` SSE already provide
`{systemId, cases}` for all operators of the main runtime. Keep entries with
`type:"request"`, without `openedFrom.origin:"initialization"`, and with status
`open` or `waiting`. `id` is the send `caseId`; `owner` is the `agentId`;
`number`, `objective` and `createdAt` serve presentation. Operator messages
remain available in `GET /api/conversations`, attached through
`messages[].caseId`. A Case receives only messages with its `caseId`, with no
greeting or history from the designer or other Cases. The designer's
conversation receives its messages without `caseId`; `designerScopeId`
distinguishes delegated contributions from another designer conversation in a
specialist runtime. Context reads use the same filtering.

The durable selection `caseInvocation.kind:"designer"` and `designer.scopeId`
explicitly identify the designer; absence of a Case never provides a fallback to
this scope. Its budget uses the admitted `workBudgetPolicy` in the separate
`<runtime.id>:designer` ledger. CaseType ceilings apply to Cases, not the
designer. Switching threads or restarting preserves consumption in each ledger.
`modelDiagnostics` warnings are supplied to the central designer, filtered as
before, never to Cases. `caseClosure` is ignored in designer scope; an operator
cannot request `done` for a Request. Other applicable closures remain scoped to
the selected Case. Mandate, grants, suboperators and tools remain the same in
both scopes; a designer delegation explicitly forwards its scope and budget
without creating a Case. `AGENT_BUSY` preserves one invocation per runtime.

### Legacy-dossier migration

An old state without a `cases` collection and without suspended work reloads its
untagged messages into the designer. If it already has a budget binding, the
designer keeps that historical scope and its consumption instead of receiving a
new ledger. An admitted policy with no recovered binding suspends execution; no
fresh budget is inferred from history. If the state carries a continuation, a
pending candidate or a legacy work receipt, the existing migration retains a
Request with `migratedFrom:"legacy-dossier"`, its reservations, cursors and
candidate ownership. It does not rewrite the journal: old messages without
`caseId` belong to the designer, even in this migrated state; new Request
messages carry its `caseId`. Old history is therefore never implicitly shared
with a Case. A missing, corrupt or ambiguous scope remains refused
(`CASE_SCOPE_MISSING` or `INVALID_CASE`); migrations do not attach an orphan
continuation to a new designer or Case.

<a id="jobs-et-watches-déclarés"></a>

## Declared Jobs and Watches

A native `AssemblyCases::CaseType` occurrence carrying `schedule` becomes a
**Job** with `EnvelopeKind::deterministic`, or a **Watch** with
`EnvelopeKind::reassessment`. Human acceptance of the proposal in **Model >
Revisions** precedes model adoption. On adoption, the runtime creates one
durable Case per declaration, with its objective, `owner`, `behavior` and
creation-version pin. A deadline adds a run or wake to this Case; it does not
create a new Case.

The central operator proposes the occurrence with `propose_sysml_edit`, a
Toolkit `insert-member` operation targeting the system's native identity. The
occurrence name carries the objective. Adapt this example to the references
actually present in the system:

```sysml
part 'Morning summary' : AssemblyCases::CaseType {
    attribute :>> envelope = AssemblyCases::EnvelopeKind::deterministic;
    ref action :>> behavior = conversation;
    ref part :>> owner = builder;
    attribute :>> maxInvocations = 8;
    attribute :>> schedule : AssemblyCases::DailyAt {
        :>> hour = 8;
        :>> minute = 0;
    }
}
```

### Scheduling and execution

The Toolkit is the only SysML reader. The host reads its identities, types,
redefinitions, `Natural` literals and `ScheduleUnit` values through native
readers; it parses no scheduling string. `part def CaseType` and
`maxInvocations : Integer` are retained for this increment.

- `Every` carries `count >= 1` and `unit = ScheduleUnit::minute`, `hour` or
  `day`;
- `DailyAt` carries `hour` from 0 to 23 and `minute` from 0 to 59, in UTC.

Example of a member of the same occurrence proposed in a single `insert-member`:

```sysml
attribute :>> schedule : AssemblyCases::Every {
    :>> count = 15;
    :>> unit = AssemblyCases::ScheduleUnit::minute;
}
```

Missing, ambiguous, non-literal, mistyped or out-of-bounds values are refused;
no read failure triggers a fallback value. The host also checks numerical and
date limits. The structured `INVALID_SCHEDULE` error identifies the CaseType and
recovery. The old String attribute is refused. Historical executable digests
remain unchanged, and importing the library alone remains inert. Public JSON
keeps `job.schedule` as text, produced from the typed values: "every 15 minutes"
or "daily at 08:00 UTC". This text is never input to the scheduler.

The runtime calculates deadlines behind the clock port. On restart, missed
deadlines cause at most one catch-up; it never runs a burst to catch up with
every interval. Two runs of the same Case do not overlap. Each run or wake
receives its own budget scope; `maxInvocations` is not a credit renewed with
every message in that run. The owner's mandate, tools and grants are still
checked.

A Watch ends its wake with a structured reply
`watchResult: {changed: boolean, summary: string}`. The runtime retains the
observation and sends a `role: "tool"` message attached to `caseId` in the
central conversation if `changed` is `true`. Its structured `watch-notification`
observation carries the source Watch, its owner (`ownerId`), `caseId`, summary
and `trust: "untrusted"`. The text and central prompt present it as an untrusted
observed datum, never as an instruction or the central operator's own words. Old
queue entries with no owner explicitly say `unknown`. `ChatTimeline` folds
consecutive `role: "tool"` records into one "··· n steps" line; opening it shows
each record's exact text. Work deliveries are never folded. Outside a Request's
own thread, evolution receipts and the operator notices that need the person (a
human decision, an unresolved escalation, an abandoned Request) keep their own
line or card; the Main's thread hides its work records and the other notices,
which Activity lists. A fold ends at any other entry and where the Case changes;
when the thread enters a Case with a fold, the Case chip precedes it. A missing
or invalid result does not mean that nothing changed.

The notification is recorded in a durable outbox with the wake result. The
central conversation deduplicates receipt by notification identity; the outbox
is acknowledged only after receipt. An interruption between receipt and
acknowledgment must therefore not duplicate the message on recovery.

### Actions and HTTP contract

`GET /api/cases` returns `{systemId, cases}`; `GET /api/cases/:id` returns
`{systemId, case}`. Path identities must be encoded. Common Case fields and its
pin are retained. The contract read by `frontend/lib/cases/cases.ts` adds:

- Job:
  `job: {schedule?, steps: [{id, label, state}], runs:
  [{id, startedAt, outcome}]}`,
  where `outcome` is `done`, `failed`, `running` or `abandoned`;
- Watch: `watch: {state, nextWakeAt?, wakes: [{at, changed, summary?}]}`, where
  `state` is `watching`, `paused` or `stopped`.

| Action                  | Endpoint                     | Body                                                                                | Response                             |
| ----------------------- | ---------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------ |
| Run now, Job            | `POST /api/cases/:id/run`    | `{}`                                                                                | `{systemId, case, action: "run"}`    |
| Pause, Watch            | `POST /api/cases/:id/pause`  | `{}`                                                                                | `{systemId, case, action: "pause"}`  |
| Resume, Watch           | `POST /api/cases/:id/resume` | `{}`                                                                                | `{systemId, case, action: "resume"}` |
| Stop, Watch             | `POST /api/cases/:id/stop`   | `{}`                                                                                | `{systemId, case, action: "stop"}`   |
| Close, main-space Cases | `POST /api/cases/:id/close`  | `{"outcome":"done"}` or `{"outcome":"abandoned"}`; a Request `done` is refused here | `{systemId, case, closed: true}`     |

Pause, resume, stop and close are runtime actions without model edits. Every
command requires a JSON object bounded to 1,024 bytes; extra fields are refused.
Exceeding the limit returns `COMMAND_TOO_LARGE` (HTTP 413). Commands retain
local-origin checks. The `cases` SSE event publishes the same
`{systemId, cases}` snapshot on every change. Errors have the form
`{error: {code, message, context?, recovery?}}`; an unknown Case gives HTTP 404,
and a conflict or busy execution gives HTTP 409.

### Limits of this increment

Wakes consult a source through the operator's already admitted means; no webhook
or external event provider is added. The executed behavior is the one referenced
by the declaration: the owner's conversational flow or another native compiled
flow with the same allocation and mandate checks. Available primitives remain
those of the conversational engine; an action with no executable flow or with
invalid allocations is refused on read. Proposing a Job or Watch grants no
editing or execution rights.

The process polls the scheduler every second and serializes each operator's
work. A deadline therefore waits for an invocation already in progress to
finish. Resume sets a future deadline without replaying wakes from the paused
period; Stop is terminal, and Close closes the Case. Stopping the process during
a Job marks its run `abandoned`; for a Watch, the wake summary reports the
interruption. History and notifications remain persisted in the existing session
store.

A SysML proposal remains bounded by admitted editing rights. The operator may
propose a `grantModelEditing` grant only if that variant appears in
`mandate.supportedChanges`. The request grants nothing: see
[editing rights by mandate](../../how-to/operateurs/droits-edition-par-mandat.md).

### URL and local-command security (phase 2)

Under `urlSelectionMode: user-provided`, only human messages in the current
conversation can supply the URL: messages without `caseId` for the designer, or
with the exact `caseId` for a Request. A URL supplied to Request A authorizes
neither Request B nor a Job or Watch run. A scheduled run has no human message:
its target must appear in the name carrying the objective of the admitted
CaseType, with the same path and parameters. Owner, behavior and type must match
this Case. The runtime objective alone is insufficient. Otherwise, the call is
refused with `URL_NOT_USER_SUPPLIED`. The network mandate still applies.

All state-changing POSTs in the Cases adapter (`run`, `pause`, `resume`, `stop`,
`close`) require `Host` to equal `127.0.0.1` or `localhost` with the served
port, an `Origin` that is present and identical to the request's local origin,
and `Content-Type: application/json`. The port comes from server configuration,
never from the received header. `sec-fetch-site: cross-site` is also refused.
The `development` environment relaxes two of these checks: the port is not
compared, any loopback `Origin` (`localhost` or `127.0.0.1`, over HTTP) is
accepted, and the `sec-fetch-site` check is skipped. The guard runs before any
body read or business call. JSON makes the cross-site request non-simple; no
CORS access to commands is added. `HOST_REFUSED`, `ORIGIN_REFUSED` and
`JSON_REQUIRED` refusals carry code, message and recovery. Actions with no
parameters require `{}`; closing keeps its explicit outcome. The
`requireLocalJsonCommand` guard, defined in
[`local-security.ts`](../../../src/infrastructure/http/local-security.ts), is
shared with conversation, Request-space and local-control commands.

## Sources and scope of verification

- [Case identity and states](../../../src/domain/work/entities/cases.ts),
  [native types](../../../src/adapters/out/sysml-toolkit/compilation-policies/work/case-types.ts)
  and [SysML declaration](../../../models/cases.sysml).
- [Selection and recovery](../../../src/application/work/cases/runtime.ts),
  [model adoption](../../../src/application/work/runtime/model-adoption.ts),
  [HTTP messages](../../../src/adapters/in/http/work/conversations.ts) and
  [Case HTTP commands](../../../src/adapters/in/http/work/cases.ts).
- [Scheduler](../../../src/application/work/cases/scheduling.ts),
  [typed schedules](../../../src/domain/work/value-objects/case-schedule.ts),
  [Watch notifications](../../../src/application/work/runtime/system.ts) and
  [URL admission](../../../src/application/governance/tool-invocation-admission.ts).
- [Scheduled integration scenarios](../../../test/integration/scheduled-cases_test.ts)
  with scripted operators and
  [native type reading](../../../test/integration/case-types_test.ts). Their
  presence does not prove that they ran in a given instance.
- Request spaces:
  [opening](../../../src/application/work/request-spaces/opening.ts) and its
  [ports](../../../src/application/work/request-spaces/ports.ts),
  [opening records and commands](../../../src/domain/work/request-spaces.ts),
  [identifier allocation](../../../src/adapters/out/postgres/request-space-store.ts),
  [branch refs](../../../src/adapters/out/git/request-branches.ts),
  [base selection](../../../src/application/work/request-spaces/opening-sources.ts),
  [space runtime](../../../src/application/work/request-spaces/runtime.ts),
  [write destination](../../../src/domain/model/editing/request-write-destination.ts),
  [read-only model](../../../src/application/work/request-spaces/request-space-model.ts),
  [Case views](../../../src/adapters/in/http/model/case-branch.ts),
  [scoped conversations](../../../src/application/work/request-spaces/conversations.ts)
  and [admissions](../../../src/application/work/request-spaces/control.ts).
- [Opening tests](../../../src/application/work/request-spaces/opening_test.ts)
  and
  [PostgreSQL composition tests](../../../test/integration/postgres-request-spaces-composition_test.ts).
  Their presence does not prove that they ran in a given instance.
- Branch team: `branchTeam` in the
  [space records](../../../src/domain/work/request-spaces.ts),
  [team creation decision](../../../src/application/work/request-spaces/request-change-decision.ts),
  [supervision readout](../../../src/application/work/request-spaces/supervision.ts)
  and the
  [PostgreSQL witness](../../../test/integration/postgres-request-branch-team_test.ts).
  Their presence does not prove that they ran in a given instance.

No real trial of a Job or Watch with the Claude provider is recorded in this
handoff. The Request-space contracts above are read from the code; this page
records no browser or provider qualification of them. External event triggers,
detailed judgment points and accepted Case transfer are not qualified by this
increment.
