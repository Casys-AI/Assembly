import { localSkillRelease } from "../../test/support/release-opening-fixture.ts";
import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  createCombinedSavedSystemsApi,
  createSavedSystemsApi,
  createSavedSystemsController,
  releaseOpeningKind,
  type SavedSystemsApi,
  SavedSystemsReadError,
  type SavedSystemView,
} from "./saved-systems.ts";
const tag = { mode: "create" as const, name: "v1" };
const source = {
  branch: { kind: "main" as const },
  sourceVersion: `commit:${"a".repeat(40)}`,
};
export const saved: SavedSystemView = {
  assetAvailability: "unchecked",
  id: "saved-1",
  saveKey: "key",
  metadata: { name: "Exact S", purpose: "Repeatable inspection" },
  createdAt: "2026-10-29T00:00:00Z",
  status: "retained",
  manifest: null,
  digest: "digest",
  issues: [],
  revision: 1,
  origin: { projectId: "p", systemId: "s", executionSpaceId: "main" },
  prerequisites: [],
  selectedOperators: [],
};
Deno.test("saved systems client connects save, list and exact inspect without authority DTOs", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const api = createSavedSystemsApi({
    fetch: ((path, init) => {
      calls.push({ path: String(path), body: JSON.parse(String(init?.body)) });
      return Promise.resolve(
        Response.json(String(path).endsWith("/list") ? [saved] : saved),
      );
    }) as typeof fetch,
  });
  equal(
    (await api.save({
      saveKey: "key",
      name: "Exact S",
      purpose: "Repeatable inspection",
      source,
    })).id,
    saved.id,
  );
  equal((await api.list())[0].id, saved.id);
  equal((await api.inspect(saved.id)).digest, saved.digest);
  deepStrictEqual(calls.map((entry) => entry.path), [
    "/api/saved-systems/save",
    "/api/saved-systems/list",
    "/api/saved-systems/saved-1/inspect",
  ]);
  deepStrictEqual(calls[1].body, {});
  equal(JSON.stringify(calls).includes("actorId"), false);
  const denied = createSavedSystemsApi({
    fetch: (() =>
      Promise.resolve(
        Response.json({ code: "FORBIDDEN", error: "Withdrawn" }, {
          status: 403,
        }),
      )) as typeof fetch,
  });
  await rejects(
    () => denied.list(),
    (error: unknown) =>
      error instanceof SavedSystemsReadError && error.code === "FORBIDDEN",
  );
});
Deno.test("save action preserves retry key, displays incomplete/refused results and opens selected version", async () => {
  const commands: { saveKey: string; name: string; purpose: string }[] = [];
  let fail = true;
  let refused = false;
  let nextKey = 0;
  // The host's record: the last one it acknowledged.
  let acknowledged = saved;
  const api = {
    tags: () => Promise.resolve([]),
    list: () => Promise.resolve([saved]),
    save(input: Parameters<SavedSystemsApi["save"]>[0]) {
      commands.push(input);
      if (fail) {
        fail = false;
        throw new Error("Interrupted");
      }
      acknowledged = {
        ...saved,
        saveKey: input.saveKey,
        metadata: { name: input.name, purpose: input.purpose },
        ...(input.tag
          ? {
            tag: {
              selection: input.tag,
              binding: {
                name: input.tag.name,
                refOid: input.source.sourceVersion.slice(7),
                commitOid: input.source.sourceVersion.slice(7),
              },
              verified: true,
            },
            tagAvailability: "verified" as const,
          }
          : {}),
        source: {
          ...input.source,
          repositoryId: "p",
          branchRef: "refs/heads/main",
          admittedHeadVersion: input.source.sourceVersion,
          sourceDigest: "a".repeat(64),
        },
        status: "incomplete" as const,
      };
      return Promise.resolve(acknowledged);
    },
    inspect() {
      if (refused) {
        throw new SavedSystemsReadError("FORBIDDEN", "Source withdrawn");
      }
      return Promise.resolve(acknowledged);
    },
  };
  const stored = new Map<string, string>();
  const controller = createSavedSystemsController(
    api,
    () => {},
    () => `key-${++nextKey}`,
    {
      host: () => Promise.resolve({ projectId: "p", systemId: "s" }),
      origin: () => "http://localhost:4311",
      storage: () => ({
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => {
          stored.set(key, value);
        },
        removeItem: (key) => {
          stored.delete(key);
        },
      }),
    },
  );
  await controller.open();
  equal(controller.state.records.length, 1);
  await controller.save("Exact S", "Purpose", source, tag);
  equal(controller.state.error, "Interrupted");
  await controller.save("Exact S", "Purpose", source, tag);
  equal(controller.state.selected!.status, "incomplete");
  equal(commands[0].saveKey, commands[1].saveKey);
  // The acknowledged Release is read at once; a refused read keeps it shown.
  refused = true;
  await controller.save("Changed", "Purpose", source, tag);
  equal(commands[2].saveKey, "key-2");
  equal(controller.state.selected!.metadata.name, "Changed");
  equal(controller.state.refused, true);
  refused = false;
  const otherSource = { ...source, sourceVersion: `commit:${"b".repeat(40)}` };
  await controller.save("Changed", "Purpose", otherSource, tag);
  equal(commands[3].saveKey, "key-3");
  deepStrictEqual(
    (commands[0] as unknown as { source: unknown }).source,
    source,
  );
  await controller.inspect(saved.id);
  equal(controller.state.selected!.digest, "digest");
  refused = true;
  await controller.inspect(saved.id);
  equal(controller.state.selected, null);
  equal(controller.state.refused, true);
  controller.dispose();
});

Deno.test("Release client preserves exact Case creation and uses only the agreed owned catalogue selectors", async () => {
  const view = localSkillRelease("releaseA", "caseA");
  const calls: Array<
    {
      path: string;
      body: unknown;
      credentials?: RequestCredentials;
      cache?: RequestCache;
    }
  > = [];
  const api = createSavedSystemsApi({
    catalogue: { kind: "case", caseId: "caseA" },
    fetch: ((path, init) => {
      calls.push({
        path: String(path),
        body: JSON.parse(String(init?.body)),
        credentials: init?.credentials,
        cache: init?.cache,
      });
      return Promise.resolve(
        Response.json(String(path).includes("/list?") ? [view] : view),
      );
    }) as typeof fetch,
  });
  await api.list();
  await api.inspect(view.id);
  const command = {
    saveKey: "same-key",
    name: "Case source",
    purpose: "Keep exact source",
    source: {
      branch: { kind: "case" as const, caseId: "caseA" },
      sourceVersion: view.source!.sourceVersion,
    },
  };
  await api.save(command);
  deepStrictEqual(calls.map((call) => call.path), [
    "/api/saved-systems/list?caseId=caseA",
    "/api/saved-systems/releaseA/inspect?space=requests",
    "/api/saved-systems/save",
  ]);
  deepStrictEqual(calls[2].body, command);
  equal(
    calls.every((call) =>
      call.credentials === "same-origin" && call.cache === "no-store"
    ),
    true,
  );
  let path = "";
  await createSavedSystemsApi({
    catalogue: { kind: "owned-requests" },
    fetch: ((input) => {
      path = String(input);
      return Promise.resolve(Response.json([view]));
    }) as typeof fetch,
  }).list();
  equal(path, "/api/saved-systems/list?space=requests");
});

Deno.test("opening candidates retain incomplete status and require exact selected inspection without a general incomplete waiver", () => {
  const candidate = localSkillRelease();
  equal(releaseOpeningKind(candidate), "local-validation");
  equal(releaseOpeningKind(candidate, true), null);
  equal(
    releaseOpeningKind({ ...candidate, assetAvailability: "verified" }, true),
    "local-validation",
  );
  equal(candidate.status, "incomplete");
  for (
    const refused of [
      {
        ...candidate,
        issues: ["PREREQUISITES_REQUIRED", "EXACT_ASSET_UNAVAILABLE"],
      },
      { ...candidate, issues: ["EXACT_ASSET_UNAVAILABLE"] },
      { ...candidate, manifest: { ...candidate.manifest!, prerequisites: [] } },
      { ...candidate, assetAvailability: "unavailable" as const },
      { ...candidate, status: "pending" as const },
      { ...candidate, digest: null },
    ]
  ) equal(releaseOpeningKind(refused), null);
});

Deno.test("tag inventory is scoped to the exact source and rejects mismatched commits", async () => {
  const calls: unknown[] = [];
  const binding = {
    name: "v1",
    refOid: "b".repeat(40),
    commitOid: "a".repeat(40),
  };
  const api = createSavedSystemsApi({
    fetch: ((_path, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Promise.resolve(Response.json({ tags: [binding] }));
    }) as typeof fetch,
  });
  deepStrictEqual(await api.tags(source), [binding]);
  deepStrictEqual(calls, [{ source }]);
  const invalid = createSavedSystemsApi({
    fetch: (() =>
      Promise.resolve(
        Response.json({ tags: [{ ...binding, commitOid: "c".repeat(40) }] }),
      )) as typeof fetch,
  });
  await rejects(() => invalid.tags(source));
});

Deno.test("opening readiness is selected-only, closed and consistent with host evidence", async () => {
  const base = {
    ...localSkillRelease(),
    assetAvailability: "verified" as const,
  };
  const ready = {
    ...base,
    openingAvailability: "ready" as const,
    openingIssues: [],
  };
  let response: unknown = ready;
  const api = createSavedSystemsApi({
    fetch: (() => Promise.resolve(Response.json(response))) as typeof fetch,
  });
  equal((await api.inspect(base.id)).openingAvailability, "ready");
  for (const records of [[ready, base], [base, ready], [ready, ready]]) {
    response = records;
    await rejects(() => api.list(), SavedSystemsReadError);
  }
  for (
    const bad of [
      { ...ready, openingIssues: ["INITIAL_SKILL_BUNDLE_UNAVAILABLE"] },
      { ...ready, openingIssues: undefined },
      { ...ready, assetAvailability: "unavailable" },
      { ...ready, status: "conflict" },
      {
        ...ready,
        openingAvailability: "unchecked",
        openingIssues: ["SOURCE_OPENING_UNAVAILABLE"],
      },
      { ...ready, openingAvailability: "unavailable", openingIssues: [] },
      {
        ...ready,
        openingAvailability: "unavailable",
        openingIssues: ["/private/path"],
      },
    ]
  ) {
    response = bad;
    await rejects(() => api.inspect(base.id), SavedSystemsReadError);
  }
  response = {
    ...base,
    openingAvailability: "unavailable",
    openingIssues: ["INITIAL_SKILL_BUNDLE_UNAVAILABLE"],
  };
  equal((await api.inspect(base.id)).openingAvailability, "unavailable");
  response = base;
  equal((await api.inspect(base.id)).openingAvailability, undefined);
});

Deno.test("failed selected inspection or catalogue read clears previously ready evidence", async () => {
  const base = {
    ...localSkillRelease(),
    assetAvailability: "verified" as const,
    openingAvailability: "ready" as const,
    openingIssues: [],
  };
  let failure = false, listFailure = false;
  let hostSystem = base.origin.systemId;
  const api: SavedSystemsApi = {
    tags: () => Promise.resolve([]),
    list: () =>
      listFailure
        ? Promise.reject(new Error("offline"))
        : Promise.resolve([base]),
    save: () => Promise.reject(new Error("unused")),
    inspect: () =>
      failure ? Promise.reject(new Error("withdrawn")) : Promise.resolve(base),
  };
  const storage = new Map<string, string>();
  const c = createSavedSystemsController(api, () => {}, () => "new-key", {
    host: () =>
      Promise.resolve({
        projectId: base.origin.projectId,
        systemId: hostSystem,
      }),
    origin: () => "http://localhost",
    storage: () => ({
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => {
        storage.set(k, v);
      },
      removeItem: (k) => {
        storage.delete(k);
      },
    }),
  });
  const selected = () => c.state.selected;
  await c.inspect(base.id);
  equal(selected()?.openingAvailability, "ready");
  failure = true;
  await c.inspect(base.id);
  equal(selected(), null);
  failure = false;
  await c.inspect(base.id);
  equal(selected()?.openingAvailability, "ready");
  listFailure = true;
  await c.open();
  equal(selected(), null);
  listFailure = false;
  await c.inspect(base.id);
  equal(selected()?.openingAvailability, "ready");
  hostSystem = "different-host";
  await c.inspect(base.id);
  equal(selected(), null);
  hostSystem = base.origin.systemId;
  await c.inspect(base.id);
  equal(selected()?.openingAvailability, "ready");
  hostSystem = "different-host";
  await c.open();
  equal(selected(), null);
  c.dispose();
});

Deno.test("Main catalogue combines authorized origins, routes inspection and reports partial reads", async () => {
  const main = localSkillRelease("main-release");
  const request = localSkillRelease("request-release", "caseA");
  const calls: string[] = [];
  let denyRequests = false;
  const api = createCombinedSavedSystemsApi({
    fetch: ((input: RequestInfo | URL) => {
      const path = String(input);
      calls.push(path);
      if (path === "/api/saved-systems/list") {
        return Promise.resolve(Response.json([main]));
      }
      if (path === "/api/saved-systems/list?space=requests") {
        return Promise.resolve(
          denyRequests
            ? Response.json({ code: "FORBIDDEN", error: "denied" }, {
              status: 403,
            })
            : Response.json([request]),
        );
      }
      return Promise.resolve(
        Response.json(path.includes("request-release") ? request : main),
      );
    }) as typeof fetch,
  });
  const all = await api.listWithNotice!();
  deepStrictEqual(all.records.map((record) => record.id), [
    main.id,
    request.id,
  ]);
  equal(all.notice, "");
  await api.inspect(main.id);
  await api.inspect(request.id);
  deepStrictEqual(calls.slice(-2), [
    "/api/saved-systems/main-release/inspect",
    "/api/saved-systems/request-release/inspect?space=requests",
  ]);
  denyRequests = true;
  const partial = await api.listWithNotice!();
  deepStrictEqual(partial.records.map((record) => record.id), [main.id]);
  equal(
    partial.notice,
    "Partial catalogue: owned Request Releases could not be read.",
  );
  await rejects(() => api.inspect(request.id));
});

Deno.test("a late older combined catalogue cannot restore stale inspection origins", async () => {
  const main = localSkillRelease("main-release");
  const request = localSkillRelease("request-release", "caseA");
  const first = Promise.withResolvers<Response>();
  let reads = 0;
  const calls: string[] = [];
  const api = createCombinedSavedSystemsApi({
    fetch: ((input: RequestInfo | URL) => {
      const path = String(input);
      calls.push(path);
      if (path === "/api/saved-systems/list") {
        return Promise.resolve(Response.json([main]));
      }
      if (path === "/api/saved-systems/list?space=requests") {
        return ++reads === 1
          ? first.promise
          : Promise.resolve(Response.json([]));
      }
      return Promise.resolve(Response.json(main));
    }) as typeof fetch,
  });
  const older = api.listWithNotice!();
  await api.listWithNotice!();
  first.resolve(Response.json([request]));
  await older;
  await rejects(() => api.inspect(request.id));
  await api.inspect(main.id);
  equal(calls.at(-1), "/api/saved-systems/main-release/inspect");
});

Deno.test("controller presents available Main records alongside partial catalogue notice", async () => {
  const main = localSkillRelease("main-release");
  const api: SavedSystemsApi = {
    tags: () => Promise.resolve([]),
    list: () => Promise.resolve([]),
    listWithNotice: () =>
      Promise.resolve({
        records: [main],
        notice: "Partial catalogue: owned Request Releases could not be read.",
      }),
    save: () => Promise.reject(new Error("unused")),
    inspect: () => Promise.reject(new Error("unused")),
  };
  const controller = createSavedSystemsController(api, () => {}, () => "key", {
    host: () =>
      Promise.resolve({
        projectId: main.origin.projectId,
        systemId: main.origin.systemId,
      }),
    origin: () => "http://localhost",
    storage: () => ({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    }),
  });
  await controller.open();
  deepStrictEqual(controller.state.records.map((record) => record.id), [
    main.id,
  ]);
  equal(
    controller.state.catalogueNotice,
    "Partial catalogue: owned Request Releases could not be read.",
  );
  controller.dispose();
});

function readRecovery() {
  return {
    host: () => Promise.resolve({ projectId: "p", systemId: "s" }),
    origin: () => "http://localhost",
    storage: () => ({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    }),
  };
}
async function tickUntil(done: () => boolean) {
  for (let n = 0; n < 100 && !done(); n++) await Promise.resolve();
  equal(done(), true);
}
Deno.test("Release invalidation bursts coalesce one follow-up and never issue commands", async () => {
  const reads = [
    Promise.withResolvers<SavedSystemView[]>(),
    Promise.withResolvers<SavedSystemView[]>(),
  ];
  let calls = 0;
  let commands = 0;
  const controller = createSavedSystemsController(
    {
      list: () => reads[calls++].promise,
      tags: () => Promise.resolve([]),
      inspect: () => {
        commands++;
        throw new Error("unused");
      },
      save: () => {
        commands++;
        throw new Error("unused");
      },
    },
    () => {},
    () => "unused",
    readRecovery(),
  );
  const opened = controller.open();
  await tickUntil(() => calls === 1);
  const pending = controller.invalidate();
  void controller.invalidate();
  void controller.invalidate();
  reads[0].resolve([saved]);
  await tickUntil(() => calls === 2);
  const newer = { ...saved, revision: 2 };
  reads[1].resolve([newer]);
  await Promise.all([opened, pending]);
  equal(calls, 2);
  equal(controller.state.records[0].revision, 2);
  equal(commands, 0);
  controller.dispose();
});

Deno.test("an inspection asked during chained catalogue reads goes before the next read, and a second command is refused aloud", async () => {
  const reads = [
    Promise.withResolvers<SavedSystemView[]>(),
    Promise.withResolvers<SavedSystemView[]>(),
  ];
  let calls = 0;
  const order: string[] = [];
  const controller = createSavedSystemsController(
    {
      list: () => {
        order.push("list");
        return reads[calls++].promise;
      },
      tags: () => Promise.resolve([]),
      inspect: (id) => {
        order.push(`inspect ${id}`);
        return Promise.resolve(saved);
      },
      save: () => Promise.reject(new Error("unused")),
    },
    () => {},
    () => "unused",
    readRecovery(),
  );
  void controller.open();
  await tickUntil(() => calls === 1);
  // The live stream asks again while the first read is in flight.
  void controller.invalidate();
  const inspecting = controller.inspect(saved.id);
  await controller.inspect("other");
  equal(controller.state.error, "Another Release action is still running.");
  reads[0].resolve([saved]);
  await inspecting;
  await tickUntil(() => calls === 2);
  deepStrictEqual(order, ["list", `inspect ${saved.id}`, "list"]);
  equal(controller.state.selected?.id, saved.id);
  reads[1].resolve([saved]);
  controller.dispose();
});

Deno.test("disposed Release reads abort and cannot repopulate the old scope or notify", async () => {
  const late = Promise.withResolvers<SavedSystemView[]>();
  let signal: AbortSignal | undefined;
  let changes = 0;
  const controller = createSavedSystemsController(
    {
      list: (selected) => {
        signal = selected;
        return late.promise;
      },
      tags: () => Promise.resolve([]),
      inspect: () => Promise.reject(new Error("unused")),
      save: () => Promise.reject(new Error("unused")),
    },
    () => {
      changes++;
    },
    () => "unused",
    readRecovery(),
  );
  const opened = controller.open();
  await tickUntil(() => signal !== undefined);
  void controller.invalidate();
  controller.dispose();
  equal(signal!.aborted, true);
  const before = changes;
  late.resolve([saved]);
  await opened;
  deepStrictEqual(controller.state.records, []);
  equal(changes, before);
  await controller.invalidate();
  equal(changes, before);
});

Deno.test("each Release invalidation re-reads its own scope and refusal removes protected rows", async () => {
  const paths: string[] = [];
  let denied = false;
  const api = (caseId: string) =>
    createSavedSystemsApi({
      catalogue: { kind: "case", caseId },
      fetch: ((path) => {
        paths.push(String(path));
        return Promise.resolve(
          denied
            ? Response.json({ code: "FORBIDDEN", error: "Revoked" }, {
              status: 403,
            })
            : Response.json([{ ...saved, id: caseId }]),
        );
      }) as typeof fetch,
    });
  const a = createSavedSystemsController(
    api("caseA"),
    () => {},
    () => "unused",
    readRecovery(),
  );
  const b = createSavedSystemsController(
    api("caseB"),
    () => {},
    () => "unused",
    readRecovery(),
  );
  await Promise.all([a.open(), b.open()]);
  await Promise.all([a.invalidate(), b.invalidate()]);
  deepStrictEqual(a.state.records.map((r) => r.id), ["caseA"]);
  deepStrictEqual(b.state.records.map((r) => r.id), ["caseB"]);
  equal(
    paths.filter((path) => path === "/api/saved-systems/list?caseId=caseA")
      .length,
    2,
  );
  equal(
    paths.filter((path) => path === "/api/saved-systems/list?caseId=caseB")
      .length,
    2,
  );
  denied = true;
  await a.invalidate();
  deepStrictEqual(a.state.records, []);
  equal(a.state.readRefused, true);
  equal(a.state.readError, "Revoked");
  a.dispose();
  b.dispose();
});
