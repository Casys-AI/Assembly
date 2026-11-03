import assert from "node:assert/strict";
import { type LogRecord, reset } from "@logtape/logtape";
import { ModelVersionEvents } from "../../../application/model/revisions/version-events.ts";
import { configureTechnicalLogging } from "../../../infrastructure/logging.ts";
import { ChangePublicationError } from "../../../domain/model/publication/change.ts";
import type {
  AgentMessageCommand,
  ConversationsSnapshot,
} from "../../../domain/work/records/conversations.ts";
import {
  type ConversationsApplication,
  createConversationsHandler,
} from "./work/conversations.ts";
import { createControlHandler } from "./work/control.ts";
import { createRequestSpaceOpeningHandler } from "./work/request-space-openings.ts";
import {
  createSpaceSessionHandler,
  SPACE_SESSION_COOKIE,
} from "./work/space-session.ts";
import { SseAudience } from "../../../infrastructure/http/sse.ts";
import type { SpaceController } from "../../../domain/work/request-spaces.ts";
import {
  createHttpApp,
  createHttpServeHandler,
  type HttpAppDependencies,
  type HttpEdgeHandler,
} from "./app.ts";

const nullHandler: HttpEdgeHandler = () => Promise.resolve(null);

Deno.test("http app delegates exact Request operator inspection before model readers", async () => {
  const paths: string[] = [];
  const { base } = dependencies({
    handleRequestOperatorDetails(request) {
      paths.push(new URL(request.url).pathname);
      return Promise.resolve(
        Response.json({ caseId: "case-A", operatorId: "owner" }),
      );
    },
    handleCaseModel() {
      throw new Error("Request inspection must not fall through to Main");
    },
  });
  const response = await createHttpApp(base).request(
    "/api/request-cases/case-A/operators/owner/details",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    caseId: "case-A",
    operatorId: "owner",
  });
  assert.deepEqual(paths, [
    "/api/request-cases/case-A/operators/owner/details",
  ]);
});

Deno.test("http app delegates supervision reads to its bound handler without falling through to model readers", async () => {
  let reads = 0;
  const { base } = dependencies({
    handleRequestSupervision(request) {
      if (new URL(request.url).pathname !== "/api/system/supervision") {
        return Promise.resolve(null);
      }
      reads++;
      return Promise.resolve(Response.json({ observation: "controlled" }));
    },
    handleCaseModel() {
      throw new Error("Supervision must not fall through to a model reader");
    },
  });
  const response = await createHttpApp(base).request(
    "/api/system/supervision?limit=20",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { observation: "controlled" });
  assert.equal(reads, 1);
});

function dependencies(overrides: Partial<HttpAppDependencies> = {}) {
  const seen: string[] = [];
  const seenControl: string[] = [];
  const base: HttpAppDependencies = {
    handleFrontend: () => Promise.resolve(null),
    handleModelDiagnostics: nullHandler,
    service: { snapshot: { revision: 7, busy: false } as never },
    store: {
      listRevisions: () => Promise.resolve([]),
      loadRevision: () => Promise.resolve(null),
      loadProjection: () => Promise.resolve(null),
    },
    operatorWorkspace: {
      conversations: { conversations: () => Promise.resolve([]) },
      cases: { cases: [] },
    },
    modelVersionEvents: {
      initial: () => Promise.resolve({ version: "v" }),
      publish: () => Promise.resolve(undefined),
    },
    clients: new Set(),
    handleModelRevisions: nullHandler,
    handleControl: (request) => {
      seenControl.push(`${request.method} ${new URL(request.url).pathname}`);
      if (request.method === "POST") {
        return Promise.resolve(new Response("Not found", { status: 404 }));
      }
      return Promise.resolve(null);
    },
    handleConversations: (request) => {
      seen.push(`conversations:${new URL(request.url).pathname}`);
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === "/api/messages"
      ) {
        return Promise.resolve(
          Response.json({ accepted: true }, { status: 202 }),
        );
      }
      return Promise.resolve(null);
    },
    handleArtifactSources: nullHandler,
    handleSpaceSession: nullHandler,
    handleRequestSpaceOpenings: nullHandler,
    handleCases: nullHandler,
    project: null,
    agents: { label: "fixture" },
    projections: {
      handleModelAttention: nullHandler,
      handleModelBoard: nullHandler,
      handleAuthorityMatrix: nullHandler,
      handleSourceTokens: nullHandler,
      handleModelViews: nullHandler,
      modelAttention: { warm: () => Promise.resolve() },
      readModelBoardHead: () => Promise.resolve("head"),
    },
    liveGraph: {
      handleModelGraph: nullHandler,
      graphClients: new Set(),
      status: () => ({ version: "v", activityDigest: "d", error: null }),
    },
    ...overrides,
  };
  return { base, seen, seenControl };
}

Deno.test("http app: conversations shadows control on POST /api/messages", async () => {
  const { base, seen, seenControl } = dependencies();
  const app = createHttpApp(base);
  const response = await app.request("/api/messages", { method: "POST" });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.deepEqual(seen, ["conversations:/api/messages"]);
  // The shadowed control handler never sees the request.
  assert.deepEqual(seenControl, []);
});

Deno.test("http app: control catch-all POST 404 stays last", async () => {
  const { base, seenControl } = dependencies();
  const app = createHttpApp(base);
  const response = await app.request("/api/unknown-route", { method: "POST" });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
  assert.deepEqual(seenControl, ["POST /api/unknown-route"]);
});

Deno.test("http app: tail routes keep status codes and fallbacks", async () => {
  const { base } = dependencies();
  const app = createHttpApp(base);
  const state = await app.request("/api/state");
  assert.equal(state.status, 200);
  assert.deepEqual(await state.json(), { revision: 7, busy: false });
  const history = await app.request("/api/history/abc");
  assert.equal(history.status, 404);
  assert.equal(await history.text(), "Not found");
  const missing = await app.request("/api/nope");
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "Not found");
  const method = await app.request("/api/state", { method: "PUT" });
  assert.equal(method.status, 405);
  assert.equal(await method.text(), "Method not allowed");
  const health = await app.request("/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ready: true,
    modelReady: true,
    provider: "fixture",
    modelBackend: "SysML Toolkit + Git",
    modelProject: null,
  });
});

Deno.test("http app: an event stream opened with a Request session joins its owner's audience until it closes", async () => {
  const audience = new SseAudience<SpaceController>();
  const identified: Array<string | null> = [];
  const { base } = dependencies({
    eventAudience: {
      identify(request) {
        const cookie = request.headers.get("cookie");
        identified.push(cookie);
        // Like spaceSessionSecret, a missing session refuses synchronously.
        if (cookie !== `${SPACE_SESSION_COOKIE}=${"a".repeat(64)}`) {
          throw new Error("A current local control session is required.");
        }
        return Promise.resolve({ ownerId: "owner" } as SpaceController);
      },
      audience,
    },
  });
  const app = createHttpApp(base);
  const decoder = new TextDecoder();
  const readUntil = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    marker: string,
  ) => {
    let text = "";
    while (!text.includes(marker)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    return text;
  };
  const owned = await app.request("/api/events", {
    headers: { cookie: `${SPACE_SESSION_COOKIE}=${"a".repeat(64)}` },
  });
  const anonymous = await app.request("/api/events");
  const ownedReader = owned.body!.getReader();
  const anonymousReader = anonymous.body!.getReader();
  await readUntil(ownedReader, "event: model-version");
  await readUntil(anonymousReader, "event: model-version");
  const toOwner = (member: SpaceController) => member.ownerId === "owner";
  await audience.send(toOwner, "case-model-version", { caseId: "case-A" });
  assert.match(
    await readUntil(ownedReader, "case-model-version"),
    /event: case-model-version\ndata: \{"caseId":"case-A"\}/,
  );
  await ownedReader.cancel();
  // Neither the closed stream nor the stream without a session hears it.
  await audience.send(toOwner, "case-model-version", { caseId: "case-B" });
  const pending = anonymousReader.read();
  const quiet = await Promise.race([
    pending.then(() => "event"),
    new Promise((resolve) => setTimeout(() => resolve("quiet"), 20)),
  ]);
  assert.equal(quiet, "quiet");
  await anonymousReader.cancel();
  assert.deepEqual(identified, [
    `${SPACE_SESSION_COOKIE}=${"a".repeat(64)}`,
    null,
  ]);
});

Deno.test("http app: delegation errors keep the mapped status", async () => {
  const failing: HttpEdgeHandler = () => {
    throw new ChangePublicationError("PUBLICATION_FAILED", {
      changeId: "change",
      systemId: "system",
    }, "L’état a changé.");
  };
  const { base } = dependencies();
  base.projections.handleModelBoard = failing;
  const app = createHttpApp(base);
  const response = await app.request("/api/model/board");
  assert.equal(response.status, 409);
  const body = await response.json() as { code: string };
  assert.equal(body.code, "PUBLICATION_FAILED");
});

Deno.test("http app: serve info reaches the frontend handler", async () => {
  let received: unknown = "unset";
  const { base } = dependencies({
    handleFrontend: (_request, info) => {
      received = info === undefined ? "undefined" : "defined";
      return Promise.resolve(null);
    },
  });
  const handle = createHttpServeHandler(base);
  const info = {
    remoteAddr: { transport: "tcp", hostname: "127.0.0.1", port: 1 },
  } as never;
  const response = await handle(
    new Request("http://localhost/api/state"),
    info,
  );
  assert.equal(response.status, 200);
  assert.equal(received, "defined");
});

Deno.test("http app: production handlers keep the POST /api/messages shadow", async () => {
  const servedOrigin = "http://127.0.0.1:4311";
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
    }],
  };
  const submitted: AgentMessageCommand[] = [];
  const shadowed: AgentMessageCommand[] = [];
  const application = (
    calls: AgentMessageCommand[],
  ): ConversationsApplication => ({
    get snapshot() {
      return structuredClone(state);
    },
    get catalogSnapshot() {
      return { systemId: state.systemId, version: "catalog", tools: [] };
    },
    submitHuman(command) {
      calls.push(command);
      return Promise.resolve(undefined);
    },
    decideCandidate: () => Promise.resolve(),
    decideChange: () => Promise.resolve(),
  });
  const { base } = dependencies({
    handleConversations: createConversationsHandler(
      application(submitted),
      servedOrigin,
    ),
    // Control would accept POST /api/messages too; it must never run.
    handleControl: createControlHandler(
      {
        snapshot: { revision: 7, busy: false } as never,
        decideChange: () => Promise.resolve(),
      },
      application(shadowed),
      servedOrigin,
    ),
  });
  const app = createHttpApp(base);
  const response = await app.request(`${servedOrigin}/api/messages`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:4311",
      origin: servedOrigin,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "Bonjour" }),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.deepEqual(submitted, [{
    agentId: "native:builder",
    text: "Bonjour",
    expectedRevision: 7,
  }]);
  assert.deepEqual(shadowed, []);
});

Deno.test("http app: real session and opening adapters precede legacy command routing", async () => {
  const origin = "http://127.0.0.1:4311";
  const capability = "a".repeat(64);
  const session = "b".repeat(64);
  const commands: unknown[] = [];
  let exchanges = 0;
  const view = {
    id: "opening",
    caseId: "case",
    caseNumber: 1,
    executionSpaceId: "space",
    branchId: "branch",
    initialContributionId: "input",
    phase: "dispatched" as const,
    revision: 5,
    sourceVersion: `commit:${"c".repeat(40)}`,
    release: null,
    admissionId: "admission",
    issues: [],
  };
  const { base, seen, seenControl } = dependencies({
    handleSpaceSession: createSpaceSessionHandler({
      exchange(secret) {
        assert.equal(secret, capability);
        exchanges++;
        return Promise.resolve({
          secret: session,
          expiresAt: "2099-01-01T00:00:00Z",
        });
      },
    }, origin),
    handleRequestSpaceOpenings: createRequestSpaceOpeningHandler({
      open(command, secret) {
        assert.equal(secret, session);
        commands.push(command);
        return Promise.resolve(view);
      },
    }, origin),
  });
  const app = createHttpApp(base);
  const post = (path: string, body: unknown, cookie?: string) =>
    app.fetch(
      new Request(origin + path, {
        method: "POST",
        headers: {
          host: "127.0.0.1:4311",
          origin,
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  const exchange = await post("/api/space-session/exchange", {
    capabilitySecret: capability,
  });
  assert.equal(exchange.status, 200);
  assert.equal(exchanges, 1);
  assert.equal((await exchange.text()).includes(session), false);
  const setCookie = exchange.headers.get("set-cookie")!;
  assert.match(setCookie, /HttpOnly; SameSite=Strict/);
  assert.equal(setCookie.includes("Domain="), false);
  const cookie = setCookie.split(";")[0];
  assert.equal(cookie, `${SPACE_SESSION_COOKIE}=${session}`);

  const currentMain = {
    openingKey: "stable_main_intention",
    text: "Open from the selected current main",
    source: { kind: "current-main", expectedVersion: view.sourceVersion },
  };
  const retainedRelease = {
    openingKey: "stable_release_intention",
    text: "Open from the selected Release",
    source: {
      kind: "release",
      releaseId: "retained_release",
      digest: "d".repeat(64),
    },
  };
  for (const command of [currentMain, retainedRelease, currentMain]) {
    const opened = await post(
      "/api/request-space-openings/open",
      command,
      cookie,
    );
    assert.equal(opened.status, 200);
    assert.deepEqual(await opened.json(), view);
  }
  // The transport keeps retry identity and source selection unchanged. Durable
  // replay/source pinning are covered by the opening service's own witnesses.
  assert.deepEqual(commands, [currentMain, retainedRelease, currentMain]);
  assert.deepEqual(seen, []);
  assert.deepEqual(seenControl, []);

  assert.equal(
    (await post("/api/request-space-openings/open", currentMain)).status,
    403,
  );
  assert.equal(
    (await post(
      "/api/request-space-openings/open?owner=other",
      currentMain,
      cookie,
    )).status,
    400,
  );
  assert.equal(
    (await post("/api/request-space-openings/open", {
      ...currentMain,
      executionSpaceId: "main",
    }, cookie)).status,
    400,
  );
  assert.equal(commands.length, 3);
  assert.deepEqual(seenControl, []);
  const method = await app.fetch(
    new Request(origin + "/api/request-space-openings/open"),
  );
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "POST");
  // No issue endpoint was introduced by registration of the exchange adapter.
  assert.equal((await post("/api/space-session/issue", {})).status, 404);
  assert.equal(exchanges, 1);
});

Deno.test("http app: provider resource handler owns its GET and method errors before legacy delegation", async () => {
  const seen: string[] = [];
  const { base, seenControl } = dependencies({
    handleProviderResources(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/api/performance/provider-resources") {
        return Promise.resolve(null);
      }
      seen.push(request.method);
      return Promise.resolve(
        Response.json({ pin: "executed" }, {
          status: request.method === "GET" ? 200 : 405,
        }),
      );
    },
  });
  const app = createHttpApp(base);
  assert.equal(
    (await app.request("/api/performance/provider-resources")).status,
    200,
  );
  assert.equal(
    (await app.request("/api/performance/provider-resources", {
      method: "POST",
    })).status,
    405,
  );
  assert.deepEqual(seen, ["GET", "POST"]);
  assert.deepEqual(seenControl, []);
  assert.equal((await app.request("/api/state")).status, 200);
});

Deno.test("development environment endpoint and HTTP edge keep Host and Origin local", async () => {
  const { base } = dependencies({ environment: "development" });
  const app = createHttpApp(base);
  const request = (path: string, headers: HeadersInit, method = "GET") =>
    app.fetch(new Request(`http://127.0.0.1:4399${path}`, { method, headers }));
  const configuration = await request("/api/environment", {
    host: "127.0.0.1:4399",
  });
  assert.equal(configuration.status, 200);
  assert.deepEqual(await configuration.json(), { environment: "development" });
  assert.equal(configuration.headers.get("cache-control"), "no-store");
  assert.equal(
    (await request("/api/environment", {
      host: "127.0.0.1:4399",
      "sec-fetch-site": "cross-site",
    })).status,
    403,
  );
  assert.equal(
    (await request("/api/environment", {
      host: "127.0.0.1:4399",
      origin: "http://localhost:5173",
      "sec-fetch-site": "cross-site",
    })).status,
    200,
  );
  assert.equal(
    (await request("/api/environment", { host: "evil.example" })).status,
    403,
  );
  assert.equal(
    (await request("/api/environment", {
      host: "127.0.0.1:4399",
      origin: "http://evil.example",
    })).status,
    403,
  );
  assert.equal(
    (await request("/api/messages", {
      host: "127.0.0.1:4399",
      origin: "http://evil.example",
    }, "POST")).status,
    403,
  );
  assert.equal(
    (await request("/api/messages", {
      host: "127.0.0.1:4399",
      origin: "http://localhost:5173",
    }, "POST")).status,
    202,
  );
});
Deno.test("environment endpoint defaults to production", async () => {
  const { base } = dependencies();
  const response = await createHttpApp(base).request("/api/environment");
  assert.deepEqual(await response.json(), { environment: "production" });
});

Deno.test("http app: /api/events keeps state, conversations and cases when the model version notice fails", async () => {
  const warnings: LogRecord[] = [];
  await configureTechnicalLogging({
    level: "warning",
    sink: (record) => {
      warnings.push(record);
    },
  });
  try {
    const revision = {
      version: `commit:${"a".repeat(40)}`,
      sourceDigest: "sources",
      sources: {},
      elements: [],
      documents: [],
      semanticDigest: "",
      provenanceDigest: "",
      sourceHashes: {},
      engineVersion: "fixture",
    };
    for (const failure of ["current", "journal", undefined]) {
      const warningCount = warnings.length;
      const error = Object.assign(new Error(`${failure} unavailable`), {
        code: "MODEL_NOTIFICATION_FAILED",
        context: { phase: failure },
        recovery: "Restore the advisory source before retrying.",
      });
      const modelVersionEvents = new ModelVersionEvents({
        current: () =>
          failure === "current"
            ? Promise.reject(error)
            : Promise.resolve(revision),
        readProposalJournal: () =>
          failure === "journal" ? Promise.reject(error) : Promise.resolve([]),
      }, () => {});
      const { base } = dependencies({
        modelVersionEvents,
        operatorWorkspace: {
          conversations: {
            conversations: () => Promise.resolve([{ id: "conversation" }]),
          },
          cases: { cases: [{ id: "case" }] },
        },
      });
      const controller = new AbortController();
      const response = await createHttpApp(base).request("/api/events", {
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      const reader = response.body!.getReader();
      const expected = [
        "state",
        "conversations",
        "cases",
        ...(failure ? [] : ["model-version"]),
      ];
      try {
        for (const name of expected) {
          const { value } = await reader.read();
          assert.match(
            new TextDecoder().decode(value),
            new RegExp(`^event: ${name}\\ndata: `),
          );
        }
      } finally {
        await reader.cancel();
        controller.abort();
      }
      assert.equal(warnings.length, warningCount + (failure ? 1 : 0));
      if (failure) {
        const warning = warnings.at(-1)!;
        assert.deepEqual(warning.category, ["http"]);
        assert.equal(
          warning.message.join(""),
          "Initial model version notification failed",
        );
        assert.deepEqual(warning.properties, {
          code: error.code,
          context: error.context,
          recovery: error.recovery,
          error: error.message,
          stack: error.stack,
        });
      }
    }
    assert.equal(warnings.length, 2);
  } finally {
    await reset();
  }
});
