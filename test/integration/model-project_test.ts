import {
  createModelProject,
  listModelProjects,
  readModelProject,
  readProjectSources,
} from "../../src/adapters/out/filesystem/model-project.ts";
import { main } from "../../tools/model-project.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error("Expected rejection");
}

Deno.test("local projects preserve identity and editable nested SysML without instance state", async () => {
  const root = await Deno.makeTempDir();
  try {
    const created = await createModelProject({
      root,
      name: "example",
      sources: { "nested/a.sysml": "package A {}" },
    });
    const read = await readModelProject(created.directory);
    assert(read.id === created.project.id);
    assert(
      (await readProjectSources(`${created.directory}/sources`))[
        "nested/a.sysml"
      ] === "package A {}",
    );
    assert((await listModelProjects(root)).length === 1);
    await rejects(() =>
      createModelProject({
        root,
        name: "example",
        sources: { "b.sysml": "package B {}" },
      })
    );
    assert((await readModelProject(created.directory)).id === read.id);
    await rejects(() =>
      createModelProject({
        root,
        name: "../escape",
        sources: { "a.sysml": "" },
      })
    );
    await rejects(() =>
      createModelProject({
        root,
        name: "unsafe",
        sources: { "../a.sysml": "" },
      })
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("project import rejects source symlinks and manifest path substitutions", async () => {
  const root = await Deno.makeTempDir();
  try {
    const created = await createModelProject({
      root,
      name: "example",
      sources: { "a.sysml": "package A {}" },
    });
    await Deno.symlink(
      `${created.directory}/sources/a.sysml`,
      `${created.directory}/sources/link.sysml`,
    );
    await rejects(() => readProjectSources(`${created.directory}/sources`));
    await Deno.remove(`${created.directory}/sources/link.sysml`);
    await Deno.writeTextFile(
      `${created.directory}/model-project.json`,
      JSON.stringify({ ...created.project, sourcesDirectory: "../outside" }),
    );
    await rejects(() => readModelProject(created.directory));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("project CLI imports ordinary SysML directories and lists existing projects", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/input`);
    await Deno.writeTextFile(`${root}/input/a.sysml`, "package A {}");
    await main([
      "create",
      "local",
      "--root",
      `${root}/projects`,
      "--from-sources",
      `${root}/input`,
    ]);
    const entries = await listModelProjects(`${root}/projects`);
    assert(entries.length === 1 && entries[0].project.name === "local");
    await main(["inspect", entries[0].directory]);
    await main(["list", `--root=${root}/projects`]);
    await rejects(() =>
      main([
        "create",
        "other",
        "--from-sources",
        `${root}/input`,
        "--remote",
        "anything",
      ])
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("project CLI exports verified admitted sources without compiling or overwriting draft", async () => {
  const { GitModelRepository } = await import(
    "../../src/adapters/out/git/repository.ts"
  );
  const { materialize } = await import(
    "../../src/domain/model/value-objects/artifact.ts"
  );
  const root = await Deno.makeTempDir();
  try {
    const created = await createModelProject({
      root,
      name: "exportable",
      sources: { "a.sysml": "package Admitted {}" },
    });
    await rejects(() => main(["export", created.directory]));
    await rejects(() => Deno.lstat(`${created.directory}/.git`));
    const repository = await GitModelRepository.open({
      projectDir: created.directory,
      repositoryId: created.project.id,
      compiler: {
        compile: (sources) => materialize([], sources, "fixture-engine"),
        recipe: () => {
          throw new Error("Fixture compiler reports no build recipe");
        },
      },
    });
    const admitted = await repository.initialize({
      "a.sysml": "package Admitted {}",
    });
    await Deno.writeTextFile(
      `${created.directory}/sources/a.sysml`,
      "package HumanDraft {}",
    );
    await main(["export", created.directory]);
    const exported = `${created.directory}/.assembly/snapshots/${
      admitted.version.slice(7)
    }/sources`;
    assert(
      await Deno.readTextFile(`${exported}/a.sysml`) === "package Admitted {}",
    );
    assert(
      await Deno.readTextFile(`${created.directory}/sources/a.sysml`) ===
        "package HumanDraft {}",
    );
    await main(["export", created.directory, "--version", admitted.version]);
    await rejects(() =>
      main(["export", created.directory, "--version", "HEAD"])
    );
    await Deno.writeTextFile(`${exported}/extra.sysml`, "package Extra {}");
    await rejects(() => main(["export", created.directory]));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
