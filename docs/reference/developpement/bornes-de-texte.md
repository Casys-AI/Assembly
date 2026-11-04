# Text limits and character counting

This reference describes how length limits count characters. The decision schema
(`decisionSchema`, `src/adapters/out/llm-providers/output-validation.ts`) and
the domain sometimes constrain the same field. Both must count in the same way.
The full schema still applies to the reconstructed decision, even when its
limits are removed from the schema Claude receives: see
[decision transport](../execution/transport-claude.md).

## `characterCount`

`characterCount(value)` (`src/domain/primitives/character-count.ts:2`) returns
the number of Unicode code points in `value`. This is the length JSON Schema
uses for `minLength` and `maxLength`. `String.length` counts UTF-16 code units:
a character outside the Basic Multilingual Plane, such as an emoji, counts as
two.

| Text                                | `characterCount` | `String.length` |
| ----------------------------------- | ---------------- | --------------- |
| `abc`                               | 3                | 3               |
| Precomposed `é`                     | 1                | 1               |
| `e` followed by a combining accent  | 2                | 2               |
| `😀`                                | 1                | 2               |
| `👨‍👩‍👧` (three emoji, two joiners) | 5                | 8               |

The function does not count graphemes: a joined sequence counts all its code
points. A lone surrogate counts as one. The test
`src/domain/primitives/character-count_test.ts:4` covers accents, the emoji and
the joined sequence in the table.

## Usage rule

- Use `characterCount` where a domain limit duplicates a schema limit on the
  same field. With `String.length`, 150 emoji (150 code points, 300 code units)
  would satisfy `maxLength: 200` but still be rejected by the domain.
- A domain limit with no matching schema limit keeps `String.length`.
- Ajv already counts code points for `minLength` and `maxLength`. Its `unicode`
  option, which can switch back to UTF-16 code units, is deprecated in the
  version used (`deno.json:7`). No `new Ajv` in `src/` passes it.
- Byte limits fall outside this rule: they count UTF-8 bytes. These are
  `MAX_FILE_BYTES` and `MAX_TOTAL_BYTES` for sources
  (`src/domain/model/value-objects/sources.ts:6`, `:7` and `:68`) and `MAX_CODE`
  for tool code (`src/adapters/out/sandbox/runner.ts:28` and `:348`).

The test `src/adapters/out/llm-providers/output-validation_test.ts:356` uses
emoji at the limits to check that the schema and domain accept and reject the
same values for a tool name, diagnostic addresses, an operator specification and
the `maxLength` of a Work result schema. It tests only the schema for a Watch
summary and for a consultation's `inputJson`. The test
`src/domain/governance/policies/operator-authority-policy_test.ts:32` covers a
policy recipient's identity on the domain side only.

## Limits counted by `characterCount`

These are all calls in `src/`, excluding tests. In the last column, `schema:N`
means line N of `src/adapters/out/llm-providers/output-validation.ts`, and
`tools:N` means line N of `src/domain/model/consultation/context.ts`.

| Field                                | Limit             | Code                                                                                                    | Matching schema limit                                                                        |
| ------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Proposed tool name                   | 200               | `src/domain/work/value-objects/tool-name.ts:20` (length reported at `:47`)                              | `schema:76`, through `MAX_TOOL_NAME_LENGTH` (`src/domain/work/value-objects/tool-name.ts:6`) |
| Network host                         | 253               | `src/domain/governance/policies/network-policy.ts:29`                                                   | `schema:37`                                                                                  |
| Source file path                     | 240               | `src/domain/model/value-objects/sources.ts:44`                                                          | `schema:182`                                                                                 |
| Diagnostic address `code`            | 128               | `src/domain/model/value-objects/diagnostic-address.ts:19`                                               | `schema:49`                                                                                  |
| Diagnostic address `elementId`       | 512               | `src/domain/model/value-objects/diagnostic-address.ts:21`                                               | `schema:50`                                                                                  |
| Name of an operator to create        | 80                | `src/domain/governance/policies/change-approvability.ts:184`                                            | `schema:297`                                                                                 |
| Editing right `file` and `root`      | 240 and 512       | `src/domain/governance/operator-authority.ts:170` (called at `:177`)                                    | `schema:103` and `schema:104`                                                                |
| Operator `instruction`               | 4000              | `src/domain/governance/operator-authority.ts:170` (called at `:212`)                                    | `schema:300`                                                                                 |
| Operator Request type name           | 80                | `src/domain/governance/operator-authority.ts:170` (called at `:214`)                                    | `schema:308`                                                                                 |
| First Request objective              | 2000              | `src/domain/governance/operator-authority.ts:170` (called at `:219`)                                    | `schema:311`                                                                                 |
| Policy recipient identity            | 512               | `src/domain/governance/policies/operator-authority-policy.ts:59`                                        | `schema:42`, used at `schema:126`                                                            |
| Model consultation `inputJson`       | 65 536            | `src/application/work/conversation/decision.ts:32`                                                      | `schema:70`                                                                                  |
| Behavior `inputJson`                 | 65 536            | `src/application/governance/behavior-call-admission.ts:94`                                              | `schema:92`                                                                                  |
| Watch response `watchResult.summary` | 4000              | `src/application/work/runtime/system.ts:682`                                                            | `schema:64`                                                                                  |
| Model target `elementId`             | 512               | `src/domain/model/editing/source-index.ts:164`, `src/adapters/model/consultation/readers/source.ts:244` | `tools:87`, `schema:207` through `schema:222`                                                |
| Model query expression               | 4096              | `src/application/model/editing/tooling.ts:20`                                                           | `tools:82`                                                                                   |
| Path read by `read_source`           | 240               | `src/adapters/model/consultation/readers/source.ts:510`                                                 | `tools:91`                                                                                   |
| `search` text                        | 200               | `src/adapters/model/consultation/readers/source.ts:538`                                                 | `tools:76`                                                                                   |
| String value in a Work result        | Field `maxLength` | `src/domain/work/policies/verified-effect-closure.ts:138`                                               | The `maxLength` in the schema received by `validateWorkResultValues`                         |
| Skills policy host                   | 253               | `src/domain/skills/context-skills.ts:144`                                                               | None in the decision schema; same ceiling as the network host                                |

## Matching limits still counted with `String.length`

These limits duplicate a schema limit on the same field and count UTF-16 code
units. They therefore do not follow the rule above.

| Field                                                      | Domain | Code                                                                                                                                                          | Schema                                                                                     |
| ---------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Page URL (`invoke_tool`)                                   | 4096   | `src/domain/work/errors/tool-invocation.ts:46`, `src/adapters/out/sandbox/runner.ts:205`                                                                      | 4096, `schema:86`                                                                          |
| Delegation identifier                                      | 128    | `src/domain/governance/policies/model-edit-policy.ts:23`                                                                                                      | 128, `schema:241` and `schema:288`                                                         |
| Expected value of a Work result text field (SysML literal) | 20 000 | `src/adapters/out/sysml-toolkit/compilation-policies/work/result-condition.ts:249`                                                                            | 20 000, `src/adapters/out/sysml-toolkit/compilation-policies/work/result-condition.ts:134` |
| Reviewer name                                              | 80     | `src/domain/governance/policies/change-approvability.ts:202`, `src/domain/governance/policies/governance.ts:302`, `src/application/model/source-model.ts:809` | 120, `schema:318`                                                                          |

For each, the domain may reject a value that satisfies the schema limit. For a
reviewer name, the two limits also differ.

## Limits without a matching schema limit

These count with `String.length`, as the rule requires. Examples:

| Field                                                                 | Limit   | Code                                                                                                               |
| --------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| Rationale for a mandate change or agent creation                      | 2000    | `src/domain/governance/policies/governance.ts:259`                                                                 |
| Rationale for an admission decision                                   | 2000    | `src/application/work/candidates/decisions.ts:73`                                                                  |
| Skills layer identifiers (`skillIdentity`)                            | 512     | `src/domain/skills/context-skills.ts:97`                                                                           |
| Rationale for a revision proposed through `POST /api/model-revisions` | 4000    | `src/adapters/in/http/model/revisions.ts:476` (through `text`, `:97`)                                              |
| Message text, human or delegated, to a conversation                   | 100 000 | `MAX_USER_MESSAGE_CHARS`, in `src/domain/work/records/conversations.ts`; shared by HTTP and application boundaries |

Since D1 (`ea55739`, 25 October 2026), the message limit has been
`MAX_USER_MESSAGE_CHARS = 100_000`, counted by `String.length` (UTF-16 code
units). The input field no longer has a competing `maxLength`: the server
rejects an overrun and the text remains available for correction. The journal
keeps the entire accepted message; projection to the provider then applies the
context policy. The message limit therefore does not guarantee that the whole
message is transmitted in every decision.

The `POST /api/model-revisions` route and the `propose_sysml_revision` decision
are separate entry points. The schema limits the decision's rationale to 2000
(`src/adapters/out/llm-providers/output-validation.ts:173`).

## Next work

The next task on these limits is:

- One limit, one source. The domain exports the constant and the schema imports
  it, as with `MAX_TOOL_NAME_LENGTH`.
