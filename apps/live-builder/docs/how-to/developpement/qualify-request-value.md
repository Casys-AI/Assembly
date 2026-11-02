# Qualify the Request value flow

This qualification uses an isolated temporary repository and PostgreSQL test
schemas in the dedicated local `assembly_pg1_test` database. It starts with an
owner-authorized source profile: one Request owner, two durable operators,
`authorized-host` URL selection and no initial network access. The setup
publishes and adopts separate Main grants for `docs.deno.com` and exact
`read_web_page` candidate admission before the Request starts. It does not turn
a delegated message into a human URL authorization. The profile is limited to
this qualification; it does not grant recursive creation or local-file access.

Run from `apps/live-builder`, with the pinned Toolkit path in
`SYSML_TOOLKIT_DIR` and an explicitly selected `ASSEMBLY_POSTGRES_TEST_URL`,
after the centrally scheduled native checks have a slot. Use the bounded
`test:postgres-toolkit` profile so both prerequisites remain enabled and the
shared test lock prevents competing campaigns. The fixture owns and cleans only
its unique test schemas; it never selects the application's database implicitly.

```sh
ASSEMBLY_SEMANTIC_INTEGRATION=1 \
  .data/toolchains/deno-v2.9.7/deno task test:postgres-toolkit --allow-slow \
  test/integration/request-value-profile_test.ts \
  test/integration/request-value-flow_test.ts
```

The flow test uses a scripted provider, controlled HTML responses and the real
local generated-tool sandbox. The controlled test explicitly asserts overlapping
sandbox tests and reverse return order, alongside exact plan receipts. The
real-run parallelism criterion is overlapping candidate-bearing task attempts
for the same Root Request, with distinct resources, invocations and
correlations; sandbox overlap there is an observation and both sandbox reports
must pass. The controlled test must pass before considering the opt-in real
provider run. A skipped test is not a qualification. The controlled pages are
fixtures and are not evidence about Deno documentation. This test exercises
continuation replay; it does not claim an interrupted full value flow has been
restarted. Restart evidence in `request-team-workspace_test.ts` concerns its
separately scoped team flow.

For a separately scheduled real run, point Deno at the existing credential file
without copying it. The file must provide `ANTHROPIC_API_KEY` and
`ANTHROPIC_MODEL`; set `SYSML_TOOLKIT_DIR` and the dedicated
`ASSEMBLY_POSTGRES_TEST_URL` separately. Keep this opt-in provider run
separately scheduled; it is not a normal cleanup or storage test.

The [live entry point](../../../tools/qualify-request-value.ts) does not acquire
the shared test lock. Live qualification therefore requires separately
coordinated exclusive execution, with no other campaign running for its full
duration. A standalone executable example is intentionally omitted until that
coordination is provided.

Without `--live` the entry point makes no provider or page request. Live mode
caps provider HTTP requests, including unsuccessful and repair requests, at 32,
sets a twenty-minute deadline for the complete campaign, including native setup,
and bounds the report. The longer total bound follows the observed controlled
native flow exceeding seven minutes; individual provider decisions retain their
60-second timeout and all attempts share the same 32-request ceiling. A loop
does not extend that deadline. Provider request count is not currency cost. The
tool retains `qualification-report.json` in the printed temporary directory,
including failure evidence; runtime state uses its separately owned PostgreSQL
test schemas. The report records `mechanismCompleted` separately from
`valueReview`, which remains pending for human review. It records each observed
nonempty title and text excerpt, text digest, candidate digest and Main's reply.
The `sourceEvidenceCollection` field distinguishes validated source evidence
that was never reached, partly collected, or completely collected before a
failure. Each operator's `finalJournalFacts` independently records bounded
available tool call/completion counts, actual page-observation metadata and
observed plan states. An empty `observedSources` array alone therefore does not
establish zero reads.

Root Request status is recorded independently: an open or waiting Request may
already contain the completed requested result. The live check still requires
both active, tested, exactly admitted tools, both actual source observations and
no unresolved work plan or candidate. Parallel preparation requires overlapping
recorded attempts for the exact two preparation assignments, correlated to the
same Root Request, owner, distinct operator resources, invocations and candidate
identities. Waiting gaps between continuations do not count. Sandbox-call
overlap is recorded as an observation; the two passed sandbox reports remain
mandatory. The driver consumes the production `assembly-work-plan-result/v1`
view and its exact `graph`; full historical receipts remain in the isolated plan
store.

An output's usefulness and its interpretation of Deno documentation require
review against the actual sources. Candidate attribution is reported only when
the operator's retained journal has exactly one ordered call and completion for
the same candidate and exactly one matching page feedback. Multiple calls or
results are treated as ambiguous and make this qualification incomplete. Usage
is marked incomplete if a response omits usage metadata or if a provider request
has no completion metadata. A deadline, unavailable provider, unfinished
contribution or missing result is a failure, not acceptance. The report also
records metadata from actual provider payloads: projected-context character
counts, message and candidate counts, operator and Request identities. It does
not record credentials or copy the credential file.

Inspect the report for the exact Request, operator identities, policy changes,
candidate digests and tests, source versions, messages and actual tool results.
Only the two returned public-page contents support claims about those pages; the
distinction between Deno permissions and Assembly's sandbox is a separate
technical observation. Review the result before reuse. This qualification does
not qualify the browser's System/Model refresh or historical view: those require
a separate normal application and browser check.
