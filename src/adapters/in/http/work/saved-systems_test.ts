import {
  SavedSystemError,
  type SavedSystemView,
} from "../../../../domain/work/saved-systems.ts";
import { deepStrictEqual, equal } from "node:assert/strict";
import { createSavedSystemsHandler } from "./saved-systems.ts";
const source = {
  branch: { kind: "main" },
  sourceVersion: `commit:${"a".repeat(40)}`,
};
const origin = "http://127.0.0.1:4311";
const tag = { mode: "create", name: "v1" };
function command(path: string, body: unknown, from = origin) {
  return new Request(origin + path, {
    method: "POST",
    headers: {
      host: "127.0.0.1:4311",
      origin: from,
      "content-type": "application/json",
      cookie: `assembly-space-session=${"a".repeat(64)}`,
    },
    body: JSON.stringify(body),
  });
}
Deno.test("saved system HTTP creation binds current control while local reads refuse arbitrary scope/actor DTOs", async () => {
  const calls: unknown[] = [];
  const handle = createSavedSystemsHandler(
    {
      readTool(id, operatorId, candidateId) {
        calls.push({ id, operatorId, candidateId });
        return Promise.resolve({ sources: [] });
      },
      save() {
        throw new Error("No unauthenticated Main save path");
      },
      list() {
        calls.push("list");
        return Promise.resolve([]);
      },
      inspect(id) {
        calls.push(id);
        return Promise.resolve({ id } as never);
      },
    },
    origin,
    {
      save(secret, input) {
        equal(secret, "a".repeat(64));
        calls.push(input);
        return Promise.resolve({ id: "saved" } as never);
      },
      list() {
        throw new Error("Main read must keep its existing source scope");
      },
      inspect() {
        throw new Error("Main read must keep its existing source scope");
      },
      readTool() {
        throw new Error("Main tool read must keep its existing source scope");
      },
    },
  );
  equal(
    (await handle(
      command("/api/saved-systems/save", {
        saveKey: "key",
        name: "Name",
        purpose: "Purpose",
        source,
        tag,
      }),
    ))!.status,
    200,
  );
  equal((await handle(command("/api/saved-systems/list", {})))!.status, 200);
  equal(
    (await handle(command("/api/saved-systems/saved/inspect", {})))!.status,
    200,
  );
  deepStrictEqual(calls, [
    { saveKey: "key", name: "Name", purpose: "Purpose", source, tag },
    "list",
    "saved",
  ]);
  equal(
    (await handle(
      command("/api/saved-systems/saved/tools/retired-operator/tool/read", {}),
    ))!.status,
    200,
  );
  deepStrictEqual(calls.at(-1), {
    id: "saved",
    operatorId: "retired-operator",
    candidateId: "tool",
  });
  equal(
    (await handle(
      command("/api/saved-systems/saved/tools/retired-operator/tool/read", {
        actorId: "owner",
      }),
    ))!.status,
    400,
  );
  equal(
    (await handle(
      command("/api/saved-systems/save", {
        saveKey: "key",
        name: "Name",
        purpose: "",
        actorId: "owner",
        exerciseOwnerAuthority: {},
      }),
    ))!.status,
    400,
  );
  equal(
    (await handle(command("/api/saved-systems/list", { systemId: "other" })))!
      .status,
    400,
  );
  equal(
    (await handle(
      command("/api/saved-systems/list", {}, "https://evil.invalid"),
    ))!.status,
    403,
  );
  equal(
    (await handle(
      command("/api/saved-systems/save", { name: "x".repeat(9000) }),
    ))!.status,
    400,
  );
  equal(
    (await handle(new Request(origin + "/api/saved-systems/list")))!.status,
    405,
  );
  equal(await handle(new Request(origin + "/api/unrelated")), null);
});

Deno.test("Release HTTP requires exact branch/source selection and rejects client-owned ref or authority fields", async () => {
  let calls = 0;
  const handle = createSavedSystemsHandler({
    save() {
      calls++;
      return Promise.resolve({} as never);
    },
    list: () => Promise.resolve([]),
    inspect: () => Promise.resolve({} as never),
    readTool: () => Promise.resolve({ sources: [] }),
  }, origin);
  for (
    const selected of [undefined, { ...source, sourceVersion: "HEAD" }, {
      ...source,
      branch: { kind: "main", ref: "refs/heads/proposal" },
    }, { ...source, actorId: "owner" }]
  ) {
    const result = await handle(
      command("/api/saved-systems/save", {
        saveKey: "key",
        name: "Name",
        purpose: "",
        source: selected,
      }),
    );
    equal(result!.status, 400);
  }
  equal(calls, 0);
});

Deno.test("stale source error is a conflict without exposing a different response", async () => {
  const handle = createSavedSystemsHandler(
    {
      save: () => Promise.reject(new Error("unused")),
      list: () => Promise.resolve([]),
      inspect: () => Promise.reject(new Error("unused")),
      readTool: () => Promise.reject(new Error("unused")),
    },
    origin,
    {
      save: () =>
        Promise.reject(
          new SavedSystemError("SOURCE_STALE", "Selected source is stale."),
        ),
      list: () => Promise.resolve([]),
      inspect: () => Promise.reject(new Error("unused")),
      readTool: () => Promise.reject(new Error("unused")),
    },
  );
  const response = await handle(
    command("/api/saved-systems/save", {
      saveKey: "key",
      name: "Name",
      purpose: "Purpose",
      source,
      tag,
    }),
  );
  equal(response!.status, 409);
  deepStrictEqual(await response!.json(), {
    code: "SOURCE_STALE",
    error: "Selected source is stale.",
  });
});

Deno.test("selected HTTP inspection alone invokes read-only readiness after Main or owned Request access", async () => {
  const trace: string[] = [];
  const published: SavedSystemView = {
    id: "release",
    saveKey: "key",
    metadata: { name: "Published", purpose: "" },
    createdAt: "2026-10-30T00:00:00Z",
    status: "incomplete",
    revision: 3,
    manifest: null,
    digest: null,
    issues: ["PREREQUISITES_REQUIRED"],
    origin: {
      projectId: "project",
      systemId: "system",
      executionSpaceId: "main",
    },
    assetAvailability: "verified",
    openingAvailability: "unchecked",
    openingIssues: [],
    selectedOperators: [],
    prerequisites: [],
  };
  const before = structuredClone(published);
  let denied = false, failed = false;
  const service = {
    save: () => Promise.resolve(structuredClone(published)),
    list: () => {
      trace.push("list");
      return Promise.resolve([structuredClone(published)]);
    },
    inspect: (id: string) => {
      trace.push(`main:${id}`);
      return Promise.resolve(structuredClone(published));
    },
    readTool: () => {
      trace.push("tool");
      return Promise.resolve({ sources: [] });
    },
  };
  const handle = createSavedSystemsHandler(service, origin, {
    save: service.save,
    list: service.list,
    readTool: service.readTool,
    inspect(secret, id) {
      equal(secret, "a".repeat(64));
      trace.push(`request:${id}`);
      if (denied) {
        throw new SavedSystemError("FORBIDDEN", "Release unavailable.");
      }
      return Promise.resolve({
        ...structuredClone(published),
        origin: { ...published.origin, executionSpaceId: "request-space" },
      });
    },
  }, {
    inspect(view) {
      trace.push(`probe:${view.origin.executionSpaceId}`);
      if (failed) throw new Error("/private/secret/path");
      // The port receives a clone; accidental changes cannot replace publication facts.
      view.metadata.name = "Must not replace publication";
      return Promise.resolve({
        openingAvailability: "ready" as const,
        openingIssues: [],
      });
    },
  });
  for (
    const path of [
      "/api/saved-systems/list",
      "/api/saved-systems/list?space=requests",
    ]
  ) {
    const response = await handle(command(path, {}));
    equal(response!.status, 200);
    equal((await response!.json())[0].openingAvailability, "unchecked");
  }
  const saved = await handle(
    command("/api/saved-systems/save", {
      saveKey: "key",
      name: "Published",
      purpose: "",
      source,
      tag,
    }),
  );
  equal((await saved!.json()).openingAvailability, "unchecked");
  await handle(
    command("/api/saved-systems/release/tools/operator/tool/read", {}),
  );
  equal(trace.some((entry) => entry.startsWith("probe:")), false);
  trace.length = 0;
  for (const suffix of ["", "?space=requests"]) {
    const response = await handle(
      command(`/api/saved-systems/release/inspect${suffix}`, {}),
    );
    const result = await response!.json();
    equal(result.openingAvailability, "ready");
    deepStrictEqual(result.openingIssues, []);
    equal(result.metadata.name, "Published");
    equal(result.status, published.status);
  }
  deepStrictEqual(trace, [
    "main:release",
    "probe:main",
    "request:release",
    "probe:request-space",
  ]);
  deepStrictEqual(published, before);
  trace.length = 0;
  denied = true;
  equal(
    (await handle(
      command("/api/saved-systems/release/inspect?space=requests", {}),
    ))!.status,
    403,
  );
  deepStrictEqual(trace, ["request:release"]);
  failed = true;
  const refused = await handle(
    command("/api/saved-systems/release/inspect", {}),
  );
  const result = await refused!.json();
  equal(result.openingAvailability, "unavailable");
  deepStrictEqual(result.openingIssues, ["SOURCE_OPENING_UNAVAILABLE"]);
  equal(JSON.stringify(result).includes("/private/"), false);
  deepStrictEqual(published, before);
});

Deno.test("Release catalogue discloses its bounded window and read-only pending history", async () => {
  const pending = {
    id: "accepted",
    status: "pending",
    publication: {
      format: "assembly-release-publication-v1",
      outcome: "pending",
      attempt: 0,
      updatedAt: "2026-10-31T00:00:00.000Z",
      nextSequence: 2,
      historyTruncated: false,
      events: [{
        sequence: 1,
        attempt: 0,
        step: "acceptance",
        status: "completed",
        at: "2026-10-31T00:00:00.000Z",
      }],
    },
  } as SavedSystemView;
  let mutations = 0;
  const handle = createSavedSystemsHandler({
    save() {
      mutations++;
      throw new Error("No implicit recovery");
    },
    list: () => Promise.resolve([pending]),
    inspect: () => Promise.resolve(pending),
    readTool: () => Promise.resolve({ sources: [] }),
  }, origin);
  const response = (await handle(command("/api/saved-systems/list", {})))!;
  equal(response.headers.get("x-assembly-catalogue-limit"), "100");
  equal(response.headers.get("x-assembly-catalogue-history"), "bounded");
  const result = await response.json();
  equal(result[0].publication.outcome, "pending");
  equal(result[0].publication.events.length, 1);
  equal(mutations, 0);
});
