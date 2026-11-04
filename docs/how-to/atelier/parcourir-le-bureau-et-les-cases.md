# Navigate the desktop and Cases

This guide describes the interface as of 4 November 2026. Its labels are in
English. The initial model names its main operator **Main Operator**; a system
created before this rename retains the name declared in its model.

## Talk to the Main Operator

Click the operator button at the center of the Dock. It opens the persistent
conversation with the main operator alongside the page already displayed. You
can use it to design the system and request operators to handle Requests. This
conversation is not itself a Case.

Case is the common term for Requests, Jobs and Watches. The **Requests** button
and page collect conversational requests only.

`Ctrl` + `Shift` + `D` focuses the disc; `Enter` opens the conversation.
`Escape` first closes an open operator detail, then the conversation. The Dock
remains accessible at the bottom of the desktop. Click the operator's name at
the top of its conversation to reveal its **Mission**, **Mandate** and
**Tools**, and the list of the other operators.

The Main Operator's thread shows what asks you: your own messages, its replies,
the decisions you can make, escalations nobody has settled and reports of
abandoned Requests. Work records and routine notices, such as a Request's
completion, are not shown there. **Activity** lists them.

The title bar names the system and shows a version pill for the model being
viewed. The **Assembly** menu provides **About Assembly** information and the
model provider. **Switch system…** and **Settings…** are still disabled. To
create a system, follow [Start a system](demarrer-un-systeme.md).

## Open or find a Request

1. Open **Requests**, to the left of the disc.
2. To start a Request, type in **What do you need?** at the bottom of the list.
   The request opens its own conversation, without a welcome message.
3. To resume a Request, open its row under **Open**. Closed Requests appear
   under **Done**. The most recent ones come first in each group.
4. Reply in **Reply…**. The field is replaced by a line such as “Closed · done”
   once the Request has ended.

Before starting, **Start from** selects the model of the new Request: **Current
Main**, or a retained Release from the **Releases** group. The Release list
refreshes when you open the page and when you focus the selector. Refreshing
keeps your choice and any saved opening intention. To start from a Release you
are reading, use **New Request from this Release** on its inspection: it opens
this page with that Release selected.

In production mode, **Local control file** imports the credential file supplied
with the local instance to establish its authorized session. This is not an
upload of a Release or model. Development mode establishes the local session
automatically; it has no credential-file picker.

The title reflects what was requested. A Case's internal number is not its name.
Each row also shows a version pill and its age. A solid dot indicates unread
activity or a pending decision. **needs you** means that a decision is required
for that specific Case.

Open Requests are also accessible to the left of the Dock. When space runs out,
older ones fold into **+N earlier**. In a Request's header, **Keep in Dock**
keeps a Case within reach, even after closure; click it again to remove that
preference. A closed, unpinned Request leaves the Dock. Pinning is local to this
browser and system: it changes neither the model nor its rights.

A Request's header shows its title, **From Release …** when it started from a
Release, and a version pill: “Request n”, or “Request n · modified” once its
branch moved from its base. Its operator is named by a two-word name, not
“Branch Operator”, which stays in the tooltip. **View model** opens its model
and **Create release** starts a Release from its current source. Closing a
Request from the interface is not offered. Archiving is planned.

## Read a conversation

Operators' messages are read as Markdown: lists, tables, quotes and code are
drawn. A link to a Request is a chip. A message that is very long or deeply
nested, a raw HTML fragment or an image stays as plain text. Diagnostics links
remain clickable; other external links stay as text. Your own messages stay
exactly as you wrote them.

Several tool or host records in a row are folded into one line, **··· n steps**.
Open it to read each record as it was written.

## Decide on a card

A change to the model, a change of mandate or rights, or a new team member
arrives as one card. Its state reads **To decide**, **Applying**, **Applied**,
**Declined** or **Superseded**.

1. Read the card: what changes, who proposed it, and the exact `.sysml` diff
   under **SysML +n −m**. A new member shows its mission and its rights.
2. Choose **Accept**, **Decline** or **Adjust**. **Adjust** lets you enter a
   correction: the old proposal is declined and the operator prepares another.
3. Once decided, the card folds to one line with its state. **Applying** shows
   three dots (decided, saved, in service). If the host still has a step to
   take, **Retry applying** appears.
4. To see who decided and under which rule, open the byline: it reads “Decided
   by … · rule … · rev. n”.

A Branch Operator's request is also relayed in the Main Operator's thread. It is
one decision: you can decide there or in the Request, and the other card
follows. Accepting sources and putting them into service stay two separate
steps; see [Revise the system](../evolution/reviser-systeme.md).

## Read operator contributions

In a Request, the tree on the left shows its owner and the operators that
contributed to it. Select a suboperator to read its exchanges within that Case.
This thread has no reply field; **Open conversation** opens that operator's
conversation. Return to the tree root to reply within the Request.

The operator panel shows its mission, **Mandate**, **Tools** and, when the
catalogue is available, **Skills**. Tools are grouped by server; skills show
their names and descriptions. The panel sits to the right when space permits and
above the conversation in a narrow layout. This panel is read-only.

## Keep a conversation beside System or Model

The desktop has three states: full conversation, split conversation and page,
and page only. From full Main or a full Request, opening System or Model shows
the same conversation in split, with its current thread and unsent draft. If a
sub-operator's contribution was selected, that thread stays selected. The
operator tree and details panel are hidden in this compact layout. **Open full
Request** returns to the full layout.

Click the selected conversation's tile in the Dock to hide the chat and give the
page the available width. Click any conversation from page-only to open its full
conversation. Switching to another conversation while split keeps the
System/Model page open under the newly selected context. Selecting the central
operator disc while a model page is open switches the conversation to the Main
Operator and keeps the page; selecting a Request tile switches back. Opening
System or Model without a selected Case shows the Main Operator conversation.

Page-only is recorded as `conversation=hidden` on System/Model addresses;
internal links preserve it. Hiding or showing the chat preserves the exact
branch, inspection, page and selected operator.

The Dock shows only the tiles that fit; the others pile into **+N**. It reads
the available width again when the window changes and keeps keyboard focus
reachable when a tile moves.

When the scoped Request reader is available, System and Model show its branch
and exact model version. If that reader is unavailable, the page says so; it
does not substitute the global model. The Main Operator context shows main.

**Create release** in a Request's header starts a Release from that Request's
current source, even while it runs an older version. The host checks authority,
exact tags and retention before it creates anything; see
[Create and inspect a release](../modeles/parcourir-system-et-model.md#create-and-inspect-a-release).

## Find what waits and what happened

**Activity** collects pending decisions above a chronological history of what
happened. Its badge counts the same pending queue. A decision attached to a Case
links to its conversation and flags only that Case. A decision specific to the
Main Operator remains in its conversation. See
[Find what is waiting and what happened](../modeles/parcourir-system-et-model.md#find-what-is-waiting-and-what-happened-activity).

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
