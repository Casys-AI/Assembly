import assert from "node:assert/strict";
import { SpaceControls } from "../../../application/work/request-spaces/control.ts";
import type {
  SpaceControlCredential,
  SpaceCredentialStorePort,
} from "../../../application/work/request-spaces/control-ports.ts";
import {
  requestControlAdoptedState,
  spaceControlAuthority,
  spaceUuid,
} from "../../../../test/support/request-space-fixture.ts";
import type { LocalCapabilityFile } from "./space-control-files.ts";
import {
  reportLocalControlCommand,
  runLocalControlCommand,
} from "./space-control-command.ts";

const privateSecret = "a".repeat(64);
function fixture(
  options: {
    commitThenReject?: boolean;
    outputCloseFails?: boolean;
    disconnectFails?: boolean;
  } = {},
) {
  const authority = spaceControlAuthority();
  const rows = new Map<string, SpaceControlCredential>();
  const calls = { save: 0, remove: 0, outputClose: 0, disconnect: 0 };
  let nextId = 0, nextSecret = 0;
  const store: SpaceCredentialStorePort = {
    insert(row) {
      rows.set(row.id, structuredClone(row));
      if (row.kind === "capability" && options.commitThenReject) {
        // Real service awaited a store operation whose commit was applied before
        // its acknowledgement was lost. It cannot return its receipt/secret.
        return Promise.reject(
          new Error(`driver acknowledgement lost: ${privateSecret}`),
        );
      }
      return Promise.resolve();
    },
    findHash: (hash) =>
      Promise.resolve(
        structuredClone(
          [...rows.values()].find((row) => row.secretHash === hash) ?? null,
        ),
      ),
    get: (id) => Promise.resolve(structuredClone(rows.get(id) ?? null)),
    revokeCapability(id, ownerId, expectedRevision) {
      const row = rows.get(id)!;
      assert.equal(row.ownerId, ownerId);
      assert.equal(row.revision, expectedRevision);
      row.status = "revoked";
      row.revision++;
      return Promise.resolve(structuredClone(row));
    },
  };
  const controls = new SpaceControls(
    store,
    {
      current: () => Promise.resolve(structuredClone(authority)),
      capture: () =>
        Promise.resolve({
          authority: structuredClone(authority),
          adoptedState: requestControlAdoptedState(),
        }),
    },
    { randomSecret: () => (++nextSecret === 1 ? "a" : "b").repeat(64) },
    () => Date.parse("2026-10-30T00:00:00Z"),
    () => spaceUuid(++nextId),
  );
  const profile = {
    scope: authority.scope,
    primaryOperatorId: "operator",
    origin: "http://127.0.0.1:4313",
  };
  let delivered: LocalCapabilityFile | undefined;
  const output = {
    path: "/owned-qualification/capability.json",
    save(file: LocalCapabilityFile) {
      calls.save++;
      delivered = structuredClone(file);
      return Promise.resolve();
    },
    removeOwned() {
      calls.remove++;
      return Promise.resolve();
    },
    close() {
      calls.outputClose++;
      return options.outputCloseFails
        ? Promise.reject(new Error(`private close error ${privateSecret}`))
        : Promise.resolve();
    },
  };
  const local = {
    controls,
    currentOwnerId: () => Promise.resolve("owner"),
    close() {
      calls.disconnect++;
      return options.disconnectFails
        ? Promise.reject(new Error(`private disconnect error ${privateSecret}`))
        : Promise.resolve();
    },
  };
  const presentation = (
    result: Parameters<typeof reportLocalControlCommand>[0],
  ) => {
    const info: string[] = [], error: string[] = [];
    const exitCode = reportLocalControlCommand(result, {
      info: (value) => info.push(value),
      error: (value) => error.push(value),
    });
    assert.equal(
      JSON.stringify({ result, info, error }).includes(privateSecret),
      false,
    );
    return { exitCode, info, error };
  };
  return {
    rows,
    calls,
    profile,
    output,
    local,
    delivered: () => delivered,
    presentation,
  };
}
Deno.test("local CLI reports issuance unconfirmed when the real service store commits then rejects", async () => {
  const f = fixture({ commitThenReject: true });
  const result = await runLocalControlCommand({
    action: "issue",
    profile: f.profile,
    output: f.output,
    open: () => Promise.resolve(f.local),
  });
  assert.deepEqual(result.outcome, {
    kind: "issuance-unconfirmed",
    reservedOutput: f.output.path,
  });
  assert.equal(f.rows.size, 1);
  assert.equal([...f.rows.values()][0].kind, "capability");
  assert.equal([...f.rows.values()][0].status, "active");
  assert.equal(f.calls.save, 0);
  assert.equal(f.calls.remove, 0);
  assert.equal(f.calls.outputClose, 1);
  assert.equal(f.calls.disconnect, 1);
  // No returned receipt means no invented credential identity or compensation.
  const printed = f.presentation(result);
  assert.equal(printed.exitCode, 1);
  assert.match(printed.error.join("\n"), /issuance is unconfirmed/);
  assert.match(printed.error.join("\n"), /Do not automatically retry/);
  assert.equal(printed.info.length, 0);
});
Deno.test("local CLI keeps confirmed issuance and private delivery successful when both cleanups fail", async () => {
  const f = fixture({ outputCloseFails: true, disconnectFails: true });
  const result = await runLocalControlCommand({
    action: "issue",
    profile: f.profile,
    output: f.output,
    open: () => Promise.resolve(f.local),
  });
  assert.equal(result.outcome.kind, "issued");
  assert.equal(f.delivered()!.credentialId, [...f.rows.values()][0].id);
  assert.equal([...f.rows.values()][0].status, "active");
  assert.equal(f.calls.save, 1);
  assert.equal(f.calls.remove, 0);
  assert.equal(f.calls.outputClose, 1);
  assert.equal(f.calls.disconnect, 1);
  assert.deepEqual(result.cleanupIssues, [
    "OUTPUT_CLOSE_FAILED",
    "CONTROL_DISCONNECT_FAILED",
  ]);
  const printed = f.presentation(result);
  assert.equal(printed.exitCode, 0);
  assert.match(printed.info[0], /Local capability file:/);
  assert.equal(printed.error.length, 2);
  assert.equal(
    printed.error.some((line) => /command failed|retry/i.test(line)),
    false,
  );
});
Deno.test("local CLI keeps actual revocation successful when disconnect fails", async () => {
  const f = fixture({ disconnectFails: true });
  const issued = await f.local.controls.issueCapability("owner");
  const stored: LocalCapabilityFile = {
    format: 1,
    ...f.profile.scope,
    origin: f.profile.origin,
    credentialId: issued.credentialId,
    expiresAt: issued.expiresAt,
    capabilitySecret: issued.secret,
  };
  const result = await runLocalControlCommand({
    action: "revoke",
    stored,
    open: () => Promise.resolve(f.local),
  });
  assert.deepEqual(result.outcome, {
    kind: "revoked",
    credentialId: issued.credentialId,
  });
  assert.equal(f.rows.get(issued.credentialId)!.status, "revoked");
  assert.equal(f.rows.get(issued.credentialId)!.revision, 1);
  assert.equal(f.calls.disconnect, 1);
  assert.deepEqual(result.cleanupIssues, ["CONTROL_DISCONNECT_FAILED"]);
  const printed = f.presentation(result);
  assert.equal(printed.exitCode, 0);
  assert.match(printed.info[0], /Local capability revoked:/);
  assert.equal(printed.error.length, 1);
  assert.equal(
    printed.error.some((line) => /command failed|retry/i.test(line)),
    false,
  );
});
Deno.test("local CLI distinguishes failure before issuance from an attempted uncertain mutation", async () => {
  const f = fixture();
  f.local.currentOwnerId = () =>
    Promise.reject(new Error(`owner read failed ${privateSecret}`));
  const result = await runLocalControlCommand({
    action: "issue",
    profile: f.profile,
    output: f.output,
    open: () => Promise.resolve(f.local),
  });
  assert.deepEqual(result.outcome, { kind: "failed-before-mutation" });
  assert.equal(f.rows.size, 0);
  assert.equal(f.calls.remove, 1);
  assert.equal(f.calls.outputClose, 1);
  assert.equal(f.calls.disconnect, 1);
  assert.equal(f.presentation(result).exitCode, 1);
});
