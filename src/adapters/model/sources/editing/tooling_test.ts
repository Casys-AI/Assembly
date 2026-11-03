import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import { ExplicitTooling } from "../../../../../test/support/explicit-tooling.ts";
import type { SourceRevision } from "../source-model.ts";
import {
  modelToolingTarget,
  queryModelRevision,
  resolveModelEdits,
} from "./tooling.ts";

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

Deno.test("target location follows native owners and keeps the UTF-8 declaration exact", () => {
  deepStrictEqual(modelToolingTarget(fixture(), "open:attribute"), {
    qualifiedName: "P::café",
    metaclass: "AttributeUsage",
    source: { path: "model.sysml", text: "attribute café = 1;" },
  });
  const cycle = fixture();
  cycle.elements[0]!.owner = { "@id": "open:attribute" };
  delete cycle.elements[0]!["sysx:sourceDocument"];
  throws(() => modelToolingTarget(cycle, "open:attribute"), /source bundle/);
  const external = fixture();
  external.elements[0]!["sysx:sourceDocument"] = "other.sysml";
  throws(() => modelToolingTarget(external, "open:attribute"), /source bundle/);
  throws(() => modelToolingTarget(fixture(), "toolkit:attribute"), /absent/);
});

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

Deno.test("type edits resolve one immutable target and safely spell the native type", () => {
  const revision = fixture();
  const original = structuredClone(revision);
  for (
    const [typeName, type] of [
      ["ScalarValues::String", "'ScalarValues'::'String'"],
      ["::Flows::Private", "::'Flows'::'Private'"],
      ["Flows::'révision-台灣'", "'Flows'::'révision-台灣'"],
      ["'L\\'atelier'::'a\\\\b'", "'L\\'atelier'::'a\\\\b'"],
    ]
  ) {
    deepStrictEqual(
      resolveModelEdits(revision, [{
        kind: "set-type",
        elementId: "open:attribute",
        typeName,
      }]),
      [{
        kind: "set-type",
        target: modelToolingTarget(revision, "open:attribute"),
        type,
      }],
    );
  }
  deepStrictEqual(revision, original);
  throws(() =>
    resolveModelEdits(revision, [{
      kind: "set-type",
      elementId: "stale-native-id",
      typeName: "Flows::Private",
    }]), /absent/);
  for (
    const typeName of [
      "",
      "T".repeat(4097),
      "A::'unclosed",
      "T; attribute injected = 1;",
      "T { attribute injected = 1; }",
    ]
  ) {
    throws(() =>
      resolveModelEdits(revision, [{
        kind: "set-type",
        elementId: "open:attribute",
        typeName,
      }]), /bounded native type name/);
  }
});

Deno.test("safe native type spelling retains the bridge UTF-8 byte bound", () => {
  const revision = fixture();
  for (const typeName of ["T".repeat(4094), "'" + "😀".repeat(1023) + "'"]) {
    const [resolved] = resolveModelEdits(revision, [{
      kind: "set-type",
      elementId: "open:attribute",
      typeName,
    }]);
    if (resolved.kind !== "set-type") throw new Error("Expected a type edit");
    equal(new TextEncoder().encode(resolved.type).length <= 4096, true);
  }
  for (
    const typeName of [
      "T".repeat(4095),
      "T".repeat(4096),
      "'" + "😀".repeat(1024) + "'",
    ]
  ) {
    throws(() =>
      resolveModelEdits(revision, [{
        kind: "set-type",
        elementId: "open:attribute",
        typeName,
      }]), /Native type spelling exceeds the 4096-byte limit/);
  }
});

Deno.test("agents cannot request host replacement or host-only type fields", () => {
  for (
    const edit of [
      { kind: "replace-member", text: "attribute café = 2;" },
      { kind: "set-type", type: "ScalarValues::String" },
      { kind: "set-type", typeName: "ScalarValues::String", extra: true },
    ]
  ) {
    throws(() =>
      resolveModelEdits(fixture(), [{
        ...edit,
        elementId: "open:attribute",
      }] as unknown as import("../../../../domain/model/editing/tooling.ts").ModelEdit[])
    );
  }
});

Deno.test("agents cannot address anonymous members, host opt-in resolves @id", () => {
  const revision = fixture();
  revision.elements.push({
    "@id": "open:anonymous",
    "@type": "AllocationUsage",
    owner: { "@id": "open:package" },
    "sysx:sourceDocument": "model.sysml",
    "sysx:sourceLine": 2,
    "sysx:sourceColumn": 3,
    "sysx:sourceEndLine": 2,
    "sysx:sourceEndColumn": 23,
  });
  throws(
    () => modelToolingTarget(revision, "open:anonymous"),
    /named declaration/,
  );
  for (
    const edit of [
      { kind: "set-value", elementId: "open:anonymous", expression: "2" },
      { kind: "rename", elementId: "open:anonymous", name: "renamed" },
      {
        kind: "insert-member",
        elementId: "open:anonymous",
        text: "attribute added = 1;",
      },
      { kind: "remove", elementId: "open:anonymous" },
      { kind: "set-type", elementId: "open:anonymous", typeName: "P::Flow" },
    ] as const
  ) {
    throws(() => resolveModelEdits(revision, [edit]), /named declaration/);
  }
  deepStrictEqual(
    modelToolingTarget(revision, "open:anonymous", { allowAnonymous: true }),
    {
      qualifiedName: "@open:anonymous",
      metaclass: "AllocationUsage",
      source: { path: "model.sysml", text: "attribute café = 1;" },
    },
  );
});

Deno.test("reference edits retain exact IDs and site on the immutable source", () => {
  const revision = fixture();
  const edit = {
    kind: "retarget-reference" as const,
    fromId: "open:attribute",
    toId: "open:package",
    site: {
      unit: "model.sysml",
      line: 2,
      col: 13,
      endLine: 2,
      endCol: 17,
      kind: "reference",
      ownerId: "anonymous-owner",
      chainRootId: null,
      preimage: "café",
    },
  };
  deepStrictEqual(resolveModelEdits(revision, [edit]), [edit]);
  throws(
    () => resolveModelEdits(revision, [{ ...edit, toId: "missing" }]),
    /Missing source declaration/,
  );
  throws(
    () =>
      resolveModelEdits(revision, [{
        ...edit,
        site: { ...edit.site, unit: "outside.sysml" },
      }]),
    /immutable source bundle/,
  );
});
