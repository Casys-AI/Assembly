# Browse the System and Model places

This guide is for people using the workshop. It shows how to read the admitted
SysML model in the System place, its history in the Model place, and what awaits
a decision in the To decide place. It assumes that a system is running and its
interface is open: see [start a system](../atelier/demarrer-un-systeme.md).
Labels match the interface and are in English. Things you click are in bold.
Text displayed by the page is in quotation marks.

System pages do not change anything. In Model, **Accept**, **Decline**, **Admit
and integrate**, **Adjust**, and **Put in service** act on the host when the
card offers them. To decide makes no decisions: each row leads to the page where
you decide.

## Open a place

1. In the Dock, at the bottom of the screen, find the three tiles to the right
   of the logo: **System**, **Model**, and **To decide**.
2. Clicking a tile opens the place in the main panel. **To decide** shows the
   number of items waiting. **Model** shows an indicator when a proposal is
   waiting.
3. Clicking the tile again, or the panel's close button (tooltip "Close System",
   "Close Model", or "Close To decide"), closes the place. **System** reopens on
   Team. **Model** reopens on the last page read, with its revision or file.
4. Switch pages using the tabs at the top of the panel. Each page has its own
   address, such as `/system?page=rights` or `/model?page=files`. Team and
   Activity use the bare address (`/system`, `/model`). `/revisions`, Model's
   former address, still opens Model.
5. Copying the address shares the view. In System, it carries the open element
   (`?select=`) and the version being read (`?version=`). In Model, `?commit=`
   or `?proposal=` opens Revisions on a revision; `?file=`, `?line=`, and
   `?version=` control Files. A tool proposal in Activity carries `?operator=`,
   `?candidate=`, and `?digest=`; these three identities open that operator's
   exact candidate.

### Identify the conversation and version being viewed

**30 October 2026 navigation update:** System/Model support split and page-only
views. A selected conversation's Dock tile hides the split chat without changing
its scoped page/inspection; a conversation click from page-only opens full chat.
A different conversation clicked in split changes context while retaining the
right page. Internal links preserve `conversation=hidden`; full-chat entry opens
split. Full Main now fills its existing ChatView container like a Request. The
Dock keeps +N only for actual capacity overflow and recalculates on growth and
shrink. These are locally implemented and tested changes, with ROOT's bounded
Main/Request/draft/Dock browser observations recorded in the UX qualification of
30 October 2026; other historical/subagent/viewport paths remain separate. See
the
[dated navigation guide](../atelier/parcourir-le-bureau-et-les-cases.md#keep-a-conversation-beside-system-or-model).

**Current scope rule — 31 October 2026:** System and Model describe the
explicitly selected system. A selected Case means its own branch; global context
means main. Selecting the Main conversation while keeping a Case view open does
not silently replace that view's branch. Read the page's branch and version;
Dock monograms are secondary context cues. The conversation on the left,
including a selected suboperator, keeps its own identity and execution pin.
**Open full Request** restores its agent tree and details panel.

In a Case, its principal is **Branch Operator (BO)** because it runs in that
non-main execution space, regardless of the name retained in its source model.
Team connects BO to a muted, read-only external **Main Operator** reference.
**System main** explicitly opens the actual current main system for inspection.
The branch's Main reference and Main rights must come from that actual model,
with their own source version. Unavailable Main reads stay unavailable. A Main
reference or graph connection grants no approval authority. See the
[scope and evidence contract](../../explanation/modeles/pages-system-et-model.md#selected-system-scope).
These are the current owner rules; the dated browser evidence above covers only
the paths it actually exercised.

An explicitly selected source version is read-only. Outside Release creation,
the inspection banner offers a return to the current model without changing the
conversation or adopting the inspected version. During Release creation, the
exact selected source stays fixed: the title identifies it as current or
historical only when the current source has been read. If that comparison is
unavailable, the source is identified without guessing. A proven historical
selection keeps the inspection notice. Historical Activity and Revisions views
that cannot be read at that source version show an unavailable message and an
**Inspect Files** link; they do not present current activity as historical data.
Revisions' existing commit-detail links remain available.

A Request uses its resolved branch and exact version when its scoped reader is
available. If the scoped reader is unavailable, System and Model say so rather
than showing main under the Request's name.

## Read the System place

### Diagnostics

Open **System > Diagnostics** to inspect existing Doctor and SHACL findings for
the exact version shown by System. Main and Request scopes remain distinct;
missing or inaccessible reports show unavailable rather than borrowing Main or
showing zero. Doctor and SHACL can overlap, so their counts are separate.
Severity/finding are textual; masked findings remain in a separate disclosure.
Known locations offer exact source links; no repair or masking command is added
by this read-only page. ROOT observed Main and Request reports; lower SHACL,
narrow layout and source-click browser checks remain open in the UX
qualification of 30 October 2026.

**Later 30 October owner steer:** the next bounded UI delta merges Doctor/SHACL
findings into one list, deduplicating only identical full diagnostic content;
producer provenance moves into details. Existing separate API reports and
unavailable/mismatch/unmapped indicators remain. The earlier browser screenshots
precede that delta. Product scope is desktop only; no mobile-product acceptance
gate is added.

The tabs are **Team**, **Explore**, **Flows**, **Requirements**, and **Rights**
([`desk.ts:8`](../../../frontend/lib/workbench/desk.ts)). The **More** menu
lists **Parts** and **Allocations**
([`desk.ts:17`](../../../frontend/lib/workbench/desk.ts)); it takes the page's
name when either is displayed.

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

1. Below the tabs, read the version line: the short commit code (its full
   identity is in the tooltip), then the "main" indicator when the address does
   not name a version.
2. If the model in service for the central agent is a different commit, the "In
   service:" indicator followed by its code is added. The page then describes
   something that is not yet running.
3. To read a past version, add `?version=` followed by `commit:` and the
   commit's 40 hexadecimal digits. Page links keep that version, and the **Show
   main** link replaces the "main" indicator.
4. A rejected version is reported as "This is not the identity of a version of
   the model." (malformed identity) or "This version is not in the model's
   history." (unknown commit). **Show main** returns to the head.

### Choose the wording: Readable or SysML

1. On every page except Team, find the **Readable** / **SysML** group to the
   right of the tabs.
2. **Readable**, the default choice, describes the model in everyday language: a
   unit carries the name the team gives it, an identifier becomes a phrase
   (`maxAgentDecisions` becomes "Max agent decisions"), and an element has an
   icon indicating its kind. **SysML** uses the model's terms: declaration
   keywords, types, identifiers, expressions, source file.
3. The choice stays in this browser, under the `assembly:view:mode` key (an
   older `ase:view:mode` value is copied only when the new key is absent)
   ([`view-prefs.ts:15`](../../../frontend/lib/system/view-prefs.ts)). It is not
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
   ([`element-detail.ts:242`](../../../frontend/lib/system/board/detail.ts)).
   The first three relationship groups are listed; "N more" opens the others. A
   group names eight elements, then "+N". Each referenced element is a link to
   its page. In an Explore column, the details are limited to the summary and
   action links.
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
2. Read the network. Each agent is a node, surrounded by what it uses: tools,
   skills, contexts, memories, information. A dark line connects "You" to agents
   that talk with you; "You" only appears if there is one. A light line goes
   from the agent to what it uses. A shared resource is a single node marked
   "×N". Nodes can be moved with the mouse.
3. Read the profile below the network. Selecting an agent (`?select=<id>`)
   changes the profile; without a selection, it shows the first agent that talks
   with you, otherwise the first agent. It says "Talks with you" or "Not in
   direct contact with you" when the model or runtime says so, and "working now"
   when the agent is working.
4. Read the profile sections: "Context", "Tools & skills", "Memory", "Mandate",
   and "Works on" (the flows it executes; absent if it executes none). A section
   the model does not declare becomes a dotted line saying so, such as "No
   memory declared".
5. Under "Tools & skills", read the "Servers" row: the tool servers the runtime
   provides to the agent, with their tool count (the list is in the tooltip).
   This appears alongside what the model declares, never in its place.

Beyond twelve agents, the agent list replaces the network, to the left of the
profile
([`TeamPage.tsx:18`](../../../frontend/components/system/team/TeamPage.tsx)).
With no declared agent, the page says "No agent declared". If the projector
could not place any, it says "No agent could be read". Host notes, with their
code and instruction, are also displayed: all of them below this message when
there is no agent, otherwise only warnings and errors above the page.

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

## Read the Model place

The tabs are **Activity**, **Revisions**, **Files**, **Releases**, and **SysML**
([`desk.ts:70`](../../../frontend/lib/workbench/desk.ts)). Activity opens first.
An address with `?commit=` or `?proposal=` opens Revisions on that revision. The
former `?page=graph` address opens SysML. An address with
`?modelVersion=commit:…` reads that source commit there. Numeric revision links
`?revision=N`, including those from chat, keep the historical execution graph;
they are not included in the usual tabs.

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
rejected version is reported as in System, with **Show main**.

### Create and inspect a release

**30 October 2026 presentation update:** publication and Request availability
are separate. The publication badge identifies the immutable creation/tag
result; it is not a fresh-opening approval or a complete-retention claim.
Selecting a Release runs the server's read-only exact-source/asset/skill/host
inspection. Only a ready result displays **Ready at last check**; absent or
failed inspection cannot remain green. Opening a Request rechecks current
conditions/authority. No second approval or catalogue-wide host probing is
introduced. Existing skill prerequisite metadata does not alone prove its local
bytes are missing. The code paths have focused qualification; ROOT also observed
one selected Main Release published and green Ready at last check without
retention retry or a second approval. The dated UX report records that bounded
result; readiness is still rechecked when opening.

1. Open **Model → Files** and check the displayed branch and exact version. The
   **Releases** panel on the right offers **Create release** for an eligible
   source. The action is also available from the Releases catalogue.
2. In the creation page, check the source and choose **Create a new tag** or
   **Choose an existing tag**. Existing choices are limited to available tags
   pointing to that exact source. Enter a valid new tag name if creating one,
   then enter the release **Title** and optional **Notes**. Opening the form or
   refreshing its lists creates nothing; choose **Create release** to submit.
3. A new Release requires a tag. The tag and the source remain fixed to the
   selected commit if the branch advances; the tag does not switch a running
   model or confer execution rights. Inspect the result and its asset and tag
   availability separately. An externally moved or deleted tag is reported as
   unavailable; Assembly does not silently follow it to another commit.
4. If an acknowledgement is lost, the original source, tag and details remain as
   an unconfirmed intention. Reopening the page does not submit it again: use
   the explicit retry on the same source. When a matching terminal response
   reports that a tag is unavailable, that failed attempt remains visible and
   the page permits a new attempt with another tag. Other uncertain errors do
   not automatically clear the original intention.
5. Select a Release in the catalogue to inspect its source and retained
   contents. Historical untagged Releases remain readable as recorded; no tag is
   invented for them. Older runtime captures remain identified separately.

Release creation belongs to **Model**. Main supports eligible exact admitted
versions. A Request can retain its unchanged eligible initial base (B0), subject
to current authority and source visibility. An evolved Request version (A1)
remains refused until its separate local-admission and provenance work is
qualified. A fresh Request can select an eligible retained Release through its
source selector; default Release selection is separate and is not connected.
**Pin** on a Case only keeps its Dock tile visible.

**30 October 2026, current implementation checkpoint:** the B0-only refusal
above records the earlier qualified baseline. The current source implements
Release creation from the verified current admitted Request source while its
runtime may execute an older version. It preserves exact tags, authority,
retention/prerequisite status and independent fresh-opening controls. Joined
native and A1 browser qualification remain pending; the older port-4399 browser
build and its successful Main-tag creation do not qualify this new path. No
acceptance or deployment is implied.

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
   (`?view=`), and element (`?select=`). **Show main** returns to the head from
   a pinned commit. The System "In SysML views" chips are not yet available.
6. **SVG** downloads the displayed diagram, with its filters and collapsed
   contents. **PlantUML** requests the view's text only when opened; **Copy**
   copies it and **Download .puml** downloads it. **.sysml** downloads this
   version's sources combined into one file, in path order.

An action view may be missing branches or decision guards because of the
Toolkit. Check the sources or Flows to verify the declaration; the viewer does
not reconstruct these links.

## Find what is waiting: To decide

1. Open **To decide**. The page lists items awaiting a decision, one per row:
   proposals first, then authorizations, then tools.
2. Read a row: a dot, the text, the requesting agent, an arrow. The tooltip
   gives the text and agent.
3. Follow the row. "Review model proposal" followed by the identifier leads to
   the proposal in Revisions. "Authorize reviewer creation", "Authorize operator
   creation", "Authorize model editing", and "Authorize mandate change" lead to
   the operator's Case or conversation. A native "Authorize tool:" admission
   opens the exact notification in **Model → Activity**; older instances without
   an operator catalog keep their conversation destination.
4. Decide where the row takes you.

The page says "Updating decisions…" during the first read and "Nothing to
decide" when nothing is waiting. If the queue could not be read, it says so with
**Try again** instead of claiming nothing is waiting.

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
- Activity and Revisions reread history, Files the head's file list, SysML its
  views, and To decide the queue.
- For System, Activity, Revisions, Files, and SysML, a decision made elsewhere
  (in chat, for example) has the same effect as an announcement.
- A version named in the address (`?version=`) never moves: a commit does not
  change.

## What this guide does not cover

Building blocks in System, search, and the To decide health group are not yet in
the interface. The Toolkit view and attention routes available on the host are
not enough to make them usable from these pages.
