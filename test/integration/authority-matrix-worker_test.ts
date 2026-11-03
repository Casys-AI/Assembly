import assert from "node:assert/strict";
import {
  createIsolatedWorkerRunner,
  runSysmlToolkitWorker,
  SYSML_TOOLKIT_PROJECTION_EXECUTION_MS,
  SYSML_TOOLKIT_TIMEOUT_MS,
  SysmlToolkitTimeoutError,
  type ToolkitWorkerOperation,
} from "../../src/adapters/out/sysml-toolkit/worker-client.ts";
import { MATRIX_EXECUTION_MS } from "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/worker-client.ts";
import { CompiledAuthorityMatrixReader } from "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/reader.ts";
import { AuthorityMatrixService } from "../../src/application/governance/authority-matrix.ts";
import { createAuthorityMatrixHandler } from "../../src/adapters/in/http/governance/authority-matrix.ts";
import type { AuthorityMatrix } from "../../src/domain/governance/records/authority-matrix.ts";
import { parseModelRevisionId } from "../../src/domain/shared-kernel/revision-id.ts";

const fixture = new URL(
  "../fixtures/sysml-toolkit-worker-fixture.ts",
  import.meta.url,
);
const sources = { "model.sysml": "package Initial;" };
const version = parseModelRevisionId(`commit:${"a".repeat(40)}`);
interface WorkerState {
  workerId: string;
  maximumActive: number;
  operations: string[];
}
const toolkitState = (key: string) =>
  runSysmlToolkitWorker<WorkerState>(
    key,
    {
      operation: "query",
      sources,
      expression: "state",
    },
    4000,
    fixture,
  );

Deno.test("projection lane reuses shared FIFO/priority and recycles without retiring the Toolkit worker", async () => {
  const key = crypto.randomUUID();
  const toolkit = await toolkitState(key);
  const run = createIsolatedWorkerRunner<ToolkitWorkerOperation>({
    isProjection: (request) => request.operation === "board",
    maxOperationsPerWorker: 5,
  });
  const initial = await run<WorkerState>(
    key,
    { operation: "query", sources, expression: "state" },
    4000,
    fixture,
  );
  assert.notEqual(initial.workerId, toolkit.workerId);
  const blocker = run(
    key,
    { operation: "query", sources, expression: "state:100" },
    4000,
    fixture,
  );
  const projection = run<WorkerState>(
    key,
    { operation: "board", sources },
    4000,
    fixture,
  );
  const foreground = run(
    key,
    { operation: "edit", sources, edits: [] },
    4000,
    fixture,
  );
  await blocker;
  assert.equal(await foreground, "edit");
  const result = await projection;
  assert.equal(result.maximumActive, 1);
  assert.deepEqual(result.operations, ["query", "query", "edit", "board"]);
  // Fifth completed operation is acknowledged only after this lane terminates.
  const last = await run<WorkerState>(
    key,
    { operation: "query", sources, expression: "state" },
    4000,
    fixture,
  );
  assert.equal(last.workerId, initial.workerId);
  const replacement = await run<WorkerState>(
    key,
    { operation: "query", sources, expression: "state" },
    4000,
    fixture,
  );
  assert.notEqual(replacement.workerId, initial.workerId);
  assert.equal((await toolkitState(key)).workerId, toolkit.workerId);
});

Deno.test("dedicated projection ceiling preempts infinite work and keeps host and Toolkit responsive", async () => {
  const key = crypto.randomUUID();
  const before = await toolkitState(key);
  const run = createIsolatedWorkerRunner<ToolkitWorkerOperation>({
    isProjection: () => true,
    maxOperationsPerWorker: 5,
  });
  await run(
    key,
    { operation: "query", sources, expression: "state" },
    4000,
    fixture,
  );
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const expired = assert.rejects(
      run(
        key,
        {
          operation: "board",
          sources,
          options: { model: "spin-blocked" },
        },
        15_000,
        fixture,
      ),
      (error) => {
        assert.ok(error instanceof SysmlToolkitTimeoutError);
        assert.equal(error.timeoutMs, SYSML_TOOLKIT_PROJECTION_EXECUTION_MS);
        assert.equal(error.started, true);
        return true;
      },
    );
    const available = await toolkitState(key);
    assert.equal(available.workerId, before.workerId);
    await expired;
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 0);
  assert.equal(
    await run(key, { operation: "check", sources }, 4000, fixture),
    "check",
  );
});

Deno.test("compiled matrix HTTP deadline suppresses thirty retries after real worker preemption", async () => {
  const key = crypto.randomUUID();
  const run = createIsolatedWorkerRunner<ToolkitWorkerOperation>({
    isProjection: () => true,
    maxOperationsPerWorker: 5,
  });
  await run(
    key,
    { operation: "query", sources, expression: "state" },
    4000,
    fixture,
  );
  let calls = 0;
  const service = new AuthorityMatrixService(
    new CompiledAuthorityMatrixReader(
      {
        header: (version) =>
          Promise.resolve({
            version,
            sources,
            sourceDigest: "a".repeat(64),
          }),
        at: () =>
          Promise.resolve({
            version,
            sources,
            elements: [],
            documents: [],
            sourceHashes: {},
            sourceDigest: "test",
            semanticDigest: "test",
            provenanceDigest: "test",
            engineVersion: "test",
          }),
      },
      "test",
      () => {
        calls++;
        return run<AuthorityMatrix>(
          key,
          { operation: "board", sources, options: { model: "spin-blocked" } },
          200,
          fixture,
        );
      },
    ),
  );
  const handler = createAuthorityMatrixHandler(
    service,
    () => Promise.resolve(version),
  );
  for (let i = 0; i < 31; i++) {
    const response = await handler(
      new Request(
        `http://atelier.test/api/model/authority-matrix?version=${version}`,
      ),
    );
    assert.equal(response?.status, 502);
    assert.equal(response?.headers.get("cache-control"), "no-store");
    assert.equal(response?.headers.get("retry-after"), "30");
    const failure = await response?.json();
    assert.equal(failure.code, "TOOLKIT_TIMEOUT");
    assert.equal(failure.context.version, version);
    assert.equal(failure.context.started, true);
  }
  assert.equal(calls, 1);
});

Deno.test("a lane that owns a disposable process sets its own projection ceiling", async () => {
  assert.ok(
    MATRIX_EXECUTION_MS > SYSML_TOOLKIT_PROJECTION_EXECUTION_MS &&
      MATRIX_EXECUTION_MS < SYSML_TOOLKIT_TIMEOUT_MS,
    "the matrix ceiling is above the Toolkit one and below the total budget",
  );
  for (const invalid of [0, 1.5, 60_001]) {
    assert.throws(() =>
      createIsolatedWorkerRunner<ToolkitWorkerOperation>({
        isProjection: () => true,
        projectionExecutionMs: invalid,
      })
    );
  }
  const run = createIsolatedWorkerRunner<ToolkitWorkerOperation>({
    isProjection: () => true,
    maxOperationsPerWorker: 1,
    projectionExecutionMs: 1500,
  });
  const started = performance.now();
  await assert.rejects(
    run(
      crypto.randomUUID(),
      { operation: "board", sources, options: { model: "spin-blocked" } },
      15_000,
      fixture,
    ),
    (error) => {
      assert.ok(error instanceof SysmlToolkitTimeoutError);
      assert.equal(error.timeoutMs, 1500);
      return true;
    },
  );
  assert.ok(
    performance.now() - started < 6000,
    "preempted at the lane ceiling",
  );
});
