# The desktop and Cases

The desktop keeps a persistent conversation with the main operator and opens
work objects beside it. The agent button represents this point of contact, named
**Main Operator** in the initial model. It stays accessible while the person
looks at a Case, a team or a version.

This organisation follows the decisions of 23 and 24 October 2026: a restrained
collaboration interface, close to a desktop application, with few permanent
texts and controls. The Dock is always visible and occupies its own space below
the content. Global actions belong to the Assembly menu; decisions about a task
stay in that task's context.

Case is the common term for the three forms of work: Request, Job and Watch. The
**Requests** button and page refer only to conversational requests; **Jobs** and
**Watches** name the other categories.

## A persistent conversation, separate Requests

The Main Operator designs the system with the person and creates operators to
handle Requests. Its conversation remains available between tasks; it is neither
an execution envelope nor a Case.

A Request has its own conversation on the **Requests** page. The person can
therefore pursue several requests without mixing them up. Its title comes from
the stated objective, and the tree on the left shows only the agents involved in
that Case. Delegated exchanges stay correlated with this work; they do not fill
the central conversation as independent replies.

The agent's instructions reserve closure for an explicit request. The server
still enforces closure commands and rules. A reply, closure and evidence of a
verified result are three different facts.

Conversation tabs were considered and then rejected: they would have multiplied
the places to talk, particularly for long-running watches. A Request is
therefore a conversation on **Requests**; a Job or Watch keeps a tracking page
open beside the central conversation. The earlier targeted-reply proposal
`↳ #16` is no longer needed, and work item UX-D3 is abandoned.

## The Dock distinguishes forms of work

Open Requests sit to the left of the disc. Jobs and Watches are grouped on the
right, before **System**, **Model** and **To decide**. They remain separate
because continuing a conversation, tracking scheduled work and monitoring a
source call for different interactions.

The person can pin any Case. This preference grants no authority and does not
keep an execution open. A closed Case can stay pinned for rereading; other
closed Requests can be found in **Done**.

## A decision stays attached to its origin

A change request can originate in a Case or in the Main Operator's conversation.
This origin determines the destination of **To decide**, the **needs you** badge
and the conversation that receives the card. It avoids marking every Case of an
agent when only one request is waiting for a decision.

A Request's Branch Operator works away from the Main Operator, so its request is
also relayed to the Main Operator's conversation, with the same card. The person
can decide there or in the Case; it is one decision. When a rule of the Main
Operator's mandate covers that Branch Operator, the Main Operator decides and
both cards show the outcome.

The card shows the exact source change and its base. Accepting sources and
putting the contract into service remain distinct actions. The agent panel and
Dock pin do not change any mandate. Publication and adoption details belong to
the [revision reference](../../reference/evolution/revisions-et-historique.md).

For the distinction between envelopes and executions, see
[Requests, Jobs and Watches](../operateurs/requests-jobs-et-watches.md).

## Product direction and limits

The demo focuses on Requests, subagents and mandates from within a Case. Product
development of Jobs and Watches remains frozen, without erasing code already
delivered. On 25 October, Erwan confirmed that the Main Operator can propose one
for a recurring need. The proposal still goes through the revision process; it
means neither activation nor qualification of the entire envelope.

Reading and design concern the same system. Separating them into two
presentations is deferred. No presentation choice can grant a right that the
server refuses. Model diagnostics, the trace of a reply and the synchronised
scene remain open work.

For everyday interactions, see
[Browse the desktop and Cases](../../how-to/atelier/parcourir-le-bureau-et-les-cases.md).
For routes, states and read boundaries, see the
[desktop reference](../../reference/atelier/bureau-et-cases.md).
