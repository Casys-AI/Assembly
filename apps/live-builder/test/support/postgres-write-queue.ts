import { PostgresModelWriteQueue } from "../../src/adapters/model/repository/writing/postgres-write-queue.ts";
import { repositoryWriterLock } from "../../src/adapters/out/git/writer-lock.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { materialize } from "../../src/adapters/model/builds/materialization/artifact.ts";
import type {
  SettleOutcome,
  WriteLease,
} from "../../src/application/model/publication/ports/out/model-write-queue.port.ts";
import { ModelWriteWorker } from "../../src/application/model/publication/write-queue.ts";
import { createPostgresClient } from "../../src/adapters/out/postgres/client.ts";
import { postgresClientConfiguration } from "../../src/adapters/out/postgres/config.ts";

export const queueTestScope = {
  projectId: "pg3-project",
  systemId: "pg3-system",
};
export const queueTestRecipe = "b".repeat(64);
export const queueTestCompiler = {
  compile: (sources: Readonly<Record<string, string>>) =>
    materialize([], sources, "pg3-fixture"),
  recipe: () => Promise.reject(new Error("Fixture uses legacy snapshots")),
};
export const unusedPublication = {
  prepare: () => Promise.reject(new Error("accept-proposal does not prepare")),
  publish: () => Promise.reject(new Error("accept-proposal uses repository")),
};

/** A real child process used only by PG-3 integration tests. Connection
 * material arrives through the host environment, never arguments or output. */
if (import.meta.main) {
  const [mode, schema, projectDir, repositoryId, marker] = Deno.args;
  const client = createPostgresClient(postgresClientConfiguration(
    Deno.env.get("ASSEMBLY_POSTGRES_TEST_URL"),
    2,
    schema,
  ));
  let repository: GitModelRepository;
  const lock = () => repositoryWriterLock(repository.stateDir);
  class StopBeforeSettleQueue extends PostgresModelWriteQueue {
    override async settle(lease: WriteLease, outcome: SettleOutcome) {
      if (mode === "crash" && outcome.status === "published") {
        await Deno.writeTextFile(marker, outcome.version);
        // Parent kills this real process after checking the durable Git anchor.
        await new Promise(() => setInterval(() => {}, 1000));
      }
      return await super.settle(lease, outcome);
    }
  }
  const queue = new StopBeforeSettleQueue({
    client,
    scope: queueTestScope,
    writerLock: lock,
  });
  try {
    repository = await GitModelRepository.open({
      projectDir,
      compiler: queueTestCompiler,
      writeFence: {
        assertCurrent: (fence) => queue.heartbeat(fence, 30_000),
        guard: (fence, operation) =>
          queue.guardPublication(fence, 30_000, operation),
      },
    });
    if (mode === "claim") {
      const acquired = await queue.acquire(
        repositoryId,
        `child-${Deno.pid}`,
        30_000,
      );
      await Deno.writeTextFile(marker, JSON.stringify(acquired?.lease ?? null));
    } else {
      const worker = new ModelWriteWorker({
        queue,
        repository,
        publication: unusedPublication,
        owner: `child-${Deno.pid}`,
        recipeDigest: () => Promise.resolve(queueTestRecipe),
      });
      const result = await worker.runOnce(repositoryId);
      throw new Error(
        `Child should stop before SQL settlement: ${result.status}`,
      );
    }
  } finally {
    await client.$disconnect();
  }
}
