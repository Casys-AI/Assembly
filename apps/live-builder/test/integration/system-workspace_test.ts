import {
  deepStrictEqual,
  equal,
  notEqual,
  rejects,
  throws,
} from "node:assert/strict";
import { join } from "node:path";
import {
  readModelProject,
  readProjectSources,
} from "../../src/adapters/out/filesystem/model-project.ts";
import {
  availablePort,
  createNamedSystem,
  createSystemWorkspace,
  listSystemWorkspaces,
  preparedSources,
  readSystemWorkspace,
  systemEnvironment,
  systemName,
  workspacePaths,
} from "../../tools/system-workspace.ts";

const sources = { "core.sysml": "package Core { part def Thing; }\n" };

Deno.test("named systems preserve distinct model and execution identities on explicit resume", async () => {
  const root = await Deno.makeTempDir({ prefix: "ase-named-system-" });
  try {
    const first = await createSystemWorkspace({
      root,
      name: "one",
      port: 4313,
      sources,
    });
    const second = await createSystemWorkspace({
      root,
      name: "two",
      port: 4314,
      sources,
    });
    notEqual(first.id, second.id);
    equal(first.format, 2);
    deepStrictEqual(await readSystemWorkspace(root, "one"), first);
    const environment = systemEnvironment(root, first);
    deepStrictEqual(environment, {
      PORT: "4313",
      ASSEMBLY_SYSTEM_ID: first.id,
      ASSEMBLY_MODEL_PROJECT_DIR: workspacePaths(root, "one").project,
      ASSEMBLY_DEMO_DATA_DIR: workspacePaths(root, "one").instance,
    });
    deepStrictEqual(
      (await listSystemWorkspaces(root)).map((system) => system.name),
      ["one", "two"],
    );
    await rejects(
      () => createSystemWorkspace({ root, name: "one", port: 4400, sources }),
      /existe déjà/,
    );
    deepStrictEqual(await readSystemWorkspace(root, "one"), first);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("concurrent creation of the same system accepts one complete source tree without overwrite", async () => {
  const root = await Deno.makeTempDir({ prefix: "ase-named-race-" });
  try {
    const creations = await Promise.allSettled([
      createSystemWorkspace({ root, name: "race", port: 4313, sources }),
      createSystemWorkspace({
        root,
        name: "race",
        port: 4314,
        sources: { "other.sysml": "package Other;\n" },
      }),
    ]);
    equal(
      creations.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const system = await readSystemWorkspace(root, "race");
    const winner = creations.find((result) => result.status === "fulfilled")!;
    deepStrictEqual(system, winner.value);
    const seeded = await readProjectSources(
      workspacePaths(root, "race").sources,
    );
    deepStrictEqual(
      Object.keys(seeded),
      system.port === 4313 ? ["core.sysml"] : ["other.sysml"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("source snapshots and added SysML are preserved as one complete prepared seed", async () => {
  const root = await Deno.makeTempDir({ prefix: "ase-named-seed-" });
  try {
    const input = join(root, "sources.json"),
      added = join(root, "interaction.sysml");
    await Deno.writeTextFile(
      input,
      JSON.stringify({
        sources: { ...sources, "nested/second.sysml": "package Second;\n" },
      }),
    );
    await Deno.writeTextFile(added, "package Interaction;\n");
    const prepared = await preparedSources({
      fromSources: input,
      addSources: [added],
    });
    await Deno.writeTextFile(input, JSON.stringify(prepared));
    deepStrictEqual(await preparedSources({ fromSources: input }), prepared);
    await createSystemWorkspace({
      root,
      name: "prepared",
      port: 4313,
      sources: prepared,
    });
    deepStrictEqual(
      await readProjectSources(
        workspacePaths(root, "prepared").sources,
      ),
      prepared,
    );
    await rejects(
      () => preparedSources({ fromSources: input, addSources: [added, added] }),
      /existe déjà/,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("workspace creation rejects unsafe names and paths before touching system storage", async () => {
  for (
    const name of ["../other", "", "One", "-one", "one/two", "a".repeat(64)]
  ) {
    throws(() => systemName(name));
  }
  const root = await Deno.makeTempDir({ prefix: "ase-named-invalid-" });
  try {
    await rejects(
      () =>
        createSystemWorkspace({
          root,
          name: "invalid",
          port: 4313,
          sources: { "../leak.sysml": "package Leak;" },
        }),
      /Unsafe/,
    );
    await rejects(
      () => Deno.stat(workspacePaths(root, "invalid").directory),
      Deno.errors.NotFound,
    );
    deepStrictEqual(await listSystemWorkspaces(join(root, "absent")), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("named workspace metadata refuses retired formats and unexpected targets on resume", async () => {
  const root = await Deno.makeTempDir({ prefix: "ase-named-manifest-" });
  try {
    const system = await createSystemWorkspace({
      root,
      name: "sealed",
      port: 4313,
      sources,
    });
    await Deno.writeTextFile(
      workspacePaths(root, "sealed").manifest,
      JSON.stringify({ ...system, format: 1 }),
    );
    await rejects(() => readSystemWorkspace(root, "sealed"), /Manifeste/);
    await Deno.writeTextFile(
      workspacePaths(root, "sealed").manifest,
      JSON.stringify({ ...system, project: "/unrelated-project" }),
    );
    await rejects(() => readSystemWorkspace(root, "sealed"), /Manifeste/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("port selection rejects active and already assigned ports", () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const occupied = (listener.addr as Deno.NetAddr).port;
    throws(() => availablePort(occupied), /déjà utilisé/);
    throws(() => availablePort(4313, [4313]), /réservé/);
  } finally {
    listener.close();
  }
});

Deno.test("an interrupted creator is reported without blocking other named systems", async () => {
  const root = await Deno.makeTempDir({ prefix: "ase-named-interruption-" });
  try {
    const partial = workspacePaths(root, "interrupted");
    await Deno.mkdir(partial.sources, { recursive: true });
    await Deno.writeTextFile(
      join(partial.sources, "core.sysml"),
      sources["core.sysml"],
    );
    await createSystemWorkspace({ root, name: "ready", port: 4313, sources });
    const incomplete: string[] = [];
    deepStrictEqual(
      (await listSystemWorkspaces(root, (name) => incomplete.push(name))).map((
        system,
      ) => system.name),
      ["ready"],
    );
    deepStrictEqual(incomplete, ["interrupted"]);
    equal(
      await Deno.readTextFile(join(partial.sources, "core.sysml")),
      sources["core.sysml"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("concurrent names reserve different default ports and retain both manifests", async () => {
  const root = await Deno.makeTempDir({ prefix: "ase-named-ports-" });
  try {
    const [one, two] = await Promise.all([
      createNamedSystem({ root, name: "one", sources }),
      createNamedSystem({ root, name: "two", sources }),
    ]);
    notEqual(one.port, two.port);
    deepStrictEqual(
      (await listSystemWorkspaces(root)).map((system) => system.name),
      ["one", "two"],
    );
    await rejects(
      () => createNamedSystem({ root, name: "three", port: one.port, sources }),
      /réservé/,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("named system environment selects the supplied source project and separate execution directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "ase-named-project-" });
  try {
    const seed = { "custom.sysml": "package Custom { part def Seed; }\n" };
    const input = join(root, "seed.json");
    await Deno.writeTextFile(input, JSON.stringify({ sources: seed }));
    const system = await createNamedSystem({
      root,
      name: "seeded",
      sources: await preparedSources({ fromSources: input }),
    });
    const env = systemEnvironment(root, system);
    const project = await readModelProject(env.ASSEMBLY_MODEL_PROJECT_DIR);
    deepStrictEqual(await readProjectSources(project.sourcesPath), seed);
    notEqual(env.ASSEMBLY_DEMO_DATA_DIR, project.projectDir);
    equal((await Deno.stat(env.ASSEMBLY_DEMO_DATA_DIR)).isDirectory, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a retired system is reported without blocking listing or creation", async () => {
  const root = await Deno.makeTempDir({ prefix: "ase-named-retired-" });
  try {
    const old = await createSystemWorkspace({
      root,
      name: "legacy",
      port: 4313,
      sources,
    });
    await Deno.writeTextFile(
      workspacePaths(root, "legacy").manifest,
      JSON.stringify({ ...old, format: 1, database: "ase_system_legacy" }),
    );
    await createSystemWorkspace({ root, name: "ready", port: 4314, sources });
    const retired: string[] = [];
    deepStrictEqual(
      (await listSystemWorkspaces(root, () => {}, (name) => retired.push(name)))
        .map((system) => system.name),
      ["ready"],
    );
    deepStrictEqual(retired, ["legacy"]);
    await rejects(() => readSystemWorkspace(root, "legacy"), /format retiré 1/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
