import { deepStrictEqual, equal, match } from "node:assert/strict";
import type { CasesSnapshot } from "../../../../domain/work/entities/cases.ts";
import { type CasesApplication, createCasesHandler } from "./cases.ts";

function fixture() {
  const snapshot: CasesSnapshot = {
    systemId: "system-1",
    cases: [{
      id: "system-1:case:1",
      number: 1,
      type: "request",
      objective: "Lire la source admise",
      owner: "native:central",
      openedBy: "native:central",
      openedFrom: { conversationId: "conversation-1", messageId: "message-1" },
      modelPin: { digest: "model-digest", repositoryVersion: "commit:source" },
      status: "open",
      budget: { budgetId: "budget-1", scopeId: "legacy-case-1" },
      createdAt: "2026-10-24T00:00:00.000Z",
    }],
  };
  const commands: Array<{ id: string; outcome: "done" | "abandoned" }> = [];
  const actions: Array<{ id: string; action: string }> = [];
  const application: CasesApplication = {
    get cases() {
      return structuredClone(snapshot);
    },
    runCase(id) {
      actions.push({ id, action: "run" });
      return Promise.resolve();
    },
    pauseCase(id) {
      actions.push({ id, action: "pause" });
      return Promise.resolve();
    },
    resumeCase(id) {
      actions.push({ id, action: "resume" });
      return Promise.resolve();
    },
    stopCase(id) {
      actions.push({ id, action: "stop" });
      return Promise.resolve();
    },
    closeCase(id, outcome) {
      commands.push({ id, outcome });
      const caseRecord = snapshot.cases.find((entry) => entry.id === id);
      if (!caseRecord) {
        return Promise.reject(
          Object.assign(new Error("Case introuvable."), { code: "NOT_FOUND" }),
        );
      }
      caseRecord.status = outcome === "done"
        ? "closed-done"
        : "closed-abandoned";
      caseRecord.closedAt = "2026-10-24T01:00:00.000Z";
      return Promise.resolve();
    },
  };
  const handler = createCasesHandler(application, "http://127.0.0.1:4311");
  const get = (path = "/api/cases", method = "GET") =>
    handler(new Request(`http://127.0.0.1:4311${path}`, { method }));
  const close = (
    input: unknown = { outcome: "done" },
    headers: HeadersInit = {},
    id = snapshot.cases[0]!.id,
  ) =>
    handler(
      new Request(
        `http://127.0.0.1:4311/api/cases/${encodeURIComponent(id)}/close`,
        {
          method: "POST",
          headers: {
            host: "127.0.0.1:4311",
            origin: "http://127.0.0.1:4311",
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify(input),
        },
      ),
    );
  return { snapshot, application, commands, actions, handler, get, close };
}

Deno.test("Job and Watch reads preserve the exact details expected by the Cases interface", async () => {
  const { snapshot, get, actions, commands } = fixture();
  const base = snapshot.cases[0];
  snapshot.cases = [{
    ...base,
    type: "job",
    job: {
      schedule: "daily 08:00",
      steps: [{ id: "behavior", label: "Morning summary", state: "done" }],
      runs: [{ id: "run-1", startedAt: base.createdAt, outcome: "done" }],
    },
  }, {
    ...base,
    id: "system-1:case:2",
    number: 2,
    type: "watch",
    watch: {
      state: "watching",
      nextWakeAt: "2026-10-24T01:00:00.000Z",
      wakes: [{ at: base.createdAt, changed: true, summary: "Une offre." }],
    },
  }];
  deepStrictEqual(await (await get())!.json(), snapshot);
  for (const record of snapshot.cases) {
    const detail = await get(`/api/cases/${encodeURIComponent(record.id)}`);
    deepStrictEqual(await detail!.json(), {
      systemId: snapshot.systemId,
      case: record,
    });
  }
  deepStrictEqual(actions, []);
  deepStrictEqual(commands, []);
});

Deno.test("Case runtime actions dispatch only the path identity and return the updated Case", async () => {
  for (const action of ["run", "pause", "resume", "stop"] as const) {
    const { snapshot, handler, actions, get } = fixture();
    const id = snapshot.cases[0].id;
    const path = `/api/cases/${encodeURIComponent(id)}/${action}`;
    equal((await get(path))?.status, 405);
    const response = await handler(
      new Request(`http://127.0.0.1:4311${path}`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:4311",
          origin: "http://127.0.0.1:4311",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    equal(response?.status, 200);
    deepStrictEqual(actions, [{ id, action }]);
    deepStrictEqual(await response!.json(), {
      systemId: snapshot.systemId,
      case: snapshot.cases[0],
      action,
    });
  }
});

Deno.test("Case actions refuse cross-origin calls and authority-bearing bodies", async () => {
  const { handler, actions } = fixture();
  for (const action of ["run", "pause", "resume", "stop"]) {
    const url = `http://127.0.0.1:4311/api/cases/system-1:case:1/${action}`;
    const crossSite = await handler(
      new Request(url, {
        method: "POST",
        headers: { host: "127.0.0.1:4311", origin: "https://other.test" },
      }),
    );
    equal(crossSite?.status, 403);
    const authority = await handler(
      new Request(url, {
        method: "POST",
        headers: {
          host: "127.0.0.1:4311",
          origin: "http://127.0.0.1:4311",
          "content-type": "application/json",
        },
        body: JSON.stringify({ owner: "another-operator" }),
      }),
    );
    equal(authority?.status, 400);
    equal((await authority!.json()).error.code, "INVALID_COMMAND");
  }
  deepStrictEqual(actions, []);
  const empty = await handler(
    new Request(
      "http://127.0.0.1:4311/api/cases/system-1:case:1/run",
      {
        method: "POST",
        headers: {
          host: "127.0.0.1:4311",
          origin: "http://127.0.0.1:4311",
          "content-type": "application/json",
        },
        body: "{}",
      },
    ),
  );
  equal(empty?.status, 200);
});

Deno.test("Case action failures preserve structured context and recovery", async () => {
  const { application, handler } = fixture();
  application.runCase = () =>
    Promise.reject(Object.assign(
      new Error("Already running"),
      {
        code: "CASE_BUSY",
        context: { caseId: "system-1:case:1" },
        recovery: "Wait for the current execution.",
      },
    ));
  const response = await handler(
    new Request(
      "http://127.0.0.1:4311/api/cases/system-1:case:1/run",
      {
        method: "POST",
        headers: {
          host: "127.0.0.1:4311",
          origin: "http://127.0.0.1:4311",
          "content-type": "application/json",
        },
        body: "{}",
      },
    ),
  );
  equal(response?.status, 409);
  deepStrictEqual(await response!.json(), {
    error: {
      code: "CASE_BUSY",
      message: "Already running",
      context: { caseId: "system-1:case:1" },
      recovery: "Wait for the current execution.",
    },
  });
});

Deno.test("Case reads preserve stable identities, pins and legacy budget references without starting work", async () => {
  const { snapshot, commands, get } = fixture();
  snapshot.cases[0]!.objective = "<img src=x onerror=attack()>";
  const collection = await get();
  equal(collection?.status, 200);
  equal(collection?.headers.get("cache-control"), "no-store");
  equal(collection?.headers.get("x-content-type-options"), "nosniff");
  match(collection!.headers.get("content-type")!, /application\/json/);
  deepStrictEqual(await collection!.json(), snapshot);
  const detail = await get("/api/cases/system-1%3Acase%3A1");
  equal(detail?.status, 200);
  deepStrictEqual(await detail!.json(), {
    systemId: snapshot.systemId,
    case: snapshot.cases[0],
  });
  deepStrictEqual(commands, []);
});

Deno.test("Case detail reports a structured not-found error", async () => {
  const { get, commands } = fixture();
  const response = await get("/api/cases/unknown");
  equal(response?.status, 404);
  deepStrictEqual(await response!.json(), {
    error: { code: "NOT_FOUND", message: "Case introuvable." },
  });
  deepStrictEqual(commands, []);
});

Deno.test("local closure forwards the exact Case and explicit outcome and returns persisted state", async () => {
  for (const outcome of ["done", "abandoned"] as const) {
    const { snapshot, commands, close } = fixture();
    const response = await close({ outcome }, {
      origin: "http://127.0.0.1:4311",
    });
    equal(response?.status, 200);
    deepStrictEqual(commands, [{ id: "system-1:case:1", outcome }]);
    deepStrictEqual(await response!.json(), {
      systemId: snapshot.systemId,
      case: {
        ...snapshot.cases[0],
        status: outcome === "done" ? "closed-done" : "closed-abandoned",
        closedAt: "2026-10-24T01:00:00.000Z",
      },
      closed: true,
    });
  }
});

Deno.test("Case closure retains local origin controls before invoking the application", async () => {
  const { close, commands } = fixture();
  for (
    const headers of [
      { origin: "https://other.test" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
    ] as HeadersInit[]
  ) {
    const response = await close(undefined, headers);
    equal(response?.status, 403);
    equal((await response!.json()).error.code, "ORIGIN_REFUSED");
  }
  deepStrictEqual(commands, []);
  equal((await close())?.status, 200);
});

Deno.test("cases expose only their declared methods and reject query authority fields", async () => {
  const { get, handler, commands } = fixture();
  for (
    const [path, method, allowed] of [
      ["/api/cases", "POST", "GET"],
      ["/api/cases/system-1:case:1", "DELETE", "GET"],
      ["/api/cases/system-1:case:1/close", "GET", "POST"],
    ]
  ) {
    const response = await get(path, method);
    equal(response?.status, 405);
    equal(response?.headers.get("allow"), allowed);
    equal((await response!.json()).error.code, "METHOD_NOT_ALLOWED");
  }
  for (
    const path of [
      "/api/cases?owner=other",
      "/api/cases/system-1:case:1?version=old",
    ]
  ) {
    const response = await get(path);
    equal(response?.status, 400);
    equal((await response!.json()).error.code, "INVALID_QUERY");
  }
  const closeQuery = await handler(
    new Request(
      "http://127.0.0.1:4311/api/cases/system-1:case:1/close?owner=other",
      {
        method: "POST",
        headers: {
          host: "127.0.0.1:4311",
          origin: "http://127.0.0.1:4311",
          "content-type": "application/json",
        },
        body: JSON.stringify({ outcome: "done" }),
      },
    ),
  );
  equal(closeQuery?.status, 400);
  equal(await get("/api/state"), null);
  equal(await get("/api/cases/system-1:case:1/unknown"), null);
  deepStrictEqual(commands, []);
});

Deno.test("cases refuse malformed or decoded path identifiers", async () => {
  const { get, commands } = fixture();
  for (
    const id of ["%FF", "%2F", "%00", "%7F", "%20id", "id%20", "x".repeat(257)]
  ) {
    const response = await get(`/api/cases/${id}`);
    equal(response?.status, 400);
    equal((await response!.json()).error.code, "INVALID_CASE_ID");
  }
  deepStrictEqual(commands, []);
});

Deno.test("Case closure accepts only one explicit outcome and no authority-bearing fields", async () => {
  const { close, commands } = fixture();
  for (
    const value of [
      null,
      [],
      "done",
      {},
      { outcome: "closed-done" },
      { outcome: "job" },
      { outcome: true },
      { outcome: "done", owner: "native:other" },
      { outcome: "done", authority: "human" },
      { outcome: "done", caseId: "other" },
    ]
  ) {
    const response = await close(value);
    equal(response?.status, 400);
    equal((await response!.json()).error.code, "INVALID_COMMAND");
  }
  deepStrictEqual(commands, []);
});

Deno.test("Case closure rejects invalid media, JSON and oversized bodies", async () => {
  const { close, handler, commands } = fixture();
  const media = await close(undefined, { "content-type": "text/plain" });
  equal(media?.status, 415);
  equal((await media!.json()).error.code, "JSON_REQUIRED");
  for (const body of ["{", new Uint8Array([255])]) {
    const response = await handler(
      new Request("http://127.0.0.1:4311/api/cases/system-1:case:1/close", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4311",
          origin: "http://127.0.0.1:4311",
          "content-type": "application/json",
        },
        body,
      }),
    );
    equal(response?.status, 400);
    equal((await response!.json()).error.code, "INVALID_JSON");
  }
  const tooLarge = await close({ outcome: "x".repeat(1025) });
  equal(tooLarge?.status, 413);
  equal((await tooLarge!.json()).error.code, "COMMAND_TOO_LARGE");
  const empty = await handler(
    new Request("http://127.0.0.1:4311/api/cases/system-1:case:1/close", {
      method: "POST",
      headers: {
        host: "127.0.0.1:4311",
        origin: "http://127.0.0.1:4311",
        "content-type": "application/json",
      },
    }),
  );
  equal(empty?.status, 400);
  equal((await empty!.json()).error.code, "INVALID_COMMAND");
  deepStrictEqual(commands, []);
});

Deno.test("late Case closure refusals preserve codes and do not retry", async () => {
  for (
    const [code, status] of [["CASE_BUSY", 409], ["CASE_CLOSED", 409], [
      "CASE_CONFLICT",
      409,
    ], [
      "NOT_FOUND",
      404,
    ]] as const
  ) {
    const { application, close, commands } = fixture();
    application.closeCase = (id, outcome) => {
      commands.push({ id, outcome });
      return Promise.reject(
        Object.assign(new Error("Clôture refusée."), { code }),
      );
    };
    const response = await close();
    equal(response?.status, status);
    deepStrictEqual(await response!.json(), {
      error: { code, message: "Clôture refusée." },
    });
    equal(commands.length, 1);
  }
});

Deno.test("every Case POST requires loopback Host served Origin and JSON before dispatch", async () => {
  for (const action of ["run", "pause", "resume", "stop", "close"]) {
    for (
      const [change, status, code] of [
        [{ origin: null }, 403, "ORIGIN_REFUSED"],
        [{ origin: "https://foreign.test" }, 403, "ORIGIN_REFUSED"],
        [{ host: "attacker.test:4311" }, 403, "HOST_REFUSED"],
        [{ host: "127.0.0.1:9999" }, 403, "HOST_REFUSED"],
        [{ host: null }, 403, "HOST_REFUSED"],
        [{ "content-type": "text/plain" }, 415, "JSON_REQUIRED"],
        [{ "content-type": null }, 415, "JSON_REQUIRED"],
        [{}, 200, null],
      ] as const
    ) {
      const f = fixture();
      const headers = new Headers({
        host: "127.0.0.1:4311",
        origin: "http://127.0.0.1:4311",
        "content-type": "application/json",
      });
      for (const [key, value] of Object.entries(change)) {
        if (value === null) headers.delete(key);
        else headers.set(key, value);
      }
      const response = await f.handler(
        new Request(
          `http://127.0.0.1:4311/api/cases/system-1:case:1/${action}`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(action === "close" ? { outcome: "done" } : {}),
          },
        ),
      );
      equal(response?.status, status, `${action}: ${JSON.stringify(change)}`);
      if (code) {
        const error = (await response!.json()).error;
        equal(error.code, code);
        equal(typeof error.message, "string");
        equal(typeof error.recovery, "string");
        equal(f.actions.length + f.commands.length, 0);
      } else equal(f.actions.length + f.commands.length, 1);
    }
  }
});

Deno.test("Cases reject DNS rebinding origins and unserved ports and accept localhost", async () => {
  for (
    const [origin, expected] of [["http://attacker.test:4311", 403], [
      "http://127.0.0.1:9999",
      403,
    ], ["http://localhost:4311", 200]] as const
  ) {
    const f = fixture();
    const response = await f.handler(
      new Request(`${origin}/api/cases/system-1:case:1/run`, {
        method: "POST",
        headers: {
          host: new URL(origin).host,
          origin,
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    equal(response?.status, expected);
    equal(f.actions.length, expected === 200 ? 1 : 0);
    if (expected !== 200) {
      equal((await response!.json()).error.code, "HOST_REFUSED");
    }
  }
});
