import { createElement } from "preact";
import { renderToString as render } from "preact-render-to-string";
import type {
  GraphNode,
  NativeModelView as NativeView,
} from "../../lib/graph/types.ts";
import {
  defaultDiagramOptions,
  DiagramModel,
} from "../../lib/graph/view-model.ts";
import { OperatorDetails } from "./GraphInspector.tsx";
import { mandateFixture as fixture } from "../../test/support/mandate-fixture.ts";
function assert(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}
Deno.test("shared catalog does not imply invocation rights; inspector escapes explicit binding", () => {
  const f = fixture();
  f.nodes.push({
    id: "catalog:active",
    nativeId: "active-tool",
    label: "Shared active tool",
    runtimeStage: "active",
    role: "usage",
    category: "part",
  });
  const inspect = (node: GraphNode) =>
    render(
      createElement(OperatorDetails, {
        model: new DiagramModel(f, defaultDiagramOptions()),
        node,
      }),
    );
  const without = inspect(f.holder);
  assert(
    !without.includes("May invoke"),
    "Catalog membership inferred operator permission",
  );
  assert(
    without.includes("not documented"),
    "Unknown granting operator was invented",
  );
  f.holder.operator!.capabilityBindings = [{
    kind: "read-page",
    relationship: "may-invoke",
    nativeId: "active-tool",
    name: '<img src=x onerror="bad">',
    sourceRefs: ["host policy"],
    evidenceLevel: "configured",
  }];
  const activeTool = f.nodes.at(-1)!;
  activeTool.runtimeStage = "testing";
  assert(
    !inspect(f.holder).includes("May invoke"),
    "Unadmitted candidate received invocation permission",
  );
  activeTool.runtimeStage = "active";
  const withBinding = inspect(f.holder);
  assert(
    withBinding.includes("May invoke") && withBinding.includes("&lt;img"),
    "Explicit permission missing or unescaped",
  );
  assert(!withBinding.includes("<img"), "Model metadata injected HTML");
});

Deno.test("clicking the operator or its native scope exposes the same verified network mandate", () => {
  const f = fixture();
  const frame = {
    id: "view:scope",
    nativeId: "scope",
    label: "Selected actions",
    role: "usage",
    category: "view",
  };
  const view: NativeView = {
    id: frame.id,
    nativeId: frame.nativeId,
    label: frame.label,
    ownerNativeId: "namespace",
    members: [{
      nativeId: "expose",
      resolution: "resolved",
      graphNodeIds: [f.holder.id, f.action.id],
    }],
  };
  const overview: NativeView = {
    id: "view:overview",
    nativeId: "overview",
    label: "overview",
    members: [{ resolution: "resolved", nestedViewId: view.id }],
  };
  const graph = { ...f, views: [view, overview] };
  f.holder.mandate.networkScope = {
    allowedHosts: [],
    sourceRefs: ["native-network-literal"],
  };
  const inspect = (node: GraphNode) =>
    render(
      createElement(OperatorDetails, {
        model: new DiagramModel(graph, defaultDiagramOptions()),
        node,
      }),
    );
  for (const target of [f.holder, frame]) {
    const text = inspect(target);
    assert(
      text.includes("Configured mandate") &&
        text.includes("No allowed domain."),
      "Verified scope missing from operator or frame inspector",
    );
    assert(
      text.includes("native-network-literal"),
      "Native network proof missing",
    );
  }
  f.holder.mandate!.networkScope = {
    allowedHosts: ["research.example.net"],
    sourceRefs: ["native-network-literal"],
  };
  assert(
    inspect(frame).includes("research.example.net"),
    "Updated configured host missing",
  );
});
