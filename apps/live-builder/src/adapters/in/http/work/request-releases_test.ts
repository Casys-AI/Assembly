import { deepStrictEqual, equal } from "node:assert/strict";
import { createSavedSystemsHandler } from "./saved-systems.ts";
import { SavedSystemError } from "../../../../domain/work/saved-systems.ts";

const origin = "http://127.0.0.1:4311";
const version = `commit:${"a".repeat(40)}`;
const cookie = `assembly-space-session=${"a".repeat(64)}`;
function post(path: string, body: unknown, authenticated = true) {
  return new Request(origin + path, {
    method: "POST",
    headers: {
      host: "127.0.0.1:4311",
      origin,
      "content-type": "application/json",
      ...(authenticated ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function fixture() {
  const main: string[] = [], scoped: unknown[] = [];
  let forbidden = false;
  const denyMainSave = () => {
    main.push("save");
    throw new Error("HTTP cannot bypass current creation authority");
  };
  const service = {
    save: denyMainSave,
    list: () => Promise.resolve([]),
    inspect: denyMainSave,
    readTool: denyMainSave,
  };
  const result = {
    id: "release-a",
    origin: { projectId: "p", systemId: "s", executionSpaceId: "space-a" },
  };
  const requests = {
    listTags(secret: string, source: unknown) {
      scoped.push({ kind: "tags", secret, source });
      return Promise.resolve({
        tags: [{
          name: "v1",
          refOid: "a".repeat(40),
          commitOid: "a".repeat(40),
        }],
      });
    },
    save(secret: string, command: unknown) {
      scoped.push({ kind: "save", secret, command });
      if (forbidden) {
        throw new SavedSystemError("FORBIDDEN", "retain-release required");
      }
      return Promise.resolve(result);
    },
    list(secret: string, caseId?: string) {
      scoped.push({ kind: "list", secret, caseId });
      return Promise.resolve([result]);
    },
    inspect(secret: string, id: string) {
      scoped.push({ kind: "inspect", secret, id });
      return Promise.resolve(result);
    },
    readTool(
      secret: string,
      id: string,
      operatorId: string,
      candidateId: string,
    ) {
      scoped.push({ kind: "tool", secret, id, operatorId, candidateId });
      return Promise.resolve({ sources: [] });
    },
  };
  const handler = createSavedSystemsHandler(
    service as never,
    origin,
    requests as never,
  );
  return {
    handler,
    main,
    scoped,
    forbid() {
      forbidden = true;
    },
  };
}

Deno.test("tag inventory requires the current session and one exact source with no browser scope", async () => {
  const f = fixture();
  const source = {
    branch: { kind: "case", caseId: "case-a" },
    sourceVersion: version,
  };
  equal(
    (await f.handler(post("/api/saved-systems/tags", { source }, false)))!
      .status,
    403,
  );
  equal(f.scoped.length, 0);
  const response =
    (await f.handler(post("/api/saved-systems/tags", { source })))!;
  equal(response.status, 200);
  deepStrictEqual(await response.json(), {
    tags: [{ name: "v1", refOid: "a".repeat(40), commitOid: "a".repeat(40) }],
  });
  deepStrictEqual(f.scoped, [{ kind: "tags", secret: "a".repeat(64), source }]);
  for (
    const [path, body] of [
      ["/api/saved-systems/tags?space=requests", { source }],
      ["/api/saved-systems/tags", { source, repositoryId: "foreign" }],
      ["/api/saved-systems/tags", {
        source: { ...source, sourceVersion: "HEAD" },
      }],
    ] as const
  ) equal((await f.handler(post(path, body)))!.status, 400);
});

Deno.test("both Main and Case save require the authenticated creation boundary and preserve exact source/key", async () => {
  const f = fixture();
  const commands = [
    {
      saveKey: "save-main",
      tag: { mode: "create", name: "save-main" },
      name: "Main",
      purpose: "Exact",
      source: { branch: { kind: "main" }, sourceVersion: version },
    },
    {
      saveKey: "save-case",
      tag: { mode: "create", name: "save-case" },
      name: "A",
      purpose: "Exact",
      source: {
        branch: { kind: "case", caseId: "case-a" },
        sourceVersion: version,
      },
    },
  ];
  for (const command of commands) {
    equal(
      (await f.handler(post("/api/saved-systems/save", command, false)))!
        .status,
      403,
    );
    equal(
      (await f.handler(post("/api/saved-systems/save", command)))!.status,
      200,
    );
  }
  deepStrictEqual(
    f.scoped,
    commands.map((command) => ({
      kind: "save",
      secret: "a".repeat(64),
      command,
    })),
  );
  f.forbid();
  equal(
    (await f.handler(post("/api/saved-systems/save", commands[0])))!.status,
    403,
  );
  deepStrictEqual(f.main, []);
});

Deno.test("owned Request catalogue/inspection selectors stay explicit and never call Main readers", async () => {
  const f = fixture();
  for (
    const path of [
      "/api/saved-systems/list?space=requests",
      "/api/saved-systems/list?caseId=case-a",
      "/api/saved-systems/release-a/inspect?space=requests",
      "/api/saved-systems/release-a/tools/operator/tool/read?space=requests",
    ]
  ) equal((await f.handler(post(path, {})))!.status, 200);
  deepStrictEqual(f.scoped.map((entry) => (entry as { kind: string }).kind), [
    "list",
    "list",
    "inspect",
    "tool",
  ]);
  deepStrictEqual(f.scoped[1], {
    kind: "list",
    secret: "a".repeat(64),
    caseId: "case-a",
  });
  for (
    const path of [
      "/api/saved-systems/list?space=main",
      "/api/saved-systems/list?space=requests&space=requests",
      "/api/saved-systems/list?caseId=case-a&space=requests",
      "/api/saved-systems/release-a/inspect?caseId=case-a",
      "/api/saved-systems/list?executionSpaceId=space-a",
    ]
  ) equal((await f.handler(post(path, {})))!.status, 400);
  equal(
    (await f.handler(
      post("/api/saved-systems/list?space=requests", {}, false),
    ))!.status,
    403,
  );
  deepStrictEqual(f.main, []);
});

Deno.test("missing production creation binding fails closed instead of using a generic Main service", async () => {
  let writes = 0;
  const save = () => {
    writes++;
    return Promise.resolve({});
  };
  const handler = createSavedSystemsHandler(
    { save, list: save, inspect: save, readTool: save } as never,
    origin,
  );
  const command = {
    saveKey: "save",
    name: "A",
    purpose: "Exact",
    source: { branch: { kind: "main" }, sourceVersion: version },
  };
  equal((await handler(post("/api/saved-systems/save", command)))!.status, 403);
  equal(writes, 0);
});
