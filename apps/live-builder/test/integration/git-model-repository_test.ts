import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import {
  materialize,
  sha256,
} from "../../src/adapters/model/builds/materialization/artifact.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { ModelRepositoryError } from "../../src/application/model/repository.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { ChangePublicationError } from "../../src/domain/model/publication/change.ts";
import { modelSourceDigest } from "../../src/domain/model/value-objects/sources.ts";
import {
  ModelBuildService,
  ModelBuildServiceError,
} from "../../src/application/model/builds/service.ts";
import {
  BuildStoreError,
  type ModelBuildStore,
} from "../../src/application/model/builds/ports/out/build-store.port.ts";
import {
  changePublication,
  preparePublication,
} from "../../src/domain/model/publication/change.ts";
import type { PendingChange } from "../../src/domain/governance/records/pending-change.ts";
import { deflateSync } from "node:zlib";
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
// This deterministic compiler fixture materializes real CompiledModel IR, rather
// than accepting or inventing alternate toolkit output. Real compiler case below.
const compiler = {
  compile: (sources: Sources) => materialize([], sources, "fixture-engine"),
  recipe: () => {
    throw new Error("Fixture compiler reports no build recipe");
  },
};
const source = (name: string): Sources => ({
  "nested/model.sysml": `package ${name};\n`,
});

Deno.test("queued Git acceptance holds its fence through CAS and retries after loss", async () => {
  const projectDir = await Deno.makeTempDir();
  let rejectGuard = true;
  let guarded = 0;
  try {
    const options = {
      projectDir,
      compiler,
      writeFence: {
        async assertCurrent() {},
        async guard<T>(
          _fence: unknown,
          operation: () => Promise<T>,
        ): Promise<T> {
          guarded++;
          if (rejectGuard) {
            throw Object.assign(new Error("lease lost before CAS"), {
              code: "WRITE_FENCE_LOST",
            });
          }
          return await operation();
        },
      },
    };
    let repo = await GitModelRepository.open(options);
    const initial = await repo.initialize(source("Initial"));
    const proposal = await repo.propose({
      baseVersion: initial.version,
      sources: source("Next"),
      author: "operator",
      reason: "fenced acceptance",
    });
    const command = { commandId: proposal.id, commandDigest: "a".repeat(64) };
    const fence = {
      repositoryId: repo.repositoryId,
      commandId: proposal.id,
      owner: "worker",
      fence: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await rejects(
      () =>
        repo.accept({
          id: proposal.id,
          expectedVersion: initial.version,
          author: "reviewer",
          command,
          fence,
        }),
      /lease lost before CAS/,
    );
    equal((await repo.current()).version, initial.version);
    repo = await GitModelRepository.open(options);
    equal((await repo.proposal(proposal.id)).status, "proposed");
    rejectGuard = false;
    const accepted = await repo.accept({
      id: proposal.id,
      expectedVersion: initial.version,
      author: "reviewer",
      command,
      fence,
    });
    equal(guarded, 2);
    equal(
      (await repo.findPublicationByCommand(proposal.id))?.revision.version,
      accepted.version,
    );
    equal(
      (await repo.findPublicationByCommand(proposal.id))?.commandDigest,
      command.commandDigest,
    );
    equal(await repo.descriptorAt(accepted.version), null);
    equal((await repo.reachableArtifactDigests()).size, 0);
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("prepared Git publication reuses verified bytes without compiling under lock", async () => {
  const projectDir = await Deno.makeTempDir();
  const repositoryId = "33333333-3333-4333-8333-333333333333";
  const blobs = new Map<string, Uint8Array>();
  let compileCount = 0;
  const recipe = {
    toolkit: { version: "fixture", bundleDigest: "b".repeat(64) },
    format: "fixture-json-v1",
    normalizerVersion: 1,
    irVersion: "0.1",
    artifactSchema: 1,
    engineVersion: "fixture-engine",
  };
  const countedCompiler = {
    async compile(sources: Sources) {
      compileCount++;
      return await materialize([], sources, recipe.engineVersion);
    },
    recipe() {
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
  const buildService = new ModelBuildService({
    repositoryId,
    store,
    compiler: countedCompiler,
    materializer: {
      async materialize({ artifact, sources }) {
        return await materialize(
          artifact.elements,
          sources,
          artifact.engineVersion,
          artifact.provider,
        );
      },
    },
  });
  try {
    const repo = await GitModelRepository.open({
      projectDir,
      repositoryId,
      compiler: countedCompiler,
      buildService,
    });
    const initial = await repo.initialize(source("Initial"));
    const candidateSources = source("Prepared");
    const compiled = await countedCompiler.compile(candidateSources);
    const descriptor = await buildService.ensure(compiled, recipe);
    equal(compileCount, 2);
    const pin = {
      digest: "base-model",
      repositoryVersion: initial.version,
      rootId: "root",
      configurationId: "configuration",
      configurationRevision: 0,
      sourceIds: ["source"],
    };
    const change: PendingChange = {
      id: "22222222-2222-4222-8222-222222222222",
      kind: "mandate-change",
      status: "approved",
      baseRevision: 0,
      baseModelDigest: pin.digest,
      requestedAt: "now",
      decidedAt: "later",
      reason: "Verified candidate",
      authorityExercise: exerciseOwnerAuthority(
        { identity: { systemId: "system" }, version: pin },
        "mandate-change",
      ),
    };
    const approval = changePublication(change, pin);
    const receipt = preparePublication(approval, {
      executionBase: {
        repositoryVersion: initial.version,
        sourceDigest: initial.sourceDigest,
      },
      replayedEdits: [],
      revalidation: {
        checkedAt: new Date().toISOString(),
        executionBaseVersion: initial.version,
        scopeDigest: "c".repeat(64),
        authorityStillValid: true,
        preconditionsChecked: 0,
        baseUnchanged: true,
      },
      result: {
        sourceDigest: descriptor.sourceDigest,
        recipeDigest: descriptor.recipe.digest,
        buildKey: descriptor.buildKey,
        artifactDigest: descriptor.artifactDigest,
      },
    });
    blobs.delete(descriptor.artifactDigest);
    await rejects(
      () =>
        repo.publishPrepared({
          expectedHeadVersion: initial.version,
          sources: candidateSources,
          author: `ase:approved-change:${change.id}`,
          receipt,
          descriptor,
        }),
      (error: unknown) =>
        error instanceof ModelBuildServiceError &&
        error.code === "BUILD_UNAVAILABLE",
    );
    equal(compileCount, 2);
    await buildService.ensure(compiled, recipe);
    const published = await repo.publishPrepared({
      expectedHeadVersion: initial.version,
      sources: candidateSources,
      author: `ase:approved-change:${change.id}`,
      receipt,
      descriptor,
    });
    equal(compileCount, 2);
    equal(
      (await repo.descriptorAt(published.version))?.artifactDigest,
      descriptor.artifactDigest,
    );
    assert(
      (await repo.reachableArtifactDigests()).has(descriptor.artifactDigest),
    );
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("Git decision receipts preserve owner authority and explicit recovery across reopen", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const options = { projectDir, compiler };
    let repo = await GitModelRepository.open(options);
    const initial = await repo.initialize(source("Initial"));
    const authorityExercise = exerciseOwnerAuthority(
      {
        identity: { systemId: "system" },
        version: { digest: "base-execution-digest" },
      },
      "model-revision",
      { outOfMandate: true, reason: "Repair root authority" },
    );
    const proposal = await repo.propose({
      baseVersion: initial.version,
      sources: source("Restored"),
      author: "local-owner",
      reason: "Repair root authority",
      authorization: { kind: "local-owner", authorityExercise },
    });
    const accepted = await repo.accept({
      id: proposal.id,
      expectedVersion: initial.version,
      author: "local-control",
      decisionAuthorityExercise: authorityExercise,
    });
    repo = await GitModelRepository.open(options);
    const restored = await repo.proposal(proposal.id);
    assert(restored.status === "accepted");
    assert(
      canonical(restored.decisionAuthorityExercise) ===
        canonical(authorityExercise),
    );
    assert(restored.authorization?.kind === "local-owner");
    assert(
      canonical(restored.authorization.authorityExercise) ===
        canonical(authorityExercise),
    );
    assert(
      (await repo.at(initial.version)).sourceDigest === initial.sourceDigest,
    );
    const rejected = await repo.propose({
      baseVersion: accepted.version,
      sources: source("Rejected"),
      author: "local-owner",
      reason: "Not adopted",
      authorization: { kind: "local-owner", authorityExercise },
    });
    await repo.reject({
      id: rejected.id,
      author: "local-control",
      decisionAuthorityExercise: authorityExercise,
    });
    repo = await GitModelRepository.open(options);
    assert(
      canonical(
        (await repo.proposal(rejected.id)).decisionAuthorityExercise,
      ) === canonical(authorityExercise),
    );
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});
async function fails(fn: () => Promise<unknown>, contains: string) {
  try {
    await fn();
  } catch (error) {
    assert(String(error).includes(contains), String(error));
    return;
  }
  throw new Error("Expected failure");
}
async function fixtureGit(
  projectDir: string,
  args: string[],
  input?: string | Uint8Array | AsyncIterable<Uint8Array>,
): Promise<string> {
  const child = new Deno.Command("git", {
    args: [`--git-dir=${projectDir}/.git`, ...args],
    env: {
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
      if (typeof input === "string" || input instanceof Uint8Array) {
        await writer.write(
          typeof input === "string" ? new TextEncoder().encode(input) : input,
        );
      } else {
        for await (const chunk of input) await writer.write(chunk);
      }
    } finally {
      await writer.close();
    }
  };
  const [output] = await Promise.all([child.output(), write()]);
  assert(output.success, new TextDecoder().decode(output.stderr));
  return new TextDecoder().decode(output.stdout).trim();
}
async function refusesWithBoundedReads(
  repo: GitModelRepository,
  version: string,
  message: string,
  allowContents = false,
) {
  const Command = Deno.Command;
  const commands: string[][] = [];
  try {
    Deno.Command = class extends Command {
      constructor(command: string | URL, options?: Deno.CommandOptions) {
        super(command, options);
        if (String(command) !== "git") return;
        const args = options?.args ?? [];
        commands.push(args);
        // Fail safely if preflight regresses: never let the duplicate fixture
        // actually request 10 GiB of contents in the test process.
        if (
          args.includes("show") ||
          args.includes("cat-file") &&
            !(allowContents && args.includes("--batch-command"))
        ) {
          throw new Error("Unexpected Git content read before rejection");
        }
      }
    };
    let refused = false;
    try {
      await repo.at(version);
    } catch (error) {
      assert(error instanceof ModelRepositoryError, String(error));
      assert(error.code === "INVALID_REPOSITORY");
      assert(error.message.includes(message), error.message);
      refused = true;
    }
    assert(refused, "Forged tree was accepted");
  } finally {
    Deno.Command = Command;
  }
  const reads = commands.filter((args) => args.includes("cat-file"));
  assert(
    allowContents
      ? reads.length === 1 && reads[0].includes("--batch-command")
      : reads.length === 0,
    "Rejected tree exceeded the expected Git content reads",
  );
}
async function journal(
  dir: string,
  id: string,
  update: (record: Record<string, unknown>) => void,
) {
  const path = `${dir}/.assembly/runtime/proposals/${id}.json`;
  const record = JSON.parse(await Deno.readTextFile(path));
  update(record.value);
  record.digest = await sha256(canonical(record.value));
  await Deno.writeTextFile(path, JSON.stringify(record));
}
Deno.test("Git immutable history, proposals, recovery, drafts, conflicts and corruption", async () => {
  const projectDir = await Deno.makeTempDir();
  const at = "2026-11-02T03:00:00.000Z";
  try {
    await Deno.mkdir(`${projectDir}/sources`);
    await Deno.writeTextFile(
      `${projectDir}/sources/draft.sysml`,
      "human unsaved draft",
    );
    let repo = await GitModelRepository.open({
      projectDir,
      compiler,
      clock: { now: () => at },
    });
    const initial = await repo.initialize(source("Initial"));
    assert(/^commit:[a-f0-9]{40}$/.test(initial.version));
    const proposed = await repo.propose({
      baseVersion: initial.version,
      sources: source("Proposed"),
      author: "operator",
      reason: "review",
    });
    assert((await repo.current()).version === initial.version);
    equal(proposed.createdAt, at);
    const accepted = await repo.accept({
      id: proposed.id,
      expectedVersion: initial.version,
      author: "reviewer",
    });
    assert(
      (await repo.at(initial.version)).sources["nested/model.sysml"] ===
        "package Initial;\n",
    );
    assert(
      await Deno.readTextFile(`${projectDir}/sources/draft.sysml`) ===
        "human unsaved draft",
    );
    const history = await repo.history();
    assert(
      history.commits.length === 2 &&
        history.commits[0].parents.includes(proposed.proposalVersion!),
    );
    assert((await repo.history({ limit: 1 })).truncated);
    const rejected = await repo.propose({
      baseVersion: accepted.version,
      sources: source("Rejected"),
      author: "operator",
      reason: "discard",
    });
    await repo.reject({ id: rejected.id, author: "reviewer" });
    repo = await GitModelRepository.open({ projectDir, compiler });
    const retainedRejection = await repo.proposal(rejected.id);
    assert(retainedRejection.status === "rejected");
    equal(retainedRejection.createdAt, at);
    equal(retainedRejection.decidedAt, at);
    assert(
      (await repo.accept({
        id: proposed.id,
        expectedVersion: initial.version,
        author: "reviewer",
      })).version === accepted.version,
    );
    // Recreate a crash after CAS but before final receipt, then advance admitted
    // head: recovery must recognize the exact ancestor, not just equal content.
    await journal(projectDir, proposed.id, (record) => {
      record.status = "accepting";
      delete record.acceptedVersion;
    });
    const later = await repo.publishSystemSources(
      source("Later"),
      accepted.version,
      "system",
    );
    repo = await GitModelRepository.open({ projectDir, compiler });
    assert(
      (await repo.proposal(proposed.id)).acceptedVersion === accepted.version,
    );
    const concurrent = await GitModelRepository.open({ projectDir, compiler });
    const results = await Promise.allSettled([
      repo.publishSystemSources(source("A"), later.version, "one"),
      concurrent.publishSystemSources(source("B"), later.version, "two"),
    ]);
    assert(
      results.filter((result) => result.status === "fulfilled").length === 1,
      "Concurrent CAS admitted two writers",
    );
    const pending = await repo.propose({
      baseVersion: (await repo.current()).version,
      sources: source("Pending"),
      author: "operator",
      reason: "recover preparing",
    });
    await journal(projectDir, pending.id, (record) => {
      record.status = "preparing";
    });
    repo = await GitModelRepository.open({ projectDir, compiler });
    assert((await repo.proposal(pending.id)).status === "proposed");
    await Deno.writeTextFile(
      `${projectDir}/.assembly/runtime/proposals/${pending.id}.json`,
      "{}",
    );
    await fails(() => repo.listProposals(), "journal");
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});
Deno.test("Git rejects source artifact corruption and never adopts unrelated repositories", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    const initial = await repo.initialize(source("Initial"));
    await repo.exportSources(initial.version);
    await Deno.writeTextFile(
      `${repo.admittedSourcesDirectory(initial.version)}/nested/model.sysml`,
      "changed",
    );
    assert((await repo.current()).version === initial.version);
    await fails(() => repo.exportSources(initial.version), "export differs");
    const oid = initial.version.slice(7);
    const file = `${projectDir}/.git/objects/${oid.slice(0, 2)}/${
      oid.slice(2)
    }`;
    await Deno.chmod(file, 0o644);
    await Deno.writeTextFile(file, "corrupt Git object");
    await fails(() => repo.current(), "Git");
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
  const unrelated = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${unrelated}/.git`);
    await fails(
      () => GitModelRepository.open({ projectDir: unrelated, compiler }),
      "Unidentified",
    );
  } finally {
    await Deno.remove(unrelated, { recursive: true });
  }
});

Deno.test("Git batch reads preserve UTF-8 bytes across 64 nested source files", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    const sources = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [
        `nested/group${i % 4}/model${i}.sysml`,
        `// café 臺灣 🚀\r\npackage Model${i};${i % 2 ? "\n" : ""}`,
      ]),
    );
    const initial = await repo.initialize(sources);
    const first = await repo.at(initial.version);
    assert(canonical(first.sources) === canonical(sources));
    first.sources["nested/group0/model0.sysml"] = "caller mutation";
    const second = await repo.at(initial.version);
    assert(canonical(second.sources) === canonical(sources));
    assert(canonical(second) === canonical(initial));
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("Git metadata rejects 10000 duplicate paths before reading their 1 MiB blob", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    const initial = await repo.initialize(source("Initial"));
    const git = (args: string[], input?: Uint8Array | string) =>
      fixtureGit(projectDir, args, input);
    const oid = initial.version.slice(7);
    const blob = await git(
      ["hash-object", "-w", "--stdin"],
      "x".repeat(1_048_576),
    );
    const snapshot = await git(["rev-parse", `${oid}:.ase-build.json`]);
    const name = new TextEncoder().encode("100644 model.sysml\0");
    const entry = new Uint8Array(name.length + 20);
    entry.set(name);
    entry.set(
      Uint8Array.from(blob.match(/../g)!, (byte) => parseInt(byte, 16)),
      name.length,
    );
    const duplicate = new Uint8Array(entry.length * 10000);
    for (let i = 0; i < 10000; i++) duplicate.set(entry, i * entry.length);
    const nested = await git(
      ["hash-object", "--literally", "-t", "tree", "-w", "--stdin"],
      duplicate,
    );
    const sources = await git(["mktree"], `040000 tree ${nested}\tnested\n`);
    const tree = await git(
      ["mktree"],
      `100644 blob ${snapshot}\t.ase-build.json\n040000 tree ${sources}\tsources\n`,
    );
    const forged = await git(
      ["commit-tree", tree, "-p", oid],
      "Duplicate paths\n",
    );
    await refusesWithBoundedReads(
      repo,
      `commit:${forged}`,
      "Git source tree differs from compiled snapshot",
    );
    assert((await repo.current()).version === initial.version);
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("Git metadata rejects unexpected blobs and declared size limits before contents", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    const initial = await repo.initialize({
      "model.sysml": "package Initial;",
    });
    const git = (args: string[], input?: Uint8Array | string) =>
      fixtureGit(projectDir, args, input);
    const oid = initial.version.slice(7);
    const snapshot = await git(["rev-parse", `${oid}:.ase-build.json`]);
    const original = await git(["rev-parse", `${oid}:sources/model.sysml`]);
    const large = await git(
      ["hash-object", "-w", "--stdin"],
      "x".repeat(1_048_577),
    );
    const oneMiB = await git(
      ["hash-object", "-w", "--stdin"],
      "x".repeat(1_048_576),
    );
    const forge = async (
      files: Array<[string, string]>,
      snapshotOid = snapshot,
      extraRoot = "",
    ) => {
      const sources = await git(
        ["mktree"],
        files.map(([path, blob]) => `100644 blob ${blob}\t${path}\n`).join(""),
      );
      const tree = await git(
        ["mktree"],
        `100644 blob ${snapshotOid}\t.ase-build.json\n040000 tree ${sources}\tsources\n${extraRoot}`,
      );
      return `commit:${await git(
        ["commit-tree", tree, "-p", oid],
        "Forged\n",
      )}`;
    };
    await refusesWithBoundedReads(
      repo,
      await forge(
        [["model.sysml", original]],
        snapshot,
        `100644 blob ${large}\textra.bin\n`,
      ),
      "Unexpected Git snapshot path or mode",
    );
    await refusesWithBoundedReads(
      repo,
      await forge([["model.sysml", original], ["extra.sysml", large]]),
      "SysML source size limit exceeded",
    );
    await refusesWithBoundedReads(
      repo,
      await forge([["model.sysml", large]]),
      "SysML source size limit exceeded",
    );
    await refusesWithBoundedReads(
      repo,
      await forge(
        Array.from({ length: 9 }, (_, i) => [`model${i}.sysml`, oneMiB]),
      ),
      "SysML source size limit exceeded",
    );
    await refusesWithBoundedReads(
      repo,
      await forge([["model.sysml", original], ["extra.sysml", original]]),
      "Git source tree differs from compiled snapshot",
      true,
    );
    assert((await repo.current()).version === initial.version);
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("Git batch reads each shared source blob once", async () => {
  const projectDir = await Deno.makeTempDir();
  const Command = Deno.Command;
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    const sources = Object.fromEntries(
      Array.from(
        { length: 64 },
        (_, i) => [`model${i}.sysml`, "package Shared;\n"],
      ),
    );
    const initial = await repo.initialize(sources);
    const chunks: Uint8Array[] = [];
    const commands: string[][] = [];
    Deno.Command = class extends Command {
      #batch: boolean;
      constructor(command: string | URL, options?: Deno.CommandOptions) {
        super(command, options);
        const args = options?.args ?? [];
        if (String(command) === "git") commands.push(args);
        this.#batch = String(command) === "git" &&
          args.includes("--batch-command");
      }
      override spawn(): Deno.ChildProcess {
        const child = super.spawn();
        if (this.#batch) {
          Object.defineProperty(child, "stdout", {
            value: child.stdout.pipeThrough(
              new TransformStream({
                transform(chunk, controller) {
                  chunks.push(chunk);
                  controller.enqueue(chunk);
                },
              }),
            ),
          });
        }
        return child;
      }
    };
    assert(
      canonical((await repo.at(initial.version)).sources) ===
        canonical(sources),
    );
    assert(
      commands.length === 2,
      "Source count must not increase subprocesses",
    );
    const frames = await new Blob(chunks.map((chunk) => chunk.slice())).text();
    assert(
      frames.match(/[a-f0-9]{40} blob 16\npackage Shared;\n\n/g)?.length === 1,
      "Shared source OID must appear in the batch output exactly once",
    );
    commands.length = 0;
    assert((await repo.current()).version === initial.version);
    assert(
      commands.length === 3,
      "Current revision must use at most three Git processes",
    );
  } finally {
    Deno.Command = Command;
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("Git recovery memo detects changed journals, refs and objects with unchanged heads", async () => {
  for (const damage of ["journal", "ref", "object"]) {
    const projectDir = await Deno.makeTempDir();
    try {
      const repo = await GitModelRepository.open({ projectDir, compiler });
      const initial = await repo.initialize(source("Initial"));
      const proposal = await repo.propose({
        baseVersion: initial.version,
        sources: source("Proposed"),
        author: "operator",
        reason: "recover memo integrity",
      });
      await repo.listProposals();
      await repo.listProposals();
      const git = async (...args: string[]) => {
        const output = await new Deno.Command("git", {
          args: [`--git-dir=${projectDir}/.git`, ...args],
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert(output.success, new TextDecoder().decode(output.stderr));
        return new TextDecoder().decode(output.stdout).trim();
      };
      if (damage === "journal") {
        await journal(projectDir, proposal.id, (record) => {
          record.status = "unknown";
        });
        await fails(() => repo.listProposals(), "journal status");
      } else if (damage === "ref") {
        await git(
          "update-ref",
          `refs/heads/${proposal.branch}`,
          initial.version.slice(7),
        );
        await fails(() => repo.listProposals(), "branch differs");
      } else {
        const oid = await git(
          "rev-parse",
          `${proposal.proposalVersion!.slice(7)}:sources/nested/model.sysml`,
        );
        const path = `${projectDir}/.git/objects/${oid.slice(0, 2)}/${
          oid.slice(2)
        }`;
        const bytes = await Deno.readFile(path);
        const old = await Deno.stat(path);
        await Deno.chmod(path, 0o644);
        // Same size and restored mtime: timestamp-only invalidation is unsafe.
        await Deno.writeFile(path, new Uint8Array(bytes.length));
        if (old.atime && old.mtime) {
          await Deno.utime(path, old.atime, old.mtime);
        }
        await fails(() => repo.listProposals(), "Git");
      }
      assert((await repo.current()).version === initial.version);
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  }
});
Deno.test("Git recovery cache stays cheap after packing history", async () => {
  const projectDir = await Deno.makeTempDir();
  const readFile = Deno.readFile;
  const Command = Deno.Command;
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    const initial = await repo.initialize(source("Initial"));
    const proposal = await repo.propose({
      baseVersion: initial.version,
      sources: source("Proposed"),
      author: "operator",
      reason: "packed history",
    });
    await repo.accept({
      id: proposal.id,
      expectedVersion: initial.version,
      author: "reviewer",
    });
    const output = await new Command("git", {
      args: [`--git-dir=${projectDir}/.git`, "gc", "--prune=now"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(output.success, new TextDecoder().decode(output.stderr));
    const packFiles = [];
    for await (const entry of Deno.readDir(`${projectDir}/.git/objects/pack`)) {
      if (entry.name.endsWith(".pack")) packFiles.push(entry.name);
    }
    assert(packFiles.length > 0, "The fixture must use packed objects");
    const reads: string[] = [];
    Deno.readFile = (path, options) => {
      if (String(path).includes(`${projectDir}/.git/objects/`)) {
        reads.push(String(path));
      }
      return readFile(path, options);
    };
    // Stabilize dependencies and warm recovery after loose objects move to packs.
    await repo.listProposals();
    await repo.listProposals();
    const commands: string[][] = [];
    Deno.Command = class extends Command {
      constructor(command: string | URL, options?: Deno.CommandOptions) {
        super(command, options);
        if (String(command) === "git") commands.push(options?.args ?? []);
      }
    };
    const recovered = (await repo.listProposals())[0];
    assert(recovered.id === proposal.id && recovered.status === "accepted");
    assert(
      reads.length === 0,
      `Recovery read object contents: ${reads.join(", ")}`,
    );
    assert(
      commands.length === 1 && commands[0].includes("for-each-ref"),
      "An unchanged recovery must only query refs once, without rereading snapshots",
    );
    const pack = `${projectDir}/.git/objects/pack/${packFiles[0]}`;
    const old = await Deno.stat(pack);
    await Deno.chmod(pack, 0o644);
    const file = await Deno.open(pack, { write: true });
    try {
      // Preserve the pack length and mtime while damaging its signature.
      await file.write(new Uint8Array([0]));
    } finally {
      file.close();
    }
    if (old.atime && old.mtime) await Deno.utime(pack, old.atime, old.mtime);
    await fails(() => repo.listProposals(), "Git");
  } finally {
    Deno.readFile = readFile;
    Deno.Command = Command;
    await Deno.remove(projectDir, { recursive: true });
  }
});

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
Deno.test({
  name: "real Toolkit artifact survives Git publication and reopen",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const projectDir = await Deno.makeTempDir();
    try {
      const options = {
        projectDir,
        compiler: new ToolkitCompiler({ packageDir: packageDir! }),
      };
      const repo = await GitModelRepository.open(options);
      const initial = await repo.initialize(source("RealCompiler"));
      const reopened = await GitModelRepository.open(options);
      assert(
        canonical(await reopened.at(initial.version)) === canonical(initial),
      );
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
});

Deno.test("separate Git writer processes serialize CAS without losing immutable pins", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    const initial = await repo.initialize(source("Initial"));
    const module = new URL(
      "../../src/adapters/out/git/repository.ts",
      import.meta.url,
    )
      .href;
    const ir = new URL(
      "../../src/adapters/model/builds/materialization/artifact.ts",
      import.meta.url,
    ).href;
    const code = `import {GitModelRepository} from ${JSON.stringify(module)};
      import {materialize} from ${JSON.stringify(ir)};
      const [projectDir,expectedVersion,name]=Deno.args;
      const compiler={compile:(sources)=>materialize([],sources,"fixture-engine")};
      const repo=await GitModelRepository.open({projectDir,compiler});
      try { await repo.publishSystemSources({"nested/model.sysml":"package "+name+";\\n"},expectedVersion,name); console.log("admitted"); }
      catch(error) { if(error.code!=="STALE_REVISION") throw error; console.log("stale"); }`;
    const run = (name: string) =>
      new Deno.Command(Deno.execPath(), {
        args: ["eval", code, projectDir, initial.version, name],
        stdout: "piped",
        stderr: "piped",
      }).output();
    const outputs = await Promise.all([run("ProcessA"), run("ProcessB")]);
    assert(
      outputs.every((output) => output.success),
      outputs.map((output) => new TextDecoder().decode(output.stderr)).join(
        "\n",
      ),
    );
    const text = outputs.map((output) =>
      new TextDecoder().decode(output.stdout).trim()
    ).sort();
    assert(
      canonical(text) === canonical(["admitted", "stale"]),
      canonical(text),
    );
    assert((await repo.history()).commits.length === 2);
    assert(
      (await repo.at(initial.version)).sourceDigest === initial.sourceDigest,
    );
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("Git structural diff retains deleted semantic fields", async () => {
  const projectDir = await Deno.makeTempDir();
  const compiler = {
    compile: (sources: Sources) =>
      materialize(
        [{
          "@id": "stable-package",
          "@type": "Package",
          ...(sources["model.sysml"].includes("Named")
            ? { declaredName: "Named" }
            : {}),
        }],
        sources,
        "fixture-engine",
      ),
    recipe: () => {
      throw new Error("Fixture compiler reports no build recipe");
    },
  };
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    const before = await repo.initialize({ "model.sysml": "package Named;" });
    const after = await repo.publishSystemSources(
      { "model.sysml": "package;" },
      before.version,
      "operator",
    );
    const diff = await repo.graphDiff(before.version, after.version);
    assert(diff.engine === "Git");
    const change = diff.changes.find((change) =>
      change.nativeId === "stable-package"
    );
    const field = change?.fields.find((field) => field.field === "name");
    assert(
      change?.kind === "changed" && field?.before === "Named" &&
        !("after" in field),
      canonical(diff),
    );
    const initial = await repo.graphDiff(null, before.version);
    assert(initial.counts.added === 1);
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

async function lifecycle(
  dir: string,
  update: (record: Record<string, unknown>) => void,
) {
  const path = `${dir}/.assembly/runtime/repository.json`;
  const record = JSON.parse(await Deno.readTextFile(path));
  update(record.value);
  record.digest = await sha256(canonical(record.value));
  await Deno.writeTextFile(path, JSON.stringify(record));
}
async function localGit(dir: string, args: string[]) {
  const result = await new Deno.Command("git", {
    args: [`--git-dir=${dir}/.git`, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(result.success, new TextDecoder().decode(result.stderr));
}
Deno.test("ready Git repositories fail closed when admitted ref or Git directory disappears", async () => {
  for (const damage of ["ref", "directory", "head", "legacy-ref"]) {
    const projectDir = await Deno.makeTempDir();
    try {
      const repo = await GitModelRepository.open({ projectDir, compiler });
      await repo.initialize(source("Initial"));
      await Deno.mkdir(`${projectDir}/sources`);
      await Deno.writeTextFile(
        `${projectDir}/sources/draft.sysml`,
        "dirty invalid draft",
      );
      if (damage === "legacy-ref") {
        await lifecycle(projectDir, (record) => {
          delete record.status;
        });
      }
      if (damage === "ref" || damage === "legacy-ref") {
        await localGit(projectDir, ["update-ref", "-d", "refs/heads/admitted"]);
      } else {await Deno.remove(
          `${projectDir}/.git${damage === "head" ? "/HEAD" : ""}`,
          { recursive: true },
        );}
      await fails(
        () => GitModelRepository.open({ projectDir, compiler }),
        "repository",
      );
      await fails(() => repo.initialize(source("DirtyReplacement")), "Git");
      assert(
        await Deno.readTextFile(`${projectDir}/sources/draft.sysml`) ===
          "dirty invalid draft",
      );
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  }
});
Deno.test("initial publication recovery uses exact immutable pin before and after admitted CAS", async () => {
  for (const beforeCas of [true, false]) {
    const projectDir = await Deno.makeTempDir();
    try {
      const repo = await GitModelRepository.open({ projectDir, compiler });
      const initial = await repo.initialize(source("Initial"));
      await lifecycle(projectDir, (record) => {
        record.status = "creating";
      });
      if (beforeCas) {
        await localGit(projectDir, ["update-ref", "-d", "refs/heads/admitted"]);
      }
      const reopened = await GitModelRepository.open({
        projectDir,
        compiler: {
          compile: () => {
            throw new Error("Must not compile dirty sources during recovery");
          },
          recipe: () => {
            throw new Error("Fixture compiler reports no build recipe");
          },
        },
      });
      assert((await reopened.current()).version === initial.version);
      assert(
        (await reopened.initialize(source("DirtyReplacement"))).version ===
          initial.version,
      );
      const receipt = JSON.parse(
        await Deno.readTextFile(
          `${projectDir}/.assembly/runtime/repository.json`,
        ),
      );
      assert(receipt.value.status === "ready");
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  }
});
Deno.test("Git process launch errors never masquerade as an uninitialized model", async () => {
  const projectDir = await Deno.makeTempDir();
  const previousPath = Deno.env.get("PATH");
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    await repo.initialize(source("Initial"));
    Deno.env.set("PATH", `${projectDir}/no-executables`);
    await fails(() => repo.current(), "executable");
    await fails(
      () => GitModelRepository.open({ projectDir, compiler }),
      "executable",
    );
  } finally {
    if (previousPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", previousPath);
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("explicit exports reject extras and symlinks while immutable reads remain usable", async () => {
  for (const damage of ["extra", "symlink"]) {
    const projectDir = await Deno.makeTempDir();
    try {
      const repo = await GitModelRepository.open({ projectDir, compiler });
      const initial = await repo.initialize(source("Initial"));
      const destination = await repo.exportSources(initial.version);
      if (damage === "extra") {
        await Deno.writeTextFile(
          `${destination}/extra.sysml`,
          "package Unadmitted;",
        );
      } else {
        await Deno.remove(`${destination}/nested/model.sysml`);
        await Deno.writeTextFile(
          `${projectDir}/outside.sysml`,
          initial.sources["nested/model.sysml"],
        );
        await Deno.symlink(
          `${projectDir}/outside.sysml`,
          `${destination}/nested/model.sysml`,
        );
      }
      await fails(
        () => repo.exportSources(initial.version),
        damage === "extra" ? "export differs" : "Symlink",
      );
      assert((await repo.current()).version === initial.version);
      assert((await repo.history()).commits.length === 1);
      const after = await repo.publishSystemSources(
        source("Later"),
        initial.version,
        "operator",
      );
      assert(after.version !== initial.version);
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  }
});
Deno.test("Git and private state directories cannot redirect through symlinks", async () => {
  for (const path of [".git", ".assembly", ".ase"]) {
    const projectDir = await Deno.makeTempDir();
    const outside = await Deno.makeTempDir();
    try {
      await Deno.symlink(outside, `${projectDir}/${path}`);
      await fails(
        () => GitModelRepository.open({ projectDir, compiler }),
        "Unsafe repository directory",
      );
      const entries = [];
      for await (const entry of Deno.readDir(outside)) entries.push(entry);
      assert(entries.length === 0);
    } finally {
      await Deno.remove(projectDir, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  }
});

Deno.test("multiline proposal and rejection reasons preserve text without spoofing history authors", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    const initial = await repo.initialize(source("Initial"));
    const reason =
      "First explanation\nASE-Author: forged-author\nSecond explanation";
    const proposal = await repo.propose({
      baseVersion: initial.version,
      sources: source("Proposed"),
      author: "original-author",
      reason,
    });
    assert(proposal.reason === reason);
    await repo.accept({
      id: proposal.id,
      expectedVersion: initial.version,
      author: "actual-reviewer",
    });
    const history = await repo.history();
    assert(history.commits[0].author === "actual-reviewer", canonical(history));
    assert((await repo.proposal(proposal.id)).reason === reason);
    const next = await repo.propose({
      baseVersion: history.headVersion,
      sources: source("Rejected"),
      author: "original-author",
      reason,
    });
    const rejectionReason =
      "Reject first line\r\nASE-Author: another-forgery\nReject last line";
    const rejected = await repo.reject({
      id: next.id,
      author: "actual-reviewer",
      reason: rejectionReason,
    });
    assert(rejected.rejectionReason === rejectionReason);
    const reopened = await GitModelRepository.open({ projectDir, compiler });
    assert(
      (await reopened.proposal(next.id)).rejectionReason === rejectionReason,
    );
    await fails(
      () =>
        repo.propose({
          baseVersion: history.headVersion,
          sources: source("BadActor"),
          author: "first\nsecond",
          reason,
        }),
      "author",
    );
    await fails(
      () =>
        repo.propose({
          baseVersion: history.headVersion,
          sources: source("BadReason"),
          author: "operator",
          reason: "bad\0reason",
        }),
      "reason",
    );
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("approved publication records the canonical trailer and index atomically and never commits twice", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    const initial = await repo.initialize(source("Initial"));
    const changeId = crypto.randomUUID();
    const receipt = {
      changeId,
      authorityExercise: exerciseOwnerAuthority({
        identity: { systemId: "system" },
        version: { digest: "base" },
      }, "mandate-change"),
      baseModelDigest: "base",
      baseRevision: 0,
      adoptedPin: { digest: "base", repositoryVersion: initial.version },
      decidedAt: "2026-10-24T00:00:00Z",
      edits: [],
    };
    const author = `ase:approved-change:${changeId}`;
    const published = await repo.updateSystemSources(
      () => source("Approved"),
      author,
      { publication: receipt },
    );
    const ref = `refs/ase/approved-changes/${changeId}`;
    assert(
      (await fixtureGit(projectDir, ["rev-parse", ref])).trim() ===
        published.version.slice(7),
    );
    const body = await fixtureGit(projectDir, [
      "show",
      "-s",
      "--format=%B",
      ref,
    ]);
    assert(
      body.includes(
        `ASE-Approval: ${canonical(receipt)}\nASE-Author: ${author}`,
      ),
    );
    assert((await repo.history()).commits[0].author === author);
    const found = await repo.findPublication(changeId);
    assert(found?.revision.version === published.version);
    assert(canonical(found.receipt) === canonical(receipt));
    const retried = await repo.updateSystemSources(
      () => {
        throw new Error("Must not prepare twice");
      },
      author,
      { publication: receipt },
    );
    assert(retried.version === published.version);
    assert((await repo.history()).commits.length === 2);
    await fails(
      () =>
        repo.updateSystemSources(() => source("Other"), author, {
          publication: { ...receipt, decidedAt: "different" },
        }),
      "receipt differs",
    );
    await fails(
      () => repo.findPublication("../invalid"),
      "Invalid approved change ID",
    );

    const secondId = crypto.randomUUID();
    const second = { ...receipt, changeId: secondId };
    // Race in the index creation after the repository's initial lookup:
    // create must fail AND leave the admitted branch at its previous value.
    await rejects(() =>
      repo.updateSystemSources(
        async () => {
          await fixtureGit(projectDir, [
            "update-ref",
            `refs/ase/approved-changes/${secondId}`,
            initial.version.slice(7),
          ]);
          return source("MustNotPublish");
        },
        `ase:approved-change:${secondId}`,
        { publication: second },
      ), (error: unknown) => {
      assert(error instanceof ChangePublicationError);
      equal(error.code, "PUBLICATION_FAILED");
      equal(error.recovery, "retry");
      equal(error.context.changeId, secondId);
      return true;
    });
    assert((await repo.current()).version === published.version);
    await fails(() => repo.findPublication(secondId), "another author");
    const noOpId = crypto.randomUUID();
    await rejects(
      () =>
        repo.updateSystemSources(
          (current) => current.sources,
          `ase:approved-change:${noOpId}`,
          { publication: { ...receipt, changeId: noOpId } },
        ),
      (error: unknown) => {
        assert(error instanceof ChangePublicationError);
        equal(error.code, "PUBLICATION_NOT_APPLICABLE");
        equal(error.recovery, "refuse");
        equal(error.context.changeId, noOpId);
        return true;
      },
    );
    assert(await repo.findPublication(noOpId) === null);
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("B3: missing publication index falls back to unbounded first-parent lookup beyond 200 commits", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    const initial = await repo.initialize(source("Initial"));
    const changeId = crypto.randomUUID();
    const receipt = {
      changeId,
      authorityExercise: exerciseOwnerAuthority({
        identity: { systemId: "system" },
        version: { digest: "base" },
      }, "mandate-change"),
      baseModelDigest: "base",
      baseRevision: 0,
      adoptedPin: { digest: "base", repositoryVersion: initial.version },
      decidedAt: "2026-10-24T00:00:00Z",
      edits: [],
    };
    const publication = await repo.updateSystemSources(
      () => source("Approved"),
      `ase:approved-change:${changeId}`,
      { publication: receipt },
    );
    await fixtureGit(projectDir, [
      "update-ref",
      "-d",
      `refs/ase/approved-changes/${changeId}`,
    ]);
    assert(
      (await repo.findPublication(changeId))?.revision.version ===
        publication.version,
    );
    const tree = (await fixtureGit(projectDir, [
      "rev-parse",
      `${publication.version.slice(7)}^{tree}`,
    ])).trim();
    // Build real descendants in one fixture-only process. With no file edits,
    // each commit inherits the published tree; production lookup stays unchanged.
    const historyRef = "refs/heads/fixture-long-history";
    const encoder = new TextEncoder();
    const history = (async function* () {
      for (let i = 0; i < 205; i++) {
        const message = `Later ${i}\n\nASE-Author: other\n`;
        yield encoder.encode(
          `commit ${historyRef}\nmark :${i + 1}\n` +
            "author Test <test@local.invalid> 1730000000 +0000\n" +
            "committer Test <test@local.invalid> 1730000000 +0000\n" +
            `data ${encoder.encode(message).byteLength}\n${message}` +
            `from ${i === 0 ? publication.version.slice(7) : `:${i}`}\n\n`,
        );
      }
      yield encoder.encode("done\n");
    })();
    await fixtureGit(
      projectDir,
      ["fast-import", "--quiet", "--done"],
      history,
    );
    const parent = await fixtureGit(projectDir, ["rev-parse", historyRef]);
    const descendants = (await fixtureGit(projectDir, [
      "log",
      "--first-parent",
      "--format=%H%x00%P%x00%T%x00%B%x1e",
      `${publication.version.slice(7)}..${parent}`,
    ])).split("\x1e").map((record) => record.trim()).filter(Boolean).map((
      record,
    ) => record.split("\0"));
    equal(descendants.length, 205);
    equal(descendants[0][0], parent);
    for (
      const [index, [oid, parents, commitTree, message]] of descendants
        .entries()
    ) {
      assert(/^[0-9a-f]{40}$/.test(oid));
      equal(
        parents,
        descendants[index + 1]?.[0] ?? publication.version.slice(7),
      );
      equal(commitTree, tree);
      equal(message, `Later ${204 - index}\n\nASE-Author: other`);
    }
    await fixtureGit(projectDir, ["update-ref", "refs/heads/admitted", parent]);
    await fixtureGit(projectDir, ["update-ref", "-d", historyRef]);
    const found = await repo.findPublication(changeId);
    assert(found?.revision.version === publication.version);
    assert(canonical(found.receipt) === canonical(receipt));
    assert(await repo.findPublication(crypto.randomUUID()) === null);
    // Missing index still cannot cause a second publication.
    const retried = await repo.updateSystemSources(
      () => {
        throw new Error("Must not replay");
      },
      `ase:approved-change:${changeId}`,
      { publication: receipt },
    );
    assert(retried.version === publication.version);
    assert((await repo.current()).version === `commit:${parent}`);
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("historical approved commits are discoverable without fabricating an approval trailer", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    const initial = await repo.initialize(source("Initial"));
    const changeId = crypto.randomUUID();
    const historical = await repo.publishSystemSources(
      source("Historical"),
      initial.version,
      `ase:approved-change:${changeId}`,
    );
    const found = await repo.findPublication(changeId);
    assert(found?.revision.version === historical.version);
    assert(found.receipt === undefined);
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("publication verify and preparation failures create no commit or reference and expose recovery", async () => {
  const projectDir = await Deno.makeTempDir();
  let compileFailure: Error | undefined;
  try {
    const repo = await GitModelRepository.open({
      projectDir,
      compiler: {
        compile(sources) {
          if (compileFailure) return Promise.reject(compileFailure);
          return compiler.compile(sources);
        },
        recipe: () => compiler.recipe(),
      },
    });
    const initial = await repo.initialize(source("Initial"));
    const objects = () =>
      fixtureGit(projectDir, [
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname) %(objecttype)",
      ]);
    const refs = () =>
      fixtureGit(projectDir, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
      ]);
    const beforeObjects = await objects();
    const beforeRefs = await refs();
    for (const phase of ["prepare", "compile", "verify", "io"] as const) {
      const changeId = crypto.randomUUID();
      const receipt = {
        changeId,
        authorityExercise: exerciseOwnerAuthority({
          identity: { systemId: "system" },
          version: { digest: "base" },
        }, "mandate-change"),
        baseModelDigest: "base",
        baseRevision: 0,
        adoptedPin: { digest: "base", repositoryVersion: initial.version },
        decidedAt: "now",
        edits: [],
      };
      const rejection = new ChangePublicationError(
        "PUBLICATION_NOT_APPLICABLE",
        {
          changeId,
          systemId: "system",
        },
        "Compiled candidate refused",
      );
      compileFailure = phase === "compile"
        ? new Error("Invalid syntax")
        : phase === "io"
        ? new Deno.errors.PermissionDenied("Compiler input unavailable")
        : undefined;
      let verified = false;
      await rejects(() =>
        repo.updateSystemSources(
          () => {
            if (phase === "prepare") throw new Error("Preparation guard");
            return source("Candidate");
          },
          `ase:approved-change:${changeId}`,
          {
            publication: receipt,
            verify(compiled) {
              verified = true;
              deepStrictEqual(compiled.sources, source("Candidate"));
              equal(compiled.version, initial.version);
              assert(compiled.sourceDigest !== initial.sourceDigest);
              throw rejection;
            },
          },
        ), (error: unknown) => {
        assert(error instanceof ChangePublicationError);
        equal(
          error.code,
          phase === "io" ? "PUBLICATION_FAILED" : "PUBLICATION_NOT_APPLICABLE",
        );
        equal(error.recovery, phase === "io" ? "retry" : "refuse");
        equal(error.context.changeId, changeId);
        if (phase === "verify") equal(error, rejection);
        return true;
      });
      equal(verified, phase === "verify");
      equal(await objects(), beforeObjects); // Includes unreachable commits.
      equal(await refs(), beforeRefs);
      equal(await repo.findPublication(changeId), null);
      equal((await repo.current()).version, initial.version);
    }
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("approval receipts preserve both formats and operation order through publication recovery", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const options = { projectDir, compiler };
    let repo = await GitModelRepository.open(options);
    await repo.initialize(source("Initial"));
    const formats:
      import("../../src/domain/model/publication/change.ts").ChangePublication[
        "edits"
      ][] = [
        [{ owner: "system", name: "z", value: "first" }, {
          owner: "system",
          name: "a",
          value: true,
        }],
        ["z", "a"].map((name, index) => ({
          op: "setFeatureValue",
          target: {
            id: name,
            qualifiedName: `System::${name}`,
            metaclass: "AttributeUsage",
            preimage: "a".repeat(64),
          },
          value: index,
        })),
      ];
    for (const [index, edits] of formats.entries()) {
      const base = await repo.current();
      const receipt = {
        changeId: crypto.randomUUID(),
        authorityExercise: exerciseOwnerAuthority({
          identity: { systemId: "system" },
          version: { digest: "base" },
        }, "mandate-change"),
        baseModelDigest: "base",
        baseRevision: index,
        adoptedPin: { digest: "base", repositoryVersion: base.version },
        decidedAt: "now",
        edits,
      };
      const author = `ase:approved-change:${receipt.changeId}`;
      let calls = 0;
      const publish = async () =>
        await repo.updateSystemSources(
          () => {
            calls++;
            return source(`Format${index}`);
          },
          author,
          { publication: receipt },
        );
      const revision = await publish();
      equal(calls, 1);
      repo = await GitModelRepository.open(options);
      deepStrictEqual(
        (await repo.findPublication(receipt.changeId))!.receipt,
        receipt,
      );
      const retry = { ...receipt, edits: [] };
      equal(
        (await repo.updateSystemSources(
          () => {
            throw new Error("Recovery called updater");
          },
          author,
          { publication: retry },
        )).version,
        revision.version,
      );
      deepStrictEqual(retry.edits, edits);
      equal((await publish()).version, revision.version);
      equal(calls, 1);
    }
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("oversized approval trailer refuses before any Git object or ref is written", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    const initial = await repo.initialize(source("Initial"));
    const objects = () =>
      fixtureGit(projectDir, [
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname) %(objecttype)",
      ]);
    const before = await objects();
    const receipt = {
      changeId: crypto.randomUUID(),
      authorityExercise: exerciseOwnerAuthority({
        identity: { systemId: "system" },
        version: { digest: "base" },
      }, "mandate-change"),
      baseModelDigest: "base",
      baseRevision: 0,
      adoptedPin: { digest: "base", repositoryVersion: initial.version },
      decidedAt: "now",
      edits: [{ owner: "system", name: "huge", value: "台".repeat(65_536) }],
    };
    await rejects(
      () =>
        repo.updateSystemSources(
          () => source("Oversized"),
          `ase:approved-change:${receipt.changeId}`,
          { publication: receipt },
        ),
      (error: unknown) => {
        assert(error instanceof ChangePublicationError);
        equal(error.code, "PUBLICATION_RECEIPT_TOO_LARGE");
        equal(error.recovery, "refuse");
        return true;
      },
    );
    equal(await objects(), before);
    equal((await repo.current()).version, initial.version);
    equal(await repo.findPublication(receipt.changeId), null);
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("Git headers match every fixture revision and history never requests artifact contents", async () => {
  const projectDir = await Deno.makeTempDir();
  const Command = Deno.Command;
  try {
    let repo = await GitModelRepository.open({ projectDir, compiler });
    const initial = await repo.initialize(source("Initial"));
    const reader = await GitModelRepository.open({ projectDir, compiler });
    const proposal = await repo.propose({
      baseVersion: initial.version,
      sources: source("Proposed"),
      author: "operator",
      reason: "header fixture",
    });
    const accepted = await repo.accept({
      id: proposal.id,
      expectedVersion: initial.version,
      author: "reviewer",
    });
    await repo.publishSystemSources(
      source("Later"),
      accepted.version,
      "system",
    );
    const versions = (await fixtureGit(projectDir, ["rev-list", "--all"]))
      .split("\n").map((oid) => `commit:${oid}`);
    equal(versions.length, 4);
    const artifactOids: string[] = [];
    for (const version of versions) {
      const revision = await repo.at(version);
      const header = await repo.header(version);
      deepStrictEqual(header, {
        version,
        sources: revision.sources,
        sourceDigest: revision.sourceDigest,
      });
      equal(await modelSourceDigest(header.sources), revision.sourceDigest);
      artifactOids.push(
        await fixtureGit(projectDir, [
          "rev-parse",
          `${version.slice(7)}:.ase-build.json`,
        ]),
      );
    }
    repo = reader;
    const requests: string[] = [];
    Deno.Command = class extends Command {
      #batch: boolean;
      constructor(command: string | URL, options?: Deno.CommandOptions) {
        super(command, options);
        this.#batch = String(command) === "git" &&
          (options?.args ?? []).includes("cat-file");
      }
      override spawn(): Deno.ChildProcess {
        const child = super.spawn();
        if (this.#batch) {
          const getWriter = child.stdin.getWriter.bind(child.stdin);
          child.stdin.getWriter = () => {
            const writer = getWriter();
            const write = writer.write.bind(writer);
            writer.write = (chunk) => {
              requests.push(new TextDecoder().decode(chunk));
              return write(chunk);
            };
            return writer;
          };
        }
        return child;
      }
    };
    const history = await repo.history({ limit: 4 });
    equal(history.commits.length, 3);
    assert(requests.some((request) => request.includes("contents ")));
    for (const oid of artifactOids) {
      assert(
        !requests.some((request) => request.includes(oid)),
        `History requested artifact ${oid}`,
      );
    }
  } finally {
    Deno.Command = Command;
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("artifact corruption leaves headers and history readable but at and recovery reject it", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    const initial = await repo.initialize(source("Initial"));
    const proposal = await repo.propose({
      baseVersion: initial.version,
      sources: source("Proposed"),
      author: "operator",
      reason: "recovery integrity",
    });
    await repo.listProposals();
    await repo.listProposals();
    const version = proposal.proposalVersion!;
    const header = await repo.header(version);
    const history = await repo.history();
    const oid = await fixtureGit(projectDir, [
      "rev-parse",
      `${version.slice(7)}:.ase-build.json`,
    ]);
    const stored = JSON.parse(
      await fixtureGit(projectDir, ["cat-file", "blob", oid]),
    );
    stored.compiled.sourceDigest = "0".repeat(64);
    const bytes = new TextEncoder().encode(JSON.stringify(stored));
    const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const object = new Uint8Array(prefix.length + bytes.length);
    object.set(prefix);
    object.set(bytes, prefix.length);
    const path = `${repo.gitDir}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
    await Deno.chmod(path, 0o644);
    await Deno.writeFile(path, deflateSync(object));
    deepStrictEqual(await repo.header(version), header);
    deepStrictEqual(await repo.history(), history);
    await rejects(() => repo.at(version), /Changed model snapshot/);
    await rejects(() => repo.listProposals(), /Changed model snapshot/);
    await rejects(
      () => GitModelRepository.open({ projectDir, compiler }),
      /Changed model snapshot/,
    );
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("header and at share one read path: missing version, damaged snapshot, abort", async () => {
  const projectDir = await Deno.makeTempDir();
  const Command = Deno.Command;
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    const initial = await repo.initialize(source("Initial"));
    const later = await repo.publishSystemSources(
      source("Later"),
      initial.version,
      "system",
    );
    const missing = `commit:${"f".repeat(40)}`;
    const refusal = async (read: () => Promise<unknown>) => {
      try {
        await read();
      } catch (error) {
        assert(error instanceof ModelRepositoryError, String(error));
        return { code: error.code, message: error.message };
      }
      throw new Error("Expected a repository refusal");
    };
    const unknown = {
      code: "NOT_FOUND",
      message: "Model version not found",
    };
    deepStrictEqual(await refusal(() => repo.at(missing)), unknown);
    deepStrictEqual(await refusal(() => repo.header(missing)), unknown);

    // Damage of a known commit is INVALID_REPOSITORY, never NOT_FOUND and never
    // a raw error, for the source-only read as for at(). A model error raised
    // by the tree checks keeps its own message; any other failure is wrapped.
    const oid = initial.version.slice(7);
    const git = (args: string[], input?: string) =>
      fixtureGit(projectDir, args, input);
    const snapshot = await git(["rev-parse", `${oid}:.ase-build.json`]);
    const nul = await git(["hash-object", "-w", "--stdin"], "package A;\0");
    const sources = await git(
      ["mktree"],
      `100644 blob ${nul}\tnested.sysml\n`,
    );
    const tree = await git(
      ["mktree"],
      `100644 blob ${snapshot}\t.ase-build.json\n040000 tree ${sources}\tsources\n`,
    );
    const forged = `commit:${await git(
      ["commit-tree", tree, "-p", oid],
      "NUL byte in a source\n",
    )}`;
    const extra = await git(["mktree"], `100644 blob ${nul}\tmodel.sysml\n`);
    const foreign = await git(
      ["mktree"],
      `100644 blob ${snapshot}\t.ase-build.json\n040000 tree ${extra}\tsources\n100644 blob ${nul}\tstray.bin\n`,
    );
    const stray = `commit:${await git(
      ["commit-tree", foreign, "-p", oid],
      "Unexpected root path\n",
    )}`;
    const expectations = [
      [forged, repo.at, "Git source tree differs from compiled snapshot"],
      [
        forged,
        repo.header,
        "Invalid Git model snapshot: Invalid SysML source text: nested.sysml",
      ],
      [stray, repo.at, "Unexpected Git snapshot path or mode"],
      [stray, repo.header, "Unexpected Git snapshot path or mode"],
    ] as const;
    for (const [damaged, read, message] of expectations) {
      deepStrictEqual(await refusal(() => read.call(repo, damaged)), {
        code: "INVALID_REPOSITORY",
        message,
      });
    }
    equal((await repo.header(later.version)).sourceDigest, later.sourceDigest);

    // An aborted read reports the abort, even for a version that does not exist.
    const reason = new Error("caller gave up");
    for (const version of [later.version, missing]) {
      for (const read of [repo.at, repo.header]) {
        await rejects(
          () => read.call(repo, version, AbortSignal.abort(reason)),
          (error) => error === reason,
        );
      }
    }

    // The signal reaches every Git subprocess of both reads, including the
    // rev-parse that tells a missing version from a damaged one.
    const seen: Array<{ args: string[]; signal?: AbortSignal }> = [];
    Deno.Command = class extends Command {
      constructor(command: string | URL, options?: Deno.CommandOptions) {
        super(command, options);
        if (String(command) === "git") {
          seen.push({ args: options?.args ?? [], signal: options?.signal });
        }
      }
    };
    const controller = new AbortController();
    for (
      const read of [
        () => repo.at(later.version, controller.signal),
        () => repo.header(later.version, controller.signal),
        () => repo.at(missing, controller.signal).catch(() => undefined),
        () => repo.header(missing, controller.signal).catch(() => undefined),
        () => repo.header(initial.version, controller.signal).catch(() => 0),
      ]
    ) {
      seen.length = 0;
      await read();
      assert(seen.length > 0, "No Git subprocess observed");
      for (const command of seen) {
        assert(
          command.signal === controller.signal,
          `git ${command.args.join(" ")} ignored the caller's signal`,
        );
      }
    }
    Deno.Command = Command;
  } finally {
    Deno.Command = Command;
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("recovery retains semantic validation even when the malformed artifact has a valid Git hash", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const repo = await GitModelRepository.open({ projectDir, compiler });
    const initial = await repo.initialize(source("Initial"));
    const proposal = await repo.propose({
      baseVersion: initial.version,
      sources: source("Proposed"),
      author: "operator",
      reason: "semantic recovery integrity",
    });
    const original = proposal.proposalVersion!.slice(7);
    const stored = JSON.parse(
      await fixtureGit(projectDir, ["show", `${original}:.ase-build.json`]),
    );
    stored.compiled.sourceDigest = "0".repeat(64);
    stored.digest = await sha256(canonical(stored.compiled));
    const artifact = await fixtureGit(projectDir, [
      "hash-object",
      "-w",
      "--stdin",
    ], JSON.stringify(stored));
    const sources = await fixtureGit(projectDir, [
      "rev-parse",
      `${original}:sources`,
    ]);
    const tree = await fixtureGit(
      projectDir,
      ["mktree"],
      `100644 blob ${artifact}\t.ase-build.json\n040000 tree ${sources}\tsources\n`,
    );
    const oid = await fixtureGit(projectDir, [
      "commit-tree",
      tree,
      "-p",
      initial.version.slice(7),
    ], "Malformed compiled digest\n");
    const version = `commit:${oid}`;
    await fixtureGit(projectDir, [
      "update-ref",
      `refs/heads/${proposal.branch}`,
      oid,
    ]);
    await journal(projectDir, proposal.id, (record) => {
      record.proposalVersion = version;
      record.status = "preparing";
    });
    equal((await repo.header(version)).sourceDigest, proposal.sourceDigest);
    await rejects(
      () => repo.at(version),
      /Stored compiler artifact or IR digest mismatch/,
    );
    await rejects(
      () => repo.listProposals(),
      /Stored compiler artifact or IR digest mismatch/,
    );
    await rejects(
      () => GitModelRepository.open({ projectDir, compiler }),
      /Stored compiler artifact or IR digest mismatch/,
    );
    equal((await repo.current()).version, initial.version);
    equal((await repo.proposal(proposal.id)).status, "preparing");
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});
