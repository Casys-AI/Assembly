// deno-lint-ignore-file require-await -- Async port doubles preserve promise failure contracts.
import assert from "node:assert/strict";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { parseModelRevisionRef } from "../../src/domain/model/value-objects/element-ref.ts";
import { buildOperationJournal } from "../../src/domain/model/editing/write-command.ts";
import type { PendingChange } from "../../src/domain/governance/records/pending-change.ts";
import type { ModelCompiler } from "../../src/application/model/builds/ports/out/model-compiler.port.ts";
import type { ModelRevision } from "../../src/domain/model/records/revision.ts";
import {
  buildApprovedChangeCommand,
  type ModelWriteWorker,
} from "../../src/application/model/publication/write-queue.ts";
import { QueuedModelWriter } from "../../src/application/model/publication/queued-writer.ts";
import { PostgresModelWriteQueue } from "../../src/adapters/model/repository/writing/postgres-write-queue.ts";
import { repositoryWriterLock } from "../../src/adapters/out/git/writer-lock.ts";
import {
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";

const repositoryId = "44444444-4444-4444-8444-444444444444";
const baseVersion = "commit:" + "1".repeat(40);
const publishedVersion = "commit:" + "2".repeat(40);
const digest = (character: string) => character.repeat(64);

async function dossierFor(commandId: string) {
  const pin = {
    digest: "base-model",
    repositoryVersion: baseVersion,
    rootId: "root",
    configurationId: "configuration",
    configurationRevision: 0,
    sourceIds: ["source"],
  };
  const change: PendingChange = {
    id: commandId,
    kind: "mandate-change",
    status: "approved",
    baseRevision: 0,
    baseModelDigest: pin.digest,
    requestedAt: "now",
    decidedAt: "later",
    reason: "Exact extension",
    authorityExercise: exerciseOwnerAuthority(
      { identity: { systemId: "system" }, version: pin },
      "mandate-change",
    ),
  };
  return await buildApprovedChangeCommand({
    repositoryId,
    change,
    pin,
    journal: buildOperationJournal({
      base: parseModelRevisionRef({ repositoryId, version: baseVersion }),
      baseSourceDigest: digest("a"),
      edits: [{
        op: "setFeatureValue",
        target: {
          id: "el-1",
          qualifiedName: "Sys::a",
          metaclass: "PartUsage",
          preimage: digest("b"),
        },
        value: "x",
        format: 1,
      }],
    }),
    recipeDigest: digest("c"),
  });
}

function writer(
  queue: PostgresModelWriteQueue,
  observed: string[],
): QueuedModelWriter {
  const worker = {
    async runOnce() {
      const acquired = await queue.acquire(repositoryId, "worker", 60_000);
      if (!acquired) return { status: "idle" as const };
      const stored = await queue.getDossier(
        repositoryId,
        acquired.lease.commandId,
      );
      assert.deepStrictEqual(stored, acquired.dossier);
      observed.push(acquired.lease.commandId);
      await queue.transition(acquired.lease, "prepared");
      await queue.transition(acquired.lease, "publishing");
      await queue.settle(acquired.lease, {
        status: "published",
        version: publishedVersion,
      });
      return {
        status: "published" as const,
        commandId: acquired.lease.commandId,
        version: publishedVersion,
        already: false,
      };
    },
  } as unknown as ModelWriteWorker;
  return new QueuedModelWriter(
    repositoryId,
    queue,
    worker,
    {
      recipe: async () => {
        throw new Error("not used");
      },
      compile: async () => {
        throw new Error("not used");
      },
    } satisfies ModelCompiler,
    { at: async (version) => ({ version } as ModelRevision) },
  );
}

Deno.test({
  name:
    "queued writer persists before execution, resumes the stored PostgreSQL dossier, and closes",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      const scope = {
        projectId: "queued-writer-project",
        systemId: "queued-writer-system",
        executionSpaceId: "main",
        operatorId: "owner",
      };
      await seedPostgresRuntime(client, scope);
      await client.sourceRepository.create({
        data: {
          projectId: scope.projectId,
          systemId: scope.systemId,
          repositoryId,
          sourceScopeId: "queued-writer-source",
        },
      });
      const dir = await Deno.makeTempDir({ prefix: "queued-writer-lock-" });
      let activeWriter: QueuedModelWriter | undefined;
      try {
        const lock = await repositoryWriterLock(dir);
        const options = {
          client,
          scope,
          writerLock: () => Promise.resolve(lock),
        };
        let queue = new PostgresModelWriteQueue(options);
        const firstId = "11111111-1111-4111-8111-111111111111";
        const secondId = "22222222-2222-4222-8222-222222222222";
        const observed: string[] = [];
        const firstWriter = writer(queue, observed);
        activeWriter = firstWriter;
        const first = await dossierFor(firstId);
        assert.equal(
          (await firstWriter.publish(first)).version,
          publishedVersion,
        );
        assert.deepStrictEqual(observed, [firstId]);
        await firstWriter.close();
        await assert.rejects(() => firstWriter.publish(first), /closed/);

        // A fresh PostgreSQL client sees the original persisted dossier after
        // the first client closes; no caller reconstructs the approved journal.
        const second = await dossierFor(secondId);
        await queue.enqueue(second);
        await client.$disconnect();
        queue = new PostgresModelWriteQueue({
          ...options,
          client: createClient(),
        });
        const resumed = writer(queue, observed);
        activeWriter = resumed;
        assert.deepStrictEqual(
          await queue.getDossier(repositoryId, secondId),
          second,
        );
        assert.equal(second.decision.kind, "approved-change");
        if (second.decision.kind === "approved-change") {
          const originalApproval = second.decision.approval;
          await assert.rejects(
            () =>
              resumed.resume(secondId, {
                ...originalApproval,
                decidedAt: "forged",
              }),
            /Original approval differs/,
          );
          assert.deepStrictEqual(observed, [firstId]);
          assert.equal(
            (await resumed.resume(secondId, originalApproval))?.version,
            publishedVersion,
          );
        }
        assert.deepStrictEqual(observed, [firstId, secondId]);
        resumed.start();
        await resumed.close();
      } finally {
        await activeWriter?.close();
        await Deno.remove(dir, { recursive: true });
      }
    });
  },
});
