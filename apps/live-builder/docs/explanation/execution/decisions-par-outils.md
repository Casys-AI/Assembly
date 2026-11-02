# Why agent decisions use tools

At the modeled choice step, the operator chooses among structured requests:
reply, consult the model, invoke a tool, propose a revision, and so on. With the
Claude API, each request is a **native tool call**, with one tool per exposed
decision type. `LangChainAgents` supplies the SDK transport; the admitted flow
and host handlers retain execution. This document explains that boundary. The
[transport contract](../../reference/execution/transport-claude.md) provides the
details.

## The agent requests; the host decides

A tool call executes nothing. The called tool's name identifies the decision
type; its input carries the arguments. Assembly reconstructs the decision, then
validates it with the same Ajv schema used for other providers. The host's
controls then apply unchanged: mandate, editing rights, admission, digest and
model version.

Tools declared to the API are therefore not capabilities. They describe the
shape of admissible requests. An input the API accepts may still be rejected by
Ajv and then by the host. Free text outside a tool call is never executed.

`StructuredAgents` filters the exposed schema using the host-provided context
and checks the returned decisions against those capabilities. This helps the
operator choose a relevant request; it does not replace admission. Host handlers
check the current model, exact target and authority before the operation. A
successful provider call grants no rights.

## A bounded vocabulary that can evolve

`ChatDecision` and its validation schema define the implemented request types.
They are a closed execution boundary, not a universal list of agentic actions.
Adding a type requires its contract, schema, provider description and host
handling with the relevant controls. The former freeze on `ChatDecision` has
been explicitly lifted. These request types remain distinct from the SysML
action primitives that route and execute them.

## What strict output could no longer support

Until October 25, 2026, Claude returned its decision as **strict JSON**
(`output_config.format`) against the union of all permitted decisions. The API
compiles that schema into a grammar. Measurements taken that day with
`claude-sonnet-5-5` show a limit of about 60 properties in total:

- the designer, with 8 decision types and 57 properties, just fitted;
- a ninth real type caused every call to fail (“compiled grammar is too large”);
- **strict** tools failed in the same way;
- **non-strict** tools worked with both 11 and 41 tools.

Each new decision would have moved every agent closer to that limit. Non-strict
tools remove it: their schemas guide the model without being compiled into a
grammar. Exact validation remains local.

<a id="one-decision-per-turn"></a>

## Bounded calls from one response

Conversation choices use `decideBatch`: one response may contain one to eight
calls, each with its own identifier and arguments. Singleton `decide`, candidate
review and admission still expect one call. Group validation runs before
dispatch; a terminal decision must be last. The admitted flow processes the
selected requests with their individual controls and results. Several calls in a
provider response do not authorize parallel effects.

The transport uses `tool_choice: auto`, permitting multiple provider calls only
for a batch. Invalid calls receive at most **one** repair turn with a coded
error; a second invalid response fails. SDK retries are disabled. No agent loop
or tool execution lives in the transport. The
[transport reference](../../reference/execution/transport-claude.md#response-and-repair)
describes group ordering, repair and correlated results.

## The cost: a stable, cached prefix

Previously, about 3,100 tokens of instructions were sent in the user message on
every call, without caching. Tools followed by fixed instructions now form an
identical prefix for a given session type. The API caches that prefix and reads
it at a reduced price on subsequent calls. Turn context (state, sources and
messages) and conditional instructions follow the prefix in the user message.

Adding a decision type costs a few hundred tokens of tool definition. That cost
is paid once when writing the cache, then read again.

## What stays unchanged

- Providers share the structured decision contracts and local validation;
  transport does not define the operator's mandate or action flow.
- `MuseAgents` keeps its JSON output: the format remains provider-specific, and
  shared instructions do not depend on it.
- Output budgets, effort and a revision's source map are unchanged.

This is standard practice for model APIs (_function calling_). It allows other
providers to use the same decision contract.
