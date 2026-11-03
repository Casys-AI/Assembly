import { h } from "preact";
import { renderToString } from "preact-render-to-string";
import type { GraphDiff } from "../../lib/model/revisions/api.ts";
import GraphRevisionDiff from "./GraphRevisionDiff.tsx";
function assert(value: unknown, detail = "Assertion failed"): asserts value {
  if (!value) throw new Error(detail);
}
function diff(): GraphDiff {
  return {
    fromVersion: "commit:before",
    toVersion: "commit:after",
    engine: "Git",
    counts: { added: 1, removed: 0, changed: 1 },
    truncated: false,
    changes: [{
      id: "SysMLRelationship/edge-1",
      nativeId: "edge-1",
      kind: "changed",
      category: "relationship",
      metaclass: "Dependency",
      label: "Model relation",
      qualifiedName: "System::relation",
      fields: [{ field: "target", before: "part-1", after: "part-2" }],
    }],
  };
}
Deno.test("graph diff renders counts, a collapsed relation and precise before/after fields", () => {
  const output = renderToString(h(GraphRevisionDiff, { diff: diff() }));
  for (
    const text of [
      "+1 added",
      "1 changed",
      "Model relation",
      "Relationship",
      "Dependency",
      "System::relation",
      "SysMLRelationship/edge-1",
      "Before",
      "After",
      "part-1",
      "part-2",
    ]
  ) assert(output.includes(text), text);
  assert(output.includes("<details"));
  assert(!output.includes(" open"), "Details begin collapsed");
  assert(
    !output.includes("d2h-wrapper"),
    "One pane renders model changes only",
  );
});
Deno.test("graph diff safely escapes model values and bounds displayed document fields", () => {
  const data = diff();
  const hostile = "<script>alert('x')</script>";
  data.changes[0].label = hostile;
  data.changes[0].nativeId = hostile;
  data.changes[0].fields = [{
    field: hostile,
    before: { nested: hostile },
    after: hostile + "x".repeat(5000),
  }];
  const output = renderToString(h(GraphRevisionDiff, { diff: data }));
  assert(!output.includes("<script>"));
  assert(output.includes("&lt;script>"));
  assert(output.includes("Value shortened"));
  assert(!output.includes("x".repeat(1201)));
});
Deno.test("graph diff distinguishes loading, unavailable versions, unchanged and partial reads", () => {
  assert(
    renderToString(h(GraphRevisionDiff, { diff: undefined })).includes(
      "Reading model changes",
    ),
  );
  const failure = renderToString(
    h(GraphRevisionDiff, { error: "Version indisponible" }),
  );
  assert(failure.includes('role="alert"'));
  assert(failure.includes("Version indisponible"));
  assert(!failure.includes("Reading model changes"));
  const data = diff();
  data.changes = [];
  data.counts = { added: 0, removed: 0, changed: 0 };
  assert(
    renderToString(h(GraphRevisionDiff, { diff: data })).includes(
      "No element or relationship changes",
    ),
  );
  data.truncated = true;
  const partial = renderToString(h(GraphRevisionDiff, { diff: data }));
  assert(partial.includes("Partial list"));
  assert(partial.includes("No changes in the list received"));
  assert(!partial.includes("No element or relationship changes"));
});

Deno.test("graph identities distinguish the stored IR document from its native SysML identity", () => {
  const data = diff();
  let output = renderToString(h(GraphRevisionDiff, { diff: data }));
  assert(output.includes("SysML identity: <code>edge-1</code>"));
  assert(
    output.includes(
      "Model document: <code>SysMLRelationship/edge-1</code>",
    ),
  );
  data.changes[0].category = "endpoint";
  data.changes[0].id = "EndpointV0/endpoint-1";
  output = renderToString(h(GraphRevisionDiff, { diff: data }));
  assert(
    output.includes("SysML identity of the relationship: <code>edge-1</code>"),
  );
  assert(
    output.includes("Model document: <code>EndpointV0/endpoint-1</code>"),
  );
});
