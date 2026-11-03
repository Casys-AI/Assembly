# Model validation

The linter advises the designer. APE patterns are optional and warnings do not
block execution. Compiler refusals retain their own mechanism.

## Available rules

As of 25 October 2026, `lintModelDiagnostics` emits five rules. Severity
describes the recommendation; `finding` describes what the model facts
establish. `present` is not proof of execution, and `indeterminate` does not
prove absence.

| Code                        | Severity | Finding       | Scope                                                                                          |
| --------------------------- | -------- | ------------- | ---------------------------------------------------------------------------------------------- |
| `LOOP_WITHOUT_BUDGET`       | warning  | absent        | Executable conversation or plan without an invocation budget policy                            |
| `SELF_ADMINISTERED`         | info     | present       | Admission of an operator's own candidates assigned to that operator (`admissionMode: builder`) |
| `NO_ACCOUNTABLE_OWNER`      | warning  | indeterminate | The projector does not provide a human accountability declaration for the unit                 |
| `EFFECT_NOT_VERIFIED`       | warning  | absent        | Exposed behavior with a typed effect but no `WorkResultContract` associated with that exposure |
| `CAPABILITY_BEYOND_MANDATE` | warning  | present       | `SkillPolicy` hosts outside the network mandate's hosts                                        |

`EFFECT_WITHOUT_ADMISSION` and a source diagnostic named `AUTHORITY_INVARIANT`
are not implemented. Further model-doctor work remains open.

## Reading diagnostics

### System screen and exact scoped reads — 30 October 2026

**System > Diagnostics** now consumes the existing Doctor result and a separate
SHACL report; this adds no rule, health score, repair or masking workflow.
`GET /api/model/diagnostics/shapes?version=commit:<40 lowercase hex>` returns
`{version,report}` with the existing build/shapes/engine identity, conformance,
mapped diagnostics and unmapped-result count. Exact version is mandatory; there
is no implicit Main-head fallback. SHACL failure is separate from Doctor output.

Request reads use the existing authenticated
`/api/case-model/<caseId>/api/model/...` facade for Doctor, shapes and
Attention, resolving permitted exact versions and revalidating current control.
Main and historical reads keep their existing boundaries. The UI rejects
conflicting Doctor/SHACL source digests and stale scope/session results,
separates masked findings from active counts, and keeps Attention nonadditive.
Actual Main and Request displays have bounded browser evidence in the UX
qualification of 30 October 2026; lower SHACL, narrow Diagnostics and
source-click browser checks remain open. The older API and rule descriptions
below retain their own existing semantics.

**Later 30 October owner steer:** the UI will present one findings list, with
exact full-content deduplication and producer/report provenance in details.
Doctor's five existing TS rules and the two existing overlapping budget/host
SHACL mappings remain separate implementations, not small-versus-global checks.
The API contracts above stay separate; unavailable sources, digest mismatch and
unmapped results cannot disappear into a clean unified count. Earlier tests and
screenshots precede this UI delta; targeted requalification remains root-owned.
Scope is desktop only, not a mobile product.

`GET /api/model/diagnostics` reads the current version.
`GET /api/model/diagnostics?version=commit:IDENTIFIANT` selects an immutable
version from the Git repository. To examine a proposal before acceptance, use
its `proposalVersion`.

```json
{
  "version": "commit:IDENTIFIANT",
  "sourceDigest": "DIGEST_DES_SOURCES",
  "diagnostics": [
    {
      "code": "LOOP_WITHOUT_BUDGET",
      "severity": "warning",
      "pattern": "3.6",
      "elementId": "operator-id",
      "qualifiedName": "Workshop::operator",
      "source": { "file": "workshop.sysml", "line": 12, "column": 3 },
      "finding": "absent",
      "message": "Conversation unit has no invocation budget policy.",
      "remedy": { "kind": "revision-template", "template": "work-budget" },
      "masked": false
    }
  ]
}
```

`severity` is `error`, `warning` or `info`. `finding` is `absent`,
`indeterminate` or `present`. `pattern`, `elementId`, `qualifiedName`, `source`
and `remedy` are optional. Positions refer to the sources of the version being
read. Diagnostics are sorted stably and cached by source digest; masks are
reread on every consultation.

## Masking

`POST /api/model/diagnostics/masks` receives JSON:

```json
{ "code": "LOOP_WITHOUT_BUDGET", "elementId": "operator-id", "masked": true }
```

The response is
`{ "mask": { "code": "LOOP_WITHOUT_BUDGET", "elementId":
"operator-id", "masked": true } }`.
With an `elementId`, the mask identifies the `code`/`elementId` pair. Without an
`elementId`, or with `elementId: null`, it covers that code throughout the
model. Current warnings and information diagnostics can be masked; errors never
can, even if a preference already exists. A global mask is refused if the code
identifies a current error. `masked: false` removes the preference for that
scope, including when its cause has disappeared; removing a local mask does not
remove a global mask for the same code, and vice versa. Masks apply to the
versions being read and persist in the `model-diagnostic-masks.json` file in the
instance's data directory. This changes no model source. A masked diagnostic
remains in `diagnostics` with `masked: true`; only removing its cause removes
the diagnostic.

HTTP errors carry `{ "code": "CODE_MACHINE", "error": "Message" }`:
`INVALID_VERSION`, `INVALID_MASK`, `INVALID_REQUEST` (400),
`DIAGNOSTIC_NOT_MASKABLE` (400), `DIAGNOSTIC_NOT_FOUND` or `NOT_FOUND` (404),
`JSON_REQUIRED` (415), `METHOD_NOT_ALLOWED` (405), `ORIGIN_DENIED` (403). A
technical failure carries a code and a 500 or 502 status. Commands check origin
in the same way as the local workbench's revision routes.

Diagnostic messages, HTTP errors and the diagnostic instruction in the prompt
are in English.

## Proposed corrections

The main agent's `propose_sysml_revision` and `propose_sysml_edit` decisions can
include
`addresses: [{ "code": "LOOP_WITHOUT_BUDGET",
"elementId": "operator-id" }]`.
Each pair must match an existing diagnostic in `baseVersion`. This check reads
the complete list, even when the diagnostic is masked or absent from the limited
excerpt supplied to the prompt. An unknown or malformed reference prevents
proposal creation. The optional field is preserved in the proposal record and
API list. It records an intended correction; only comparing the versions'
diagnostics establishes resolution.

## Events

The existing `GET /api/events` stream emits `diagnostics` after revalidation of
a proposed, published or adopted version:

```json
{
  "version": "commit:IDENTIFIANT",
  "sourceDigest": "DIGEST_DES_SOURCES",
  "counts": { "error": 0, "warning": 2, "info": 0 }
}
```

Counts include masked diagnostics. A failed revalidation emits no successful
summary and does not undo a mutation already performed. Reading versions does
not create a new `diagnostics` event.

The `model-version` event separately describes the admitted HEAD and proposal
journal:

```json
{
  "head": "commit:IDENTIFIANT",
  "sourceDigest": "DIGEST_DES_SOURCES",
  "proposals": { "pending": 1, "digest": "DIGEST_DU_JOURNAL" }
}
```

`pending` counts the `preparing`, `proposed` and `accepting` states. The SHA-256
digest covers identities, statuses, source digests and proposed/accepted
versions, sorted by identity. This read is advisory, with no write lock or
journal recovery; an unreadable proposal directory is omitted with a coded
warning. A single proposal's version never becomes this event's HEAD.

Each connection receives this initial summary when the read succeeds, alongside
`state`, `conversations` and `cases`. If the read fails, only `model-version` is
omitted with a warning: the response remains an SSE stream. After an observed
mutation (including rejection), a change to HEAD or the journal produces an
event; a comment without a model or journal change remains silent. A
notification failure does not undo the mutation, and notification may be
retried.

## Scope

These routes belong to the workbench's designer surface on loopback; they do not
establish a human identity. Only the main chat context receives up to 20
unmasked warnings and errors. The agent reports them on opening and proposes a
revision through the authorized paths, without making patterns mandatory.

Recognized effects are construction through `reuse-tool`, memory writes through
`capture`/`revise`/`review`/`withdraw`, and skill operations through
`install`/`load`/`unload`. Task text, an inbox, a plan or an untyped external
publication is not enough to prove an effect. Current rights do not support
generic comparison of a `BehaviorAccess` action against its mandate; that
comparison is excluded. Violations already refused by compilation remain
refusals.

The initial model now declares a human owner holding the authority root.
However, `projectModelDiagnosticFacts` still sets
`accountableHumanDeclared: false` for conversations and plans, without reading
`ownerAuthority`. `NO_ACCOUNTABLE_OWNER` must therefore not be read as proof
that the model contains no owner. The connection to this declaration and its
scope per unit remain to be checked. An owner declaration does not prove
acceptance of accountability either; human admission and `humanInput` do not
prove it.

The API, masks and reporting to the agent are available. The diagnostic panel,
source underlines and frontend correction actions remain open work.

Sources: [rules](../../../src/domain/model/policies/diagnostics.ts),
[facts projection](../../../src/adapters/model/diagnostics/source.ts) and
[modeled authority](../operateurs/autorite-du-modele.md).
