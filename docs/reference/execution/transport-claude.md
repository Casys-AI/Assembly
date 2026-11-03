# Decision transport to the Claude API

[`LangChainAgents`](../../../src/adapters/out/llm-providers/langchain-agents.ts)
uses `ChatAnthropic` to send structured decisions as native tool calls. The
composition root selects this adapter; `ClaudeAgents` remains a compatibility
export. The SDK handles HTTP and message conversion, while Assembly validates
requests and retains authority, execution and durable state. The
[explanation](../../explanation/execution/decisions-par-outils.md) gives the
reasons; the
[practical guide](../../how-to/execution/verifier-le-fournisseur-claude.md)
shows how to try it against the real API.

<a id="configuration"></a>

## Configuration

`src/main.ts` reads the environment through
[`resolveProviderConfiguration`](../../../src/composition/provider-configuration.ts).

| Variable                        | Default             | Effect                                               |
| ------------------------------- | ------------------- | ---------------------------------------------------- |
| `AGENT_PROVIDER`                | `claude`            | `muse` selects `MuseAgents`.                         |
| `ANTHROPIC_API_KEY`             | none                | Key sent in the `x-api-key` header.                  |
| `ANTHROPIC_MODEL`               | `claude-sonnet-5-5` | Model called.                                        |
| `ANTHROPIC_EFFORT`              | `high`              | `low`, `medium`, `high`, `xhigh` or `max`.           |
| `ANTHROPIC_DECISION_MAX_TOKENS` | none                | Decision output budget, an integer from 1 to 65 536. |

Without `ANTHROPIC_DECISION_MAX_TOKENS`, a decision has 4 096 output tokens, or
16 384 when its context contains model sources. Candidate review and admission
keep their budget of 2 048. See the
[effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort).
These technical parameters change no model rights. A truncated response remains
a failure: its usage is recorded and no partial result is executed or retried
automatically.

<a id="requête"></a>

## Request

The adapter pins `ChatAnthropic` to `https://api.anthropic.com`. The SDK sends
the Messages request with the following configured values:

| Field           | Content                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `model`         | `ANTHROPIC_MODEL`.                                                                                                          |
| `max_tokens`    | The budget described above.                                                                                                 |
| `system`        | Constitution, pin-capability instructions and compact pin card, followed by the transport instruction with `cache_control`. |
| `tools`         | Fixed decision types for the admitted pin and invocation type; the last carries `cache_control`.                            |
| `tool_choice`   | `auto`; `disable_parallel_tool_use` is false for batches and true for singleton calls.                                      |
| `messages`      | A bounded host-built turn brief, then native assistant calls and correlated results, appended in order.                     |
| `output_config` | `{effort}` only.                                                                                                            |

No tool is `strict`, no JSON output format or `thinking` parameter is imposed.
Streaming and SDK retries are disabled. One deadline, 120 seconds by default,
covers the call and its optional repair; the response is capped at 1,000,000
bytes before SDK decoding.

Conversation choices use `decideBatch`, whose instruction permits one to eight
tool calls. Singleton `decide`, candidate review and admission require exactly
one. Free text is never a decision. Instructions shared with Muse do not name an
output format.

## Exposed tools

The tool name is the decision's `kind`. Its `input_schema` is the decision
variant without `kind`. The current conversation schema has 18 distinct kinds;
`review_decision` is a separate review/admission contract. These are implemented
request types, not a universal action catalog or grants. Exposure is filtered by
[`StructuredAgents`](../../../src/adapters/out/llm-providers/structured-agents.ts);
the host still checks each requested operation against the admitted model.

| Tool                                                      | Exposed when                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `reply`                                                   | always                                                                          |
| `consult_model`                                           | the admitted pin exposes model read operations                                  |
| `propose_tool`                                            | always                                                                          |
| `invoke_tool`                                             | always                                                                          |
| `invoke_behavior`                                         | always                                                                          |
| `propose_mandate_change`                                  | always                                                                          |
| `propose_sysml_revision`                                  | `modelEditing.rawRevision` is true and the policy contains `replace-source`     |
| `propose_sysml_edit`                                      | `modelEditing.targetedEdits` is true and the policy contains another operation  |
| `propose_model_delegation`                                | `modelAdministration` is present                                                |
| `decide_operator_change`                                  | `operatorAuthority.policies` is nonempty                                        |
| `inspect_operator_candidate`, `decide_operator_candidate` | `operatorToolAdmission.policies` contains an enabled policy                     |
| `open_request`                                            | Main's admitted mandate grants the open-request act                             |
| `resume_request`                                          | Main's design invocation exposes Request continuation, even with no open target |
| `prepare_operator_evolution`                              | `operatorEvolution.capabilities.prepare` is true                                |
| `decide_operator_evolution`                               | `operatorEvolution.capabilities.accept` is true                                 |
| `adopt_operator_evolution`                                | `operatorEvolution.capabilities.adopt` is true                                  |
| `propose_agent_creation`                                  | always; one tool for both variants, with `role` set to `operator` or `reviewer` |
| `review_decision`                                         | the only tool in a candidate review or admission                                |

Within `propose_agent_creation`, the Request-team variant follows the pin's
creation grant. Invocation still requires an open or waiting Request and
remaining child capacity. Within `propose_mandate_change`, requesting a
tool-admission grant requires that supported change in the mandate. An exposed
kind does not imply that every argument or target is permitted. State changes do
not remove tools: for example, an unavailable continuation receives a coded
`RESUME_TARGET_UNAVAILABLE` result with `context` and `recovery`. The host's
authority checks remain mandatory at execution.

The schemas sent are a subset of the decision schema:

- `oneOf` becomes `anyOf`;
- limits are removed: `minLength`, `maxLength`, `minimum`, `maximum`,
  `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `pattern`, `minItems`,
  `maxItems`, `uniqueItems`, `minProperties`, `maxProperties`, `propertyNames`;
- a revision's file map (`sources`) becomes a list of `{path, content}` pairs,
  with 1 to 16 entries and distinct paths.

The full Ajv schema (`decisionSchema`, `reviewSchema`) still applies to the
reconstructed decision. It is authoritative for structure, followed by the host
for rights.

## Response and repair

A valid response contains one `tool_use` block for a singleton call, or one to
eight for a batch. All names must be exposed and all arguments must pass Ajv
validation. Call IDs must be distinct, nonempty strings without whitespace, at
most 256 characters. `reply`, `decide_operator_candidate` and
`decide_operator_change` are terminal: at most one may appear and it must be
last. A Case-closing reply cannot accompany a preceding `propose_*` request.

The complete group is validated before dispatch. The host applies the admitted
proposal ceiling and controls each selected operation; successful transport
validation does not establish permission or success. Invalid output receives
**one** repair turn:

| Code                      | Cause                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| `NO_TOOL_CALL`            | No tool call; free text is never interpreted.                                    |
| `MULTIPLE_TOOL_CALLS`     | Several calls in a singleton response.                                           |
| `TOO_MANY_TOOL_CALLS`     | More than eight calls in a batch.                                                |
| `INVALID_TOOL_CALL_ID`    | Missing, duplicate or malformed call IDs.                                        |
| `UNKNOWN_TOOL`            | Tool not exposed in this context.                                                |
| `INVALID_TOOL_INPUT`      | Non-object input, conflicting `kind`, invalid sources or Ajv errors (at most 8). |
| `INVALID_TOOL_CALL_ORDER` | A group violates the terminal-decision or Case-closure rules.                    |

Repair retains the previous assistant content, including thinking blocks, and
returns an error result correlated to each call ID, or a text message when no
call was made. Malformed IDs are the exception: the invalid assistant message is
not replayed, because its results cannot be correlated safely. The repair
content is `{code, detail, allowedTools}`, with `detail` limited to 1,500
characters. A batch repair replaces the whole proposed group.

One transport invocation therefore makes at most two API calls. If repair also
fails, it ends with `invalid tool decision schema after repair (<code>)`.

<a id="erreurs"></a>

## Errors

A call error is raised as `Claude request failed: <category>`. Only
host-authored categories cross this boundary; raw SDK errors are neither
attached as `cause` nor copied into the message, because they may contain
headers, credentials or response bodies. An unclassified SDK failure becomes
`provider failure`.

| Category                                                                   | Cause                                                          |
| -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `HTTP <status>`                                                            | Non-2xx HTTP response.                                         |
| `request timed out`                                                        | Decision timeout, including repair.                            |
| `transport failure`                                                        | `fetch` or stream failure, or `AbortError`, outside timeout.   |
| `missing response body`, `invalid response JSON`, `invalid response shape` | Unreadable response.                                           |
| `response-size limit exceeded`                                             | Response too large.                                            |
| `output token limit reached (max_tokens)`                                  | Output budget exhausted; no repair.                            |
| `incomplete completion (refusal)`                                          | Model refusal; also `stop_sequence`, `pause_turn`.             |
| `invalid tool decision schema after repair (<code>)`                       | Repair failed.                                                 |
| `completion observer failed`                                               | Completion metadata could not be recorded within the deadline. |
| `provider failure`                                                         | Unclassified SDK failure.                                      |

Classification is in
[`LangChainAgents`](../../../src/adapters/out/llm-providers/langchain-agents.ts).
The adapter wraps the SDK's fetch to enforce response bounds and error
redaction. A transport failure is not a business refusal.

## Prompt cache

The cached prefix consists, in API order, of **tools** followed by **system**.
The last tool and last system block carry `ephemeral` breakpoints. For a
decision, the prefix contains the host constitution, instructions derived from
pin capabilities, and a short card: operator mission, summarized mandate,
limits, network hosts, one line per behavior with its compact input contract,
skill index and model filenames. The card is memoized by pin digest, operator
and invocation type in a bounded process-local cache. It contains no live
Request status, loaded skill body, model source body or conversation journal.
The same pin and invocation keep the same prefix when a Request opens.

The first message of a turn contains its host-built brief: opening input, Case
objective and status, remaining budget, exact task source URLs, and Main's open
Request targets. It is limited to 4,096 JSON characters (approximately 1,000
tokens, not a provider count). Long input text carries a journal reference. The
host refuses an unrepresentable required brief with a coded error instead of
silently dropping actionable identifiers. Model sources, skill text, memory and
journal evidence are read on demand through their existing tools.

The agent port prepares the request before the host reserves call budget. A
local pin-card or brief limit becomes a modeled `DECISION_CONTEXT_REFUSED` reply
with its cause code, context and recovery; it makes no provider call and
consumes no reserved attempt. Subsequent calls reuse the retained opening brief
before performing any reconstruction or size check against later state.

Completed batches retain the initial brief and native `tool_use`/`tool_result`
exchanges. Later calls append results without rewriting previous messages; tool
observations are not copied into a second state dump. Observations exceeding
8,192 JSON characters carry a bounded preview and an exact journal reference or
repeatable admitted model-read reference. An unreferenceable oversized result is
refused. History exceeding 80,000 JSON characters receives
`DECISION_CONTEXT_REFUSED`; this lot introduces neither LLM summarization nor
automatic compaction. A movable `ephemeral` marker on the last user content
block supplements the tool and system breakpoints. The full durable journal
remains distinct from this provider view. Cache eligibility is not evidence of a
cache hit: real provider counters are measured separately after integration.

`read_source` returns exact source pages with a source digest and a next
request; the whole file remains verified in the editing working set. Skill
loading and journal evidence use optional `offset`/`limit` fields declared in
their SysML contracts. The current seed exposes these paged contracts.
Historical two-field pins retain their admitted schemas: their oversized
observations can require explicit adoption of the paged contract before the
agent can inspect every page. The host never accepts undeclared arguments or
repeats an external effect to recover its observation.

The SDK response metadata's `usage` is passed to `onCompletion`, alongside the
response ID, model and stop reason. Historical measurements are in the 25
October report.

## Differences from Muse

`MuseAgents` receives the same shared instructions and produces the same
decisions, validated by the same Ajv schema, including the batch contract. Its
format remains JSON imposed by `--output-schema`; its format instruction is
appended to `instruction`. The source map keeps its original form there.
