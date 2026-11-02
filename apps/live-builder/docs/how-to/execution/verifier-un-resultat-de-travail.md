# Verify a work result — Verified-Effect Closure

Use a result contract when a plan's progress must depend on an effect verified
in its source of truth. You need the system's sources and the rights required to
revise them. This procedure describes configuration; it does not report a
successful execution.

1. Define the exact result and the source capable of establishing it. Choose the
   facts to read and the expected values before the work starts. A transport
   receipt or a statement in chat is not enough.
2. Find the native access to the work. Provide a separate read action, its
   allocation to the authoritative source and its `BehaviorAccess` for the
   caller. Declare a typed output matching the observed item. The reader must
   report raw facts and their provenance; it does not choose the business
   criterion.
3. Define flat items for expected values and observed facts. Use the scalars and
   operators in the
   [admitted subset](../../reference/execution/resultats-verifies.md). If a read
   query is needed, define its type. For per-call values, type `input` as the
   work input and bind it to the exact `work` access. Bind fields of `expected`
   or `query` to scalar fields of that `input`; use a literal for fixed values.
4. Import `verified-effect-closure.sysml`. Add a direct occurrence of
   `APEVerifiedEffectClosure::WorkResultContract` in the calling
   `ConversationSystem`. Bind `work` and `observation` to their separate
   accesses; type `expected`, `observed` and, if necessary, `query`. Declare the
   `condition` constraint that compares the facts with the expected result. Set
   `maxObservations` between 1 and 8.
5. Have the revision accepted and then adopted. Verify the identities, version
   and rights actually admitted. Importing the library alone creates no access.
   An old v1 plan must be explicitly readmitted before execution under the v2
   contract.
6. Execute the plan and inspect the task's technical state separately from
   `resultVerification`. Only `verified` allows protected progress. Keep the
   correlations, sources and observations supporting that conclusion.
7. If the result remains uncertain, explicitly resume the same plan to observe
   again within its remaining budget. Do not reissue the protected work's write
   when it is complete or uncertain. On exhaustion, or if the contradiction
   persists, keep the obligation open and handle the remaining work under the
   appropriate authority.

For a published tool, the `AssemblyWork::InspectWorkArtifacts` reader provides a
specialised profile, and the model expresses its condition using
`AssemblyToolPublicationResult::PublicationExpectation` and
`AssemblyToolPublicationResult::PublicationObservation`. For another domain, an
admitted reader must access its actual source of truth. Fixtures with distinct
criteria are neither an integration with a real ERP nor proof of universal Case
closure or transfer of responsibility.

## Example condition and bindings

In an occurrence with typed expected and observed items, the condition remains a
native expression:

```sysml
constraint :>> condition {
    observed.status == expected.status and
    observed.amount >= expected.amount
}
```

The owning system then binds the values specific to the work:

```sysml
bind resultContract.input = collectorAccess.input;
bind resultContract.expected.status = resultContract.input.status;
bind resultContract.expected.amount = resultContract.input.amount;
bind resultContract.query.recordId = resultContract.input.recordId;
```

These excerpts assume that the accesses and types have already been declared.
The
[`verifiedBoundRecordSources`](../../../test/support/verified-work-fixture.ts)
fixture provides the complete native assembly used for qualification. The reader
and effect in this record scenario remain test implementations.
