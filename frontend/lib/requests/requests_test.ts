import { parseConversationsSnapshot } from "../conversations/state.ts";
import { localSkillRelease } from "../../test/support/release-opening-fixture.ts";
import { deepStrictEqual, equal, match, ok, throws } from "node:assert/strict";
import {
  capabilitySecretFromFile,
  createRequests,
  type IntentStorage,
} from "./requests.ts";
import { caseRecord } from "../../test/support/case-fixture.ts";
import type { Fetcher } from "../workbench/api.ts";

/** Execute fixture assertions immediately while preserving Promise rejection. */
function fixtureResponse(run: () => Response): Promise<Response> {
  return new Promise((resolve) => resolve(run()));
}

const origin = "http://127.0.0.1:4311";
const version = `commit:${"a".repeat(40)}`;
const secret = "b".repeat(64);
const host = {
  projectId: "git:45a0a316-1773-4c47-80a5-b1688a28ab6c",
  systemId: "54014246-1c70-4039-88d6-6b6bf1e3d8ee",
};
const file = () => ({
  format: 1,
  ...host,
  origin,
  credentialId: "credential",
  expiresAt: "2999-01-01T00:00:00.000Z",
  capabilitySecret: secret,
});
function memory() {
  const values = new Map<string, string>();
  const storage: IntentStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  return { storage, values };
}
const record = (id: string, number = 1) =>
  caseRecord(number, {
    id,
    owner: "same-native",
    modelPin: { digest: "pin", repositoryVersion: version },
  });
const conversation = (caseId: string, revision = 17) => ({
  agentId: "same-native",
  nativeId: "same-native",
  runtimeOwned: true,
  name: "Owner",
  responsibility: "Answer",
  primary: false,
  canSend: false,
  revision,
  busy: false,
  phase: "Ready",
  modelDigest: "c".repeat(64),
  repositoryVersion: version,
  messages: [{
    id: `message-${caseId}`,
    role: "assistant",
    text: caseId,
    at: "2026-10-30T00:00:00Z",
    caseId,
  }],
});
const read = (caseId: string, revision = 17) => ({
  systemId: "runtime-projection",
  defaultAgentId: "same-native",
  version: `v-${caseId}-${revision}`,
  conversations: [conversation(caseId, revision)],
});
function fixture(fetch: Fetcher, retained = memory()) {
  return {
    retained,
    requests: createRequests({
      fetch,
      origin: () => origin,
      host: () => host,
      storage: () => retained.storage,
      createKey: () => "one-stable-intention",
    }),
  };
}

Deno.test("local control import checks exact host/origin/fields and bounded file before exchange without persisting a secret", async () => {
  equal(capabilitySecretFromFile(JSON.stringify(file()), origin, host), secret);
  for (
    const patch of [
      { origin: "http://localhost:4311" },
      { projectId: "foreign" },
      { systemId: "foreign" },
      { expiresAt: "2020-01-01" },
      { capabilitySecret: "bad" },
      { ownerId: "invented" },
    ]
  ) {
    throws(() =>
      capabilitySecretFromFile(
        JSON.stringify({ ...file(), ...patch }),
        origin,
        host,
      )
    );
  }
  const calls: string[] = [];
  const f = fixture((path, init) =>
    fixtureResponse(() => {
      calls.push(path);
      if (path === "/api/space-session/exchange") {
        deepStrictEqual(JSON.parse(String(init?.body)), {
          capabilitySecret: secret,
        });
        equal(init?.credentials, "same-origin");
        return Response.json({ expiresAt: file().expiresAt });
      }
      return Response.json({ systemId: host.systemId, cases: [] });
    })
  );
  equal(
    await f.requests.connect({
      size: 4097,
      text: () => Promise.resolve(JSON.stringify(file())),
    }),
    false,
  );
  deepStrictEqual(calls, []);
  equal(
    await f.requests.connect({
      size: 500,
      text: () => Promise.resolve(JSON.stringify(file())),
    }),
    true,
  );
  deepStrictEqual(calls, [
    "/api/space-session/exchange",
    "/api/cases?space=requests",
  ]);
  equal(f.retained.values.size, 0);
  ok(!JSON.stringify(f.requests.intent.peek()).includes(secret));
});

Deno.test("opening persists exact intention before sending and reconstructs pending work without an automatic command or Main fallback", async () => {
  const retained = memory();
  const commands: unknown[] = [];
  let stage = 0;
  const fetch: Fetcher = (path, init) =>
    fixtureResponse(() => {
      if (path === "/api/request-space-openings/open") {
        const body = JSON.parse(String(init?.body));
        commands.push(body);
        equal(
          JSON.parse([...retained.values.values()][0]).openingKey,
          body.openingKey,
        );
        if (stage++ === 0) throw new TypeError("Lost acknowledgement");
        return Response.json({
          id: "opening",
          caseId: "caseA",
          caseNumber: 1,
          branchId: "branchA",
          executionSpaceId: "spaceA",
          initialContributionId: "first",
          sourceVersion: version,
          phase: stage === 2 ? "branch-ready" : "dispatched",
          revision: 4,
          admissionId: "admission",
          release: null,
          issues: [],
        });
      }
      if (path === "/api/cases?space=requests") {
        return Response.json({
          systemId: host.systemId,
          cases: [record("caseA")],
        });
      }
      if (path === "/api/cases/caseA?space=requests") {
        return Response.json({
          systemId: host.systemId,
          case: record("caseA"),
        });
      }
      if (path === "/api/conversations?caseId=caseA") {
        return Response.json(read("caseA"));
      }
      if (path === "/api/case-model/caseA") {
        return Response.json({
          caseId: "caseA",
          branchId: "branchA",
          executionSpaceId: "spaceA",
          version,
          branchVersion: version,
          executionVersion: version,
          readOnly: true,
          release: null,
        });
      }
      throw new Error(`Unexpected route ${path}`);
    });
  const first = fixture(fetch, retained).requests;
  first.sessionReady.value = true;
  equal(await first.open("  First request  "), null);
  const second = fixture(fetch, retained).requests;
  second.restore();
  second.sessionReady.value = true;
  equal(commands.length, 1);
  equal(second.intent.peek()?.text, "First request");
  equal(await second.open("Changed request"), null);
  equal(commands.length, 1);
  equal(await second.open("First request"), null);
  equal(second.opening.peek()?.phase, "branch-ready");
  equal(retained.values.size, 1);
  equal(await second.open("First request"), "caseA");
  deepStrictEqual(commands, [commands[0], commands[0], commands[0]]);
  equal(retained.values.size, 0);
  equal(second.scopes.peek().get("caseA")?.branchId, "branchA");
});

Deno.test("malformed admission acknowledgements preserve the exact durable opening intention without navigation or fallback", async () => {
  for (const phase of ["admitted", "dispatched"]) {
    for (const admissionId of [undefined, null, 17, {}, "", "a".repeat(129)]) {
      const retained = memory();
      const calls: { path: string; body: unknown }[] = [];
      const fetch: Fetcher = (path, init) =>
        fixtureResponse(() => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          equal(path, "/api/request-space-openings/open");
          return Response.json({
            id: "opening",
            caseId: "caseA",
            caseNumber: 1,
            branchId: "branchA",
            executionSpaceId: "spaceA",
            initialContributionId: "first",
            sourceVersion: version,
            phase,
            revision: 4,
            admissionId,
            release: null,
            issues: [],
          });
        });
      const first = fixture(fetch, retained).requests;
      first.sessionReady.value = true;
      equal(await first.open("First request"), null);
      equal(first.opening.peek(), null);
      ok(first.error.peek().includes("acknowledgement is unreadable"));
      equal(retained.values.size, 1);
      const saved = [...retained.values.entries()];
      const second = fixture(fetch, retained).requests;
      second.restore();
      second.sessionReady.value = true;
      deepStrictEqual(second.intent.peek(), {
        openingKey: "one-stable-intention",
        text: "First request",
        source: { kind: "current-main" },
      });
      equal(await second.open("First request"), null);
      equal(second.opening.peek(), null);
      ok(second.error.peek().includes("acknowledgement is unreadable"));
      deepStrictEqual([...retained.values.entries()], saved);
      deepStrictEqual(calls, [calls[0], calls[0]]);
    }
  }
});

Deno.test("unavailable durable intent storage prevents opening and malformed persisted intention is never silently replaced", async () => {
  let writes = 0;
  const f = fixture(() =>
    fixtureResponse(() => {
      writes++;
      return Response.json({});
    })
  );
  f.requests.sessionReady.value = true;
  f.retained.storage.setItem = () => {
    throw new Error("Storage denied");
  };
  equal(await f.requests.open("Request"), null);
  equal(writes, 0);
  const broken = memory();
  broken.values.set(
    `assembly-request-opening:${origin}:${host.projectId}:${host.systemId}`,
    "{broken",
  );
  const restored = fixture(() =>
    fixtureResponse(() => {
      writes++;
      return Response.json({});
    }), broken).requests;
  restored.sessionReady.value = true;
  equal(await restored.open("Request"), null);
  equal(writes, 0);
});

Deno.test("A/B reuse one native identity but keep their selected reads and exact contribution revision isolated", async () => {
  const calls: { path: string; body: unknown }[] = [];
  let refuse = false;
  const f = fixture((path, init) =>
    fixtureResponse(() => {
      calls.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (refuse) {
        return Response.json({
          code: "FORBIDDEN",
          error: "Session expired",
          context: { session: "invalid" },
        }, { status: 403 });
      }
      if (path === "/api/cases?space=requests") {
        return Response.json({
          systemId: host.systemId,
          cases: [record("caseA"), record("caseB", 2)],
        });
      }
      if (path === "/api/conversations?caseId=caseA") {
        return Response.json(read("caseA", 17));
      }
      if (path === "/api/conversations?caseId=caseB") {
        return Response.json(read("caseB", 42));
      }
      if (path === "/api/conversations/same-native/messages?space=requests") {
        return Response.json({ accepted: true, caseId: "caseB" });
      }
      throw new Error(`Unexpected route ${path}`);
    })
  );
  await f.requests.cases.refresh();
  await Promise.all([f.requests.refresh("caseA"), f.requests.refresh("caseB")]);
  equal(f.requests.conversation("caseA")?.messages[0].text, "caseA");
  equal(f.requests.conversation("caseB")?.messages[0].text, "caseB");
  equal(
    await f.requests.send(
      "caseB",
      f.requests.conversation("caseA")!,
      "Wrong displayed revision",
    ),
    false,
  );
  equal(
    await f.requests.send(
      "caseB",
      f.requests.conversation("caseB")!,
      "Continue B",
    ),
    true,
  );
  deepStrictEqual(calls.find((call) => call.body), {
    path: "/api/conversations/same-native/messages?space=requests",
    body: { caseId: "caseB", text: "Continue B", expectedRevision: 42 },
  });
  refuse = true;
  await f.requests.refresh("caseB");
  equal(f.requests.canSend("caseB", f.requests.conversation("caseB")), false);
  equal(f.requests.sessionReady.peek(), false);
  ok(
    calls.every((call) =>
      call.path !== "/api/messages" && call.path !== "/api/conversations" &&
      call.path !== "/api/cases"
    ),
  );
});

Deno.test("a stale Request contribution is reread and retried once with the fresh revision", async () => {
  for (const secondStale of [false, true]) {
    const events: Array<{ path: string; body?: unknown }> = [];
    let revision = 17;
    let writes = 0;
    const f = fixture((path, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      events.push({ path, ...(body ? { body } : {}) });
      if (path === "/api/cases?space=requests") {
        return Promise.resolve(Response.json({
          systemId: host.systemId,
          cases: [record("caseA")],
        }));
      }
      if (path === "/api/conversations?caseId=caseA") {
        return Promise.resolve(Response.json(read("caseA", revision)));
      }
      if (path === "/api/conversations/same-native/messages?space=requests") {
        writes++;
        revision = 18;
        if (writes === 1 || secondStale) {
          return Promise.resolve(Response.json({
            code: "STALE_CONVERSATION",
            error: "Conversation changed",
          }, { status: 409 }));
        }
        return Promise.resolve(
          Response.json({ accepted: true, caseId: "caseA" }),
        );
      }
      throw new Error(`Unexpected route ${path}`);
    });
    await f.requests.cases.refresh();
    await f.requests.refresh("caseA");
    const start = events.length;
    const draft = "Keep this contribution";
    const sent = await f.requests.send(
      "caseA",
      f.requests.conversation("caseA")!,
      draft,
    );
    equal(sent, !secondStale);
    const action = events.slice(start);
    const posts = action.filter((event) => event.body);
    deepStrictEqual(posts.map((event) => event.body), [
      { caseId: "caseA", text: draft, expectedRevision: 17 },
      { caseId: "caseA", text: draft, expectedRevision: 18 },
    ]);
    ok(
      action.findIndex((event) =>
        event.path === "/api/conversations?caseId=caseA"
      ) > 0,
    );
    ok(
      action.findIndex((event) =>
        event.path === "/api/conversations?caseId=caseA"
      ) < action.indexOf(posts[1]),
    );
    if (secondStale) {
      match(
        f.requests.writeErrors.peek().get("caseA") ?? "",
        /STALE_CONVERSATION/,
      );
    }
  }
});

Deno.test("a stale Request never retries after its runtime or owner identity changes", async () => {
  for (const changed of ["owner", "system"] as const) {
    let afterRefusal = false;
    const posts: string[] = [];
    const f = fixture(async (path) => {
      if (path === "/api/cases?space=requests") {
        return Response.json({
          systemId: host.systemId,
          cases: [
            afterRefusal && changed === "owner"
              ? { ...record("caseA"), owner: "new-native" }
              : record("caseA"),
          ],
        });
      }
      if (path === "/api/conversations?caseId=caseA") {
        const value = read("caseA", afterRefusal ? 18 : 17);
        if (afterRefusal && changed === "system") {
          value.systemId = "other-runtime";
        }
        if (afterRefusal && changed === "owner") {
          value.conversations[0].nativeId = "new-native";
        }
        return Response.json(value);
      }
      if (path.includes("/messages?space=requests")) {
        posts.push(path);
        afterRefusal = true;
        if (changed === "owner") await f.requests.cases.refresh();
        return Response.json({
          code: "STALE_CONVERSATION",
          error: "Conversation changed",
        }, { status: 409 });
      }
      throw new Error(`Unexpected route ${path}`);
    });
    await f.requests.cases.refresh();
    await f.requests.refresh("caseA");
    equal(
      await f.requests.send(
        "caseA",
        f.requests.conversation("caseA")!,
        "Keep message",
      ),
      false,
    );
    deepStrictEqual(posts, [
      "/api/conversations/same-native/messages?space=requests",
    ]);
    match(
      f.requests.writeErrors.peek().get("caseA") ?? "",
      /STALE_CONVERSATION/,
    );
  }
});

Deno.test("a stale Request waits for an older poll then reads again before retrying", async () => {
  let resolvePoll!: (response: Response) => void;
  const poll = new Promise<Response>((resolve) => resolvePoll = resolve);
  let reads = 0;
  let pendingSignal: AbortSignal | undefined;
  const events: Array<
    string | { caseId: string; text: string; expectedRevision: number }
  > = [];
  const f = fixture((path, init) => {
    if (path === "/api/cases?space=requests") {
      return Promise.resolve(
        Response.json({ systemId: host.systemId, cases: [record("caseA")] }),
      );
    }
    if (path === "/api/conversations?caseId=caseA") {
      reads++;
      events.push(`read-${reads}`);
      if (reads === 2) {
        pendingSignal = init?.signal ?? undefined;
        return poll;
      }
      return Promise.resolve(
        Response.json(read("caseA", reads === 1 ? 17 : 18)),
      );
    }
    if (path === "/api/conversations/same-native/messages?space=requests") {
      events.push(JSON.parse(String(init?.body)));
      const writes = events.filter((event) => typeof event !== "string").length;
      return Promise.resolve(
        writes === 1
          ? Response.json({
            code: "STALE_CONVERSATION",
            error: "Conversation changed",
          }, { status: 409 })
          : Response.json({ accepted: true, caseId: "caseA" }),
      );
    }
    throw new Error(`Unexpected route ${path}`);
  });
  await f.requests.cases.refresh();
  await f.requests.refresh("caseA");
  const release = f.requests.retain("caseA");
  const oldPoll = f.requests.refresh("caseA");
  const sending = f.requests.send(
    "caseA",
    f.requests.conversation("caseA")!,
    "Keep message",
  );
  // The rejection is handled while the already-running poll remains unresolved.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  deepStrictEqual(events, ["read-1", "read-2", {
    caseId: "caseA",
    text: "Keep message",
    expectedRevision: 17,
  }]);
  release();
  equal(
    pendingSignal?.aborted,
    false,
    "ordinary send awaits keep the shared read alive",
  );
  resolvePoll(Response.json(read("caseA", 17)));
  await oldPoll;
  equal(await sending, true);
  deepStrictEqual(events.slice(0, 5), [
    "read-1",
    "read-2",
    { caseId: "caseA", text: "Keep message", expectedRevision: 17 },
    "read-3",
    { caseId: "caseA", text: "Keep message", expectedRevision: 18 },
  ]);
  equal(events.filter((event) => typeof event !== "string").length, 2);
});

Deno.test("a foreign Case conversation response is terminal and never becomes the selected Request", async () => {
  const f = fixture(() => Promise.resolve(Response.json(read("foreign"))));
  await f.requests.refresh("caseA");
  equal(f.requests.conversation("caseA"), null);
  ok(f.requests.readErrors.peek().get("caseA"));
});

Deno.test("browser import uses static host context instead of a runtime projection identity", async () => {
  const calls: string[] = [];
  const requests = createRequests({
    origin: () => origin,
    storage: () => memory().storage,
    fetch: (path) => {
      calls.push(path);
      if (path === "/api/request-space-openings/context") {
        return Promise.resolve(Response.json(host));
      }
      throw new Error("No exchange is allowed for the foreign descriptor");
    },
  });
  equal(await requests.loadContext(), true);
  deepStrictEqual(requests.context.peek(), host);
  equal(
    await requests.connect({
      size: 500,
      text: () =>
        Promise.resolve(
          JSON.stringify({ ...file(), systemId: "request-runtime-id" }),
        ),
    }),
    false,
  );
  ok(calls.every((path) => path === "/api/request-space-openings/context"));
});

Deno.test("a remembered exact Release opens without consulting the catalogue or inspecting it again", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const f = fixture((path, init) => {
    calls.push({
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (path === "/api/request-space-openings/open") {
      throw new TypeError("Lost acknowledgement");
    }
    throw new Error(`Unexpected route ${path}`);
  });
  const source = {
    kind: "release" as const,
    releaseId: "remembered",
    digest: "d".repeat(64),
  };
  f.requests.sessionReady.value = true;
  f.requests.source.value = source;
  equal(await f.requests.open("Use remembered Release"), null);
  deepStrictEqual(calls, [{
    path: "/api/request-space-openings/open",
    body: {
      openingKey: "one-stable-intention",
      text: "Use remembered Release",
      source,
    },
  }]);
});

Deno.test("an exact Release is inspected and verified before its immutable digest becomes the opening source", async () => {
  const manifestDigest = "d".repeat(64);
  const view = {
    id: "releaseA",
    metadata: { name: "Release A" },
    status: "retained",
    digest: manifestDigest,
    origin: { ...host, executionSpaceId: "main" },
    source: { branch: { kind: "main" }, sourceVersion: version },
    issues: [],
    selectedOperators: [],
    prerequisites: [],
    assetAvailability: "verified",
  };
  const calls: { path: string; body: unknown }[] = [];
  const f = fixture((path, init) =>
    fixtureResponse(() => {
      calls.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (path === "/api/saved-systems/list") {
        return Response.json([{ ...view, assetAvailability: "unchecked" }]);
      }
      if (path === "/api/saved-systems/list?space=requests") {
        return Response.json([]);
      }
      if (path === "/api/saved-systems/releaseA/inspect") {
        return Response.json(view);
      }
      if (path === "/api/request-space-openings/open") {
        throw new TypeError("Lost acknowledgement");
      }
      throw new Error(`Unexpected route ${path}`);
    })
  );
  await f.requests.loadReleases();
  deepStrictEqual(f.requests.source.peek(), { kind: "current-main" });
  await f.requests.selectRelease("releaseA");
  deepStrictEqual(f.requests.source.peek(), {
    kind: "release",
    releaseId: "releaseA",
    digest: manifestDigest,
  });
  f.requests.sessionReady.value = true;
  equal(await f.requests.open("Use exact Release"), null);
  deepStrictEqual(calls.at(-1)?.body, {
    openingKey: "one-stable-intention",
    text: "Use exact Release",
    source: { kind: "release", releaseId: "releaseA", digest: manifestDigest },
  });
});

Deno.test("fresh Request source choice includes truthful owned local-skill Release candidates and sends exact ID/digest", async () => {
  const main = localSkillRelease("mainRelease");
  const owned = localSkillRelease("ownedRelease", "caseA");
  const calls: Array<{ path: string; body: unknown }> = [];
  const f = fixture((path, init) => {
    calls.push({
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (path === "/api/saved-systems/list") {
      return Promise.resolve(Response.json([main]));
    }
    if (path === "/api/saved-systems/list?space=requests") {
      return Promise.resolve(Response.json([owned]));
    }
    if (path === "/api/saved-systems/ownedRelease/inspect?space=requests") {
      return Promise.resolve(
        Response.json({ ...owned, assetAvailability: "verified" }),
      );
    }
    if (path === "/api/request-space-openings/open") {
      throw new TypeError("Lost opening acknowledgement");
    }
    throw new Error(`Unexpected route ${path}`);
  });
  await f.requests.loadReleases();
  deepStrictEqual(f.requests.releases.peek().map((view) => view.id), [
    "mainRelease",
    "ownedRelease",
  ]);
  await f.requests.selectRelease(owned.id);
  deepStrictEqual(f.requests.source.peek(), {
    kind: "release",
    releaseId: owned.id,
    digest: owned.digest,
  });
  equal(f.requests.releases.peek()[1].status, "incomplete");
  equal(f.requests.releases.peek()[1].origin.executionSpaceId, "space-caseA");
  f.requests.sessionReady.value = true;
  equal(await f.requests.open("Use owned exact source"), null);
  deepStrictEqual((calls.at(-1)!.body as { source: unknown }).source, {
    kind: "release",
    releaseId: owned.id,
    digest: owned.digest,
  });
  equal(
    calls.some((call) =>
      call.path === "/api/saved-systems/ownedRelease/inspect"
    ),
    false,
  );
  equal(f.requests.intent.peek()?.source.kind, "release");
});

Deno.test("the Release a new Request starts from is selected once by the next complete catalogue read, or refused when unlisted", async () => {
  const owned = localSkillRelease("ownedRelease", "caseA");
  let ownedListed = false;
  const f = fixture((path) => {
    if (path === "/api/saved-systems/list") {
      return Promise.resolve(Response.json([]));
    }
    if (path === "/api/saved-systems/list?space=requests") {
      return Promise.resolve(
        ownedListed
          ? Response.json([owned])
          : Response.json({ code: "FORBIDDEN" }, { status: 403 }),
      );
    }
    if (path === "/api/saved-systems/ownedRelease/inspect?space=requests") {
      return Promise.resolve(
        Response.json({ ...owned, assetAvailability: "verified" }),
      );
    }
    throw new Error(`Unexpected route ${path}`);
  });
  const release = {
    kind: "release",
    releaseId: owned.id,
    digest: owned.digest,
  };
  f.requests.startFrom(owned.id);
  // A partial catalogue cannot tell: the wish waits for a complete read.
  await f.requests.loadReleases();
  deepStrictEqual(f.requests.source.peek(), { kind: "current-main" });
  ownedListed = true;
  await f.requests.loadReleases();
  deepStrictEqual(f.requests.source.peek(), release);
  // Taken once: a later read keeps the person's own choice.
  f.requests.source.value = { kind: "current-main" };
  await f.requests.loadReleases();
  deepStrictEqual(f.requests.source.peek(), { kind: "current-main" });
  f.requests.startFrom("missing");
  await f.requests.loadReleases();
  equal(f.requests.error.peek(), "Select an exact listed Release.");
  deepStrictEqual(f.requests.source.peek(), { kind: "current-main" });
});

Deno.test("failed exact Request Release inspection never retries Main or changes a pinned selection", async () => {
  const owned = localSkillRelease("ownedRelease", "caseA");
  let mainInspect = 0;
  const f = fixture((path) => {
    if (path === "/api/saved-systems/list") {
      return Promise.resolve(Response.json([]));
    }
    if (path === "/api/saved-systems/list?space=requests") {
      return Promise.resolve(Response.json([owned]));
    }
    if (path.endsWith("/inspect")) mainInspect++;
    if (path.endsWith("/inspect?space=requests")) {
      return Promise.resolve(
        Response.json({
          ...owned,
          digest: "f".repeat(64),
          assetAvailability: "verified",
        }),
      );
    }
    throw new Error("Scoped Release unavailable");
  });
  await f.requests.loadReleases();
  f.requests.source.value = {
    kind: "release",
    releaseId: "previous",
    digest: "a".repeat(64),
  };
  await f.requests.selectRelease(owned.id);
  deepStrictEqual(f.requests.source.peek(), {
    kind: "release",
    releaseId: "previous",
    digest: "a".repeat(64),
  });
  equal(f.requests.error.peek().length > 0, true);
  equal(mainInspect, 0);
});

Deno.test("Request Release catalogue refuses ambiguous refs while preserving positive Main results on scoped denial", async () => {
  const main = localSkillRelease("mainRelease");
  const f = fixture((path) =>
    Promise.resolve(
      path.includes("?space=requests")
        ? Response.json({
          code: "FORBIDDEN",
          error: "Current owner unavailable",
        }, { status: 403 })
        : Response.json([main]),
    )
  );
  await f.requests.loadReleases();
  equal(f.requests.releases.peek()[0].id, main.id);
  const duplicate = fixture((path) =>
    Promise.resolve(
      Response.json([
        path.includes("?space=requests")
          ? localSkillRelease("duplicate", "caseA")
          : localSkillRelease("duplicate"),
      ]),
    )
  );
  await duplicate.requests.loadReleases();
  equal(duplicate.requests.releases.peek().length, 0);
});

Deno.test("late Release catalogue answers cannot replace the newer exact source choices", async () => {
  const gates = Array.from(
    { length: 4 },
    () => Promise.withResolvers<Response>(),
  );
  let calls = 0;
  const f = fixture(() => gates[calls++].promise);
  const old = f.requests.loadReleases();
  const current = f.requests.loadReleases();
  gates[2].resolve(Response.json([localSkillRelease("currentRelease")]));
  gates[3].resolve(Response.json([]));
  await current;
  gates[0].resolve(Response.json([localSkillRelease("oldRelease")]));
  gates[1].resolve(Response.json([]));
  await old;
  deepStrictEqual(f.requests.releases.peek().map((view) => view.id), [
    "currentRelease",
  ]);
});

Deno.test("automatic Release reads preserve the exact selection and reject obsolete session or host replies", async () => {
  for (const changed of ["session", "host"]) {
    const gates = Array.from(
      { length: 2 },
      () => Promise.withResolvers<Response>(),
    );
    let calls = 0, selectedHost = host;
    const requests = createRequests({
      fetch: () => gates[calls++].promise,
      host: () => selectedHost,
      origin: () => origin,
      storage: () => memory().storage,
    });
    const selected = localSkillRelease("selectedRelease");
    requests.releases.value = [selected];
    const intention = {
      kind: "release" as const,
      releaseId: selected.id,
      digest: selected.digest!,
    };
    requests.source.value = intention;
    const reading = requests.loadReleases();
    if (changed === "session") requests.sessionGeneration.value++;
    else selectedHost = { ...host, systemId: "another-host" };
    gates[0].resolve(Response.json([localSkillRelease("obsoleteRelease")]));
    gates[1].resolve(Response.json([]));
    await reading;
    deepStrictEqual(requests.releases.peek(), [selected]);
    deepStrictEqual(requests.source.peek(), intention);
  }
  const selected = localSkillRelease("selectedRelease");
  const f = fixture((path) =>
    Promise.resolve(Response.json(
      path.includes("?space=requests") ? [] : [selected],
    ))
  );
  const intention = {
    kind: "release" as const,
    releaseId: selected.id,
    digest: selected.digest!,
  };
  f.requests.source.value = intention;
  await f.requests.loadReleases();
  equal(f.requests.releases.peek()[0].id, selected.id);
  deepStrictEqual(f.requests.source.peek(), intention);
});

const retainedScope = (caseId: string, executionVersion = version) => ({
  caseId,
  branchId: `branch-${caseId}`,
  executionSpaceId: `space-${caseId}`,
  branchVersion: executionVersion,
  executionVersion,
  version: executionVersion,
  release: null,
  readOnly: true as const,
});
Deno.test("confirmed target scope refresh fences an older R0 reply and preserves sibling scope and conversation", async () => {
  const gates = [
    Promise.withResolvers<Response>(),
    Promise.withResolvers<Response>(),
  ];
  let calls = 0;
  const f = fixture((path) => {
    equal(path, "/api/case-model/caseA");
    return gates[calls++].promise;
  });
  const sibling = retainedScope("caseB"), r1 = `commit:${"f".repeat(40)}`;
  f.requests.scopes.value = new Map([["caseA", retainedScope("caseA")], [
    "caseB",
    sibling,
  ]]);
  const conversation = parseConversationsSnapshot(read("caseA"));
  f.requests.snapshots.value = new Map([["caseA", conversation]]);
  f.requests.sessionReady.value = true;
  const old = f.requests.loadScope("caseA");
  const fresh = f.requests.refreshScope("caseA");
  equal(
    f.requests.scopes.peek().has("caseA"),
    false,
    "target invalidation is synchronous",
  );
  equal(f.requests.scopes.peek().get("caseB"), sibling);
  gates[1].resolve(Response.json(retainedScope("caseA", r1)));
  await fresh;
  gates[0].resolve(Response.json(retainedScope("caseA")));
  await old;
  equal(f.requests.scopes.peek().get("caseA")?.executionVersion, r1);
  equal(f.requests.scopes.peek().get("caseB"), sibling);
  equal(f.requests.snapshots.peek().get("caseA"), conversation);
});
Deno.test("older scope failure cannot delete a newer R1 scope or disconnect a new session", async () => {
  const gates = [
    Promise.withResolvers<Response>(),
    Promise.withResolvers<Response>(),
  ];
  let calls = 0;
  const f = fixture(() => gates[calls++].promise);
  f.requests.sessionReady.value = true;
  const old = f.requests.loadScope("caseA");
  f.requests.sessionGeneration.value++;
  const r1 = `commit:${"f".repeat(40)}`,
    fresh = f.requests.refreshScope("caseA");
  gates[1].resolve(Response.json(retainedScope("caseA", r1)));
  await fresh;
  gates[0].resolve(new Response(null, { status: 403 }));
  await old;
  equal(f.requests.scopes.peek().get("caseA")?.executionVersion, r1);
  equal(f.requests.sessionReady.peek(), true);
});
Deno.test("scope replies from an expired session or intervening host context remain fenced even after returning to that host", async () => {
  for (const changed of ["session", "context"]) {
    const gates = Array.from(
      { length: 3 },
      () => Promise.withResolvers<Response>(),
    );
    let calls = 0, selectedHost = host;
    const requests = createRequests({
      fetch: () => gates[calls++].promise,
      host: () => selectedHost,
      origin: () => origin,
      storage: () => memory().storage,
    });
    requests.sessionReady.value = true;
    const old = requests.loadScope("caseA");
    if (changed === "session") {
      requests.sessionGeneration.value++;
      gates[0].resolve(Response.json(retainedScope("caseA")));
      await old;
      equal(requests.scopes.peek().has("caseA"), false);
    } else {
      selectedHost = { ...host, systemId: "another-host" };
      const intermediate = requests.loadScope("caseB");
      selectedHost = host;
      const current = requests.loadScope("caseC");
      gates[2].resolve(Response.json(retainedScope("caseC")));
      await current;
      gates[1].resolve(Response.json(retainedScope("caseB")));
      await intermediate;
      gates[0].resolve(Response.json(retainedScope("caseA")));
      await old;
      deepStrictEqual([...requests.scopes.peek().keys()], ["caseC"]);
    }
  }
});

Deno.test("cached Request conversations and read errors expire with their session", async () => {
  const requests = createRequests({
    host: () => host,
    fetch: () => Promise.resolve(Response.json(read("caseA"))),
  });
  await requests.refresh("caseA");
  requests.readErrors.value = new Map([["caseB", "unavailable"]]);
  requests.context.value = { ...host };
  equal(requests.snapshots.peek().size, 1, "same host keeps the cache");
  requests.sessionGeneration.value++;
  equal(requests.snapshots.peek().size, 0);
  equal(requests.readErrors.peek().size, 0);
  requests.dispose();
});

Deno.test("frequent invalidations show intermediate progress while callers await the final Request response", async () => {
  const replies: Array<(response: Response) => void> = [];
  const requests = createRequests({
    host: () => host,
    fetch: () => new Promise<Response>((done) => replies.push(done)),
  });
  requests.sessionReady.value = true;
  let completed = false;
  const opening = requests.refresh("caseA").then(() => completed = true);
  const notice = requests.refresh("caseA", true);
  for (const revision of [1, 2]) {
    requests.refresh("caseA", true);
    replies[revision - 1](Response.json(read("caseA", revision)));
    while (replies.length < revision + 1) await Promise.resolve();
    equal(
      requests.snapshots.peek().get("caseA")?.conversations[0].revision,
      revision,
    );
    equal(completed, false);
  }
  replies[2](Response.json(read("caseA", 3)));
  await Promise.all([opening, notice]);
  equal(replies.length, 3);
  equal(completed, true);
  equal(requests.snapshots.peek().get("caseA")?.conversations[0].revision, 3);
  requests.dispose();
});

Deno.test("a conversation reply from an older session never lands; the Request is read again in the new one", async () => {
  const replies: Array<(response: Response) => void> = [];
  const requests = createRequests({
    host: () => host,
    fetch: () => new Promise<Response>((done) => replies.push(done)),
  });
  requests.sessionReady.value = true;
  const refresh = requests.refresh("caseA");
  let concurrentFinished = false;
  const concurrent = requests.refresh("caseA").then(() => {
    concurrentFinished = true;
  });
  requests.sessionGeneration.value++;
  replies[0](Response.json(read("caseA", 1)));
  while (replies.length < 2) await Promise.resolve();
  equal(requests.snapshots.value.has("caseA"), false);
  await Promise.resolve();
  equal(concurrentFinished, false);
  replies[1](Response.json(read("caseA", 2)));
  await Promise.all([refresh, concurrent]);
  equal(concurrentFinished, true);
  equal(requests.snapshots.value.get("caseA")?.conversations[0].revision, 2);
  // A session that is no longer ready is not read again.
  const stopped = requests.refresh("caseB");
  requests.sessionReady.value = false;
  replies[2](Response.json(read("caseB")));
  await stopped;
  equal(replies.length, 3);
  equal(requests.snapshots.value.has("caseB"), false);
});

Deno.test("Request closure sends explicit accepted and rejected judgments only to the scoped endpoint", async () => {
  for (const verdict of ["accepted", "rejected"] as const) {
    let closed = false;
    const commands: unknown[] = [];
    const f = fixture((path, init) =>
      fixtureResponse(() => {
        if (init?.method === "POST") {
          equal(path, "/api/cases/caseA/close?space=requests");
          equal(init.credentials, "same-origin");
          commands.push(JSON.parse(String(init.body)));
          closed = true;
          return Response.json({ closed: true });
        }
        equal(path, "/api/cases?space=requests");
        return Response.json({
          systemId: host.systemId,
          cases: [{
            ...record("caseA"),
            ...(closed
              ? {
                status: "closed-done",
                closedAt: "2026-11-03T00:00:00Z",
                closedBy: "host-owner",
                verdict,
              }
              : {}),
          }],
        });
      })
    );
    await f.requests.cases.refresh();
    equal(await f.requests.cases.close("caseA", "done", verdict), true);
    deepStrictEqual(commands, [{ outcome: "done", verdict }]);
    equal(f.requests.cases.byId("caseA")?.verdict, verdict);
    equal(f.requests.cases.byId("caseA")?.closedBy, "host-owner");
    f.requests.dispose();
  }
});

Deno.test("held Request readers share ownership; released historical caches stay passive on reconcile", async () => {
  const reads: string[] = [];
  const f = fixture((path) => {
    reads.push(path);
    return Promise.resolve(Response.json(
      path === "/api/cases?space=requests"
        ? { systemId: host.systemId, cases: [] }
        : read(new URL(path, origin).searchParams.get("caseId")!),
    ));
  });
  f.requests.sessionReady.value = true;
  await f.requests.refresh("historical");
  const badge = f.requests.retain("caseA");
  const selection = f.requests.retain("caseA");
  await f.requests.refresh("caseA");
  deepStrictEqual(reads, [
    "/api/conversations?caseId=historical",
    "/api/conversations?caseId=caseA",
  ]);
  badge();
  badge();
  reads.length = 0;
  await f.requests.reconcile();
  deepStrictEqual(reads.sort(), [
    "/api/cases?space=requests",
    "/api/conversations?caseId=caseA",
  ]);
  selection();
  reads.length = 0;
  await f.requests.invalidateConversation("caseA");
  await f.requests.invalidateConversation("unknown");
  await f.requests.reconcile();
  deepStrictEqual(reads, Array(3).fill("/api/cases?space=requests"));
  equal(f.requests.snapshots.peek().size, 2);
  f.requests.dispose();
  reads.length = 0;
  f.requests.retain("caseA")();
  await f.requests.invalidateConversation("caseA");
  await f.requests.reconcile();
  deepStrictEqual(reads, []);
});

Deno.test("last reader release aborts its in-flight read and fences its late failure from a new reader", async () => {
  const replies = [
    Promise.withResolvers<Response>(),
    Promise.withResolvers<Response>(),
  ];
  const signals: AbortSignal[] = [];
  const f = fixture((path, init) => {
    if (path === "/api/cases?space=requests") {
      return Promise.resolve(
        Response.json({ systemId: host.systemId, cases: [] }),
      );
    }
    signals.push(init!.signal!);
    return replies[signals.length - 1].promise;
  });
  f.requests.sessionReady.value = true;
  const release = f.requests.retain("caseA");
  const old = f.requests.invalidateConversation("caseA");
  release();
  equal(signals[0].aborted, true);
  const releaseCurrent = f.requests.retain("caseA");
  const current = f.requests.refresh("caseA");
  replies[1].resolve(Response.json(read("caseA", 2)));
  await current;
  replies[0].resolve(Response.json({
    code: "FORBIDDEN",
    context: { session: "invalid" },
  }, { status: 403 }));
  await old;
  equal(
    signals.length,
    2,
    "released invalidation cannot schedule another read",
  );
  equal(f.requests.snapshots.peek().get("caseA")?.conversations[0].revision, 2);
  equal(f.requests.sessionReady.peek(), true);
  releaseCurrent();
  f.requests.dispose();
});

Deno.test("scoped collection replies cannot restore an obsolete session or replace its current data", async () => {
  for (const nextReady of [false, true]) {
    const replies = [
      Promise.withResolvers<Response>(),
      Promise.withResolvers<Response>(),
    ];
    let calls = 0;
    const f = fixture(() => replies[calls++].promise);
    f.requests.sessionReady.value = true;
    f.requests.cases.accept({
      systemId: host.systemId,
      cases: [record("retained")],
    });
    const old = f.requests.cases.refresh();
    f.requests.sessionGeneration.value++;
    f.requests.sessionReady.value = nextReady;
    replies[0].resolve(
      Response.json({ systemId: host.systemId, cases: [record("obsolete")] }),
    );
    if (nextReady) {
      while (calls < 2) await Promise.resolve();
      deepStrictEqual(
        f.requests.cases.snapshot.peek()?.cases.map((entry) => entry.id),
        ["retained"],
      );
      replies[1].resolve(
        Response.json({ systemId: host.systemId, cases: [record("current")] }),
      );
    }
    await old;
    equal(f.requests.sessionReady.peek(), nextReady);
    equal(calls, nextReady ? 2 : 1);
    deepStrictEqual(
      f.requests.cases.snapshot.peek()?.cases.map((entry) => entry.id),
      [nextReady ? "current" : "retained"],
    );
    equal(f.requests.cases.error.peek().length > 0, !nextReady);
    f.requests.dispose();
  }
});

Deno.test("known Request events coalesce targeted Case reads and preserve closure in the Dock", async () => {
  const replies = [
    Promise.withResolvers<Response>(),
    Promise.withResolvers<Response>(),
  ];
  const paths: string[] = [];
  let calls = 0;
  const f = fixture((path) => {
    paths.push(path);
    return path === "/api/cases?space=requests"
      ? Promise.resolve(Response.json({ systemId: host.systemId, cases: [] }))
      : replies[calls++].promise;
  });
  f.requests.sessionReady.value = true;
  f.requests.cases.accept({
    systemId: host.systemId,
    cases: [record("caseA"), record("caseB", 2)],
  });
  const first = f.requests.invalidateConversation("caseA");
  const again = f.requests.invalidateConversation("caseA");
  deepStrictEqual(paths, ["/api/cases/caseA?space=requests"]);
  replies[0].resolve(
    Response.json({ systemId: host.systemId, case: record("caseA") }),
  );
  while (calls < 2) await Promise.resolve();
  replies[1].resolve(Response.json({
    systemId: host.systemId,
    case: {
      ...record("caseA"),
      status: "closed-done",
      closedAt: new Date().toISOString(),
    },
  }));
  await Promise.all([first, again]);
  deepStrictEqual(paths, Array(2).fill("/api/cases/caseA?space=requests"));
  deepStrictEqual(f.requests.cases.open.peek().map((entry) => entry.id), [
    "caseB",
  ]);
  deepStrictEqual(
    f.requests.cases.recentlyClosed.peek().map((entry) => entry.id),
    ["caseA"],
  );
  await f.requests.invalidateConversation("unknown");
  equal(paths.at(-1), "/api/cases?space=requests");
  equal(paths.length, 3);
  f.requests.dispose();
});

Deno.test("disposing Requests aborts collection reads and ignores a fetcher that returns after abort", async () => {
  const reply = Promise.withResolvers<Response>();
  let signal: AbortSignal | undefined;
  const f = fixture((_path, init) => {
    signal = init?.signal ?? undefined;
    return reply.promise;
  });
  const pending = f.requests.cases.refresh();
  f.requests.dispose();
  equal(signal?.aborted, true);
  reply.resolve(
    Response.json({ systemId: host.systemId, cases: [record("obsolete")] }),
  );
  await pending;
  equal(f.requests.sessionReady.peek(), false);
  equal(f.requests.cases.snapshot.peek(), null);
});
