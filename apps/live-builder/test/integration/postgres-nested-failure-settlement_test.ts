/** Real queue, canonical history, native graph, saver and ledger. The failing
 * primitive is controlled; no Toolkit, provider or external tool is invoked. */
import assert from "node:assert/strict";
import type {
  NativeExecutionHandlers,
  NativeExecutionRequest,
} from "../../src/application/work/runtime/execution.ts";
import { nativeExecutionIdentity } from "../../src/application/work/runtime/execution.ts";
import { immutableConsultationFixture } from "../support/immutable-consultation-fixture.ts";
import { openPostgresExecutionFixtureHost } from "../support/postgres-runtime-fixture.ts";
import { postgresTestEnabled } from "../support/postgres.ts";

Deno.test({
  name:
    "PG nested native failure settles its contribution as uncertain without replaying the unknown effect",
  ignore: !postgresTestEnabled,
  async fn() {
    const fixture = immutableConsultationFixture();
    const host = await openPostgresExecutionFixtureHost({
      scope: {
        projectId: fixture.model.identity.projectId,
        systemId: "nested-failure-settlement-host",
      },
    });
    try {
      const storage = await host.storage.operator(
        fixture.model.identity.builderId,
      );
      await storage.state.save(fixture.state, null);
      const child: NativeExecutionRequest = {
        ...fixture.request,
        identity: nativeExecutionIdentity(
          fixture.state,
          "promotion",
          "nested-failure",
        ),
        contribution: { id: "nested-promotion-input", kind: "input" },
        flow: fixture.model.flows.promotion,
        maxSteps: fixture.model.policy.maxFlowSteps,
      };
      const delivery = {
        id: "parent-handles-native-failure",
        identity: fixture.request.identity,
        kind: "contribution" as const,
        modelPin: {
          modelDigest: fixture.model.version.digest,
          repositoryVersion: fixture.model.version.repositoryVersion,
        },
      };
      let operations = 0;
      let handled = 0;
      const failure = new Error("controlled nested primitive failure");
      const handlers: NativeExecutionHandlers = {
        assertBoundary: () => Promise.resolve(),
        onEvent: () => Promise.resolve(),
        handle(node) {
          assert.equal(node.mechanism, "propose_candidate");
          operations++;
          return Promise.reject(failure);
        },
      };
      await host.start(async () => {
        // The parent handles the business failure. Its returned command can
        // settle, while the nested native effect must remain explicitly unknown.
        await assert.rejects(
          () => host.native.execution.run(child, handlers),
          (error: unknown) =>
            error instanceof Error && error.message === failure.message,
        );
        await assert.rejects(
          () => host.native.execution.run(child, handlers),
          /EXECUTION_EFFECT_UNKNOWN/,
        );
        handled++;
      });
      const accepted = await host.native.dispatch.enqueue(delivery);
      // Before the correction the orphaned nested `running` receipt keeps this
      // real fixture drain pending even after the queue handler has returned.
      await host.idle(undefined, 10000);
      assert.equal(handled, 1);
      assert.equal(operations, 1);
      const scope = {
        ...host.storage.scope,
        executionSpaceId: host.storage.executionSpaceId,
        operatorId: fixture.model.identity.builderId,
      };
      const parent = await host.native.dispatch.inspect(
        delivery.identity,
        delivery.id,
      );
      assert.equal(parent?.status, "completed");
      const nested = await host.database.client.executionContribution
        .findFirstOrThrow({
          where: { ...scope, contributionId: child.contribution.id },
        });
      assert.equal(nested.status, "uncertain");
      assert.equal(nested.completedAt, null);
      assert(nested.runId);
      const run = await host.database.client.executionRun.findFirstOrThrow({
        where: { ...scope, threadId: nested.threadId, runId: nested.runId },
      });
      assert.equal(run.status, "uncertain");
      const effects = await host.database.client.executionEffect.findMany({
        where: { ...scope, threadId: nested.threadId },
      });
      assert.equal(effects.length, 1);
      assert.equal(effects[0].status, "unknown");
      assert.equal(effects[0].resultJson, null);
      assert.equal(
        await host.database.client.executionContribution.count({
          where: { ...scope, status: { in: ["queued", "running"] } },
        }),
        0,
      );
      // A completed parent replay is its existing queue receipt, never another
      // attempt at the unknown nested primitive.
      const replay = await host.native.dispatch.enqueue(delivery);
      assert.equal(replay.id, accepted.id);
      assert.equal(replay.jobId, accepted.jobId);
      assert.equal(replay.status, "completed");
      await host.idle(undefined, 10000);
      assert.equal(handled, 1);
      assert.equal(operations, 1);
      assert.deepEqual(
        await host.database.client.executionEffect.findMany({
          where: { ...scope, threadId: nested.threadId },
        }),
        effects,
      );
    } finally {
      await host.close();
    }
  },
});
