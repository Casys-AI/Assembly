import assert from "node:assert/strict";
import { createModelShapesHandler } from "./shapes.ts";
import {
  ModelShapesError,
  type ShaclValidationReport,
} from "../../../../application/model/diagnostics/shapes.ts";
import { SemanticIndexError } from "../../../../application/model/semantic/index-service.ts";

const version = `commit:${"a".repeat(40)}`;
const otherVersion = `commit:${"b".repeat(40)}`;
function report(shapesDigest = "2".repeat(64)): ShaclValidationReport {
  return {
    build: {
      repositoryId: "model-repository",
      sourceDigest: "1".repeat(64),
      recipeDigest: "3".repeat(64),
      buildKey: "4".repeat(64),
      artifactDigest: "5".repeat(64),
    },
    identity: {
      artifactDigest: "5".repeat(64),
      shapesDigest,
      factsProjectorVersion: "model-facts/v1",
      engineId: "rdf-validate-shacl",
      engineVersion: "test-pinned-version",
      optionsDigest: "6".repeat(64),
    },
    conforms: true,
    diagnostics: [],
    unmappedResults: 0,
  };
}
const url = `http://local/api/model/diagnostics/shapes?version=${version}`;

Deno.test("SHACL HTTP pins the selected source and revalidates report identity", async () => {
  const reads: string[] = [];
  let current = report();
  const handler = createModelShapesHandler({
    validate(selected) {
      reads.push(selected);
      return Promise.resolve({ version: selected, report: current });
    },
  });
  const first = await handler(new Request(url));
  assert.equal(first?.status, 200);
  assert.equal(first?.headers.get("cache-control"), "no-cache");
  const etag = first?.headers.get("etag");
  assert.ok(etag);
  assert.match(etag ?? "", /^"[0-9a-f]{64}"$/);
  assert.deepEqual(await first?.json(), { version, report: current });
  const unchanged = await handler(
    new Request(url, {
      headers: { "if-none-match": etag },
    }),
  );
  assert.equal(unchanged?.status, 304);
  assert.equal(await unchanged?.text(), "");
  current = report("7".repeat(64));
  const upgraded = await handler(
    new Request(url, {
      headers: { "if-none-match": etag },
    }),
  );
  assert.equal(upgraded?.status, 200);
  assert.notEqual(upgraded?.headers.get("etag"), etag);
  assert.deepEqual(await upgraded?.json(), { version, report: current });
  assert.deepEqual(reads, [version, version, version]);
});

Deno.test("SHACL HTTP refuses mutable, missing and ambiguous selections before reading", async () => {
  let reads = 0;
  const handler = createModelShapesHandler({
    validate(selected) {
      reads++;
      return Promise.resolve({ version: selected, report: report() });
    },
  });
  for (
    const query of [
      "",
      "?version=",
      "?version=head",
      "?version=branch:main",
      "?version=commit:a",
      `?version=commit:${"A".repeat(40)}`,
      `?version=${version}&version=${otherVersion}`,
      `?version=${version}&other=true`,
    ]
  ) {
    const result = await handler(
      new Request(
        `http://local/api/model/diagnostics/shapes${query}`,
      ),
    );
    assert.equal(result?.status, 400, query);
    assert.equal(result?.headers.get("cache-control"), "no-store");
  }
  const write = await handler(new Request(url, { method: "POST" }));
  assert.equal(write?.status, 405);
  assert.equal(write?.headers.get("allow"), "GET");
  assert.equal(
    await handler(new Request("http://local/api/model/diagnostics")),
    null,
  );
  assert.equal(reads, 0);
});

Deno.test("SHACL HTTP reports engine failure independently without private exception details", async () => {
  for (
    const error of [
      new ModelShapesError("SHACL_ENGINE_UNAVAILABLE", {
        path: "/private/host/dependency",
      }, "private engine loading detail"),
      Object.assign(new Error("private host stack"), {
        code: "HOST_PRIVATE_FAILURE",
        context: { path: "/private/host/dependency" },
        recovery: "private repair command",
      }),
    ]
  ) {
    const handler = createModelShapesHandler({
      validate: () => Promise.reject(error),
    });
    const response = await handler(new Request(url));
    assert.equal(
      response?.status,
      error instanceof ModelShapesError ? 502 : 500,
    );
    assert.equal(response?.headers.get("cache-control"), "no-store");
    const body = await response?.json();
    assert.equal(
      body.code,
      error instanceof ModelShapesError
        ? "SHACL_ENGINE_UNAVAILABLE"
        : "SHACL_VALIDATION_FAILED",
    );
    assert.equal(body.context.version, version);
    assert.equal(typeof body.recovery, "string");
    assert.equal(body.report, undefined);
    assert.doesNotMatch(JSON.stringify(body), /private|HOST_PRIVATE_FAILURE/);
  }
});

Deno.test("SHACL HTTP never returns a report labeled for a different source", async () => {
  const handler = createModelShapesHandler({
    validate: () =>
      Promise.resolve({ version: otherVersion, report: report() }),
  });
  const response = await handler(new Request(url));
  assert.equal(response?.status, 500);
  const body = await response?.json();
  assert.equal(body.code, "SHACL_VALIDATION_FAILED");
  assert.equal(body.context.version, version);
  assert.equal(body.report, undefined);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(otherVersion));
});

Deno.test("SHACL HTTP keeps an unavailable source projection explicit", async () => {
  const handler = createModelShapesHandler({
    validate: () =>
      Promise.reject(
        new SemanticIndexError(
          "INDEX_PROJECTION_MISSING",
          { path: "/private/cache" },
          "private reason",
        ),
      ),
  });
  const response = await handler(new Request(url));
  assert.equal(response?.status, 500);
  const body = await response?.json();
  assert.equal(body.code, "INDEX_PROJECTION_MISSING");
  assert.equal(body.context.version, version);
  assert.equal(body.report, undefined);
  assert.doesNotMatch(JSON.stringify(body), /private/);
});
