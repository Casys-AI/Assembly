import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  RequestAdoptionError,
  type RequestRuntimeAdoptionPort,
} from "../../../../application/model/evolution/request-adoption-ports.ts";
import { createRequestRuntimeAdoptionHandler } from "./request-runtime-adoption.ts";
import { RequestSpaceError } from "../../../../domain/work/request-spaces/scope.ts";
const origin = "http://127.0.0.1:4311";
const version = `commit:${"a".repeat(40)}`, target = `commit:${"b".repeat(40)}`;
const before = { version, digest: "c".repeat(64) },
  after = { version: target, digest: "d".repeat(64) };
const result = {
  caseId: "caseA",
  adoptionKey: "key1",
  status: "prepared" as const,
  before,
  target: after,
  blockers: [],
};
function request(action: string, body: unknown) {
  return new Request(`${origin}/api/request-runtime-adoption/${action}`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:4311",
      origin,
      cookie: `assembly-space-session=${"e".repeat(64)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
Deno.test("adoption status and resume use the original identity; absent status is not success", async () => {
  const calls: unknown[] = [];
  const service: RequestRuntimeAdoptionPort = {
    eligibility: () =>
      Promise.resolve({
        caseId: "caseA",
        eligible: true,
        executing: before,
        admitted: after,
        blockers: [],
      }),
    prepare: (_secret, input) => {
      calls.push(input);
      return Promise.resolve(result);
    },
    prepareNetwork: () =>
      Promise.reject(new Error("Not exercised by this route")),
    prepareTeam: () => Promise.reject(new Error("Not exercised by this route")),
    resume: (_secret, input) => {
      calls.push(input);
      return Promise.resolve(result);
    },
    status: (_secret, input) => {
      calls.push(input);
      return Promise.resolve(null);
    },
  };
  const handler = createRequestRuntimeAdoptionHandler(service, origin);
  const expected = { caseId: "caseA", adoptionKey: "key1" };
  equal((await handler(request("status", expected)))!.status, 404);
  equal((await handler(request("resume", expected)))!.status, 200);
  deepStrictEqual(calls, [expected, expected]);
  equal(
    (await handler(
      request("prepare", {
        ...expected,
        expectedAdmittedVersion: target,
        expectedExecutingDigest: before.digest,
        principal: "forged",
      }),
    ))!.status,
    400,
  );
});
Deno.test("adoption errors have bounded action-specific statuses", async () => {
  for (
    const [code, status] of [
      ["INVALID", 400],
      ["FORBIDDEN", 403],
      ["CONFLICT", 409],
      ["BLOCKED", 409],
      ["UNAVAILABLE", 503],
    ] as const
  ) {
    const fail = () =>
      Promise.reject(new RequestAdoptionError(code, "private"));
    const handler = createRequestRuntimeAdoptionHandler({
      eligibility: fail,
      prepare: fail,
      prepareNetwork: () => Promise.reject(new Error("unexpected use case")),
      prepareTeam: () => Promise.reject(new Error("unexpected use case")),
      resume: fail,
      status: fail,
    }, origin);
    const response = (await handler(
      request("status", { caseId: "caseA", adoptionKey: "key1" }),
    ))!;
    equal(response.status, status);
    equal((await response.json()).code, code);
  }
});

Deno.test("valid adoption prepare forwards the authenticated Case, original key and both exact expectations", async () => {
  const calls: unknown[] = [];
  const unused = () => Promise.reject(new Error("unexpected use case"));
  const handler = createRequestRuntimeAdoptionHandler({
    eligibility: unused,
    prepare(secret, input) {
      calls.push({ secret, input });
      return Promise.resolve(result);
    },
    prepareNetwork: unused,
    prepareTeam: unused,
    resume: unused,
    status: unused,
  }, origin);
  const input = {
    caseId: "caseA",
    adoptionKey: "key1",
    expectedAdmittedVersion: target,
    expectedExecutingDigest: before.digest,
  };
  const response = (await handler(request("prepare", input)))!;
  equal(response.status, 200);
  deepStrictEqual(await response.json(), result);
  deepStrictEqual(calls, [{ secret: "e".repeat(64), input }]);
  const foreignOrigin = request("prepare", input);
  foreignOrigin.headers.set("origin", "https://foreign.invalid");
  equal((await handler(foreignOrigin))!.status, 403);
  const unauthenticated = request("prepare", input);
  unauthenticated.headers.delete("cookie");
  equal((await handler(unauthenticated))!.status, 403);
  // Neither origin nor channel failures may reach a mutating use case.
  equal(calls.length, 1);
});

Deno.test("eligibility maps permission/read failures to safe stable reasons without private exception bodies", async () => {
  for (
    const [failure, expectedCode, expectedStatus, expectedReason] of [
      [
        new RequestAdoptionError("BLOCKED", "private SQL/source/stack"),
        "BLOCKED",
        409,
        "The Request is not ready for instruction adoption.",
      ],
      [
        new RequestSpaceError(
          "ADMISSION_REFUSED",
          "private credential details",
        ),
        "ADMISSION_REFUSED",
        403,
        "Current control or execution permission is unavailable for this Request.",
      ],
      [
        new RequestSpaceError("UNAVAILABLE", "private repository path"),
        "UNAVAILABLE",
        503,
        "Instruction adoption eligibility is unavailable. Check again from the current Request.",
      ],
    ] as const
  ) {
    const fail = () => Promise.reject(failure);
    const handler = createRequestRuntimeAdoptionHandler({
      eligibility: fail,
      prepare: fail,
      prepareNetwork: () => Promise.reject(new Error("unexpected use case")),
      prepareTeam: () => Promise.reject(new Error("unexpected use case")),
      resume: fail,
      status: fail,
    }, origin);
    const response =
      (await handler(request("eligibility", { caseId: "caseA" })))!;
    equal(response.status, expectedStatus);
    deepStrictEqual(await response.json(), {
      code: expectedCode,
      error: expectedReason,
    });
    equal(response.headers.get("cache-control"), "no-store");
  }
});

Deno.test("read failures differ from unknown mutation outcomes and never disclose internal errors", async () => {
  const fail = () =>
    Promise.reject(new Error("private SQL source /Volumes/secret and stack"));
  const handler = createRequestRuntimeAdoptionHandler({
    eligibility: fail,
    prepare: fail,
    prepareNetwork: () => Promise.reject(new Error("unexpected use case")),
    prepareTeam: () => Promise.reject(new Error("unexpected use case")),
    resume: fail,
    status: fail,
  }, origin);
  for (const action of ["eligibility", "status", "prepare", "resume"]) {
    const input = action === "eligibility"
      ? { caseId: "caseA" }
      : action === "prepare"
      ? {
        caseId: "caseA",
        adoptionKey: "key1",
        expectedAdmittedVersion: target,
        expectedExecutingDigest: before.digest,
      }
      : { caseId: "caseA", adoptionKey: "key1" };
    const response = (await handler(request(action, input)))!;
    equal(response.status, 503);
    const body = await response.json();
    equal(body.code, "UNAVAILABLE");
    ok(body.error.length <= 160);
    ok(!/private|SQL|\/Volumes|stack/.test(body.error));
    equal(
      body.error.includes("outcome is unknown"),
      action === "prepare" || action === "resume",
    );
  }
});
