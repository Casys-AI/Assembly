# Check the Claude provider against the real API

This guide runs the real Claude transport test: two designer decisions with all
its tools, followed by a candidate review. It confirms that the API accepts the
tools, that each decision completes and that the prefix is read from cache.
Ordinary tests never call the API; this test costs a few cents.

## Prerequisites

- A Claude API key in `apps/live-builder/.env`, which Git ignores:
  `ANTHROPIC_API_KEY=…`. Optional: `ANTHROPIC_MODEL`, defaulting to
  `claude-sonnet-5-5`.
- The runtime installed by setup under `.data/toolchains/`.

## Run the test

From `apps/live-builder`:

```bash
ASSEMBLY_REAL_CLAUDE=1 .data/toolchains/deno-v2.9.7/deno test --no-prompt --env-file=.env --allow-env --allow-net=api.anthropic.com --filter "réel" src/adapters/out/llm-providers/agents-claude-tools_test.ts
```

`--allow-net=api.anthropic.com` restricts network access to the API. Without
`ASSEMBLY_REAL_CLAUDE=1` or without a key, both tests are ignored. The `réel`
filter matches the existing test names.

## Read the result

Each test prints the `usage` of its calls. A successful test shows:

- `ok | 2 passed`;
- one call per decision. Two calls for the same decision indicate a repair turn;
- on the first call, a few thousand tokens in `cache_creation_input_tokens`:
  tools and fixed instructions are written to cache;
- on the second call, the same quantity in `cache_read_input_tokens`, with
  `input_tokens` reduced to the turn's context.

The second call must follow the first within five minutes to read the cache;
that is the case in this test.

## Troubleshooting

| Message                                              | What to check                                                                                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `HTTP 400`                                           | A parameter or tool schema was rejected: compare the request with the [contract](../../reference/execution/transport-claude.md#requête). |
| `HTTP 401` or `HTTP 403`                             | Missing or invalid key, or no access to the model.                                                                                       |
| `HTTP 429` or `HTTP 529`                             | Rate limit or overload: try again later.                                                                                                 |
| `invalid tool decision schema after repair (<code>)` | The model did not produce a valid decision within two calls; the code explains why.                                                      |
| `incomplete completion (refusal)`                    | The model refused the request.                                                                                                           |
| Zero `cache_read_input_tokens` on the second call    | The prefix changed between calls, or more than five minutes elapsed.                                                                     |

Error categories are described in the
[transport reference](../../reference/execution/transport-claude.md#erreurs).
