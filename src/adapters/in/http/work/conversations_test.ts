import {
  ChangePendingError,
  ChangeScopeMissingError,
} from "../../../../domain/governance/policies/governance.ts";
import { ChangePublicationError } from "../../../../domain/model/publication/change.ts";
import { ChangeApprovabilityError } from "../../../../domain/governance/policies/change-approvability.ts";
import { deepStrictEqual, equal, match } from "node:assert/strict";
import { CaseError } from "../../../../domain/work/errors/case.ts";
import { executableFixture } from "../../../../../test/support/execution-fixture.ts";
import { createControlHandler } from "./control.ts";
import { MAX_USER_MESSAGE_CHARS } from "../../../../domain/work/records/conversations.ts";
import {
  type AgentMessageCommand,
  type ConversationsSnapshot,
  type OperatorToolsSnapshot,
} from "../../../../application/work/operators/conversation-types.ts";
import { AuthorityInvariantError } from "../../../../domain/governance/authority.ts";
import {
  type ConversationsApplication,
  createConversationsHandler,
} from "./conversations.ts";
import {
  type OperatorCandidateDecision,
  type OperatorChangeDecision,
  OperatorConversationError,
} from "../../../../application/work/operators/conversations.ts";

const servedOrigin = "http://127.0.0.1:4311";
const commandHeaders = {
  host: "127.0.0.1:4311",
  origin: servedOrigin,
  "content-type": "application/json",
};

Deno.test("conversations GET awaits the skills-enriched read model", async () => {
  const f = fixture();
  const skills = [{
    id: "modeling",
    name: "Modeling",
    description: "Model exact contracts",
    loaded: true,
  }];
  f.application.conversations = async () => {
    await Promise.resolve();
    const snapshot = structuredClone(f.state);
    snapshot.conversations[0]!.skills = skills;
    return snapshot;
  };
  const response = await f.get();
  equal(response!.status, 200);
  const body = await response!.json();
  deepStrictEqual(body.conversations[0].skills, skills);
  equal(Object.hasOwn(body.conversations[1], "skills"), false);
});

function fixture() {
  const state: ConversationsSnapshot = {
    systemId: "modeled-system",
    defaultAgentId: "native:builder",
    version: "read-version",
    conversations: [{
      agentId: "native:builder",
      nativeId: "native:builder",
      name: "Constructeur",
      responsibility: "Proposer des outils",
      primary: true,
      runtimeOwned: true,
      canSend: true,
      revision: 7,
      busy: false,
      phase: "Prêt",
      messages: [],
      modelDigest: "admitted-model",
      repositoryVersion: "branch:source",
    }, {
      agentId: "native:reviewer",
      nativeId: "native:reviewer",
      name: "Relecteur",
      responsibility: "Examiner un candidat exact",
      primary: false,
      runtimeOwned: false,
      canSend: false,
      readOnlyReason: "Ce mandat expose uniquement la lecture de ses revues.",
      revision: 7,
      busy: false,
      phase: "En attente",
      messages: [],
      modelDigest: "admitted-model",
    }],
  };
  state.conversations.push({
    ...structuredClone(state.conversations[1]!),
    agentId: "native:worker",
    nativeId: "native:worker",
    name: "Opérateur",
    responsibility: "Traiter le travail transmis par le coordinateur",
    runtimeOwned: true,
  });
  const candidate = {
    id: "shared-candidate-id",
    name: "lecteur_html",
    description: "Transforme le HTML fourni",
    kind: "read_web_page" as const,
    code: "export default () => ({title:'Title',text:'Text'});",
    stage: "awaiting-admission" as const,
    createdAt: "2026-10-21T00:00:00Z",
    baseCatalogRevision: 0,
  };
  const catalog: OperatorToolsSnapshot = {
    systemId: state.systemId,
    version: "catalog-read-version",
    tools: [{
      agentId: "native:builder",
      agentName: "Constructeur",
      revision: 7,
      candidate: { ...candidate, digest: "a".repeat(64) },
    }, {
      agentId: "native:worker",
      agentName: "Opérateur",
      revision: 7,
      candidate: { ...candidate, digest: "b".repeat(64) },
    }],
  };
  const calls: AgentMessageCommand[] = [];
  const decisions: OperatorCandidateDecision[] = [];
  const changeDecisions: OperatorChangeDecision[] = [];
  const application: ConversationsApplication = {
    get snapshot() {
      return structuredClone(state);
    },
    get catalogSnapshot() {
      return structuredClone(catalog);
    },
    submitHuman(command) {
      calls.push(command);
      return Promise.resolve();
    },
    decideCandidate(command) {
      decisions.push(command);
      return Promise.resolve();
    },
    decideChange(command) {
      changeDecisions.push(command);
      return Promise.resolve();
    },
  };
  const handler = createConversationsHandler(application, servedOrigin);
  const get = (path = "/api/conversations", method = "GET") =>
    handler(new Request(`http://127.0.0.1:4311${path}`, { method }));
  const post = (
    value: unknown = { text: "Bonjour", expectedRevision: 7 },
    agentId = "native:builder",
    headers: HeadersInit = {},
  ) =>
    handler(
      new Request(
        `http://127.0.0.1:4311/api/conversations/${
          encodeURIComponent(agentId)
        }/messages`,
        {
          method: "POST",
          headers: { ...commandHeaders, ...headers },
          body: JSON.stringify(value),
        },
      ),
    );
  const decision = {
    candidateId: candidate.id,
    candidateDigest: "a".repeat(64),
    expectedRevision: 7,
    verdict: "approve",
    reason: "La version exacte est admise.",
  };
  const decide = (
    value: unknown = decision,
    agentId = "native:builder",
    headers: HeadersInit = {},
  ) =>
    handler(
      new Request(
        `http://127.0.0.1:4311/api/conversations/${
          encodeURIComponent(agentId)
        }/decisions`,
        {
          method: "POST",
          headers: { ...commandHeaders, ...headers },
          body: JSON.stringify(value),
        },
      ),
    );
  const decideChange = (
    value: unknown = {
      expectedRevision: 7,
      configurationRevision: 3,
      verdict: "approve",
    },
    agentId = "native:builder",
    changeId = "change-1",
    headers: HeadersInit = {},
  ) =>
    handler(
      new Request(
        `http://127.0.0.1:4311/api/conversations/${
          encodeURIComponent(agentId)
        }/changes/${encodeURIComponent(changeId)}/decision`,
        {
          method: "POST",
          headers: { ...commandHeaders, ...headers },
          body: JSON.stringify(value),
        },
      ),
    );
  return {
    state,
    catalog,
    calls,
    decisions,
    changeDecisions,
    decision,
    application,
    handler,
    get,
    post,
    decide,
    decideChange,
  };
}

function legacyFixture(application: ConversationsApplication) {
  const executionModel = executableFixture({
    projectId: "project",
    rootId: "root",
    editingContextId: "context",
    systemId: "system",
    catalogId: "catalog",
    builderId: "native:builder",
  });
  const changes: unknown[] = [];
  const handler = createControlHandler(
    {
      snapshot: {
        id: "operator-session",
        revision: 7,
        catalogRevision: 0,
        messages: [],
        candidates: [],
        events: [],
        busy: false,
        phase: "Ready",
        provider: "fixture",
        executionModel,
        configuration: {
          ...executionModel.configuration,
          changes: [{
            id: "change-1",
            kind: "mandate-change",
            status: "pending",
            baseRevision: 3,
            reason: "Lire la source",
            requestedAt: "2026-10-21T00:00:00Z",
          }],
        },
      },
      decideChange(command) {
        changes.push(command);
        return Promise.resolve();
      },
    },
    application,
    servedOrigin,
  );
  return { handler, changes };
}

function commandFixture(adapter: string) {
  const f = fixture();
  f.state.conversations[0]!.proposalContext = {
    configurationRevision: 3,
    before: {
      network: { allowedHosts: [] },
      builder: { admissionAuthority: "human" },
    },
    changes: [{
      id: "change-1",
      kind: "mandate-change",
      status: "pending",
      baseRevision: 3,
      reason: "Lire la source",
      requestedAt: "2026-10-21T00:00:00Z",
    }],
  };
  const legacy = legacyFixture(f.application);
  const handler = adapter === "legacy" ? legacy.handler : f.handler;
  return {
    handler,
    commandCount: () =>
      f.calls.length + f.decisions.length + f.changeDecisions.length +
      legacy.changes.length,
  };
}

for (
  const route of [
    {
      adapter: "conversations",
      path: "/api/messages",
      body: { text: "Bonjour" },
    },
    {
      adapter: "conversations",
      path: "/api/conversations/native:builder/messages",
      body: { text: "Bonjour", expectedRevision: 7 },
    },
    {
      adapter: "conversations",
      path: "/api/conversations/native:builder/decisions",
      body: {
        candidateId: "shared-candidate-id",
        candidateDigest: "a".repeat(64),
        expectedRevision: 7,
        verdict: "approve",
        reason: "Version exacte admise.",
      },
    },
    {
      adapter: "conversations",
      path: "/api/conversations/native:builder/changes/change-1/decision",
      body: {
        expectedRevision: 7,
        configurationRevision: 3,
        verdict: "approve",
      },
    },
    {
      adapter: "legacy",
      path: "/api/messages",
      body: { text: "Bonjour" },
    },
    {
      adapter: "legacy",
      path: "/api/decisions",
      body: {
        kind: "candidate",
        candidateId: "shared-candidate-id",
        candidateDigest: "a".repeat(64),
        expectedRevision: 7,
        verdict: "approve",
        reason: "Version exacte admise.",
      },
    },
    {
      adapter: "legacy",
      path: "/api/decisions",
      body: {
        kind: "change",
        changeId: "change-1",
        expectedRevision: 7,
        verdict: "approve",
      },
    },
  ]
) {
  Deno.test(`${route.adapter} POST ${route.path}${"kind" in route.body ? ` (${route.body.kind})` : ""} requires loopback Host served Origin and JSON before dispatch`, async () => {
    for (
      const [change, status, code] of [
        [{ origin: null }, 403, "ORIGIN_REFUSED"],
        [{ origin: "https://foreign.test" }, 403, "ORIGIN_REFUSED"],
        [{ origin: "null" }, 403, "ORIGIN_REFUSED"],
        [{ "sec-fetch-site": "cross-site" }, 403, "ORIGIN_REFUSED"],
        [{ host: "attacker.test:4311" }, 403, "HOST_REFUSED"],
        [{ host: "127.0.0.1:9999" }, 403, "HOST_REFUSED"],
        [{ host: null }, 403, "HOST_REFUSED"],
        [{ "content-type": "text/plain" }, 415, "JSON_REQUIRED"],
        [{ "content-type": "application/jsonp" }, 415, "JSON_REQUIRED"],
        [{ "content-type": null }, 415, "JSON_REQUIRED"],
        [{ "content-type": "application/json; charset=utf-8" }, 202, null],
        [{}, 202, null],
      ] as const
    ) {
      const { handler, commandCount } = commandFixture(route.adapter);
      const headers = new Headers(commandHeaders);
      for (const [key, value] of Object.entries(change)) {
        if (value === null) headers.delete(key);
        else headers.set(key, value);
      }
      const response = await handler(
        new Request(`${servedOrigin}${route.path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(route.body),
        }),
      );
      equal(response?.status, status, JSON.stringify(change));
      const body = await response!.json();
      if (code) {
        equal(body.code, code);
        equal(typeof body.error, "string");
        equal(typeof body.recovery, "string");
      } else deepStrictEqual(body, { accepted: true });
      equal(commandCount(), status === 202 ? 1 : 0);
    }
    for (
      const [origin, status] of [
        ["http://attacker.test:4311", 403],
        ["http://127.0.0.1:9999", 403],
        ["https://127.0.0.1:4311", 403],
        ["http://localhost:4311", 202],
      ] as const
    ) {
      const { handler, commandCount } = commandFixture(route.adapter);
      const response = await handler(
        new Request(`${origin}${route.path}`, {
          method: "POST",
          headers: {
            host: new URL(origin).host,
            origin,
            "content-type": "application/json",
          },
          body: JSON.stringify(route.body),
        }),
      );
      equal(response?.status, status, origin);
      if (status === 403) equal((await response!.json()).code, "HOST_REFUSED");
      equal(commandCount(), status === 202 ? 1 : 0);
    }
  });
}

Deno.test("conversation listing preserves source identities and starts no operator", async () => {
  const { get, calls, state } = fixture();
  state.conversations[0]!.name = "<img src=x onerror=attack()>";
  const response = await get();
  equal(response?.status, 200);
  equal(response?.headers.get("cache-control"), "no-store");
  equal(response?.headers.get("x-content-type-options"), "nosniff");
  match(response!.headers.get("content-type")!, /application\/json/);
  deepStrictEqual(await response!.json(), state);
  deepStrictEqual(calls, []);
});

Deno.test("human contribution targets the exact modeled conversation with its own revision", async () => {
  const { post, calls } = fixture();
  const response = await post({
    text: "  Une demande bornée.  ",
    expectedRevision: 7,
  });
  equal(response?.status, 202);
  deepStrictEqual(await response!.json(), { accepted: true });
  deepStrictEqual(calls, [{
    agentId: "native:builder",
    text: "Une demande bornée.",
    expectedRevision: 7,
  }]);
});

Deno.test("human message HTTP carries explicit Request selection and the new-conversation marker", async () => {
  const f = fixture();
  f.application.submitHuman = (command) => {
    f.calls.push(command);
    return Promise.resolve(
      command.caseId ?? (command.newConversation ? "new-case" : undefined),
    );
  };
  for (
    const selection of [{ caseId: "request-a" }, { newConversation: true }, {}]
  ) {
    const response = await f.post({
      text: "Suite",
      expectedRevision: 7,
      ...selection,
    });
    equal(response?.status, 202);
    deepStrictEqual(await response!.json(), {
      accepted: true,
      ...("caseId" in selection
        ? { caseId: "request-a" }
        : "newConversation" in selection
        ? { caseId: "new-case" }
        : {}),
    });
    deepStrictEqual(f.calls.at(-1), {
      agentId: "native:builder",
      text: "Suite",
      expectedRevision: 7,
      ...selection,
    });
  }
  for (
    const selection of [
      { caseId: "" },
      { caseId: null },
      { caseId: " request" },
      { caseId: 1 },
      { newConversation: false },
      { caseId: "request-a", newConversation: true },
    ]
  ) {
    const response = await f.post({
      text: "Suite",
      expectedRevision: 7,
      ...selection,
    });
    equal(response?.status, 400);
    equal((await response!.json()).code, "INVALID_MESSAGE");
  }
  equal(f.calls.length, 3);
});

Deno.test("the existing central message route uses the same Request contract without a client revision", async () => {
  const f = fixture();
  for (
    const selection of [{ caseId: "request-a" }, { newConversation: true }, {}]
  ) {
    const response = await f.handler(
      new Request("http://127.0.0.1:4311/api/messages", {
        method: "POST",
        headers: commandHeaders,
        body: JSON.stringify({ text: "Bonjour", ...selection }),
      }),
    );
    equal(response?.status, 202);
    deepStrictEqual(f.calls.at(-1), {
      agentId: "native:builder",
      expectedRevision: 7,
      text: "Bonjour",
      ...selection,
    });
  }
});

Deno.test("Request errors expose code, target context and recovery, including busy before stale", async () => {
  const f = fixture();
  const context = { caseId: "request-a", agentId: "native:builder" };
  const recovery =
    "Select an open Request owned by this agent or send newConversation: true.";
  for (
    const [code, status] of [["CASE_CLOSED", 409], ["CASE_NOT_FOUND", 404], [
      "CASE_NOT_OWNED",
      403,
    ]] as const
  ) {
    f.application.submitHuman = () =>
      Promise.reject(new CaseError(code, "Request refused", context, recovery));
    const response = await f.post({
      text: "Suite",
      expectedRevision: 7,
      caseId: context.caseId,
    });
    equal(response?.status, status);
    deepStrictEqual(await response!.json(), {
      error: "Request refused",
      code,
      context,
      recovery,
    });
  }
  f.state.conversations[0].busy = true;
  const response = await f.post({
    text: "Suite",
    expectedRevision: 6,
    caseId: context.caseId,
  });
  equal(response?.status, 409);
  deepStrictEqual(await response!.json(), {
    error: "Une réponse est déjà en cours pour cet opérateur.",
    code: "AGENT_BUSY",
    context,
    recovery: "retry after the current reply",
  });
});

Deno.test("audit, busy, stale and absent conversations refuse before starting a turn", async () => {
  const { state, post, calls } = fixture();
  const audit = await post(undefined, "native:reviewer");
  equal(audit?.status, 403);
  match((await audit!.json()).error, /uniquement la lecture/);
  equal((await post(undefined, "native:missing"))?.status, 404);
  equal((await post({ text: "Bonjour", expectedRevision: 6 }))?.status, 409);
  state.conversations[0]!.busy = true;
  equal((await post())?.status, 409);
  deepStrictEqual(calls, []);
});

Deno.test("local commands reject cross-site origins without changing operator authority", async () => {
  const { post, calls } = fixture();
  equal(
    (await post(undefined, undefined, { origin: "https://other.test" }))
      ?.status,
    403,
  );
  equal(
    (await post(undefined, undefined, { "sec-fetch-site": "cross-site" }))
      ?.status,
    403,
  );
  equal((await post(undefined, undefined, { origin: "null" }))?.status, 403);
  deepStrictEqual(calls, []);
  equal(
    (await post(undefined, undefined, { origin: "http://127.0.0.1:4311" }))
      ?.status,
    202,
  );
  equal(calls.length, 1);
});

Deno.test("conversation commands accept only bounded text and an integer CAS revision", async () => {
  const { post, calls } = fixture();
  for (
    const input of [
      null,
      [],
      "message",
      {},
      { text: "Bonjour" },
      { expectedRevision: 7 },
      { text: "Bonjour", expectedRevision: 7, canSend: true },
      { text: "Bonjour", expectedRevision: 7, agentId: "native:reviewer" },
      { text: "  ", expectedRevision: 7 },
      { text: "x".repeat(MAX_USER_MESSAGE_CHARS + 1), expectedRevision: 7 },
      { text: 42, expectedRevision: 7 },
      { text: "Bonjour", expectedRevision: "7" },
      { text: "Bonjour", expectedRevision: -1 },
      { text: "Bonjour", expectedRevision: 0.5 },
      { text: "Bonjour", expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    ]
  ) equal((await post(input))?.status, 400);
  deepStrictEqual(calls, []);
});

Deno.test("conversation transport rejects untrusted paths and query selectors", async () => {
  const { handler, get, calls } = fixture();
  for (
    const path of [
      "/api/conversations?revision=4",
      "/api/conversations?agentId=native:reviewer",
    ]
  ) equal((await get(path))?.status, 400);
  for (
    const path of [
      "/api/conversations/native%2Fforeign/messages",
      "/api/conversations/%E0%A4%A/messages",
      "/api/conversations/%00/messages",
      `/api/conversations/${"x".repeat(257)}/messages`,
      "/api/conversations/native%3Abuilder/messages?canSend=true",
    ]
  ) {
    const response = await handler(
      new Request(`http://127.0.0.1:4311${path}`, {
        method: "POST",
        headers: commandHeaders,
        body: JSON.stringify({ text: "Bonjour", expectedRevision: 7 }),
      }),
    );
    equal(response?.status, 400, path);
  }
  equal(await get("/chat"), null);
  equal(await get("/api/conversations/unavailable"), null);
  deepStrictEqual(calls, []);
});

Deno.test("conversation routes declare methods and require valid JSON", async () => {
  const { handler, get, calls } = fixture();
  equal((await get("/api/conversations", "POST"))?.headers.get("allow"), "GET");
  const wrongMethod = await get("/api/conversations/native:builder/messages");
  equal(wrongMethod?.status, 405);
  equal(wrongMethod?.headers.get("allow"), "POST");
  const request = (body: string, contentType: string) =>
    handler(
      new Request(
        "http://127.0.0.1:4311/api/conversations/native:builder/messages",
        {
          method: "POST",
          headers: { ...commandHeaders, "content-type": contentType },
          body,
        },
      ),
    );
  equal((await request("{}", "text/plain"))?.status, 415);
  equal((await request("{broken", "application/json"))?.status, 400);
  const empty = await handler(
    new Request(
      "http://127.0.0.1:4311/api/conversations/native:builder/messages",
      {
        method: "POST",
        headers: commandHeaders,
      },
    ),
  );
  equal(empty?.status, 400);
  deepStrictEqual(calls, []);
});

Deno.test("a 50 000-character message passes the HTTP route and one past the bound is refused with INVALID_MESSAGE", async () => {
  const f = fixture();
  const long = "z".repeat(50_000);
  const accepted = await f.post({ text: long, expectedRevision: 7 });
  equal(accepted?.status, 202);
  equal(f.calls.at(-1)?.text, long);
  const refused = await f.post({
    text: "z".repeat(MAX_USER_MESSAGE_CHARS + 1),
    expectedRevision: 7,
  });
  equal(refused?.status, 400);
  equal((await refused!.json()).code, "INVALID_MESSAGE");
});

Deno.test("streamed conversation bodies enforce their byte limit before parsing or application writes", async () => {
  const { handler, calls } = fixture();
  let cancelled = false;
  let chunksRead = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunksRead++;
      controller.enqueue(new Uint8Array(20_000));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await handler(
    new Request(
      "http://127.0.0.1:4311/api/conversations/native:builder/messages",
      {
        method: "POST",
        headers: { ...commandHeaders, "content-length": "2" },
        body,
      },
    ),
  );
  equal(response?.status, 413);
  equal(cancelled, true);
  equal(chunksRead <= 30, true);
  deepStrictEqual(calls, []);
});

Deno.test("a CAS failure at the application reservation is returned once without a retry", async () => {
  const { application, post, calls } = fixture();
  application.submitHuman = (command) => {
    calls.push(command);
    return Promise.reject(
      new OperatorConversationError(
        "STALE_CONVERSATION",
        "La conversation a changé; rechargez-la.",
        409,
      ),
    );
  };
  const response = await post();
  equal(response?.status, 409);
  match((await response!.json()).error, /conversation a changé/);
  equal(calls.length, 1);
});

Deno.test("an operator reservation does not serialize independent operator commands in HTTP", async () => {
  const { state, application, post, calls } = fixture();
  state.conversations[1]!.canSend = true;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => release = resolve);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => entered = resolve);
  application.submitHuman = (command) => {
    calls.push(command);
    if (command.agentId === "native:builder") {
      entered();
      return pending;
    }
    return Promise.resolve();
  };
  const first = post();
  await started;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const second = await Promise.race([
      post(undefined, "native:reviewer"),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Independent command blocked")),
          1_000,
        );
      }),
    ]);
    equal(second?.status, 202);
    equal(calls.length, 2);
    deepStrictEqual(
      new Set(calls.map((call) => call.agentId)),
      new Set([
        "native:builder",
        "native:reviewer",
      ]),
    );
  } finally {
    clearTimeout(timeout);
    release();
  }
  equal((await first)?.status, 202);
});

Deno.test("operator catalog listing preserves distinct ownership even when candidate IDs collide", async () => {
  const { get, catalog, decisions, calls } = fixture();
  const response = await get("/api/operator-tools");
  equal(response?.status, 200);
  equal(response?.headers.get("cache-control"), "no-store");
  deepStrictEqual(await response!.json(), catalog);
  deepStrictEqual(decisions, []);
  deepStrictEqual(calls, []);
});

Deno.test("human candidate admission is distinct from access to the operator's human inbox", async () => {
  const { state, decide, decision, decisions, calls } = fixture();
  equal(
    state.conversations.find((entry) => entry.agentId === "native:worker")!
      .canSend,
    false,
  );
  const response = await decide({
    ...decision,
    candidateDigest: "b".repeat(64),
    verdict: "refuse",
    reason: "  Ce candidat exact est refusé.  ",
  }, "native:worker");
  equal(response?.status, 202);
  deepStrictEqual(await response!.json(), { accepted: true });
  deepStrictEqual(decisions, [{
    agentId: "native:worker",
    candidateId: decision.candidateId,
    candidateDigest: "b".repeat(64),
    expectedRevision: 7,
    verdict: "refuse",
    reason: "Ce candidat exact est refusé.",
  }]);
  deepStrictEqual(calls, []);
});

Deno.test("candidate admission cannot cross owners or race a changed artifact or conversation", async () => {
  const { state, decide, decision, decisions, calls } = fixture();
  equal(
    (await decide({ ...decision, candidateDigest: "b".repeat(64) }))?.status,
    409,
  );
  equal(
    (await decide({ ...decision, candidateId: "absent" }, "native:worker"))
      ?.status,
    404,
  );
  equal((await decide(decision, "native:reviewer"))?.status, 404);
  equal((await decide(decision, "native:missing"))?.status, 404);
  equal((await decide({ ...decision, expectedRevision: 6 }))?.status, 409);
  state.conversations[0]!.busy = true;
  equal((await decide())?.status, 409);
  deepStrictEqual(decisions, []);
  deepStrictEqual(calls, []);
});

Deno.test("candidate admission rejects malformed or authority-bearing command fields", async () => {
  const { decide, decision, decisions } = fixture();
  for (
    const value of [
      null,
      [],
      {},
      { ...decision, candidateId: "" },
      { ...decision, candidateId: "x".repeat(257) },
      { ...decision, candidateDigest: " " },
      { ...decision, candidateDigest: 42 },
      { ...decision, candidateDigest: "x".repeat(257) },
      { ...decision, expectedRevision: "7" },
      { ...decision, expectedRevision: -1 },
      { ...decision, verdict: "activate" },
      { ...decision, reason: "  " },
      { ...decision, reason: "x".repeat(2001) },
      { ...decision, authority: "human" },
      { ...decision, agentId: "native:worker" },
      { text: "approve", expectedRevision: 7 },
    ]
  ) equal((await decide(value))?.status, 400);
  deepStrictEqual(decisions, []);
});

Deno.test("catalog and decision routes retain local origin, method and selection boundaries", async () => {
  const { get, decide, decision, decisions, handler } = fixture();
  equal((await get("/api/operator-tools?agentId=native:builder"))?.status, 400);
  equal((await get("/api/operator-tools", "POST"))?.status, 405);
  equal(
    (await get("/api/conversations/native:builder/decisions"))?.headers.get(
      "allow",
    ),
    "POST",
  );
  equal(
    (await decide(decision, undefined, { origin: "https://other.test" }))
      ?.status,
    403,
  );
  equal(
    (await decide(decision, undefined, { "sec-fetch-site": "cross-site" }))
      ?.status,
    403,
  );
  const query = await handler(
    new Request(
      "http://127.0.0.1:4311/api/conversations/native:builder/decisions?authority=human",
      {
        method: "POST",
        headers: commandHeaders,
        body: JSON.stringify(decision),
      },
    ),
  );
  equal(query?.status, 400);
  deepStrictEqual(decisions, []);
});

Deno.test("late candidate reservation failure propagates once without automatic admission retry", async () => {
  const { application, decide, decisions } = fixture();
  application.decideCandidate = (command) => {
    decisions.push(command);
    return Promise.reject(
      new OperatorConversationError(
        "STALE_CONVERSATION",
        "La conversation a changé; rechargez-la.",
        409,
      ),
    );
  };
  const response = await decide();
  equal(response?.status, 409);
  match((await response!.json()).error, /conversation a changé/);
  equal(decisions.length, 1);
});

Deno.test("owner authority invariant failures remain machine readable over HTTP", async () => {
  const { application, decide } = fixture();
  application.decideCandidate = () =>
    Promise.reject(
      new AuthorityInvariantError(
        3,
        "STALE_PROPOSAL",
        "Contrat de base modifié",
      ),
    );
  const response = await decide();
  equal(response?.status, 403);
  deepStrictEqual(await response!.json(), {
    error: "Contrat de base modifié",
    code: "AUTHORITY_INVARIANT",
    invariant: 3,
    reason: "STALE_PROPOSAL",
  });
});

Deno.test("missing candidate Case exposes a structured failure and recovery through admission HTTP", async () => {
  const { application, decide } = fixture();
  const context = { candidateId: "orphan", conversationId: "operator-session" };
  const recovery =
    "Reload the original dossier through initialize() to migrate it.";
  application.decideCandidate = () =>
    Promise.reject(
      new CaseError(
        "CASE_SCOPE_MISSING",
        "The candidate has no persisted Case ownership",
        context,
        recovery,
      ),
    );
  const response = await decide();
  equal(response?.status, 409);
  deepStrictEqual(await response!.json(), {
    error: "The candidate has no persisted Case ownership",
    code: "CASE_SCOPE_MISSING",
    context,
    recovery,
  });
});

Deno.test("legacy candidate decisions preserve Case failures after control handler extraction", async () => {
  const { application, decision } = fixture();
  const context = { candidateId: decision.candidateId };
  const recovery =
    "Reload the original dossier through initialize() to migrate it.";
  application.decideCandidate = () =>
    Promise.reject(
      new CaseError(
        "CASE_SCOPE_MISSING",
        "The candidate has no persisted Case ownership",
        context,
        recovery,
      ),
    );
  const { handler } = legacyFixture(application);
  const response = await handler(
    new Request("http://127.0.0.1:4311/api/decisions", {
      method: "POST",
      headers: commandHeaders,
      body: JSON.stringify({ kind: "candidate", ...decision }),
    }),
  );
  equal(response?.status, 409);
  deepStrictEqual(await response!.json(), {
    error: "The candidate has no persisted Case ownership",
    code: "CASE_SCOPE_MISSING",
    context,
    recovery,
  });
});

Deno.test("configuration decision targets the exact runtime proposal and revisions", async () => {
  const { state, decideChange, changeDecisions } = fixture();
  state.conversations[0]!.proposalContext = {
    configurationRevision: 3,
    before: {
      network: { allowedHosts: ["example.org"] },
      builder: { admissionAuthority: "human" },
      urlSelectionMode: "user-provided",
    },
    changes: [{
      id: "change-1",
      kind: "mandate-change",
      status: "pending",
      baseRevision: 3,
      reason: "Lire la source",
      requestedAt: "2026-10-21T00:00:00Z",
      requestedRights: { addNetworkHosts: ["docs.example.org"] },
    }],
  };
  equal((await decideChange())?.status, 202);
  deepStrictEqual(changeDecisions, [{
    agentId: "native:builder",
    changeId: "change-1",
    expectedRevision: 7,
    configurationRevision: 3,
    verdict: "approve",
  }]);
  equal((await decideChange(undefined, "native:worker"))?.status, 409);
  equal((await decideChange(undefined, "native:reviewer"))?.status, 409);
  equal(
    (await decideChange(undefined, "native:builder", "other"))?.status,
    404,
  );
  const stale = await decideChange({
    expectedRevision: 6,
    configurationRevision: 3,
    verdict: "approve",
  });
  equal(stale?.status, 409);
  const staleBody = await stale!.json();
  equal(staleBody.code, "PUBLICATION_FAILED");
  equal(staleBody.recovery, "retry");
  deepStrictEqual(staleBody.context, { changeId: "change-1" });
  equal(
    (await decideChange({
      expectedRevision: 7,
      configurationRevision: 2,
      verdict: "approve",
    }))?.status,
    409,
  );
  state.conversations[0]!.proposalContext.changes[0]!.status = "approved";
  equal((await decideChange())?.status, 202);
  equal(changeDecisions.length, 2);
});

Deno.test("configuration control rejects authority fields, foreign origin and busy runtime", async () => {
  const { state, decideChange, changeDecisions } = fixture();
  state.conversations[0]!.proposalContext = {
    configurationRevision: 3,
    before: {
      network: { allowedHosts: [] },
      builder: { admissionAuthority: "human" },
    },
    changes: [{
      id: "change-1",
      kind: "mandate-change",
      status: "pending",
      baseRevision: 3,
      reason: "R",
      requestedAt: "2026-10-21T00:00:00Z",
    }],
  };
  for (
    const value of [
      {
        expectedRevision: 7,
        configurationRevision: 3,
        verdict: "approve",
        authority: "human",
      },
      { expectedRevision: 7, configurationRevision: 3, verdict: "adjust" },
      { expectedRevision: "7", configurationRevision: 3, verdict: "approve" },
    ]
  ) equal((await decideChange(value))?.status, 400);
  equal(
    (await decideChange(undefined, undefined, undefined, {
      origin: "https://other.test",
    }))?.status,
    403,
  );
  state.conversations[0]!.busy = true;
  const busy = await decideChange();
  equal(busy?.status, 409);
  const failure = await busy!.json();
  equal(failure.code, "PUBLICATION_FAILED");
  equal(failure.recovery, "retry");
  deepStrictEqual(failure.context, { changeId: "change-1" });
  deepStrictEqual(changeDecisions, []);
});

Deno.test("configuration control delegates publication reconciliation at a moved revision", async () => {
  const { state, decideChange, changeDecisions } = fixture();
  state.conversations[0]!.proposalContext = {
    configurationRevision: 4,
    before: {
      network: { allowedHosts: ["docs.example.org"] },
      builder: { admissionAuthority: "human" },
    },
    changes: [{
      id: "change-1",
      kind: "mandate-change",
      status: "approved",
      baseRevision: 3,
      reason: "Lire la source",
      requestedAt: "2026-10-21T00:00:00Z",
      publication: { baseRepositoryVersion: "branch:before" },
    }],
  };
  equal((await decideChange())?.status, 202);
  equal(
    (await decideChange({
      expectedRevision: 7,
      configurationRevision: 3,
      verdict: "refuse",
    }))?.status,
    202,
  );
  state.conversations[0]!.proposalContext.changes[0]!.status = "pending";
  equal((await decideChange())?.status, 202);
  equal(
    (await decideChange({
      expectedRevision: 7,
      configurationRevision: 3,
      verdict: "refuse",
    }))?.status,
    202,
  );
  equal(changeDecisions.length, 4);
});

Deno.test("proposal feasibility failures preserve context and recovery over HTTP", async () => {
  const { application, decide } = fixture();
  const error = new ChangeApprovabilityError(
    "PROPOSAL_NOT_AUTHORIZED",
    "Admission déjà déléguée",
    {
      systemId: "system",
      changeId: "second",
      baseRevision: 1,
    },
  );
  application.decideCandidate = () => Promise.reject(error);
  const response = await decide();
  equal(response?.status, 403);
  const failure = await response!.json();
  deepStrictEqual(failure.context, error.context);
  deepStrictEqual(failure.recovery, error.recovery);
});

for (
  const code of [
    "PUBLICATION_ALREADY_APPLIED",
    "PUBLICATION_RECEIPT_MISMATCH",
    "PUBLICATION_NOT_APPLICABLE",
    "PUBLICATION_FAILED",
  ] as const
) {
  Deno.test(`publication failure ${code} preserves code, context and recovery over HTTP`, async () => {
    const { state, application, decideChange } = fixture();
    state.conversations[0]!.proposalContext = {
      configurationRevision: 3,
      before: {
        network: { allowedHosts: [] },
        builder: { admissionAuthority: "human" },
      },
      changes: [{
        id: "change-1",
        kind: "mandate-change",
        status: "pending",
        baseRevision: 3,
        reason: "R",
        requestedAt: "now",
      }],
    };
    const error = new ChangePublicationError(code, {
      changeId: "change-1",
      systemId: "system",
    }, "Déjà publiée");
    application.decideChange = () => Promise.reject(error);
    const response = await decideChange({
      expectedRevision: 7,
      configurationRevision: 3,
      verdict: "refuse",
    });
    equal(response?.status, 409);
    const failure = await response!.json();
    equal(failure.code, error.code);
    deepStrictEqual(failure.context, error.context);
    deepStrictEqual(failure.recovery, error.recovery);
  });
}

Deno.test("late configuration reservation conflicts expose retry recovery over HTTP", async () => {
  const { state, application, decideChange } = fixture();
  state.conversations[0]!.proposalContext = {
    configurationRevision: 3,
    before: {
      network: { allowedHosts: [] },
      builder: { admissionAuthority: "human" },
    },
    changes: [{
      id: "change-1",
      kind: "mandate-change",
      status: "pending",
      baseRevision: 3,
      reason: "R",
      requestedAt: "now",
    }],
  };
  for (const code of ["AGENT_BUSY", "STALE_CONVERSATION"]) {
    application.decideChange = () =>
      Promise.reject(
        new OperatorConversationError(code, "Concurrent reservation", 409),
      );
    const response = await decideChange();
    equal(response?.status, 409);
    const failure = await response!.json();
    equal(failure.code, "PUBLICATION_FAILED");
    equal(failure.recovery, "retry");
    deepStrictEqual(failure.context, { changeId: "change-1" });
  }
});

Deno.test("HTTP forwards explicit operator Request continuations for ownership validation without opening a general inbox", async () => {
  const f = fixture();
  equal((await f.post(undefined, "native:worker"))!.status, 403);
  equal(
    (await f.post(
      { text: "New", expectedRevision: 7, newConversation: true },
      "native:worker",
    ))!.status,
    403,
  );
  equal(
    (await f.post({
      text: "Continue",
      expectedRevision: 7,
      caseId: "owned-request",
    }, "native:worker"))!.status,
    202,
  );
  deepStrictEqual(f.calls.at(-1), {
    agentId: "native:worker",
    text: "Continue",
    expectedRevision: 7,
    caseId: "owned-request",
  });
  f.application.submitHuman = () =>
    Promise.reject(new CaseError("CASE_NOT_OWNED", "Foreign Request"));
  equal(
    (await f.post({
      text: "Continue",
      expectedRevision: 7,
      caseId: "foreign-request",
    }, "native:worker"))!.status,
    403,
  );
});

Deno.test("pending change failures preserve exact scope and await-decision recovery over HTTP", async () => {
  const f = fixture();
  f.application.submitHuman = () =>
    Promise.reject(
      new ChangePendingError({
        requestedBy: "native:builder",
        changeId: "pending",
        caseId: "request",
      }),
    );
  const response = await f.post();
  equal(response!.status, 409);
  const body = await response!.json();
  equal(body.code, "CHANGE_PENDING");
  deepStrictEqual(body.context, {
    requestedBy: "native:builder",
    changeId: "pending",
    caseId: "request",
  });
  deepStrictEqual(body.recovery, { action: "await-decision" });
});

Deno.test("missing change scope remains actionable over HTTP", async () => {
  const f = fixture();
  f.application.submitHuman = () =>
    Promise.reject(new ChangeScopeMissingError({ changeId: "legacy" }));
  const response = await f.post();
  equal(response!.status, 409);
  const body = await response!.json();
  equal(body.code, "CHANGE_SCOPE_MISSING");
  deepStrictEqual(body.context, { changeId: "legacy" });
  deepStrictEqual(body.recovery, { action: "restore-recorded-scope" });
});
