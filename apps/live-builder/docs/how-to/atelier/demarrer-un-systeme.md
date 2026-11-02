# Start a system with its initial foundation

This guide prepares a named system with its own data and model. It assumes
`deno task model:setup` and `deno task ui:build` have been run from
`apps/live-builder`, and that the local `.env` file configures the agent
provider.

## Prepare operational PostgreSQL

Use a dedicated local PostgreSQL database for the new demo. The qualified local
binary setup and isolated test target are described in
[the PostgreSQL guide](../../../prisma/README.md). An isolated qualification
cluster is stopped after its checks; it is not the database of a running demo.
No hosted resource is created by `system create` or `system serve`.

Configure these host-only entries in the private `.env` file:

- `ASSEMBLY_DATABASE_URL`: the runtime PostgreSQL connection.
- `ASSEMBLY_DATABASE_DIRECT_URL`: the direct administrative connection used by
  Prisma migrations.

A local database can use the same direct endpoint for both. The two settings
remain separate so a pooled runtime endpoint is never silently selected for
schema administration. Never place connection values in SysML, exported model
sources, chat, tool inputs or provider configuration messages.

From `apps/live-builder`, apply the checked-in migrations to that selected new
database before starting the system:

```sh
node --env-file=.env node_modules/prisma/build/index.js migrate deploy --config prisma/prisma.config.ts
```

First startup also initializes the official pg-boss, LangGraph checkpoint and
LangGraph store schemas. The selected runtime role needs permission for this
initialization. The host has a maximum connection budget of 24: 18 for the
shared pg-boss queue (16 ordinary workers, Main and maintenance), two for
checkpoints and four for Prisma business storage. Operators and branch views
share these pools; separate running hosts each have their own budget, so their
maximums add up. Managed-service roles and pooling require their own
qualification.

## Create, then start

From `apps/live-builder`:

```sh
deno task system create mon-systeme
deno task system serve mon-systeme
```

Creation prepares `.data/systems/mon-systeme/`, a source project in
`model-project/`, private host files in `instance/`, a system identity and an
available port between 4313 and 4399. It does not call the agent provider or
start the server. `serve` prints the address to open. To choose an available
port, add `--port=4315` to `create`.

The new builder has three sets of capabilities:

- a catalogue of conventional tools, empty unless explicitly selected;
- context with its policy, evidence reading and skills;
- local memory with its operations and policy.

The `assembly-modeling` skill is installed and loaded initially. Memory supports
capturing and recalling notes, but its initial policy forbids self-admission.
`RevoirMemoire` access is therefore insufficient to promote the operator's own
notes. Values and limits are described in the
[foundation reference](../../reference/contexte-et-memoire/socle-initial-et-skills.md).

Check `/health` for `ready`, `modelBackend` and `modelProject`, then open the
chat and model view. The model and its stores are initialized when the service
starts; creating the directory alone does not prove that the system is
executable. Current state, history, budgets, plans, memory, skills, evolution
receipts and durable execution use PostgreSQL. Git model sources, verified build
vaults and the KV build cache remain local.

## Select conventional tools initially

The `--initial-tools` manifest selects exact code for the normal testing and
admission flow. It does not authorize activation.

Prepare a `lecteur.ts` file that satisfies the `read_web_page` contract: a
self-contained module exporting `default({url, html}) => {title, text}`. The
exact criteria are defined in
[`TOOL_CONTRACTS`](../../../src/domain/work/candidates.ts). To build the
manifest from this file without copying its code into a JSON string:

```sh
deno eval '
const code = await Deno.readTextFile("lecteur.ts");
const manifest = {
  format: 1,
  tools: [{
    id: "lecteur-v1",
    name: "lecteur",
    description: "Extract the title and readable text from an HTML page",
    kind: "read_web_page",
    code,
  }],
};
await Deno.writeTextFile("catalogue.json", JSON.stringify(manifest, null, 2));
'
deno task system create mon-systeme-outille --initial-tools=catalogue.json
deno task system serve mon-systeme-outille
```

The model retains this selection in its catalogue. At startup, the engine
prepares candidates from their exact bytes, tests them and pauses when an
admission decision is required. Inspect the result in the workbench, then admit
or reject the candidate. The next selection can then be prepared. A rejected
test does not activate the tool. The initial catalogue remains limited to the
two HTML contracts currently supported; it does not load arbitrary tools or MCP
servers.

## Resume an existing system

```sh
deno task system list
deno task system serve mon-systeme
```

Stop the process with `Ctrl-C`, then run the same command again to resume with
its data. `create` rejects a name already in use. Restarting preserves the
admitted sources: it does not add the new foundation to an older instance or
reload a skill that the operator has unloaded.

To start from an explicit source set, use
`create mon-systeme --from-sources=export.json`. The file contains an object
mapping `.sysml` names to their text, either directly or within a `sources`
property. This set replaces the initial model; missing constructs are not added
automatically. `--add-source=fichier.sysml` adds a source file whose name is
absent from the prepared set. Its content may contain definitions or usages;
adding only definitions does not instantiate anything. A tool selection requires
one unique catalogue usage recognized in the sources.

To add the foundation to an older instance, follow the guides for
[modeling context and memory](../contexte-et-memoire/modeliser-contexte-et-memoire.md)
and [revising the system](../evolution/reviser-systeme.md). For an instance
started directly with `deno task serve`, retain its data and model variables;
the [second-instance guide](seconde-instance.md) describes that configuration.

## Directories and recovery

The `system.json` manifest uses format 2. `system serve` explicitly selects the
local project with `ASSEMBLY_MODEL_PROJECT_DIR`, private host files with
`ASSEMBLY_DEMO_DATA_DIR`, and the manifest's stable UUID with
`ASSEMBLY_SYSTEM_ID`. PostgreSQL scopes combine the project, this host system,
the persistent main execution space and the native operator. A Case does not
create another operator runtime. Direct `deno task serve` keeps its separate
host identity in `host-system.json` under its selected data directory.
`main-runtime-owner.json` retains the scoped primary operator locator so a newer
source HEAD cannot select an empty replacement runtime on restart. Preserve
these host files with the source repository; a missing locator with existing
PostgreSQL runtimes is refused rather than guessed. Sources provided through
`--from-sources` or `--add-source` become the sources of the started project.

A manifest using an older format is rejected. Preserve its data and prepare a
new named system from a reviewed source export; no automatic conversion or
silent recovery takes place.

## Fresh demo cutover

Create a new named system for the PostgreSQL demo and verify its database
migration before using it. Retain earlier instance directories and their
DuckDB/SQLite files for inspection; the new composition does not import, rewrite
or resume those files. New PostgreSQL events are not copied back into them.
Reusing an old model source export does not import its former operational
history.
