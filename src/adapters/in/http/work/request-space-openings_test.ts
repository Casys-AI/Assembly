import { deepStrictEqual, equal, match } from "node:assert/strict";
import { createRequestSpaceOpeningHandler } from "./request-space-openings.ts";
import {
  createSpaceSessionHandler,
  SPACE_SESSION_COOKIE,
} from "./space-session.ts";
const origin = "http://127.0.0.1:4311";
function request(path: string, body: unknown, cookie?: string) {
  return new Request(origin + path, {
    method: "POST",
    headers: {
      host: "127.0.0.1:4311",
      origin,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}
Deno.test("space opening HTTP derives session from cookie and refuses actor/scope/ref DTOs", async () => {
  let called = 0;
  const handler = createRequestSpaceOpeningHandler({
    open(_command, secret) {
      called++;
      equal(secret, "a".repeat(64));
      return Promise.resolve({
        id: "opening",
        caseId: "case",
        caseNumber: 1,
        executionSpaceId: "space",
        branchId: "branch",
        initialContributionId: "input",
        phase: "allocated",
        revision: 0,
        sourceVersion: null,
        release: null,
        admissionId: null,
        issues: [],
      });
    },
  }, origin);
  const command = {
    openingKey: "key",
    text: "Request",
    source: { kind: "current-main" },
  };
  equal(
    (await handler(request("/api/request-space-openings/open", command)))!
      .status,
    403,
  );
  const cookie = `${SPACE_SESSION_COOKIE}=${"a".repeat(64)}`;
  equal(
    (await handler(
      request("/api/request-space-openings/open", {
        ...command,
        actorId: "owner",
      }, cookie),
    ))!.status,
    400,
  );
  equal(
    (await handler(
      request("/api/request-space-openings/open", command, cookie),
    ))!.status,
    200,
  );
  equal(called, 1);
  equal(
    (await handler(
      request(
        "/api/request-space-openings/open",
        command,
        `${cookie}; ${cookie}`,
      ),
    ))!.status,
    403,
  );
});
Deno.test("session exchange exposes only a host-only HttpOnly cookie, never the session secret in JSON", async () => {
  const handler = createSpaceSessionHandler({
    exchange(secret) {
      equal(secret, "b".repeat(64));
      return Promise.resolve({
        secret: "c".repeat(64),
        expiresAt: "2099-01-01T00:00:00Z",
      });
    },
  }, origin);
  const response = await handler(
    request("/api/space-session/exchange", {
      capabilitySecret: "b".repeat(64),
    }),
  );
  equal(response!.status, 200);
  const cookie = response!.headers.get("set-cookie")!;
  match(cookie, /HttpOnly; SameSite=Strict/);
  equal(cookie.includes("Domain="), false);
  equal((await response!.text()).includes("c".repeat(64)), false);
  equal(await handler(request("/api/space-session/issue", {})), null);
});

Deno.test("Request host context is a no-store immutable host identity projection with no opening call", async () => {
  let opened = 0;
  const scope = {
    projectId: "git:host-project",
    systemId: "host-system",
    executionSpaceId: "main",
    operatorId: "runtime-native-operator",
  };
  const handler = createRequestSpaceOpeningHandler(
    {
      open() {
        opened++;
        return Promise.reject(
          new Error("Metadata must not open or resolve a Request."),
        );
      },
    },
    origin,
    scope,
  );
  scope.projectId = "changed-project";
  scope.systemId = "changed-system";
  const response = await handler(
    new Request(origin + "/api/request-space-openings/context"),
  );
  equal(response!.status, 200);
  equal(response!.headers.get("cache-control"), "no-store");
  deepStrictEqual(await response!.json(), {
    projectId: "git:host-project",
    systemId: "host-system",
  });
  equal(opened, 0);
});
Deno.test("Request host context refuses query/method overrides without invoking the opening service", async () => {
  let opened = 0;
  const handler = createRequestSpaceOpeningHandler(
    {
      open() {
        opened++;
        return Promise.reject(new Error("Unexpected opening."));
      },
    },
    origin,
    { projectId: "project", systemId: "host" },
  );
  const query = await handler(
    new Request(
      origin + "/api/request-space-openings/context?systemId=foreign",
    ),
  );
  equal(query!.status, 400);
  equal((await query!.json()).code, "INVALID_COMMAND");
  for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
    const response = await handler(
      new Request(origin + "/api/request-space-openings/context", { method }),
    );
    equal(response!.status, 405);
    equal(response!.headers.get("allow"), "GET");
    equal(response!.headers.get("cache-control"), "no-store");
  }
  equal(opened, 0);
});
Deno.test("Request host context fails closed without the optional host binding", async () => {
  let opened = 0;
  const handler = createRequestSpaceOpeningHandler({
    open() {
      opened++;
      return Promise.reject(new Error("Unexpected opening."));
    },
  }, origin);
  const response = await handler(
    new Request(origin + "/api/request-space-openings/context"),
  );
  equal(response!.status, 503);
  equal((await response!.json()).code, "UNAVAILABLE");
  equal(response!.headers.get("cache-control"), "no-store");
  equal(opened, 0);
});
