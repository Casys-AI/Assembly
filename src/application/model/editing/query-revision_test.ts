import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import { ExplicitTooling } from "../../../../test/support/explicit-tooling.ts";
import type { SourceRevision } from "../../../domain/model/records/source-revision.ts";
import { queryModelRevision } from "./query-revision.ts";
import {
  modelToolingTarget,
} from "../../../domain/model/editing/source-index.ts";

function fixture(): SourceRevision {
  return {
    version: "commit:exact-base",
    sources: { "model.sysml": "package P {\n  attribute café = 1;\n}\n" },
    elements: [{
      "@id": "open:package",
      "@type": "Package",
      qualifiedName: "P",
      "sysx:sourceDocument": "model.sysml",
    }, {
      "@id": "open:attribute",
      "@type": "AttributeUsage",
      qualifiedName: "P::café",
      owner: { "@id": "open:package" },
      "sysx:sourceLine": 2,
      "sysx:sourceColumn": 3,
      "sysx:sourceEndLine": 2,
      "sysx:sourceEndColumn": 23,
    }],
  };
}

const tooling = (query: unknown) => new ExplicitTooling({ query });

Deno.test("query binds only unique located names from its source revision, not provider UUID coincidence", async () => {
  deepStrictEqual(
    await queryModelRevision(
      tooling([
        { "@element": "toolkit:café", qualifiedName: "P::café" },
        { "@element": "open:attribute", qualifiedName: "Unknown::café" },
        { "@element": "open:attribute" },
        { "@element": "toolkit:package", qualifiedName: "P" },
      ]),
      fixture(),
      "expression",
    ),
    [
      {
        toolkitElementId: "toolkit:café",
        qualifiedName: "P::café",
        elementId: "open:attribute",
      },
      {
        toolkitElementId: "open:attribute",
        qualifiedName: "Unknown::café",
        elementId: null,
      },
      {
        toolkitElementId: "open:attribute",
        qualifiedName: null,
        elementId: null,
      },
      {
        toolkitElementId: "toolkit:package",
        qualifiedName: "P",
        elementId: null,
      },
    ],
  );
  const ambiguous = fixture();
  ambiguous.elements.push({ ...ambiguous.elements[1]!, "@id": "open:other" });
  deepStrictEqual(
    await queryModelRevision(
      tooling({
        "@element": "toolkit:café",
        qualifiedName: "P::café",
      }),
      ambiguous,
      "expression",
    ),
    {
      toolkitElementId: "toolkit:café",
      qualifiedName: "P::café",
      elementId: null,
    },
  );
});

Deno.test("query bounds expressions and results, retaining plain values and nested references", async () => {
  await rejects(
    () => queryModelRevision(tooling(null), fixture(), " "),
    /bounded/,
  );
  await rejects(
    () => queryModelRevision(tooling(null), fixture(), "x".repeat(4097)),
    /bounded/,
  );
  await rejects(
    () => queryModelRevision(tooling("x".repeat(65536)), fixture(), "q"),
    /size limit/,
  );
  const expanded = Array.from({ length: 1000 }, () => ({
    "@element": "t",
    qualifiedName: "P::'café'",
  }));
  equal(
    new TextEncoder().encode(JSON.stringify(expanded)).length < 65536,
    true,
  );
  await rejects(
    () => queryModelRevision(tooling(expanded), fixture(), "q"),
    /size limit after identity binding/,
  );
  const values = {
    value: "12",
    unit: "kg",
    flags: [true, null],
    nested: { count: 3 },
  };
  deepStrictEqual(
    await queryModelRevision(tooling(values), fixture(), "q"),
    values,
  );
});

Deno.test("query qualification recognizes quoted Unicode names without changing stored identities", async () => {
  const f = fixture();
  f.elements[0]!.declaredName = "P";
  f.elements[1]!.declaredName = "café";
  deepStrictEqual(
    await queryModelRevision(
      tooling({
        "@element": "toolkit:unicode",
        qualifiedName: "'P'::'café'",
      }),
      f,
      "q",
    ),
    {
      toolkitElementId: "toolkit:unicode",
      qualifiedName: "'P'::'café'",
      elementId: "open:attribute",
    },
  );
  const ambiguous = fixture();
  ambiguous.elements.push({
    ...ambiguous.elements[1]!,
    "@id": "open:duplicate",
    qualifiedName: "P::'café'",
  });
  throws(
    () => modelToolingTarget(ambiguous, "open:attribute"),
    /ambiguous qualified/,
  );
  const result = await queryModelRevision(
    tooling({
      "@element": "toolkit:unicode",
      qualifiedName: "P::'café'",
    }),
    ambiguous,
    "q",
  ) as { elementId: string | null };
  equal(result.elementId, null);
});

Deno.test("owner and declared names disambiguate literal separators while missing boundary evidence fails closed", async () => {
  const first = "attribute 'a::b' = 1;";
  const second = "attribute b = 2;";
  const f: SourceRevision = {
    version: "commit:delimited-names",
    sources: {
      "model.sysml":
        `package P {\n  ${first}\n  part a {\n    ${second}\n  }\n}\n`,
    },
    elements: [
      {
        "@id": "p",
        "@type": "Package",
        declaredName: "P",
        qualifiedName: "P",
        "sysx:sourceDocument": "model.sysml",
      },
      {
        "@id": "flat",
        "@type": "AttributeUsage",
        declaredName: "a::b",
        qualifiedName: "P::a::b",
        owner: { "@id": "p" },
        "sysx:sourceLine": 2,
        "sysx:sourceColumn": 3,
        "sysx:sourceEndLine": 2,
        "sysx:sourceEndColumn": 3 + first.length,
      },
      {
        "@id": "a",
        "@type": "PartUsage",
        declaredName: "a",
        qualifiedName: "P::a",
        owner: { "@id": "p" },
      },
      {
        "@id": "nested",
        "@type": "AttributeUsage",
        declaredName: "b",
        qualifiedName: "P::a::b",
        owner: { "@id": "a" },
        "sysx:sourceLine": 4,
        "sysx:sourceColumn": 5,
        "sysx:sourceEndLine": 4,
        "sysx:sourceEndColumn": 5 + second.length,
      },
    ],
  };
  deepStrictEqual(modelToolingTarget(f, "flat"), {
    qualifiedName: "'P'::'a::b'",
    metaclass: "AttributeUsage",
    source: { path: "model.sysml", text: first },
  });
  equal(modelToolingTarget(f, "nested").qualifiedName, "P::a::b");
  const result = await queryModelRevision(
    tooling([
      { "@element": "tk:flat", qualifiedName: "P::'a::b'" },
      { "@element": "tk:nested", qualifiedName: "P::a::b" },
    ]),
    f,
    "q",
  ) as Array<{ elementId: string | null }>;
  deepStrictEqual(result.map((entry) => entry.elementId), ["flat", "nested"]);
  delete f.elements[1]!.declaredName;
  throws(() => modelToolingTarget(f, "flat"), /ambiguous qualified/);
  const unknown = await queryModelRevision(
    tooling({
      "@element": "tk:flat",
      qualifiedName: "P::'a::b'",
    }),
    f,
    "q",
  ) as { elementId: string | null };
  equal(unknown.elementId, null);
});

Deno.test("model tool bounds count code points, not UTF-16 units", async () => {
  deepStrictEqual(
    await queryModelRevision(tooling(null), fixture(), "😀".repeat(4096)),
    null,
  );
  await rejects(
    () => queryModelRevision(tooling(null), fixture(), "😀".repeat(4097)),
    /bounded/,
  );
  for (const count of [300, 512]) {
    throws(
      () => modelToolingTarget(fixture(), "😀".repeat(count)),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === "TARGET_MISSING",
    );
  }
});
