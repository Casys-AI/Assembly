import assert from "node:assert/strict";
import { parseEnvironment } from "./environment.ts";
import { createRequests } from "./requests/requests.ts";
import { caseRecord } from "../test/support/case-fixture.ts";

const context = { projectId: "git:project", systemId: "system" };
const cases = { systemId: context.systemId, cases: [caseRecord(1)] };

Deno.test("runtime environment accepts only the closed backend contract", () => {
  assert.equal(parseEnvironment({ environment: "production" }), "production");
  assert.equal(parseEnvironment({ environment: "development" }), "development");
  for (
    const value of [null, {}, { environment: "test" }, {
      environment: "development",
      secret: "forbidden",
    }]
  ) {
    assert.throws(() => parseEnvironment(value));
  }
});

Deno.test("development runtime coalesces local session initialization while production never requests it", async () => {
  for (const mode of ["development", "production"] as const) {
    const paths: string[] = [];
    const requests = createRequests({
      fetch: (path, init) => {
        paths.push(path);
        if (path === "/api/environment") {
          return Promise.resolve(Response.json({ environment: mode }));
        }
        if (path === "/api/request-space-openings/context") {
          return Promise.resolve(Response.json(context));
        }
        assert.equal(path, "/api/space-session/local");
        assert.equal(init?.method, "POST");
        assert.equal(init?.credentials, "same-origin");
        assert.deepEqual(JSON.parse(String(init?.body)), {});
        return Promise.resolve(
          Response.json({
            expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          }),
        );
      },
    });
    assert.equal(requests.environment.peek(), null);
    assert.deepEqual(
      await Promise.all([
        requests.prepareConnection(),
        requests.prepareConnection(),
      ]),
      [true, true],
    );
    assert.equal(requests.environment.peek(), mode);
    assert.deepEqual(
      paths,
      mode === "development"
        ? [
          "/api/environment",
          "/api/space-session/local",
          "/api/request-space-openings/context",
        ]
        : ["/api/environment", "/api/request-space-openings/context"],
    );
    requests.dispose();
  }
});

Deno.test("unavailable local development session remains a runtime error without production fallback", async () => {
  const requests = createRequests({
    fetch: (path) =>
      Promise.resolve(
        path === "/api/environment"
          ? Response.json({ environment: "development" })
          : Response.json({ error: "Development session refused." }, {
            status: 403,
          }),
      ),
  });
  assert.equal(await requests.prepareConnection(), false);
  assert.equal(requests.environment.peek(), "development");
  assert.equal(requests.sessionReady.peek(), false);
  assert.equal(requests.error.peek(), "Development session refused.");
  requests.dispose();
});

Deno.test("authenticated cases refusal renews a development session before cached expiry", async () => {
  for (const status of [401, 403]) {
    let sessionPosts = 0;
    let environmentReads = 0;
    let refused = false;
    const requests = createRequests({
      fetch: (path, init) => {
        assert.equal(init?.credentials, "same-origin");
        if (path === "/api/environment") {
          environmentReads++;
          return Promise.resolve(Response.json({ environment: "development" }));
        }
        if (path === "/api/space-session/local") {
          sessionPosts++;
          assert.equal(init?.method, "POST");
          return Promise.resolve(Response.json({
            expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          }));
        }
        if (path === "/api/request-space-openings/context") {
          return Promise.resolve(Response.json(context));
        }
        assert.equal(path, "/api/cases?space=requests");
        return Promise.resolve(
          refused
            ? Response.json({ error: "Session refused." }, { status })
            : Response.json(cases),
        );
      },
    });
    try {
      assert.equal(await requests.prepareConnection(), true);
      await requests.cases.refresh();
      assert.equal(requests.sessionReady.peek(), true);
      assert.equal(
        requests.cases.snapshot.peek()?.cases[0]?.id,
        cases.cases[0].id,
      );
      assert.equal(sessionPosts, 1);
      refused = true;
      await requests.cases.refresh();
      assert.equal(requests.sessionReady.peek(), false);
      assert.equal(requests.cases.error.peek(), "Session refused.");
      refused = false;
      assert.equal(await requests.prepareConnection(), true);
      await requests.cases.refresh();
      assert.equal(sessionPosts, 2);
      assert.equal(environmentReads, 1);
      assert.equal(requests.sessionReady.peek(), true);
      assert.equal(requests.cases.error.peek(), "");
      assert.equal(
        requests.cases.snapshot.peek()?.cases[0]?.id,
        cases.cases[0].id,
      );
    } finally {
      requests.dispose();
    }
  }
});

Deno.test("a transient initial bootstrap failure can retry through the same connection", async () => {
  let sessionPosts = 0;
  let environmentReads = 0;
  const requests = createRequests({
    fetch: (path) => {
      if (path === "/api/environment") {
        environmentReads++;
        return Promise.resolve(Response.json({ environment: "development" }));
      }
      if (path === "/api/space-session/local") {
        if (++sessionPosts === 1) {
          return Promise.resolve(
            Response.json({ error: "Temporarily unavailable." }, {
              status: 503,
            }),
          );
        }
        return Promise.resolve(Response.json({
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        }));
      }
      if (path === "/api/request-space-openings/context") {
        return Promise.resolve(Response.json(context));
      }
      assert.equal(path, "/api/cases?space=requests");
      return Promise.resolve(Response.json(cases));
    },
  });
  try {
    assert.equal(await requests.prepareConnection(), false);
    assert.equal(requests.sessionReady.peek(), false);
    assert.equal(requests.error.peek(), "Temporarily unavailable.");
    assert.equal(await requests.prepareConnection(), true);
    await requests.cases.refresh();
    assert.equal(sessionPosts, 2);
    assert.equal(environmentReads, 1);
    assert.equal(requests.sessionReady.peek(), true);
    assert.equal(requests.error.peek(), "");
    requests.error.value = "Opening unavailable.";
    assert.equal(await requests.prepareConnection(), true);
    assert.equal(requests.error.peek(), "Opening unavailable.");
    assert.equal(
      requests.cases.snapshot.peek()?.cases[0]?.id,
      cases.cases[0].id,
    );
  } finally {
    requests.dispose();
  }
});
