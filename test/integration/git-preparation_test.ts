import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { materialize } from "../../src/adapters/model/builds/materialization/artifact.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { ModelRepositoryError } from "../../src/application/model/repository.ts";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => release = resolve);
  return { promise, release };
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Latch did not progress")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Real Git snapshots, shared OS lock and journal; only compilation is controlled. */
async function fixture(preparationConcurrency?: number) {
  const projectDir = await Deno.makeTempDir({ prefix: "ase-preparation-" });
  const sources = { "a.sysml": "package A;\n", "b.sysml": "package B;\n" };
  let activeCompiles = 0, maximumCompiles = 0, compilationCount = 0;
  let compileHook = (_sources: Sources) => Promise.resolve();
  const options = {
    projectDir,
    preparationConcurrency,
    compiler: {
      async compile(input: Sources) {
        compilationCount++;
        activeCompiles++;
        maximumCompiles = Math.max(maximumCompiles, activeCompiles);
        try {
          await compileHook(input);
          return await materialize([], input, "preparation-test");
        } finally {
          activeCompiles--;
        }
      },
      recipe: () => {
        throw new Error("Fixture compiler reports no build recipe");
      },
    },
  };
  const repository = await GitModelRepository.open(options);
  const base = await repository.initialize(sources);
  const peer = await GitModelRepository.open({
    ...options,
    projectDir: `${projectDir}/.`,
  });
  return {
    repository,
    peer,
    base,
    sources,
    setCompileHook(hook: typeof compileHook) {
      compileHook = hook;
    },
    stats: () => ({ maximumCompiles, compilationCount }),
    propose: (owner: GitModelRepository, changed: Sources) =>
      owner.propose({
        baseVersion: base.version,
        sources: changed,
        author: "agent-test",
        reason: "Change exact sources",
      }),
    close: () => Deno.remove(projectDir, { recursive: true }),
  };
}

Deno.test("proposal preparation overlaps across repository instances with a shared bounded pool", async () => {
  const f = await fixture();
  const entered = latch(), release = latch();
  let started = 0;
  f.setCompileHook(async () => {
    if (++started === 2) entered.release();
    await release.promise;
  });
  const pending = [1, 2, 3].map((number) =>
    f.propose(number === 2 ? f.peer : f.repository, {
      ...f.sources,
      "a.sysml": `package A${number};\n`,
    })
  );
  try {
    await bounded(entered.promise);
    equal(started, 2);
    // The repository writer is available while preparations occupy the pool.
    const unchanged = await bounded(f.peer.updateSystemSources(
      (current) => current.sources,
      "host-noop",
    ));
    equal(unchanged.version, f.base.version);
    release.release();
    const records = await bounded(Promise.all(pending));
    equal(records.length, 3);
    equal(f.stats().maximumCompiles, 2);
    equal((await f.repository.current()).version, f.base.version);
  } finally {
    release.release();
    await Promise.allSettled(pending);
    await f.close();
  }
});

Deno.test("acceptance preparations overlap but only the exact current HEAD can publish", async () => {
  const f = await fixture();
  const proposals = await Promise.all([
    f.propose(f.repository, { ...f.sources, "a.sysml": "package ChangedA;\n" }),
    f.propose(f.peer, { ...f.sources, "b.sysml": "package ChangedB;\n" }),
  ]);
  const entered = latch(), release = latch();
  let started = 0;
  f.setCompileHook(async () => {
    if (++started === 2) entered.release();
    await release.promise;
  });
  const pending = proposals.map((proposal, index) =>
    (index ? f.peer : f.repository).accept({
      id: proposal.id,
      expectedVersion: f.base.version,
      author: "local-control",
    })
  );
  const outcomes = Promise.allSettled(pending);
  try {
    await bounded(entered.promise);
    release.release();
    const results = await bounded(outcomes);
    equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const loser = results.findIndex((result) => result.status === "rejected");
    const failure = (results[loser] as PromiseRejectedResult).reason;
    ok(failure instanceof ModelRepositoryError);
    equal(failure.code, "STALE_REVISION");
    deepStrictEqual(
      await f.repository.proposal(proposals[loser]!.id),
      proposals[loser],
    );
    equal((await f.repository.history()).commits.length, 2);
    f.setCompileHook(() => Promise.resolve());
    const winner = await f.repository.current();
    const merged = await f.peer.accept({
      id: proposals[loser]!.id,
      expectedVersion: winner.version,
      author: "local-control",
    });
    deepStrictEqual(merged.sources, {
      "a.sysml": "package ChangedA;\n",
      "b.sysml": "package ChangedB;\n",
    });
    const count = f.stats().compilationCount;
    equal(
      (await f.repository.accept({
        id: proposals[loser]!.id,
        expectedVersion: f.base.version,
        author: "local-control",
      })).version,
      merged.version,
    );
    equal(f.stats().compilationCount, count);
  } finally {
    release.release();
    await outcomes;
    await f.close();
  }
});

Deno.test("a rejection during acceptance preparation prevents publication", async () => {
  const f = await fixture();
  const proposal = await f.propose(f.repository, {
    ...f.sources,
    "a.sysml": "package ChangedA;\n",
  });
  const entered = latch(), release = latch();
  f.setCompileHook(async () => {
    entered.release();
    await release.promise;
  });
  const acceptance = f.repository.accept({
    id: proposal.id,
    expectedVersion: f.base.version,
    author: "local-control",
  });
  const outcome = Promise.allSettled([acceptance]);
  try {
    await bounded(entered.promise);
    await bounded(f.peer.reject({ id: proposal.id, author: "other-control" }));
    release.release();
    await rejects(
      () => acceptance,
      (error: unknown) =>
        error instanceof ModelRepositoryError &&
        error.code === "STALE_REVISION",
    );
    equal((await f.repository.current()).version, f.base.version);
    equal((await f.repository.proposal(proposal.id)).status, "rejected");
  } finally {
    release.release();
    await outcome;
    await f.close();
  }
});

Deno.test("a preparation releases its permit before waiting for a host writer", async () => {
  const f = await fixture(1);
  const entered = latch(), release = latch(), hostEntered = latch();
  let calls = 0;
  f.setCompileHook(async () => {
    if (++calls === 1) {
      entered.release();
      await release.promise;
    }
  });
  const proposal = f.propose(f.repository, {
    ...f.sources,
    "a.sysml": "package ChangedA;\n",
  });
  let host: ReturnType<GitModelRepository["updateSystemSources"]> | undefined;
  let callbacks = 0;
  try {
    await bounded(entered.promise);
    host = f.peer.updateSystemSources((current) => {
      callbacks++;
      hostEntered.release();
      return { ...current.sources, "b.sysml": "package HostChange;\n" };
    }, "host-test");
    await bounded(hostEntered.promise);
    release.release();
    const [, updated] = await bounded(Promise.all([proposal, host]));
    equal(callbacks, 1);
    equal(updated.sources["b.sysml"], "package HostChange;\n");
    equal(f.stats().maximumCompiles, 1);
  } finally {
    release.release();
    await Promise.allSettled([proposal, ...(host ? [host] : [])]);
    await f.close();
  }
});
