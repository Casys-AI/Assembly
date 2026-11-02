import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  decodeSavedSystemRow,
  PostgresSavedSystemStore,
  type SavedSystemRow,
} from "./saved-system-store.ts";
import { registerPostgresClientSchema } from "./client-schema.ts";
import type { Prisma, PrismaClient } from "./client.ts";

const scope = { projectId: "p", systemId: "s", executionSpaceId: "main" };
const row: SavedSystemRow = {
  id: "release",
  saveKey: "key",
  commandDigest: "digest",
  metadata: JSON.stringify({ name: "Release", purpose: "" }),
  capture: "{}",
  createdAt: new Date("2026-10-31T00:00:00Z"),
  status: "pending",
  manifest: null,
  digest: null,
  issues: "[]",
  revision: 0,
};

Deno.test("Release store emits only after changed transaction commits, never after rollback or stale CAS", async () => {
  let notifications = 0;
  let mutations = 0;
  let mode: "commit" | "rollback" = "commit";
  let gate = Promise.withResolvers<void>();
  const updated = Promise.withResolvers<void>();
  const tx = {
    executionSpace: { updateMany: () => Promise.resolve({ count: 1 }) },
    $queryRaw: (query: Prisma.Sql) => {
      if (query.sql.startsWith("UPDATE")) {
        mutations++;
        updated.resolve();
        return Promise.resolve([{ ...row, status: "incomplete", revision: 1 }]);
      }
      return Promise.resolve([row]);
    },
  };
  const client = {
    $transaction: async (work: (selected: typeof tx) => Promise<unknown>) => {
      const result = await work(tx);
      await gate.promise;
      if (mode === "rollback") throw new Error("commit refused");
      return result;
    },
  } as unknown as PrismaClient;
  registerPostgresClientSchema(client, "controlled");
  const store = new PostgresSavedSystemStore(
    client,
    undefined,
    undefined,
    () => {
      notifications++;
    },
  );
  const command = {
    scope,
    id: row.id,
    expectedRevision: 0,
    issues: ["EXACT_ASSET_UNAVAILABLE"],
  };
  const pending = store.markIncomplete(command);
  await updated.promise;
  equal(notifications, 0);
  gate.resolve();
  equal((await pending).revision, 1);
  equal(notifications, 1);
  await store.markIncomplete({ ...command, expectedRevision: 10 });
  equal(notifications, 1);
  mode = "rollback";
  gate = Promise.withResolvers<void>();
  const failed = store.markIncomplete(command);
  gate.resolve();
  await rejects(failed, /commit refused/);
  equal(notifications, 1);
  equal(mutations, 2);
  deepStrictEqual(command.scope, scope);
});

Deno.test("a stream failure cannot turn committed Release retention into failure", async () => {
  const tx = {
    executionSpace: { updateMany: () => Promise.resolve({ count: 1 }) },
    $queryRaw: (query: Prisma.Sql) =>
      Promise.resolve([
        query.sql.startsWith("UPDATE")
          ? { ...row, revision: 1, status: "incomplete" }
          : row,
      ]),
  };
  const client = {
    $transaction: (work: (selected: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;
  registerPostgresClientSchema(client, "controlled");
  const store = new PostgresSavedSystemStore(
    client,
    undefined,
    undefined,
    () => {
      throw new Error("stream unavailable");
    },
  );
  equal(
    (await store.markIncomplete({
      scope,
      id: row.id,
      expectedRevision: 0,
      issues: [],
    })).revision,
    1,
  );
});

Deno.test("Release progress CAS rejects stale revisions and superseded runs and emits only committed steps", async () => {
  let selected = { ...row };
  let at = "2026-11-02T01:00:00.000Z";
  let notifications = 0;
  let updates = 0;
  let rollback = false;
  const tx = {
    executionSpace: { updateMany: () => Promise.resolve({ count: 1 }) },
    $queryRaw: (query: Prisma.Sql) => {
      if (query.sql.startsWith("UPDATE")) {
        updates++;
        const publication = query.values.find((value) =>
          typeof value === "string" &&
          value.startsWith('{"format":"assembly-release-publication-v1"')
        ) as string;
        selected = {
          ...selected,
          publication,
          revision: selected.revision + 1,
        };
      }
      return Promise.resolve([selected]);
    },
  };
  const client = {
    $queryRaw: tx.$queryRaw,
    $transaction: async (work: (selectedTx: typeof tx) => Promise<unknown>) => {
      const before = selected;
      const result = await work(tx);
      if (rollback) {
        selected = before;
        throw new Error("progress commit failed");
      }
      return result;
    },
  } as unknown as PrismaClient;
  registerPostgresClientSchema(client, "controlled");
  const store = new PostgresSavedSystemStore(
    client,
    undefined,
    undefined,
    () => {
      notifications++;
    },
    { now: () => at },
  );
  const start = {
    scope,
    id: row.id,
    expectedRevision: 0,
    runId: "first",
    start: true,
    event: { step: "recovery" as const, status: "started" as const },
    outcome: "preparing" as const,
  };
  const first = await store.progress(start);
  equal(first.publication?.attempt, 1);
  equal(first.publication?.events[0]?.at, at);
  equal(first.publication?.updatedAt, at);
  equal(first.createdAt, row.createdAt.toISOString());
  at = "2026-11-02T02:00:00.000Z";
  const second = await store.progress({
    ...start,
    expectedRevision: 1,
    runId: "second",
  });
  equal(second.publication?.attempt, 2);
  equal(second.publication?.events.length, 2);
  equal(second.publication?.events[1]?.at, at);
  equal(second.publication?.updatedAt, at);
  const stale = await store.progress({
    ...start,
    start: false,
    expectedRevision: 2,
  });
  equal(stale.publication?.runId, "second");
  equal(updates, 2);
  equal(notifications, 2);
  rollback = true;
  await rejects(
    () => store.progress({ ...start, expectedRevision: 2, runId: "third" }),
    /progress commit failed/,
  );
  equal(notifications, 2);
  equal((await store.get(scope, row.id))?.publication?.runId, "second");
});

Deno.test("historical Release rows have no invented publication observations", () => {
  equal(decodeSavedSystemRow(row).publication, undefined);
  equal(
    decodeSavedSystemRow({ ...row, publication: null }).publication,
    undefined,
  );
});
