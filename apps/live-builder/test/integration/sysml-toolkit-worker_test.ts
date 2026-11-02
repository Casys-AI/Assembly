import {
  deepEqual,
  equal,
  notEqual,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import {
  runSysmlToolkitWorker,
  SYSML_TOOLKIT_BOARD_EXECUTION_MS,
  SYSML_TOOLKIT_PROJECTION_EXECUTION_MS,
  SysmlToolkitTimeoutError,
} from "../../src/adapters/out/sysml-toolkit/worker-client.ts";
import {
  SYSML_TOOLKIT_VERSION,
  type ToolkitBundleProvenance,
} from "../../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { ToolkitModelBoardReader } from "../../src/adapters/model/projections/board-reader.ts";
import { ModelBoardService } from "../../src/application/model/projections/board.ts";
import { createModelBoardHandler } from "../../src/adapters/in/http/model/board.ts";
import type { ModelBoard } from "../../src/domain/model/records/board.ts";

const fixture = new URL(
  "../fixtures/sysml-toolkit-worker-fixture.ts",
  import.meta.url,
);
const sources = { "model.sysml": "package Demo;" };

interface WorkerState {
  workerId: string;
  calls: number;
  maximumActive: number;
  sources: Record<string, string>;
  operations: string[];
}

function state(
  packageDir: string,
  expression = "state",
  timeoutMs = 4000,
  input = sources,
): Promise<WorkerState> {
  return runSysmlToolkitWorker(
    packageDir,
    {
      operation: "query",
      sources: input,
      expression,
    },
    timeoutMs,
    fixture,
  );
}

Deno.test("toolkit deadline terminates a synchronously blocked fixture without blocking the host or the next call", async () => {
  const before = await state("unused");
  let hostTicks = 0;
  const timer = setInterval(() => hostTicks++, 10);
  let refused: unknown;
  try {
    await runSysmlToolkitWorker(
      "unused",
      {
        operation: "query",
        sources,
        expression: "spin-blocked",
      },
      1000,
      fixture,
    );
  } catch (error) {
    refused = error;
  } finally {
    clearInterval(timer);
  }
  ok(refused instanceof SysmlToolkitTimeoutError);
  equal(
    refused.started,
    true,
    "The worker entered its synchronous blocking loop",
  );
  ok(
    hostTicks > 0,
    "The host event loop stayed responsive while the fixture was blocked",
  );
  equal(
    await runSysmlToolkitWorker(
      "unused",
      {
        operation: "check",
        sources,
      },
      4000,
      fixture,
    ),
    "check",
  );
  notEqual((await state("unused")).workerId, before.workerId);
});

Deno.test("toolkit worker reuses its runtime and serializes independent request snapshots", async () => {
  const packageDir = crypto.randomUUID();
  const before = await state(packageDir);
  const mutable = { ...sources };
  const first = state(packageDir, "state:30");
  const second = state(packageDir, "state", 4000, mutable);
  mutable["model.sysml"] = "package Mutated;";
  const results = await Promise.all([first, second]);
  for (const result of results) {
    equal(result.workerId, before.workerId);
    equal(result.maximumActive, 1);
    deepEqual(result.sources, sources);
  }
  deepEqual(results.map((result) => result.calls), [2, 3]);
});

Deno.test("toolkit queued operations expire without running or interrupting the active worker", async () => {
  const packageDir = crypto.randomUUID();
  const before = await state(packageDir);
  let activeFinished = false;
  const active = state(packageDir, "state:300").then((result) => {
    activeFinished = true;
    return result;
  });
  const queued = state(packageDir, "state", 100);
  const expired = rejects(queued, (error) => {
    ok(error instanceof SysmlToolkitTimeoutError);
    equal(error.timeoutMs, 100);
    equal(error.started, false);
    equal(
      activeFinished,
      false,
      "The queued call times out while its peer is still active",
    );
    return true;
  });
  const [result] = await Promise.all([active, expired]);
  equal(result.workerId, before.workerId);
  equal(result.calls, 2);
  const after = await state(packageDir);
  equal(after.workerId, before.workerId);
  equal(after.calls, 3, "The expired request was removed from the queue");
});

Deno.test({
  name:
    "production toolkit retries its first bundle pin after it expires in the queue",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "ase-toolkit-queued-pin-" });
    try {
      const packageDir = `${root}/selected`;
      await Deno.symlink(
        await Deno.realPath(Deno.env.get("SYSML_TOOLKIT_DIR")!),
        packageDir,
      );
      const blockerKey = crypto.randomUUID();
      await state(blockerKey);
      let activeFinished = false;
      const active = state(blockerKey, "state:300").then(() => {
        activeFinished = true;
      });
      // Only the queue blocker uses the fixture. Both pin attempts below use
      // the production worker and its startupBundles cache with a real SDK.
      const expired = rejects(
        runSysmlToolkitWorker(packageDir, { operation: "provenance" }, 50),
        (error) => {
          ok(error instanceof SysmlToolkitTimeoutError);
          equal(error.timeoutMs, 50);
          equal(error.started, false);
          equal(activeFinished, false);
          return true;
        },
      );
      await Promise.all([active, expired]);
      const retried = await runSysmlToolkitWorker<ToolkitBundleProvenance>(
        packageDir,
        { operation: "provenance" },
        15_000,
      );
      equal(retried.version, SYSML_TOOLKIT_VERSION);
      ok(retried.digest.length > 0);
      deepEqual(
        await runSysmlToolkitWorker(packageDir, {
          operation: "check",
          sources,
        }),
        [],
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "production toolkit retries its first bundle pin after a loading failure",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "ase-toolkit-retry-pin-" });
    try {
      const packageDir = `${root}/selected`;
      await rejects(
        () => runSysmlToolkitWorker(packageDir, { operation: "provenance" }),
        { name: "SysmlToolkitWorkerError" },
      );
      await Deno.symlink(
        await Deno.realPath(Deno.env.get("SYSML_TOOLKIT_DIR")!),
        packageDir,
      );
      const retried = await runSysmlToolkitWorker<ToolkitBundleProvenance>(
        packageDir,
        { operation: "provenance" },
      );
      equal(retried.version, SYSML_TOOLKIT_VERSION);
      ok(retried.digest.length > 0);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("toolkit execution consumes only the budget remaining after queueing", async () => {
  const packageDir = crypto.randomUUID();
  const before = await state(packageDir);
  const active = state(packageDir, "state:300");
  // Each phase fits separately, but their combined duration exceeds the budget.
  const queued = state(packageDir, "state:400", 500);
  const expired = rejects(queued, (error) => {
    ok(error instanceof SysmlToolkitTimeoutError);
    equal(error.timeoutMs, 500);
    equal(error.started, true);
    return true;
  });
  const [result] = await Promise.all([active, expired]);
  equal(result.workerId, before.workerId);
  const after = await state(packageDir);
  notEqual(after.workerId, before.workerId);
  equal(after.calls, 1);
});

Deno.test("toolkit worker keeps its runtime after an ordinary source refusal", async () => {
  const packageDir = crypto.randomUUID();
  const before = await state(packageDir);
  await rejects(() => state(packageDir, "refuse"), /worker fixture exploded/);
  const after = await state(packageDir);
  equal(after.workerId, before.workerId);
  equal(after.calls, 3);
});

for (const failure of ["trap", "exit"] as const) {
  Deno.test(`toolkit worker is replaced after ${failure} without changing the next request`, async () => {
    const packageDir = crypto.randomUUID();
    const before = await state(packageDir);
    await rejects(() => state(packageDir, failure), {
      name: "SysmlToolkitWorkerError",
    });
    const after = await state(packageDir);
    notEqual(after.workerId, before.workerId);
    equal(after.calls, 1);
    deepEqual(after.sources, sources);
  });
}

Deno.test("toolkit worker errors are returned and worker results support every operation", async () => {
  await rejects(() =>
    runSysmlToolkitWorker(
      "unused",
      {
        operation: "query",
        sources,
        expression: "throw",
      },
      4000,
      fixture,
    ), /worker fixture exploded/);
  equal(
    await runSysmlToolkitWorker(
      "unused",
      { operation: "compile", sources },
      4000,
      fixture,
    ),
    "compile",
  );
  const target = {
    qualifiedName: "Demo",
    metaclass: "Package",
    source: { path: "model.sysml", text: "package Demo;" },
  };
  equal(
    await runSysmlToolkitWorker(
      "unused",
      {
        operation: "describe",
        sources,
        target,
      },
      4000,
      fixture,
    ),
    "describe",
  );
  equal(
    await runSysmlToolkitWorker(
      "unused",
      {
        operation: "edit",
        sources,
        edits: [{ kind: "remove", target }],
      },
      4000,
      fixture,
    ),
    "edit",
  );
});

Deno.test("toolkit worker refuses invalid execution deadlines before starting a worker", () => {
  for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 60_001]) {
    throws(
      () =>
        runSysmlToolkitWorker(
          "unused",
          { operation: "check", sources },
          timeout,
          fixture,
        ),
      /timeout/,
    );
  }
});

Deno.test("toolkit worker transports an isolated board request and its projection options", async () => {
  const packageDir = crypto.randomUUID();
  const before = await state(packageDir);
  const input = { ...sources };
  const options = { mode: "generic" as const, model: "reviewed model" };
  const pending = runSysmlToolkitWorker<
    WorkerState & { options: typeof options }
  >(
    packageDir,
    { operation: "board", sources: input, options },
    4000,
    fixture,
  );
  input["model.sysml"] = "package Mutated;";
  options.model = "mutated options";
  const result = await pending;
  deepEqual(result.sources, sources);
  deepEqual(result.options, { mode: "generic", model: "reviewed model" });
  equal(result.workerId, before.workerId);
  equal(result.maximumActive, 1);
  equal(result.calls, 2);
});

Deno.test("toolkit foreground operations pass boards still waiting in the queue", async () => {
  const packageDir = crypto.randomUUID();
  const before = await state(packageDir);
  const blocker = state(packageDir, "state:100");
  const board = runSysmlToolkitWorker<WorkerState>(
    packageDir,
    {
      operation: "board",
      sources,
      options: { model: "delay:20" },
    },
    4000,
    fixture,
  );
  const foreground = [
    runSysmlToolkitWorker(
      packageDir,
      { operation: "compile", sources },
      4000,
      fixture,
    ),
    runSysmlToolkitWorker(
      packageDir,
      { operation: "check", sources },
      4000,
      fixture,
    ),
    runSysmlToolkitWorker(
      packageDir,
      { operation: "edit", sources, edits: [] },
      4000,
      fixture,
    ),
  ];
  await blocker;
  deepEqual(await Promise.all(foreground), ["compile", "check", "edit"]);
  const result = await board;
  equal(result.workerId, before.workerId);
  equal(result.maximumActive, 1);
  deepEqual(result.operations, [
    "query",
    "query",
    "compile",
    "check",
    "edit",
    "board",
  ]);
});

Deno.test("toolkit board deadline preempts a blocked fixture and recovers the next foreground request", async () => {
  const packageDir = crypto.randomUUID();
  const before = await state(packageDir);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    await rejects(() =>
      runSysmlToolkitWorker(
        packageDir,
        {
          operation: "board",
          sources,
          options: { model: "spin-blocked" },
        },
        150,
        fixture,
      ), (error) => {
      ok(error instanceof SysmlToolkitTimeoutError);
      equal(error.timeoutMs, 150);
      equal(error.started, true);
      return true;
    });
  } finally {
    clearInterval(timer);
  }
  ok(ticks > 0);
  equal(
    await runSysmlToolkitWorker(
      packageDir,
      { operation: "check", sources },
      4000,
      fixture,
    ),
    "check",
  );
  notEqual((await state(packageDir)).workerId, before.workerId);
});

Deno.test("toolkit board execution cap leaves time for a queued foreground call", async () => {
  const packageDir = crypto.randomUUID();
  await state(packageDir);
  const board = runSysmlToolkitWorker(
    packageDir,
    { operation: "board", sources, options: { model: "spin-blocked" } },
    15_000,
    fixture,
  );
  const expired = rejects(board, (error) => {
    ok(error instanceof SysmlToolkitTimeoutError);
    equal(error.timeoutMs, SYSML_TOOLKIT_BOARD_EXECUTION_MS);
    equal(error.started, true);
    return true;
  });
  const foreground = runSysmlToolkitWorker(
    packageDir,
    { operation: "check", sources },
    15_000,
    fixture,
  );
  await expired;
  equal(await foreground, "check");
});

const VIEW_SUMMARY = {
  id: "definitions:Demo",
  title: "Demo",
  kind: "tree" as const,
  group: "definitions" as const,
  element: "Demo",
  nodes: 2,
  edges: 0,
};

for (const operation of ["views", "diagram"] as const) {
  Deno.test(`toolkit foreground operations pass ${operation} still waiting in the queue`, async () => {
    const packageDir = crypto.randomUUID();
    const before = await state(packageDir);
    const blocker = state(packageDir, "state:100");
    const request = operation === "views"
      ? { operation, sources }
      : { operation, sources, view: VIEW_SUMMARY };
    const pending = runSysmlToolkitWorker<WorkerState>(
      packageDir,
      request,
      4000,
      fixture,
    );
    const foreground = [
      runSysmlToolkitWorker(
        packageDir,
        { operation: "compile", sources },
        4000,
        fixture,
      ),
      runSysmlToolkitWorker(
        packageDir,
        { operation: "check", sources },
        4000,
        fixture,
      ),
      runSysmlToolkitWorker(
        packageDir,
        { operation: "edit", sources, edits: [] },
        4000,
        fixture,
      ),
    ];
    await blocker;
    deepEqual(await Promise.all(foreground), ["compile", "check", "edit"]);
    const result = await pending;
    equal(result.workerId, before.workerId);
    equal(result.maximumActive, 1);
    deepEqual(result.operations, [
      "query",
      "query",
      "compile",
      "check",
      "edit",
      operation,
    ]);
  });

  Deno.test(`toolkit ${operation} execution cap leaves time for a queued foreground call`, async () => {
    const packageDir = crypto.randomUUID();
    await state(packageDir);
    const spinSources = { "model.sysml": "spin-blocked" };
    const request = operation === "views"
      ? { operation, sources: spinSources }
      : { operation, sources: spinSources, view: VIEW_SUMMARY };
    const pending = runSysmlToolkitWorker(
      packageDir,
      request,
      15_000,
      fixture,
    );
    const expired = rejects(pending, (error) => {
      ok(error instanceof SysmlToolkitTimeoutError);
      equal(error.timeoutMs, SYSML_TOOLKIT_PROJECTION_EXECUTION_MS);
      equal(error.timeoutMs, 3_000);
      equal(error.started, true);
      return true;
    });
    const foreground = runSysmlToolkitWorker(
      packageDir,
      { operation: "check", sources },
      15_000,
      fixture,
    );
    await expired;
    equal(await foreground, "check");
  });
}

Deno.test("board HTTP cooldown suppresses thirty retries after blocked fixture preemption and permits foreground recovery", async () => {
  const packageDir = crypto.randomUUID();
  const before = await state(packageDir);
  const version = `commit:${"a".repeat(40)}`;
  let repositoryCalls = 0;
  let boardCalls = 0;
  const reader = new ToolkitModelBoardReader({
    at(requested) {
      repositoryCalls++;
      equal(requested, version);
      return Promise.resolve({
        version,
        sources,
        elements: [],
        documents: [],
        sourceDigest: "fixture sources",
        semanticDigest: "fixture semantics",
        provenanceDigest: "fixture provenance",
        sourceHashes: {},
        engineVersion: "worker fixture",
      });
    },
  }, {
    board(input) {
      boardCalls++;
      return runSysmlToolkitWorker<ModelBoard>(
        packageDir,
        {
          operation: "board",
          sources: input,
          options: { model: "spin-blocked" },
        },
        200,
        fixture,
      );
    },
  });
  const handle = createModelBoardHandler(new ModelBoardService(reader));
  const get = () =>
    handle(
      new Request(`http://atelier.test/api/model/board?version=${version}`),
    );
  const first = await get();
  equal(first?.status, 502);
  equal(first?.headers.get("cache-control"), "no-store");
  equal(first?.headers.get("retry-after"), "30");
  const firstFailure = await first?.json();
  equal(firstFailure.code, "TOOLKIT_TIMEOUT");
  deepEqual(firstFailure.context, {
    version,
    timeoutMs: 200,
    started: true,
    retryAfterMs: 30_000,
  });
  const retryStart = performance.now();
  const verifyRetry = async () => {
    const response = await get();
    equal(response?.status, 502);
    equal(response?.headers.get("cache-control"), "no-store");
    const failure = await response?.json();
    equal(failure.code, "TOOLKIT_TIMEOUT");
    equal(failure.context.version, version);
    equal(failure.context.timeoutMs, 200);
    equal(failure.context.started, true);
    ok(failure.context.retryAfterMs > 0);
    ok(failure.context.retryAfterMs <= 30_000);
    equal(failure.recovery, firstFailure.recovery);
  };
  for (let i = 0; i < 10; i++) await verifyRetry();
  await Promise.all(Array.from({ length: 20 }, verifyRetry));
  equal(boardCalls, 1, "cooldown never re-enqueues a timed-out board");
  equal(repositoryCalls, 1, "cooldown avoids repeat immutable snapshot reads");
  const retriesMs = performance.now() - retryStart;
  const foregroundStart = performance.now();
  equal(
    await runSysmlToolkitWorker(
      packageDir,
      { operation: "check", sources },
      4000,
      fixture,
    ),
    "check",
  );
  const foregroundMs = performance.now() - foregroundStart;
  const after = await state(packageDir);
  notEqual(after.workerId, before.workerId, "preempted worker was replaced");
  deepEqual(after.operations, ["check", "query"]);
  equal(after.calls, 2, "replacement worker received no board retry");
  console.log(JSON.stringify({
    qualification:
      "blocked fixture worker through board reader/service/HTTP cooldown",
    retries: 30,
    repositoryCalls,
    boardCalls,
    retriesMs,
    foregroundMs,
  }));
});
