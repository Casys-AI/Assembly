import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { compareModelGraphDocuments } from "./graph-diff.ts";

type Document = Record<string, unknown>;
const element = (id: string, fields: Document = {}): Document => ({
  "@id": `ElementV0/${id}`,
  "@type": "ElementV0",
  native_id: id,
  metaclass: "AttributeUsage",
  ...fields,
});
function diff(
  patches: unknown,
  before: Document[],
  after: Document[],
  limit = 100,
) {
  return compareModelGraphDocuments({
    patches,
    before,
    after,
    limit,
    fromVersion: "branch:before",
    toVersion: "commit:after",
  });
}
const insert = (doc: Document) => ({ "@op": "Insert", "@insert": doc });
const remove = (doc: Document) => ({ "@op": "Delete", "@delete": doc });

Deno.test("native IR mapper preserves stable identity through rename and literal changes", () => {
  const before = element("name/with/slashes", {
    name: "Old",
    integer_value: 7,
  });
  const after = element("name/with/slashes", { name: "New", integer_value: 8 });
  const result = diff(
    [{
      "@id": before["@id"],
      "@type": "ElementV0",
      name: { "@op": "SwapValue", "@before": "Old", "@after": "New" },
      integer_value: { "@op": "SwapValue", "@before": 7, "@after": 8 },
    }],
    [before],
    [after],
  );
  equal(result.engine, "Git");
  equal(result.fromVersion, "branch:before");
  equal(result.toVersion, "commit:after");
  equal(result.changes[0]!.id, "ElementV0/name/with/slashes");
  equal(result.changes[0]!.nativeId, "name/with/slashes");
  equal(result.changes[0]!.label, "New");
  deepStrictEqual(result.changes[0]!.fields, [
    { field: "integer_value", before: 7, after: 8 },
    { field: "name", before: "Old", after: "New" },
  ]);
  deepStrictEqual(result.counts, { added: 0, removed: 0, changed: 1 });
});

Deno.test("native mapper retains absent versus null, false, zero and empty string", () => {
  const before = element("literal", {
    boolean_value: true,
    integer_value: 2,
    text_value: "text",
    documentation: "remove",
  });
  const after = element("literal", {
    boolean_value: false,
    integer_value: 0,
    text_value: "",
    operator: null,
  });
  const patches = [{
    "@id": before["@id"],
    boolean_value: {},
    integer_value: {},
    text_value: {},
    documentation: {},
    operator: {},
  }];
  deepStrictEqual(diff(patches, [before], [after]).changes[0]!.fields, [
    { field: "boolean_value", before: true, after: false },
    { field: "documentation", before: "remove" },
    { field: "integer_value", before: 2, after: 0 },
    { field: "operator", after: null },
    { field: "text_value", before: "text", after: "" },
  ]);
});

Deno.test("native mapper excludes origins, provider, source, build and repository metadata", () => {
  const documents = [
    "OriginV0",
    "ProviderArtifactV0",
    "SourceSnapshotV0",
    "ModelBuildV0",
    "RepositoryIdentityV1",
  ].map((type) => ({
    "@id": `${type}/test`,
    "@type": type,
    content: "private metadata",
  }));
  const result = diff(documents.map(insert), [], documents);
  deepStrictEqual(result.changes, []);
  deepStrictEqual(result.counts, { added: 0, removed: 0, changed: 0 });
  // A document absent from the validated model projection, such as repository
  // identity, is still safely excluded by its native type.
  deepStrictEqual(diff([insert(documents[4]!)], [], []).changes, []);
});

Deno.test("native endpoint target and position changes retain relationship context without parsing IDs", () => {
  const endpoint = {
    "@id": "EndpointV0/relation/with/slashes/0",
    "@type": "EndpointV0",
    role: "target",
    position: 0,
    target: "ElementV0/a",
  };
  const nextEndpoint = { ...endpoint, position: 1, target: "ElementV0/b" };
  const relation = {
    "@id": "RelationshipV0/relation/with/slashes",
    "@type": "RelationshipV0",
    native_id: "relation/with/slashes",
    metaclass: "FeatureTyping",
    owner: "ElementV0/parent",
    endpoints: [endpoint["@id"], "EndpointV0/other"],
  };
  const reordered = {
    ...relation,
    endpoints: [...relation.endpoints].reverse(),
  };
  const parent = element("parent", {
    name: "Part",
    qualified_name: "System::Part",
  });
  const result = diff(
    [
      { "@id": relation["@id"], endpoints: {} },
      { "@id": endpoint["@id"], position: {}, target: {} },
    ],
    [parent, relation, endpoint],
    [parent, reordered, nextEndpoint],
  );
  equal(result.changes.length, 1);
  const change = result.changes[0]!;
  equal(change.category, "endpoint");
  equal(change.nativeId, relation.native_id);
  equal(change.label, "FeatureTyping Part · target [1]");
  equal(change.qualifiedName, "System::Part");
  deepStrictEqual(change.fields, [
    { field: "position", before: 0, after: 1 },
    { field: "target", before: "ElementV0/a", after: "ElementV0/b" },
  ]);
});

Deno.test("native additions and deletions are stably ordered with exact counts before limit", () => {
  const old = element("z", { name: "Old" });
  const a = element("a", { name: "A" });
  const b = element("b", { name: "B" });
  const result = diff([remove(old), insert(b), insert(a)], [old], [a, b], 2);
  deepStrictEqual(result.changes.map((change) => change.id), [
    "ElementV0/a",
    "ElementV0/b",
  ]);
  equal(result.truncated, true);
  deepStrictEqual(result.counts, { added: 2, removed: 1, changed: 0 });
  deepStrictEqual(diff([], [old], [old]).changes, []);
  equal(diff([remove(old)], [old], []).changes[0]!.kind, "removed");
});

Deno.test("native mapper does not invent changes absent from the engine and rejects invalid evidence", () => {
  const before = element("a", { name: "Old" });
  const after = element("a", { name: "New" });
  deepStrictEqual(diff([], [before], [after]).changes, []);
  throws(() => diff({}, [], []), /patch array/);
  throws(() => diff([null], [], []), /document patch/);
  throws(
    () => diff([insert(after), insert(after)], [], [after]),
    /duplicate patch/,
  );
  throws(() => diff([insert(after)], [before], [after]), /does not match/);
  throws(
    () => diff([{ "@id": after["@id"], "@op": "Unknown" }], [before], [after]),
    /unknown document operation/,
  );
  throws(() => diff([], [], [], 0), /display limit/);
});
