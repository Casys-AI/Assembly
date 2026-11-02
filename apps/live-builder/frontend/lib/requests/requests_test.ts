import { parseConversationsSnapshot } from "../conversations/state.ts";
import { localSkillRelease } from "../../test/support/release-opening-fixture.ts";
import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
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
        return Response.json({ error: "Session expired" }, { status: 403 });
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

Deno.test("late conversation refresh cannot populate a different session", async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  const requests = createRequests({ host: () => host, fetch: () => pending });
  requests.sessionReady.value = true;
  const refresh = requests.refresh("caseA");
  requests.sessionGeneration.value++;
  resolve(
    Response.json({
      systemId: host.systemId,
      version: "v",
      defaultAgentId: "same-native",
      conversations: [conversation("caseA")],
    }),
  );
  await refresh;
  equal(requests.snapshots.value.has("caseA"), false);
});
