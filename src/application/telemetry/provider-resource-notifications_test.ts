import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  createRetainedProviderCallSink,
  isProviderResourceInvalidation,
  PROVIDER_RESOURCE_INVALIDATION,
} from "./provider-resource-notifications.ts";
import {
  normalizeProviderCallObservation,
  UNKNOWN_PROVIDER_CALL_CORRELATION,
} from "./provider-call.ts";

const observation = normalizeProviderCallObservation({
  schemaVersion: 1,
  observationId: "a6609ebc-6218-4d71-a2ae-893b875b8482",
  provider: "anthropic",
  configuredModel: "sonnet",
  startedAt: "2026-10-29T00:00:00.000Z",
  endedAt: "2026-10-29T00:00:00.005Z",
  elapsedMs: 5,
  outcome: "returned",
  correlation: UNKNOWN_PROVIDER_CALL_CORRELATION,
});
const scope = { projectId: "project", systemId: "system" };

Deno.test("retained-call sink notifies only after inserted append settles", async () => {
  const commit = Promise.withResolvers<"inserted" | "duplicate">();
  const seen: string[] = [];
  const sink = createRetainedProviderCallSink(
    {
      append(host, value) {
        deepStrictEqual(host, scope);
        equal(value, observation);
        seen.push("append");
        return commit.promise;
      },
    },
    () => scope,
    () => seen.push("notify"),
  );
  const pending = sink(observation);
  deepStrictEqual(seen, ["append"]);
  commit.resolve("inserted");
  await pending;
  deepStrictEqual(seen, ["append", "notify"]);
});

Deno.test("duplicate and rejected appends never notify; notification failure does not fail retention", async () => {
  let notified = 0;
  const notify = () => {
    notified++;
  };
  await createRetainedProviderCallSink(
    {
      append: () => Promise.resolve("duplicate"),
    },
    () => scope,
    notify,
  )(observation);
  await rejects(
    createRetainedProviderCallSink(
      {
        append: () => Promise.reject(new Error("append failed")),
      },
      () => scope,
      notify,
    )(observation),
    /append failed/,
  );
  equal(notified, 0);
  await createRetainedProviderCallSink(
    {
      append: () => Promise.resolve("inserted"),
    },
    () => scope,
    () => {
      throw new Error("stream closed");
    },
  )(observation);
});

Deno.test("resource invalidation accepts only the content-free versioned envelope", () => {
  deepStrictEqual(PROVIDER_RESOURCE_INVALIDATION, { schemaVersion: 1 });
  equal(isProviderResourceInvalidation(PROVIDER_RESOURCE_INVALIDATION), true);
  for (
    const value of [null, [], {}, { schemaVersion: 2 }, {
      schemaVersion: 1,
      caseId: "private",
    }, { schemaVersion: 1, calls: 7 }]
  ) {
    equal(isProviderResourceInvalidation(value), false);
  }
});

Deno.test("retained-call sink construction leaves unregistered host scope inert", async () => {
  let registered = false;
  let scopeReads = 0;
  const sink = createRetainedProviderCallSink({
    append(host) {
      deepStrictEqual(host, scope);
      return Promise.resolve("inserted");
    },
  }, () => {
    scopeReads++;
    if (!registered) throw new Error("host not registered");
    return scope;
  }, () => {});
  equal(scopeReads, 0);
  registered = true;
  await sink(observation);
  equal(scopeReads, 1);
});
