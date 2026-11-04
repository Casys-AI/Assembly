import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import {
  materialize,
  sha256,
} from "../../src/domain/model/value-objects/artifact.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import { ModelBuildService } from "../../src/application/model/builds/service.ts";
import {
  BuildStoreError,
  type ModelBuildStore,
} from "../../src/application/model/builds/ports/out/build-store.port.ts";

const compiler = {
  compile: (sources: Sources) => materialize([], sources, "readonly-fixture"),
  recipe: () => {
    throw new Error("Fixture has no native recipe");
  },
};

async function git(projectDir: string, args: string[], input?: string) {
  const child = new Deno.Command("git", {
    args: [
      "-c",
      "commit.gpgsign=false",
      `--git-dir=${projectDir}/.git`,
      ...args,
    ],
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@local.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@local.invalid",
    },
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const write = async () => {
    if (input === undefined) return;
    const writer = child.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(input));
    } finally {
      await writer.close();
    }
  };
  const [result] = await Promise.all([child.output(), write()]);
  ok(result.success, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

/** Capture all file bytes, paths and mtimes, including Git metadata/journals. */
async function files(directory: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  async function walk(path: string, prefix = "") {
    for await (const entry of Deno.readDir(path)) {
      const key = `${prefix}${entry.name}`;
      const full = `${path}/${entry.name}`;
      const info = await Deno.lstat(full);
      if (info.isDirectory) {
        result[`${key}/`] = {
          directory: true,
          mtime: info.mtime?.toISOString(),
        };
        await walk(full, `${key}/`);
      } else {
        result[key] = {
          digest: await sha256(await Deno.readFile(full)),
          mtime: info.mtime?.toISOString(),
        };
      }
    }
  }
  await walk(directory);
  return result;
}

async function commitSameTree(
  projectDir: string,
  version: string,
  parents: string[],
  message: string,
) {
  const tree = await git(projectDir, [
    "rev-parse",
    `${version.slice(7)}^{tree}`,
  ]);
  const oid = await git(projectDir, [
    "commit-tree",
    tree,
    ...parents.flatMap((parent) => ["-p", parent.slice(7)]),
  ], `${message}\n`);
  return `commit:${oid}`;
}

Deno.test("read-only Git preserves all intermediate revisions and actual merge provenance without writing", async () => {
  const projectDir = await Deno.makeTempDir({ prefix: "ase-git-readonly-" });
  try {
    const writer = await GitModelRepository.open({ projectDir, compiler });
    const from = await writer.initialize({ "model.sysml": "package First;" });
    const mid = await writer.publishSystemSources(
      { "model.sysml": "package Mid;" },
      from.version,
      "local-control",
    );
    const same = await commitSameTree(
      projectDir,
      mid.version,
      [mid.version],
      "Same artifact, distinct revision",
    );
    const branch = await commitSameTree(projectDir, from.version, [
      from.version,
    ], "Explicit side branch");
    const to = await commitSameTree(
      projectDir,
      same,
      [same, branch],
      "Merge both branches",
    );
    // An unfinished proposal journal must neither be read nor recovered.
    await Deno.writeTextFile(
      `${writer.stateDir}/proposals/unrelated.json`,
      "unreadable journal",
    );
    await Deno.remove(`${writer.stateDir}/writer.lock`);
    const before = await files(projectDir);
    const reader = await GitModelRepository.openReadOnly({ projectDir });
    equal(reader.repositoryId, writer.repositoryId);
    equal(reader.projectId, writer.projectId);
    deepStrictEqual(Object.keys(reader).sort(), [
      "admittedMainSource",
      "at",
      "descriptorAt",
      "projectId",
      "readFirstParentInterval",
      "repositoryId",
      "verifyRequestSourceAdmission",
      "verifyScopedSoftwareSourceAdmission",
    ]);
    deepStrictEqual(await reader.admittedMainSource(mid.version), {
      headVersion: mid.version,
      sourceDigest: mid.sourceDigest,
    });
    await rejects(() => reader.admittedMainSource(to), { code: "NOT_FOUND" });
    const interval = await reader.readFirstParentInterval(from.version, to, 4);
    deepStrictEqual(interval, {
      fromVersion: from.version,
      toVersion: to,
      complete: true,
      versions: [
        { version: from.version, parents: [] },
        { version: mid.version, parents: [from.version] },
        { version: same, parents: [mid.version] },
        { version: to, parents: [same, branch] },
      ],
    });
    equal((await reader.at(same)).sourceDigest, mid.sourceDigest);
    deepStrictEqual((await reader.at(from.version)).sources, from.sources);
    equal(await reader.descriptorAt(to), null);
    deepStrictEqual(await reader.readFirstParentInterval(to, to, 1), {
      fromVersion: to,
      toVersion: to,
      complete: true,
      versions: [{ version: to, parents: [same, branch] }],
    });
    deepStrictEqual(await files(projectDir), before);
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("read-only Git bounds first-parent intervals and refuses mutable or missing endpoints", async () => {
  const projectDir = await Deno.makeTempDir({ prefix: "ase-git-interval-" });
  try {
    const writer = await GitModelRepository.open({ projectDir, compiler });
    const from = await writer.initialize({ "model.sysml": "package From;" });
    const mid = await commitSameTree(
      projectDir,
      from.version,
      [from.version],
      "Middle",
    );
    const side = await commitSameTree(
      projectDir,
      from.version,
      [from.version],
      "Side",
    );
    const to = await commitSameTree(projectDir, mid, [mid, side], "To");
    const reader = await GitModelRepository.openReadOnly({ projectDir });
    deepStrictEqual(await reader.readFirstParentInterval(from.version, to, 2), {
      fromVersion: from.version,
      toVersion: to,
      complete: false,
      reason: "version-limit",
      versions: [{ version: mid, parents: [from.version] }, {
        version: to,
        parents: [mid, side],
      }],
    });
    deepStrictEqual(await reader.readFirstParentInterval(side, to, 128), {
      fromVersion: side,
      toVersion: to,
      complete: false,
      reason: "from-not-on-first-parent",
      versions: [{ version: from.version, parents: [] }, {
        version: mid,
        parents: [from.version],
      }, { version: to, parents: [mid, side] }],
    });
    for (const limit of [0, -1, 129, 1.5, NaN]) {
      await rejects(
        () => reader.readFirstParentInterval(from.version, to, limit),
        /version limit/i,
      );
    }
    for (const version of ["admitted", "HEAD", to.slice(7), "commit:abc"]) {
      await rejects(
        () => reader.readFirstParentInterval(version, to, 128),
        /immutable model version/i,
      );
      await rejects(
        () => reader.readFirstParentInterval(to, version, 128),
        /immutable model version/i,
      );
    }
    await rejects(
      () => reader.readFirstParentInterval(`commit:${"1".repeat(40)}`, to),
      { code: "NOT_FOUND" },
    );
    await rejects(() => reader.at(`commit:${"1".repeat(40)}`), {
      code: "NOT_FOUND",
    });
    const tag = await git(
      projectDir,
      ["mktag"],
      `object ${
        from.version.slice(7)
      }\ntype commit\ntag fixture\ntagger Fixture <fixture@local.invalid> 0 +0000\n\nExplicit tag\n`,
    );
    await rejects(
      () => reader.readFirstParentInterval(from.version, `commit:${tag}`),
      { code: "INVALID_REPOSITORY" },
    );
    const controller = new AbortController();
    controller.abort(new Error("Cancelled interval"));
    await rejects(
      () =>
        reader.readFirstParentInterval(
          from.version,
          to,
          128,
          controller.signal,
        ),
      /Cancelled interval/,
    );
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("read-only opening refuses missing, damaged and unfinished repositories without creating files", async () => {
  const root = await Deno.makeTempDir({ prefix: "ase-git-readonly-invalid-" });
  try {
    await rejects(
      () => GitModelRepository.openReadOnly({ projectDir: `${root}/absent` }),
      { code: "INVALID_REPOSITORY" },
    );
    deepStrictEqual(await files(root), {});
    await rejects(() => GitModelRepository.openReadOnly({ projectDir: root }), {
      code: "INVALID_REPOSITORY",
    });
    deepStrictEqual(await files(root), {});
    const writer = await GitModelRepository.open({
      projectDir: root,
      compiler,
    });
    const creating = await files(root);
    await rejects(
      () => GitModelRepository.openReadOnly({ projectDir: root }),
      /unfinished/i,
    );
    deepStrictEqual(await files(root), creating);
    await writer.initialize({ "model.sysml": "package Initial;" });
    const ready = await files(root);
    await rejects(
      () =>
        GitModelRepository.openReadOnly({
          projectDir: root,
          repositoryId: crypto.randomUUID(),
        }),
      /identity/i,
    );
    deepStrictEqual(await files(root), ready);
    const manifestPath = `${writer.stateDir}/repository.json`;
    const valid = await Deno.readTextFile(manifestPath);
    await Deno.writeTextFile(
      manifestPath,
      valid.replace('"digest":"', '"digest":"wrong'),
    );
    const damaged = await files(root);
    await rejects(
      () => GitModelRepository.openReadOnly({ projectDir: root }),
      /Changed repository journal/i,
    );
    deepStrictEqual(await files(root), damaged);
    await Deno.writeTextFile(manifestPath, valid);
    await Deno.writeTextFile(
      `${root}/model-project.json`,
      JSON.stringify({
        schemaVersion: 1,
        name: "Fixture",
        id: writer.repositoryId,
        sourcesDirectory: "sources",
      }),
    );
    const invalidProject = await files(root);
    await rejects(() => GitModelRepository.openReadOnly({ projectDir: root }), {
      code: "INVALID_REPOSITORY",
    });
    deepStrictEqual(await files(root), invalidProject);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("read-only Git resolves available descriptor builds and never rebuilds a missing artifact", async () => {
  const projectDir = await Deno.makeTempDir({
    prefix: "ase-git-readonly-build-",
  });
  const repositoryId = crypto.randomUUID();
  const blobs = new Map<string, Uint8Array>();
  let compiles = 0;
  let recipes = 0;
  const recipe = {
    toolkit: { version: "fixture", bundleDigest: "b".repeat(64) },
    format: "fixture-json-v1",
    normalizerVersion: 1,
    irVersion: "0.1",
    artifactSchema: 1,
    engineVersion: "fixture-engine",
  };
  const countedCompiler = {
    compile(sources: Sources) {
      compiles++;
      return materialize([], sources, recipe.engineVersion);
    },
    recipe() {
      recipes++;
      return Promise.resolve(recipe);
    },
  };
  const store = {
    get(digest: string) {
      const bytes = blobs.get(digest);
      return bytes ? Promise.resolve(new Uint8Array(bytes)) : Promise.reject(
        new BuildStoreError("BUILD_BLOB_MISSING", { digest }, "missing"),
      );
    },
    put(digest: string, bytes: Uint8Array) {
      const stored = !blobs.has(digest);
      blobs.set(digest, new Uint8Array(bytes));
      return Promise.resolve({ stored, bytes: bytes.length, digest });
    },
  } as ModelBuildStore;
  const makeService = () =>
    new ModelBuildService({
      repositoryId,
      store,
      compiler: countedCompiler,
      materializer: {
        materialize: ({ artifact, sources }) =>
          materialize(
            artifact.elements,
            sources,
            artifact.engineVersion,
            artifact.provider,
          ),
      },
    });
  try {
    const writer = await GitModelRepository.open({
      projectDir,
      repositoryId,
      compiler: countedCompiler,
      buildService: makeService(),
    });
    const initial = await writer.initialize({
      "model.sysml": "package Descriptor;",
    });
    const before = await files(projectDir);
    const counts = { compiles, recipes };
    const reader = await GitModelRepository.openReadOnly({
      projectDir,
      buildService: makeService(),
    });
    const descriptor = await reader.descriptorAt(initial.version);
    ok(descriptor);
    equal(descriptor.repositoryId, repositoryId);
    deepStrictEqual(await reader.at(initial.version), initial);
    deepStrictEqual({ compiles, recipes }, counts);
    const noBuildService = await GitModelRepository.openReadOnly({
      projectDir,
    });
    await rejects(() => noBuildService.at(initial.version), {
      code: "BUILD_UNAVAILABLE",
    });
    equal(
      canonical(await noBuildService.descriptorAt(initial.version)),
      canonical(descriptor),
    );
    const cancelled = new AbortController();
    const cancellation = new Error("Cancelled descriptor before lookup");
    cancelled.abort(cancellation);
    await rejects(
      () => reader.descriptorAt(initial.version, cancelled.signal),
      (error) => error === cancellation,
    );
    const Command = Deno.Command;
    try {
      for (const target of ["ls-tree", "cat-file"]) {
        const controller = new AbortController();
        const reason = new Error(`Cancelled descriptor during ${target}`);
        let receivedSignal: AbortSignal | undefined;
        Deno.Command = class extends Command {
          constructor(command: string | URL, options?: Deno.CommandOptions) {
            super(command, options);
            if (String(command) === "git" && options?.args?.includes(target)) {
              receivedSignal = options.signal;
              controller.abort(reason);
            }
          }
        };
        await rejects(
          () => reader.descriptorAt(initial.version, controller.signal),
          (error) => error === reason,
        );
        equal(receivedSignal, controller.signal);
      }
    } finally {
      Deno.Command = Command;
    }
    blobs.clear();
    const missing = await GitModelRepository.openReadOnly({
      projectDir,
      buildService: makeService(),
    });
    await rejects(() => missing.at(initial.version), {
      code: "BUILD_UNAVAILABLE",
    });
    deepStrictEqual({ compiles, recipes }, counts);
    deepStrictEqual(await files(projectDir), before);
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("read-only Git uses immutable objects despite local replacement refs", async () => {
  const projectDir = await Deno.makeTempDir({
    prefix: "ase-git-readonly-replace-",
  });
  try {
    const writer = await GitModelRepository.open({ projectDir, compiler });
    const from = await writer.initialize({
      "model.sysml": "package Original;",
    });
    const to = await writer.publishSystemSources(
      { "model.sysml": "package Replacement;" },
      from.version,
      "local-control",
    );
    await git(projectDir, [
      "replace",
      from.version.slice(7),
      to.version.slice(7),
    ]);
    const before = await files(projectDir);
    const reader = await GitModelRepository.openReadOnly({ projectDir });
    deepStrictEqual((await reader.at(from.version)).sources, from.sources);
    deepStrictEqual(
      await reader.readFirstParentInterval(from.version, to.version),
      {
        fromVersion: from.version,
        toVersion: to.version,
        complete: true,
        versions: [{ version: from.version, parents: [] }, {
          version: to.version,
          parents: [from.version],
        }],
      },
    );
    deepStrictEqual(await files(projectDir), before);
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("read-only Git verifies historical snapshot hashes and matching source bytes", async () => {
  const projectDir = await Deno.makeTempDir({
    prefix: "ase-git-readonly-corrupt-",
  });
  try {
    const writer = await GitModelRepository.open({ projectDir, compiler });
    const initial = await writer.initialize({
      "model.sysml": "package Original;",
    });
    const snapshotText = await git(projectDir, [
      "show",
      `${initial.version.slice(7)}:.ase-build.json`,
    ]);
    const sourceTree = await git(projectDir, [
      "rev-parse",
      `${initial.version.slice(7)}:sources`,
    ]);
    const snapshot = JSON.parse(snapshotText);
    snapshot.digest = "0".repeat(64);
    const corruptSnapshot = await git(projectDir, [
      "hash-object",
      "-w",
      "--stdin",
    ], JSON.stringify(snapshot));
    const validSnapshot = await git(projectDir, [
      "rev-parse",
      `${initial.version.slice(7)}:.ase-build.json`,
    ]);
    const changedSource = await git(projectDir, [
      "hash-object",
      "-w",
      "--stdin",
    ], "package Changed!;");
    const changedTree = await git(
      projectDir,
      ["mktree"],
      `100644 blob ${changedSource}\tmodel.sysml\n`,
    );
    const versions = [];
    for (
      const [snapshotOid, sourceTreeOid] of [[corruptSnapshot, sourceTree], [
        validSnapshot,
        changedTree,
      ]]
    ) {
      const tree = await git(
        projectDir,
        ["mktree"],
        `100644 blob ${snapshotOid}\t.ase-build.json\n040000 tree ${sourceTreeOid}\tsources\n`,
      );
      versions.push(
        `commit:${await git(
          projectDir,
          ["commit-tree", tree],
          "Corrupt historical snapshot\n",
        )}`,
      );
    }
    const before = await files(projectDir);
    const reader = await GitModelRepository.openReadOnly({ projectDir });
    for (const version of versions) {
      await rejects(() => reader.at(version), { code: "INVALID_REPOSITORY" });
    }
    deepStrictEqual(await files(projectDir), before);
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("read-only Git checks the 1 MiB interval commit limit before reading contents", async () => {
  const projectDir = await Deno.makeTempDir({
    prefix: "ase-git-readonly-size-",
  });
  const Command = Deno.Command;
  try {
    const writer = await GitModelRepository.open({ projectDir, compiler });
    const from = await writer.initialize({
      "model.sysml": "package Original;",
    });
    const tree = await git(projectDir, [
      "rev-parse",
      `${from.version.slice(7)}^{tree}`,
    ]);
    const headers = `tree ${tree}\nparent ${
      from.version.slice(7)
    }\nauthor Fixture <fixture@local.invalid> 0 +0000\ncommitter Fixture <fixture@local.invalid> 0 +0000\n\n`;
    const commitOfSize = async (size: number) =>
      `commit:${await git(projectDir, [
        "hash-object",
        "-t",
        "commit",
        "-w",
        "--stdin",
      ], headers + "x".repeat(size - headers.length))}`;
    const accepted = await commitOfSize(1024 * 1024);
    const oversized = await commitOfSize(1024 * 1024 + 1);
    const afterOversized = await commitSameTree(projectDir, from.version, [
      oversized,
    ], "Valid descendant");
    equal(
      await git(projectDir, ["cat-file", "-s", accepted.slice(7)]),
      String(1024 * 1024),
    );
    equal(
      await git(projectDir, ["cat-file", "-t", oversized.slice(7)]),
      "commit",
    );
    const before = await files(projectDir);
    const reader = await GitModelRepository.openReadOnly({ projectDir });
    const interval = await reader.readFirstParentInterval(
      from.version,
      accepted,
    );
    equal(interval.complete, true);
    deepStrictEqual(interval.versions, [
      { version: from.version, parents: [] },
      { version: accepted, parents: [from.version] },
    ]);
    let contentReads = 0;
    Deno.Command = class extends Command {
      constructor(command: string | URL, options?: Deno.CommandOptions) {
        super(command, options);
        if (String(command) === "git" && options?.args?.includes("--batch")) {
          contentReads++;
        }
      }
    };
    for (const fromVersion of [from.version, oversized]) {
      await rejects(
        () => reader.readFirstParentInterval(fromVersion, oversized),
        {
          code: "INVALID_REPOSITORY",
          message: "Git interval commit exceeds the 1 MiB read limit",
        },
      );
    }
    equal(
      contentReads,
      0,
      "oversized commits must be refused before requesting contents",
    );
    await rejects(
      () => reader.readFirstParentInterval(from.version, afterOversized),
      { code: "INVALID_REPOSITORY" },
    );
    equal(
      contentReads,
      1,
      "the oversized intermediate commit must not be read or omitted",
    );
    Deno.Command = Command;
    deepStrictEqual(await files(projectDir), before);
  } finally {
    Deno.Command = Command;
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("read-only Git opening preserves cancellation before reads, after filesystem steps and in Git", async () => {
  const projectDir = await Deno.makeTempDir({
    prefix: "ase-git-readonly-open-abort-",
  });
  const lstat = Deno.lstat;
  const Command = Deno.Command;
  try {
    const writer = await GitModelRepository.open({ projectDir, compiler });
    await writer.initialize({ "model.sysml": "package Original;" });
    const before = await files(projectDir);
    const aborted = new AbortController();
    const reason = new Error("Cancelled before opening");
    aborted.abort(reason);
    await rejects(
      () =>
        GitModelRepository.openReadOnly({
          projectDir: `${projectDir}/absent`,
          signal: aborted.signal,
        }),
      (error) => error === reason,
    );
    const duringFs = new AbortController();
    const fsReason = new Error("Cancelled during filesystem validation");
    let calls = 0;
    Deno.lstat = async (...args: Parameters<typeof Deno.lstat>) => {
      const result = await lstat(...args);
      calls++;
      duringFs.abort(fsReason);
      return result;
    };
    await rejects(
      () =>
        GitModelRepository.openReadOnly({
          projectDir,
          signal: duringFs.signal,
        }),
      (error) => error === fsReason,
    );
    equal(
      calls,
      1,
      "cancellation after an async step stops later opening steps",
    );
    Deno.lstat = lstat;
    const duringGit = new AbortController();
    const gitReason = new Error("Cancelled during opening Git");
    let receivedSignal: AbortSignal | undefined;
    Deno.Command = class extends Command {
      constructor(command: string | URL, options?: Deno.CommandOptions) {
        super(command, options);
        if (
          String(command) === "git" &&
          options?.args?.includes("--is-bare-repository")
        ) {
          receivedSignal = options.signal;
          duringGit.abort(gitReason);
        }
      }
    };
    await rejects(
      () =>
        GitModelRepository.openReadOnly({
          projectDir,
          signal: duringGit.signal,
        }),
      (error) => error === gitReason,
    );
    equal(receivedSignal, duringGit.signal);
    Deno.Command = Command;
    deepStrictEqual(await files(projectDir), before);
  } finally {
    Deno.lstat = lstat;
    Deno.Command = Command;
    await Deno.remove(projectDir, { recursive: true });
  }
});
