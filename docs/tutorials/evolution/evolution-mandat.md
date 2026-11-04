# Evolve a mandate through chat

We will ask the builder to read a page, observe a network refusal, examine its
proposal, then authorize the same read. We will then inspect the model change
and the state that preceded approval.

## Prepare the exercise

Use a test instance with an LLM provider configured, and Deno and SysML Toolkit
installed. The flow was verified on macOS with the workbench’s Deno sandbox. The
[second-instance guide](../../how-to/atelier/seconde-instance.md) explains how
to separate its data from a workbench already in use.

Open the chat for this instance. In the builder’s mandate, check that
`example.org` is absent from the allowed hosts. A new instance has an empty
network scope and human admission. If this host is already granted, use a new
test instance to obtain the initial refusal.

The operator’s responses may vary. At each step, rely on the result recorded by
the host and the displayed proposal.

## 1. Have an admitted reader available

If the catalogue already contains an active reader of type `read_web_page`, keep
it. Otherwise, send this chat message:

> Propose a read_web_page tool that extracts the title and full readable text
> from the HTML supplied by the host. Follow the contract and its tests. Do not
> request network access yet.

Inspect the candidate and its test results. When the tests pass, choose **Admit
and integrate** on its card. Check that its status becomes active. Record its
identifier and digest: we will keep this same reader.

## 2. Observe the refusal and proposal

Send:

> Read https://example.org/ with the active reader. If network scope is missing,
> let the host record the refusal, then propose only adding the exact host
> example.org to the mandate.

Wait for the turn to finish. You should find a `NETWORK_SCOPE_DENIED` refusal
for `example.org`, followed by a mandate revision proposal containing:

```json
{ "addNetworkHosts": ["example.org"] }
```

The proposal is pending. The mandate keeps its previous scope. Record the
application revision and mandate version before continuing. This information is
also available from `GET /api/state`.

## 3. Approve the exact scope

In the proposal card, check the requested host and choose **Accept** to approve
that network scope. The command applies to this proposal and the reviewed
revision. Writing “yes” in the chat does not grant it. The card then reads
**Applying** and, once the new mandate is in service, **Applied**.

The host updates the SysML sources, validates their compilation and adopts the
revised mandate. The suspended case resumes. Wait for the reader’s actual
result: for this site, the title observed during the test was **Example
Domain**. The site’s content may change; the criterion is a completed call with
a recorded result.

Check that the mandate has advanced by one version and that its scope contains
only the requested addition. The reader’s identifier and digest must be the
same.

## 4. Find the change and the previous state

Open **Model**, then **Revisions**. Locate the latest accepted version and
compare it with its parent. The mandate change appears in `configuration.sysml`:
configuration revision, added host and mandate version.

Return to application history and select the revision recorded before approval.
It should still show the refusal and previous scope. Then return to the present
to find the successful result.

You have now followed an operator proposal through to its controlled effect and
found both states again. To propose another source change, consult the
[revision guide](../../how-to/evolution/reviser-systeme.md).
