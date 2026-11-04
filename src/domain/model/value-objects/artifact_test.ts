import {
  deepStrictEqual,
  equal,
  notEqual,
  ok,
  rejects,
} from "node:assert/strict";
import type { JsonObject } from "../records/compiled-model.ts";
import { materialize, sha256 as artifactSha256 } from "./artifact.ts";
import {
  canonical,
  compareCodeUnits,
} from "../../primitives/canonical-json.ts";
import { sha256 } from "../../primitives/execution-digest.ts";

Deno.test("artifact SHA preserves byte-view hashing and rejects undefined", async () => {
  const bytes = new Uint8Array([0, 97, 98, 99, 255]);
  equal(
    await artifactSha256(bytes.subarray(1, 4)),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  await rejects(
    () => artifactSha256(undefined as unknown as Uint8Array),
    TypeError,
  );
});

Deno.test("all artifact ID sorts preserve legacy en-US bytes for admitted native IDs", async () => {
  const elements = [
    "aa",
    "z",
    "B",
    "a_b",
    "a-b",
    "a1",
    "a_1",
    "I",
    "i",
    "ı",
    "İ",
    "é",
    "e\u0301",
  ].map((id) => ({
    "@id": id,
    "@type": "PartUsage",
    "sysx:sourceDocument": "model.sysml",
  }));
  const compiled = await materialize(
    elements,
    { "model.sysml": "part p;" },
    "fixture",
  );
  const legacyOrder = (left: JsonObject, right: JsonObject) =>
    String(left["@id"]).localeCompare(String(right["@id"]), "en-US");
  const semantic = compiled.documents.filter((d) =>
    ["ElementV0", "EndpointV0", "RelationshipV0"].includes(String(d["@type"]))
  );
  const origins = compiled.documents.filter((d) => d["@type"] === "OriginV0");
  equal(origins.length, elements.length);
  equal(
    compiled.semanticDigest,
    await sha256(canonical(semantic.toSorted(legacyOrder))),
  );
  equal(
    compiled.provenanceDigest,
    await sha256(canonical(origins.toSorted(legacyOrder))),
  );
  const provider = compiled.documents.find((d) =>
    d["@type"] === "ProviderArtifactV0"
  )!;
  equal(provider.content, canonical(elements.toSorted(legacyOrder)));
  notEqual(
    provider.content,
    canonical(
      elements.toSorted((a, b) => compareCodeUnits(a["@id"], b["@id"])),
    ),
  );
});

Deno.test("Materialization preserves declared IDs for historical snapshot readback compatibility", async () => {
  const elements: JsonObject[] = [
    {
      "@id": "explicit",
      "@type": "PartUsage",
      "sysx:declaredId": true,
    },
    {
      "@id": "implicit",
      "@type": "PartUsage",
      "sysx:declaredId": false,
    },
    { "@id": "absent", "@type": "PartUsage" },
  ];
  const sources = {
    "model.sysml": "part explicit; part implicit; part absent;",
  };
  const compiled = await materialize(elements, sources, "fixture-engine");
  const documents: JsonObject[] = JSON.parse(
    JSON.stringify(compiled.documents),
  );
  const elementDocument = (id: string) => {
    const document = documents.find((document) =>
      document["@type"] === "ElementV0" && document.native_id === id
    );
    ok(document);
    return document;
  };
  equal(elementDocument("explicit").declared_id, true);
  equal(elementDocument("implicit").declared_id, false);
  equal(Object.hasOwn(elementDocument("absent"), "declared_id"), false);

  const withoutDeclaredId = await materialize(
    elements.map((element) => {
      const copy = { ...element };
      if (copy["@id"] === "explicit") delete copy["sysx:declaredId"];
      return copy;
    }),
    sources,
    "fixture-engine",
  );
  notEqual(compiled.semanticDigest, withoutDeclaredId.semanticDigest);
  const repeated = await materialize(elements, sources, "fixture-engine");
  deepStrictEqual(repeated, compiled);
  equal(JSON.stringify(repeated), JSON.stringify(compiled));
});
