# Assembly

_By Casys — Build, run and evolve agentic systems._

Assembly is a local workbench for building, running and evolving an agentic
system from SysML v2 sources. Agents work within their mandates; model changes
are proposed and reviewed before adoption.

Models are files versioned in Git. SysML Toolkit compiles the model in Rust
through N-API, in an isolated process.

The maintained project lives in
[`apps/live-builder`](apps/live-builder/README.md), with a Fresh interface.
Local data and toolchains stay under `apps/live-builder/.data/`.

Default setup installs verified precompiled native bundles using Git, Deno
**2.9.7** and a `GITHUB_TOKEN` or `GH_TOKEN` authorized to read this private
repository's Releases. The tracked catalog is currently empty: the first bundle
publication has not happened, so this path currently reports an unavailable
target. To get started now, install Rust **1.98.1** and Node/npm and use the
explicit source setup below from the repository root:

```sh
deno task setup:source
deno task build
cd apps/live-builder
test -e .env || cp .env.example .env
```

Configure the agent provider in `.env`: `AGENT_PROVIDER`, `ANTHROPIC_MODEL` and
`ANTHROPIC_API_KEY`. A valid key is required to call a real agent. Create and
start the system:

```sh
deno task system create mon-systeme
deno task system serve mon-systeme
```

Source setup copies the current runtime and builds both native addons from
pinned, verified sources. Shared Cargo dependencies come from
`apps/live-builder/vendor/rust/`; Cargo builds use `--frozen` offline. Once
qualified bundles have been published, `deno task setup` installs them without
Rust or npm, checking their hashes and provenance before extraction. It reuses a
valid installation and reports missing bundles or denied access explicitly,
without falling back to compilation. The server prints the instance address. See
the
[installation contract](apps/live-builder/docs/reference/modeles/toolkit-local.md).

See the [documentation](apps/live-builder/docs/README.md) and
[development conventions](CONTRIBUTING.md).

## License

Assembly is licensed under the [MIT License](LICENSE). Third-party components
retain their own licenses, including the
[vendored SysML Toolkit distribution](apps/live-builder/vendor/sysml-toolkit/README.md).
