import assert from "node:assert/strict";
import {
  requestControlBinding,
  requestControlState,
  spaceControlAuthority,
} from "../../../../test/support/request-space-fixture.ts";
import type { SystemRuntimeState } from "../../../application/work/runtime/state.ts";
import type { Prisma, PrismaClient } from "./client.ts";
import { registerPostgresClientSchema } from "./client-schema.ts";
import { PostgresPrimarySpaceControlSource } from "./primary-space-control-source.ts";
import {
  encodeRuntimeSnapshotPayload,
  RUNTIME_SNAPSHOT_HEADER_CHARS,
  RUNTIME_SNAPSHOT_PREFIX,
} from "./runtime-snapshot-codec.ts";

/** Large enough for the codec to frame it, as a real PRIMARY state is. */
function stored(state: SystemRuntimeState, encode = true) {
  if (encode) {
    state.events = [{ label: "padding", detail: "x".repeat(20_000) }] as never;
  }
  const json = JSON.stringify(state);
  const payload = encode ? encodeRuntimeSnapshotPayload(json) : json;
  assert.equal(payload.startsWith(RUNTIME_SNAPSHOT_PREFIX), encode);
  return { revision: BigInt(state.revision), payload };
}

/** One fenced PRIMARY row; counts the narrow probe and the full row read. */
function fixture(initial: { revision: bigint; payload: string }) {
  let row: typeof initial | null = initial;
  const calls = { fence: 0, probe: 0, full: 0 };
  const client = {} as PrismaClient;
  registerPostgresClientSchema(client, "public");
  const tx = {
    $queryRaw(sql: Prisma.Sql) {
      if (sql.sql.includes("FOR SHARE")) {
        calls.fence++;
        return Promise.resolve([{ operatorId: "operator" }]);
      }
      assert.match(sql.sql, /substr\("payload", 1, (\?|\$\d+)::integer\)/);
      assert.equal(sql.values.includes(RUNTIME_SNAPSHOT_HEADER_CHARS), true);
      calls.probe++;
      return Promise.resolve(
        row
          ? [{
            revision: row.revision,
            header: row.payload.slice(0, RUNTIME_SNAPSHOT_HEADER_CHARS),
          }]
          : [],
      );
    },
    runtimeState: {
      findFirst() {
        calls.full++;
        return Promise.resolve(row && { ...row });
      },
    },
  } as unknown as Prisma.TransactionClient;
  const primary = new PostgresPrimarySpaceControlSource(client, {
    ...requestControlBinding,
    primaryOperatorId: "operator",
  });
  return {
    calls,
    read: () => primary.readLocked(tx),
    replace(next: { revision: bigint; payload: string } | null) {
      row = next;
    },
  };
}

Deno.test("PRIMARY control reuses its decode while the fenced revision and header stay equal", async () => {
  const f = fixture(stored(requestControlState()));
  const first = await f.read();
  assert.deepEqual(f.calls, { fence: 1, probe: 0, full: 1 });
  const second = await f.read();
  assert.deepEqual(f.calls, { fence: 2, probe: 1, full: 1 });
  assert.deepEqual(second, first);
  assert.equal(second.adoptedState.revision, 0);
  assert.equal(second.adoptedState.stateId, "primary-runtime");
  // Each caller owns its copy; the remembered source is never shared.
  first.source!.policy.operatorIds.push("intruder");
  assert.deepEqual((await f.read()).source, second.source);
  assert.deepEqual(f.calls, { fence: 3, probe: 2, full: 1 });
  // A row that disappears behind a remembered key is refused as before.
  f.replace(null);
  await assert.rejects(f.read, /unavailable/);
  assert.deepEqual(f.calls, { fence: 4, probe: 3, full: 1 });
});

Deno.test("PRIMARY control decodes again when the revision or the content header changes", async () => {
  const f = fixture(stored(requestControlState()));
  await f.read();
  const advanced = spaceControlAuthority();
  advanced.sourceVersion = `commit:${"e".repeat(40)}`;
  advanced.modelDigest = "e".repeat(64);
  f.replace(stored(requestControlState(advanced, 1)));
  const next = await f.read();
  assert.deepEqual(f.calls, { fence: 2, probe: 1, full: 2 });
  assert.equal(next.adoptedState.revision, 1);
  assert.equal(next.source!.sourceVersion, advanced.sourceVersion);
  // Same revision, other content: its SHA-256 header differs.
  const disabled = requestControlState(advanced, 1);
  disabled.executionModel!.spaceControlPolicy!.enabled = false;
  f.replace(stored(disabled));
  assert.equal((await f.read()).source!.policy.enabled, false);
  assert.deepEqual(f.calls, { fence: 3, probe: 2, full: 3 });
});

Deno.test("PRIMARY control keeps the full read for plain payloads and never remembers a failure", async () => {
  const plain = fixture(stored(requestControlState(), false));
  await plain.read();
  await plain.read();
  assert.deepEqual(plain.calls, { fence: 2, probe: 0, full: 2 });

  const foreign = requestControlState();
  foreign.executionModel!.identity.builderId = "another-operator";
  const f = fixture(stored(foreign));
  await assert.rejects(f.read, /unavailable/);
  await assert.rejects(f.read, /unavailable/);
  assert.deepEqual(f.calls, { fence: 2, probe: 0, full: 2 });
  f.replace(stored(requestControlState()));
  await f.read();
  const corrupt = stored(requestControlState());
  f.replace({
    revision: corrupt.revision,
    payload: `${corrupt.payload.slice(0, -8)}AAAAAAAA`,
  });
  // Same revision, same header, damaged body: the remembered decode is the
  // verified content of that key; the next changed key decodes and refuses.
  assert.equal((await f.read()).adoptedState.revision, 0);
  f.replace({
    revision: 1n,
    payload: corrupt.payload.slice(0, -8) + "AAAAAAAA",
  });
  await assert.rejects(f.read, /corrupt|revision/);
  await assert.rejects(f.read, /corrupt|revision/);
  assert.equal(f.calls.full, 5);
});
