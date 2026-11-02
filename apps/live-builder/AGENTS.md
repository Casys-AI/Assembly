# Assembly workbench — agent entry point

Commands first (pinned Deno, from this directory):

```sh
.data/toolchains/deno-v2.9.7/deno task test:changed   # affected tests, 175 s budget
.data/toolchains/deno-v2.9.7/deno task test:unit src/path_test.ts
.data/toolchains/deno-v2.9.7/deno task check          # separate type check
.data/toolchains/deno-v2.9.7/deno task test           # unit, setup and interface, 132 s budget
deno task test:heavy --plan                          # inspect without executing
deno task test:heavy --allow-slow                    # deliberate final campaign
```

- Iterate with a targeted task or `test:changed`; run `check` and the normal
  suite once for the stabilized change. Tests do not repeat type checking.
- All maintained test tasks use `tools/test-runner.ts`: finite duration,
  controlled integration flags, one process group at a time across this
  repository's worktrees, parallel workers for unit, setup and interface stages
  (one for integration and slow profiles), and low CPU scheduling priority. A
  second launcher names the holder and waits up to 15 minutes (`--wait=0` fails
  at once); `--no-fail-fast` collects every failure.
- Slow profiles (`test:toolkit`, `test:postgres`, `test:semantic`, `test:heavy`,
  `test:full`) require `--allow-slow`. Heavy suites live in `test/heavy/` and
  are excluded from every standard task. Run one heavy campaign on the
  stabilized lot when required; do not repeat it per subagent or per small edit.
  Raw `deno test` bypasses the launcher protections; do not use it for campaign
  execution.
- A budget overrun is a failed run to diagnose, not a reason to silently skip
  tests or raise the normal budget. Inspect `--plan` before broadening a run.
  Temporary directories stay in `.data/test-runs/`; successful runs clean only
  their own directory, while failed runs retain their evidence.
- A test that is ignored or skipped is never evidence. State which command
  actually ran and its counts.

## Layer boundaries

Five folders in `src/`; the architecture test guards `domain/`, `application/`
and `infrastructure/`. The long form is in
[CONTRIBUTING.md](../../CONTRIBUTING.md#frontières-du-code).

- `domain/` holds types, rules and transitions. It imports only itself: no
  database, network, Deno or validation framework.
- `application/` orchestrates use cases and defines the ports it needs. It
  imports `domain/` only. It does not construct adapters or manage file locks.
- `adapters/` implements those ports (compilation, validation, storage,
  transport, locking). It imports `domain/`, `application/` and
  `infrastructure/`, never `composition/`.
- `infrastructure/` holds technical services shared by every context (clock,
  logging, environment, SSE, native process client). It may import
  `application/` and `domain/`; seven imports of `adapters/` are tracked by a
  shrinking warn-list in the test.
- `composition/` is the composition root. It builds adapters and use cases and
  fixes the startup and stop order; `main.ts` calls it. It may import every
  folder.
- Where to look in `adapters/`: `in/` (routes in `in/http/<context>/`, local
  controls in `in/local/`) and `out/<system>/` (`postgres`, `git`,
  `sysml-toolkit`, `llm-providers`…) are grouped by technical system; `work/`,
  `model/`, `governance/` and `skills/` are grouped by context and build on
  `out/`. Search by name when unsure: the execution ledger is in
  `work/runtime/`, other Postgres stores in `out/postgres/`.
- The admitted SysML model and its identities are the source of truth.
  Refactoring never changes canonical encodings, digests or journals.
- Full conventions: the code boundaries of `../../CONTRIBUTING.md` and
  `src/README.md`.

## Never move, never rename

- `src/adapters/sysml-toolkit-pin.ts` — its exact path is hashed into the
  install fingerprint.
- A worker without its client and fixtures (toolkit, authority matrix, semantic
  preparation).
- Entry points: `src/main.ts`, the frontend routes, persisted formats and
  encodings, `.data` files, `ase-diagnostics-shapes.ttl` with its module.

## Excluded trees

- `frontend/_fresh/` (generated), `vendor/`, `native/` Rust crates, SysML model
  sources and example payloads, the frozen `prototypes/model-views/v1-views`
  snapshot. Keep these out of default agent context and out of moves.

## Tests

- Unit tests are colocated (`foo.ts` / `foo_test.ts`). Assembled flows, files,
  databases, servers and subprocesses belong in `test/integration/`;
  multi-minute campaigns belong in `test/heavy/` behind `test:heavy`.
- Moving a test preserves its cases and updates imports, fixture URLs and
  subprocess paths. Do not widen permissions to hide a load-time effect.
