# Initial foundation, tools and skills

This reference describes the workbench's current bootstrap and its contracts.
The 22 October 2026 bootstrap and skills report records the tests actually
performed; a construction's presence in this reference does not qualify all APE
patterns.

## Composition and compatibility

[`loadInitialSources`](../../../src/adapters/out/filesystem/initial-model-sources.ts)
prepares the normal configuration with context, memory, skills and native call
libraries. It inserts the
[`information-bootstrap.sysml`](../../../models/information-bootstrap.sysml)
fragment into `liveBuilder`. This fragment groups `context`, `context.skills`
and `memory`, with their access actions, allocations and bindings. The
conventional tool `catalog` remains separate.

The
[`configuration-information-views.sysml`](../../../models/configuration-information-views.sysml)
fragment declares the **Contexte** and **Mémoire** frames, with **Skills**
inside Contexte. `agentOverview` exposes them in **General → Vue d'ensemble**.
These views group existing elements and retain their identities and bindings;
they do not change the executable contract. Containment relationships displayed
between frames come from the SysML views, while the inspector retains the
elements' native ownership.

The initial skill references `bundle:assembly-modeling` and the SHA-256 of the
exact bytes of the
[bundled `SKILL.md`](../../../skills/assembly-modeling/SKILL.md). The skill body
is not copied into the SysML sources. The resolver verifies the bundle bytes on
first installation. An existing installation keeps its loaded or unloaded state
on restart. Historical `bundle:ase-modeling` references still resolve the exact
legacy asset at `skills/legacy/ase-modeling/SKILL.md`; its bytes and digest
remain unchanged. Each seed is pinned from the actual asset it names.

Persisted source sets and those supplied through `--from-sources` are retained.
Updating the software does not migrate them or replace their policies with the
values below. A change goes through revision and adoption.

## Initial values

| Set                | Parameters                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main operator      | `operatorName="Main Operator"`, `primaryContact=true`, `humanInputEnabled=true`. Its mission is to design and evolve the system with the person and create operators for Requests. |
| Context            | `recentMessages=8`, `maxMessageCharacters=2000`, `maxCollectionItems=12`, `maxContextCharacters=250000`. Limits count JSON characters.                                             |
| Memory             | `modeling` scope, sources required, known outcome required for admission, maximum validity 86 400 000 ms, `allowSelfAdmission=false`.                                              |
| Skills             | No download hosts (`allowedHosts=[]`), `maxSkillBytes=65536`, `maxInstalledSkills=32`, `maxLoadedSkills=4`, `maxLoadedCharacters=48000`.                                           |
| Initial skill      | `assembly-modeling`, bundled reference, digest recorded in the model, loaded on first installation.                                                                                |
| Conventional tools | No tools selected by default; human admission in the normal configuration.                                                                                                         |

New systems also receive an explicit invocation budget of 1,000 cumulative agent
invocations per dossier (`revision=1`, `onExhausted="wait"`, recipient
`local-control`). This is the chosen initial setting, not a recommended ceiling
for every mission. It is separate from each turn's decision and flow-step
limits. The diagnostic-only `AccountabilityAssignment` binds the containing
conversation to its declared human owner; it does not establish that person's
acceptance of accountability. Plans require their own direct assignment.

The bundled initial skill needs no download host. Installing a remote skill
requires an accepted and adopted source revision that explicitly authorizes its
host in `SkillPolicy.allowedHosts`. If the network mandate does not list that
host, `CAPABILITY_BEYOND_MANDATE` reports a warning. Existing source sets are
not rewritten by these defaults.

The name and mission come from [`system.sysml`](../../../models/system.sysml)
and [`configuration.sysml`](../../../models/configuration.sysml). The 25 October
rename does not change the sources of systems already created: an older instance
may therefore keep “Designer” until an explicit revision.

### Initial operator metadata

The model declares `operatorName`, `operatorInstruction`, `primaryContact` and
`humanInputEnabled` together on the system occurrence. The
[compiler](../../../src/adapters/out/sysml-toolkit/compilation-policies/work/execution-model.ts)
accepts either their complete absence for compatibility, or exactly one
declaration of each. Partial presence or duplicates are rejected. The name and
instruction are nonblank strings, with maximum lengths of 160 and 16 000
respectively in `String.length`. `primaryContact=true` requires
`humanInputEnabled=true`.

In the initial foundation, `operatorInstruction` is:

> Design and evolve this system with the person, and create operators to handle
> Requests.

The name and mission are model data; they do not change the operator's mandate
or rights. Persisted systems keep their own declarations.

Memory is local to the operator. Capture, recall, revision, review and
withdrawal operations are exposed separately. The initial policy prevents this
operator from admitting its own notes, even if `RevoirMemoire` is exposed.
Review between operators is not implemented yet. Self-admission requires
explicit delegation in an accepted and adopted policy; it is not an independent
review.

## Skill operations

Types come from [`skills.sysml`](../../../models/skills.sysml). Each access
explicitly links the caller, target action and request type. Additional fields
are rejected.

| Initial access   | Action                    | Input                                              | Effect                                                                     |
| ---------------- | ------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| `InstallerSkill` | `APESkills::InstallSkill` | `id`, `url`, optional `expectedDigest`             | Downloads a new local version, initially unloaded.                         |
| `ListerSkills`   | `APESkills::ListSkills`   | Empty object                                       | Returns local metadata without the instruction body.                       |
| `ChargerSkill`   | `APESkills::LoadSkill`    | `id`, `expectedDigest`, optional `offset`, `limit` | Selects this exact version and returns its instruction text.               |
| `DechargerSkill` | `APESkills::UnloadSkill`  | `id`, `expectedDigest`                             | Removes this version from the selection without deleting its installation. |

A skill's local identifier starts with a lowercase letter or digit and contains
at most 120 characters: lowercase letters and digits with the separators `-`,
`_` and `.`. Digests are SHA-256 values of 64 lowercase hexadecimal characters.

Catalogues belong to individual operators and are persisted in scoped PostgreSQL
records. Exact skill documents are retained in the common model Git repository
and resolved through immutable source bindings. Operations retain caller,
invocation, model version, digest and catalogue revision. An installed
identifier denotes immutable content: installing different content under that
identifier is a conflict. Reinstalling the same content from the same source
keeps its loaded or unloaded state. There is no catalogue deletion operation
yet.

Loading and unloading also require consultation access. Returning instructions
requires consultation and loading access. The context service reevaluates the
current limits and access rights. A successful `ChargerSkill` result supplies
the exact selected text once, as a native tool result. The provider's pin card
contains the skill index; subsequent calls do not repeat `skills.loaded`.
Installation, listing and unloading receipts contain metadata only. A replay
after a later unload does not reactivate or return the old instruction text.

The current `LoadSkillRequest` supports UTF-16 character `offset` and `limit`
(defaults 0 and 4096; maximum limit 4096). The result contains `content`,
`range` and, when more remains, `next` with the exact next selection. Each
native page fits 7168 serialized JSON characters, leaving room for the host's
call status and evidence reference. Existing pins with the historical two-field
request still return the whole selected document; they do not acquire page
selectors. Large legacy results use the host's bounded journal reference. A
skill's text grants no permission. Unloading removes the current selection; it
does not purge historical conversations.

## Acquisition and limits

The URL must point to a path ending in `SKILL.md`, over HTTPS, with a DNS host
present exactly in `allowedHosts`. Credentials in the URL, fragments and ports
other than 443 are rejected. All redirects are rejected and the response URL
must remain the requested URL. The download limits both the declared size and
the bytes actually received, with a default total timeout of 15 seconds. The
file must be nonempty UTF-8 text with no null character. Optional frontmatter
may provide `name` and `description`; these fields are used only for display.

This implementation installs a single instruction file. It does not extract
archives, execute scripts or download resources referenced by the Markdown.
Downloaded sources do not silently replace already installed content. The digest
proves the identity of the bytes, not the quality of the instructions.

The policy accepts 1 to 128 installations, 1 to 128 simultaneously loaded skills
without exceeding the number of installations, and ceilings from 256 to 1 048
576 for file bytes and loaded characters. It accepts at most 32 distinct hosts.
The initial configuration values are lower than these technical bounds. A new
load exceeding a limit is rejected without changing the selection. If already
selected instructions exceed a newly adopted limit, returning them fails
explicitly before calling the provider; they are not truncated to continue the
decision.

In the latter case, the agent in this chat can no longer unload skills or
propose a revision. Unloading the relevant skills before adopting lower limits
prevents this blockage. Once blocked, the flow requires host intervention or a
revision prepared outside this chat, accepted and adopted through the existing
paths, to restore a compatible policy.

## Initial tool catalogue

`deno task system create <nom> --initial-tools=catalogue.json` transforms the
manifest into `AssemblyInitialTools::ToolSeed` occurrences under the local
catalogue. The manifest contains exactly `format: 1` and `tools`, with at most
eight entries. Each entry has exactly these fields:

| Field         | Contract                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `id`          | Unique identifier of 1 to 128 characters: letters, digits, `_`, `.` or `-`, starting with a letter or digit. |
| `name`        | Unique nonempty name, at most 120 characters.                                                                |
| `description` | Nonempty text, at most 4 000 characters.                                                                     |
| `kind`        | `read_web_page` or `read_web_page_outline`.                                                                  |
| `code`        | Nonempty standalone module, at most 40 000 characters.                                                       |

The JSON file is limited to 384 000 characters. The selection retains the exact
code in the model; it carries neither active status nor verdict. The engine
creates candidates and applies the usual tests and admission. When admission is
pending, it waits for a decision before preparing the next candidate. Resume
does not duplicate candidates already prepared or silently replace a candidate
whose selection has changed.

The [HTML contracts](../../../src/domain/work/candidates.ts) and engine
permissions continue to apply. This catalogue is not a general integration for
plugins, MCP or external tools.

For procedures, see
[starting a system](../../how-to/atelier/demarrer-un-systeme.md) and
[managing skills](../../how-to/contexte-et-memoire/gerer-les-skills.md). For
their role in design, see
[building with patterns](../../explanation/bibliotheque-ape/construire-avec-les-patterns-ape.md).
