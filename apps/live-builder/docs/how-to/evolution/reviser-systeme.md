# Propose, compare and adopt a revision

Use this guide to change the existing SysML system through its chat. The
effective execution policy must permit `mayProposeSysmlRevision`, and the agent
must receive the required sources and their exact version. Targeted model
consultation is governed by `mayConsultModel`, which is required for revision
proposals. On historical pins that omit this field it follows the retained
revision right. Wait for an execution to finish before deciding a revision.

The
[Context Separation](../../explanation/contexte-et-memoire/separation-du-contexte.md)
page explains the distinction between consulted sources, current state and
journal evidence during this workflow.

## Read before editing

Open **Tools** to inspect the operator's five model tools: search, inspection,
references, source reading and source unloading. Ask it to find the affected
elements, inspect their references and read the necessary files before preparing
the proposal. For example:

> Find the builder's mandate in the model, inspect the elements that reference
> it and read its source files before proposing the change. Keep the
> consultation version supplied by the host for all these calls.

The agent uses the standard consultation tools supplied by the host. Search and
inspection return pointers; `read_source` loads complete files into its next
context. A search excerpt is not enough to reconstruct a file to edit.
Consultations count towards the request's decision limit: prefer a precise
change.

Loaded sources remain selected during this request. `unload_sources` releases
this selection; a new request starts from the current version. If loading is
refused, check the limit and unload files that are no longer needed when the
selection is too large. Unloading other files does not resolve a per-file size
limit. Formats and limits are described in the
[consultation reference](../../reference/contexte-et-memoire/consultation-ciblee-modele.md).

## Have the change prepared

In the system's chat, describe the desired result and its limits. For example:

> In the existing model, revise the builder mandate's documentation to clarify
> its current scope. Preserve its rights, identities and the other files.
> Propose the SysML revision with its reason and base version.

The agent submits `propose_sysml_revision`. It supplies the complete content of
each changed or added file; files absent from the proposal remain those of the
base. Compilation and contract checks precede availability for review. An
invalid proposal does not change the current branch.

For a grant already supported by the mandate variants, request a
`propose_mandate_change` proposal instead. The chat's control card then follows
the workflow described in the
[tutorial](../../tutorials/evolution/evolution-mandat.md).

## Review the sources

In the authoring agent's chat, the proposal appears in the feed with the exact
Git diff of its files. **Accept**, **Decline** and **Adjust** remain on the
card. **Adjust** lets you enter a correction: the old proposal is declined, then
the request is sent to the same agent to prepare a new proposal. An unconfirmed
submission remains flagged, without automatic retry or validation of the change.

To find a proposal, open **Model > Revisions**, then **Proposals**. Select it
and check its reason, base and files in the diff. **Unified** shows changes line
by line; **Split** puts the two versions side by side. Both layouts compare the
same sources against the proposal's base.

In **Commits**, each commit is compared with its first parent containing model
sources, or with the empty tree for the initial import. The page does not allow
a different base to be selected. Its address retains the selected commit or
proposal. Comparing two arbitrary versions remains possible through the
[diff routes](../../reference/evolution/revisions-et-historique.md#lecture-du-dépôt-de-modèles).

## Accept or decline the design

Choose **Accept** in the chat or proposal detail on **Revisions** to publish the
reviewed sources, or **Decline** to keep the current design. Acceptance checks
the current version and proposal digest. Revisions controls wait until the diff
is loaded and no other decision is in progress.

If the current branch has advanced, the writer attempts a three-way source
merge, then recompiles everything and revalidates the contract. If there is a
conflict, read the current version and have a new proposal prepared. Do not
manually replace the base content to bypass the refusal.

Chat blocks acceptance when the displayed base has changed and offers to request
an adjustment. It retains closed cards as collapsed receipts.

## Adopt the version for execution

After acceptance, open **Commits**. The `main` marker identifies the accepted
version; `running` identifies the version an operator uses. Its tooltip names
the affected operators. Accepting sources does not by itself put their new
contract into service.

If an available contract differs from the active one, **Put in service** appears
under the `main` commit. Check the operator's name; if several operators await
adoption, select the one to update in **Operator**, then use **Put in service**.
Wait for executions to finish: the control is inactive while an operator is
working or another decision is in progress. The host checks the exact digest and
commit reviewed before adoption.

Adoption targets this operator; the others retain their contracts. A
conversation without a runtime is not offered. An adoption or read error remains
displayed beside the control: read the state again before retrying.

A source revision that does not change the contract can retain the same
executable digest. It then produces no **Put in service** offer, and `running`
may remain on the old commit. The design commit and runtime digest answer
different questions; inspect their values rather than only the mandate number.

To find a decision, open the accepted commit in **Commits** and inspect its
sources. An accepted proposal's **merged as** link opens the published commit.
Application history lets you inspect the corresponding runtime state; the
[routes reference](../../reference/evolution/revisions-et-historique.md)
describes its access paths and command preconditions. The guide to
[System and Model](../modeles/parcourir-system-et-model.md) details the other
pages.
