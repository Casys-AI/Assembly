import { deepStrictEqual, equal, notEqual, rejects } from "node:assert/strict";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { materialize } from "../../src/domain/model/value-objects/artifact.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import { ArtifactSourceError } from "../../src/domain/work/artifacts/source-reference.ts";
import {
  ModelRepositoryError,
  type PublicationFence,
} from "../../src/application/model/repository.ts";
import { repositoryWriterLock } from "../../src/adapters/out/git/writer-lock.ts";
import { modelSourceDigest } from "../../src/domain/model/value-objects/sources.ts";
import { ModelBuildService } from "../../src/application/model/builds/service.ts";
import {
  BuildStoreError,
  type ModelBuildStore,
} from "../../src/application/model/builds/ports/out/build-store.port.ts";

const compiler = {
  compile: (sources: Sources) => materialize([], sources, "shared-source-test"),
  recipe: () => {
    throw new Error("No fixture build recipe");
  },
};

Deno.test("descriptor-backed retained source commits preserve build identity and all-ref vault roots", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "assembly-shared-descriptor-",
  });
  const repositoryId = "33333333-3333-4333-8333-333333333333";
  const blobs = new Map<string, Uint8Array>();
  const recipe = {
    toolkit: { version: "fixture", bundleDigest: "b".repeat(64) },
    format: "fixture-json-v1",
    normalizerVersion: 1,
    irVersion: "0.1",
    artifactSchema: 1,
    engineVersion: "shared-source-test",
  };
  const descriptorCompiler = {
    ...compiler,
    recipe: () => Promise.resolve(recipe),
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
  const buildService = new ModelBuildService({
    repositoryId,
    store,
    compiler: descriptorCompiler,
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
    const repository = await GitModelRepository.open({
      projectDir: directory,
      repositoryId,
      compiler: descriptorCompiler,
      buildService,
    });
    const base = await repository.initialize({
      "main.sysml": "package Descriptor;\n",
    });
    const receipt = await repository.artifactSources("scope").retain({
      baseVersion: base.version,
      source: skill("# Descriptor source\n"),
    });
    const descriptor = await repository.descriptorAt(base.version);
    deepStrictEqual(
      await repository.descriptorAt(`commit:${receipt.reference.commitOid}`),
      descriptor,
    );
    deepStrictEqual(
      await repository.reachableArtifactDigests(),
      new Set([descriptor!.artifactDigest]),
    );
    equal(
      (await repository.header(`commit:${receipt.reference.commitOid}`))
        .sourceDigest,
      base.sourceDigest,
    );
    const sourceReader = await GitModelRepository.openArtifactSourcesReadOnly({
      projectDir: directory,
      scopeId: "scope",
    });
    deepStrictEqual(
      await sourceReader.read(receipt.reference),
      skill("# Descriptor source\n"),
    );
    equal((await repository.current()).version, base.version);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
async function git(
  directory: string,
  args: string[],
  input?: string,
): Promise<string> {
  const child = new Deno.Command("git", {
    args: [
      "--no-replace-objects",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      `--git-dir=${directory}/.git`,
      ...args,
    ],
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@local.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@local.invalid",
    },
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const output = await child.output();
  equal(output.success, true, new TextDecoder().decode(output.stderr));
  return new TextDecoder().decode(output.stdout).trim();
}
async function fixture(
  writeFence?: Parameters<typeof GitModelRepository.open>[0]["writeFence"],
) {
  const directory = await Deno.makeTempDir({ prefix: "assembly-shared-git-" });
  const options = { projectDir: directory, compiler, writeFence };
  const repository = await GitModelRepository.open(options);
  const base = await repository.initialize({
    "main.sysml": "package Initial;\n",
  });
  return {
    directory,
    options,
    repository,
    base,
    close: () => Deno.remove(directory, { recursive: true }),
  };
}
const skill = (content: string) => ({
  artifactId: "skill-1",
  kind: "skill-document" as const,
  content,
});

Deno.test("common Git retains exact source versions without altering admitted model identities", async () => {
  const f = await fixture();
  try {
    const sources = f.repository.artifactSources("scope");
    const first = await sources.retain({
      baseVersion: f.base.version,
      source: skill("# First\n"),
    });
    const second = await sources.retain({
      baseVersion: f.base.version,
      source: skill("# Second\n"),
    });
    const tool = {
      artifactId: "tool-1",
      kind: "tool-draft" as const,
      content: {
        name: "Tool",
        description: "Test tool",
        kind: "read_web_page" as const,
        code: "return 1;",
      },
    };
    const retainedTool = await sources.retain({
      baseVersion: f.base.version,
      source: tool,
    });
    notEqual(first.reference.commitOid, second.reference.commitOid);
    notEqual(first.reference.contentDigest, second.reference.contentDigest);
    const retained = await f.repository.at(
      `commit:${first.reference.commitOid}`,
    );
    equal(retained.sourceDigest, f.base.sourceDigest);
    equal(await modelSourceDigest(retained.sources), f.base.sourceDigest);
    equal(retained.provenanceDigest, f.base.provenanceDigest);
    equal(retained.semanticDigest, f.base.semanticDigest);
    deepStrictEqual(retained.sources, f.base.sources);
    equal((await f.repository.current()).version, f.base.version);
    deepStrictEqual(
      await sources.retain({
        baseVersion: f.base.version,
        source: skill("# First\n"),
      }),
      first,
    );
    await git(f.directory, [
      "update-ref",
      "refs/heads/authoring",
      first.reference.commitOid,
    ]);
    await git(f.directory, [
      "update-ref",
      "refs/heads/authoring",
      second.reference.commitOid,
    ]);
    await git(f.directory, ["update-ref", "-d", "refs/heads/authoring"]);
    await git(f.directory, ["gc", "--prune=now"]);
    const reopened = await GitModelRepository.open(f.options);
    const reader = await GitModelRepository.openArtifactSourcesReadOnly({
      projectDir: f.directory,
      scopeId: "scope",
    });
    deepStrictEqual(
      await reopened.artifactSources("scope").read(first.reference),
      skill("# First\n"),
    );
    deepStrictEqual(
      await reader.read(second.reference),
      skill("# Second\n"),
    );
    deepStrictEqual(
      await reader.read(retainedTool.reference),
      tool,
    );
    equal((await reopened.reachableArtifactDigests()).size, 0);
    await rejects(
      () => reopened.artifactSources("other").read(first.reference),
      (error: unknown) =>
        error instanceof ArtifactSourceError && error.code === "scope",
    );
    await rejects(
      () => sources.read({ ...first.reference, repositoryId: "other" }),
      ArtifactSourceError,
    );
    await rejects(
      () => sources.read({ ...first.reference, entryPath: "../SKILL.md" }),
      ArtifactSourceError,
    );
  } finally {
    await f.close();
  }
});

Deno.test("model proposal snapshots preserve declared artifact packages from their exact parent", async () => {
  const f = await fixture();
  try {
    const port = f.repository.artifactSources("scope");
    const receipt = await port.retain({
      baseVersion: f.base.version,
      source: skill("# Retained\n"),
    });
    const proposal = await f.repository.propose({
      baseVersion: `commit:${receipt.reference.commitOid}`,
      sources: { "main.sysml": "package Proposed;\n" },
      author: "fixture-host",
      reason: "Verify common tree preservation",
    });
    const entry = await git(f.directory, [
      "show",
      `${proposal.proposalVersion!.slice(7)}:${receipt.reference.entryPath}`,
    ]);
    equal(entry, "# Retained");
    notEqual(
      (await f.repository.header(proposal.proposalVersion!)).sourceDigest,
      f.base.sourceDigest,
    );
    deepStrictEqual(await port.read(receipt.reference), skill("# Retained\n"));
    equal((await f.repository.current()).version, f.base.version);
  } finally {
    await f.close();
  }
});

Deno.test("source command anchors recover exact receipts and refuse conflicts or lost fences", async () => {
  let lost = false;
  let guarded = 0;
  const f = await fixture({
    assertCurrent() {
      if (lost) {
        throw Object.assign(new Error("lost"), { code: "WRITE_FENCE_LOST" });
      }
      return Promise.resolve();
    },
    async guard<T>(
      _fence: PublicationFence,
      operation: () => Promise<T>,
    ): Promise<T> {
      guarded++;
      if (lost) {
        throw Object.assign(new Error("lost"), { code: "WRITE_FENCE_LOST" });
      }
      return await operation();
    },
  });
  try {
    const command = {
      commandId: "source-command",
      commandDigest: "a".repeat(64),
    };
    const fence = {
      repositoryId: f.repository.repositoryId,
      commandId: command.commandId,
      owner: "fixture",
      fence: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    } satisfies PublicationFence;
    const input = {
      baseVersion: f.base.version,
      source: skill("# Command\n"),
      command,
      fence,
    };
    const port = f.repository.artifactSources("scope");
    const receipt = await port.retain(input);
    equal(guarded, 1);
    deepStrictEqual(await port.findByCommand(command), receipt);
    deepStrictEqual(await port.retain(input), receipt);
    equal(guarded, 1);
    await rejects(
      () => port.retain({ ...input, source: skill("# Conflict\n") }),
      ArtifactSourceError,
    );
    await rejects(
      () => port.findByCommand({ ...command, commandDigest: "b".repeat(64) }),
      ArtifactSourceError,
    );
    await git(f.directory, [
      "update-ref",
      "-d",
      `refs/assembly/source-commands/${command.commandId}`,
    ]);
    deepStrictEqual(await port.retain(input), receipt);
    deepStrictEqual(await port.findByCommand(command), receipt);
    lost = true;
    await rejects(
      () =>
        port.retain({
          ...input,
          command: { ...command, commandId: "lost-command" },
          fence: { ...fence, commandId: "lost-command" },
        }),
      (error: unknown) =>
        !!error && typeof error === "object" && "code" in error &&
        error.code === "WRITE_FENCE_LOST",
    );
    equal(
      await port.findByCommand({ ...command, commandId: "lost-command" }),
      null,
    );
    equal((await f.repository.current()).version, f.base.version);
  } finally {
    await f.close();
  }
});

Deno.test("shared source reads reject symbolic retention refs and undeclared tree entries", async () => {
  const f = await fixture();
  try {
    const port = f.repository.artifactSources("scope");
    const receipt = await port.retain({
      baseVersion: f.base.version,
      source: skill("# Exact\n"),
    });
    const ref = receipt.reference;
    const retainedRef = `refs/assembly/sources/v2/${ref.manifestDigest}`;
    await git(f.directory, ["update-ref", "-d", retainedRef]);
    await rejects(
      () => port.read(ref),
      (error: unknown) =>
        error instanceof ArtifactSourceError && error.code === "not-found",
    );
    await git(f.directory, [
      "symbolic-ref",
      retainedRef,
      "refs/heads/admitted",
    ]);
    await rejects(() => port.read(ref), ArtifactSourceError);
    await git(f.directory, ["symbolic-ref", "--delete", retainedRef]);
    await git(f.directory, ["update-ref", retainedRef, ref.commitOid]);
    const blob = await git(
      f.directory,
      ["hash-object", "-w", "--stdin"],
      "unlisted",
    );
    for (
      const [mode, path] of [["100644", "undeclared.txt"], [
        "120000",
        ref.entryPath,
      ], ["100644", ref.entryPath]]
    ) {
      await git(f.directory, ["read-tree", `${ref.commitOid}^{tree}`]);
      await git(f.directory, [
        "update-index",
        "--add",
        "--cacheinfo",
        mode,
        blob,
        path,
      ]);
      const tree = await git(f.directory, ["write-tree"]);
      const forged = await git(f.directory, [
        "commit-tree",
        tree,
        "-p",
        ref.commitOid,
      ], "forged fixture\n");
      await git(f.directory, ["update-ref", retainedRef, forged]);
      await rejects(
        () => port.read({ ...ref, commitOid: forged }),
        ArtifactSourceError,
      );
      await rejects(() => f.repository.header(`commit:${forged}`));
    }
  } finally {
    await f.close();
  }
});

Deno.test("source-only readers freeze their host scope and fail safely without initializing missing paths", async () => {
  const f = await fixture();
  try {
    const receipt = await f.repository.artifactSources("scope").retain({
      baseVersion: f.base.version,
      source: skill("# Bound scope\n"),
    });
    const options = { projectDir: f.directory, scopeId: "scope" };
    const pending = GitModelRepository.openArtifactSourcesReadOnly(options);
    options.scopeId = "other";
    const reader = await pending;
    deepStrictEqual(
      await reader.read(receipt.reference),
      skill("# Bound scope\n"),
    );
    const missing = `${f.directory}/private-missing-source-location`;
    await rejects(
      () =>
        GitModelRepository.openArtifactSourcesReadOnly({
          projectDir: missing,
          scopeId: "scope",
        }),
      (error: unknown) =>
        error instanceof ArtifactSourceError &&
        error.message === "Artifact source: repository",
    );
    await rejects(() => Deno.lstat(missing), Deno.errors.NotFound);
  } finally {
    await f.close();
  }
});

Deno.test("source retention rechecks authority after waiting for the existing Git writer lock", async () => {
  const f = await fixture();
  const originalLock = Deno.FsFile.prototype.lock;
  let release!: () => void;
  let entered!: () => void;
  let attempted!: () => void;
  const hold = new Promise<void>((resolve) => release = resolve);
  const held = new Promise<void>((resolve) => entered = resolve);
  const waiting = new Promise<void>((resolve) => attempted = resolve);
  let holder: Promise<void> | undefined;
  let pending: Promise<unknown> | undefined;
  let authority = true;
  try {
    const port = f.repository.artifactSources("scope");
    const old = await port.retain({
      baseVersion: f.base.version,
      source: skill("# Original exact bytes\n"),
    });
    const before = await git(f.directory, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/assembly/sources/v2/",
    ]);
    const lock = await repositoryWriterLock(f.repository.stateDir);
    holder = lock.runExclusive(async () => {
      entered();
      await hold;
    });
    await held;
    let checks = 0;
    Deno.FsFile.prototype.lock = function (
      this: Deno.FsFile,
      exclusive?: boolean,
    ) {
      attempted();
      return originalLock.call(this, exclusive);
    };
    pending = port.retain({
      baseVersion: f.base.version,
      source: skill("# Refused changed bytes\n"),
    }, {
      assertCurrent() {
        checks++;
        if (!authority) {
          throw new ModelRepositoryError(
            "EDIT_SCOPE_DENIED",
            "Source publication authority changed",
          );
        }
        return Promise.resolve();
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        waiting,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() =>
            reject(
              new Error("Source writer did not wait on the existing lock"),
            ), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    equal(checks, 0);
    authority = false;
    release();
    await holder;
    await rejects(
      () => pending!,
      (error: unknown) =>
        error instanceof ModelRepositoryError &&
        error.code === "EDIT_SCOPE_DENIED",
    );
    equal(checks, 1);
    equal(
      await git(f.directory, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/assembly/sources/v2/",
      ]),
      before,
    );
    deepStrictEqual(
      await port.read(old.reference),
      skill("# Original exact bytes\n"),
    );
    equal((await f.repository.current()).version, f.base.version);
  } finally {
    authority = false;
    release?.();
    await holder;
    await pending?.catch(() => {});
    Deno.FsFile.prototype.lock = originalLock;
    await f.close();
  }
});
