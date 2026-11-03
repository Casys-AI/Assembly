import assert from "node:assert/strict";
import { AuthorityMatrixService } from "../../../../../application/governance/authority-matrix.ts";
import { CompiledAuthorityMatrixReader } from "./reader.ts";
import { SysmlToolkitTimeoutError } from "../../worker-client.ts";
import { TOOLKIT_PROJECTION_BACKOFF_MS } from "../versioned-reader.ts";
import {
  MATRIX_VERSION,
  matrixFixture,
} from "../../../../../../test/support/authority-matrix-fixtures.ts";

const sources = { "model.sysml": "package Initial;" };
const revision = {
  version: MATRIX_VERSION,
  sources,
  elements: [],
  documents: [],
  sourceDigest: "repository digest",
  semanticDigest: "semantic digest",
  provenanceDigest: "provenance digest",
  sourceHashes: {},
  engineVersion: "test",
};

Deno.test("matrix reader reuses the exact compiled artifact, project and returned version; service shares the projection", async () => {
  let calls = 0;
  const service = new AuthorityMatrixService(
    new CompiledAuthorityMatrixReader(
      {
        header: (version) =>
          Promise.resolve({
            version,
            sources: {},
            sourceDigest: "a".repeat(64),
          }),
        at(version) {
          assert.equal(version, MATRIX_VERSION);
          return Promise.resolve(revision);
        },
      },
      "test",
      (input, projectId) => {
        calls++;
        assert.strictEqual(input, revision);
        assert.equal(projectId, "test");
        return Promise.resolve(matrixFixture(input.version));
      },
    ),
  );
  const matrices = await Promise.all(
    Array.from({ length: 30 }, () => service.read(MATRIX_VERSION)),
  );
  assert.equal(calls, 1);
  assert.ok(matrices.every((matrix) => matrix === matrices[0]));
  assert.strictEqual(await service.read(MATRIX_VERSION), matrices[0]);
  assert.equal(calls, 1);
});

Deno.test("matrix reader cannot disguise a repository version mismatch", async () => {
  const other = `commit:${"f".repeat(40)}`;
  const service = new AuthorityMatrixService(
    new CompiledAuthorityMatrixReader(
      {
        header: (version) =>
          Promise.resolve({
            version,
            sources: {},
            sourceDigest: "a".repeat(64),
          }),
        at: () => Promise.resolve({ ...revision, version: other }),
      },
      "test",
      (input) => Promise.resolve(matrixFixture(input.version)),
    ),
  );
  await assert.rejects(() => service.read(MATRIX_VERSION), (error) => {
    assert.equal((error as { code: string }).code, "MODEL_VERSION_MISMATCH");
    return true;
  });
});

Deno.test("matrix reader reuses the board timeout backoff for queued and active work", async () => {
  for (const started of [false, true]) {
    let now = 0;
    let calls = 0;
    const reader = new CompiledAuthorityMatrixReader(
      {
        header: (version) =>
          Promise.resolve({
            version,
            sources: {},
            sourceDigest: "a".repeat(64),
          }),
        at: () => Promise.resolve(revision),
      },
      "test",
      () => {
        calls++;
        return Promise.reject(new SysmlToolkitTimeoutError(3000, started));
      },
      () => now,
    );
    const timeout = () =>
      assert.rejects(() => reader.read(MATRIX_VERSION), (error) => {
        assert.deepEqual(error, {
          code: "TOOLKIT_TIMEOUT",
          context: {
            version: MATRIX_VERSION,
            timeoutMs: 3000,
            started,
            retryAfterMs: started ? TOOLKIT_PROJECTION_BACKOFF_MS : 1000,
          },
          recovery: started
            ? "The authority matrix exceeded the Toolkit budget. Wait for context.retryAfterMs before retrying; do not retry in a loop."
            : "The projection did not start. Retry after one second; no per-version execution cooldown applies.",
        });
        return true;
      });
    for (let i = 0; i < 30; i++) await timeout();
    assert.equal(calls, started ? 1 : 30);
    now = TOOLKIT_PROJECTION_BACKOFF_MS;
    await timeout();
    assert.equal(calls, started ? 2 : 31);
  }
});
