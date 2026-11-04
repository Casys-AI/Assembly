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

Deno.test("only an identified session refusal renews a development session before cached expiry", async () => {
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
            ? Response.json({
              code: "FORBIDDEN",
              error: "Session refused.",
              context: { session: "invalid" },
            }, { status })
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

Deno.test("a Request permission refusal stays local and never renews the control session", async () => {
  let sessionPosts = 0;
  const requests = createRequests({
    fetch: (path) => {
      if (path === "/api/space-session/local") {
        sessionPosts++;
        return Promise.resolve(Response.json({
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        }));
      }
      const body = path === "/api/environment"
        ? { environment: "development" }
        : path === "/api/request-space-openings/context"
        ? context
        : path === "/api/cases?space=requests"
        ? cases
        : {
          code: "FORBIDDEN",
          error: "The selected Request is unavailable",
        };
      return Promise.resolve(Response.json(body, {
        status: path.startsWith("/api/conversations?") ? 403 : 200,
      }));
    },
  });
  try {
    await requests.prepareConnection();
    await requests.cases.refresh();
    for (let i = 0; i < 3; i++) {
      await requests.refresh("unavailable");
      assert.equal(requests.sessionReady.peek(), true);
      assert.equal(
        requests.readErrors.peek().get("unavailable"),
        "The selected Request is unavailable",
      );
      await requests.prepareConnection();
    }
    assert.equal(sessionPosts, 1);
    assert.equal(requests.sessionGeneration.peek(), 1);
  } finally {
    requests.dispose();
  }
});

Deno.test("an old authentication refusal cannot disconnect a replacement session or host", async () => {
  for (const changed of ["session", "host", "host-return", "dispose"]) {
    const reply = Promise.withResolvers<Response>();
    const requests = createRequests({ fetch: () => reply.promise });
    requests.context.value = context;
    requests.sessionReady.value = true;
    const reading = requests.cases.ensure("request");
    if (changed === "session") requests.sessionGeneration.value++;
    else if (changed === "dispose") requests.dispose();
    else {
      requests.context.value = { ...context, systemId: "other" };
      if (changed === "host-return") requests.context.value = context;
    }
    reply.resolve(Response.json({
      code: "FORBIDDEN",
      context: { session: "invalid" },
    }, { status: 403 }));
    await reading;
    assert.equal(requests.sessionReady.peek(), true);
    requests.dispose();
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
