# PostgreSQL operational storage

This directory defines the operational storage envelopes used by the production
composition through Prisma. Scoped state, history, memory, skills, budgets,
plans, model-write commands and evolution dossiers use PostgreSQL. Framework
checkpoints and dispatch also use PostgreSQL through their own adapters.
The former file-based Network Impact CLI and legacy operational SQL adapters
are retired under PG-5. Existing DuckDB/SQLite files and Git history are not
imported, rewritten or deleted. Deno KV remains the build/projection cache;
its internal local SQLite engine is outside this migration.

The pinned candidate is Prisma CLI/client/adapter-pg 7.10.1 with pg 8.23.1 and
Deno 2.9.7. `latest` must not replace these pins: Prisma's CLI latest tag can
refer to an ORM 8 release candidate. Dependencies belong in the workbench's
existing `deno.json` and lockfile.

Generate the client using Node after dependencies are installed. Run from
`apps/live-builder`; use the existing host Node binary, with no lifecycle script
or implicit database creation:

```sh
node node_modules/prisma/build/index.js validate --config prisma/prisma.config.ts
node node_modules/prisma/build/index.js generate --config prisma/prisma.config.ts
```

The configuration requires `ASSEMBLY_DATABASE_DIRECT_URL`. Generation and
validation use its syntax only, so they may use a non-secret dummy local URL.
Migrations require an explicitly selected direct administrative connection;
never substitute a pooled runtime endpoint or run `migrate reset` against a
retained instance. Runtime configuration is supplied to
`postgresClientConfiguration()` and is not read implicitly at module import.

```sh
node node_modules/prisma/build/index.js migrate deploy --config prisma/prisma.config.ts
```

`schema.prisma` owns relational fields, scope keys and foreign keys. The initial
migration includes `invariants.sql`, covering immutable evidence, valid pins,
nonnegative safe integers and execution-space parent identity. PostgreSQL
CHECKs/triggers are intentional custom migration SQL; Prisma does not infer them
from a payload or from this schema. New migrations must preserve them. Domain
payloads remain validated TEXT and keep their existing codecs/digests.

The host owns one Prisma client with a bounded pool and disconnects once at
shutdown. Store facades do not close it. Every store receives an explicit
`PostgresRuntimeScope`; the Case number allocator receives only
`PostgresSystemScope`. Lookup by a local ID alone is insufficient.

The isolated real PostgreSQL tests require a dedicated local database named
`assembly_pg1_test`. They create a random schema, apply the versioned SQL and
drop only that schema. Running ordinary integration tests without
`ASSEMBLY_POSTGRES_TEST_URL` skips this qualification and proves no PostgreSQL
contract.

For this qualified Darwin arm64 profile, reproduce the prebuilt setup with
`TMPDIR=<directory on the checkout's volume> python3 prisma/setup-local-postgres.py`.
The helper verifies the pinned published SHA-512 plus executable SHA-256 values,
extracts under `.data/toolchains`, validates internal library symlinks and runs
only version checks. It starts no database and executes no npm lifecycle script.
The upstream package is `@embedded-postgres/darwin-arm64@18.4.0-beta.17` from
[embedded-postgres](https://github.com/leinelissen/embedded-postgres); the
actual engine reports PostgreSQL 18.4. This is a third-party prebuilt
distribution, separate from the production hosting choice. Other OS/CPU profiles
need their own pinned setup and qualification.

For a bounded fresh local cluster, supply an already qualified prebuilt
PostgreSQL binary directory (containing `postgres`, `initdb` and `pg_ctl`). The
helper starts a localhost-only process on a random port with small
memory/connection limits and stops it afterward. Failure artifacts remain in the
newly created temporary directory. It never downloads a package or contacts a
hosted database.

```sh
ASSEMBLY_POSTGRES_BIN_DIR=/absolute/path/to/qualified/native/bin \
TMPDIR=/absolute/path/on/the/checkout/volume \
.data/toolchains/deno-v2.9.7/deno run --no-prompt \
  --allow-read --allow-write --allow-env --allow-run \
  --allow-net=127.0.0.1 prisma/qualify-local.ts
```

This qualifies the engine/ORM/runtime combination only. Managed Prisma Postgres
roles, endpoint pool behavior, connection budget, operational adapters,
publication recovery and the complete demo require their own recorded checks. A Git
reference or SQL foreign key grants no execution, admission, context-recall or
historical-read rights.

The initial migration remains unchanged. Additive migration
`20261027000001_artifact_reference_v2` retains historical immutable v1 rows and
adds explicit v2 format/path checks without relabeling evidence. Migration
`20261027000002_model_write_queue` adds the scoped queue envelopes and custom
intent/counter constraints. Their PostgreSQL schema checks passed; queue
publication, fencing and recovery require the separate PG-3 qualification.
