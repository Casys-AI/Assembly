# From SysML to execution

The SysML model expresses the admitted design: components, contracts, mandates,
allocations, sequences, guards and assertions. The chat can propose changes to
it. The built-in view makes it readable. Effects depend on the validated version
and the host's controls.

## How SysML Toolkit and Assembly exchange data

SysML Toolkit compiles `.sysml` sources with its Rust compiler, called through
an N-API addon loaded in a local Deno subprocess. Assembly normalizes the
compiled elements for its derived model projections and execution contract. In
the current production path, Git preserves exact source trees and build
descriptors; compiled artifact bytes are verified in the KV build store and
durable vault outside Git.

The current path is:

```text
Admitted SysML sources
  → SysML Toolkit: native N-API compilation (child process)
  → build service: compiled artifact in the KV store and durable vault
  → Git: sources, .assembly-build-ref.json descriptor and commit
  → model adapter: Assembly projection and validation
  → ExecutableModel: identified execution contract
  → LangGraph nodes and edges, with Assembly host mechanisms
```

The parent process exchanges requests and results with the child process over a
versioned NDJSON protocol on standard input and output. The addon, prepared
library and native sessions stay in the child. The
[native transport](../../../src/infrastructure/native/process-client.ts) and
[compiler client](../../../src/adapters/out/sysml-toolkit/worker-client.ts)
implement this isolation and enforce deadlines; this path loads no WASM runtime.

JSON carries compiled facts and contracts between layers. A JSON object from the
chat or a session state does not thereby acquire the authority of an admitted
SysML source. The adapter resolves native references and rejects a model that is
incomplete for the controls it uses.

Model graphs are derived projections, not files stored in new Git snapshots. The
[build service reference](../../reference/modeles/service-des-builds.md)
describes verified artifact resolution and separate projection caches. Legacy
commits containing an inline `.ase-build.json` remain readable without rewriting
their history.

The local model adapter implements the application port `ModelPort`. The
application service consumes an `ExecutableModel` whose version carries the
digest, native references and repository version. The
[runtime adapter](../../../src/adapters/out/native-execution/native-graph.ts)
compiles its flows to LangGraph, which schedules transitions and owns interrupts
and checkpoints. Assembly's TypeScript handlers perform provider calls,
sandboxing, controlled network access, storage and journaling. Production
persists execution checkpoints and effect receipts in PostgreSQL, separately
from the model's RDF index. An uncertain effect requires reconciliation before
further dispatch.

SysML Toolkit does not receive every message to run the chat. It compiles the
design; Assembly uses the resulting contract to handle the case and control the
choices proposed by the agent.

## Why a proposal does not grant a right

An agent can request a grant that its mandate permits it to propose. The host
records a proposal tied to a revision. Until a separate control command has
decided that proposal, rights remain those of the admitted model.

For a network mandate revision, approval triggers a bounded source change,
validation, review and adoption, followed by resumption of the suspended case.
The October 21 test shows this transition with the same reader before and after
the grant. The action succeeds because the network control reads the granted
scope again, not because the agent claims a permission.

For a general SysML source proposal, accepting the design and adopting the
execution contract are separate decisions. This allows a design to be examined
before authorizing its effects.

Local commands record a control authority. They do not yet provide complete
human identity authentication. A `human` label in a trace describes the local
mechanism used; it does not prove the decision maker's personal identity.

## The owner is an operator in the model

The initial model declares a human owner, their mandate, the authority root and
the root grant. This makes the origin of local decisions visible rather than
leaving the owner outside the design. A decision receipt preserves that origin
and the version preceding the effect. Local fallback remains possible with an
explicit reason and the `outOfMandate` marker; it does not become an ordinary
right in the model.

This declaration does not yet resolve all authority through a single profile.
Software mandates, editing rights, their administration and delegated decisions
retain their bounded mechanisms. A generic capability and grant profile remains
to be designed. The current contract and its limits are in the
[authority reference](../../reference/operateurs/autorite-du-modele.md).

The `OperatorAuthorityPolicy` policy can represent the Main Operator's power to
decide certain network requests from other operators. Its bounded proposal,
publication and decision paths are wired through the host's authority checks. It
must not be confused with delegated administration of editing rights.

## Publication carries the decision evidence

An in-memory approval is not enough: the publication commit carries its receipt
and the expected edits. After an interruption, Assembly looks for that
publication before replaying the change or allowing its rejection. It verifies
the published revision rather than reconstructing a receipt from the current
model. Resumption does not replace an adopted pin that has changed since the
decision either.

The mechanism links a decision to an exact design effect; the presence of a
commit does not establish the success of an external action. See the
[source writer](../../reference/evolution/ecrivain-des-sources.md).

## Two complementary histories

Git preserves design revisions through source trees, build descriptors and
commits. The build store and vault preserve the compiled artifact bytes named by
those descriptors; model graphs are derived projections. PostgreSQL preserves
recorded application states, messages, decisions, events and the projections
available at those revisions. An application revision number therefore does not
identify a SysML commit.

A mandate change connects these histories: proposal, decision, new source and
execution events carrying the model context. An old state remains readable
without reactivating its former mandate. The Revisions page presents model
commits with a Git source diff; it lets users read versioned designs without
reactivating the rights of an earlier execution.

## Current implementation scope

The workbench executes a validated subset of SysML. Conversation supports the
historical `ConversationCase` and standalone action definitions declaring the
supported `operator-command-v1` profile. That profile requires explicit source
consultation before a new decision and a modeled action for internal commands.
Promotion retains its supported flow types; guards, assertions and primitives
remain bounded by the executable contract. Changing this design requires source
publication and explicit runtime adoption. These implemented paths do not imply
execution of arbitrary SysML models or qualification of every possible flow.

The domain contains decision types and controls; the application orchestrates

ports; adapters connect SysML Toolkit, Git, PostgreSQL, KV and providers. This
direction organizes the main path. Migration tools and the former optional lab
remain experiments: the entire repository is not presented as a finished DDD
library.

The [tutorial](../../tutorials/evolution/evolution-mandat.md) exercises changes
to an existing system's mandate. The mandate report of 21 October separates
observed facts from these implementation limits.
