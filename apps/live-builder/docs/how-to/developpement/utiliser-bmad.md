# Run an increment with BMAD

BMAD helps scope, implement and review Assembly increments. Its installation
reuses the repository's plans; decisions and contracts remain in their existing
documentation. Installing it does not start any implementation work.

## Project installation

The pinned version is **BMAD Method 6.12.4**, with the built-in `core` and `bmm`
modules, for Codex and Claude Code. Node.js 20.12 or later and `uv` are required
by its tools; they are development dependencies. Assembly's runtime remains
documented in [CONTRIBUTING.md](../../../../../CONTRIBUTING.md).

From the repository root, reinstall with:

```sh
npx --yes bmad-method@6.12.4 install --yes --action update --modules bmm --tools codex,claude-code --user-name Erwan --communication-language French --document-output-language English --output-folder _bmad-output --set core.project_name='Assembly' --set bmm.user_skill_level=expert --set bmm.planning_artifacts=apps/live-builder/planning/plans --set bmm.implementation_artifacts=_bmad-output/implementation-artifacts --set bmm.project_knowledge=apps/live-builder/docs --no-shims
```

For a first installation in a new checkout, omit `--action update`. Keep the
explicit version during checks and updates; a version migration is a separate
decision.

Keep both tool IDs when reinstalling: `--tools` selects the complete set of
integrations to retain.

- `.agents/skills/bmad-*` contains the 29 skills installed for Codex.
- `.claude/skills/bmad-*` contains the same 29 skills for Claude Code.
- `CLAUDE.md` imports `AGENTS.md` so both tools share the project instructions.
- `_bmad/config.toml` and `_bmad/_config/manifest.yaml` describe the
  installation.
- `_bmad/custom/config.toml` holds lasting team settings: French communication,
  English document output, the project name and documentation paths. The
  resolver applies them after installation answers.
- `_bmad/custom/bmad-*.toml` makes the relevant workflows load this guide.
- `_bmad/config.user.toml` and `*.user.toml` files under `custom/` are personal
  and ignored by Git. Other installation files and team customizations must be
  versioned together.
- `_bmad-output/implementation-artifacts` receives implementation briefs,
  reviews and tracking records for a requested increment. Technical snapshots
  under `_bmad/render/` remain ignored.

Do not modify distributed skills to adapt the project: use overrides under
`_bmad/custom/`, which the installer preserves.

## Reuse existing inputs

The paths below are relative to the repository root. They provide explicit
inputs when a workflow looks for a PRD, architecture or UX contract. Read only
the sections relevant to the requested scope, then check the code they describe.
The filenames BMAD expects are not a reason to generate replacement documents.

| Workflow need                                              | Project sources                                                                                                                                                                                                                                 | Scope                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Product intent, scope and acceptance of the next milestone | `apps/live-builder/planning/plans/priorisation-moscow.md`                                                                                                                                                                                       | A proposal awaiting decisions; retain open decisions and exclusions.                             |
| Work inventory, dependencies and handover                  | `apps/live-builder/planning/plans/plan-de-travail.md`                                                                                                                                                                                           | A work map; historical code bases and sequencing do not prove the current HEAD's state.          |
| Reservations and follow-ups                                | `apps/live-builder/planning/plans/a-faire.md`                                                                                                                                                                                                   | Reservations remain open after integration until their resolution is proven.                     |
| Increment requirements                                     | The specialized plan linked from `plan-de-travail.md`                                                                                                                                                                                           | Retain the M, W, F, B, L, D, UX and 5 work-item identifiers; cite the sections used.             |
| Architecture and invariants                                | `CONTRIBUTING.md`, `apps/live-builder/docs/explanation/developpement/decisions-et-perimetre.md`, `apps/live-builder/docs/explanation/developpement/frontieres-du-code.md`, `apps/live-builder/docs/explanation/execution/sysml-et-execution.md` | Retain the chosen direction and boundaries; examine their implementation before making a change. |
| Experience and interface contracts                         | `apps/live-builder/planning/plans/ux-atelier.md`, `apps/live-builder/planning/plans/system-et-model.md`, `apps/live-builder/docs/reference/atelier/bureau-et-cases.md`                                                                          | Distinguish proposed UX from contractual behavior.                                               |
| Contracts and qualification evidence                       | `apps/live-builder/docs/reference/`; historical reports in Git history                                                                                                                                                                          | Qualification records retain their date, version, profile and limits when consulted.             |

This mapping supplies the existing framing sources; it does not declare that all
prerequisites for a future increment are satisfied. State a real scope or
evidence gap explicitly, without inferring a decision from a file's name or
presence.

## Choose and track an increment

1. Use `bmad-help` for orientation. Read this mapping before recommending
   another framing phase. The project already has requirements, architecture
   decisions and plans.
2. To clarify a requested outcome, use `bmad-spec` with the specialized plan and
   the relevant MoSCoW sections. For broader work,
   `bmad-create-epics-and-stories` can reuse the same sources. Break down only
   the requested scope; the proposed MoSCoW is not an agreed backlog.
3. Each brief states the actor, outcome, scope, exclusions, observable criteria,
   refusal cases, expected evidence, dependencies and open decisions. Link each
   requirement to its source and existing identifiers; undecided estimates and
   thresholds remain open.
4. An implementation request goes through `bmad-build`. The brief passes the
   relevant sources and constraints to implementation agents, including
   `AGENTS.md`, `CONTRIBUTING.md` and the work item's plan. Check the current
   code before reusing an earlier delivery or prototype.
5. Perform the review and checks appropriate to the change, following
   `CONTRIBUTING.md` and the central plan's working conventions.
   `bmad-code-review` supports an additional review; `bmad-sprint-planning`
   checks preparation or tracking when a breakdown has been chosen.
6. Record evidence and reservations in the existing work-item tracking. A BMAD
   brief points to that tracking; it must not become a contradictory second
   inventory. Distinguish **implemented**, **integrated**, **connected**,
   **qualified** and **accepted**. Declare acceptance only for an outcome
   verified under the agreed conditions.

The current milestone framing, its story slices and their limits are kept with
the plans in `apps/live-builder/planning/`; a BMAD workflow does not launch
those packages or grant new mandates.

## Check the configuration

From the repository root:

```sh
uv run _bmad/scripts/resolve_config.py --project-root . --key core --key modules.bmm
uv run _bmad/scripts/resolve_customization.py --skill .agents/skills/bmad-build --project-root . --key workflow.persistent_facts
uv run _bmad/scripts/resolve_customization.py --skill .claude/skills/bmad-build --project-root . --key workflow.persistent_facts
```

The first result must name the project, French communication and English
document output, plans under `apps/live-builder/planning/plans`, project
knowledge under `apps/live-builder/docs` and implementation output under
`_bmad-output/implementation-artifacts`. Both customization results must contain
a `file:` reference to this guide.

Installed skills become available on the next Codex turn. In Claude Code, open a
session from the project root and invoke `/bmad-help` to begin.
