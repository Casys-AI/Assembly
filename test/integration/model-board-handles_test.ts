import assert from "node:assert/strict";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { loadSysmlToolkit } from "../../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import { accountToolkitHandles } from "../support/toolkit-handle-accounting.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

Deno.test({
  name:
    "real Toolkit board frees every wrapper and session on success and injected failures",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const base = await loadSysmlToolkit(packageDir);
    const sources = await loadInitialSources();
    const run = async (injection?: { call: number; trap: boolean }) => {
      const accounting = accountToolkitHandles(base, injection);
      const tooling = new SysmlToolkitAdapter({
        packageDir,
        loadRuntime: () => Promise.resolve(accounting.runtime),
      });
      try {
        await tooling.board(sources);
      } catch (error) {
        if (!injection) throw error;
      }
      accounting.assertDisposed(JSON.stringify(injection ?? "success"));
      return accounting;
    };
    const baseline = await run();
    assert.ok(baseline.allocations.length > 100, "substantial real projection");
    const { calls } = baseline;
    const points = new Set<number>([1]);
    for (
      const method of ["resolve", "elementsOfMetaclass", "members", "typings"]
    ) {
      const first = calls.findIndex((call) => call.method === method);
      assert.ok(first >= 0, `${method} acquisition exercised`);
      points.add(first + 1);
    }
    const batches = calls.flatMap((call, index) =>
      call.batch && call.handles > 1 ? [index] : []
    );
    assert.ok(batches.length > 0, "real array-returning acquisition exercised");
    for (const index of [batches[0], batches.at(-1)!]) {
      assert.equal(calls[index + 1].method, "elementId");
      // Throw while inspecting the first member: all remaining wrappers in the
      // returned batch must already have been adopted by Reader.internAll.
      points.add(index + 2);
    }
    for (const fraction of [0.5, 0.9, 0.99]) {
      points.add(Math.max(1, Math.floor(calls.length * fraction)));
    }
    for (const call of [...points].sort((a, b) => a - b)) {
      for (const trap of [false, true]) await run({ call, trap });
    }
    console.log(JSON.stringify({
      qualification:
        "real Toolkit wrapper accounting via adapter loadRuntime seam",
      baselineCalls: calls.length,
      wrappers: baseline.allocations.length,
      batches: batches.length,
      injectedCases: points.size * 2,
    }));
  },
});
