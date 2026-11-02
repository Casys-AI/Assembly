import assert from "node:assert/strict";
import {
  type AuthorityMatrixProcessInput,
  authorityMatrixProcessStats,
  MATRIX_PROCESS_HEAP_MIB,
  type MatrixProcessObserver,
  scheduleAuthorityMatrix,
} from "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/worker-client.ts";
import { SysmlToolkitWorkerError } from "../../src/adapters/out/sysml-toolkit/worker-client.ts";
import { AuthorityMatrixService } from "../../src/application/governance/authority-matrix.ts";
import { createAuthorityMatrixHandler } from "../../src/adapters/in/http/governance/authority-matrix.ts";
import { ToolkitVersionedReader } from "../../src/adapters/out/sysml-toolkit/projections/versioned-reader.ts";

const entry = new URL(
  "../fixtures/authority-matrix-crash-process.ts",
  import.meta.url,
);
const version = `commit:${"b".repeat(40)}`;
const job = (
  name: string,
  elements: readonly unknown[] = [],
): () => Promise<AuthorityMatrixProcessInput> =>
() =>
  Promise.resolve({
    revision: {
      version,
      sourceDigest: "0".repeat(64),
      engineVersion: "0.10.10",
      provenanceDigest: "0".repeat(64),
      provider: {
        name: "sysml-toolkit",
        version: "0.10.10",
        format: "ase-toolkit-normalized-json-v1",
      },
      sources: {},
      elements,
    },
    projectId: "test",
    pin: { version, sourceDigest: "0".repeat(64) },
    name,
  } as unknown as AuthorityMatrixProcessInput);

Deno.test("heap exhaustion or a crash in the projection process is a coded error and the next request succeeds", async () => {
  const exits: { code: number; signal: string | null }[] = [];
  const observer: MatrixProcessObserver = {
    onExit: ({ code, signal }) => exits.push({ code, signal }),
  };
  let hostHeapBefore = Deno.memoryUsage().heapUsed;
  const started = performance.now();
  await assert.rejects(
    scheduleAuthorityMatrix("heap", job("heap"), 15_000, observer, entry),
    (error) => {
      assert.ok(error instanceof SysmlToolkitWorkerError);
      assert.equal(error.code, "PROJECTION_PROCESS_UNAVAILABLE");
      // The message carries the child's exit status (and signal) and the tail of
      // its stderr.
      assert.match(
        error.message,
        /^Projection child exited [1-9]\d*( \(SIG[A-Z0-9]+\))?:/,
      );
      return true;
    },
  );
  const heapMs = performance.now() - started;
  assert.equal(exits.length, 1);
  assert.notEqual(exits[0]!.code, 0, "the child died; the host did not");
  // The host is untouched: it neither died nor grew by the child's allocation.
  assert.ok(
    Deno.memoryUsage().heapUsed - hostHeapBefore < 64 * 1024 * 1024,
    "host JS heap is unaffected by the child's exhaustion",
  );
  hostHeapBefore = 0;

  await assert.rejects(
    scheduleAuthorityMatrix("exit", job("exit"), 15_000, observer, entry),
    { code: "PROJECTION_PROCESS_UNAVAILABLE" },
  );
  assert.equal(exits.at(-1)!.code, 7);

  const matrix = await scheduleAuthorityMatrix(
    "next",
    job("next"),
    15_000,
    observer,
    entry,
  ) as unknown as { marker: string; cwd: string };
  assert.equal(matrix.marker, "next");
  assert.equal(
    Deno.realPathSync(matrix.cwd),
    Deno.realPathSync(new URL("../../", import.meta.url)),
    "the child runs in the application directory that holds deno.json",
  );
  assert.deepEqual(exits.at(-1), { code: 0, signal: null });
  assert.deepEqual(authorityMatrixProcessStats(), {
    active: 0,
    queued: 0,
    retiring: 0,
  });
  console.log(JSON.stringify({
    heapExhaustionMs: Math.round(heapMs),
    heapLimitMiB: MATRIX_PROCESS_HEAP_MIB,
    exits,
  }));
});

Deno.test("a child that dies before reading its input is reported with its exit and stderr, whatever the payload size", async () => {
  const early = new URL(
    "../fixtures/authority-matrix-early-exit-process.ts",
    import.meta.url,
  );
  // 3000 elements of 2 KiB are about 6 MiB: far beyond the pipe buffer, so the
  // write to a dead child fails (EPIPE) instead of being absorbed by the pipe.
  const big = Array.from(
    { length: 3000 },
    (_, index) => ({ "@id": `e${index}`, text: "x".repeat(2000) }),
  );
  const exits: { code: number; signal: string | null }[] = [];
  const observer: MatrixProcessObserver = {
    onExit: ({ code, signal }) => exits.push({ code, signal }),
  };
  for (
    const [label, elements] of [["empty", []], ["6 MiB", big]] as const
  ) {
    await assert.rejects(
      scheduleAuthorityMatrix(
        `early-${label}`,
        job("early", elements),
        15_000,
        observer,
        early,
      ),
      (error) => {
        assert.ok(error instanceof SysmlToolkitWorkerError, label);
        assert.equal(error.code, "PROJECTION_PROCESS_UNAVAILABLE", label);
        assert.match(error.message, /^Projection child exited 3\b/, label);
        assert.match(error.message, /FATAL: module graph failed/, label);
        assert.doesNotMatch(error.message, /EPIPE/, label);
        return true;
      },
    );
    assert.deepEqual(exits.at(-1)!.code, 3, label);
  }

  // Through the shared reader and the real handler: an infrastructure failure
  // (502) whose recovery does not blame the model.
  const service = new AuthorityMatrixService(
    new ToolkitVersionedReader(
      (requested) =>
        scheduleAuthorityMatrix(
          requested,
          job("early", big),
          15_000,
          undefined,
          early,
        ),
      "authority matrix",
      "AUTHORITY_MATRIX_FAILED",
      undefined,
      false,
    ),
  );
  const response = await createAuthorityMatrixHandler(
    service,
    () => Promise.resolve(version),
  )(new Request(`http://test/api/model/authority-matrix?version=${version}`));
  assert.equal(response?.status, 502);
  assert.equal(response?.headers.get("cache-control"), "no-store");
  const failure = await response!.json();
  assert.equal(failure.code, "PROJECTION_PROCESS_UNAVAILABLE");
  assert.match(failure.context.message, /exited 3/);
  assert.equal("diagnostics" in failure.context, false);
  assert.doesNotMatch(failure.recovery, /Correct the reported model/);
  assert.match(failure.recovery, /Restore the authority matrix runtime/);
  assert.deepEqual(authorityMatrixProcessStats(), {
    active: 0,
    queued: 0,
    retiring: 0,
  });
});
