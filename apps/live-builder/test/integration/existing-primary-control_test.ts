import assert from "node:assert/strict";
import { existingPrimaryControl } from "../../src/adapters/out/postgres/existing-primary-control.ts";
import type { PrismaClient } from "../../src/adapters/out/postgres/client.ts";
import { registerPostgresClientSchema } from "../../src/adapters/out/postgres/client-schema.ts";
import { createRequestSpaceControls } from "../../src/composition/space-controls.ts";
import {
  requestControlState,
  requestSpaceScope as scope,
} from "../support/request-space-fixture.ts";

function fixture() {
  const state = requestControlState();
  let lifecycle = "active";
  let exists = true;
  let reads = 0;
  const calls: string[] = [];
  const tx = {
    $executeRaw(sql: { sql: string }) {
      assert.equal(sql.sql, "SET TRANSACTION READ ONLY");
      calls.push("read-only");
      return Promise.resolve(0);
    },
    $queryRaw() {
      calls.push("canonical-primary-lock");
      return Promise.resolve([{ operatorId: "operator" }]);
    },
    executionSpace: {
      findUnique({ where }: { where: unknown }) {
        assert.deepEqual(where, {
          projectId_systemId_executionSpaceId: {
            ...scope,
            executionSpaceId: "main",
          },
        });
        calls.push("existing-main");
        return Promise.resolve({
          lifecycle,
          parentExecutionSpaceId: null,
          caseId: null,
        });
      },
    },
    operatorRuntime: {
      findUnique() {
        calls.push("existing-operator");
        return Promise.resolve(exists ? {} : null);
      },
    },
    runtimeState: {
      findFirst({ where }: { where: unknown }) {
        assert.deepEqual(where, {
          ...scope,
          executionSpaceId: "main",
          operatorId: "operator",
        });
        reads++;
        return Promise.resolve({
          revision: BigInt(state.revision),
          payload: JSON.stringify(state),
        });
      },
    },
  };
  const client = {
    async $transaction<T>(
      run: (found: typeof tx) => Promise<T>,
      options?: unknown,
    ) {
      if (options) {
        assert.deepEqual(options, { isolationLevel: "RepeatableRead" });
      }
      return await run(tx);
    },
  } as unknown as PrismaClient;
  registerPostgresClientSchema(client, "local_control_test");
  return {
    client,
    state,
    calls,
    reads: () => reads,
    closeMain: () => lifecycle = "closed",
    missingOperator: () => exists = false,
  };
}
Deno.test("explicit local control reopens current PRIMARY without registration or runtime/source initialization", async () => {
  const f = fixture();
  const primary = await existingPrimaryControl(f.client, scope, "operator");
  assert.equal(
    primary.binding.sourceSystemNativeId,
    f.state.executionModel!.identity.systemId,
  );
  assert.notEqual(primary.binding.sourceSystemNativeId, scope.systemId);
  assert.equal(f.reads(), 2);
  assert.deepEqual(f.calls, [
    "read-only",
    "existing-main",
    "existing-operator",
    "canonical-primary-lock",
  ]);
  // The canonical modeled owner differs from the native runtime operator.
  const source = await primary.read();
  assert.equal(source!.owner.operatorId, "owner");
  const { controls } = createRequestSpaceControls({
    client: f.client,
    scope,
    primarySpaceControl: primary,
  });
  await assert.rejects(controls.issueCapability("operator"));
});
Deno.test("explicit local control refuses absent/closed Main and missing or changed canonical policy", async () => {
  const closed = fixture();
  closed.closeMain();
  await assert.rejects(
    existingPrimaryControl(closed.client, scope, "operator"),
  );
  const missing = fixture();
  missing.missingOperator();
  await assert.rejects(
    existingPrimaryControl(missing.client, scope, "operator"),
  );
  const noPolicy = fixture();
  delete noPolicy.state.executionModel!.spaceControlPolicy;
  await assert.rejects(
    existingPrimaryControl(noPolicy.client, scope, "operator"),
  );
  const changed = fixture();
  const primary = await existingPrimaryControl(
    changed.client,
    scope,
    "operator",
  );
  changed.state.executionModel!.spaceControlPolicy!.enabled = false;
  const { controls } = createRequestSpaceControls({
    client: changed.client,
    scope,
    primarySpaceControl: primary,
  });
  await assert.rejects(controls.issueCapability("owner"));
  changed.state.executionModel!.identity.systemId = "foreign-native-system";
  await assert.rejects(primary.read());
});
