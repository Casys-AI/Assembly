import {
  deepStrictEqual,
  equal,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import {
  ModelContextError,
  type ModelSourceRange,
} from "../../../domain/model/consultation/context.ts";
import { ModelContextReader, utf8SourceSpan } from "./source-reader.ts";
import { materialize } from "../../../adapters/model/builds/materialization/artifact.ts";
import type { JsonObject } from "../../../domain/model/records/compiled-model.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";

const encode = (text: string) => new TextEncoder().encode(text);
function range(source: string, text: string): ModelSourceRange {
  const start = source.indexOf(text);
  ok(start >= 0);
  const coordinates = (offset: number) => {
    const prefix = source.slice(0, offset).split("\n");
    return [prefix.length, encode(prefix.at(-1)!).length + 1];
  };
  const [startLine, startColumn] = coordinates(start);
  const [endLine, endColumn] = coordinates(start + text.length);
  return {
    startLine: startLine!,
    startColumn: startColumn!,
    endLine: endLine!,
    endColumn: endColumn!,
    coordinateSystem: "utf8-bytes",
  };
}
function located(source: string, text: string): JsonObject {
  const r = range(source, text);
  return {
    "sysx:sourceLine": r.startLine,
    "sysx:sourceColumn": r.startColumn,
    "sysx:sourceEndLine": r.endLine,
    "sysx:sourceEndColumn": r.endColumn,
    // Deliberately just a header: the reader must use the complete span.
    "sysx:sourceText": text.split("\n")[0] + "\n",
  };
}

async function fixture() {
  const definition =
    "item def Policy {\n        attribute label : String;\n    }";
  const attribute = 'attribute label = "café 😀";';
  const usage =
    `item policy : Definitions::Policy {\n        ${attribute}\n    }`;
  const sources = {
    "defs.sysml": `package Definitions {\n    ${definition}\n}\n`,
    "system.sysml":
      `package System {\n    private import Definitions::*;\n    ${usage}\n}\n`,
  };
  const elements: JsonObject[] = [
    { "@id": "file-system-namespace", "@type": "Namespace" },
    {
      "@id": "defs",
      "@type": "Package",
      declaredName: "Definitions",
      qualifiedName: "Definitions",
      "sysx:sourceDocument": "defs.sysml",
      ...located(sources["defs.sysml"], sources["defs.sysml"].trimEnd()),
    },
    {
      "@id": "definition",
      "@type": "ItemDefinition",
      declaredName: "Policy",
      qualifiedName: "Definitions::Policy",
      owner: { "@id": "defs" },
      ...located(sources["defs.sysml"], definition),
    },
    {
      "@id": "label-definition",
      "@type": "AttributeUsage",
      declaredName: "label",
      qualifiedName: "Definitions::Policy::label",
      owner: { "@id": "definition" },
      ...located(sources["defs.sysml"], "attribute label : String;"),
    },
    {
      "@id": "system",
      "@type": "Package",
      declaredName: "System",
      qualifiedName: "System",
      owner: { "@id": "file-system-namespace" },
      "sysx:sourceDocument": "system.sysml",
      ...located(sources["system.sysml"], sources["system.sysml"].trimEnd()),
    },
    {
      "@id": "usage",
      "@type": "ItemUsage",
      declaredName: "policy",
      qualifiedName: "System::policy",
      owner: { "@id": "system" },
      ...located(sources["system.sysml"], usage),
    },
    {
      "@id": "attribute",
      "@type": "AttributeUsage",
      declaredName: "label",
      qualifiedName: "System::policy::label",
      owner: { "@id": "usage" },
      ...located(sources["system.sysml"], attribute),
    },
    {
      "@id": "value",
      "@type": "LiteralString",
      value: "café 😀",
      owner: { "@id": "attribute" },
      ...located(sources["system.sysml"], '"café 😀"'),
    },
    {
      "@id": "typing",
      "@type": "FeatureTyping",
      owner: { "@id": "usage" },
      source: [{ "@id": "usage" }],
      target: [{ "@id": "definition" }],
    },
    {
      "@id": "feature-value",
      "@type": "FeatureValue",
      owner: { "@id": "attribute" },
      featureWithValue: { "@id": "attribute" },
      value: { "@id": "value" },
    },
  ];
  const revision: ModelRevision = {
    ...await materialize(elements, sources, "test"),
    version: "branch:one",
  };
  const calls = { current: 0, at: [] as string[] };
  const repository = {
    current: () => {
      calls.current++;
      return Promise.resolve(revision);
    },
    at: (version: string) => {
      calls.at.push(version);
      return Promise.resolve({ ...revision, version });
    },
  };
  return { definition, attribute, usage, sources, revision, repository, calls };
}

function code(expected: ModelContextError["code"]) {
  return (error: unknown) =>
    error instanceof ModelContextError && error.code === expected;
}

Deno.test("model context overview is compact and pins source hashes without source bodies", async () => {
  const f = await fixture();
  const reader = new ModelContextReader(f.repository);
  const overview = await reader.overview();
  equal(overview.version, f.revision.version);
  equal(overview.sourceDigest, f.revision.sourceDigest);
  deepStrictEqual(overview.files.map((file) => file.path), [
    "defs.sysml",
    "system.sysml",
  ]);
  equal(overview.files[1]!.sha256, f.revision.sourceHashes["system.sysml"]);
  equal(
    overview.files[1]!.byteLength,
    encode(f.sources["system.sysml"]).length,
  );
  deepStrictEqual(overview.roots.items.map((element) => element.id), [
    "defs",
    "system",
  ]);
  equal(JSON.stringify(overview).includes("café"), false);
  equal(f.calls.current, 1);
  equal(f.calls.at.length, 0);
});

Deno.test("model inspect follows cross-file typing and inherited source paths with exact Unicode spans", async () => {
  const f = await fixture();
  const reader = new ModelContextReader(f.repository);
  const result = await reader.query({
    operation: "inspect",
    version: f.revision.version,
    elementId: "usage",
  });
  equal(result.operation, "inspect");
  if (result.operation !== "inspect") throw new Error("Expected inspection");
  const selected = result.items.find((item) => item.reason === "selected")!;
  equal(selected.source!.content, f.usage);
  equal(selected.source!.path, "system.sysml");
  equal(
    result.items.find((item) => item.element.id === "definition")!.source!
      .content,
    f.definition,
  );
  equal(
    result.items.find((item) => item.element.id === "definition")!.source!.path,
    "defs.sysml",
  );
  equal(
    result.items.find((item) => item.element.id === "attribute")!.source!
      .content,
    f.attribute,
  );
  equal(
    result.items.find((item) => item.reason === "owner")!.sourceUnavailable,
    "summary-only",
  );
  equal(
    result.items.find((item) => item.reason === "owner")!.source,
    undefined,
  );
});

Deno.test("model read_source returns the full exact file and refuses oversized or paginated reads", async () => {
  const f = await fixture();
  const reader = new ModelContextReader(f.repository);
  const result = await reader.query({
    operation: "read_source",
    version: f.revision.version,
    path: "system.sysml",
  });
  equal(result.operation, "read_source");
  if (result.operation !== "read_source") throw new Error("Expected source");
  equal(result.content, f.sources["system.sysml"]);
  equal(result.sha256, f.revision.sourceHashes["system.sysml"]);
  equal(result.characters, f.sources["system.sysml"].length);
  await rejects(
    new ModelContextReader(f.repository, { maxSourceBytes: 1 }).query({
      operation: "read_source",
      version: f.revision.version,
      path: "system.sysml",
    }),
    code("SOURCE_TOO_LARGE"),
  );
  await rejects(
    reader.query({
      operation: "read_source",
      version: f.revision.version,
      path: "system.sysml",
      offset: 0,
    }),
    code("INVALID_REQUEST"),
  );
  await rejects(
    reader.query({
      operation: "read_source",
      version: f.revision.version,
      path: "../system.sysml",
    }),
    code("INVALID_REQUEST"),
  );
  await rejects(
    reader.query({
      operation: "read_source",
      version: f.revision.version,
      path: "missing.sysml",
    }),
    code("NOT_FOUND"),
  );
});

Deno.test("model discovery pagination is stable and marks earlier or later omitted entries", async () => {
  const f = await fixture();
  const reader = new ModelContextReader(f.repository);
  const first = await reader.query({
    operation: "search",
    version: f.revision.version,
    query: "policy",
    limit: 2,
  });
  const second = await reader.query({
    operation: "search",
    version: f.revision.version,
    query: "policy",
    offset: 2,
    limit: 2,
  });
  if (first.operation !== "search" || second.operation !== "search") {
    throw new Error("Expected search");
  }
  equal(first.total, 4);
  equal(first.nextOffset, 2);
  equal(first.truncated, true);
  equal(second.nextOffset, undefined);
  equal(second.truncated, true);
  equal(
    new Set([...first.items, ...second.items].map((item) => item.id)).size,
    4,
  );
  await rejects(
    reader.query({
      operation: "search",
      version: f.revision.version,
      limit: 51,
    }),
    code("INVALID_REQUEST"),
  );
  // The query bound counts characters like the tool schema (maxLength 200).
  await reader.query({
    operation: "search",
    version: f.revision.version,
    query: "😀".repeat(200),
  });
  await rejects(
    reader.query({
      operation: "search",
      version: f.revision.version,
      query: "😀".repeat(201),
    }),
    code("INVALID_REQUEST"),
  );
  await rejects(
    reader.query({
      operation: "search",
      version: f.revision.version,
      offset: -1,
    }),
    code("INVALID_REQUEST"),
  );
  await rejects(
    reader.query({
      operation: "search",
      version: f.revision.version,
      limit: 1.5,
    }),
    code("INVALID_REQUEST"),
  );
});

Deno.test("model references returns stored relation roles and its declared coverage", async () => {
  const f = await fixture();
  const result = await new ModelContextReader(f.repository).query({
    operation: "references",
    version: f.revision.version,
    elementId: "ElementV0/usage",
  });
  if (result.operation !== "references") throw new Error("Expected references");
  equal(result.coverage, "stored-normalized-relations");
  equal(result.items.length, 1);
  equal(result.items[0]!.metaclass, "FeatureTyping");
  deepStrictEqual(
    result.items[0]!.endpoints.map((
      endpoint,
    ) => [endpoint.role, endpoint.element.id]),
    [["source", "usage"], ["target", "definition"]],
  );
});

Deno.test("inspection budgets omit complete declarations instead of cutting source text", async () => {
  const f = await fixture();
  const result = await new ModelContextReader(f.repository, {
    maxInspectSourceBytes: 1,
  }).query({
    operation: "inspect",
    version: f.revision.version,
    elementId: "attribute",
  });
  if (result.operation !== "inspect") throw new Error("Expected inspection");
  equal(result.items[0]!.source, undefined);
  equal(result.items[0]!.sourceUnavailable, "source-budget");
});

Deno.test("model reader refuses forged versions and mismatched repository results", async () => {
  const f = await fixture();
  const reader = new ModelContextReader(f.repository);
  await rejects(
    reader.query({ operation: "search", version: "main" }),
    code("INVALID_REQUEST"),
  );
  await rejects(
    reader.query({ operation: "search", version: "commit:../main" }),
    code("INVALID_REQUEST"),
  );
  equal(f.calls.at.length, 0);
  const mismatched = new ModelContextReader({
    ...f.repository,
    at: () => Promise.resolve({ ...f.revision, version: "branch:other" }),
  });
  await rejects(mismatched.overview("branch:one"), code("VERSION_MISMATCH"));
});

Deno.test("model cache coalesces reads, shares commit aliases, evicts LRU and isolates mutations", async () => {
  const f = await fixture();
  const reader = new ModelContextReader(f.repository, { maxCachedVersions: 2 });
  const [first, concurrent] = await Promise.all([
    reader.overview("branch:one"),
    reader.overview("branch:one"),
  ]);
  equal(f.calls.at.length, 1);
  first.roots.items[0]!.source!.path = "poisoned";
  first.files[0]!.sha256 = "poisoned";
  equal(concurrent.roots.items[0]!.source!.path, "defs.sysml");
  f.revision.sources["system.sysml"] = "external mutation";
  const source = await reader.query({
    operation: "read_source",
    version: "commit:one",
    path: "system.sysml",
  });
  if (source.operation !== "read_source") throw new Error("Expected source");
  ok(source.content.includes("café"));
  equal(source.version, "commit:one");
  equal(f.calls.at.length, 1);
  f.revision.sources["system.sysml"] = source.content;
  await reader.overview("branch:two");
  await reader.overview("branch:one");
  await reader.overview("branch:three");
  await reader.overview("branch:two");
  deepStrictEqual(f.calls.at, [
    "branch:one",
    "branch:two",
    "branch:three",
    "branch:two",
  ]);
});

Deno.test("model reader refuses conflicting explicit source origins", async () => {
  const f = await fixture();
  const paths = f.revision.documents.filter((document) =>
    document["@type"] === "SourcePathV0"
  );
  f.revision.documents.push(
    ...paths.map((path, index) => ({
      "@id": `OriginV0/conflict-${index}`,
      "@type": "OriginV0",
      object: "ElementV0/usage",
      source_path: path["@id"],
    })),
  );
  await rejects(
    new ModelContextReader(f.repository).query({
      operation: "inspect",
      version: f.revision.version,
      elementId: "usage",
    }),
    code("AMBIGUOUS_SOURCE"),
  );
});

Deno.test("UTF-8 source spans handle accents and astral characters and reject split boundaries", () => {
  const source = 'package Test {\n  attribute label = "café 😀";\n}\n';
  const declaration = 'attribute label = "café 😀";';
  equal(utf8SourceSpan(source, range(source, declaration)), declaration);
  equal(utf8SourceSpan(source, range(source, "😀")), "😀");
  const emoji = range(source, "😀");
  throws(
    () =>
      utf8SourceSpan(source, { ...emoji, startColumn: emoji.startColumn + 1 }),
    code("INVALID_SOURCE_RANGE"),
  );
  throws(
    () => utf8SourceSpan(source, { ...emoji, endColumn: 10000 }),
    code("INVALID_SOURCE_RANGE"),
  );
  throws(
    () =>
      utf8SourceSpan(source, {
        ...emoji,
        endLine: emoji.startLine,
        endColumn: emoji.startColumn,
      }),
    code("INVALID_SOURCE_RANGE"),
  );
});
