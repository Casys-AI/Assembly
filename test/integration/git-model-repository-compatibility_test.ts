import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import {
  materialize,
  sha256,
} from "../../src/domain/model/value-objects/artifact.ts";
import { ModelRepositoryError } from "../../src/application/model/repository.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import type { CompiledModel } from "../../src/domain/model/records/compiled-model.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import { validateModelSources } from "../../src/domain/model/value-objects/sources.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

async function fixtureGit(
  projectDir: string,
  args: string[],
  input?: string,
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
    const encoder = new TextEncoder();
    try {
      // The large compatibility fixture is ASCII JSON. Avoid another complete
      // 96 MiB byte allocation just to feed its serialized snapshot to Git.
      for (let offset = 0; offset < input.length; offset += 1_048_576) {
        await writer.write(
          encoder.encode(input.slice(offset, offset + 1_048_576)),
        );
      }
    } finally {
      await writer.close();
    }
  };
  const [output] = await Promise.all([child.output(), write()]);
  assert(output.success, new TextDecoder().decode(output.stderr));
  return new TextDecoder().decode(output.stdout).trim();
}

async function commitSnapshot(
  repo: GitModelRepository,
  files: Array<[string, string]>,
  snapshot: string,
): Promise<string> {
  const git = (args: string[], input?: string) =>
    fixtureGit(repo.directory, args, input);
  const snapshotOid = await git(["hash-object", "-w", "--stdin"], snapshot);
  const sourceTree = await git(
    ["mktree"],
    files.map(([path, oid]) => `100644 blob ${oid}\t${path}\n`).join(""),
  );
  const tree = await git(
    ["mktree"],
    `100644 blob ${snapshotOid}\t.ase-build.json\n040000 tree ${sourceTree}\tsources\n`,
  );
  const oid = await git(["commit-tree", tree], "Historical fixture\n");
  return `commit:${oid}`;
}

async function encodeSnapshot(
  repo: GitModelRepository,
  compiled: CompiledModel,
): Promise<string> {
  const digest = await sha256(canonical(compiled));
  return JSON.stringify({
    repositoryId: repo.projectId.slice(4),
    compiled,
    digest,
  });
}

async function rejectsCorruption(read: () => Promise<unknown>) {
  try {
    await read();
  } catch (error) {
    assert(error instanceof ModelRepositoryError, String(error));
    assert(error.code === "INVALID_REPOSITORY", error.code);
    return;
  }
  throw new Error("Corrupted repository was accepted");
}

Deno.test("Git reads historical snapshots exceeding 96 MiB without recompiling", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const repo = await GitModelRepository.open({
      projectDir,
      compiler: {
        compile: () => {
          throw new Error("Historical reads must never compile sources");
        },
        recipe: () => {
          throw new Error("Fixture compiler reports no build recipe");
        },
      },
    });
    const content = "\u0001".repeat(1_048_576);
    const sources: Sources = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`model${index}.sysml`, content]),
    );
    validateModelSources(sources);
    const prepareHistoricalRevision = async () => {
      const compiled = await materialize([], sources, "fixture-engine");
      const snapshot = await encodeSnapshot(repo, compiled);
      // Each source occurs in sources and SourceSnapshotV0.content; every U+0001
      // occupies six JSON bytes. Historical publication accepted this artifact.
      assert(snapshot.length > 96 * 1_048_576);
      const blob = await fixtureGit(
        projectDir,
        ["hash-object", "-w", "--stdin"],
        content,
      );
      return await commitSnapshot(
        repo,
        Object.keys(sources).map((path) => [path, blob]),
        snapshot,
      );
    };
    const version = await prepareHistoricalRevision();
    await fixtureGit(projectDir, [
      "update-ref",
      "refs/heads/admitted",
      version.slice(7),
    ]);
    for (const read of [() => repo.at(version), () => repo.current()]) {
      const revision = await read();
      assert(revision.version === version);
      assert(Object.keys(revision.sources).length === 8);
      for (const [path, expected] of Object.entries(sources)) {
        assert(revision.sources[path] === expected, `Changed source: ${path}`);
      }
      const snapshots = revision.documents.filter((document) =>
        document["@type"] === "SourceSnapshotV0"
      );
      assert(snapshots.length === 8);
      assert(snapshots.every((document) => document.content === content));
    }
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

for (
  const corruption of ["unexpected extension", "65 files", "case collision"]
) {
  Deno.test(`Git reports INVALID_REPOSITORY for ${corruption} in a source tree`, async () => {
    const projectDir = await Deno.makeTempDir();
    try {
      const repo = await GitModelRepository.open({
        projectDir,
        compiler: {
          compile: (sources) => materialize([], sources, "fixture-engine"),
          recipe: () => {
            throw new Error("Fixture compiler reports no build recipe");
          },
        },
      });
      const initial = await repo.initialize({
        "model.sysml": "package Initial;",
      });
      const snapshot = await fixtureGit(projectDir, [
        "show",
        `${initial.version.slice(7)}:.ase-build.json`,
      ]);
      const blob = await fixtureGit(projectDir, [
        "rev-parse",
        `${initial.version.slice(7)}:sources/model.sysml`,
      ]);
      const paths = corruption === "unexpected extension"
        ? ["model.sysml", "extra.txt"]
        : corruption === "65 files"
        ? Array.from({ length: 65 }, (_, index) => `model${index}.sysml`)
        : ["model.sysml", "Model.sysml"];
      const version = await commitSnapshot(
        repo,
        paths.map((path) => [path, blob]),
        snapshot,
      );
      await rejectsCorruption(() => repo.at(version));
      await fixtureGit(projectDir, [
        "update-ref",
        "refs/heads/admitted",
        version.slice(7),
      ]);
      await rejectsCorruption(() => repo.current());
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  });
}

for (const corruption of ["malformed JSON", "invalid stored sources"]) {
  Deno.test(`Git reports INVALID_REPOSITORY for ${corruption} in a snapshot`, async () => {
    const projectDir = await Deno.makeTempDir();
    try {
      const repo = await GitModelRepository.open({
        projectDir,
        compiler: {
          compile: (sources) => materialize([], sources, "fixture-engine"),
          recipe: () => {
            throw new Error("Fixture compiler reports no build recipe");
          },
        },
      });
      const initial = await repo.initialize({
        "model.sysml": "package Initial;",
      });
      const compiled = await materialize([], initial.sources, "fixture-engine");
      compiled.sources = { "extra.txt": "package Initial;" };
      const snapshot = corruption === "malformed JSON"
        ? "{"
        : await encodeSnapshot(repo, compiled);
      const blob = await fixtureGit(projectDir, [
        "rev-parse",
        `${initial.version.slice(7)}:sources/model.sysml`,
      ]);
      const version = await commitSnapshot(
        repo,
        [["model.sysml", blob]],
        snapshot,
      );
      await rejectsCorruption(() => repo.at(version));
      await fixtureGit(projectDir, [
        "update-ref",
        "refs/heads/admitted",
        version.slice(7),
      ]);
      await rejectsCorruption(() => repo.current());
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  });
}

Deno.test("Git bounds batch output by declared snapshot size and reaps its child", async () => {
  const projectDir = await Deno.makeTempDir();
  const Command = Deno.Command;
  try {
    const repo = await GitModelRepository.open({
      projectDir,
      compiler: {
        compile: (sources) => materialize([], sources, "fixture-engine"),
        recipe: () => {
          throw new Error("Fixture compiler reports no build recipe");
        },
      },
    });
    const initial = await repo.initialize({
      "model.sysml": "package Initial;",
    });
    let changedSizes = 0;
    Deno.Command = class extends Command {
      #tree: boolean;
      constructor(command: string | URL, options?: Deno.CommandOptions) {
        super(command, options);
        this.#tree = String(command) === "git" &&
          (options?.args ?? []).includes("ls-tree");
      }
      override spawn(): Deno.ChildProcess {
        const child = super.spawn();
        if (this.#tree) {
          // Intercept the actual bounded metadata stream used by the reader.
          // Patching child.output() would no longer exercise this production path.
          const stdout = child.stdout;
          Object.defineProperty(child, "stdout", {
            value: new ReadableStream<Uint8Array>({
              async start(controller) {
                try {
                  const bytes = await new Response(stdout).arrayBuffer();
                  const rows = new TextDecoder().decode(bytes).split("\0");
                  controller.enqueue(new TextEncoder().encode(
                    rows.map((row) => {
                      if (!row.endsWith("\t.ase-build.json")) return row;
                      changedSizes++;
                      return row.replace(/ +\d+\t/, " 1\t");
                    }).join("\0"),
                  ));
                  controller.close();
                } catch (error) {
                  controller.error(error);
                }
              },
            }),
          });
        }
        return child;
      }
    };
    let refused = false;
    try {
      await repo.at(initial.version);
    } catch (error) {
      assert(error instanceof ModelRepositoryError, String(error));
      assert(error.code === "INVALID_REPOSITORY", error.code);
      assert(
        error.message === "Git batch output exceeds declared object sizes",
        error.message,
      );
      refused = true;
    }
    assert(refused, "Git output exceeded its declared size without rejection");
    assert(changedSizes === 1);
    Deno.Command = Command;
    assert((await repo.at(initial.version)).version === initial.version);
    // The default Deno resource/op sanitizers also require the failed read to
    // close its pipes and reap the real cat-file child before this test returns.
  } finally {
    Deno.Command = Command;
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("Git preserves INVALID_REQUEST for a malformed revision identifier", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    const repo = await GitModelRepository.open({
      projectDir,
      compiler: {
        compile: (sources) => materialize([], sources, "fixture-engine"),
        recipe: () => {
          throw new Error("Fixture compiler reports no build recipe");
        },
      },
    });
    try {
      await repo.at("commit:not-a-commit");
    } catch (error) {
      assert(error instanceof ModelRepositoryError, String(error));
      assert(error.code === "INVALID_REQUEST", error.code);
      return;
    }
    throw new Error("Malformed revision identifier was accepted");
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});
