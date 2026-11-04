import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import { ModelBuildService } from "../../src/application/model/builds/service.ts";
import { FileBuildVault } from "../../src/adapters/out/filesystem/build-vault.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { KvModelBuildStore } from "../../src/adapters/out/deno-kv/kv-store.ts";
import {
  materialize,
  sha256,
} from "../../src/domain/model/value-objects/artifact.ts";
import { storedBuildMaterializer } from "../../src/adapters/out/sysml-toolkit/compilation/stored-materializer.ts";
import { resolveRepositoryLayout } from "../../src/adapters/out/filesystem/layout.ts";
import { inspectModelProject } from "../../src/adapters/out/git/project-inspection.ts";
import {
  createModelProject,
} from "../../src/adapters/out/filesystem/model-project.ts";

const repositoryId = "33333333-3333-4333-8333-333333333333";
const recipe = {
  toolkit: { version: "fixture", bundleDigest: "b".repeat(64) },
  format: "ase-toolkit-normalized-json-v1",
  normalizerVersion: 1,
  irVersion: "0.1",
  artifactSchema: 1,
  engineVersion: "fixture-engine",
};
const compiler = {
  compile: (sources: Sources) =>
    materialize([], sources, recipe.engineVersion, {
      name: "fixture",
      version: recipe.engineVersion,
      format: recipe.format,
    }),
  recipe: () => Promise.resolve(recipe),
};

async function git(projectDir: string, args: string[], input?: string) {
  const child = new Deno.Command("git", {
    args: [`--git-dir=${projectDir}/.git`, ...args],
    env: {
      GIT_AUTHOR_NAME: "ASE",
      GIT_AUTHOR_EMAIL: "ase@local.invalid",
      GIT_COMMITTER_NAME: "ASE",
      GIT_COMMITTER_EMAIL: "ase@local.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const written = async () => {
    if (input === undefined) return;
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  };
  const [result] = await Promise.all([child.output(), written()]);
  equal(result.success, true, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

/** Author old Git/journal formats directly, without renaming current state. */
async function oldCommit(
  projectDir: string,
  path: string,
  text: string,
  sources: Sources,
  parent?: string,
) {
  const source = await git(
    projectDir,
    ["hash-object", "-w", "--stdin"],
    sources["model.sysml"],
  );
  const sourceTree = await git(
    projectDir,
    ["mktree"],
    `100644 blob ${source}\tmodel.sysml\n`,
  );
  const build = await git(projectDir, ["hash-object", "-w", "--stdin"], text);
  const tree = await git(
    projectDir,
    ["mktree"],
    `100644 blob ${build}\t${path}\n040000 tree ${sourceTree}\tsources\n`,
  );
  return await git(projectDir, [
    "commit-tree",
    tree,
    ...(parent ? ["-p", parent] : []),
  ], "Historical model\n\nASE-Author: ase:host\n");
}

Deno.test("fresh repository owns Assembly state, descriptor and export names", async () => {
  const root = await Deno.makeTempDir();
  const store = await KvModelBuildStore.open({ path: ":memory:" });
  try {
    const { directory: projectDir, project } = await createModelProject({
      root,
      name: "new-system",
      sources: { "model.sysml": "package AssemblyCore {}" },
    });
    const builds = new ModelBuildService({
      repositoryId: project.id,
      store,
      compiler,
      materializer: storedBuildMaterializer,
    });
    const repo = await GitModelRepository.open({
      projectDir,
      compiler,
      buildService: builds,
    });
    const current = await repo.initialize({
      "model.sysml": "package AssemblyCore {}",
    });
    equal(repo.stateDir, `${projectDir}/.assembly/runtime`);
    const manifest = JSON.parse(
      await Deno.readTextFile(`${repo.stateDir}/repository.json`),
    );
    equal(manifest.value.kind, "assembly-local-git-v1");
    const paths = (await git(projectDir, [
      "ls-tree",
      "--name-only",
      current.version.slice(7),
    ])).split("\n");
    deepStrictEqual(paths, [".assembly-build-ref.json", "sources"]);
    const exported = await repo.exportSources(current.version);
    equal(
      exported,
      `${projectDir}/.assembly/snapshots/${current.version.slice(7)}/sources`,
    );
    equal(
      (await inspectModelProject(projectDir)).admitted?.snapshotPathCandidate,
      exported,
    );
    await rejects(() => Deno.lstat(`${projectDir}/.ase`), Deno.errors.NotFound);
  } finally {
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("real legacy Git history reopens in place with exact identities, bytes and BuildRefs", async () => {
  const projectDir = await Deno.makeTempDir();
  const store = await KvModelBuildStore.open({ path: ":memory:" });
  const readerStore = await KvModelBuildStore.open({ path: ":memory:" });
  try {
    await git(projectDir, ["init", "--initial-branch=workspace", projectDir]);
    const stateDir = `${projectDir}/.ase/runtime`;
    await Deno.mkdir(`${stateDir}/proposals`, { recursive: true });
    const vault = new FileBuildVault({ directory: `${stateDir}/builds/vault` });
    const builds = new ModelBuildService({
      repositoryId,
      store,
      vault,
      compiler,
      materializer: storedBuildMaterializer,
    });
    const firstSources = {
      "model.sysml": "package AssemblyCore { part historic; }\n",
    };
    const firstCompiled = await compiler.compile(firstSources);
    const inlineText = canonical({
      repositoryId,
      compiled: firstCompiled,
      digest: await sha256(canonical(firstCompiled)),
    });
    const first = await oldCommit(
      projectDir,
      ".ase-build.json",
      inlineText,
      firstSources,
    );
    const lastSources = {
      "model.sysml": "package AssemblyCore { part retained; }\n",
    };
    const lastCompiled = await compiler.compile(lastSources);
    const descriptor = await builds.ensure(lastCompiled, recipe);
    const descriptorText = canonical(descriptor);
    const last = await oldCommit(
      projectDir,
      ".ase-build-ref.json",
      descriptorText,
      lastSources,
      first,
    );
    await vault.putVerified(
      descriptor.artifactDigest,
      await store.get(descriptor.artifactDigest),
    );
    await git(projectDir, ["update-ref", "refs/heads/admitted", last]);
    const manifestValue = {
      kind: "ase-local-git-v1",
      repositoryId,
      workspace: "sources",
      activeRef: "refs/heads/admitted",
      status: "ready",
      initialVersion: `commit:${first}`,
    };
    const manifestText = JSON.stringify({
      value: manifestValue,
      digest: await sha256(canonical(manifestValue)),
    });
    await Deno.writeTextFile(`${stateDir}/repository.json`, manifestText);
    await Deno.writeTextFile(
      `${stateDir}/retained-user-data.bin`,
      "exact old bytes\0ASE",
    );
    const objects = () =>
      git(projectDir, [
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname) %(objecttype)",
      ]);
    const beforeObjects = await objects();
    // Empty cache proves the old vault location is consulted, without a recipe.
    const readerBuilds = new ModelBuildService({
      repositoryId,
      store: readerStore,
      vault,
      materializer: storedBuildMaterializer,
    });
    const refuseCompiler = {
      compile: () =>
        Promise.reject(new Error("Historical read must not compile")),
      recipe: () =>
        Promise.reject(new Error("Historical recipe must not be resolved")),
    };
    const repo = await GitModelRepository.open({
      projectDir,
      compiler: refuseCompiler,
      buildService: readerBuilds,
    });
    const readOnly = await GitModelRepository.openReadOnly({
      projectDir,
      buildService: readerBuilds,
    });
    equal(repo.repositoryId, repositoryId);
    equal(repo.stateDir, stateDir);
    deepStrictEqual((await repo.at(`commit:${first}`)).sources, firstSources);
    deepStrictEqual((await readOnly.at(`commit:${last}`)).sources, lastSources);
    equal(
      (await repo.at(`commit:${first}`)).provenanceDigest,
      firstCompiled.provenanceDigest,
    );
    equal(
      (await repo.current()).provenanceDigest,
      lastCompiled.provenanceDigest,
    );
    deepStrictEqual(await readOnly.descriptorAt(`commit:${last}`), descriptor);
    deepStrictEqual(
      (await repo.history()).commits.map((entry) => entry.version),
      [`commit:${last}`, `commit:${first}`],
    );
    equal(await Deno.readTextFile(`${stateDir}/repository.json`), manifestText);
    equal(
      await Deno.readTextFile(`${stateDir}/retained-user-data.bin`),
      "exact old bytes\0ASE",
    );
    equal(
      await git(projectDir, ["show", `${first}:.ase-build.json`]),
      inlineText,
    );
    equal(
      await git(projectDir, ["show", `${last}:.ase-build-ref.json`]),
      descriptorText,
    );
    equal(await objects(), beforeObjects);
    await rejects(
      () => Deno.lstat(`${projectDir}/.assembly`),
      Deno.errors.NotFound,
    );
    const reopened = await GitModelRepository.open({
      projectDir,
      compiler,
      buildService: builds,
    });
    const next = await reopened.publishSystemSources(
      { "model.sysml": "package AssemblyCore {}" },
      `commit:${last}`,
      "operator",
    );
    const paths =
      (await git(projectDir, ["ls-tree", "--name-only", next.version.slice(7)]))
        .split("\n");
    deepStrictEqual(paths, [".assembly-build-ref.json", "sources"]);
    equal(
      JSON.parse(await Deno.readTextFile(`${stateDir}/repository.json`)).value
        .kind,
      "ase-local-git-v1",
    );
    equal(
      await git(projectDir, ["show", `${last}:.ase-build-ref.json`]),
      descriptorText,
    );
  } finally {
    await store.close();
    await readerStore.close();
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("competing state trees and build entries refuse without selecting or overwriting", async () => {
  const projectDir = await Deno.makeTempDir();
  const store = await KvModelBuildStore.open({ path: ":memory:" });
  try {
    await Deno.mkdir(`${projectDir}/.ase/runtime`, { recursive: true });
    await Deno.writeTextFile(`${projectDir}/.ase/runtime/sentinel`, "legacy");
    await Deno.mkdir(`${projectDir}/.assembly/runtime`, { recursive: true });
    await Deno.writeTextFile(
      `${projectDir}/.assembly/runtime/sentinel`,
      "canonical",
    );
    for (
      const action of [
        () => resolveRepositoryLayout(projectDir),
        () => GitModelRepository.open({ projectDir, compiler }),
        () => GitModelRepository.openReadOnly({ projectDir }),
      ]
    ) await rejects(action, /Ambiguous repository state/);
    equal(
      await Deno.readTextFile(`${projectDir}/.ase/runtime/sentinel`),
      "legacy",
    );
    equal(
      await Deno.readTextFile(`${projectDir}/.assembly/runtime/sentinel`),
      "canonical",
    );
    await rejects(() => Deno.lstat(`${projectDir}/.git`), Deno.errors.NotFound);
    await Deno.remove(`${projectDir}/.ase`, { recursive: true });
    const builds = new ModelBuildService({
      repositoryId,
      store,
      compiler,
      materializer: storedBuildMaterializer,
    });
    const repo = await GitModelRepository.open({
      projectDir,
      repositoryId,
      compiler,
      buildService: builds,
    });
    const current = await repo.initialize({
      "model.sysml": "package AssemblyCore {}",
    });
    const oid = current.version.slice(7);
    const descriptor = await git(projectDir, [
      "rev-parse",
      `${oid}:.assembly-build-ref.json`,
    ]);
    const sources = await git(projectDir, ["rev-parse", `${oid}:sources`]);
    for (const competing of [".ase-build-ref.json", ".ase-build.json"]) {
      const tree = await git(
        projectDir,
        ["mktree"],
        `100644 blob ${descriptor}\t.assembly-build-ref.json\n100644 blob ${descriptor}\t${competing}\n040000 tree ${sources}\tsources\n`,
      );
      const bad = await git(
        projectDir,
        ["commit-tree", tree, "-p", oid],
        "Ambiguous build entries\n",
      );
      await rejects(() => repo.at(`commit:${bad}`), /BUILD_FORMAT_AMBIGUOUS/);
      await rejects(
        () => repo.descriptorAt(`commit:${bad}`),
        /BUILD_FORMAT_AMBIGUOUS/,
      );
    }
  } finally {
    await store.close();
    await Deno.remove(projectDir, { recursive: true });
  }
});
