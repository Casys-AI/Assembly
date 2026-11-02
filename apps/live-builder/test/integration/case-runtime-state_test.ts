import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { readCaseRuntimeState } from "../../src/adapters/out/postgres/case-runtime-state.ts";
import type { PrismaClient } from "../../src/adapters/out/postgres/client.ts";
import { requestControlState } from "../support/request-space-fixture.ts";
import { runtimeStateSummary } from "../../src/adapters/out/postgres/runtime-state-snapshot.ts";
import {
  encodeRuntimeSnapshotPayload,
  RUNTIME_SNAPSHOT_PREFIX,
} from "../../src/adapters/out/postgres/runtime-snapshot-codec.ts";

function fixture(framed = false) {
  const host = { projectId: "host-project", systemId: "host-system" };
  const seed = requestControlState();
  seed.id = "request:space:operator";
  // A real Case state is large enough for the codec to frame it.
  if (framed) {
    seed.events = [{ label: "padding", detail: "x".repeat(20_000) }] as never;
  }
  const json = JSON.stringify(seed);
  const payload = framed ? encodeRuntimeSnapshotPayload(json) : json;
  equal(payload.startsWith(RUNTIME_SNAPSHOT_PREFIX), framed);
  // Compare the exact persisted JSON representation, where undefined is absent.
  const state = JSON.parse(json) as typeof seed;
  const current = { revision: BigInt(state.revision), payload };
  const summary = runtimeStateSummary(state);
  let retained: unknown = {
    ...current,
    runtimeStateId: state.id,
    catalogRevision: BigInt(state.catalogRevision),
    eventCount: BigInt(state.events.length),
    modelPayload: JSON.stringify(state.model),
    ...summary,
    origin: "commit",
  };
  let space = {
    caseId: "caseA",
    parentExecutionSpaceId: "main",
    lifecycle: "active",
    closedAt: null as Date | null,
  };
  const reads: unknown[] = [], directives: string[] = [];
  const client = {
    $transaction: async (
      action: (tx: unknown) => Promise<unknown>,
      options: unknown,
    ) => {
      deepStrictEqual(options, { isolationLevel: "RepeatableRead" });
      return await action({
        $executeRaw: (sql: { strings: string[] }) => {
          directives.push(sql.strings.join(""));
          return Promise.resolve(0);
        },
        executionSpace: {
          findUnique: (input: unknown) => {
            reads.push(input);
            return Promise.resolve(space);
          },
        },
        runtimeState: {
          findFirst: (input: unknown) => {
            reads.push(input);
            return Promise.resolve(current);
          },
        },
        runtimeRevision: {
          findFirst: (input: unknown) => {
            reads.push(input);
            return Promise.resolve(retained);
          },
        },
        // No update/upsert/create methods: a write attempt is a failing witness.
      });
    },
  } as unknown as Pick<PrismaClient, "$transaction">;
  return {
    host,
    state,
    json,
    reads,
    directives,
    retainPayload(payload: string) {
      retained = { ...(retained as object), payload };
    },
    read: () =>
      readCaseRuntimeState(client, host, "space", "caseA", "operator"),
    close: () => {
      space = { ...space, lifecycle: "closed", closedAt: new Date() };
    },
    foreign: () => {
      space = { ...space, caseId: "caseB" };
    },
    missingHistory: () => {
      retained = null;
    },
  };
}
Deno.test("Case runtime adapter reads active and closed state without write or baseline creation", async () => {
  const f = fixture();
  deepStrictEqual(await f.read(), f.state);
  f.close();
  deepStrictEqual(await f.read(), f.state);
  deepStrictEqual(f.directives, [
    "SET TRANSACTION READ ONLY",
    "SET TRANSACTION READ ONLY",
  ]);
  deepStrictEqual(f.reads[1], {
    where: { ...f.host, executionSpaceId: "space", operatorId: "operator" },
  });
  equal(f.reads.length, 6);
});
Deno.test("Case runtime adapter refuses foreign Case and missing history without repair", async () => {
  const foreign = fixture();
  foreign.foreign();
  await rejects(foreign.read, /unavailable/);
  equal(foreign.reads.length, 1);
  const missing = fixture();
  missing.missingHistory();
  await rejects(missing.read, /history disagree/);
});
Deno.test("Case runtime adapter compares framed current and history by header and keeps refusing divergence", async () => {
  const framed = fixture(true);
  deepStrictEqual(await framed.read(), framed.state);
  // History stored as plain text with the same content still agrees.
  framed.retainPayload(framed.json);
  deepStrictEqual(await framed.read(), framed.state);
  const divergent = fixture(true);
  const other = JSON.parse(divergent.json);
  other.events[0].detail = "y".repeat(20_000);
  divergent.retainPayload(encodeRuntimeSnapshotPayload(JSON.stringify(other)));
  await rejects(divergent.read, /history disagree/);
});
