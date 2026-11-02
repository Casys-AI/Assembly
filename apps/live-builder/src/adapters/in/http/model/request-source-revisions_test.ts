import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
} from "node:assert/strict";
import { createRequestSourceRevisionsHandler } from "./request-source-revisions.ts";
import { RequestSpaceError } from "../../../../domain/work/request-spaces.ts";
import { ModelWriteQueueError } from "../../../../application/model/publication/write-queue.ts";
import type { RequestSourceRevisions } from "../../../../application/model/source-admission/revisions.ts";
import type { ModelRevision } from "../../../../domain/model/records/revision.ts";
const origin = "http://127.0.0.1:4311";
const cookie = `assembly-space-session=${"a".repeat(64)}`;
const version = `commit:${"b".repeat(40)}`, digest = "c".repeat(64);
function request(
  path: string,
  body: unknown,
  changes: Record<string, string> = {},
) {
  return new Request(origin + path, {
    method: "POST",
    headers: {
      host: "127.0.0.1:4311",
      origin,
      cookie,
      "content-type": "application/json",
      ...changes,
    },
    body: JSON.stringify(body),
  });
}
function fixture() {
  const calls: Array<{ kind: string; secret: string; input: unknown }> = [];
  const service = {
    propose(secret: string, input: unknown) {
      calls.push({ kind: "propose", secret, input });
      return Promise.resolve({
        caseId: "caseA",
        id: "proposal1",
        author: "local-owner",
        reason: "Refine",
        baseVersion: version,
        createdAt: "2026-10-30T00:00:00Z",
        status: "proposed",
        validation: "validated",
        sourceDigest: digest,
        proposalVersion: version,
        diff: [{
          path: "configuration.sysml",
          kind: "changed",
          before: "old",
          after: "new",
          hidden: "private",
        }],
        authority: { secret: "private-authority" },
      });
    },
    accept(secret: string, input: unknown) {
      calls.push({ kind: "accept", secret, input });
      return Promise.resolve({
        caseId: "caseA",
        commandId: "proposal1",
        authority: "private-authority",
      });
    },
    resume(secret: string, input: unknown) {
      calls.push({ kind: "resume", secret, input });
      return Promise.resolve({
        version,
        sourceDigest: digest,
        elements: [{ secret: "private-ir" }],
        sources: { hidden: "private-source" },
        provider: { token: "private-token" },
      } as unknown as ModelRevision);
    },
  } as unknown as Pick<RequestSourceRevisions, "propose" | "accept" | "resume">;
  return {
    calls,
    handler: createRequestSourceRevisionsHandler(service, origin),
  };
}
Deno.test("Request source routes derive session from the cookie and expose bounded projections", async () => {
  const f = fixture();
  const edit = {
    caseId: "caseA",
    expectedVersion: `commit:${"a".repeat(40)}`,
    changes: [{ path: "configuration.sysml", text: "new" }],
    reason: "Refine",
  };
  const proposed =
    (await f.handler(request("/api/request-source-revisions/propose", edit)))!;
  equal(proposed.status, 200);
  equal(proposed.headers.get("cache-control"), "no-store");
  const proposedText = await proposed.text();
  match(proposedText, /proposal1/);
  doesNotMatch(proposedText, /private|authority|assembly-space-session/);
  const accepted = (await f.handler(
    request("/api/request-source-revisions/accept", {
      caseId: "caseA",
      proposalId: "proposal1",
    }),
  ))!;
  equal(accepted.status, 202);
  deepStrictEqual(await accepted.json(), {
    caseId: "caseA",
    commandId: "proposal1",
  });
  const resumed = (await f.handler(
    request("/api/request-source-revisions/resume", {
      caseId: "caseA",
      commandId: "proposal1",
    }),
  ))!;
  equal(resumed.status, 200);
  deepStrictEqual(await resumed.json(), {
    caseId: "caseA",
    version,
    sourceDigest: digest,
  });
  deepStrictEqual(f.calls, [
    { kind: "propose", secret: "a".repeat(64), input: edit },
    {
      kind: "accept",
      secret: "a".repeat(64),
      input: { caseId: "caseA", proposalId: "proposal1" },
    },
    {
      kind: "resume",
      secret: "a".repeat(64),
      input: { caseId: "caseA", commandId: "proposal1" },
    },
  ]);
});
Deno.test("Request source routes reject cross-origin, missing or duplicate cookies, arbitrary scope, unknown fields and GET before service", async () => {
  const f = fixture();
  const path = "/api/request-source-revisions/propose";
  const edit = {
    caseId: "caseA",
    expectedVersion: `commit:${"a".repeat(40)}`,
    changes: [{ path: "configuration.sysml", text: "new" }],
    reason: "Refine",
  };
  equal(
    (await f.handler(request(path, edit, { origin: "http://evil.invalid" })))!
      .status,
    403,
  );
  equal((await f.handler(request(path, edit, { cookie: "" })))!.status, 403);
  equal(
    (await f.handler(request(path, edit, { cookie: `${cookie}; ${cookie}` })))!
      .status,
    403,
  );
  for (
    const input of [
      { ...edit, destination: { ref: "refs/heads/main" } },
      { ...edit, actor: "owner" },
      { ...edit, secret: "x" },
      { ...edit, changes: [{ path: "x", text: "x", scope: "main" }] },
    ]
  ) {
    equal((await f.handler(request(path, input)))!.status, 400);
  }
  equal((await f.handler(request(`${path}?caseId=caseB`, edit)))!.status, 400);
  equal(
    (await f.handler(
      new Request(origin + "/api/request-source-revisions/resume", {
        method: "GET",
      }),
    ))!.status,
    405,
  );
  equal(await f.handler(request("/api/model/revisions", edit)), null);
  equal(f.calls.length, 0);
});
Deno.test("Request source route maps public refusal/conflict/unavailability without leaking internals", async () => {
  const input = { caseId: "caseA", commandId: "proposal1" };
  const response = async (error: unknown) =>
    (await createRequestSourceRevisionsHandler({
      propose: () => Promise.reject(error),
      accept: () => Promise.reject(error),
      resume: () => Promise.reject(error),
    }, origin)(request("/api/request-source-revisions/resume", input)))!;
  const forbidden = await response(
    new RequestSpaceError("FORBIDDEN", "Current session required"),
  );
  equal(forbidden.status, 403);
  const conflict = await response(
    new ModelWriteQueueError("WRITE_QUEUE_CONFLICT", {
      reason: "private storage details",
    }, "private storage details"),
  );
  equal(conflict.status, 409);
  doesNotMatch(await conflict.text(), /private/);
  const unknown = await response(new Error("private database path and secret"));
  equal(unknown.status, 503);
  doesNotMatch(await unknown.text(), /private|secret/);
});
Deno.test("Request source routes bound body and command identity before any work", async () => {
  const f = fixture();
  equal(
    (await f.handler(
      request("/api/request-source-revisions/accept", {
        caseId: "caseA",
        proposalId: "proposal1",
        authority: {},
      }),
    ))!.status,
    400,
  );
  equal(
    (await f.handler(
      request("/api/request-source-revisions/resume", {
        caseId: "caseA",
        commandId: "../main",
      }),
    ))!.status,
    400,
  );
  const malformed = new Request(
    origin + "/api/request-source-revisions/propose",
    {
      method: "POST",
      headers: {
        host: "127.0.0.1:4311",
        origin,
        cookie,
        "content-type": "application/json",
      },
      body: "{",
    },
  );
  equal((await f.handler(malformed))!.status, 400);
  const tooLarge = request("/api/request-source-revisions/propose", {
    caseId: "caseA",
    expectedVersion: `commit:${"a".repeat(40)}`,
    reason: "x",
    changes: [{ path: "a", text: "x".repeat(8_500_000) }],
  });
  equal((await f.handler(tooLarge))!.status, 400);
  equal(f.calls.length, 0);
});
Deno.test("resume does not return another Case or fabricate an unavailable command", async () => {
  const service = {
    propose: () => {
      throw new Error("unused");
    },
    accept: () => {
      throw new Error("unused");
    },
    resume: () => Promise.resolve(null),
  };
  const handler = createRequestSourceRevisionsHandler(service, origin);
  const response = (await handler(
    request("/api/request-source-revisions/resume", {
      caseId: "caseA",
      commandId: "missing",
    }),
  ))!;
  equal(response.status, 404);
  doesNotMatch(await response.text(), /commit:|sourceDigest|main/);
});

Deno.test("proposal rejects missing and malformed expected version before service", async () => {
  const f = fixture();
  const edit = {
    caseId: "caseA",
    changes: [{ path: "a.sysml", text: "x" }],
    reason: "x",
  };
  const path = "/api/request-source-revisions/propose";
  equal((await f.handler(request(path, edit)))!.status, 400);
  equal(
    (await f.handler(request(path, { ...edit, expectedVersion: "main" })))!
      .status,
    400,
  );
  equal(f.calls.length, 0);
});
