import assert from "node:assert/strict";
import { type NativeViewRecord, projectNativeViews } from "./native-views.ts";
import type { ModelGraphData, ModelGraphNode } from "./graph.ts";
const node = (
  id: string,
  nativeId: string,
  contextPath: string[],
): ModelGraphNode => ({
  id,
  nativeId,
  contextPath,
  role: "usage",
} as ModelGraphNode);
const graph: Pick<ModelGraphData, "nodes"> = {
  nodes: [
    node("builder", "b", ["s", "b"]),
    node("first-propose", "propose", ["s", "promotion1", "propose"]),
    node("second-propose", "propose", ["s", "promotion2", "propose"]),
    node("catalog", "catalog", ["s", "catalog"]),
  ],
};
const record = (
  targetNativeId: string,
  featurePath: string[] = [],
): NativeViewRecord => ({
  nativeId: "actions",
  label: "Actions",
  ownerNativeId: "s",
  exposures: [{
    nativeId: "expose1",
    importedMembershipId: "membership1",
    targetNativeId,
    featurePath,
    recursive: false,
  }],
});
Deno.test("native view uses evidenced context chain and preserves graph ownership", () => {
  const before = structuredClone(graph);
  const result = projectNativeViews([
    record("propose", ["promotion2", "propose"]),
  ], graph);
  assert.deepEqual(result.views[0]!.members[0]!.graphNodeIds, [
    "second-propose",
  ]);
  assert.deepEqual(graph, before);
  assert.deepEqual(result.views[0]!.sourceEvidenceIds, [
    "actions",
    "expose1",
    "membership1",
    "propose",
    "promotion2",
  ]);
});
Deno.test("ambiguous terminal exposure selects no occurrence", () => {
  const result = projectNativeViews([record("propose")], graph);
  assert.equal(result.views[0]!.members[0]!.resolution, "ambiguous");
  assert.deepEqual(result.views[0]!.members[0]!.graphNodeIds, []);
  assert.equal(result.diagnostics.length, 1);
});
Deno.test("nested view is a view reference, not a fabricated owned node", () => {
  const child = record("b");
  const parent = { ...record("actions"), nativeId: "overview" };
  const result = projectNativeViews([child, parent], graph);
  assert.equal(result.views[1]!.members[0]!.nestedViewId, "view:actions");
  assert.deepEqual(result.views[1]!.members[0]!.graphNodeIds, []);
});
Deno.test("recursive exposure expands only the selected occurrence subtree", () => {
  const nestedGraph = {
    nodes: [...graph.nodes, node("child", "child", ["s", "b", "child"])],
  };
  const r = record("b");
  r.exposures[0]!.recursive = true;
  assert.deepEqual(
    projectNativeViews([r], nestedGraph).views[0]!.members[0]!.graphNodeIds,
    ["builder", "child"],
  );
});

Deno.test("namespace exposure selects future direct catalog members without fabricating membership descendants", () => {
  const r = record("catalog");
  r.exposures[0] = {
    ...r.exposures[0]!,
    kind: "namespace",
    importedMembershipId: "",
    importedNamespaceId: "catalog",
    isImportAll: true,
  };
  const tool = {
    ...node("tool", "tool-native", ["s", "catalog", "tool-native"]),
    parentId: "catalog",
  };
  const internal = {
    ...node("tool-detail", "detail", ["s", "catalog", "tool-native", "detail"]),
    parentId: "tool",
  };
  assert.deepEqual(
    projectNativeViews([r], graph).views[0]!.members[0]!.graphNodeIds,
    [],
  );
  const dynamic = { nodes: [...graph.nodes, tool, internal] };
  assert.deepEqual(
    projectNativeViews([r], dynamic).views[0]!.members[0]!.graphNodeIds,
    ["tool"],
  );
  assert.deepEqual(
    projectNativeViews([record("catalog")], dynamic).views[0]!.members[0]!
      .graphNodeIds,
    ["catalog"],
  );
  r.exposures[0]!.recursive = true;
  assert.deepEqual(
    projectNativeViews([r], dynamic).views[0]!.members[0]!.graphNodeIds,
    ["tool", "tool-detail"],
  );
});
Deno.test("namespace exposure refuses an ambiguous namespace occurrence", () => {
  const r = record("catalog");
  r.exposures[0]!.kind = "namespace";
  const result = projectNativeViews([r], {
    nodes: [
      ...graph.nodes,
      node("other-catalog", "catalog", ["other", "catalog"]),
    ],
  });
  assert.equal(result.views[0]!.members[0]!.resolution, "ambiguous");
  assert.deepEqual(result.views[0]!.members[0]!.graphNodeIds, []);
});
