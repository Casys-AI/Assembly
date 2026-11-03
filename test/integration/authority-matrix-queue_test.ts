import assert from "node:assert/strict";
import { AuthorityMatrixService } from "../../src/application/governance/authority-matrix.ts";
import { ModelRepositoryError } from "../../src/application/model/repository.ts";
import { ToolkitModelBoardReader } from "../../src/adapters/model/projections/board-reader.ts";
import { createModelBoardHandler } from "../../src/adapters/in/http/model/board.ts";
import { CompiledAuthorityMatrixReader } from "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/reader.ts";
import {
  authorityMatrixProcessStats,
  MATRIX_MAX_QUEUED,
} from "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/worker-client.ts";
import { createAuthorityMatrixHandler } from "../../src/adapters/in/http/governance/authority-matrix.ts";
import { prepareMatrixArtifact } from "../support/authority-matrix-artifact-fixtures.ts";
import { parseModelRevisionId } from "../../src/domain/shared-kernel/revision-id.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

Deno.test({
  name:
    "matrix bounds versions before loading artifacts, coalesces bursts and returns retryable saturation",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const projectId = "git:22222222-2222-4222-8222-222222222222";
    const versions = Array.from(
      { length: 40 },
      (_, i) =>
        parseModelRevisionId(`commit:${i.toString(16).padStart(40, "0")}`),
    );
    const fixture = await prepareMatrixArtifact("initial", {
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
      projectId,
      version: versions[0],
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    const loaded: string[] = [], pins: string[] = [];
    let spawns = 0, exits = 0, maxSlice = 0, minYields = Infinity;
    const service = new AuthorityMatrixService(
      new CompiledAuthorityMatrixReader(
        {
          header(version) {
            pins.push(version);
            return Promise.resolve({
              ...fixture.pin,
              version,
              sources: fixture.revision.sources,
            });
          },
          async at(version) {
            loaded.push(version);
            if (version === versions[0]) await gate;
            return { ...fixture.revision, version };
          },
        },
        projectId,
        undefined,
        undefined,
        {
          onSpawn: () => spawns++,
          onExit: () => exits++,
          onPrepared: (s) => {
            maxSlice = Math.max(maxSlice, s.maxSliceMs);
            minYields = Math.min(minYields, s.yields);
          },
        },
      ),
    );
    const handler = createAuthorityMatrixHandler(
      service,
      () => Promise.resolve(versions[0]),
    );
    let maxLag = 0, last = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - last - 5);
      last = now;
    }, 5);
    const pending = versions.map((version) =>
      handler(
        new Request(
          `http://test/api/model/authority-matrix?version=${version}`,
        ),
      )
    );
    const duplicates = Array.from(
      { length: 20 },
      () => service.read(versions[0]),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(loaded.length, 1, "only active version reads an artifact");
      assert.equal(
        pins.length,
        1,
        "waiting versions retain only their identifiers",
      );
      assert.equal(
        spawns,
        0,
        "loading is gated before preparation or process start",
      );
      assert.equal(authorityMatrixProcessStats().queued, MATRIX_MAX_QUEUED);
      const refused = await pending[versions.length - 1];
      assert.equal(refused?.status, 502);
      assert.equal(refused?.headers.get("retry-after"), "1");
      assert.equal(refused?.headers.get("cache-control"), "no-store");
      assert.equal(
        (await refused?.json()).code,
        "PROJECTION_QUEUE_UNAVAILABLE",
      );
      release();
      const responses = await Promise.all(pending);
      const values = await Promise.all(duplicates);
      assert.ok(values.every((value) => value === values[0]));
      assert.equal(
        responses.filter((r) => r?.status === 200).length,
        1 + MATRIX_MAX_QUEUED,
      );
      assert.equal(spawns, 1 + MATRIX_MAX_QUEUED);
      assert.equal(exits, spawns);
      assert.equal(loaded.filter((v) => v === versions[0]).length, 1);
      const retried = await handler(
        new Request(
          `http://test/api/model/authority-matrix?version=${versions.at(-1)}`,
        ),
      );
      assert.equal(
        retried?.status,
        200,
        "saturation did not impose a 30-second cooldown",
      );
      assert.deepEqual(authorityMatrixProcessStats(), {
        active: 0,
        queued: 0,
        retiring: 0,
      });
      // Serializing the whole 12 MiB artifact in one go takes about 25 ms and
      // cloning it about 70 ms, so a millisecond gate alone cannot tell the
      // incremental writer from a single block, and a slice also counts GC
      // pauses and descheduling (41.8 ms was seen once in about 200 slices under
      // load). The invariant is therefore both: the work was cut into many
      // yielded slices, and no slice is anywhere near a stalled loop.
      assert.ok(minYields >= 25, `preparation yielded only ${minYields} times`);
      assert.ok(maxSlice < 100, `incremental preparation slice ${maxSlice}ms`);
      assert.ok(maxLag < 100, `event loop lag ${maxLag}ms`);
      console.log(
        JSON.stringify({
          versions: versions.length,
          duplicates: duplicates.length,
          maxQueued: MATRIX_MAX_QUEUED,
          loaded: loaded.length,
          spawns,
          exits,
          maxSlice,
          minYields,
          maxLag,
        }),
      );
    } finally {
      release();
      clearInterval(interval);
      await Promise.allSettled([...pending, ...duplicates]);
    }
  },
});

Deno.test("aborted artifact loads cannot strand the projection lane", async () => {
  const { scheduleAuthorityMatrix } = await import(
    "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/worker-client.ts"
  );
  let aborted = false;
  await assert.rejects(scheduleAuthorityMatrix("first", (signal) => {
    signal!.addEventListener("abort", () => aborted = true, { once: true });
    return new Promise(() => {});
  }, 25));
  assert.ok(aborted);
  let nextStarted = false;
  await assert.rejects(
    scheduleAuthorityMatrix("next", () => {
      nextStarted = true;
      return Promise.reject(
        Object.assign(new Error("missing"), { code: "NOT_FOUND" }),
      );
    }, 1000),
    { code: "NOT_FOUND" },
  );
  assert.ok(nextStarted);
  assert.deepEqual(authorityMatrixProcessStats(), {
    active: 0,
    queued: 0,
    retiring: 0,
  });
});

Deno.test("matrix keeps a repository error's own code, status and recovery across the deferred load, exactly as the board route", async () => {
  const version = parseModelRevisionId(`commit:${"a".repeat(40)}`);
  const request = (path: string) =>
    new Request(`http://test${path}?version=${version}`);
  const head = () => Promise.resolve(version);
  for (
    const [error, status, recovery] of [
      [
        new ModelRepositoryError("NOT_FOUND", "Model version not found"),
        404,
        "Choose an existing commit from /api/model-history.",
      ],
      [
        new ModelRepositoryError("INVALID_REPOSITORY", "Damaged snapshot"),
        500,
        "Inspect the model repository and restore a valid snapshot before reading this version.",
      ],
    ] as const
  ) {
    // The failure is raised by the deferred load, in the pin read first and in
    // the artifact read when the pin is fine: both go through the same lane.
    for (const failingStep of ["header", "at"] as const) {
      const repository = {
        header: () =>
          failingStep === "header" ? Promise.reject(error) : Promise.resolve({
            version,
            sources: {},
            sourceDigest: "0".repeat(64),
          }),
        at: () => Promise.reject(error),
      };
      const matrix = await createAuthorityMatrixHandler(
        new AuthorityMatrixService(
          new CompiledAuthorityMatrixReader(repository, "test"),
        ),
        head,
      )(request("/api/model/authority-matrix"));
      const boardReader = new ToolkitModelBoardReader(repository, {
        board: () => Promise.reject(new Error("the board must not run")),
      });
      const board = await createModelBoardHandler(
        { read: (requested: string) => boardReader.read(requested) },
        head,
      )(request("/api/model/board"));
      const label = `${error.code} from ${failingStep}`;
      assert.equal(matrix?.status, status, label);
      assert.equal(board?.status, status, label);
      assert.equal(matrix?.headers.get("cache-control"), "no-store", label);
      const matrixBody = await matrix?.json();
      const boardBody = await board?.json();
      assert.equal(matrixBody.code, error.code, label);
      assert.equal(matrixBody.recovery, recovery, label);
      // Same code, same context ({version, message}), same recovery: no empty
      // diagnostics and no Toolkit advice for a repository fault.
      assert.deepEqual(matrixBody, boardBody, label);
    }
  }
});

Deno.test("a load failure without a repository type keeps its own code, status and an infrastructure recovery", async () => {
  const version = parseModelRevisionId(`commit:${"a".repeat(40)}`);
  const response = await createAuthorityMatrixHandler(
    new AuthorityMatrixService(
      new CompiledAuthorityMatrixReader({
        header: () =>
          Promise.resolve({
            version,
            sources: {},
            sourceDigest: "0".repeat(64),
          }),
        at: () =>
          Promise.reject(
            Object.assign(new Error("pin reader offline"), {
              code: "MODEL_PIN_UNAVAILABLE",
            }),
          ),
      }, "test"),
    ),
    () => Promise.resolve(version),
  )(
    new Request(`http://test/api/model/authority-matrix?version=${version}`),
  );
  assert.equal(response?.status, 502);
  const body = await response?.json();
  assert.equal(body.code, "MODEL_PIN_UNAVAILABLE");
  assert.equal(body.context.message, "pin reader offline");
  assert.equal("diagnostics" in body.context, false);
  assert.doesNotMatch(body.recovery, /Correct the reported model or Toolkit/);
});
