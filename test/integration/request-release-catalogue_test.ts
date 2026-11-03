import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { PostgresRequestReleaseCatalogue } from "../../src/adapters/out/postgres/request-release-catalogue.ts";
import { registerPostgresClientSchema } from "../../src/adapters/out/postgres/client-schema.ts";
import type {
  Prisma,
  PrismaClient,
} from "../../src/adapters/out/postgres/client.ts";
import { requestReleaseFixture } from "../support/request-release-fixture.ts";

async function fixture() {
  const f = await requestReleaseFixture();
  const statements: Prisma.Sql[] = [];
  const row = {
    ...f.scope,
    id: "release-a",
    saveKey: "save-a",
    commandDigest: "command",
    creationAuthorization: null,
    metadata: JSON.stringify({ name: "A", purpose: "Exact" }),
    capture: JSON.stringify({
      origin: f.scope,
      source: f.source,
      registeredOperatorIds: ["operator"],
      operators: [],
      prerequisites: [],
      admission: { operatorIds: [], prerequisites: [] },
    }),
    createdAt: new Date(f.record.createdAt),
    status: "pending",
    manifest: null,
    digest: null,
    issues: "[]",
    revision: 0,
    openingCaseId: f.record.caseId,
    openingOwnerId: f.record.ownerId,
  };
  let rows = [row];
  const client = {
    $queryRaw(query: Prisma.Sql) {
      statements.push(query);
      return Promise.resolve(rows);
    },
  } as unknown as PrismaClient;
  registerPostgresClientSchema(client, "request_release_fixture");
  const catalogue = new PostgresRequestReleaseCatalogue(client, f.record.scope);
  return {
    ...f,
    row,
    statements,
    catalogue,
    answer(next: typeof row[]) {
      rows = next;
    },
  };
}

Deno.test("owned catalogue uses one bounded read of existing rows with host/owner/Case parameters and actual origin", async () => {
  const f = await fixture();
  const records = await f.catalogue.listOwned("owner", f.record.caseId);
  equal(records.length, 1);
  deepStrictEqual(records[0].scope, f.scope);
  equal(records[0].record.capture.source?.branch.kind, "case");
  equal("openingOwnerId" in records[0].record, false);
  equal(f.statements.length, 1);
  const query = f.statements[0];
  ok(query.sql.includes('"request_release_fixture"."SavedSystem"'));
  ok(query.sql.includes('"request_release_fixture"."SpaceOpening"'));
  ok(query.sql.includes("LIMIT 100"));
  ok(!/UPDATE|INSERT|DELETE|FOR UPDATE/.test(query.sql));
  for (
    const value of [
      f.scope.projectId,
      f.scope.systemId,
      "owner",
      f.record.caseId,
    ]
  ) ok(query.values.includes(value));
});

Deno.test("selected origin lookup keeps Request scope and a missing/foreign joined row cannot become Main", async () => {
  const f = await fixture();
  const selected = await f.catalogue.selected("owner", "release-a");
  deepStrictEqual(selected?.scope, f.scope);
  ok(f.statements[0].values.includes("release-a"));
  f.answer([]);
  equal(await f.catalogue.selected("owner", "missing"), null);
  f.answer([{ ...f.row, openingOwnerId: "foreign" }]);
  await rejects(() => f.catalogue.selected("owner", "release-a"));
  f.answer([{ ...f.row, executionSpaceId: "foreign-space" }]);
  await rejects(() => f.catalogue.selected("owner", "release-a"));
});
