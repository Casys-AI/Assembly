# Create and find a local model project

A project contains editable SysML sources and the history of the admitted model.
An instance owns its session, journals and adopted runtime version. Several
instances can open the same project, but model changes are shared, including
catalogue observations that the workbench still writes into SysML. Separate
instance directories therefore do not make all business state independent.
Editing a draft does not retroactively change the version adopted by an
execution.

From `apps/live-builder`, with the local toolchain installed:

```sh
deno task model:project create mon-projet --root /chemin/projets --from-sources /chemin/sources-sysml
deno task model:project list --root /chemin/projets
deno task model:project inspect /chemin/projets/mon-projet
```

`--from-sources` points to a directory containing `.sysml` files, optionally in
subdirectories. The command copies these files into `sources/` and creates
`model-project.json`: schema version, stable UUID, name and relative source
path. It rejects an existing project and symbolic links in the sources. The
catalogue scans the local directory supplied through `--root`. Without this
option, it uses `.data/projects` relative to the current directory.

`inspect` displays the `sources/` draft directory separately from the
`commit:<sha>` version of `refs/heads/admitted`, once initialized.
`snapshotPathCandidate` only identifies the intended export path; this read
creates no files and does not verify an existing export.

To open an exact revision in an external viewer, explicitly export its sources:

```sh
deno task model:project export /chemin/projets/mon-projet
deno task model:project export /chemin/projets/mon-projet --version commit:<sha-complet>
```

Without `--version`, the command selects the current admitted version when the
export starts. It verifies the sources and the complete exported snapshot, then
prints `version` and `sourcesPath`, a path under
`.assembly/snapshots/<sha>/sources` for a new project, to pass to the viewer.
Existing `.ase` projects keep their original snapshot layout. It does not
recompile the model and rejects a project without an initialized repository and
an admitted revision. A modified export causes an error; an export is not a
second source of truth. The command does not change the editable `sources/`
draft.

Creation prepares the files; model initialization and admission use the real
compiler when the Git repository starts. The admitted revision retains the
compiled artifact, its digests and the compiler version. The V1 manifest is not
yet a generic library lockfile or a guarantee that the model can be rebuilt
independently of that artifact.

To open this project with the backend:

```sh
ASSEMBLY_MODEL_PROJECT_DIR=/chemin/projets/mon-projet \
ASSEMBLY_DEMO_DATA_DIR=/chemin/instances/mon-projet \
deno task serve
```

Product environment settings use `ASSEMBLY_*`; the old `ASE_*` names remain
readable aliases. A defined Assembly value takes precedence, including an empty
value.

The Git repository is local. These commands create no GitHub repository, remote
or publication, and request no network access. The usual backend configuration
is still required. Instance session files and databases remain separate from the
project manifest; do not give them the same storage location when several
instances run simultaneously.

For a first trial with a complete assembly, you can use
`--from-sources test/fixtures/commercial-watch`. The `models/` directory also
contains bootstrap fragments; it is not a bundle that can be imported as a
whole.

SysML Toolkit validates the executable contract and provides targeted edits; Git
retains the sources and their versions. Follow the
[dedicated guide](activer-toolkit-local.md) to install Toolkit. The maintained
backend uses this local combination. Data from an older TerminusDB instance
still requires an explicit migration; use a new instance directory for this
first local project.

This V1 qualifies an existing local project. A standalone `git clone` is not
enough to reconstruct it: the project manifest and private journals remain
outside model commits. To share only the sources, use `export`, then
`create --from-sources <chemin-exporté>` in a new project, with a new identity
and its own admission. This workflow publishes nothing to GitHub.

## Verified workflow

The initial qualification on 22 October used local Git and the OpenSysML/Toolkit
adapters available at the time, without a TerminusDB server or a call to an AI
provider. It verifies search and inspection at a pinned version, targeted
editing, proposals from two operators, explicit merging, conflicts, history,
draft preservation and recovery of adopted contracts.

The Revisions view and application graph were also opened on a real Git project.
The project catalogue remains a local command in this increment; no new complete
management interface is required.

Permissions remain those of the current admitted model. The
[structured editing policy](../operateurs/droits-edition-par-mandat.md) now
bounds each operator's operations and file/root pairs; the descriptive `scope`
field grants no rights. Without this policy, read tools remain available but
delegated writes are rejected. Proposals are neither admitted nor adopted
automatically.
