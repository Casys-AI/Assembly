import assert from "node:assert/strict";
import { createRequestSourceRevisionApi } from "./request-revisions.ts";
const base = `commit:${"a".repeat(40)}`, next = `commit:${"b".repeat(40)}`;
const proposal = {
  caseId: "case-a",
  id: "proposal-a",
  author: "local-owner",
  baseVersion: base,
  proposalVersion: next,
  sourceDigest: "c".repeat(64),
  reason: "Clearer instructions",
  createdAt: "now",
  status: "proposed",
  validation: "validated",
  diff: [{ path: "core.sysml", kind: "changed", before: "old", after: "new" }],
};
Deno.test("Request source client sends only scoped public DTO with draft expectedVersion and same-origin cookies", async () => {
  const calls: { path: string; input: RequestInit }[] = [];
  const api = createRequestSourceRevisionApi("case-a", {
    fetch: ((path, input) => {
      calls.push({ path: String(path), input: input! });
      return Promise.resolve(Response.json(
        String(path).endsWith("propose")
          ? proposal
          : String(path).endsWith("accept")
          ? { caseId: "case-a", commandId: "proposal-a" }
          : { caseId: "case-a", version: next, sourceDigest: "d".repeat(64) },
      ));
    }) as typeof fetch,
  });
  await api.propose({
    expectedVersion: base,
    path: "core.sysml",
    text: "new",
    reason: "Clearer instructions",
  });
  await api.accept("proposal-a");
  await api.resume("proposal-a");
  assert.deepEqual(calls.map((call) => call.path), [
    "/api/request-source-revisions/propose",
    "/api/request-source-revisions/accept",
    "/api/request-source-revisions/resume",
  ]);
  assert.deepEqual(JSON.parse(String(calls[0].input.body)), {
    caseId: "case-a",
    expectedVersion: base,
    changes: [{ path: "core.sysml", text: "new" }],
    reason: "Clearer instructions",
  });
  assert.deepEqual(JSON.parse(String(calls[1].input.body)), {
    caseId: "case-a",
    proposalId: "proposal-a",
  });
  assert.deepEqual(JSON.parse(String(calls[2].input.body)), {
    caseId: "case-a",
    commandId: "proposal-a",
  });
  assert(
    calls.every(({ input }) =>
      input.method === "POST" && input.credentials === "same-origin"
    ),
  );
});
Deno.test("Request source client refuses foreign Case and different acceptance ID", async () => {
  const api = createRequestSourceRevisionApi("case-a", {
    fetch: (() =>
      Promise.resolve(
        Response.json({ ...proposal, caseId: "case-b", commandId: "foreign" }),
      )) as typeof fetch,
  });
  await assert.rejects(() =>
    api.propose({
      expectedVersion: base,
      path: "core.sysml",
      text: "new",
      reason: "why",
    })
  );
  await assert.rejects(() => api.accept("proposal-a"));
  await assert.rejects(() => api.resume("proposal-a"));
});

Deno.test("source action refusals do not disconnect the current control channel", async () => {
  let code = "REQUEST_SOURCE_OWNER_REFUSED", status = 403, disconnected = 0;
  let context: { session: string } | undefined = undefined;
  const api = createRequestSourceRevisionApi("case-a", {
    fetch: (() =>
      Promise.resolve(
        Response.json({ code, context }, { status }),
      )) as typeof fetch,
    onUnauthorized: () => {
      disconnected++;
    },
  });
  await assert.rejects(() => api.accept("proposal-a"));
  code = "EDIT_SCOPE_DENIED";
  await assert.rejects(() => api.accept("proposal-a"));
  code = "UNKNOWN";
  await assert.rejects(() => api.accept("proposal-a"));
  assert.equal(disconnected, 0);
  code = "FORBIDDEN";
  await assert.rejects(() => api.accept("proposal-a"));
  assert.equal(disconnected, 0);
  context = { session: "invalid" };
  await assert.rejects(() => api.accept("proposal-a"));
  assert.equal(disconnected, 1);
  status = 401;
  code = "UNKNOWN";
  await assert.rejects(() => api.accept("proposal-a"));
  assert.equal(disconnected, 2);
});
