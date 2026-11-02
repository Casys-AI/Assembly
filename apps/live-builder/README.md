# Assembly

The workbench builds an agentic system from local SysML v2 sources versioned in
Git. SysML Toolkit compiles these sources in Rust through N-API, in an isolated
process; revision proposals go through explicit checks and admission. Chat,
tools, the model and revisions share a Fresh interface.

## Getting started

Default setup uses Git, Deno **2.9.7** and a `GITHUB_TOKEN` or `GH_TOKEN` with
access to this private repository's Releases to install precompiled bundles. The
tracked catalog is currently empty, and the first bundle publication has not
happened. To get started now, install Rust **1.98.1** and Node/npm and run the
explicit source setup from `apps/live-builder`:

```sh
deno task setup:source
deno task ui:build
test -e .env || cp .env.example .env
```

Configure the agent provider in `.env`, which Git ignores:
`AGENT_PROVIDER=claude`, `ANTHROPIC_MODEL` and `ANTHROPIC_API_KEY`. A valid key
is required to call a real agent.

Product settings use the `ASSEMBLY_*` names shown in `.env.example`. Existing
`ASE_*` settings remain supported aliases; a defined `ASSEMBLY_*` value wins,
including an empty value. Provider and Toolkit settings keep their existing
names.

Create and start the system:

```sh
deno task system create mon-systeme
deno task system serve mon-systeme
```

Setup copies the current Deno runtime under `.data/toolchains/deno-v2.9.7/`.
Source mode builds both native addons; `ASSEMBLY_RUST_BIN_DIR` selects the Rust
1.98.1 binaries. Shared crates come from the verified vendor archive and Cargo
uses `--frozen` offline; npm may fetch the pinned N-API CLI. Once bundles have
been published, `deno task model:setup` installs the two bundles authorized by
the tracked catalog without Rust or npm. Existing installations are verified
before reuse; missing targets fail explicitly without compilation. See the
[native contract](docs/reference/modeles/toolkit-local.md). The model is stored
in a local Git repository. Execution data stays separate from the model under
`.data/`. The server prints the instance port.

A new system receives a builder, its context, its memory and the
`assembly-modeling` skill. Its tool catalog is empty unless tools are explicitly
selected.

See [local projects](docs/how-to/modeles/projets-locaux.md) to choose the model
directory, and
[the initial foundation](docs/how-to/atelier/demarrer-un-systeme.md) to prepare
tools. An existing instance retains its data; its history does not validate the
current version.

## Development

To read the code by pattern, start with the [APE code map](src/README.md) and
the [SysML model index](models/README.md). They connect canonical numbers and
titles to mechanisms and their limits.

Backend mode is selected at startup with `ASSEMBLY_ENV=development|production`.
Omitting it means **production**. Build mode does not select backend mode: the
same compiled interface reads `GET /api/environment` at runtime.

For an existing named local system, start its backend explicitly in development:

```sh
deno task dev:backend <name>
```

This task sets `ASSEMBLY_ENV=development` and delegates to the existing
`system serve` launcher. It preserves that system's data, model, port and normal
runtime checks. Generic `deno task serve` and `deno task system serve <name>`
retain the production default unless the environment explicitly selects
development. The named-system launcher inherits that explicit setting; it does
not silently change production launches.

Then start the interface in another terminal. Replace the backend port with the
address printed by the named system; for example:

```sh
ASSEMBLY_BACKEND_URL=http://127.0.0.1:4313 deno task dev
# http://127.0.0.1:5173/
```

Root, application and frontend `dev` tasks set `ASSEMBLY_ENV=development` in
their process chain. The backend must also have been started in development;
starting Vite cannot change an already running backend's mode. Vite reloads the
interface and proxies APIs/SSE to `ASSEMBLY_BACKEND_URL` (default
`http://127.0.0.1:4311`), preserving the browser's Host and Origin. The backend
alone validates its production or local development origin policy and creates
the session through the existing controls and HttpOnly cookie. In development
the interface requests `POST /api/space-session/local` with `{}` after reading
the backend's mode, with no control-file selection. This works both in the
compiled backend-served interface and through Vite on 5173 or 5174. Production
retains the existing explicit local control-file exchange and exact-origin
policy. No credential is read, stored or exchanged by Vite, and no build-time
mode flag controls this behavior. Unavailable runtime metadata or
development-session failure never falls back to a file picker. The normal file
picker is shown only after the backend explicitly reports production.

Frontend HMR does not reload backend code. Backend changes or a mode change
require an explicit backend restart. After deliberately changing the server
mode, reload the browser: the interface keeps its runtime mode for the current
mount. No backend watch mode is introduced.

```sh
deno task check
deno task test
deno task ui:check
deno task ui:test
deno task ui:build
```

For a targeted check, run one file at a time. Integrations using the real
Toolkit require explicit activation and reduced priority:

```sh
nice -n 15 deno test -A src/domain/conversations_test.ts
ASSEMBLY_SEMANTIC_INTEGRATION=1 nice -n 15 deno test -A test/integration/model-views_test.ts
```

The Toolkit package must be installed; `SYSML_TOOLKIT_DIR` can specify its path.
Run only one or two heavy suites at a time. Verify a documentation change
through its links, sources and `deno fmt --check`, without rerunning the entire
Toolkit suite. See also [CONTRIBUTING](../../CONTRIBUTING.md).

The build also verifies generated routes and files. Tests and headless checks do
not replace visual verification of the interface.

The [documentation](docs/README.md) brings together guides, pattern explanations
and references. Dated reports retain observations from the version tested; they
do not necessarily describe the current backend.
