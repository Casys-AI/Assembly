import { deepStrictEqual, equal, throws } from "node:assert/strict";
import type { SourceRevision } from "../records/source-revision.ts";
import { modelToolingTarget, resolveModelEdits } from "./source-index.ts";

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
      }] as unknown as import("./tooling.ts").ModelEdit[])
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
