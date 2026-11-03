import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import assert from "node:assert/strict";
import { SysmlToolkitAdapter } from "../../src/adapters/sysml-toolkit-adapter.ts";
import { loadInitialSources } from "../../src/adapters/source-model.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");

Deno.test({
  name: "the initial system projects native views with decision branches",
  ignore: !toolkitIntegrationEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const adapter = new SysmlToolkitAdapter({ packageDir: packageDir! });
    const projection = await adapter.views(await loadInitialSources());
    assert.deepEqual(projection.problems, []);
    const ids = projection.views.map((v) => v.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const view of projection.views) {
      const nodes = new Set(view.diagram.nodes.map((n) => n.id));
      for (const edge of view.diagram.edges) {
        assert.ok(nodes.has(edge.source), `${view.id}: ${edge.source}`);
        assert.ok(nodes.has(edge.target), `${view.id}: ${edge.target}`);
      }
      assert.equal(view.nodes, view.diagram.nodes.length);
      assert.equal(view.edges, view.diagram.edges.length);
    }

    const structure = projection.views.find((v) =>
      v.id === "structure:ASELiveBuilder::liveBuilder"
    );
    assert.equal(structure?.kind, "interconnection");
    assert.ok(structure!.diagram.nodes.some((n) => n.kind === "port"));
    assert.ok(structure!.diagram.edges.some((e) => e.kind === "connect"));

    const conversation = projection.views.find((v) =>
      v.id === "behavior:ASEConversation::ConversationCase"
    );
    const branches = conversation!.diagram.edges.filter((e) => e.supplemented);
    const decisions = new Set(
      conversation!.diagram.nodes.filter((n) => n.kind === "control").map((
        n,
      ) => n.id),
    );
    assert.ok(branches.length >= 3);
    assert.ok(branches.every((e) => decisions.has(e.source) && e.guard));
    assert.ok(branches.some((e) => e.guard === "else"));

    const lifecycle = projection.views.find((v) =>
      v.id === "state:ASELifecycle::CandidateLifecycle"
    );
    assert.ok(lifecycle!.diagram.edges.some((e) => e.kind === "transition"));
    assert.ok(projection.views.some((v) => v.group === "definitions"));
  },
});
