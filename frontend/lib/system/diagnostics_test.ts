import { deepStrictEqual, equal, match } from "node:assert/strict";
import {
  createDiagnosticsApi,
  type SystemDiagnosticsRead,
} from "./diagnostics.ts";
const version = `commit:${"a".repeat(40)}`;
const other = `commit:${"b".repeat(40)}`;
const doctor = {
  version,
  sourceDigest: "b".repeat(64),
  diagnostics: [{
    code: "D1",
    severity: "warning",
    finding: "absent",
    message: "Inspect this",
    masked: false,
  }],
};
function shape(v = version) {
  return {
    version: v,
    report: {
      build: {
        repositoryId: "repo",
        sourceDigest: "b".repeat(64),
        recipeDigest: "c".repeat(64),
        buildKey: "d".repeat(64),
        artifactDigest: "e".repeat(64),
      },
      identity: {
        artifactDigest: "e".repeat(64),
        shapesDigest: "f".repeat(64),
        optionsDigest: "1".repeat(64),
        factsProjectorVersion: "1",
        engineId: "engine",
        engineVersion: "1",
      },
      conforms: false,
      diagnostics: [],
      unmappedResults: 2,
    },
  };
}
Deno.test("Doctor publishes independently while SHACL and Attention resolve unavailable", async () => {
  const waiting = Promise.withResolvers<Response>(),
    called = Promise.withResolvers<void>();
  const urls: URL[] = [];
  let observed: SystemDiagnosticsRead | undefined;
  const api = createDiagnosticsApi({
    fetch: ((input) => {
      const url = new URL(String(input), "http://example.test");
      urls.push(url);
      if (url.pathname.endsWith("/shapes")) return waiting.promise;
      if (url.pathname.endsWith("/attention")) {
        return Promise.resolve(
          Response.json({ code: "FORBIDDEN" }, { status: 403 }),
        );
      }
      return Promise.resolve(Response.json(doctor));
    }) as typeof fetch,
  });
  const pending = api.read(version, undefined, (read) => {
    if (read.doctor.status === "ready" && read.shapes.status === "loading") {
      observed = read;
      called.resolve();
    }
  });
  await called.promise;
  const snapshot = () => observed;
  equal(snapshot()?.doctor.status, "ready");
  equal(snapshot()?.shapes.status, "loading");
  waiting.resolve(
    Response.json({ code: "SHACL_ENGINE_UNAVAILABLE" }, { status: 501 }),
  );
  const result = await pending;
  equal(result.doctor.status, "ready");
  equal(result.shapes.status, "unsupported");
  equal(result.attention.status, "unavailable");
  match(result.attention.message, /authorized/);
  equal(urls.length, 3);
  for (const url of urls) equal(url.searchParams.get("version"), version);
});
Deno.test("wrong exact version and invalid shape identity refuse only their reports", async () => {
  for (const mode of ["version", "header", "identity"] as const) {
    const api = createDiagnosticsApi({
      fetch: ((input) => {
        const url = new URL(String(input), "http://example.test");
        if (url.pathname.endsWith("/shapes")) {
          const value = shape(mode === "version" ? other : version);
          if (mode === "identity") {
            value.report.identity.artifactDigest = "9".repeat(64);
          }
          return Promise.resolve(Response.json(
            value,
            mode === "header"
              ? { headers: { "x-model-version": other } }
              : undefined,
          ));
        }
        if (url.pathname.endsWith("/attention")) {
          return Promise.resolve(
            Response.json({ code: "UNAVAILABLE" }, { status: 404 }),
          );
        }
        return Promise.resolve(Response.json(doctor));
      }) as typeof fetch,
    });
    const result = await api.read(version);
    equal(result.doctor.status, "ready");
    equal(result.shapes.status, "error");
    if (result.shapes.status === "error") {
      equal(result.shapes.code, "DIAGNOSTICS_INVALID_RESPONSE");
    }
    equal(result.attention.status, "unavailable");
  }
  const requests: unknown[] = [];
  const invalid = createDiagnosticsApi({
    fetch: ((input) => {
      requests.push(input);
      return Promise.resolve(Response.json({}));
    }) as typeof fetch,
  });
  const result = await invalid.read("main");
  deepStrictEqual(requests, []);
  equal(result.doctor.status, "error");
  equal(result.shapes.status, "error");
  equal(result.attention.status, "error");
});

Deno.test("conflicting Doctor and SHACL source identities are refused in either completion order", async () => {
  for (const first of ["doctor", "shapes"] as const) {
    const doctors = Promise.withResolvers<Response>();
    const shapes = Promise.withResolvers<Response>();
    const attention = Promise.withResolvers<Response>();
    const firstReady = Promise.withResolvers<void>();
    const mismatch = Promise.withResolvers<void>();
    const seen: SystemDiagnosticsRead[] = [];
    const api = createDiagnosticsApi({
      fetch: ((input) => {
        const path = new URL(String(input), "http://example.test").pathname;
        return path.endsWith("/shapes")
          ? shapes.promise
          : path.endsWith("/attention")
          ? attention.promise
          : doctors.promise;
      }) as typeof fetch,
    });
    const result = api.read(version, undefined, (read) => {
      seen.push(read);
      if (read[first].status === "ready") firstReady.resolve();
      if (
        read.shapes.status === "error" &&
        read.shapes.code === "DIAGNOSTICS_SOURCE_MISMATCH"
      ) mismatch.resolve();
    });
    const wrong = shape();
    wrong.report.build.sourceDigest = "2".repeat(64);
    if (first === "doctor") doctors.resolve(Response.json(doctor));
    else shapes.resolve(Response.json(wrong));
    await firstReady.promise;
    if (first === "doctor") shapes.resolve(Response.json(wrong));
    else doctors.resolve(Response.json(doctor));
    await mismatch.promise;
    attention.resolve(Response.json({ code: "UNAVAILABLE" }, { status: 404 }));
    const final = await result;
    equal(final.doctor.status, "ready");
    equal(final.shapes.status, "error");
    if (final.shapes.status === "error") {
      equal(final.shapes.code, "DIAGNOSTICS_SOURCE_MISMATCH");
    }
    const combined = seen.filter((read) =>
      read.doctor.status === "ready" && read.shapes.status !== "loading"
    );
    equal(combined.length >= 1, true);
    for (const read of combined) equal(read.shapes.status, "error");
  }
});
