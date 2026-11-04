# Install skills and load them into context

This guide uses the chat of a system whose admitted model exposes
`InstallerSkill`, `ListerSkills`, `ChargerSkill` and `DechargerSkill`. The
[initial foundation](../atelier/demarrer-un-systeme.md) provides these
operations. Skills are managed through these native operations; there is no
dedicated installation screen.

The requests below tell the agent what to do. Check its call receipts and the
returned statuses: a written reply without a call does not prove that a skill
was installed or loaded.

## Inspect Assembly’s initial skill

In the chat, ask:

> List the installed skills with their identifiers, digests and loaded states.
> Use the native inspection operation.

`ListerSkills` takes an empty object. On a new system, the result includes
`assembly-modeling`, installed from `bundle:assembly-modeling` and loaded. The
list contains metadata without copying the instructions. The `loaded` field
identifies the selection. Limits are checked when loading a skill and when
preparing context. The consequences of a refusal depend on when the limit is
exceeded, as described below.

## Download and install a version

Choose an HTTPS URL pointing to the raw text of a `SKILL.md` file. New systems
allow no download hosts. First prepare an accepted and adopted source revision
that explicitly authorizes the exact host in
`APESkills::SkillPolicy.allowedHosts`. If the operator network mandate does not
list that host, `CAPABILITY_BEYOND_MANDATE` reports a warning. For a
reproducible version, use a URL containing a commit and provide its SHA-256
digest if it has already been verified.

Ask the agent, replacing the values in angle brackets:

> Install skill `<identifier>` from `<exact SKILL.md URL>` without loading it.
> Report the resulting digest and its state.

The input to `InstallerSkill` contains `id`, `url` and optionally
`expectedDigest`. For a new installation, the receipt must show `loaded: false`.
Reinstalling the same content from the same source preserves the existing loaded
or unloaded state. No scripts or neighboring files from the remote repository
are installed. The download stores local UTF-8 text; it does not automatically
follow its Markdown references.

To allow another host or increase a limit, propose a change to
`APESkills::SkillPolicy`, then have it accepted and adopted through the
[revision workflow](../evolution/reviser-systeme.md). An instruction inside a
skill does not change that policy.

## Load and unload a skill

Use the exact identifier and digest from the receipt or a fresh listing:

> Load skill `<identifier>` with digest `<exact digest>`, then list the skills
> to check its state.

`ChargerSkill` takes `{id, expectedDigest}`. The selected text enters subsequent
decision contexts under its provenance and version. Its content changes neither
the mandate, call permissions nor admission rules.

To remove it from the selection:

> Unload skill `<identifier>` with digest `<exact digest>`, then check its state
> with a fresh listing.

`DechargerSkill` uses the same fields. The `loaded: false` state and
installation persist across restarts. Unloading deletes neither the installed
text nor the operation history. It does not remove anything the agent has
already quoted or used from earlier messages.

## Lower limits without blocking the chat

A new load that would exceed a limit is refused without changing the selection.
If the current selection remains compatible, the chat stays usable: the agent
can unload a skill and retry the load, or propose a suitable policy.

Before adopting lower limits, unload the necessary skills under the policy that
still applies. Check that the remaining selection fits the new ceilings, then
adopt the revision.

If an overly restrictive policy has already been adopted, reading the skills can
fail before the provider call. The agent in that chat can then neither unload a
skill nor propose its own repair. Recovery requires host intervention or a
revision prepared outside that chat, then accepted and adopted through the
existing workflow to restore a compatible policy. Repeating an unload request in
the blocked chat is not enough.

## Handle a refusal

| Refusal                                                            | Useful next step                                                                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Forbidden host, URL or redirect                                    | Check the raw URL and admitted policy before proposing a change to it.                                                                 |
| Digest mismatch                                                    | Read the installed version again; do not substitute another digest to hide an unexpected change.                                       |
| Identifier already installed with different content                | Choose a new version identifier and unload the old version if it should no longer guide the agent.                                     |
| New load refused because it exceeds a limit                        | If the current selection remains compatible, unload a skill or propose a suitable policy from the chat.                                |
| Context preparation blocked after adopting limits that are too low | Restore a compatible policy through host intervention or a revision prepared outside that chat; the blocked chat cannot repair itself. |
| Operation not exposed or model awaiting adoption                   | Check access and adopt the authorized version before retrying.                                                                         |

See the
[foundation and skills reference](../../reference/contexte-et-memoire/socle-initial-et-skills.md)
for formats, initial values and the limits of this implementation.
