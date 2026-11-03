# Local models: current architecture

The workbench uses **native SysML Toolkit through N-API**, a **local Git**
repository and the Assembly TypeScript runtime. Human-readable sources remain
`.sysml` files. No model server or GitHub hosting is required.

## Reading the code

- `src/domain/` contains contracts and invariants: projects, sources, revision
  identities, proposals, mandates, budgets and executable models.
- `src/application/` contains use cases and ports: conversation, admission,
  execution, cooperation and persistence.
- `src/adapters/` contains implementations: Toolkit, Git, files, session
  storage, HTTP and decision providers.
- `models/` contains SysML constructs; some of its files are bootstrap
  fragments. The `test/fixtures/commercial-watch/` fixture is a complete
  assembly that can be used directly.
- `frontend/` presents conversations, models and revisions without granting
  execution authority.

Sources have their own `domain/model/value-objects/sources.ts` module: valid
relative paths, no collisions and size limits.
`domain/model/value-objects/revision-id.ts` distinguishes an immutable commit
from a branch name. `domain/model/entities/project.ts`,
`domain/model/records/revision.ts` and `domain/model/records/graph-diff.ts` make
these concepts visible in the source tree. Adapters do not own their domain
definitions.

`application/work/system-runtime.ts` drives a session of the modeled system:
conversation, admission and execution, with its participating operators,
including the builder and reviewer. `SystemRuntimeState` describes that state;
`adapters/work/storage/system-state-store.ts` preserves it. A system can
therefore include multiple operators. `adapters/work/operator-workspace.ts`
assembles conversational units and their exchanges around the shared model
repository.

## From file to execution

```text
.sysml sources
    → Rust Toolkit through N-API, in a child process: analysis, resolution, diagnostics
    → normalization of facts in the supported subset
    → compiled artifact and Assembly controls
    → artifact bytes in the KV build store and durable vault
    → Git proposal and admission: sources and .assembly-build-ref.json descriptor
    → adoption by a TypeScript execution
```

`toolkit-compiler.ts` drives the native runtime in a Deno subprocess. Each
operation has a deadline that includes queueing time. The parent sends sources
and receives results over a versioned NDJSON protocol; the N-API addon and
sessions stay in the child. `toolkit-normalizer.ts` preserves identifiers and
semantic properties, associates native positions with sources and makes the
supported branches explicit. Missing or ambiguous required information causes
rejection.

`source-graph.ts` prepares fact projections. `execution-model.ts` builds the
execution contract: rights, actions, allocations, parameters and flows.
`source-model.ts` connects authorized transformations to the repository. The
runtime interprets this bounded contract; it does not claim to execute all of
SysML v2.

## Projects, drafts and versions

A local project has a manifest and editable sources. In the current production
path, Git preserves admitted source trees, proposal commits and build
descriptors. A new model commit contains `sources/` and
`.assembly-build-ref.json`; compiled artifact bytes are verified in the KV build
store and durable vault outside Git. Model graphs are derived projections, with
separate caches. The
[build service reference](../../reference/modeles/service-des-builds.md)
describes this storage and the continued reading of legacy `.ase-build.json`
commits without rewriting history.

`sources/` is the human draft; admission does not overwrite it. The export
command produces a revision's exact files for inspection in another tool.

Exported copies are reconstructible and never serve as runtime authority. An
altered copy can be rejected during export without preventing reads of valid Git
objects. An initialized repository that loses its objects or admitted reference
is not silently recreated from drafts.

Preparations can overlap in a bounded pool. Before publication, the repository
checks the expected head and exact change set under a lock. A conflict or stale
head requires explicit reconciliation. Journals support recovery of an
interrupted publication.

An instance separately preserves its conversation, journals and adopted
contract. Instances opening the same project nevertheless share changes to that
model, including catalog information that the workbench still writes into SysML.
Separate instance directories are not enough to isolate all business state.

The initial workflow is described in the
[local projects guide](../../how-to/modeles/projets-locaux.md). V1 sharing
covers source export/import; an independent clone with migration of all private
journals has not been qualified.

## Mandates and capabilities

A capability describes an available operation. A mandate authorizes its holder
to request operations. Declaring a capability, owning a workspace or obtaining a
positive response from a language model does not grant permission.

The runtime checks native permissions, the holder, versions and the
proposal/admission/adoption stages. The descriptive `scope` field grants no
write rights. The
[structured editing policy](../../how-to/operateurs/droits-edition-par-mandat.md)
binds operations and file/root pairs to the holder and their mandate. The
repository checks all actual changes, including renamed references, then the
merged result under current rights. Mandates and execution controls remain
protected from delegated edits. Without an explicit policy, an operator cannot
propose model writes.

[Delegated administration](../../how-to/operateurs/administration-deleguee.md)
separates the right to perform an edit from the right to grant or delegate that
right further. An internal operation constructs only the authorized grant or
revocation; it remains a proposal to be admitted. Chains are recomputed from
current rights, and revoking a parent deactivates incompatible descendants
without deleting their history.

The sandbox protects execution of generated tool code. The Toolkit child process
owns its native state and can be terminated when an operation exceeds its
deadline. The parent waits for its exit before launching the next process. The
[native transport](../../../src/infrastructure/native/process-client.ts)
launches the child with explicit Deno permissions: reading the application and
package, writing to its private directory and loading authorized files through
FFI. It does not inherit the host's permissions wholesale. This computational
isolation does not replace the sandbox for generated tools.

The [native distribution](../../../vendor/sysml-toolkit/README.md) preserves
pinned versions and fingerprints. The former WASM path has been removed from
active workflows; its artifacts and evidence remain historical.

## Formats and reloading

The current artifact uses JSON and carries compiler provenance. The executor
consumes a typed, validated projection; it does not have to interpret the full
JSON on every action. CBOR and incremental compilation are possible
optimizations to measure, not prerequisites for this workflow.

The Toolkit 0.10.10 SDK offers compact JSON and CBOR, but its public APIs return
complete results. Windowed library loading is not a directly executable user
model stream.

Future file watching will prepare a complete new generation, then pass through
validation, admission and adoption. It will not mutate the active contract
fragment by fragment. Executions already started retain their version or require
an explicit continuation migration.

## Useful next steps

1. Make conversation and promotion patterns optional in the core.
2. Qualify sharing a complete project with its declared dependencies.
3. Add project selection in the interface and optimizations only when a real use
   case justifies them.

The SAV prototype is no longer maintained. Former separate model backends have
been removed from maintained code. Dated reports remain historical evidence, not
a description of the current configuration.
