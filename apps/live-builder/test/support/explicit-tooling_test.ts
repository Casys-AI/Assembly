import { deepStrictEqual, throws } from "node:assert/strict";
import { ExplicitTooling } from "./explicit-tooling.ts";

Deno.test("explicit tooling reads clone their fixtures and every edit fails with a code", async () => {
  const tooling = new ExplicitTooling({ query: { values: [1] }, check: [] });
  const first = await tooling.query() as { values: number[] };
  first.values.push(2);
  deepStrictEqual(await tooling.query(), { values: [1] });
  deepStrictEqual(await tooling.check(), []);
  const diagnostics = new ExplicitTooling({
    check: [{ severity: "info", message: "Prepared diagnostic" }],
  });
  const checked = await diagnostics.check();
  checked[0]!.message = "caller mutation";
  deepStrictEqual(await diagnostics.check(), [{
    severity: "info",
    message: "Prepared diagnostic",
  }]);
  throws(() => new ExplicitTooling().query(), { code: "TEST_TOOLING_READ" });
  throws(() => new ExplicitTooling().check(), { code: "TEST_TOOLING_READ" });
  deepStrictEqual(await new ExplicitTooling({ query: null }).query(), null);
  throws(() => tooling.edit(), { code: "TEST_TOOLING_WRITE" });
  throws(() => tooling.compile({}), { code: "TEST_TOOLING_READ" });
  throws(() =>
    tooling.describe({}, {
      qualifiedName: "P",
      metaclass: "Package",
      source: { path: "p.sysml", text: "package P;" },
    }), { code: "TEST_TOOLING_READ" });
});

Deno.test("explicit tooling compilation and descriptions use only supplied fixtures", async () => {
  const sources = { "fixture.sysml": "opaque fixture bytes" };
  const compiled = {
    sources,
    elements: [],
    documents: [],
    sourceDigest: "fixture-source",
    semanticDigest: "fixture-semantic",
    provenanceDigest: "fixture-provenance",
    sourceHashes: {},
    engineVersion: "test-only",
  };
  const description = {
    id: "fixture-id",
    qualifiedName: "Fixture",
    metaclass: "Package",
    types: [],
    source: {
      path: "fixture.sysml",
      startByte: 0,
      endByte: 20,
      text: sources["fixture.sysml"],
    },
  };
  const tooling = new ExplicitTooling({
    compiled,
    descriptions: { Fixture: description },
  });
  const result = await tooling.compile(sources);
  result.sources["fixture.sysml"] = "changed";
  deepStrictEqual(await tooling.compile(sources), compiled);
  deepStrictEqual(await tooling.snapshot(sources), {
    ...compiled,
    version: "test:fixture-source",
  });
  const target = {
    qualifiedName: "Fixture",
    metaclass: "Package",
    source: { path: "fixture.sysml", text: "opaque fixture bytes" },
  };
  const described = await tooling.describe(sources, target);
  described.types.push({ id: "mutation" });
  deepStrictEqual(await tooling.describe(sources, target), description);
  throws(() => tooling.compile({ "other.sysml": "other bytes" }), {
    code: "TEST_TOOLING_READ",
  });
});
