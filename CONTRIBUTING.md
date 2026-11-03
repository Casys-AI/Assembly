# Developing Assembly

The maintained projects are the workbench at the repository root and its Fresh
interface in `frontend`. Each keeps its own Deno configuration and lockfile;
root tasks reach the interface with `--cwd frontend`, without imposing a
workspace or mixing their browser and server dependencies.

Use Deno **2.9.7**, as recorded in `.deno-version`. Workbench setup also
installs the qualified binary in its local toolchain.

```sh
deno task setup   # verified precompiled bundles; requires published catalog entries
deno task setup:source # explicitly build both native addons; starts no service
deno task quality # format, lint, types and normal tests for both projects
deno task test:integration:full --allow-slow # complete non-native integration suite
deno task build   # build Fresh, then check its routes and generated files
deno task dev     # interface with HMR at http://127.0.0.1:5173/
deno task dev:backend <name> # existing named backend in explicit development mode
deno task db:up   # local development PostgreSQL in Docker (compose.yaml)
deno task db:migrate # apply pending migrations to .env's database
deno task db:down # stop it; data stays in the `assembly_postgres` volume
```

The development database runs in Docker, not from a checkout: `compose.yaml`
starts PostgreSQL 18.4 on `127.0.0.1:55432` with its data in a named volume, and
`.env.example` points to it. Copy that file to `.env`, run `deno task db:up`
then `deno task db:migrate`. `docker compose down --volumes` deletes the
database; nothing else does.

`ASSEMBLY_ENV=development|production` selects backend behavior at startup;
production is the default. The `dev` task chain explicitly selects development
for its processes. Use `dev:backend <name>` for the existing named-system
launcher; ordinary `serve`/`system serve` launches retain the production default
unless explicitly configured. Vite reuses that running backend on `4311` and
proxies APIs/SSE while preserving browser Host and Origin.
`ASSEMBLY_BACKEND_URL` selects another local instance; Vite cannot change its
runtime mode.

The compiled interface and HMR both read the backend's public
`/api/environment`. Development uses its existing controls/cookie through
`POST /api/space-session/local`, without a file picker or Vite credential
bootstrap. Production keeps the explicit control-file exchange and exact-origin
checks. A build-time frontend flag never chooses authentication behavior. Start
the named backend, then the interface with the address the backend prints:

```sh
deno task dev:backend <name>
ASSEMBLY_BACKEND_URL=http://127.0.0.1:4313 deno task dev   # http://127.0.0.1:5173/
```

Frontend changes need no build or backend restart; backend code/mode changes
require an explicit restart.

Product configuration uses `ASSEMBLY_*`. Corresponding `ASE_*` names remain
supported aliases; a defined `ASSEMBLY_*` value takes precedence, including an
empty value. Third-party settings such as `SYSML_TOOLKIT_DIR` keep their names.

BMAD stable is configured to use the existing plans. The
[usage guide](docs/how-to/developpement/utiliser-bmad.md) describes the sources,
workflows and pinned reinstallation.

User setup requires Git, Deno and a `GITHUB_TOKEN` or `GH_TOKEN` with access to
private Releases. It runs no compiler and never implicitly falls back to a
source build. The tracked catalog under `vendor/native-runtimes/` authorizes
downloaded bytes. It is currently empty: use `deno task setup:source` until the
first qualified assets have been prepared and promoted.

Source mode requires Rust **1.98.1**, Node and npm; `ASSEMBLY_RUST_BIN_DIR` can
select the pinned Rust binaries. It verifies the shared `vendor/rust/` archive,
both locks and sources before an offline Cargo build with `--frozen`. npm may
fetch the pinned N-API CLI. Build caches and targets stay local and separate.
Old installations are retained; a divergent package is never overwritten.

The `native-runtimes.yml` workflow separates builds for the four declared
targets, native qualification and manual Release promotion. A target enters the
catalog only after passing its contracts. Generated-tool sandbox qualification
is a separate local macOS check; the release workflow does not replace it. Linux
refusals are tested separately. See the
[native contract](docs/reference/modeles/toolkit-local.md) for asset preparation
without publication.

- `deno task test`, from the root or the workbench: unit, setup and interface
  (SSR and DOM) tests; from `frontend`, the interface tests only. `quality` adds
  format, lint and type checks for both projects. The complete integration sweep
  is separate. Normal and complete integration runs do not inherit PostgreSQL,
  Toolkit, SHACL, LDkit, native-build or real-provider opt-ins from the
  terminal.
- Iterate with `deno task test:changed`, or select a file and optionally a
  `--filter` on `test:unit` / `test:integration` from the repository root.
  Affected-test selection uses Deno's import graph and Git changes. It is an
  iteration aid that retains affected integration tests within its stage
  budgets, not a replacement for complete integration qualification.
- `test:integration` is a focused 60-second loop: supply file selectors,
  `--related` or `--changed`. A filter alone does not scope the module sweep.
  Without selection it refuses before starting tests; `--plan` can still inspect
  the unselected roots. For example, from the repository root:
  `deno task test:integration test/integration/model-version-events_test.ts`.
- `test:integration:full --allow-slow`, from the root or workbench: all
  `test/integration` modules with a 390-second overall budget, clean normal
  environment and one worker. CI requires this unfiltered step in addition to
  normal quality checks; no integration modules or assertions are removed.
- `test:toolkit --allow-slow`: integration tests with the installed Toolkit.
- `test:postgres --allow-slow`: PostgreSQL qualification using an explicit
  `ASSEMBLY_POSTGRES_TEST_URL` for the dedicated local `assembly_pg1_test` DB.
- `test:postgres-toolkit --allow-slow`: joined persistence/native checks with
  both that explicit test URL and `SYSML_TOOLKIT_DIR`; use this for native
  restart, source-pin, budget and live Network Impact scenarios.
- `test:semantic --allow-slow`: the separately enabled SHACL/LDkit integration
  checks; normal tests keep these opt-ins off as well.
- `test:full --allow-slow`: unit/setup/Toolkit tests and, from the root, the
  interface tests. It does not include the heavy mandate and evolution campaign.
- `test:heavy --allow-slow`: the separate mandate and evolution campaign in
  `test/heavy/`. Requires both Toolkit and the dedicated PostgreSQL test URL so
  the durable half is not silently ignored. Run this once on a stabilized lot
  when its qualification is required.
- Add `--plan` to inspect a task's profile, selected commands and time budget
  without launching tests or requiring the campaign infrastructure. The plan
  never prints connection strings.

## Documentation

Write product and contributor documentation in English. Preserve technical
identifiers, API fields and runnable examples when translating their
explanations. Keep file paths and referenced heading anchors compatible.
Historical reports are available in Git history; internal planning notes are
outside this documentation language pass.

<a id="frontières-du-code"></a>

## Code boundaries

The backend in `src` has five folders. Each imports only what is listed here;
`test/integration/architecture_test.ts` guards `domain/`, `application/` and
`infrastructure/`.

- `domain/` holds types, rules and transitions. It imports only itself: no
  database, network, Deno or validation framework. Its contexts (`model`,
  `work`, `governance`, …) still import each other in a counted set of places;
  the test freezes the counts and lets them only shrink.
- `application/` orchestrates use cases and defines the ports it needs. It
  imports `domain/` only. It does not construct adapters or manage file locks.
- `adapters/` implements those ports: compilation, technical validation,
  storage, transport and locking. It imports `domain/`, `application/` and
  `infrastructure/`, never `composition/`.
- `infrastructure/` holds technical services shared by every context: clock,
  environment, logging, schema validation, SSE, the Fresh frontend dispatch,
  local HTTP security and the native Toolkit process client. It implements
  `application/` ports, so it may import `application/` and `domain/`. Seven
  imports of `adapters/` remain, tracked by a warn-list in the test that may
  only shrink.
- `composition/` is the composition root: it builds the adapters and use cases,
  wires them together and fixes the startup and stop order. The entry points
  (`main.ts`, `tools/system-control.ts`) call it; no other folder in `src/`
  imports it. It may import every other folder.
- Fresh components consume read and command APIs. The interface grants no
  execution rights and does not regenerate the SysML model.

Where to look in `adapters/`, which is grouped two ways at once:

- By technical system. `in/` receives calls: `in/http/<context>/` for routes,
  `in/local/` for local space controls. `out/<system>/` is what Assembly calls:
  `postgres`, `git`, `sysml-toolkit`, `llm-providers`, `oxigraph`, `filesystem`
  and so on.
- By business context. `work/`, `model/`, `governance/` and `skills/` hold the
  adapters of one context that build on `out/`: the execution runtime in
  `work/runtime/`, the source-authoritative model in `model/sources/`, access
  checks in `governance/`.

Start from the system (`out/`) or the route (`in/http/`); if neither fits, look
in the context folder. Postgres stores mostly sit in `out/postgres/`, but the
execution ledger stays beside its runtime in `work/runtime/`. These groupings
import each other and no test governs those imports.

The admitted model and its identities remain the source of truth. Refactoring
does not change canonical encodings, digests or historical journals. An observed
execution trace remains distinct from a scenario declared in the model.

## Tests

All maintained test tasks use `tools/test-runner.ts` and the pinned Deno
executable. One launcher runs at a time across this repository's worktrees: a
second one prints the holder's profile, folder and process, then waits for the
lock up to 15 minutes (`--wait=SECONDS`; `--wait=0` fails at once). Unit, setup
and interface stages run on Deno's `--parallel` workers (half the CPUs, at most
four; `--jobs=N` overrides); integration and the slow profiles keep one worker.
The launcher runs at low scheduling priority, limits native worker-pool
settings, and places owned temporary files in the checkout's `.data/test-runs/`.
Every run retains per-stage JUnit reports in its run directory, with test-case
durations and source-file grouping (file totals sum case times and exclude
module loading). A successful run removes only its owned `tmp/` directory; a
failed run retains it and prints the run directory for diagnosis. It does not
delete unrelated temporary files or database schemas.

| Command                              | Runs                                               | Measured (before) | Budget       |
| ------------------------------------ | -------------------------------------------------- | ----------------- | ------------ |
| `test`, root                         | unit, setup, interface SSR and DOM; parallel       | 57–70 s (~100 s)  | 132 s        |
| `test`, `frontend`                   | interface SSR and DOM; parallel                    | 6–9 s (18 s)      | 17 s         |
| `test:unit` / `test:setup`           | one stage; parallel                                | 33–55 s / 7–23 s  | 80 s / 35 s  |
| `test:changed`                       | affected unit, setup, integration; root: interface | varies            | 175 s, 192 s |
| `test:integration <files>`           | selected integration files; one worker             | varies            | 60 s         |
| `test:integration:full --allow-slow` | all non-native integration; one worker             | 258 s             | 390 s        |
| other `--allow-slow` profiles        | Toolkit, PostgreSQL, semantic or heavy; one worker | not measured      | 20 min/stage |

Measured on a shared 10-CPU machine under load 7 to 15 on 31 October 2026;
"before" is the earlier serial run. Each budget is the sum of its stages'
budgets, set from the slowest measured wall time plus about half; a run prints
each stage's time against its budget. These are ceilings, not promised
completion times. `--timeout=<seconds>` can lower a budget; only an acknowledged
slow profile can raise it, up to one hour. The budget starts once the lock is
held. On timeout the launcher terminates its own process group, including
ordinary child workers, and returns failure (124), after a short bounded
shutdown grace. An interrupted run or terminal hangup is also a failure.
`--no-fail-fast` runs every stage and lists all failures instead of stopping at
the first. The operating system releases the lock when its owner exits, so a
crashed holder never blocks; do not remove a live lock file. Raw `deno test`
commands bypass these safeguards and are reserved for deliberately scoped
diagnostics, not routine campaigns.

Tests use `--no-check` to avoid repeating the separate `deno task check` pass.
Implement independent parts in parallel with explicit file ownership. During
iteration, run targeted tests when they resolve a concrete uncertainty or
unblock progress, not mechanically after each edit. Batch the general
qualification and visual checks at the end of a stabilized lot. Before repeating
an expensive failing test, obtain actionable diagnostics and state what the next
run will establish. Reuse valid evidence; repeat broader checks only when a
failure, relevant change or unresolved concern justifies it.

Before handing off a stabilized change, run the appropriate type check and one
normal verification, plus the complete integration profile when integration
qualification is required. The normal profile deliberately excludes the
comprehensive integration sweep and real infrastructure qualifications; an
ignored test never counts as a passing qualification. No assertions are removed
to meet the time budget; a budget changes only with a new measurement. A timeout
remains a failed run requiring investigation; the explicit comprehensive profile
does not turn a previous timeout into a pass.

For a targeted CPU diagnostic, `--cpu-profile` is available on
`test:integration` and `test:postgres-toolkit` with exactly one file selector.
It enables explicit profiling windows in tests that support them, rather than
profiling the launcher. The runner grants `sys:inspector` and sets
`ASSEMBLY_TEST_CPU_PROFILE=1` only for that selected test process; inherited
activation is removed by default. Existing budgets, prerequisites and the shared
lock remain in force. Tests use `withTestCpuProfile` with a `phase` metadata
field to identify the captured window. The B0 retained-tool target witness
captures Request opening. The A+ witness in
`test/integration/postgres-request-retained-tools_test.ts` captures the A1 and
A2 `waitPublished` windows separately after acceptance. Both retain their
private diagnostic files under `.data/request-opening-profiles/` after the run.
CPU samples must be interpreted alongside elapsed phases and database
observations, not as proof of the cause of an earlier timeout.

Unit tests are colocated: `foo.ts` and `foo_test.ts`, or `Component.tsx` and
`Component_test.tsx`. They use test doubles for ports. Flows that assemble
several implementations or use a file, database, local server or subprocess
belong in `test/integration/`. Shared data and helpers stay in `test/fixtures/`
and `test/support/`.

Bootstrap script contracts stay beside `tools/`. The `test:setup` task runs
their temporary-file cases with read/write permissions, without subprocesses and
with real native builds disabled even if their flag is exported in the shell.
Real-build qualification remains explicit and separate from ordinary quality
checks.

Moving a test preserves its cases and updates its imports, fixture URLs and
subprocess paths. A test must exercise the production mechanism: a copied
function or unused helper does not prove its behavior. Do not widen test
permissions to hide a load-time side effect.

## CI and platform-specific checks

Routine pull requests and pushes run normal quality checks, the mandatory
unfiltered `test:integration:full --allow-slow` qualification and the frontend
build on Ubuntu. They do not allocate a hosted macOS runner or build native
runtimes. The generated-tool sandbox requires macOS `sandbox-exec`; Linux tests
retain the explicit unsupported-platform refusal and do not qualify Darwin
isolation.

Run the sandbox integration suite locally on macOS from the repository root. On
a fresh checkout, first use the pinned Deno 2.9.7 to install dependencies and
prepare only its local executable:

```sh
deno ci
deno eval --no-prompt --allow-read --allow-write --allow-env "import { installRuntime } from './tools/setup.ts'; console.log(await installRuntime());"
```

Then run:

```sh
.data/toolchains/deno-v2.9.7/deno test --no-prompt --frozen --allow-read --allow-write --allow-run=/usr/bin/sandbox-exec --allow-net=127.0.0.1 test/integration/tool-runner_test.ts
```

This suite uses controlled inputs and fetch doubles. It needs neither Rust,
SysML Toolkit nor a native-runtime build. Prepare the pinned Deno runtime and
project dependencies as above, without invoking `setup:source` for this check.
On macOS, expect the nine `macOSSandboxTest` cases to execute and only the
unsupported-platform refusal case to be ignored (currently 20 passed, 1 ignored
for the complete file). A Linux run skips the Darwin cases and cannot serve as
this qualification.

`native-runtimes.yml` remains a manual release workflow. Its macOS runners build
and qualify Darwin-specific binaries; run it only when producing those release
artifacts is explicitly intended, never as routine PR validation. A skipped
macOS suite is not evidence of sandbox qualification.

## Deno and Fresh

Dependencies are pinned in `deno.json` files and their lockfiles. Install with
`deno install`; use `deno ci` for a clean installation from the lockfile in CI.
The latter replaces `node_modules` and must not run on an instance that is in
use. The current TypeScript options and imports require neither `package.json`
nor `tsconfig.json`.

Fresh owns navigation through its partials, links and forms. The Workbench keeps
its key and state across views. A component imported by an island is browser
code, even when it lives in `components/`; only props crossing the server/island
boundary must be serializable.

Clean up browser resources, observers, streams and graph controllers. A
historical view does not follow present events. HTTP and headless checks do not
replace visual verification in a browser: state what was actually run.

Exports, reference fixtures and experimental evidence are not caches. Removing
them is outside the scope of routine code cleanup.
