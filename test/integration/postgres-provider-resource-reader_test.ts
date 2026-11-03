import assert from "node:assert/strict";
import { Client } from "pg";
import {
  PostgresProviderResourceReader,
} from "../../src/adapters/out/postgres/provider-resource-reader.ts";
import { encodeProviderCall } from "../../src/adapters/out/postgres/provider-call-codec.ts";
import {
  type ProviderCallObservation,
  UNKNOWN_PROVIDER_CALL_CORRELATION,
} from "../../src/application/telemetry/provider-call.ts";
import type { ProviderResourceQuery } from "../../src/application/telemetry/provider-resource-readout.ts";
import type { PrismaClient } from "../../src/adapters/out/postgres/client.ts";
import { registerPostgresClientSchema } from "../../src/adapters/out/postgres/client-schema.ts";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";

const host = { projectId: "resource-project", systemId: "resource-system" };
const query: ProviderResourceQuery = {
  ...host,
  executionSpaceId: "main",
  repositoryVersion: `commit:${"a".repeat(40)}`,
  modelDigest: "a".repeat(64),
  endedThrough: "2026-10-29T00:00:02.000Z",
};
const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
function observation(
  n: number,
  patch: Partial<ProviderCallObservation> = {},
): ProviderCallObservation {
  return {
    schemaVersion: 1,
    observationId: id(n),
    provider: "anthropic",
    configuredModel: "model",
    startedAt: "2026-10-29T00:00:00.000Z",
    endedAt: "2026-10-29T00:00:01.000Z",
    elapsedMs: 0.5,
    outcome: "returned",
    usage: { input_tokens: 1 },
    correlation: {
      ...UNKNOWN_PROVIDER_CALL_CORRELATION,
      executionScope: { ...host, executionSpaceId: "main" },
      repositoryVersion: query.repositoryVersion,
      modelDigest: query.modelDigest,
    },
    ...patch,
  };
}
const row = (call: ProviderCallObservation, scope = host) => ({
  ...scope,
  executionSpaceId: call.correlation.executionScope?.executionSpaceId ?? null,
  observationId: call.observationId,
  payload: encodeProviderCall(scope, call),
});
const unavailable = {
  name: "ProviderResourceReadError",
  code: "PROVIDER_RESOURCE_READ_FAILED",
  message: "Provider resource readout is unavailable",
};

Deno.test({
  name:
    "provider resource query exhausts >500 rows with exact scopes, actual versions, cutoff and usage unknowns",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      const calls = Array.from({ length: 501 }, (_, i) =>
        observation(i + 1, {
          correlation: {
            ...observation(i + 1).correlation,
            operatorId: ["operator-a", "operator-b", null][i % 3],
          },
          usage: i === 0
            ? { input_tokens: 0 }
            : i === 1
            ? undefined
            : { input_tokens: 1 },
          ...(i === 500
            ? { endedAt: query.endedThrough, outcome: "failed" as const }
            : {}),
        }));
      const base = observation(1000);
      calls.push(
        observation(1000, {
          correlation: {
            ...base.correlation,
            repositoryVersion: `commit:${"b".repeat(40)}`,
          },
        }),
        observation(1001, {
          correlation: { ...base.correlation, modelDigest: "b".repeat(64) },
        }),
        observation(1002, { endedAt: "2026-10-29T00:00:02.001Z" }),
        observation(1003, {
          correlation: { ...base.correlation, repositoryVersion: null },
        }),
        observation(1004, {
          correlation: { ...base.correlation, modelDigest: null },
        }),
        observation(1005, {
          correlation: { ...base.correlation, executionScope: null },
        }),
        observation(1006, {
          correlation: {
            ...base.correlation,
            executionScope: { ...host, executionSpaceId: "case-a" },
            caseId: "case-a",
          },
        }),
        observation(1007, {
          correlation: {
            ...base.correlation,
            executionScope: { ...host, executionSpaceId: "case-a" },
            caseId: "case-b",
          },
        }),
        observation(1008, {
          correlation: {
            ...base.correlation,
            executionScope: { ...host, executionSpaceId: "case-b" },
            caseId: "case-b",
          },
        }),
      );
      for (let i = 501; i < calls.length; i++) {
        calls[i] = {
          ...calls[i],
          correlation: {
            ...calls[i].correlation,
            operatorId: "outside-selection",
          },
        };
      }
      const foreign = { ...host, systemId: "foreign" };
      const foreignCall = observation(1009, {
        correlation: {
          ...base.correlation,
          operatorId: "foreign-operator",
          executionScope: { ...foreign, executionSpaceId: "main" },
        },
      });
      // Fixture bulk seed reuses canonical production encoding; sink idempotency
      // is already qualified separately. The production reader is unchanged.
      await client.providerCallObservation.createMany({
        data: [
          ...calls.map((call) => row(call)),
          row(foreignCall, foreign),
        ],
      });
      const reader = new PostgresProviderResourceReader(client);
      const result = await reader.read(query);
      assert.equal(result.calls, 501);
      assert.equal(result.outcomes.failed, 1);
      assert.equal(result.outcomes.returned, 500);
      assert.equal(result.providerElapsedMs.observedSubtotal, 250.5);
      assert.deepEqual(result.units.input_tokens, {
        observedSubtotal: 499,
        presentCalls: 500,
        missingCalls: 1,
        state: "partial",
      });
      assert.equal(result.units.output_tokens.observedSubtotal, null);
      assert.equal(result.units.output_tokens.missingCalls, 501);
      assert.equal(result.physicalCallCoverage, "unknown");
      assert.equal(result.retainedPopulation, "complete");
      const groups = result.operatorGroups!;
      assert.deepEqual(groups.map((group) => [group.operatorId, group.calls]), [
        ["operator-a", 167],
        ["operator-b", 167],
        [null, 167],
      ]);
      assert.deepEqual(groups.map((group) => group.units.input_tokens), [
        {
          observedSubtotal: 166,
          presentCalls: 167,
          missingCalls: 0,
          state: "known",
        },
        {
          observedSubtotal: 166,
          presentCalls: 166,
          missingCalls: 1,
          state: "partial",
        },
        {
          observedSubtotal: 167,
          presentCalls: 167,
          missingCalls: 0,
          state: "known",
        },
      ]);
      assert.deepEqual(
        groups.map((group) => group.providerElapsedMs.observedSubtotal),
        [83.5, 83.5, 83.5],
      );
      assert.deepEqual(groups.map((group) => group.outcomes.failed), [0, 0, 1]);
      assert.equal(
        groups.reduce((sum, group) => sum + group.calls, 0),
        result.calls,
      );
      assert.equal(
        groups.reduce(
          (sum, group) => sum + group.units.input_tokens.missingCalls,
          0,
        ),
        result.units.input_tokens.missingCalls,
      );
      assert.equal(
        groups.reduce(
          (sum, group) => sum + group.units.input_tokens.presentCalls,
          0,
        ),
        result.units.input_tokens.presentCalls,
      );
      assert.equal(
        (await reader.read({
          ...query,
          executionSpaceId: "case-a",
          caseId: "case-a",
        })).calls,
        1,
      );
      assert.equal((await reader.read({ ...query, ...foreign })).calls, 1);
      const empty = await reader.read({
        ...query,
        modelDigest: "c".repeat(64),
      });
      assert.equal(empty.state, "observed-empty");
      assert.equal(empty.providerElapsedMs.observedSubtotal, null);
      assert.deepEqual(empty.operatorGroups, []);
    });
  },
});

Deno.test({
  name:
    "provider resource snapshots exclude between-page ingestion and retain it in the next read",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient, schema }) => {
      await client.providerCallObservation.createMany({
        data: Array.from({ length: 501 }, (_, i) => {
          const call = observation(i + 1);
          return row({
            ...call,
            correlation: {
              ...call.correlation,
              operatorId: i < 500 ? "operator-a" : "operator-b",
            },
          });
        }),
      });
      const writer = createClient();
      let inserted = false;
      // Controlled interleaving around real SQL, not a copied pagination reducer.
      const observed = new Proxy(client, {
        get(target, property, receiver) {
          if (property !== "$transaction") {
            return Reflect.get(target, property, receiver);
          }
          return (
            operation: (transaction: unknown) => Promise<unknown>,
            options: unknown,
          ) =>
            target.$transaction(
              (transaction) =>
                operation(
                  new Proxy(transaction, {
                    get(tx, key, txReceiver) {
                      if (key !== "$queryRaw") {
                        const member = Reflect.get(tx, key, txReceiver);
                        return typeof member === "function"
                          ? member.bind(tx)
                          : member;
                      }
                      return async (
                        ...args: Parameters<typeof tx.$queryRaw>
                      ) => {
                        const result = await tx.$queryRaw(...args);
                        if (
                          !inserted && Array.isArray(result) &&
                          result.length === 500
                        ) {
                          inserted = true;
                          const call = observation(1000);
                          await writer.providerCallObservation.create({
                            data: row({
                              ...call,
                              correlation: {
                                ...call.correlation,
                                operatorId: "new-operator",
                              },
                            }),
                          });
                        }
                        return result;
                      };
                    },
                  }),
                ),
              options as Parameters<PrismaClient["$transaction"]>[1],
            );
        },
      });
      registerPostgresClientSchema(observed, schema);
      const result = await new PostgresProviderResourceReader(observed).read(
        query,
      );
      assert.equal(inserted, true);
      assert.equal(result.calls, 501);
      assert.deepEqual(
        result.operatorGroups!.map((group) => [group.operatorId, group.calls]),
        [["operator-a", 500], ["operator-b", 1]],
      );
      const next = await new PostgresProviderResourceReader(client).read(query);
      assert.equal(next.calls, 502);
      assert.deepEqual(
        next.operatorGroups!.map((group) => [group.operatorId, group.calls]),
        [["new-operator", 1], ["operator-a", 500], ["operator-b", 1]],
      );
    });
  },
});

Deno.test({
  name:
    "provider resource query refuses corrupt scope rows before eligibility and never returns partial totals",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await client.providerCallObservation.create({
        data: row(observation(1)),
      });
      const outsideVersion = observation(1000, {
        correlation: {
          ...observation(1000).correlation,
          repositoryVersion: `commit:${"b".repeat(40)}`,
        },
        endedAt: "2026-10-29T00:00:03.000Z",
      });
      const corrupt = row(outsideVersion);
      await client.providerCallObservation.create({ data: corrupt });
      const reader = new PostgresProviderResourceReader(client);
      for (
        const payload of [
          "{",
          corrupt.payload.replace('"schemaVersion":1', '"schemaVersion":2'),
          encodeProviderCall(host, {
            ...outsideVersion,
            correlation: {
              ...outsideVersion.correlation,
              executionScope: { ...host, executionSpaceId: "foreign" },
            },
          }),
          JSON.stringify({ ...outsideVersion, usage: { input_tokens: -1 } }),
          encodeProviderCall(host, {
            ...outsideVersion,
            observationId: id(1001),
          }),
          `${corrupt.payload} `,
        ]
      ) {
        await client.providerCallObservation.update({
          where: {
            projectId_systemId_observationId: {
              ...host,
              observationId: outsideVersion.observationId,
            },
          },
          data: { payload },
        });
        await assert.rejects(reader.read(query), unavailable);
      }
      await client.providerCallObservation.update({
        where: {
          projectId_systemId_observationId: {
            ...host,
            observationId: outsideVersion.observationId,
          },
        },
        data: { payload: corrupt.payload },
      });
      assert.equal((await reader.read(query)).calls, 1);
    });
  },
});

Deno.test({
  name:
    "provider resource PostgreSQL read has a fixed deadline under a blocked table",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, schema, connectionString }) => {
      const blocker = new Client({
        connectionString,
        connectionTimeoutMillis: 5_000,
      });
      await blocker.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          `LOCK TABLE "${schema}"."ProviderCallObservation" IN ACCESS EXCLUSIVE MODE`,
        );
        const started = performance.now();
        await assert.rejects(
          new PostgresProviderResourceReader(client).read(query),
          unavailable,
        );
        const elapsed = performance.now() - started;
        assert(elapsed >= 8_000 && elapsed < 20_000);
      } finally {
        await blocker.query("ROLLBACK");
        await blocker.end();
      }
    });
  },
});

Deno.test({
  name:
    "provider resource PostgreSQL selection preserves exact Request R0/R1 pins and unknown evidence",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      const caseId = "case-a", executionSpaceId = "case-space-a";
      const r0 = `commit:${"1".repeat(40)}`,
        r1 = `commit:${"2".repeat(40)}`,
        sameDigestOtherVersion = `commit:${"3".repeat(40)}`;
      const digest0 = "4".repeat(64), digest1 = "5".repeat(64);
      const scoped = (
        n: number,
        version: string | null,
        digest: string | null,
        changes: Partial<ProviderCallObservation> = {},
      ) => {
        const base = observation(n);
        return observation(n, {
          ...changes,
          correlation: {
            ...base.correlation,
            executionScope: { ...host, executionSpaceId },
            scopeKind: "request",
            scopeId: caseId,
            caseId,
            repositoryVersion: version,
            modelDigest: digest,
          },
        });
      };
      // Synthetic persisted measurements exercise selection, not external provider calls.
      const r0call = scoped(3001, r0, digest0, { usage: { input_tokens: 11 } });
      const calls = [
        r0call,
        scoped(3002, r1, digest1, { usage: { input_tokens: 7 } }),
        scoped(3003, sameDigestOtherVersion, digest1, {
          usage: { input_tokens: 99 },
        }),
        scoped(3004, null, digest1),
        scoped(3005, r1, null),
        scoped(3006, r1, digest1, {
          endedAt: query.endedThrough,
          usage: { input_tokens: 3 },
        }),
        scoped(3007, r1, digest1, { endedAt: "2026-10-29T00:00:02.001Z" }),
      ];
      const sibling = scoped(3008, r1, digest1);
      calls.push({
        ...sibling,
        correlation: {
          ...sibling.correlation,
          caseId: "case-b",
          scopeId: "case-b",
        },
      });
      const otherSpace = scoped(3009, r1, digest1);
      calls.push({
        ...otherSpace,
        correlation: {
          ...otherSpace.correlation,
          executionScope: { ...host, executionSpaceId: "case-space-b" },
        },
      });
      await client.providerCallObservation.createMany({
        data: calls.map((call) => row(call)),
      });
      const originalR0 = await client.providerCallObservation.findUniqueOrThrow(
        {
          where: {
            projectId_systemId_observationId: {
              ...host,
              observationId: r0call.observationId,
            },
          },
        },
      );
      const reader = new PostgresProviderResourceReader(client);
      const selected = {
        ...query,
        executionSpaceId,
        caseId,
        repositoryVersion: r1,
        modelDigest: digest1,
      };
      const r1result = await reader.read(selected);
      assert.equal(r1result.calls, 2);
      assert.equal(r1result.units.input_tokens.observedSubtotal, 10);
      assert.equal(r1result.retainedPopulation, "complete");
      assert.equal(r1result.physicalCallCoverage, "unknown");
      const old = await reader.read({
        ...selected,
        repositoryVersion: r0,
        modelDigest: digest0,
      });
      assert.equal(old.calls, 1);
      assert.equal(old.units.input_tokens.observedSubtotal, 11);
      const sameDigest = await reader.read({
        ...selected,
        repositoryVersion: sameDigestOtherVersion,
      });
      assert.equal(sameDigest.calls, 1);
      assert.equal(sameDigest.units.input_tokens.observedSubtotal, 99);
      assert.deepEqual(
        await client.providerCallObservation.findUniqueOrThrow({
          where: {
            projectId_systemId_observationId: {
              ...host,
              observationId: r0call.observationId,
            },
          },
        }),
        originalR0,
      );
    });
  },
});
