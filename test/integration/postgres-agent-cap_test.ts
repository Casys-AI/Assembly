import assert from "node:assert/strict";
import type {
  OperatorDeliveryReceipt,
  OperatorExecutionDelivery,
} from "../../src/application/work/operators/execution.ts";
import { openPostgresDurableRecoveryHost } from "../support/postgres-runtime-fixture.ts";
import { eventually } from "../support/eventually.ts";
import { postgresTestEnabled } from "../support/postgres.ts";

function delivery(
  operatorId: string,
  kind: OperatorExecutionDelivery["kind"] = "contribution",
): OperatorExecutionDelivery {
  return {
    id: crypto.randomUUID(),
    kind,
    identity: {
      operatorId,
      invocationKey: "local:turn",
      purpose: "conversation",
      scope: { kind: "request", scopeId: "case", rootRequestId: "case" },
    },
    modelPin: { modelDigest: "a".repeat(64) },
    payload: { text: "Dispatch capacity witness; no provider or native model" },
  };
}

Deno.test({
  name:
    "E7 PG: sixteen blocked ordinary deliveries queue the seventeenth while every Main delivery kind runs",
  ignore: !postgresTestEnabled,
  async fn() {
    const host = await openPostgresDurableRecoveryHost({
      scope: { projectId: "git:agent-cap", systemId: "agent-cap" },
      primaryOperatorId: "primary",
    });
    const started = new Set<string>();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => release = resolve);
    try {
      const session = await host.openSession();
      const dispatch = session.native.dispatch;
      const ordinary = Array.from(
        { length: 17 },
        (_, i) => delivery(`ordinary-${i}`),
      );
      for (const input of [...ordinary, delivery("primary")]) {
        await session.storage.operator(input.identity.operatorId);
      }
      await session.start(async (input) => {
        started.add(input.id);
        if (ordinary.slice(0, 16).some((item) => item.id === input.id)) {
          await blocked;
        }
      });
      for (const input of ordinary.slice(0, 16)) await dispatch.enqueue(input);
      await eventually(() => started.size === 16 ? true : undefined, {
        label: "all sixteen ordinary workers blocked in handlers",
        diagnose: () => [...started],
      });
      const overflow = ordinary[16];
      const receipt = await dispatch.enqueue(overflow);
      assert.equal(receipt.status, "queued");
      for (
        const kind of [
          "contribution",
          "continuation",
          "notification",
          "command",
          "schedule",
        ] as const
      ) {
        const main = delivery("primary", kind);
        await dispatch.enqueue(main);
        await eventually(
          async () =>
            (await dispatch.inspect(main.identity, main.id))?.status ===
                "completed"
              ? true
              : undefined,
          {
            label:
              `reserved Main worker completes ${kind} while ordinary workers are blocked`,
          },
        );
      }
      assert.equal(started.has(overflow.id), false);
      assert.equal(
        (await dispatch.inspect(overflow.identity, overflow.id))?.status,
        "queued",
      );
      const [job] = await dispatch.boss.findJobs(
        session.native.ledger.options.queueName,
        { id: receipt.jobId },
      );
      assert.equal(job.id, receipt.jobId);
      assert.equal(job.state, "created");
      assert.equal(job.priority, 0);
      release();
      await session.idle(undefined, 30_000);
      assert.equal(started.size, 22);
      for (const input of ordinary) {
        assert.equal(
          (await dispatch.inspect(input.identity, input.id))?.status,
          "completed",
        );
      }
    } finally {
      release();
      await host.close();
    }
  },
});

Deno.test({
  name:
    "E7 PG: restart retains an unstarted ordinary job and a legacy priority-zero Main job without reclassification",
  ignore: !postgresTestEnabled,
  async fn() {
    const host = await openPostgresDurableRecoveryHost({
      scope: {
        projectId: "git:agent-cap-restart",
        systemId: "agent-cap-restart",
      },
      primaryOperatorId: "primary",
    });
    try {
      const first = await host.openSession();
      const inputs = [
        delivery("ordinary"),
        delivery("primary", "continuation"),
      ];
      const receipts: OperatorDeliveryReceipt[] = [];
      for (const input of inputs) {
        await first.storage.operator(input.identity.operatorId);
        receipts.push(await first.native.dispatch.enqueue(input));
      }
      // Reproduce a Main job accepted before lane priorities existed. Its bytes
      // and receipt stay unchanged, only its historical queue priority is zero.
      const legacy = receipts[1];
      await first.storage.client.$executeRawUnsafe(
        `UPDATE "${host.schemas.queueSchema}".job SET priority=0 WHERE id=$1::uuid AND name=$2`,
        legacy.jobId,
        first.native.ledger.options.queueName,
      );
      await first.stop();
      const successor = await host.openSession();
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        assert.deepEqual(
          await successor.native.dispatch.inspect(input.identity, input.id),
          receipts[i],
        );
        const [job] = await successor.native.dispatch.boss.findJobs(
          successor.native.ledger.options.queueName,
          { id: receipts[i].jobId },
        );
        assert.equal(job.state, "created");
        assert.equal(job.priority, 0);
      }
      const started: string[] = [];
      await successor.start((input) => {
        started.push(input.id);
        return Promise.resolve();
      });
      await successor.idle(undefined, 30_000);
      assert.deepEqual(
        started.toSorted(),
        inputs.map((input) => input.id).toSorted(),
      );
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        const receipt = await successor.native.dispatch.inspect(
          input.identity,
          input.id,
        );
        assert.equal(receipt?.jobId, receipts[i].jobId);
        assert.equal(receipt.status, "completed");
      }
    } finally {
      await host.close();
    }
  },
});
