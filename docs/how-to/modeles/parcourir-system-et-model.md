# Browse the System and Model places

This guide is for people using the workshop. It shows how to read the admitted
SysML model in the System place, its history in the Model place, and what awaits
a decision in the Activity place. It assumes that a system is running and its
interface is open: see [start a system](../atelier/demarrer-un-systeme.md).
Labels match the interface and are in English. Things you click are in bold.
Text displayed by the page is in quotation marks.

System pages do not change anything. In Model, **Accept**, **Decline**, **Admit
and integrate**, **Adjust**, and **Put in service** act on the host when the
card offers them. Activity makes no decisions: each row leads to the page where
you decide.

## Open a place

1. In the Dock, at the bottom of the screen, find the three tiles to the right
   of the logo: **System**, **Model**, and **Activity**.
2. Clicking a tile opens the place in the main panel. **Activity** shows the
   number of items waiting. **Model** shows an indicator when a proposal is
   waiting.
3. Clicking the tile again, or the panel's close button (tooltip "Close System",
   "Close Model", or "Close Activity"), closes the place. **System** reopens on
   Team. **Model** reopens on the last page read, with its revision or file.
4. Switch pages using the tabs at the top of the panel. Each page has its own
   address, such as `/system?page=rights` or `/model?page=files`. Team and
   Model’s Activity use the bare address (`/system`, `/model`). Dock Activity
   opens at `/activity`. `/revisions`, Model's former address, still opens
   Model.
5. Copying the address shares the view. In System, it carries the open element
   (`?select=`) and the version being read (`?version=`). In Model, `?commit=`
   or `?proposal=` opens Revisions on a revision; `?file=`, `?line=`, and
   `?version=` control Files. A tool proposal in Activity carries `?operator=`,
   `?candidate=`, and `?digest=`; these three identities open that operator's
   exact candidate.

### Identify the conversation and version being viewed

The title bar shows a **version pill** for the model the page describes: “Main”
with the date of the commit, “Request n” (“Request n · modified” once its branch
moved from its base) or the name of a Release. Its dot is filled when that
version is in service, and a lock marks a read-only version. Open it to read the
exact status (In service, Not in service, Past version, Version unavailable or
Service status unavailable) and the identities behind it. The same pill replaces
identifiers in lists and headers.

System and Model describe the explicitly selected system. A selected Case means
its own branch; global context means main. Selecting the Main conversation while
keeping a Case view open does not silently replace that view's branch. Read the
page's branch and version. **Leave Request** in the title bar returns to the
Main conversation. The conversation on the left, including a selected
sub-operator, keeps its own identity and execution pin. **Open full Request**
restores its operator tree and details panel. The split and page-only layouts
are described in
[Keep a conversation beside System or Model](../atelier/parcourir-le-bureau-et-les-cases.md#keep-a-conversation-beside-system-or-model).

In a Case, its principal is the **Branch Operator (BO)** because it runs in that
non-main execution space, regardless of the name retained in its source model.
Team joins it to a muted **Main Operator** node, a link to the actual main
system. The branch's Main reference and Main rights come from that actual model,
with their own source version. Unavailable Main reads stay unavailable. A Main
reference or graph connection grants no approval authority. See the
[scope and evidence contract](../../explanation/modeles/pages-system-et-model.md#selected-system-scope).

An explicitly selected source version is read-only. Outside Release creation, a
banner reads “Read-only inspection” with the version, says that the conversation
keeps its current model, and offers **Return to current model**. It neither
changes the conversation nor adopts the inspected version. During Release
creation, the exact selected source stays fixed: the title identifies it as
current or historical only when the current source has been read. If that
comparison is unavailable, the source is identified without guessing. A proven
historical selection keeps the inspection notice. Historical Activity and
Revisions views that cannot be read at that source version show an unavailable
message and an **Inspect Files** link; they do not present current activity as
historical data. Revisions' existing commit-detail links remain available.

A Request uses its resolved branch and exact version when its scoped reader is
available. If the scoped reader is unavailable, System and Model say so rather
than showing main under the Request's name.

## Read the System place

The tabs are **Team**, **Performance**, **Explore**, **Flows**,
**Requirements**, **Rights** and **Diagnostics**
([`desk.ts:8`](../../../frontend/lib/workbench/desk.ts)). The **More** menu
lists **Parts** and **Allocations**
([`desk.ts:19`](../../../frontend/lib/workbench/desk.ts)); it takes the page's
name when either is displayed. In a Request, only **Team**, **Performance** and
**Rights** are tabs; **More** also holds **Explore**, **Flows**,
**Requirements** and **Diagnostics**. **Search** at the right of the tabs, or
the `/` key, opens a field that finds an element by name and links to its page.

The ordinary pages come from the selected system's board at its displayed
commit. Rights reads that commit's matrix. A read-only external Main reference
carries Main's own actual source/version and rights rather than borrowing the
branch matrix. Declared rights do not establish effective access. A Main/BO
comparison compares those versions: when a Case started from an older Release,
it does not by itself describe all changes made within that Case. During the
first read, the page says "Reading the system…".

### Follow a tool being prepared

In **Team**, each operator's profile presents its tools under **Tools & skills →
Has**. A candidate awaiting admission has a yellow "Awaiting admission" chip.
The conversation's **Tools** panel uses the same indicator. The text status
remains readable without relying on color.

Clicking the chip opens the corresponding notification in **Model → Activity**,
with its diff, checks, and the consequence of admission. A tool candidate's diff
covers its code; a SysML proposal's diff covers the model sources. **Admit and
integrate** records a single admission that then authorizes automatic
publication and activation under the current mandate. The tool remains in
activation until that publication is verified.

Stale reads are marked as the last observations. Explicitly versioned views do
not display current candidates. In **Explore**, an exact native binding makes it
possible to show the tool's state; a new tool appearing in a later board is
briefly highlighted, without animation on the first load or in a historical
view.

### Read the displayed version

1. Below the tabs, read the version line: the version pill, as in the title bar.
   On main it reads “Main” and the commit's date; open it for the full commit
   code and its status.
2. If the model in service for the central operator is a different commit, the
   pill says so (“Not in service” or “Past version”) and its inspection lists
   the “In service” commit. The page then describes something that is not yet
   running.
3. To read a past version, add `?version=` followed by `commit:` and the
   commit's 40 hexadecimal digits. Page links keep that version, a lock marks
   the pill as read-only, and the **Show current model** link returns to the
   head.
4. A rejected version is reported as "This is not the identity of a version of
   the model." (malformed identity) or "This version is not in the model's
   history." (unknown commit). **Show current model** returns to the head.

### Choose the wording: Readable or SysML

1. On Explore, Flows, Requirements, Rights, Parts and Allocations, find the
   **Readable** / **SysML** group to the right of the tabs. Team, Performance
   and Diagnostics do not have it.
2. **Readable**, the default choice, describes the model in everyday language: a
   unit carries the name the team gives it, an identifier becomes a phrase
   (`maxAgentDecisions` becomes "Max agent decisions"), and an element has an
   icon indicating its kind. **SysML** uses the model's terms: declaration
   keywords, types, identifiers, expressions, source file.
3. The choice stays in this browser, under the `assembly:view:mode` key (an
   older `ase:view:mode` value is copied only when the new key is absent)
   ([`view-prefs.ts:19`](../../../frontend/lib/system/view-prefs.ts)). It is not
   included in the address. Without storage, it only applies to the open page.

### Open an element's details

These actions apply to Explore, Flows, Requirements, Parts, and Allocations.
Team and Rights have their own, described below.

1. Selecting an element (card, row, step, state, port) opens its details
   directly below. Only one detail panel is open at a time, and the address
   carries `?select=<id>`.
2. Read the details: the element's kind, name, summary, the values the model
   gives it, then its relationships, grouped by meaning. Up to six values are
   shown, fourteen in **SysML**, then "+N more"
   ([`detail.ts:242`](../../../frontend/lib/system/board/detail.ts)). The first
   three relationship groups are listed; "N more" opens the others. A group
   names eight elements, then "+N". Each referenced element is a link to its
   page. In an Explore column, the details are limited to the summary and action
   links.
3. Follow an action link. One carries the name of the element's home page
   (**Parts**, **Flows**…; **Explore** for a concept without its own page) and
   leads there; it is absent when you are already there. **Source** opens the
   model file at the declaration's line, in Model > Files.
4. Notice what is connected: while an element is selected, its neighbors remain
   outlined, with labels explaining why ("performed by", for example);
   Allocations outlines them without saying why. The others fade.
5. Close the details with the **×** button, the Escape key, or a second click on
   the element.

### See who acts: Team

1. Open **System** in the Dock. Team opens.
2. Read the network. By default it shows only the operators, a dark line joining
   "You" to those that talk with you ("You" only appears if there is one), and
   its nodes can be moved with the mouse. The **Resources** switch above it adds
   what they use (tools, skills, contexts, memories, information), a shared
   resource being a single node marked "×N". An arrow goes from an operator to
   each operator it may call, such as a member its Request created.
3. Read the profile below the network. Selecting an operator (`?select=<id>`)
   changes the profile; without a selection, it shows the first operator that
   talks with you, otherwise the first operator. It says "Talks with you" or
   "Not in direct contact with you" when the model or runtime says so, and
   "working now" when the operator is working.
4. Read the profile sections: "Context", "Tools & skills", "Memory", "Mandate",
   and "Works on" (the flows it executes; absent if it executes none). A section
   the model does not declare becomes a dotted line saying so, such as "No
   memory declared".
5. Under "Tools & skills", read the "Servers" row: the tool servers the runtime
   provides to the operator, with their tool count (the list is in the tooltip).
   This appears alongside what the model declares, never in its place.

On the main system, the Branch Operators of the open Requests join the network
beside the Main Operator, newest first and joined by a “supervises” line; each
leads to its Request's Team. Beyond six, the oldest fold into one “+N earlier”
node. In a Request, the network shows its own operators and a muted Main
Operator node that links to the main system.

A **Performance** summary stands beside the network, with its **Open
Performance** link.

Beyond twelve operators, the operator list replaces the network, to the left of
the profile
([`TeamPage.tsx:30`](../../../frontend/components/system/team/TeamPage.tsx)).
With no declared operator, the page says "No agent declared". If the projector
could not place any, it says "No agent could be read". Host notes, with their
code and instruction, are also displayed: all of them below this message when
there is no operator, otherwise only warnings and errors above the page.

### Browse the whole model: Explore

1. Open **Explore**. A column appears for each concept that contains something:
   "Team", "Can do", "Rules", "Guarantees", "Information". The number beside the
   title counts the cards.
2. Read the group titles within a column (they disappear when there is only one
   column). A title comes from what the model groups the element under (a
   package, a facet), otherwise from the unit: "in" followed by its name, or "In
   every system". Without a unit, it is "Shared definitions". An element
   declared in several units is a single card marked "×N".
3. Selecting a card opens its details below; selecting it again closes them.

An empty model shows "Nothing declared yet".

### Follow a flow or lifecycle: Flows

1. Open **Flows**. On the left are the "Flows" list, then the "Lifecycles" list.
   The first flow is read by default; selecting another (`?flow=<id>`) reads it
   instead. A "×N" means that N units declare it.
2. Read a flow as a vertical thread: the start, then steps shown as cards. A
   filled dot names the operator that executes the step, a ring a platform
   element.
3. A decision is a diamond. A decision, fork, or step with several successors
   splits the thread into side-by-side branches, named `if`, `else`, `parallel`,
   or `then`. The guard is in the tooltip; in **SysML** mode, it follows the
   name. "↺ back to" signals a loop, "→" a jump. A step that nothing reaches
   from the start says so in its tooltip.
4. Read a lifecycle as columns of states, from left to right: by distance from
   the initial state, then states that no path reaches, then final states. The
   initial state has a dark border, a final state a dashed border, an inherited
   state is more subdued. A state's tooltip says where it leads (trigger, guard,
   target).
5. Selecting a step or state opens its details below. The page keeps the current
   flow.

Without behavior, the page says "No flows yet"; a lifecycle without states says
"No states yet".

### Check requirements: Requirements

1. Open **Requirements**. Two sections may appear: "Requirements" and
   "Constraints". An empty section is not drawn.
2. Read the dot on each row. For a requirement, filled: at least one unit is
   declared to satisfy it; alert ring: none. For a constraint, filled: an
   executed step upholds it; pale ring: none. The row's tooltip repeats this. Do
   not read these dots as test results: the model does not say whether anything
   has been tested.
3. Read the text. In **Readable** mode, a requirement is described by its
   summary, followed by its name (if it has a summary) and the names of its
   clauses; a constraint says "on" followed by the element it targets, and "not
   performed" when nothing executes it. In **SysML** mode, the declaration
   appears as written, with its expression.

Without requirements or constraints, the page says "No requirements yet".

### See the structure: Parts

1. Open **More**, then **Parts**. There is one section per unit: its name, its
   ports, then "Operators" and "Platform" (environments, catalogs, and gates
   that operators depend on), nested as the model nests them.
2. Read a port: a square (hollow when conjugated), its name and type, then what
   it carries, with `←` for an input and `→` for an output. "not connected"
   signals a port that nothing reaches.
3. Read the "Connection", "From", "To" table: the model's `connect`
   declarations. Its endpoints are text; select the port in the panels above.
4. Selecting a unit, part, or port opens its details.

Without structure, the page says "No system structure yet".

### See who executes what: Allocations

1. Open **More**, then **Allocations**. Columns are performers, grouped by unit.
   Rows are what the model allocates to them, grouped under the flow's name,
   followed by "· in" and the unit, or under "Actions · in" for an action
   outside a flow. A unit the page cannot place is "?".
2. Read a dot: it is a model allocation (`allocate`).
3. Selecting a row's name or one of its dots opens its details in a table row.

Without allocations, the page says "No allocations yet".

### Read rights: Rights

1. Open **Rights**. The matrix is read separately, slowly the first time:
   "Reading the rights…" appears, and actors are already drawn, without marks.
2. In **Readable** mode, read the overview. One row per actor, "You" first, then
   each operator. One column per family in which someone has a right: "Tools",
   "Approve", "Mandate", "Model", "Memory", "Work". The header's tooltip gives
   the family's full name.
3. Read a mark. Filled disk: the actor does it alone ("alone"); half disk: it
   proposes it and a decision follows ("proposes"); empty ring: no ("no"); alert
   ring: granted without use ("granted, unusable"); padlock: never ("never"). In
   "Tools" and "Approve", an indicator beside the mark ("approves its own tools"
   in the legend) signals an actor that admits its own tools with no possible
   reviewer.
4. Selecting a mark opens that family's rights one by one below the actor's row,
   each with its mark. An unusable right says why.
5. Switch to **SysML** mode to read the complete matrix. Rows are actors as
   named by the model. Columns are rights, grouped by family: "Tools",
   "Admission", "Mandate & operators", "Model", "Memory & skills", "Exposed
   behaviors". The table scrolls horizontally. Until the matrix is read, the
   overview remains displayed.
6. Read a dot: filled, "allowed"; half, "can propose, a decision follows"; ink
   ring, "inherited"; pale ring, "not allowed"; alert ring, "allowed, of no
   use". The legend below the table lists them.
7. Selecting a dot opens the cell's details below the row: the family, right,
   actor, then "State", "Basis", "Rule", "Applied at", "Uncertain", and "Codes"
   when they exist. "Declared by" lists links to the model files, at the line
   declaring the rule. These details close like the others.

A matrix without actors or rights says "No rights declared". A sentence below
the table says which version the rights belong to and that pending proposals are
not counted. The other limits are in the legend's tooltip.

### Measure the work: Performance

1. Open **Performance**. In a Request it measures that Request; on the main
   system it measures the Main. While the measurements are read, the page says
   “Reading measurements…”. If they cannot be read, it says “Measurements
   unavailable”, with the reason in the tooltip.
2. Read the two headline figures. **Duration** runs from the Request's opening
   to its closing, and reads `N/A` while it is open. **Tokens** adds input,
   output and cache tokens, with the number of calls and the mean per call. The
   main system has no duration.
3. Read the facts under them: the share of input read **from cache**, the
   **failed calls** (failed or timed out), and, in a Request, **your messages**
   and **your decisions**, which count what you sent after the opening message
   and the cards you accepted or declined.
4. Read **By agent**: one row per operator, with its calls, tokens, tokens per
   call and cache share, most calls first. The name links to its profile in
   Team. Calls whose operator is no longer in the team read “Former member”, and
   calls with no operator link read “Unattributed”. Past twenty rows, **Next**
   and **Previous** turn the pages.
5. Open **Details** for the tokens by kind, the provider time summed (calls can
   overlap, so it is not the duration) and the model version read.

A figure that is defined but lacks data reads `N/A`, with the reason in its
tooltip; `N/A` is never zero. Totals are a minimum: calls that cannot be linked
to the scope are not counted. The page does not judge a Request: it has no
verdict. Definitions are in the
[Desktop and Cases reference](../../reference/atelier/bureau-et-cases.md#performance).

### Read the model's findings: Diagnostics

1. Open **Diagnostics**, in a Request under **More**. It lists the model
   findings of the exact version System shows. Main and Request scopes stay
   distinct.
2. Read **Findings**. Doctor and SHACL findings form one list, sorted by
   severity: each row has its severity, its message, the element it concerns (a
   link to Explore) and, when known, `file:line:column`, a link to that line in
   Files. Findings that are exactly identical in both checks appear once.
   **Finding details** gives the code and the checks that reported it. The list
   shows 25 findings; **Show more findings** reveals more.
3. Open **Checks** to see whether Doctor and SHACL were read for this version. A
   check that cannot be read says so, and the page notes “Partial checks: the
   count covers only available results.” It never borrows Main's report or shows
   zero in its place.
4. **Masked findings** keeps the findings that a Doctor mask hides from
   attention. A mask hides a finding; it does not resolve it. **Related
   attention** lists Rights and other System items, with an **Inspect** link. It
   is another view, not an additional total.

The page is read-only: it adds no repair or masking command. A new system starts
without a Doctor warning.

## Read the Model place

The tabs are **Activity**, **Revisions**, **Files**, **Releases**, and **SysML**
([`desk.ts:74`](../../../frontend/lib/workbench/desk.ts)). Activity opens first.
An address with `?commit=` or `?proposal=` opens Revisions on that revision. The
former `?page=graph` address opens SysML. An address with
`?modelVersion=commit:…` reads that source commit there. Numeric revision links
`?revision=N` keep the historical execution graph; they are not included in the
usual tabs.

In a Request, Model offers only **Files**, **SysML** and **Releases**, on the
Request's own branch. The other pages say “This view is unavailable for a
Request branch.”

### Follow activity: Activity

1. Open **Activity**. Rows are grouped: "Waiting for you" (proposals being
   prepared, awaiting a decision, or being accepted), "Accepted" (main commits,
   newest first), and "Declined". An empty group is not drawn. With nothing to
   show, the page says "No activity yet."
2. Read a row: the state, title, author ("proposed by …", "proposed by …,
   accepted by …", or "admitted by …" for a commit without a proposal), age,
   commit code, "main", "preparing", or "accepting" indicators, and the size "+n
   −m · k files".
3. Selecting a row opens its revision below; selecting it again closes it. An
   adjustment in progress preserves its text and resume state across refreshes
   and the proposal's prior rejection.
4. Read the list of affected files: for each, what happened to it ("added",
   "changed", "removed", "renamed"), its path, and the lines added and removed.
   The path is a link to the file in Files, as it is after the change. A deleted
   file has no link.
5. Read the exact diff of `.sysml` files. **Unified** and **Split** change its
   layout.
6. For a proposal awaiting a decision, use **Accept** or **Decline**. A proposal
   being prepared or accepted does not have these buttons. They only become
   active once the changes have been read and if no other decision is in
   progress, on a page or in chat. During submission, **Accept** says
   "Working…". A refusal appears above the diff: the page's message, such as
   "The decision was refused. The history was read again; review it before
   deciding again.", followed by the host's response. The effects of a decision
   are described in
   [propose, compare, and adopt a revision](../evolution/reviser-systeme.md).

When the history is truncated, the page says "Older commits are not shown."

### Examine a revision: Revisions

1. Open **Revisions**. The left column has two tabs, **Commits** and
   **Proposals**, and shows one list at a time. The number on **Proposals**
   counts proposals awaiting a decision.
2. Select a row. Without a selection, **Commits** opens the head of main, and
   **Proposals** opens the first proposal awaiting a decision, otherwise the
   first in the list. Each row is a link: the revision has its own address.
3. Read the details on the right: the title, author, age, commit code (the full
   identity is in the tooltip), size "+n −m · k files", and the exact source
   diff, preceded by its file list. For a proposal, the code is its base ("Base
   commit"). A commit is read against its first parent, a proposal against its
   base. For the list of affected files with links to Files, open the same
   revision in Activity. The initial commit (without a parent) presents only Git
   counters and a bordered file list: each name opens Files at that version. It
   neither loads nor displays the full source additions and has no "View diff"
   button. Other commits keep their diff.
4. Read a proposal's indicators. When accepted, it carries "merged as" followed
   by the commit code, which is a link. While being prepared, it says "The
   operator is still preparing this proposal."; while being accepted, "This
   proposal is being accepted." When declined, it says "Reason:" followed by the
   reason, when one exists.
5. Decide a proposal awaiting a decision with **Accept** or **Decline**, under
   the same conditions as in Activity.

If nothing changes in the sources, the page says "No source changes." A revision
missing from the loaded history says so: "This revision is not in the loaded
history.", or "This revision is older than the N latest commits."

### Put the accepted model in service: Put in service

1. Open **Revisions**, **Commits** tab, and look for the control below the head
   of main's row. It only appears if, for at least one operator, the available
   executable contract differs from the one in service (`adoptionOffers`,
   [`history.ts:101`](../../../frontend/lib/model/revisions/history.ts)). The
   number on the **Commits** tab says how many operators are behind.
2. With one affected operator, its name is displayed. With several, select one
   from the **Operator** menu.
3. Click **Put in service**. The tooltip says, for example, "Puts a1b2c3d in
   service for Main Operator" (short commit code, operator name). The button
   says "Working…" during submission. It is inactive while an operator is
   working (tooltip "An operator is running") or another decision is in
   progress.
4. Check the result using the "running" indicator on the commit's row: the
   tooltip names the operators running it.

A refused adoption is reported below the button: the page's message, then the
host's response. An operator whose runtime could not be read is named there. The
routes are described in
[Revisions and history](../../reference/evolution/revisions-et-historique.md).

### Read files: Files

1. Open **Files**. The page says "Reading the files…", then displays the version
   line, as in System, and the file tree on the left: the root first, then each
   directory. Names omit their `.sysml` extension.
2. Selecting a file opens it on the right (`?file=<chemin>`). Without a
   selection, the first file in the tree opens.
3. Read the header: the path, then the file's latest change (message, commit
   code, age). It is a link to that commit in Revisions.
4. Read the text colored by the Toolkit, one source line per row. Keywords,
   types, comments, strings, and numbers are distinguished; the text remains
   readable without color if tokens are unavailable. Selecting a line number
   highlights it and adds `?line=<n>` to the address; selecting the same number
   clears it.

Beyond 2,000 lines, the page only draws a window and says so: "Lines A–B of N".
Away from the start of the file, the **First lines** link returns to the
beginning ([`files.ts:132`](../../../frontend/lib/model/sources/files.ts)). A
file missing from the version says "… is not in this version.", an empty file
"This file is empty.", a version without files "No files in this version." A
rejected version is reported as in System, with **Show current model**.

### Create and inspect a release

A Release keeps one exact source version so that a Request can start from it.
Publishing and starting a Request are separate. The publication badge says that
the tag and source were retained; it does not claim that a Request can start.
Selecting a Release runs the server's read-only inspection of its exact source,
assets, skills and host. Only a Release that a Request can start from shows
**Ready** (a check mark in its inspection, and “Ready at last check” in the
tooltip). **Ready** is a reading, not a grant: opening a Request rechecks
current conditions and authority, and asks for no second approval.

1. Open **Model → Files** and check the displayed branch and exact version. The
   **Releases** panel on the right offers **Create release** for an eligible
   source. The action is also available from the Releases catalogue and, in a
   Request, from its header.
2. A Release needs a tag on that exact commit. If there is none, choose **Create
   tag**, enter a **Tag name** (a valid Git tag name) and choose **Create tag**
   again. This tags the source only: it publishes no Release and changes nothing
   in service. In a Request, only its current admitted version can be tagged.
3. In the form, check the source, choose the tag under **Existing tag** (the
   list holds only the tags that point to that exact source), then enter the
   release **Title** and optional **Notes**. Opening the form or refreshing its
   lists creates nothing; choose **Create release** to submit.
4. The tag and the source stay fixed to the selected commit if the branch
   advances. The tag does not switch a running model or confer execution rights.
   Inspect the result and its asset and tag availability separately. A tag moved
   or deleted outside Assembly is reported as unavailable; Assembly does not
   silently follow it to another commit.
5. If an acknowledgement is lost, the original source, tag and details remain as
   an unconfirmed intention (**Not confirmed**). Reopening the page does not
   submit it again: use **Retry release creation** on the same source. When a
   matching terminal response reports that a tag is unavailable, that failed
   attempt remains visible and the page permits a new attempt with another tag.
   After an acknowledged creation whose retention is incomplete, **Retry
   retention for this release** reuses the original request.
6. Select a Release in the catalogue to inspect its source and retained
   contents. The inspection lists its operators by name, what it needs (skills,
   a tool sandbox, private resources) and, under **Details**, the exact
   identities. When it is **Ready**, **New Request from this Release** opens
   Requests with it preselected under **Start from**. Historical untagged
   Releases remain readable as recorded; no tag is invented for them. Older
   runtime captures remain identified separately.

Main supports eligible exact admitted versions. A Request can retain its current
admitted source even while its runtime executes an older version, under current
authority and source visibility. **Keep in Dock** on a Case only keeps its Dock
tile visible. A fresh Request selects a retained Release with **Start from**; a
default Release selection is not connected.

### Read diagrams: SysML

1. Open **SysML**. The page reads the model's views, then the selected diagram.
   The selector groups them by structure, action flows, state machines, declared
   views, and general definitions. A version without views says so.
2. Select a view. Drag the background to move around the diagram, use the zoom
   buttons and **Fit** to fit it in the view. Arrow keys move the view; `+` and
   `−` zoom, `0` fits it.
3. Use relationship filters to show or hide a family of lines. Double-click a
   block to collapse or expand its contents.
4. Selecting a node opens its inspector, properties, and relationships.
   **Source**, when available, opens Files at the line in the same commit.
   Escape clears the selection.
5. Copying the address shares the version (`?version=commit:…`), view
   (`?view=`), and element (`?select=`). **Show current model** returns to the
   head from a pinned commit. The System "In SysML views" chips are not yet
   available.
6. **SVG** downloads the displayed diagram, with its filters and collapsed
   contents. **PlantUML** requests the view's text only when opened; **Copy**
   copies it and **Download .puml** downloads it. **.sysml** downloads this
   version's sources combined into one file, in path order.

An action view may be missing branches or decision guards because of the
Toolkit. Check the sources or Flows to verify the declaration; the viewer does
not reconstruct these links.

## Find what is waiting and what happened: Activity

1. Open **Activity**. **Waiting for you** lists Main and open-Request decisions,
   one per row; its count matches the Dock badge.
2. Read a row: a dot, the text, the requesting operator, an arrow. The tooltip
   gives the text and operator.
3. Follow the row. "Review model proposal" leads to the proposal in Revisions.
   "Authorize reviewer creation", "Authorize operator creation", "Authorize
   model editing", and "Authorize mandate change" lead to the operator's Case or
   conversation. A native "Authorize tool:" admission opens the exact
   notification in **Model → Activity**; older instances without an operator
   catalog keep their conversation destination.
4. Decide where the row takes you.

The page says "Updating decisions…" during the first read and "Nothing to
decide" when nothing is waiting. If the queue could not be read, it says so with
**Try again** instead of claiming nothing is waiting. Before the session is
ready, "Connect to the system…" explains that the full queue and history cannot
be read.

**What happened** follows, newest first: opened and finished Requests with their
Branch Operators, dated decisions and operator handoffs, proven member
creations, and retained Releases. **Details** exposes identities, full reports
and receipts. The first 30 events are shown; **Show more** reveals 30 more.
**Read again** refreshes the catalogues, Request conversations and visible
decision statuses. Events without a recorded date or sufficient proof are
omitted. Partial reads and truncated model history are reported.

Main keeps the conversation, human decisions, unresolved escalations and
abandoned Request reports. Routine completion notices and member returns appear
in Activity. Already decided human cards remain folded in Main. Model > Activity
continues to show the model's version history.

## Follow the model head live

The host announces when the head of main advances, when a proposal is made or
decided, and on every connection. Pages follow this announcement without
reloading.

- System pages reread the board at the new head. The old one stays displayed
  until the response, and the version line changes. The Rights matrix follows:
  it is read for the board's commit.
- If a System page fails to reread, the page keeps what it was showing and says
  why alongside it, with the host's code and instruction when provided. **Try
  again** rereads; it waits for the delay the host requests (**Try again in N
  s**). It is absent when rereading cannot change anything, for example for a
  rejected version.
- Model > Activity and Revisions reread model history; Files rereads the head's
  file list, and SysML its views. Dock Activity rereads only the source that
  changed: model history when the Main head advances, Releases on catalogue
  invalidation. Existing Request snapshots are reused; a newly discovered
  Request is read once, and a new authority notice rereads that Request only.
- For System, Model > Activity, Revisions, Files, and SysML, a decision made
  elsewhere (in chat, for example) has the same effect as an announcement.
- A version named in the address (`?version=`) never moves: a commit does not
  change.

## What this guide does not cover

Building blocks in System and the Activity health group are not yet in the
interface. The Toolkit view and attention routes available on the host are not
enough to make them usable from these pages.
