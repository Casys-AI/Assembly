import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { createWorkbenchApi } from "./api.ts";

Deno.test("all workbench commands use same-origin paths and JSON content type", async () => {
  const writes: string[] = [];
  const api = createWorkbenchApi((path, init) => {
    equal(init?.method, "POST");
    equal(new Headers(init.headers).get("content-type"), "application/json");
    equal(typeof JSON.parse(String(init.body)), "object");
    writes.push(path);
    return Promise.resolve(Response.json({ accepted: true }, { status: 202 }));
  });
  await api.sendMessage("Bonjour");
  await api.sendAgentMessage({
    agentId: "native:builder",
    expectedRevision: 7,
    text: "Bonjour",
  });
  const candidate = {
    candidateId: "candidate-1",
    candidateDigest: "a".repeat(64),
    expectedRevision: 7,
    verdict: "approve" as const,
    reason: "Version exacte admise.",
  };
  await api.decideOperatorTool({ agentId: "native:builder", ...candidate });
  await api.decideOperatorChange({
    agentId: "native:builder",
    changeId: "change-1",
    expectedRevision: 7,
    configurationRevision: 3,
    verdict: "approve",
  });
  await api.decide({ kind: "candidate", ...candidate });
  await api.decide({
    kind: "change",
    changeId: "change-1",
    expectedRevision: 7,
    verdict: "approve",
  });
  deepStrictEqual(writes, [
    "/api/messages",
    "/api/conversations/native%3Abuilder/messages",
    "/api/conversations/native%3Abuilder/decisions",
    "/api/conversations/native%3Abuilder/changes/change-1/decision",
    "/api/decisions",
    "/api/decisions",
  ]);
});

Deno.test("mandate decisions target the owner, exact change and both examined revisions", async () => {
  const writes: Array<{ path: string; body: unknown }> = [];
  const api = createWorkbenchApi((path, init) => {
    writes.push({ path, body: JSON.parse(String(init?.body)) });
    return Promise.resolve(Response.json({ accepted: true }));
  });
  await api.decideOperatorChange({
    agentId: "native:worker",
    changeId: "change/1",
    expectedRevision: 8,
    configurationRevision: 3,
    verdict: "approve",
  });
  deepStrictEqual(writes, [{
    path: "/api/conversations/native%3Aworker/changes/change%2F1/decision",
    body: { expectedRevision: 8, configurationRevision: 3, verdict: "approve" },
  }]);
});
Deno.test("adapter reads server errors even with a non-JSON response", async () => {
  const api = createWorkbenchApi(() =>
    Promise.resolve(new Response("Unavailable", { status: 503 }))
  );
  await api.readState().then(() => {
    throw new Error("Expected HTTP failure");
  }, (err) => {
    equal(err.message, "Action not possible (503).");
  });
});

Deno.test("agent message transport carries only the selected native command target and its CAS revision", async () => {
  const writes: Array<{ path: string; body: unknown }> = [];
  const api = createWorkbenchApi((path, init) => {
    writes.push({ path, body: JSON.parse(String(init?.body)) });
    return Promise.resolve(Response.json({ accepted: true }, { status: 202 }));
  });
  await api.sendAgentMessage({
    agentId: "native:actor/one?exact",
    expectedRevision: 9,
    text: "Consigne",
  });
  deepStrictEqual(writes, [{
    path: "/api/conversations/native%3Aactor%2Fone%3Fexact/messages",
    body: { text: "Consigne", expectedRevision: 9 },
  }]);
});

Deno.test("missing conversation capability keeps legacy instances available; malformed data is not invented", async () => {
  const old = createWorkbenchApi(() =>
    Promise.resolve(new Response(null, { status: 404 }))
  );
  equal(await old.readConversations(), null);
  const broken = createWorkbenchApi(() =>
    Promise.resolve(Response.json({ conversations: [] }))
  );
  await rejects(
    () => broken.readConversations(),
    /conversations received are unreadable/,
  );
});

Deno.test("operator tool decisions carry their owner and CAS revision without a human-inbox grant", async () => {
  const writes: Array<{ path: string; body: unknown }> = [];
  const api = createWorkbenchApi((path, init) => {
    writes.push({ path, body: JSON.parse(String(init?.body)) });
    return Promise.resolve(Response.json({ accepted: true }, { status: 202 }));
  });
  await api.decideOperatorTool({
    agentId: "native:worker/one",
    candidateId: "candidate",
    candidateDigest: "exact",
    expectedRevision: 4,
    verdict: "approve",
    reason: "Décision explicite",
  });
  deepStrictEqual(writes, [{
    path: "/api/conversations/native%3Aworker%2Fone/decisions",
    body: {
      candidateId: "candidate",
      candidateDigest: "exact",
      expectedRevision: 4,
      verdict: "approve",
      reason: "Décision explicite",
    },
  }]);
  const old = createWorkbenchApi(() =>
    Promise.resolve(new Response(null, { status: 404 }))
  );
  equal(await old.readOperatorTools(), null);
});

Deno.test("Case mandate decisions address the scoped route and exact Case", async () => {
  const writes: Array<{ path: string; body: unknown }> = [];
  const api = createWorkbenchApi((path, init) => {
    writes.push({ path, body: JSON.parse(String(init?.body)) });
    return Promise.resolve(
      Response.json({
        status: "published-awaiting-adoption",
        caseId: "C/1",
        changeId: "change/1",
      }),
    );
  });
  const result = await api.decideOperatorChange({
    agentId: "native:worker",
    changeId: "change/1",
    caseId: "C/1",
    expectedRevision: 8,
    configurationRevision: 3,
    verdict: "approve",
  });
  deepStrictEqual(writes, [{
    path:
      "/api/conversations/native%3Aworker/changes/change%2F1/decision?space=requests",
    body: {
      caseId: "C/1",
      expectedRevision: 8,
      configurationRevision: 3,
      verdict: "approve",
    },
  }]);
  equal(result.status, "published-awaiting-adoption");
});

Deno.test("Case decision status and retry use the durable server command", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const api = createWorkbenchApi((path, init) => {
    calls.push({
      path,
      method: init?.method ?? "GET",
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    return Promise.resolve(
      Response.json({
        caseId: "C/1",
        changeId: "x/2",
        status: "blocked",
        canResume: true,
      }),
    );
  });
  await api.readCaseChangeStatus("native:one", "x/2", "C/1");
  await api.resumeCaseChange("native:one", "x/2", "C/1");
  deepStrictEqual(calls, [
    {
      path:
        "/api/conversations/native%3Aone/changes/x%2F2/decision?space=requests&caseId=C%2F1",
      method: "GET",
    },
    {
      path:
        "/api/conversations/native%3Aone/changes/x%2F2/decision/resume?space=requests",
      method: "POST",
      body: { caseId: "C/1" },
    },
  ]);
});
