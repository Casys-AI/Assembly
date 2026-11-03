import { deepEqual, equal, notEqual, rejects } from "node:assert/strict";
import { runtimeProvenanceRecord } from "../domain/work/value-objects/runtime-provenance.ts";
import {
  DenoRuntimeProvenanceCollector,
  type RuntimeProvenanceDependencies,
  type RuntimeProvenanceOptions,
} from "./runtime-provenance.ts";

const commit = "a".repeat(40);
const toolkit = { version: "0.10.10", digest: "b".repeat(64) };
const options: RuntimeProvenanceOptions = {
  applicationDirectory: "/ase-checkout",
  toolkitPackageDirectory: "/loaded-toolkit",
  agents: {
    provider: "claude",
    model: "claude-sonnet-5-5",
    effort: "high",
    decisionMaxTokens: 4096,
  },
};
const dependencies: RuntimeProvenanceDependencies = {
  runGit: (args) => Promise.resolve(args[0] === "rev-parse" ? commit : ""),
  denoVersion: () => "2.9.7",
  loadToolkitProvenance: () => Promise.resolve(toolkit),
};

Deno.test("runtime provenance collects one startup snapshot from the ASE repository and loaded toolkit", async () => {
  const commands: { args: readonly string[]; directory: string }[] = [];
  let loads = 0;
  let versions = 0;
  const collector = new DenoRuntimeProvenanceCollector(options, {
    ...dependencies,
    runGit(args, directory) {
      commands.push({ args, directory });
      return Promise.resolve(
        args[0] === "rev-parse" ? `${commit}\n` : " M app.ts\n",
      );
    },
    denoVersion() {
      versions++;
      return "2.9.7";
    },
    loadToolkitProvenance(directory) {
      equal(directory, "/loaded-toolkit");
      loads++;
      return Promise.resolve(toolkit);
    },
  });
  const [first, concurrent] = await Promise.all([
    collector.collect(),
    collector.collect(),
  ]);
  deepEqual(first, concurrent);
  deepEqual(await collector.collect(), first);
  equal(loads, 1);
  equal(versions, 1);
  deepEqual(commands, [
    { args: ["rev-parse", "--verify", "HEAD"], directory: "/ase-checkout" },
    {
      args: ["status", "--porcelain=v1", "--untracked-files=normal"],
      directory: "/ase-checkout",
    },
  ]);
  deepEqual(
    first,
    await runtimeProvenanceRecord({
      schemaVersion: 1,
      complete: true,
      incompleteReasons: [],
      ase: { commit, dirty: true },
      deno: "2.9.7",
      toolkit,
      agents: options.agents,
    }),
  );
});

Deno.test("runtime provenance represents unavailable Git information explicitly", async () => {
  const collector = new DenoRuntimeProvenanceCollector(options, {
    ...dependencies,
    runGit: () => Promise.reject(new Error("Git permission denied")),
  });
  deepEqual((await collector.collect()).provenance.ase, {
    commit: "unknown",
    dirty: "unknown",
  });
  const unavailableStatus = new DenoRuntimeProvenanceCollector(options, {
    ...dependencies,
    runGit: (args) =>
      args[0] === "rev-parse"
        ? Promise.resolve(commit)
        : Promise.reject(new Error("Status unavailable")),
  });
  deepEqual((await unavailableStatus.collect()).provenance.ase, {
    commit,
    dirty: "unknown",
  });
  const invalidHead = new DenoRuntimeProvenanceCollector(options, {
    ...dependencies,
    runGit: () => Promise.resolve(""),
  });
  deepEqual((await invalidHead.collect()).provenance.ase, {
    commit: "unknown",
    dirty: false,
  });
});

Deno.test("runtime provenance snapshots only public agent settings and distinguishes configured models", async () => {
  const agents = { ...options.agents, apiKey: "never-record-this" };
  const collector = new DenoRuntimeProvenanceCollector(
    { ...options, agents },
    dependencies,
  );
  agents.model = "changed-after-construction";
  const record = await collector.collect();
  deepEqual(record.provenance.agents, options.agents);
  equal(JSON.stringify(record).includes("never-record-this"), false);
  const muse = await new DenoRuntimeProvenanceCollector({
    ...options,
    agents: { provider: "muse", model: "configured-muse-model" },
  }, dependencies).collect();
  notEqual(muse.digest, record.digest);
  deepEqual(muse.provenance.agents, {
    provider: "muse",
    model: "configured-muse-model",
  });
});

Deno.test("Muse provenance distinguishes an explicit model from an unresolved CLI default without blocking startup", async () => {
  for (const model of ["configured-muse-model", "unknown", ""]) {
    const record = await new DenoRuntimeProvenanceCollector({
      ...options,
      agents: { provider: "muse", model },
    }, dependencies).collect();
    const resolved = model !== "unknown" && model !== "";
    equal(record.provenance.agents.model, model || "unknown");
    equal(record.provenance.complete, resolved);
    deepEqual(
      record.provenance.incompleteReasons,
      resolved ? [] : ["agent-model-unresolved"],
    );
    const { complete: _complete, incompleteReasons: _reasons, ...legacy } =
      record.provenance;
    notEqual(record.digest, (await runtimeProvenanceRecord(legacy)).digest);
  }
});

Deno.test("runtime provenance refuses an unverified toolkit and does not retry the startup collection", async () => {
  let loads = 0;
  const collector = new DenoRuntimeProvenanceCollector(options, {
    ...dependencies,
    loadToolkitProvenance() {
      loads++;
      return Promise.reject(
        new Error("sysml-toolkit package and native addon versions disagree"),
      );
    },
  });
  await rejects(() => collector.collect(), /versions disagree/);
  await rejects(() => collector.collect(), /versions disagree/);
  equal(loads, 1);
});
