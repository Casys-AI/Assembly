import assert from "node:assert/strict";
import type { SourceRepository } from "../source-repository.ts";
import type { ModelRepositoryPort } from "../repository.ts";
import type { SourceRevision } from "../../../domain/model/records/source-revision.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import { SourceModelDiagnosticsReader } from "./source-diagnostics-reader.ts";

const unexpectedCompilation = {
  compile() {
    throw new Error("Metadata or failed source reads must not compile");
  },
};

Deno.test("diagnostic reader captures lightweight head metadata and lazily hydrates its exact version", async () => {
  const first = `commit:${"a".repeat(40)}`;
  const second = `commit:${"b".repeat(40)}`;
  let head = first;
  const calls: string[] = [];
  const unavailable = new Error("captured source unavailable");
  const repository:
    & Pick<SourceRepository, "current" | "at" | "history">
    & Pick<ModelRepositoryPort, "header"> = {
      current() {
        throw new Error("Header reads must not load current source");
      },
      history(options) {
        assert.deepEqual(options, { limit: 1 });
        calls.push("history");
        return Promise.resolve({
          headVersion: head,
          truncated: false,
          commits: [],
        });
      },
      header(version) {
        calls.push(`header:${version}`);
        return Promise.resolve({
          version,
          sourceDigest: `digest:${version}`,
          sources: {},
        });
      },
      at(version) {
        calls.push(`at:${version}`);
        return Promise.reject(unavailable);
      },
    };
  const reader = new SourceModelDiagnosticsReader(
    repository,
    "project",
    unexpectedCompilation,
  );
  const captured = await reader.read();
  assert.equal(captured.version, first);
  assert.equal(captured.digest, `digest:${first}`);
  assert.deepEqual(calls, ["history", `header:${first}`]);
  head = second;
  await assert.rejects(
    () => captured.input(),
    (error) => error === unavailable,
  );
  assert.deepEqual(calls, ["history", `header:${first}`, `at:${first}`]);

  calls.length = 0;
  const explicit = await reader.read(first);
  assert.equal(explicit.version, first);
  assert.equal(explicit.digest, `digest:${first}`);
  assert.deepEqual(calls, [`header:${first}`]);
  await assert.rejects(
    () => explicit.input(),
    (error) => error === unavailable,
  );
  assert.deepEqual(calls, [`header:${first}`, `at:${first}`]);
});

Deno.test("diagnostic reader without headers derives metadata from the captured current or historical source", async () => {
  const current: SourceRevision = {
    version: `commit:${"a".repeat(40)}`,
    sources: { "model.sysml": "package Current;\n" },
    elements: [],
  };
  const historical: SourceRevision = {
    version: `commit:${"b".repeat(40)}`,
    sources: { "model.sysml": "\npackage Current;\n" },
    elements: [],
  };
  const calls: string[] = [];
  const repository: Pick<SourceRepository, "current" | "at" | "history"> = {
    current() {
      calls.push("current");
      return Promise.resolve(current);
    },
    at(version) {
      assert.equal(version, historical.version);
      calls.push(`at:${version}`);
      return Promise.resolve(historical);
    },
    history() {
      throw new Error("Without headers metadata must use the selected source");
    },
  };
  const reader = new SourceModelDiagnosticsReader(
    repository,
    "project",
    unexpectedCompilation,
  );
  const capturedCurrent = await reader.read();
  assert.equal(capturedCurrent.version, current.version);
  assert.equal(
    capturedCurrent.digest,
    await modelSourceDigest(current.sources),
  );
  assert.deepEqual(calls, ["current"]);

  const capturedHistorical = await reader.read(historical.version);
  assert.equal(capturedHistorical.version, historical.version);
  assert.equal(
    capturedHistorical.digest,
    await modelSourceDigest(historical.sources),
  );
  assert.notEqual(capturedHistorical.digest, capturedCurrent.digest);
  assert.deepEqual(calls, ["current", `at:${historical.version}`]);
});
