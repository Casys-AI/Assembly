# Operate several agents in one system

Use this guide to prepare a system with a point of contact and several
operators, send them work, then evolve their contracts. It uses the workbench’s
standard server. The number of operators and their missions come from the SysML
sources.

The 21 October 2026 verification report preserves a recorded multi-operator run
and its limits, separately from this guide's current setup instructions.

## Prepare separate data

From the repository root, prepare a named system with a complete source set:

```sh
deno task system create mon-systeme --port=4313 --from-sources=mes-sources.json
deno task system serve mon-systeme
```

The JSON file contains either a map `{ "chemin.sysml": "texte SysML" }` or an
export containing that map in `sources`. `create` does not call the agent
provider. It prepares `.data/systems/mon-systeme`, a distinct Git model
directory identity and a distinct port. An existing name is refused; `serve`
resumes its data. `deno task system list` shows the prepared systems.

The initial sources are kept in the system’s `sources` subdirectory. After
initialization, the model repository’s history becomes the reference: editing
that directory does not replace an accepted revision. To change an existing
system, use the revision workflow below.

The [commercial-watch](../../../test/fixtures/commercial-watch/README.md)
directory provides an initial three-operator source set. It illustrates the same
behavior as any other system; its monitoring goals remain SysML data.

## Declare operators and communications

In the sources, declare concrete occurrences of `ConversationSystem`. Their
qualified scopes, builders, catalogs, policies, contracts and flows must be
distinct and valid. The conversation metadata is:

```sysml
attribute operatorName : String = "Coordinateur";
attribute operatorInstruction : String = "Coordonner le travail admis.";
attribute primaryContact : Boolean = true;
attribute humanInputEnabled : Boolean = true;
```

Declare only one primary point of contact. For a specialist that receives work
only from other operators, set `primaryContact` and `humanInputEnabled` to
`false`.

To send it work, use an occurrence of `AssemblyWork::AgentInbox` allocated to
its builder, then a `BehaviorAccess` that exposes that occurrence to the
authorized caller. The presence of the
[work-operators.sysml](../../../models/work-operators.sysml) library alone
grants no access.

Envelopes are declared per operator. The current engine supports the
Conversational Case Management envelope; declaring another envelope does not add
an execution engine for it.

## Assign work and follow responses

Open **Conversation** and send the request to the point of contact. The side
list shows the operators actually declared. Selecting or pinning a thread helps
you inspect it; it changes neither the operator’s mandate nor its permission to
receive human input. A thread without human input remains readable and refuses
direct messages.

Ask the coordinator to use its exposed behaviors to distribute the work. In a
plan, tasks must form a complete dependency graph, with the exact behavior
identities and their parameters. Every task is admitted before the first call.
See [closed work plans](../../reference/execution/work-plans.md).

Read the correlated responses: `completed` means the assigned work has finished;
`waiting` means a decision or continuation is expected; `failed` means failure.
A returned call or visible candidate alone does not prove that the mission is
finished. A dependency waits for completed work. It does not automatically fill
its parameters with another task’s results: the coordinator must obtain the real
references before requesting work that uses them.

## Inspect tools and their reuse

In **Tools**, read the candidate’s owner, content, trials and state. A decision
targets the exact owner, candidate identifier, digest and conversation revision.
The permission to admit a candidate is checked against its local mandate; it is
distinct from permission to talk directly to that operator.

To share a tool, expose the native catalog inspection and reuse entries
separately. The requesting operator first obtains the real references of an
active artifact: `sourceAgentId`, `candidateId`, `digest`. It then requests an
import through its local `ReuseTool` entry.

Import preserves the artifact’s bytes and provenance but creates a local
candidate. Inspect local trials, admission and activation before considering it
usable by this second operator.

## Evolve the system

Have the agents propose changes, then open **Revisions** to compare the sources,
decide whether to integrate them and inspect the compiled result. The detailed
workflow remains [system revision](../evolution/reviser-systeme.md).

Then choose the operator whose contract must change and explicitly adopt the
reviewed digest and source version. Accepting a source revision does not mean
that all operators adopt it. Each session keeps its admitted contract until its
own adoption. Admission of the point of contact also determines the system’s
members; adding or removing an occurrence therefore requires reconciling that
registry.

Wait for ongoing work to finish before adopting a contract. If the model changed
between review and the command, reload and review the new version instead of
repeating a command that has become stale.

## Resume after an interruption

Run `deno task system serve mon-systeme` again with the same name and
environment file. Sessions, admitted contracts, candidates and receipts are
preserved. Interrupted work without a certain result is not automatically
executed again. Inspect its state before requesting an explicit resumption.

If the current sources no longer compile a session, its history and admitted
contract remain readable; execution waits for a valid model again. Do not delete
the database or recreate a system to hide this divergence.
