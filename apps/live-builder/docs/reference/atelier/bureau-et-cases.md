# Desktop and Cases

Code state as of 25 October 2026, base `73b3ed6`. This reference comes from
reading the components and their contracts; it does not replace a visual test or
qualification of the planned envelopes.

Case is the common type for Requests, Jobs and Watches. The **Requests** button
and page show only Cases of type `request`; **Jobs** and **Watches** have their
own stacks. Routes and technical identifiers keep the name `cases`.

## Navigation

### Current three-state navigation — 30 October 2026

The current local implementation supersedes the older baseline below where
visibility/layout differ. Full Main or full Request → System/Model opens split
with the same conversation. In split, its selected Dock tile hides chat and
retains the exact scoped page at available width; another conversation switches
context while retaining that page. In page-only, any conversation tile opens
full conversation. `conversation=hidden` is System/Model display state only,
inherited by internal links and cleared on entry from full chat. It grants no
source or execution right. Same-context toggles preserve
source/version/inspection/agent; context changes keep existing governed
source-selection rules.

Full-page Main uses the existing ChatView at full height, in a central column
comparable to Cases with reserved side areas (latest explicit user correction;
final browser qualification pending). Split mode is unchanged. Request selection
is parked across page-only and Main navigation so its draft/scroll subtree is
retained; a full side-agent conversation does not also reveal Main from stale
local talking state. The Dock keeps its +N pile for surplus capacity only and
recalculates actual usable width on growth/shrink, preserving focus during
moves.

Local evidence: `apps/live-builder/.data/ux-readiness-frontend-reviewed.log`
passes 75 combined cases, including 50 Workbench and eight context cases with
the mounted parking-state correction; `ux-dock-focus.log` separately passes 14
Dock cases. These are bounded automated selections, not proof of actual browser
dimensions/scroll or whole-MVP acceptance. ROOT subsequently observed Main
split/page-only/full, Request draft preservation across full Main, and 400px
Dock capacity growing from two tiles/two piled to all four fitting. The UX
qualification of 30 October 2026 records those bounded browser checks; broader
source/subagent/viewport cases remain separate.

| Address                            | Content                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `/cases`                           | Request list, Open groups followed by Done.                                            |
| `/cases?case=<id>`                 | Conversation of this Request's owner.                                                  |
| `/cases?case=<id>&agent=<agentId>` | Exchanges of a sub-agent that participated in the Request; otherwise, the main thread. |
| `/chat`                            | Main operator conversation.                                                            |
| `/chat?case=<id>`                  | Job or Watch detail beside the conversation; a Request goes to `/cases`.               |
| `/chat?case=new`                   | Requests page with no selection, ready for a new request.                              |
| `/system` and `/model`             | System and Model places; their `page` parameter selects the page.                      |
| `/decide`                          | Pending decisions.                                                                     |

`/revisions` opens the Model place. `/tools` opens the central conversation's
tools. The [related guide](../../how-to/modeles/parcourir-system-et-model.md)
describes the System and Model pages in detail.

Sources: [`desk.ts`](../../../frontend/lib/workbench/desk.ts),
[`Workbench.tsx`](../../../frontend/islands/Workbench.tsx).

## Dock and local preferences

The Dock places pinned Cases and open Requests to the left of the agent button.
Older Requests group together when width is limited. To the right are the Jobs
and Watches stacks, then System, Model and To decide. The To decide count comes
from pending decisions that have a destination the user can open.

A closed Request stays in the Dock only if pinned. The “24 hours” wording still
present in some comments is not the rule for composing tiles: `work` uses open
Requests and pins. Narrow-window Dock verification remains open in the UX plan.

Pins are stored under `assembly:pins:<systemId>` in the browser's
`localStorage`. The older `ase:pins:<systemId>` value is copied when the
canonical key is absent; the old key is retained. Seen-Case preferences use the
same compatibility rule for `assembly:seen:<systemId>`. If that storage is
unavailable, they last until the page reloads. They write neither SysML sources
nor mandates.

`Control+Shift+D` focuses the disc; it does not send a message. `Escape` closes
the top layer, then returns focus to its trigger. The Assembly menu exposes
About and read-only provider information. Switch system and Settings are
disabled. The title bar shows the connection status during reconnection or
disconnection.

Sources: [`Dock.tsx`](../../../frontend/components/workbench/Dock.tsx),
[`pins.ts`](../../../frontend/lib/workbench/pins.ts),
[`AppMenu.tsx`](../../../frontend/components/workbench/AppMenu.tsx).

## Request list, conversation and agents

The list contains only Requests, sorted newest first within Open, then Done.
`caseTitle` derives the name from the objective's first sentence, removes
recognized opening phrases and cuts at a word boundary. The internal identity
remains the `caseId`.

A solid dot means a pending decision or activity since the last read. **needs
you** concerns only the decision attached to the Case. For an older decision
with no recorded origin, association by operator is used only if that operator
has a single open Case.

A Branch Operator's request is also relayed in the Main Operator's thread, under
its notice, as the Case's own card: it names the Branch Operator and decides
through the same command and API as the Case card, so a decision on one shows on
the other after refresh. When the Main Operator decides it under its mandate,
the relayed card shows the status only. One card is shown per change, on its
latest notice; non-network kinds keep the Case card's "not available here"
message.

The tree always keeps the owner at its root. Sub-agents attach to the caller of
their first delegated message; with no known caller, they attach to the root.
Cycles are cut, and siblings follow the order of their first contribution. Only
messages correlated with the Case are read. A sub-agent thread has no composer,
but may display a decision card requiring action; it therefore does not
guarantee an absence of actions.

The agent panel itself is read-only: mission, Mandate, Tools grouped by server,
and Skills when the catalogue is available. The Case header shows the budget
only if `workBudget.scopeId` matches its budget. Close requests the `done`
outcome. A closed Case no longer shows a composer.

Sources: [`CasesPage.tsx`](../../../frontend/components/cases/CasesPage.tsx),
[`tree.ts`](../../../frontend/lib/cases/tree.ts),
[`AgentPanel.tsx`](../../../frontend/components/conversations/AgentPanel.tsx),
[`pending.ts`](../../../frontend/lib/decide/pending.ts).

## Reading and commanding Cases

The [Cases contract](../operateurs/cases.md) describes the backend rules. This
section specifies how the desktop consumes them.

| Frontend call                                   | Body or result                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /api/cases`                                | Collection `{systemId, cases}`.                                                           |
| `GET /api/cases/:id`                            | Case detail, including a Case absent from the current collection.                         |
| `POST /api/cases/:id/close`                     | `{"outcome":"done"}` or `{"outcome":"abandoned"}`; the Request interface requests `done`. |
| `POST /api/cases/:id/run`                       | `{}`; the Job's Run now action.                                                           |
| `POST /api/cases/:id/pause`, `/resume`, `/stop` | `{}`; Watch commands.                                                                     |
| SSE `cases` event                               | New read state for Cases.                                                                 |

The parser checks known types and enumerations, ignores extra fields and drops a
malformed entry without hiding the others. Duplicate identifiers, or duplicate
numbers for the same owner, cause the whole collection to be rejected.

The contract carries no server revision number. Reads are ordered when they
start and events when they arrive; a response older than the latest accepted
state is ignored. A `404` on the collection means that this backend does not
provide Cases: the desktop keeps the operator conversations. A `404` on a detail
means Case not found. The store does not run two closures simultaneously, or two
scheduled actions simultaneously. Domain rules are still checked by the server.

Sources: [`cases.ts`](../../../frontend/lib/cases/cases.ts),
[`cases_test.ts`](../../../frontend/lib/cases/cases_test.ts),
[`cases.ts`](../../../src/adapters/in/http/work/cases.ts).

## Jobs and Watches

`CaseView` reads the Job's `steps` and `runs`, and the Watch's state,
`nextWakeAt` and `wakes`. The run, pause, resume and stop commands are connected
to `state.cases.act`. Job judgment buttons remain disabled because the Workbench
does not provide `CaseActions.judge`.

A Job's recent runs are limited to twelve marks. A Watch's band shows at most
twenty-four wakes; the list groups unchanged wakes and keeps each change
separate. Data comes from the server, not interface fixtures. This code's
presence does not lift the product freeze on Jobs and Watches or their
qualification reservations.

The “Rules of” title uses the Case's creation date; its creation version is
available in the tooltip. This provenance does not guarantee a fixed execution:
adoption replaces the runtime contract, including for open Cases. See the
[Cases reference](../operateurs/cases.md) for the distinction between creation
provenance and the current admitted model.

Source: [`CaseView.tsx`](../../../frontend/components/cases/CaseView.tsx).

## Retained limitations

The backend does not yet expose an operator's actual current Case to the roster.
A `busy` state therefore remains **Working**, and can make several tiles for the
same owner look busy. The `agentActivity` presentation function can name a Case,
but the Workbench provides none when the agent is working.

Model diagnostic surfaces, response traces, per-agent budgets, the system
manager and the choice between two presentations are still planned. Publication
of delegation policies for the Main Operator remains to be connected.

### Current MO/BO scope clarification — 31 October 2026

This owner correction supersedes the 30 October generic “Operator” label rule.
“Main Operator” denotes the unique global actor in Main. A Case's principal in
`executionSpaceId != "main"` is **Branch Operator**, its isolated branch root;
the role never comes from matching a name. Preserve custom/model names and
persisted identities. Other branch members keep their own roles and identities.

System follows the selected system, so a Case page describes its branch. Team
connects BO to a muted, read-only external Main reference and **System main**
link; read that reference and Main's rights from the actual current main model,
never a branch copy. Missing Main evidence stays unavailable. BO may evolve its
branch independently through the governed software-evolution path. No
relationship or graph edge grants approval or delegation: current
actor/act/target/scope proof remains necessary. Main-versus-BO rights
differences are not all Case-local edits when its birth Release predates Main;
use that exact baseline and admitted history. See the
[canonical scope contract](../../explanation/modeles/pages-system-et-model.md#selected-system-scope).
This clarification establishes no new execution or browser qualification.
