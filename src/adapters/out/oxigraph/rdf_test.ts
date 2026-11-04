import baselineGzip from "./fixtures/rdf-batches-baseline.json" with {
  type: "json",
};
import fullBaselineGzip from "./fixtures/rdf-full-baseline.json" with {
  type: "json",
};
import { createHash } from "node:crypto";
import { deepStrictEqual, equal, notEqual, throws } from "node:assert/strict";
import type { JsonObject } from "../../../domain/model/records/compiled-model.ts";
import { contextualProjectorVersion } from "../../../application/model/semantic/index-service.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import { parseElementIri } from "./iri.ts";
import { type BuildRef } from "../../../domain/model/value-objects/element-ref.ts";
import {
  ASE_PROPERTY_VOCAB,
  ASE_VOCAB,
  DeterministicRdfModelProjector,
  type ParsedQuad,
  type ParsedTerm,
  parseNQuads,
  projectModelToNQuadBatches,
  projectModelToNQuads,
  propPredicate,
  stringArrayMemberPredicate,
  SYSML_VOCAB,
  XSD,
} from "./rdf.ts";

const digest = (char: string) => char.repeat(64);
const build: BuildRef = {
  repositoryId: "repo-one",
  sourceDigest: digest("1"),
  recipeDigest: digest("2"),
  buildKey: digest("3"),
  artifactDigest: digest("4"),
};

const elements: JsonObject[] = [
  {
    "@id": "pkg",
    "@type": "Package",
    declaredName: "Golden",
    qualifiedName: "Golden",
    ownedMember: [{ "@id": "part" }, { "@id": "attr" }, { "@id": "part" }],
    emptyList: [],
    "sysx:sourceDocument": "model.sysml",
    "sysx:sourceLine": 1,
    "sysx:sourceColumn": 1,
  },
  {
    "@id": "part",
    "@type": "PartUsage",
    declaredName: 'p "quoted"\nline',
    qualifiedName: "Golden::p",
    owner: { "@id": "pkg" },
    typing: [{ "@id": "lib-part-def" }],
    counts: [1, 1, 2],
    ratio: 0.5,
    big: 9007199254740991,
    flag: true,
    missing: null,
    nested: { inner: "v", deep: [true, false] },
    "sysx:sourceDocument": "model.sysml",
    "sysx:sourceLine": 3,
    "sysx:sourceColumn": 8,
  },
  {
    "@id": "attr",
    "@type": "AttributeUsage",
    declaredName: "élément",
    qualifiedName: "Golden::élément",
    owner: { "@id": "pkg" },
  },
  {
    "@id": "lib-part-def",
    "@type": "PartDefinition",
    declaredName: "LibPart",
    qualifiedName: "Lib::LibPart",
  },
];
const libraryNativeIds = ["lib-part-def"];

// Semantic reconstruction from quads: occurrence lists are authoritative.
function reconstruct(quads: ParsedQuad[]): JsonObject[] {
  const bySubject = new Map<string, ParsedQuad[]>();
  const key = (term: ParsedTerm) => `${term.kind}:${term.value}`;
  for (const quad of quads) {
    const list = bySubject.get(key(quad.subject)) ?? [];
    list.push(quad);
    bySubject.set(key(quad.subject), list);
  }
  const value = (term: ParsedTerm): unknown => {
    if (term.kind === "literal") {
      if (term.datatype === XSD.integer || term.datatype === XSD.double) {
        return Number(term.value);
      }
      if (term.datatype === XSD.boolean) return term.value === "true";
      return term.value;
    }
    if (term.kind === "iri") {
      if (term.value === ASE_VOCAB.nullValue) return null;
      return { "@id": parseElementIri(term.value).nativeId };
    }
    if (
      (bySubject.get(key(term)) ?? []).some((quad) =>
        quad.predicate === ASE_VOCAB.rdfType &&
        quad.object.kind === "iri" &&
        quad.object.value === ASE_VOCAB.occurrenceList
      )
    ) return listValues(term);
    return record(term);
  };
  const listValues = (term: ParsedTerm): unknown[] => {
    const occurrences = (bySubject.get(key(term)) ?? [])
      .filter((quad) => quad.predicate === ASE_VOCAB.occurrence)
      .map((quad) => {
        const parts = bySubject.get(key(quad.object)) ?? [];
        const index = parts.find((q) => q.predicate === ASE_VOCAB.index)!;
        const held = parts.find((q) => q.predicate === ASE_VOCAB.value)!;
        return {
          index: Number((index.object as { value: string }).value),
          value: value(held.object),
        };
      });
    return occurrences.sort((a, b) => a.index - b.index).map((o) => o.value);
  };
  const record = (subject: ParsedTerm): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const quad of bySubject.get(key(subject)) ?? []) {
      if (quad.predicate.startsWith("urn:ase:vocab:list:")) {
        const property = decodeURIComponent(
          quad.predicate.slice("urn:ase:vocab:list:".length),
        );
        out[property] = listValues(quad.object);
      }
    }
    for (const quad of bySubject.get(key(subject)) ?? []) {
      const prefix = quad.predicate.startsWith(SYSML_VOCAB)
        ? SYSML_VOCAB
        : quad.predicate.startsWith(ASE_PROPERTY_VOCAB)
        ? ASE_PROPERTY_VOCAB
        : undefined;
      if (!prefix) continue;
      const property = decodeURIComponent(quad.predicate.slice(prefix.length));
      if (property in out) continue; // list form already authoritative
      out[property] = value(quad.object);
    }
    return out;
  };
  const rebuilt: JsonObject[] = [];
  for (const quad of quads) {
    if (quad.predicate !== ASE_VOCAB.nativeId) continue;
    const nativeId = (quad.object as { value: string }).value;
    const own = bySubject.get(key(quad.subject)) ?? [];
    const metaclass = own.find((q) => q.predicate === ASE_VOCAB.metaclass)!;
    rebuilt.push({
      "@id": nativeId,
      "@type": (metaclass.object as { value: string }).value,
      ...record(quad.subject),
    });
  }
  return rebuilt.sort((a, b) => String(a["@id"]) < String(b["@id"]) ? -1 : 1);
}

Deno.test("projection roundtrips ids, types, typed values, names and sources", () => {
  const { nquads } = projectModelToNQuads({
    build,
    elements,
    libraryNativeIds,
  });
  const expected = [...elements].sort((a, b) =>
    String(a["@id"]) < String(b["@id"]) ? -1 : 1
  );
  deepStrictEqual(reconstruct(parseNQuads(nquads)), expected);
});

Deno.test("lists preserve order, duplicates and emptiness", () => {
  const { nquads } = projectModelToNQuads({
    build,
    elements,
    libraryNativeIds,
  });
  const rebuilt = reconstruct(parseNQuads(nquads));
  const pkg = rebuilt.find((e) => e["@id"] === "pkg")!;
  deepStrictEqual(pkg.ownedMember, [
    { "@id": "part" },
    { "@id": "attr" },
    { "@id": "part" },
  ]);
  deepStrictEqual(pkg.emptyList, []);
  const part = rebuilt.find((e) => e["@id"] === "part")!;
  deepStrictEqual(part.counts, [1, 1, 2]);
});

Deno.test("projection bytes are deterministic under input reordering", () => {
  const first = projectModelToNQuads({ build, elements, libraryNativeIds });
  const shuffled = [...elements].reverse().map((element) =>
    Object.fromEntries(Object.entries(element).reverse())
  );
  const second = projectModelToNQuads({
    build,
    elements: shuffled,
    libraryNativeIds,
  });
  equal(second.nquads, first.nquads);
  equal(second.quadCount, first.quadCount);
  // Every quad sits in the build graph; lines are sorted, newline-ended.
  equal(first.nquads.endsWith("\n"), true);
  for (const quad of parseNQuads(first.nquads)) {
    equal(quad.graph, `urn:ase:build:${digest("4")}`);
  }
});

Deno.test("batched projection retains complete facts and the new vocabulary identity", async () => {
  const input = { build, elements, libraryNativeIds };
  const projector = new DeterministicRdfModelProjector();
  const result = await projector.project(input);
  equal(result.quadCount, 91);
  notEqual(
    result.projection.projectionDigest,
    "3e17c5e666675c4427bf642fcc09d7cae36c7841dc7f4dbb9d6e417dcc1b6ae9",
  );
  equal(
    result.projection.projectorVersion,
    "ase-rdf-quads-v4:b8cfa7a1b59439365b854b71efc97335980247be846b9a5605f249b7fe1dfd3e",
  );
  const reordered = await projector.project({
    ...input,
    elements: [...elements].reverse(),
  });
  deepStrictEqual(reordered, result);
  deepStrictEqual(
    result.quads,
    new TextEncoder().encode(projectModelToNQuads(input).nquads),
  );
  const empty = await projector.project({ ...input, elements: [] });
  equal(empty.quads.length, 0);
  equal(empty.quadCount, 0);
  equal(
    empty.projection.projectionDigest,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

Deno.test("production batches preserve mapped baseline content under the new vocabulary", async () => {
  // The compressed fixture was generated by the projector at cc4c4d7.
  const elements = Array.from({ length: 32 }, (_, i) => ({
    "@id": `large-${String(i).padStart(2, "0")}`,
    "@type": "PartUsage",
    documentation: `document ${i} ` + "é😀x".repeat(12000),
    reference: { "@id": "lib-part-def" },
  }));
  const input = { build, elements, libraryNativeIds };
  equal([...projectModelToNQuadBatches(input).batches].length >= 3, true);
  const result = await new DeterministicRdfModelProjector().project(input);
  equal(result.quadCount, 160);
  const compressed = Uint8Array.from(
    atob(baselineGzip),
    (byte) => byte.charCodeAt(0),
  );
  const baseline = await new Response(
    new Blob([compressed]).stream().pipeThrough(
      new DecompressionStream("gzip"),
    ),
  ).arrayBuffer();
  const mapped = new TextDecoder().decode(baseline)
    .replaceAll("<urn:ase:metaclass:", `<${SYSML_VOCAB}`)
    .replaceAll("<urn:ase:vocab:prop:", `<${SYSML_VOCAB}`)
    .trimEnd().split("\n").sort().join("\n") + "\n";
  deepStrictEqual(result.quads, new TextEncoder().encode(mapped));
});

Deno.test("compact blank nodes preserve every baseline statement under a bijection", async () => {
  // Immutable e53fc125 v2 output for this fixture, before vocabulary mapping.
  const compressed = Uint8Array.from(
    atob(fullBaselineGzip),
    (c) => c.charCodeAt(0),
  );
  const bytes = await new Response(
    new Blob([compressed]).stream().pipeThrough(
      new DecompressionStream("gzip"),
    ),
  ).text();
  const old = parseNQuads(
    bytes.replaceAll("<urn:ase:metaclass:", `<${SYSML_VOCAB}`)
      .replaceAll("<urn:ase:vocab:prop:", `<${SYSML_VOCAB}`)
      .replaceAll(`<${SYSML_VOCAB}sysx%3A`, `<${ASE_PROPERTY_VOCAB}sysx%3A`),
  );
  const current = parseNQuads(
    projectModelToNQuads({ build, elements, libraryNativeIds }).nquads,
  );
  // Refine each blank node by its incoming and outgoing statements until this
  // finite fixture is distinguished, then establish a one-to-one mapping.
  const signatures = (quads: ParsedQuad[]) => {
    const blanks = new Set(
      quads.flatMap((q) =>
        [q.subject, q.object].filter((t) => t.kind === "blank").map((t) =>
          t.value
        )
      ),
    );
    let colors = new Map([...blanks].map((id) => [id, "blank"]));
    const encode = (term: ParsedTerm) =>
      term.kind === "blank"
        ? `blank:${colors.get(term.value)}`
        : JSON.stringify(term);
    for (let round = 0; round < 12; round++) {
      const next = new Map<string, string>();
      for (const id of blanks) {
        const facts = quads.flatMap((q) => [
          ...(q.subject.kind === "blank" && q.subject.value === id
            ? [`out:${q.predicate}:${encode(q.object)}:${q.graph}`]
            : []),
          ...(q.object.kind === "blank" && q.object.value === id
            ? [`in:${q.predicate}:${encode(q.subject)}:${q.graph}`]
            : []),
        ]).sort();
        next.set(
          id,
          createHash("sha256").update(JSON.stringify(facts)).digest("hex"),
        );
      }
      colors = next;
    }
    return colors;
  };
  const oldColors = signatures(old);
  const newColors = signatures(current);
  const groups = (colors: Map<string, string>) => {
    const byColor = new Map<string, string[]>();
    for (const [id, color] of colors) {
      byColor.set(color, [...(byColor.get(color) ?? []), id]);
    }
    return byColor;
  };
  const oldGroups = groups(oldColors);
  const newGroups = groups(newColors);
  deepStrictEqual([...oldGroups.keys()].sort(), [...newGroups.keys()].sort());
  const mapping = new Map<string, string>();
  for (const [color, ids] of oldGroups) {
    const targets = newGroups.get(color)!;
    equal(ids.length, targets.length);
    ids.sort().forEach((id, i) => mapping.set(id, targets.sort()[i]!));
  }
  const normalized = (quads: ParsedQuad[], map: Map<string, string>) =>
    quads.map((q) =>
      JSON.stringify({
        ...q,
        subject: q.subject.kind === "blank"
          ? { ...q.subject, value: map.get(q.subject.value)! }
          : q.subject,
        object: q.object.kind === "blank"
          ? { ...q.object, value: map.get(q.object.value)! }
          : q.object,
      })
    ).sort();
  deepStrictEqual(
    normalized(old, mapping),
    normalized(current, new Map([...newColors.keys()].map((id) => [id, id]))),
  );
});

Deno.test("batches respect UTF-8 byte targets without splitting quads", async () => {
  const input = {
    build,
    libraryNativeIds,
    elements: [{
      "@id": "unicode",
      "@type": "PartUsage",
      documentation: "é😀".repeat(150),
      description: "unpaired surrogate \uD800",
    }],
  };
  const target = 250;
  const projected = await new DeterministicRdfModelProjector().project(input);
  equal(
    projected.projection.projectionDigest,
    "023a201a83845daa6557382a4d65b506d09e243410313bf2671c6d831b40509a",
  );
  // cc4c4d7 output mapped to the new class/property IRIs and sorted.
  const result = projectModelToNQuadBatches(input, target);
  const batches = [...result.batches];
  const encoder = new TextEncoder();
  equal(batches.length > 1, true);
  equal(batches.join(""), projectModelToNQuads(input).nquads);
  equal(result.byteLength, encoder.encode(batches.join("")).length);
  deepStrictEqual(
    projected.quads,
    encoder.encode(batches.join("")),
  );
  for (const batch of batches) {
    equal(batch.endsWith("\n"), true);
    if (encoder.encode(batch).length > target) {
      equal(batch.split("\n").length, 2);
    }
  }
  for (
    const limit of [
      0,
      -1,
      1.5,
      Number.NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]
  ) {
    throws(() => projectModelToNQuadBatches(input, limit), {
      code: "RDF_PROJECTION_INVALID",
    });
  }
});

Deno.test("repository scope prevents cross-repository element collisions", async () => {
  const projector = new DeterministicRdfModelProjector();
  const one = await projector.project({ build, elements, libraryNativeIds });
  const two = await projector.project({
    build: { ...build, repositoryId: "repo-two" },
    elements,
    libraryNativeIds,
  });
  // Same A → same graph name, but element IRIs (and bytes) differ.
  equal(one.projection.artifactDigest, two.projection.artifactDigest);
  notEqual(one.projection.projectionDigest, two.projection.projectionDigest);
  const textOne = new TextDecoder().decode(one.quads);
  equal(textOne.includes("<urn:ase:model:repo-one:part>"), true);
  equal(textOne.includes("<urn:ase:model:repo-two:part>"), false);
  // Library elements are shared, never repository-scoped.
  equal(textOne.includes("<urn:ase:library:lib-part-def>"), true);
  equal(
    new TextDecoder().decode(two.quads).includes(
      "<urn:ase:library:lib-part-def>",
    ),
    true,
  );
});

Deno.test("projection digest authenticates the bytes and is not A", async () => {
  const projector = new DeterministicRdfModelProjector();
  const projected = await projector.project({
    build,
    elements,
    libraryNativeIds,
  });
  equal(
    projected.projection.projectionDigest,
    await sha256(new TextDecoder().decode(projected.quads)),
  );
  notEqual(projected.projection.projectionDigest, build.artifactDigest);
  equal(projected.projection.kind, "rdf-quads");
  // Another artifact version moves the graph even for equal elements.
  const other = await projector.project({
    build: { ...build, artifactDigest: digest("7") },
    elements,
    libraryNativeIds,
  });
  equal(
    new TextDecoder().decode(other.quads).includes(
      `<urn:ase:build:${digest("7")}>`,
    ),
    true,
  );
  notEqual(
    other.projection.projectionDigest,
    projected.projection.projectionDigest,
  );
});

Deno.test("canonical Toolkit properties stay primary, aliases explicit", () => {
  const { nquads } = projectModelToNQuads({
    build,
    elements,
    libraryNativeIds,
  });
  equal(nquads.includes(`<${propPredicate("ownedMember")}>`), true);
  equal(nquads.includes(`<${propPredicate("sysx:sourceDocument")}>`), true);
  equal(nquads.includes(`<${ASE_VOCAB.name}>`), true);
  equal(nquads.includes(`<${ASE_VOCAB.qualifiedName}>`), true);
  equal(nquads.includes("<https://www.omg.org/spec/SysML#PartUsage>"), true);
});

Deno.test("malformed element graphs are refused at the boundary", () => {
  for (
    const bad of [
      [{ "@type": "PartUsage" }],
      [{ "@id": "x" }],
      [{ "@id": "x", "@type": "T" }, { "@id": "x", "@type": "T" }],
      [{ "@id": "x", "@type": "T", bad: Number.POSITIVE_INFINITY }],
      [{ "@id": "x", "@type": "T", bad: Number.NaN }],
    ] as JsonObject[][]
  ) {
    throws(() =>
      projectModelToNQuads({ build, elements: bad, libraryNativeIds: [] })
    );
  }
  throws(() =>
    projectModelToNQuads({
      build: { ...build, artifactDigest: "not-a" },
      elements,
      libraryNativeIds,
    })
  );
});

Deno.test("the N-Quads reader refuses malformed lines", () => {
  throws(() => parseNQuads("<a> <b> <c>\n"));
  throws(() => parseNQuads('"literal" <b> <c> .\n'));
  throws(() => parseNQuads("<a> <b> <c> <d> extra .\n"));
  deepStrictEqual(parseNQuads(""), []);
});

Deno.test("contextual version authenticates repository and library metadata but not S/R/K", async () => {
  const projector = new DeterministicRdfModelProjector();
  const input = { build, elements, libraryNativeIds };
  const first = await projector.project(input);
  for (const version of ["ase-rdf-quads-v2", "ase-rdf-quads-v3"]) {
    const oldVersion = await contextualProjectorVersion(
      version,
      build,
      libraryNativeIds,
    );
    notEqual(first.projection.projectorVersion, oldVersion);
  }
  equal(first.projection.artifactDigest, build.artifactDigest);
  const same = await projector.project({
    ...input,
    build: {
      ...build,
      sourceDigest: digest("5"),
      recipeDigest: digest("6"),
      buildKey: digest("7"),
    },
    libraryNativeIds: [libraryNativeIds[0]!, libraryNativeIds[0]!],
  });
  deepStrictEqual(first, same);
  const otherRepo = await projector.project({
    ...input,
    build: { ...build, repositoryId: "repo-two" },
  });
  const otherClassification = await projector.project({
    ...input,
    libraryNativeIds: [],
  });
  notEqual(
    first.projection.projectorVersion,
    otherRepo.projection.projectorVersion,
  );
  notEqual(
    first.projection.projectorVersion,
    otherClassification.projection.projectorVersion,
  );
  equal(first.projection.projectorVersion.length <= 128, true);
  throws(() => projectModelToNQuads({ ...input, libraryNativeIds: [""] }));
});

Deno.test("compact blank nodes keep distinct paths and nested values roundtrip", async () => {
  const adversarial: JsonObject[] = [{
    "@id": "native_actual_id",
    "@type": "PartUsage",
    a_b: { leaf: "one segment", members: [{ value: 1 }, { value: 1 }] },
    a: { x5F: { b: { leaf: "three segments", members: [{ value: 2 }] } } },
    _: { leaf: "underscore", values: ["first", "first", "last"] },
    "": {
      x5F: { "": { leaf: "empty surrounding segments", values: ["other"] } },
    },
    "é_": { leaf: "unicode and escape", items: [[1, 1], [2]] },
    "#0": { v: { leaf: "property names resembling internal list paths" } },
  }];
  const input = { build, elements: adversarial, libraryNativeIds: [] };
  const projected = projectModelToNQuads(input);
  const quads = parseNQuads(projected.nquads);
  deepStrictEqual(reconstruct(quads), adversarial);
  const objectFor = (property: string) =>
    quads.find((quad) =>
      quad.subject.kind === "iri" &&
      quad.subject.value === "urn:ase:model:repo-one:native_actual_id" &&
      quad.predicate === propPredicate(property)
    )!.object;
  const shortPath = objectFor("a_b");
  const firstNested = objectFor("a");
  const secondNested = quads.find((quad) =>
    quad.subject.kind === "blank" &&
    quad.subject.value === firstNested.value &&
    quad.predicate === propPredicate("x5F")
  )!.object;
  const longPath = quads.find((quad) =>
    quad.subject.kind === "blank" &&
    quad.subject.value === secondNested.value &&
    quad.predicate === propPredicate("b")
  )!.object;
  notEqual(shortPath.value, longPath.value);
  const reordered = Object.fromEntries(
    Object.entries(adversarial[0]!).reverse(),
  ) as JsonObject;
  equal(
    projectModelToNQuads({ ...input, elements: [reordered] }).nquads,
    projected.nquads,
  );
  const result = await new DeterministicRdfModelProjector().project(input);
  equal(
    result.projection.projectorVersion.startsWith("ase-rdf-quads-v4:"),
    true,
  );
});

Deno.test("JSON string arrays retain their literal and expose only string members", () => {
  const { nquads } = projectModelToNQuads({
    build,
    libraryNativeIds: [],
    elements: [{
      "@id": "json",
      "@type": "LiteralString",
      value: '["a","b","a"]',
      invalid: '["a",1]',
      malformed: "[oops]",
      empty: "[]",
    }],
  });
  const quads = parseNQuads(nquads);
  equal(
    quads.some((q) =>
      q.predicate === propPredicate("value") &&
      q.object.value === '["a","b","a"]'
    ),
    true,
  );
  deepStrictEqual(
    quads.filter((q) => q.predicate === stringArrayMemberPredicate("value"))
      .map((q) => q.object.value).sort(),
    ["a", "b"],
  );
  equal(
    quads.some((q) =>
      ["invalid", "malformed", "empty"].some((p) =>
        q.predicate === stringArrayMemberPredicate(p)
      )
    ),
    false,
  );
});
