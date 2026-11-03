import { deepStrictEqual, equal } from "node:assert/strict";
import { createRequestSupervisionHandler } from "./request-supervision.ts";
import { RequestSpaceError } from "../../../../domain/work/request-spaces.ts";
import type {
  RequestSupervisionQuery,
  RequestSupervisionSnapshot,
} from "../../../../application/work/request-spaces/supervision-view.ts";

const secret = "a".repeat(64);
const request = (path: string, method = "GET", cookie = true) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: cookie ? { cookie: `assembly-space-session=${secret}` } : {},
  });

Deno.test("supervision HTTP isolates its GET route, transports the existing session and parses one bounded selection", async () => {
  const calls: Array<{ secret: string; query?: RequestSupervisionQuery }> = [];
  const handler = createRequestSupervisionHandler({
    read(received, query) {
      calls.push({ secret: received, query });
      return Promise.resolve(
        {
          schema: "assembly-system-supervision/v1",
        } as RequestSupervisionSnapshot,
      );
    },
  });
  equal(await handler(request("/api/system/other")), null);
  const wrongMethod = await handler(request("/api/system/supervision", "POST"));
  equal(wrongMethod?.status, 405);
  equal(wrongMethod?.headers.get("allow"), "GET");
  const response = await handler(
    request("/api/system/supervision?limit=2&cursor=case-number%3A3"),
  );
  equal(response?.status, 200);
  equal(response?.headers.get("cache-control"), "no-store");
  deepStrictEqual(calls, [{
    secret,
    query: { limit: 2, cursor: "case-number:3" },
  }]);
  const scoped = await handler(
    request("/api/system/supervision?caseId=case-A"),
  );
  equal(scoped?.status, 200);
  deepStrictEqual(calls[1].query, { caseId: "case-A" });
});

Deno.test("supervision HTTP refuses missing/duplicate transport, duplicate/foreign fields and malformed limits before service delivery", async () => {
  let calls = 0;
  const handler = createRequestSupervisionHandler({
    read() {
      calls++;
      throw new Error("Unexpected delivery");
    },
  });
  const missing = await handler(
    request("/api/system/supervision", "GET", false),
  );
  equal(missing?.status, 403);
  equal((await missing?.json()).code, "FORBIDDEN");
  for (
    const query of [
      "?version=commit:abc",
      "?limit=1&limit=2",
      "?limit=1.1",
      "?limit=01",
      "?limit=0",
      "?limit=1e2",
      "?caseId=a&caseId=b",
    ]
  ) {
    const response = await handler(request(`/api/system/supervision${query}`));
    equal(response?.status, 400, query);
    equal(response?.headers.get("cache-control"), "no-store");
  }
  const duplicate = await handler(
    new Request("http://localhost/api/system/supervision", {
      headers: {
        cookie:
          `assembly-space-session=${secret}; assembly-space-session=${secret}`,
      },
    }),
  );
  equal(duplicate?.status, 403);
  equal(calls, 0);
});

Deno.test("supervision HTTP preserves typed revocation failures and redacts unexpected storage failures", async () => {
  for (
    const [failure, status, code] of [[
      new RequestSpaceError("FORBIDDEN", "Session revoked"),
      403,
      "FORBIDDEN",
    ], [
      new RequestSpaceError("ADMISSION_REFUSED", "Admission refused"),
      403,
      "ADMISSION_REFUSED",
    ], [new Error("PRIVATE_DATABASE_DETAIL"), 503, "UNAVAILABLE"]] as const
  ) {
    const handler = createRequestSupervisionHandler({
      read() {
        throw failure;
      },
    });
    const response = await handler(request("/api/system/supervision"));
    equal(response?.status, status);
    equal(response?.headers.get("cache-control"), "no-store");
    const body = await response!.json();
    equal(body.code, code);
    equal(JSON.stringify(body).includes("PRIVATE_DATABASE_DETAIL"), false);
  }
});
