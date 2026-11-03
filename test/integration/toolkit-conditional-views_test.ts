import assert from "node:assert/strict";
import { loadSysmlToolkit } from "../../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import { TOOLKIT_RELEASE } from "../../src/adapters/sysml-toolkit-pin.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

const sources = {
  "branches.sysml": `package Repro {
  action def Flow {
    attribute x = 1;
    action pass; action reject;
    decide gate;
      if x > 0 then pass;
      else reject;
  }
  item def Tick;
  state def Life { state stopped; state waiting; accept Tick then stopped; }
}`,
};

Deno.test({
  name:
    "corrected Toolkit exposes one semantic decision source in native reads and the action view",
  ignore: !toolkitIntegrationEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const runtime = await loadSysmlToolkit(packageDir);
    assert.equal(runtime.version, TOOLKIT_RELEASE);
    const session = runtime.createSession(
      JSON.stringify(
        Object.entries(sources).map(([name, text]) => ({ name, text })),
      ),
    );
    const flow = session.resolve("Repro::Flow")!;
    const gate = session.resolve("Repro::Flow::gate")!;
    const members = session.members!(flow);
    try {
      const expected = { "@id": session.elementId(gate) };
      const branches = members.filter((e) =>
        session.metaclass(e) === "TransitionUsage"
      );
      assert.equal(branches.length, 2);
      for (const branch of branches) {
        assert.deepEqual(
          JSON.parse(session.derived!(branch, "source")),
          expected,
        );
        assert.deepEqual(
          JSON.parse(session.property!(branch, "source")),
          expected,
        );
      }
    } finally {
      for (const e of members) e.free();
      gate.free();
      flow.free();
      session.free();
    }
    const adapter = new SysmlToolkitAdapter({ packageDir });
    const listed = await adapter.views(sources);
    const summary = listed.views.find((v) =>
      v.element === "Repro::Flow" && v.kind === "action"
    )!;
    assert.ok(summary);
    const view = await adapter.diagram(sources, summary);
    const decision = view.diagram.nodes.find((n) => n.name === "gate")!;
    const branches = view.diagram.edges.filter((e) => e.source === decision.id);
    assert.equal(branches.length, 2);
    assert.deepEqual(
      branches.map((e) =>
        view.diagram.nodes.find((n) => n.id === e.target)?.name
      ).sort(),
      ["pass", "reject"],
    );
    assert.ok(branches.some((e) => e.label === "[x > 0]"));
    assert.ok(branches.every((e) => e.kind === "transition"));
  },
});

Deno.test({
  name:
    "bundled Toolkit keeps else valid through compact and full JSON round trips",
  ignore: !toolkitIntegrationEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const runtime = await loadSysmlToolkit(packageDir);
    assert.equal(runtime.version, TOOLKIT_RELEASE);
    assert.ok(
      runtime.createSessionFromInterchangeJson,
      "Native Toolkit requires interchange import support to qualify round trips",
    );
    const session = runtime.createSession(JSON.stringify([{
      name: "roundtrip.sysml",
      text: `action def Router {
        action fast;
        action slow;
        decide branch;
        if true then fast;
        else slow;
      }`,
    }]));
    try {
      assert.deepEqual(JSON.parse(session.check()), []);
      const expected = JSON.parse(session.toCompactJson!());
      for (
        const input of [session.toCompactJson!(), session.toFullJson!(false)]
      ) {
        const restored = runtime.createSessionFromInterchangeJson!(input);
        try {
          const units: { text: string }[] = JSON.parse(restored.units());
          assert.match(units.map((unit) => unit.text).join("\n"), /\belse\s/);
          assert.deepEqual(JSON.parse(restored.check()), []);
          assert.deepEqual(JSON.parse(restored.toCompactJson!()), expected);
        } finally {
          restored.free();
        }
      }
    } finally {
      session.free();
    }
  },
});

Deno.test({
  name:
    "corrected Toolkit draws implicit state transitions through the ASE worker",
  ignore: !toolkitIntegrationEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const adapter = new SysmlToolkitAdapter({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    });
    const listed = await adapter.views(sources);
    const summary = listed.views.find((v) =>
      v.element === "Repro::Life" && v.kind === "state"
    )!;
    const view = await adapter.diagram(sources, summary);
    const edge = view.diagram.edges.find((e) => e.kind === "transition")!;
    assert.ok(edge);
    assert.equal(
      view.diagram.nodes.find((n) => n.id === edge.source)?.name,
      "waiting",
    );
    assert.equal(
      view.diagram.nodes.find((n) => n.id === edge.target)?.name,
      "stopped",
    );
    assert.match(edge.label ?? "", /Tick/);
  },
});
