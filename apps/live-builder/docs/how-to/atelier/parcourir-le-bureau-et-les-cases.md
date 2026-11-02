# Navigate the desktop and Cases

This guide describes the interface as of October 30, 2026. Its labels are in
English. The initial model names its main operator **Main Operator**; a system
created before this rename retains the name declared in its model.

## Talk to the Main Operator

Click the agent button at the center of the Dock. It opens the persistent
conversation with the main operator alongside the page already displayed. You
can use it to design the system and request operators to handle Requests. This
conversation is not itself a Case.

Case is the common term for Requests, Jobs and Watches. The **Requests** button
and page collect conversational requests only.

`Ctrl` + `Shift` + `D` focuses the disc; `Enter` opens the conversation.
`Escape` first closes an open agent detail, then the conversation. The Dock
remains accessible at the bottom of the desktop.

The title bar names the system. In **System** and **Model**, it also identifies
the selected conversation and the model being viewed. An explicit historical
selection is marked as an inspection; it does not switch the running model. The
**Assembly** menu provides **About Assembly** information and the model
provider. **Switch system…** and **Settings…** are still disabled. To create a
system, follow [Start a system](demarrer-un-systeme.md).

## Open or find a Request

1. Open **Requests**, to the left of the disc.
2. To start a Request, type in **What do you need?** at the bottom of the list.
   The request opens its own conversation, without a welcome message.
3. To resume a Request, open its row under **Open**. Closed Requests appear
   under **Done**. The most recent ones come first in each group.
4. Reply in **Reply…**. The field is absent after closure.

Before opening a Request, **Model for this Request** selects current Main or an
exact saved Release. The Release list refreshes automatically when entering or
returning to the page and when focusing the selector. Refreshing preserves the
selected Release and any saved opening intention.

During development, **Local control file** imports the credential file supplied
with the local instance to establish its authorized session. This is a
development handoff, not an upload of a Release or model. Choose the Request's
model in the source selector separately.

The title reflects what was requested. A Case's internal number is not its name.
A solid dot indicates unread activity or a pending decision. **needs you** means
that a decision is required for that specific Case.

Open Requests are also accessible to the left of the Dock. When space runs out,
older ones fold into **+N earlier**. **Pin** keeps a Case within reach, even
after closure; **Unpin** removes that preference. A closed, unpinned Request
leaves the Dock. Pinning is local to this browser and system: it changes neither
the model nor its rights.

## Read agent contributions

In a Request, the tree on the left shows its owner and the agents that
contributed to it. Select a sub-agent to read its exchanges within that Case.
This thread has no reply field; **Open conversation** opens that agent's
conversation. Return to the tree root to reply within the Request.

The agent panel shows its mission, **Mandate**, **Tools** and, when the
catalogue is available, **Skills**. Tools are grouped by server, and loaded
skills are marked **loaded**. This panel is read-only.

## Keep a conversation beside System or Model

**Current navigation — 30 October 2026:** the local implementation has three
states: full conversation, split conversation/page, and page only. From full
Main or a full Request, opening System or Model shows the same conversation in
split. Clicking that selected conversation in the Dock hides the chat and gives
the same scoped page the available width. Clicking any conversation from
page-only opens its full conversation. Switching to another conversation while
split keeps the System/Model page open under the newly selected context.

Page-only is recorded as `conversation=hidden` on System/Model URLs; internal
links preserve it. A visibility toggle preserves the exact branch, inspection,
page and selected agent. Entering from a full conversation clears hidden mode.
Draft/scroll state and the parked Request selection are retained rather than
substituted with a new Request composer during Main navigation. Full Main reuses
the existing ChatView at full height. The latest explicit desktop layout choice
uses a central reading column comparable to Cases, with side areas reserved;
split mode stays unchanged. This latest layout is awaiting final browser proof.

The Dock retains legitimate +N overflow grouping. It uses actual available
width, revealing fitting tiles as it grows and piling only surplus as it
shrinks. Keyboard focus remains reachable when a tile moves into or out of the
pile. These changes have focused automated evidence. ROOT subsequently exercised
Main split/page-only/full and Request → page-only → full Main → Request with an
unsent draft preserved and cleared without sending; constrained/grown Dock
capacity was also observed (UX qualification of 30 October 2026). This closes
those bounded browser checks, not every source/subagent/viewport permutation.
Earlier descriptions below retain their source context where they do not
conflict with this dated update.

Open **System** or **Model** while a Request is selected. The same conversation
moves to the compact panel on the left, with its current thread and unsent
draft. If a sub-operator's contribution was selected, that thread stays
selected; opening a model page does not redirect you to the Request owner. The
agent tree and details panel are hidden in this compact layout. **Open full
Request** returns to the full layout, where you can choose another conversation.

The **System** and **Model** Dock tiles show a small conversation monogram and
their tooltip names the context. Selecting the central operator disc while a
model page is open switches the left conversation to the Main Operator and keeps
the right page open. Selecting a Request tile switches back in the same way.
Opening System or Model without a selected Case shows the Main Operator
conversation.

When the scoped Request reader is available, System and Model show its branch
and exact model version. If that reader is unavailable, the right page reports
the unavailability; it does not substitute the global model. The Main Operator
context continues to show main. An eligible unchanged Request base (B0) can be
retained as a Release under current authority and visibility checks. Retaining
an evolved Request source (A1) remains refused until its separate governed
admission and provenance work is qualified.

**30 October 2026, current implementation checkpoint:** the preceding B0-only
refusal describes the earlier qualified baseline. The current source now
implements retaining the verified current admitted A1 independently from the
origin Request's executed version. Existing exact authority, tag, provenance and
asset checks remain required. Joined native and A1 browser qualification are
still pending; this is neither deployment nor acceptance. The older running
port-4399 browser build does not establish the new A1 behavior.

The Case header shows its state, owner and, when the current budget belongs to
it, **Effort n / max**. **Close** requests closure as completed; a server
refusal remains visible. Closure alone does not certify that the requested
effect has been verified.

## Inspect a proposal

A source proposal shows its author, base commit, changed files and lines, then
the `.sysml` diff. **Unified** and **Split** only change its presentation.
Inspect this content before choosing **Accept** or **Decline**. A decided
proposal remains available in its collapsed form.

**To decide** collects pending decisions. A decision attached to a Case links to
its conversation and flags only that Case. A decision specific to the Main
Operator remains in its conversation. Accepting sources and putting them into
service remain distinct steps; see
[Revise the system](../evolution/reviser-systeme.md).

## Inspect an existing Job or Watch

The **Jobs** and **Watches** stacks to the right of the disc open the scheduled
Cases present in the system. One click expands their list; another opens their
detail alongside the central conversation.

- A Job shows its steps and recent runs. **Run now** requests a run; **Close
  case** requests closure. Choices at a judgment point remain disabled: their
  command is not connected.
- A Watch shows its state, next wake-up and observed changes. **Pause**,
  **Resume** and **Stop** call the server. Wakes without a change are grouped
  into one row; changes remain separate.

These pages read real data. Their presence does not complete qualification work
for Jobs and Watches: product development for them remains frozen, with the demo
focused on Requests. The Main Operator may nevertheless propose a Job or Watch
for a recurring need; that proposal grants no rights by itself.

To explore the system and its versions, see
[Navigate System and Model](../modeles/parcourir-system-et-model.md). The
desktop contracts are described in the
[reference](../../reference/atelier/bureau-et-cases.md).

### Latest operator-label clarification — 30 October 2026

The 31 October owner correction supersedes this earlier label direction: “Main
Operator” identifies the global Main actor. A Case's principal is **Branch
Operator** because its execution space is non-main, independently of its name;
custom/model names and stored identities remain unchanged. Its System page shows
the branch, with actual Main as a separate muted, read-only reference. See the
[current scope contract](../../explanation/modeles/pages-system-et-model.md#selected-system-scope).
This latest presentation correction is in progress and has no new final browser
receipt yet. It does not rename persisted identities or change conversation
targets.
