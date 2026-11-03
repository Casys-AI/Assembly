import { deepStrictEqual, equal } from "node:assert/strict";
import { createRequestOperatorDetailsHandler } from "./request-operator-details.ts";
import type { RequestOperatorDetailsSnapshot } from "../../../../application/work/request-spaces/operator-details-view.ts";

Deno.test("Request detail HTTP is authenticated, bounded and no-store without arbitrary client scope", async () => {
  const calls: unknown[] = [],
    secret = "a".repeat(64),
    origin = "http://127.0.0.1:4311";
  const handler = createRequestOperatorDetailsHandler({
    read(session, caseId, operatorId) {
      calls.push([session, caseId, operatorId]);
      return Promise.resolve(
        { caseId, operatorId } as RequestOperatorDetailsSnapshot,
      );
    },
    source(session, caseId, operatorId, command) {
      calls.push([session, caseId, operatorId, command]);
      return Promise.resolve({ sources: [] });
    },
  }, origin);
  const path = "/api/request-cases/case-a/operators/native%3Aowner/details";
  equal(await handler(new Request(origin + "/api/unrelated")), null);
  equal((await handler(new Request(origin + path)))?.status, 403);
  equal(
    (await handler(new Request(origin + path, { method: "POST" })))?.status,
    405,
  );
  const headers = {
    cookie: `assembly-space-session=${secret}`,
    origin,
    host: "127.0.0.1:4311",
    "content-type": "application/json",
  };
  const response = await handler(new Request(origin + path, { headers }));
  equal(response?.status, 200);
  equal(response?.headers.get("cache-control"), "no-store");
  deepStrictEqual(calls, [[secret, "case-a", "native:owner"]]);
  equal(
    (await handler(new Request(origin + path + "?scope=main", { headers })))
      ?.status,
    400,
  );
  equal(
    (await handler(
      new Request(origin + path.replace("details", "sources/read"), {
        method: "POST",
        headers,
        body: "x".repeat(16_385),
      }),
    ))?.status,
    400,
  );
  equal(calls.length, 1);
});
