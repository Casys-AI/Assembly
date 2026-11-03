import assert from "node:assert/strict";
import { PostgresProviderCallStore } from "../../src/adapters/out/postgres/provider-call-store.ts";
import {
  type ProviderCallObservation,
  UNKNOWN_PROVIDER_CALL_CORRELATION,
} from "../../src/application/telemetry/provider-call.ts";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";

const host = { projectId: "project", systemId: "system" };
const observation = (
  id: string,
  space: string | null,
): ProviderCallObservation => ({
  schemaVersion: 1,
  observationId: id,
  provider: "anthropic",
  configuredModel: "model",
  startedAt: "2026-10-29T00:00:00.000Z",
  endedAt: "2026-10-29T00:00:01.000Z",
  elapsedMs: 1000,
  outcome: "returned",
  correlation: {
    ...UNKNOWN_PROVIDER_CALL_CORRELATION,
    executionScope: space === null
      ? null
      : { ...host, executionSpaceId: space },
  },
  usage: { input_tokens: 7 },
});

Deno.test({
  name:
    "provider call storage preserves idempotency, conflict, scope and reopen",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      const a = new PostgresProviderCallStore(client);
      const b = new PostgresProviderCallStore(createClient());
      const main = observation("9f109fd4-fecb-4994-a2e4-3be47f07c931", "main");
      const unknown = observation("69db6eaf-cda4-4639-bfb1-fb80c35ac8be", null);
      const branch = observation(
        "6bbd387f-7efc-4cd9-8d2b-29ae0c1f1a10",
        "branch",
      );
      assert.deepEqual(
        (await Promise.all([a.append(host, main), b.append(host, main)]))
          .sort(),
        ["duplicate", "inserted"],
      );
      await assert.rejects(a.append(host, { ...main, elapsedMs: 5 }), {
        name: "ProviderCallConflictError",
        code: "PROVIDER_CALL_CONFLICT",
        message: "Provider call observation identity conflict",
      });
      await assert.rejects(
        a.append(host, {
          ...main,
          correlation: {
            ...main.correlation,
            executionScope: { ...host, executionSpaceId: "branch" },
          },
        }),
        { code: "PROVIDER_CALL_CONFLICT" },
      );
      await assert.rejects(
        a.append({ ...host, systemId: "foreign" }, main),
        /host mismatch/,
      );
      assert.equal(await a.append(host, unknown), "inserted");
      assert.equal(await a.append(host, branch), "inserted");
      const otherHost = { ...host, systemId: "other" };
      assert.equal(await a.append(otherHost, unknown), "inserted");
      assert.deepEqual(await b.list({ ...host, executionSpaceId: null }), [
        unknown,
      ]);
      assert.deepEqual(await b.list({ ...host, executionSpaceId: "main" }), [
        main,
      ]);
      assert.deepEqual(await b.list({ ...host, executionSpaceId: "branch" }), [
        branch,
      ]);
      assert.deepEqual(
        await b.list({ ...otherHost, executionSpaceId: "main" }),
        [],
      );
      await client.$disconnect();
      const reopened = new PostgresProviderCallStore(createClient());
      assert.deepEqual(
        await reopened.list({ ...host, executionSpaceId: "main" }),
        [main],
      );
      assert.equal(await reopened.append(host, main), "duplicate");
      await assert.rejects(
        reopened.list({ ...host, executionSpaceId: null }, 501),
      );
    });
  },
});
