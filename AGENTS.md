# Assembly — agent instructions

## Autonomy within the requested scope

Erwan’s rule: “Be autonomous in the work I request, but do not turn my questions
into new projects.”

- A question calls for an answer. Requests for advice, explanation or reflection
  authorize analysis and useful reading, not implementation of an improvement.
- Phrases such as “what do you think?”, “why?” or “can you think about a better
  organization?” do not authorize creating a mockup, modifying files, migrating
  data, integrating a worktree or restarting a server.
- A clearly stated request for action, even phrased as a question (“can you
  implement/fix/restart…?”), authorizes that work. Carry it out autonomously
  with the necessary checks, without requesting confirmation for each normal
  step.
- Proactivity instructions and skills apply within the requested work. Invoking
  a skill for analysis or reflection does not automatically authorize building
  or modifying something.
- An improvement discovered along the way may be proposed, but does not become a
  new project without a clear request or authorization. If an expansion is
  ambiguous, answer the question first and clarify before making changes.
- A new question during ongoing work does not expand its scope: answer it, then
  continue only the work already authorized, unless the user asks to stop or
  explicitly changes the objective.
- If the user points out that they were only asking a question, stop the
  unrequested expansion immediately. Do not launch compensatory work or modify
  the product in response to criticism of the assistant’s behavior.

## Working in Assembly

Read [CONTRIBUTING.md](CONTRIBUTING.md) for code boundaries, commands and
precautions. The [documentation index](docs/README.md) points to the tutorials,
guides, references and explanations. In the working repository, `planning/`
holds the plans, dated reports and research; it is not published.

The public repository `Casys-AI/Assembly` receives a filtered snapshot of main
(allowlist in `public-export/`). Docs and code comments that ship publicly never
link to `planning/`, `_bmad-output/`, `presentations/` or the private GitHub
repository (pinned reports, issues, pull requests): keep the fact and its date,
without the link. Private paths may stay as plain text where agents need them.
Run the two checks of `public-export/README.md` before a publication.

## Coding: tests, checks and self-review

Erwan’s rules for any agent that writes code here:

- **Run heavy suites rarely.** The PostgreSQL, Toolkit and full integration
  profiles are very slow (one scenario can take 10 to 25 minutes).
  - While working, run only targeted unit tests on the files you touch.
  - To diagnose, run one heavy scenario, filtered to the failing case.
  - Run the heavy suites once at the end; after a fix, rerun only the scenario
    you fixed.
  - Never rerun heavy suites in a loop until they turn green.
- **Proportionate tests.** Write one test per behaviour or edge case, extending
  the existing tests and fixtures before creating new ones. Do not test internal
  mechanics. If the test lines exceed about twice the code you added, justify it
  in your report.
- **One check per rule,** at the trust boundary. Do not repeat a defensive guard
  inside, and do not add a fallback that hides an error.
- **Elegance and SOLID count as much as correctness.** Write readable code with
  one responsibility per unit, keep dependencies pointing the right way, and
  reuse existing helpers instead of reimplementing them. Fix local issues in the
  lot. Structural issues (module boundaries, large services) go to the hexagonal
  refactor plan.
- **Design interfaces for agents (AX).** CLI, tools, APIs, errors and modules
  are read by agents, not only by people:
  1. no verb overlap: unique commands and explicit enums, no ambiguous aliases;
  2. safe defaults: dry run by default, writes are an explicit opt-in;
  3. structured outputs: machine-readable results (`taskId`, `status`,
     `progress`), not console spinners;
  4. machine-readable errors: `code`, `context` and `recovery`, not prose;
  5. fail fast: validate inputs at the boundary, before costly operations;
  6. deterministic outputs: same inputs, same outputs, no hidden dependence on
     time or randomness;
  7. explicit over implicit: no magic default that silently changes behaviour;
  8. composable primitives: one function does one thing, pipeline steps stay
     independent;
  9. narrow contracts: take the minimum, return the minimum useful, no god
     objects;
  10. co-located documentation: docs live next to the code, tests are executable
      documentation;
  11. test-first invariants: every behaviour has a test, edge cases before the
      happy path.
- **Review your own work before handing it back,** preferably with a fresh
  sub-agent that did not write the code. Check the rules above, plus leftover
  diagnostic or debug code and any assertion you changed without saying so. List
  what you found and fixed in your report.

## Using BMAD

In the working repository, BMAD is installed for Codex and Claude Code, at
stable version **6.12.4**; elsewhere, reinstall it with the pinned command of
the [adoption guide](docs/how-to/developpement/utiliser-bmad.md). Before any
BMAD workflow, including `bmad-help`, read that guide. It maps BMAD inputs to
existing plans: the absence of files named `prd.md` or `architecture.md` does
not justify recreating the project’s framing.

Specialized plans retain their work-package identifiers. The MoSCoW explicitly
remains a proposal pending decisions. Check the current code before relying on a
dated qualification; distinguish integrated code, wiring, qualification and
acceptance. A generated document or a merge is neither a decision to launch nor
acceptance.

## Commands

Pinned Deno, from the repository root:

```sh
.data/toolchains/deno-v2.9.7/deno task test:changed   # affected tests and interface
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
[CONTRIBUTING.md](CONTRIBUTING.md#frontières-du-code).

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
- Full conventions: the code boundaries of `CONTRIBUTING.md` and
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
