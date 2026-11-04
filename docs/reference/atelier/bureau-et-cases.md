# Desktop and Cases

Code state as of 4 November 2026. This reference comes from reading the
components and their contracts; it does not replace a visual test or
qualification of the planned envelopes.

Case is the common type for Requests, Jobs and Watches. The **Requests** button
and page show only Cases of type `request`; **Jobs** and **Watches** have their
own stacks. Routes and technical identifiers keep the name `cases`.

## Navigation

The desktop has three states. Full Main or full Request → System/Model opens
split with the same conversation. In split, the selected Dock tile of that
conversation hides the chat and keeps the exact scoped page at the available
width; another conversation switches context and keeps that page. In page-only,
any conversation tile opens the full conversation.

`conversation=hidden` is System/Model display state only. Internal links inherit
it and entry from a full chat clears it. It grants no source or execution right.
Same-context toggles preserve source, version, inspection and operator; a
context change keeps the governed source-selection rules. Request selection is
parked across page-only and Main navigation, so its draft and scroll are kept. A
full side-operator conversation does not also reveal Main from stale local
talking state.

Full-page Main uses the same chat view as a Request, in a central column with
reserved side areas. The Dock keeps its +N pile for surplus capacity only. It
recalculates the usable width when the window grows or shrinks and keeps focus
during moves.

| Address                            | Content                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `/cases`                           | Request list, Open groups followed by Done, with the field that starts a Request.        |
| `/cases?from=<releaseId>`          | The same page, with that Release preselected in **Start from**.                          |
| `/cases?case=<id>`                 | Conversation of this Request's owner.                                                    |
| `/cases?case=<id>&agent=<agentId>` | Exchanges of a suboperator that participated in the Request; otherwise, the main thread. |
| `/chat`                            | Main operator conversation.                                                              |
| `/chat?case=<id>`                  | Job or Watch detail beside the conversation; a Request goes to `/cases`.                 |
| `/chat?case=new`                   | Requests page with no selection, ready for a new request.                                |
| `/system` and `/model`             | System and Model places; their `page` parameter selects the page.                        |
| `/activity`                        | Pending decisions, followed by recorded activity.                                        |

`/decide` redirects to `/activity` (308, query kept). `/revisions` opens the
Model place. `/tools` opens the central conversation's tools. The
[related guide](../../how-to/modeles/parcourir-system-et-model.md) describes the
System and Model pages in detail.

Sources: [`desk.ts`](../../../frontend/lib/workbench/desk.ts),
[`Workbench.tsx`](../../../frontend/islands/Workbench.tsx).

## Dock and local preferences

The Dock places pinned Cases and open Requests to the left of the operator
button. Older Requests group together when width is limited. To the right are
the Jobs and Watches stacks, then System, Model and Activity. The Activity count
comes from pending Main and open-Request decisions that have a destination the
user can open. The same queue is listed in Activity.

A closed Request stays in the Dock only if pinned. The “24 hours” wording still
present in some comments is not the rule for composing tiles: `work` uses open
Requests and pins.

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

## Request list, conversation and operators

The list contains only Requests, sorted newest first within Open, then Done.
`caseTitle` derives the name from the objective's first sentence, removes
recognized opening phrases and cuts at a word boundary. The internal identity
remains the `caseId`.

A row shows a dot, the title, a version pill, its age and a pin mark when
pinned. A solid dot means a pending decision or activity since the last read.
**needs you** concerns only the decision attached to the Case. For an older
decision with no recorded origin, association by operator is used only if that
operator has a single open Case.

Below the list, **Start from** selects the model of the Request about to start:
**Current Main**, or a retained Release from the **Releases** group. The list is
read again when the page opens and when the field takes focus. The selection
stays fixed while a message is being sent, and a failed inspection keeps the
previous choice. The `from` address parameter preselects a Release once, as a
person's choice would.

A Request's header shows its title, then **From Release …** when it started from
a Release, then a version pill. The pill reads “Request n” (“Request n ·
modified” once its branch moved from its base); its tooltip and inspection list
the exact identities. The header then repeats the objective when the title says
less, the status chip (Open, Waiting, Done or Abandoned) and the name of the
Request's operator. Its links are **View model**, **Create release** and a
**Keep in Dock** toggle.

The Request's operator is the **Branch Operator** (BO) by role, but the
interface names it with an invented two-word name drawn from the Case, on the
initials of its title. A custom name from the model is kept, and “Branch
Operator” stays in the chip's tooltip.

The tree always keeps the owner at its root. suboperators attach to the caller
of their first delegated message; with no known caller, they attach to the root.
Cycles are cut, and siblings follow the order of their first contribution. Only
messages correlated with the Case are read. A suboperator thread has no
composer, but may display a decision card requiring action; it therefore does
not guarantee an absence of actions.

The operator panel itself is read-only: mission, Mandate, Tools grouped by
server, and Skills when the catalogue is available. The Request header shows no
budget and no control to close the Request: a verdict bar and a Performance
verdict tile were removed on 3 November 2026. Archiving is planned. A closed
Case no longer shows a composer; one line takes its place, such as “Closed ·
accepted by you” when a verdict was recorded earlier, or “Closed · done” or
“Closed · abandoned”.

Sources: [`CasesPage.tsx`](../../../frontend/components/cases/CasesPage.tsx),
[`RequestSource.tsx`](../../../frontend/components/cases/RequestSource.tsx),
[`tree.ts`](../../../frontend/lib/cases/tree.ts),
[`AgentPanel.tsx`](../../../frontend/components/conversations/AgentPanel.tsx),
[`pending.ts`](../../../frontend/lib/decide/pending.ts).

## Conversation thread

One rule decides how a thread shows each message.

- **The person's messages** stay exactly as written.
- **Agents' messages** are read as Markdown by `marked` and built as elements,
  never as HTML. Tables, lists, quotes, code and emphasis are drawn. A link to a
  Request reads as a chip, and a link to a Diagnostics page of main or of a
  Request stays a link; any other link, image or raw HTML stays text as the
  operator wrote it. A message over 16,000 characters, or nesting quotes or
  lists more than 8 deep, stays plain text.
- **Host and tool records** in a row fold into one quiet line, “··· n steps”.
  Opening it shows each record's exact text, never interpreted. A fold ends at
  anything else and where the Case changes.
- **Work received and returned** between operators stays a message under “View
  received work” or “View returned work”.

The Main Operator's thread shows only what asks the person. It keeps the
conversation, human decisions, unresolved escalations and reports of abandoned
Requests. It hides work records and routine notices, such as completions and
members' returns; Activity lists those. The journal and the Main's model context
keep every record.

### Decisions

A change proposed to the model, a change of mandate or rights and a new team
member read in one vocabulary. Each decision is one entry, with one state:

| State          | Meaning                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| **To decide**  | Waiting for the person, or for the decider the route names. **Accept**, **Decline** and **Adjust** show. |
| **Applying**   | Decided. The chip shows three dots; its tooltip names the steps: Decided, Saved, In service.             |
| **Applied**    | Decided, saved and in service.                                                                           |
| **Declined**   | Refused.                                                                                                 |
| **Superseded** | A newer model overtook the proposal before anyone decided it.                                            |

While it waits, the card shows its exact `.sysml` diff folded under “SysML +n
−m”. Once decided, it folds to one line with its state. A **Retry applying** or
**Retry continuation** button shows only while the host still has a step to
take; its tooltip says why it cannot be used yet. The host's own statuses never
reach the page.

The card's byline opens an inspector with the exact identities: the change, its
Request, its commit and the authority facts. When a recorded receipt names who
decided, the byline reads “Decided by you · rule … · rev. n”, or names the
operator that decided under its policy. A receipt that does not bind to the
change names no one.

A new team member reads as the member: a monogram, its name, its mission on two
lines, then its rights as marks. They say that it works in this Request, which
hosts it reaches (or no network) and how many members it may create (or none).
Its byline starts with “New member”.

A Branch Operator's request is also relayed in the Main Operator's thread, under
its notice, as the Case's own card. It decides through the same command and API
as the Case card, so a decision on one shows on the other after refresh. One
entry stays per decision: the line and the card while it waits, then the card
alone, folded on its state. When a rule of the Main Operator's mandate covers
that Branch Operator, the Main Operator decides; Activity records the dated
handoff and outcome, while Main hides the informational notice. Non-network
kinds keep the Case card's “not available here” message.

Sources:
[`ChatTimeline.tsx`](../../../frontend/components/conversations/ChatTimeline.tsx),
[`MessageText.tsx`](../../../frontend/components/conversations/MessageText.tsx),
[`message-markdown.ts`](../../../frontend/lib/conversations/message-markdown.ts),
[`ToolSteps.tsx`](../../../frontend/components/conversations/ToolSteps.tsx),
[`decision-state.ts`](../../../frontend/lib/conversations/decision-state.ts),
[`ModelChangeCard.tsx`](../../../frontend/components/model/changes/ModelChangeCard.tsx),
[`OperatorNoticeRow.tsx`](../../../frontend/components/conversations/OperatorNoticeRow.tsx).

## Reading and commanding Cases

The [Cases contract](../operateurs/cases.md) describes the backend rules. This
section specifies how the desktop consumes them.

| Frontend call                                   | Body or result                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `GET /api/cases`                                | Collection `{systemId, cases}`.                                   |
| `GET /api/cases/:id`                            | Case detail, including a Case absent from the current collection. |
| `POST /api/cases/:id/close`                     | For a Job, `{"outcome":"done"}`; the **Close case** button.       |
| `POST /api/cases/:id/run`                       | `{}`; the Job's Run now action.                                   |
| `POST /api/cases/:id/pause`, `/resume`, `/stop` | `{}`; Watch commands.                                             |
| SSE `cases` event                               | New read state for Cases.                                         |

The client can also call `POST /api/cases/:id/close?space=requests` with an
outcome and a verdict, but no control of the workbench does so for a Request.

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

The header of a Job or Watch shows the budget as **Effort n / max** only if
`workBudget.scopeId` matches its budget. A Request header shows none.

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

## Performance

The System place has a **Performance** page, and Team carries a summary of it
with an **Open Performance** link. Both read
`GET /api/performance/provider-resources?caseId=:id`; on the main system the
read has no `caseId`. Its Request scope and current execution pin are defined in
the
[Case reference](../operateurs/cases.md#reading-and-talking-to-a-request-in-its-space).

For a Request, the page shows:

- **Duration**, from the Case's opening to its closing; `N/A` while it is open;
- **Tokens**, with the number of calls and the mean per call;
- the share read **from cache**, the **failed calls** (failed or timed out), and
  **your messages** and **your decisions**, counted after the opening message;
- a **By agent** table (Operator, Calls, Tokens, Per call, Cache), twenty rows a
  page, whose names link to Team. An operator absent from the version reads
  “Former member”, and calls with no operator link read “Unattributed”;
- a **Details** disclosure with the token units, the summed provider time and
  the model version read.

On the main system the page shows tokens, cache, failed calls and the table,
with no duration and no interventions. A figure that cannot be computed is
absent. One that is defined but lacks data reads `N/A`, with the reason in its
tooltip; `N/A` is never zero. Totals are a minimum: calls not linked to the
scope are not counted. There is no verdict tile (removed on 3 November 2026).
Definitions and evidence limits are in the linked reference.

Sources:
[`PerformancePage.tsx`](../../../frontend/components/system/PerformancePage.tsx),
[`kpis.ts`](../../../frontend/lib/system/performance/kpis.ts).

## Retained limitations

The backend does not yet expose an operator's actual current Case to the roster.
A `busy` state therefore remains **Working**, and can make several tiles for the
same owner look busy. The `agentActivity` presentation function can name a Case,
but the Workbench provides none when the operator is working.

The system manager and the choice between two presentations are still planned.
Publication of delegation policies for the Main Operator is connected through
the shared writer; acceptance of the delegated flow with a real provider remains
open. See [operator authority](../operateurs/autorite-des-operateurs.md).

## Main Operator and Branch Operator scope

“Main Operator” denotes the unique global actor in Main. A Case's principal in
`executionSpaceId != "main"` is the **Branch Operator**, its isolated branch
root; the role never comes from matching a name. Preserve custom and model names
and persisted identities. Other branch members keep their own roles and
identities.

System follows the selected system, so a Case page describes its branch. In a
Case, Team joins the Branch Operator to a muted Main Operator node. That node is
a link to the actual main system and reads “Runs the main system” on hover. On
the main system, Team draws the Branch Operators of the open Requests beside the
Main Operator, newest first, up to six; the oldest fold into one “+N earlier”
node that leads to the Requests. Rights reads Main's rights from the actual
current main model, never from a branch copy, and shows each Branch Operator's
rights in its branch. Missing Main evidence stays unavailable. No relationship
or graph edge grants approval or delegation: current actor, act, target and
scope proof remain necessary.

A Branch Operator may evolve its branch independently through the governed
software-evolution path. Main-versus-BO rights differences are not all
Case-local edits when its birth Release predates Main; use that exact baseline
and admitted history. See the
[canonical scope contract](../../explanation/modeles/pages-system-et-model.md#selected-system-scope).
