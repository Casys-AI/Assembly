# Why System, Model and Activity are separate places

The three places provide three ways to read the same system. **System**
describes the model at a commit: team, capabilities, flows, requirements and
rights. **Model** shows the sources versioned in Git, proposed changes and their
adoption for execution. **Activity** gathers items awaiting a decision, links to
where they can be decided, and lists recorded events below them. The Dock badge
counts only the waiting queue, including open Requests. Model > Activity remains
the version history of the model. This separation helps readers understand the
system without confusing its model, history and pending work.

The [places guide](../../how-to/modeles/parcourir-system-et-model.md) describes
the interactions and addresses. The
[projection reference](../../reference/modeles/projections-du-modele.md)
describes their data. This explanation covers the shared rules of the pages and
the scope rule below, which governs System and Model.

<a id="selected-system-scope"></a>

## Selected system, Main and Branch Operator

This contract replaces the earlier reading of a workbench as one shared model. A
Case's principal is named by its role, never resolved from a display name, and
its Main reference and rights are never borrowed from the Case's model. Dated
reports retain their original evidence and scope.

System always describes the currently selected system. A selected Case means
that Case's branch and resolved source version; global context means `main`.
Model uses that same explicit branch/version context. Missing scoped data stays
unavailable. Conversation selection, inspected source, admitted source and each
runtime's execution pin remain distinct; choosing a conversation or inspecting a
version neither adopts it nor silently replaces the selected branch.

The principal instance in a non-main execution space
(`executionSpaceId != "main"`) is the **Branch Operator (BO)**, the isolated
root of that branch. Identify the instance by project, system, execution space
and operator ID. Do not match “Main”, “Operator” or any custom name to determine
its role, and do not rename persisted/model identities. The interface names the
Branch Operator with a two-word name drawn from its Case; a custom name from the
model is kept. Additional suboperators retain their own identities; the scope
rule does not turn every branch member into its principal.

There is one global **Main Operator (MO)** in Main's execution scope. In a
Case's Team graph, it is a muted, read-only external node connected to the BO.
The node is a link to the main system. The reference is read from the actual
current main model, never from a reused component or name in the Case source. On
the main system, Team draws the BOs of the open Requests beside the MO, each
leading to its Request's Team. The same provenance rule applies in Rights:
Main's displayed rights come from Main's actual current model and controls,
separately identified from the branch's rights and version. If that Main read is
unavailable, show unavailable. This external reference does not merge Main into
the branch or create another MO. Following the link to the main system selects
Main for inspection; it grants no authority and changes no BO runtime pin.

A BO starts from its selected exact model/Release and may independently evolve
its branch through the governed software-evolution path. Its source, admitted
model and executed model may diverge from Main and from one another. Main's
current source is not a template to silently overwrite that branch. The MO/BO
relationship describes roles and routing; it grants neither actor automatic
control of the other. An approval or delegation must prove the actual actor,
current mandate, exact act, target and scope at the effect boundary. A BO → MO →
human escalation is available only through that verified routing and delegation,
not from parentage or a graph edge. Declared rights remain distinct from
evaluated effective access.

A Main-versus-BO rights comparison describes those two named versions. It is not
a list of all changes made by the Case: a branch opened from an older Release
can already differ from today's Main before any local edit. Establish Case-local
changes from its exact birth baseline, admitted source history and relevant
receipts, while showing execution/adoption separately. Unknown baselines or
unavailable evidence stay unknown.

System's board and ordinary Rights projection read the selected commit through
the typed projection. A pending proposal does not change the admitted source.
Cross-space runtime readouts are separate data: they do not become a union of
source graphs or relabel instances as executing the displayed commit. Existing
read APIs may supply the Main reference and other required facts to the current
Team/Rights surfaces. This contract authorizes no additional roster or “Operator
supervision” panel.

The **Readable / SysML** switch changes how the same elements are named. It
belongs to the reader: the choice is stored in the browser under
`assembly:view:mode`, never in the model or address. The System frame only
displays it on the pages that use it (Explore, Flows, Requirements, Rights,
Parts and Allocations); Team, Performance and Diagnostics have no inactive
switch. The placement of this control remains a design decision.

## Detail stays close to its object

The pages follow the rules adopted for the shared frame:

- Show information on the object concerned; keep exact text in the detail or
  tooltip, without adding a systematic explanatory banner.
- Leave space between objects instead of adding effects.
- In System lists, open a single detail directly below the selected item. The
  SysML diagram uses a node inspector beside the drawing.
- Keep the title in the same position whether the page uses a column, the full
  width or the entire panel.
- Attach state to its object: `main` and `running` on the commit, proposal
  counts on their tab, Accept and Decline on the proposal.
- Name a version once, as a readable pill (Main with its date, a Request, a
  Release) with its status; exact commits, digests and identifiers stay in its
  inspection.
- Only display a control when it has an effect on the page.

[`PageFrame`](../../../frontend/components/view/PageFrame.tsx) and
[`PageNav`](../../../frontend/components/view/PageNav.tsx) implement this frame.
Tabs are links and expose their active page through `aria-current`. Shared
styles are grouped under `.view-page` in `view.css`. A detail inserted in a list
keeps its `<li>` item; it is not an unrelated block directly below `<ul>`.

Only the displayed page is mounted. In
[`ModelSpace`](../../../frontend/components/model/ModelSpace.tsx), the
historical graph only opens its stream for a numeric execution revision; SysML
reads the list of views and then the selected diagram. Files and Revisions read
their data when opened. The same rule in System prevents a heavy read or graph
from continuing to work for a hidden page.

Team calculates positions through a deterministic simulation: fixed starting
positions, random source and number of iterations in
[`layout.ts`](../../../frontend/lib/system/team/layout.ts). Selecting an
operator does not restart placement. Node dragging uses the page's pointer
events, without `d3-drag` or `d3-zoom`.

## Showing a declaration does not prove its execution

Requirements says that a requirement is **declared satisfied** by a model
element. Its markers never say it has been tested: the board does not carry that
evidence. Likewise, Rights describes the commit's rights; execution still passes
through the host's controls.

SysML shows diagrams projected by the Toolkit and laid out with ELK, loaded on
demand. The selected view, source version and selected element have an address;
filters and collapsed sections remain diagram-reading choices. The inspector
leads to sources from the same commit. SVG exports, on-demand PlantUML and
`.sysml` exports do not modify the model.

The Model tabs are Activity, Revisions, Files, Releases and SysML; in a Request,
only Files, SysML and Releases. The earlier `?page=graph` address opens SysML;
`?modelVersion=` reads the named source commit there. Numeric `?revision=N`
links retain the historical execution graph under the active SysML tab. Removing
this compatibility remains open.

Building blocks, the Activity health group and the System “In SysML views” chips
remain open. The element → views index required by these chips is not served
yet.

## Accepting a design and putting it into service

In Revisions, a commit is compared with its first parent and a proposal with its
base. The page no longer offers free-form comparison or a semantic diff. These
readings remain available through the
[revision and history APIs](../../reference/evolution/revisions-et-historique.md).

**Accept** decides a source proposal. The response may report
`executionAdopted: false`: accepting does not implicitly adopt the contract for
all operators. The **Put in service** control, below the `main` commit, makes
this second step visible.

The `running` marker is specific to each operator and comes from
`runtime.active.repositoryVersion`. Adoption concerns operators that own a
runtime; `runtimeOwned: false` excludes them. A read-only peer session may still
own a runtime. The page therefore does not reduce this rule to a read-only/write
distinction.

Chat, Cases, Activity and Revisions reuse the
[`ModelChangeView`](../../../frontend/components/model/changes/ModelChangeCard.tsx)
presentation. Commands remain specific to their context: the chat card also
offers **Adjust**, while Revisions exposes **Accept** and **Decline**.

All decision commands share the same
[`DecisionLock`](../../../frontend/lib/model/sources/command.ts): proposal,
adoption, tool admission and mandate changes. While a command is in flight,
another decision control must not act. This explains a temporarily inactive
Accept button even when the current command comes from chat.

The pages do not write SysML themselves. Accept, Decline and adoption go through
the host's commands; any future graphical editing must follow the same boundary.
Activity remains an entry point: its row leads to the proposal, Case or
conversation that carries the decision.
