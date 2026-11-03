# Use a second instance

From the repository root, after `deno task model:setup` and
`deno task ui:build`:

```sh
deno task system create second-systeme --port=4315
deno task system serve second-systeme
```

Each named system keeps its sources and host files under `.data/systems/`:
`model-project/` contains Git sources and their history; `instance/` contains
private host files. Operational state and durable execution use PostgreSQL. The
manifest's stable system UUID separates its scopes from other systems even when
native operator or Case IDs coincide. Models are compiled with SysML Toolkit.

Configure the PostgreSQL runtime and direct migration connections, then apply
the migrations as described in the [startup guide](demarrer-un-systeme.md).
Systems can share one database with their separate scopes. Each running host has
a maximum budget of 24 connections: 18 for pg-boss, two for checkpoints and four
for Prisma. Operators and branch views share these pools; separate hosts'
maximums add up. Choose an available port, and do not start two processes on the
same host files. For the PostgreSQL cutover, prepare a new named demo and retain
previous files; there is no automatic import of operational DuckDB/SQLite data.

See the [startup guide](demarrer-un-systeme.md) to select initial tools and
[local projects](../modeles/projets-locaux.md) to choose a model repository.
