import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { materialize } from "../../src/domain/model/value-objects/artifact.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";

Deno.test("Git source history follows admitted parents, excludes pending proposals, and reads without compiling", async () => {
  const projectDir = await Deno.makeTempDir({ prefix: "ase-history-" });
  let compiles = 0;
  try {
    const repository = await GitModelRepository.open({
      projectDir,
      compiler: {
        compile(sources: Sources) {
          compiles++;
          return materialize([], sources, "history-fixture");
        },
        recipe: () => {
          throw new Error("Fixture compiler reports no build recipe");
        },
      },
    });
    const initial = await repository.initialize({
      "model.sysml": "package Initial;",
    });
    const pending = await repository.propose({
      baseVersion: initial.version,
      sources: { "model.sysml": "package Proposal;" },
      author: "operator",
      reason: "Pending",
    });
    const current = await repository.publishSystemSources(
      { "model.sysml": "package Current;" },
      initial.version,
      "local-control",
    );
    const before = compiles;
    const history = await repository.history();
    equal(compiles, before);
    equal(history.headVersion, current.version);
    equal(history.truncated, false);
    deepStrictEqual(history.commits.map((entry) => entry.version), [
      current.version,
      initial.version,
    ]);
    deepStrictEqual(history.commits[0]!.parents, [initial.version]);
    equal(history.commits[0]!.author, "local-control");
    equal(history.commits[0]!.sourceDigest, current.sourceDigest);
    ok(
      !history.commits.some((entry) =>
        entry.version === pending.proposalVersion
      ),
    );
    const bounded = await repository.history({ limit: 1 });
    equal(bounded.truncated, true);
    equal(bounded.commits.length, 1);
    equal(bounded.commits[0]!.parentVersion, initial.version);
    for (const limit of [0, -1, 201, 1.5, NaN]) {
      await rejects(() => repository.history({ limit }), /history limit/i);
    }
    equal(compiles, before);
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("Git metadata covers initial add, modify, delete, rename and admitted merge first parent", async () => {
  const projectDir = await Deno.makeTempDir({ prefix: "ase-file-history-" });
  try {
    const repository = await GitModelRepository.open({
      projectDir,
      compiler: {
        compile: (sources) => materialize([], sources, "file-history"),
        recipe: () => {
          throw new Error("Fixture compiler reports no build recipe");
        },
      },
    });
    const original = "package Example {\n  part a;\n  part b;\n  part c;\n}\n";
    const initial = await repository.initialize({
      "a.sysml": original,
      "deleted.sysml": "package Deleted;\n",
    });
    const first = (await repository.history()).commits[0];
    deepStrictEqual(first.parents, []);
    equal(first.parentVersion, undefined);
    deepStrictEqual(await repository.changedFiles(initial.version), [
      { path: "a.sysml", status: "added", additions: 5, deletions: 0 },
      { path: "deleted.sysml", status: "added", additions: 1, deletions: 0 },
    ]);
    const modified = await repository.publishSystemSources(
      {
        "a.sysml": original.replace("part a;", "part changed;"),
        "new.sysml": "package New;\n",
      },
      initial.version,
      "agent:builder",
    );
    deepStrictEqual(await repository.changedFiles(modified.version), [
      { path: "a.sysml", status: "modified", additions: 1, deletions: 1 },
      { path: "deleted.sysml", status: "deleted", additions: 0, deletions: 1 },
      { path: "new.sysml", status: "added", additions: 1, deletions: 0 },
    ]);
    const renamed = await repository.publishSystemSources(
      {
        "folder/renamed.sysml": modified.sources["a.sysml"],
        "new.sysml": "package New;\n",
      },
      modified.version,
      "local-control",
    );
    deepStrictEqual(await repository.changedFiles(renamed.version), [{
      path: "folder/renamed.sysml",
      previousPath: "a.sysml",
      status: "renamed",
      additions: 0,
      deletions: 0,
    }]);
    const history = await repository.history();
    equal(history.commits[1].additions, 2);
    equal(history.commits[1].deletions, 2);
    deepStrictEqual(history.commits[1].parsedAuthor, {
      kind: "agent",
      ref: "builder",
    });
    deepStrictEqual(await repository.lastChangeByPath(renamed.version), [
      {
        path: "folder/renamed.sysml",
        lastChange: {
          version: renamed.version,
          createdAt: history.commits[0].createdAt,
          message: history.commits[0].message,
        },
      },
      {
        path: "new.sysml",
        lastChange: {
          version: modified.version,
          createdAt: history.commits[1].createdAt,
          message: history.commits[1].message,
        },
      },
    ]);
    const proposal = await repository.propose({
      baseVersion: renamed.version,
      sources: { ...renamed.sources, "new.sysml": "package Accepted;\n" },
      author: "local-owner",
      reason: "Update new\nbecause the review asked\n\nSecond paragraph",
    });
    const accepted = await repository.accept({
      id: proposal.id,
      expectedVersion: renamed.version,
      author: "local-control",
    });
    const admitted = await repository.history();
    deepStrictEqual(admitted.commits[0].parents, [
      renamed.version,
      proposal.proposalVersion,
    ]);
    deepStrictEqual(admitted.commits.map((commit) => commit.version), [
      accepted.version,
      renamed.version,
      modified.version,
      initial.version,
    ]);
    deepStrictEqual(await repository.changedFiles(accepted.version), [{
      path: "new.sysml",
      status: "modified",
      additions: 1,
      deletions: 1,
    }]);
    equal(
      (await repository.lastChangeByPath(accepted.version))[1].lastChange
        .version,
      accepted.version,
    );
    equal(
      (await repository.lastChangeByPath(accepted.version))[1].lastChange
        .message,
      admitted.commits[0].message,
      "multi-line reasons have one commit message in history and file metadata",
    );
    for (const commit of admitted.commits) {
      equal(
        commit.sourceDigest,
        (await repository.at(commit.version)).sourceDigest,
      );
    }
    const reopened = await GitModelRepository.open({
      projectDir,
      compiler: {
        compile() {
          throw new Error("Historical reads must not compile");
        },
        recipe: () => {
          throw new Error("Fixture compiler reports no build recipe");
        },
      },
    });
    reopened.at = () => {
      throw new Error("History must not read compiled snapshots");
    };
    reopened.current = () => {
      throw new Error("History must not read the current snapshot");
    };
    deepStrictEqual(
      await reopened.history(),
      admitted,
      "cold metadata preserves exact legacy facts and source digests",
    );
    await rejects(() => reopened.changedFiles(`commit:${"0".repeat(40)}`), {
      code: "NOT_FOUND",
    });
    await rejects(() => reopened.lastChangeByPath(`commit:${"0".repeat(40)}`), {
      code: "NOT_FOUND",
    });
    for (const version of ["branch:main", "commit:bad"]) {
      await rejects(() => repository.changedFiles(version), {
        code: "INVALID_REQUEST",
      });
      await rejects(() => repository.lastChangeByPath(version), {
        code: "INVALID_REQUEST",
      });
    }
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("Git metadata memo shares a single diff execution and history never reads compiled snapshots", async () => {
  const projectDir = await Deno.makeTempDir({ prefix: "ase-history-memo-" });
  const Command = Deno.Command;
  try {
    const repository = await GitModelRepository.open({
      projectDir,
      compiler: {
        compile: (sources) => materialize([], sources, "memo"),
        recipe: () => {
          throw new Error("Fixture compiler reports no build recipe");
        },
      },
    });
    const initial = await repository.initialize({ "a.sysml": "package A;\n" });
    let gitCalls = 0;
    // Instrument the process boundary, including calls routed through #git.
    Deno.Command = class extends Command {
      constructor(command: string | URL, options?: Deno.CommandOptions) {
        super(command, options);
        if (command === "git") gitCalls++;
      }
    };
    const [first, second] = await Promise.all([
      repository.changedFiles(initial.version),
      repository.changedFiles(initial.version),
    ]);
    deepStrictEqual(first, second);
    equal(gitCalls, 1);
    first[0].path = "mutated";
    equal((await repository.changedFiles(initial.version))[0].path, "a.sysml");
    equal(gitCalls, 1);
    repository.at = () => {
      throw new Error("Compiled snapshot must not be read");
    };
    repository.current = () => {
      throw new Error("Current snapshot must not be read");
    };
    const history = await repository.history();
    const before = gitCalls;
    deepStrictEqual(await repository.history(), history);
    equal(
      gitCalls - before,
      2,
      "only admitted ref and first-parent listing are mutable",
    );
    const files = await repository.lastChangeByPath(initial.version);
    const fileCalls = gitCalls;
    deepStrictEqual(await repository.lastChangeByPath(initial.version), files);
    equal(gitCalls, fileCalls);
  } finally {
    Deno.Command = Command;
    await Deno.remove(projectDir, { recursive: true });
  }
});

async function git(
  repository: GitModelRepository,
  args: string[],
  input?: string,
) {
  const command = new Deno.Command("git", {
    args: [`--git-dir=${repository.gitDir}`, ...args],
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).spawn();
  if (input !== undefined) {
    const writer = command.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const output = await command.output();
  ok(output.success, new TextDecoder().decode(output.stderr));
  return new TextDecoder().decode(output.stdout).trim();
}

Deno.test("history is advisory when a build snapshot is altered or absent; at and current reject it", async () => {
  const projectDir = await Deno.makeTempDir({
    prefix: "ase-advisory-history-",
  });
  try {
    const repository = await GitModelRepository.open({
      projectDir,
      compiler: {
        compile: (sources) => materialize([], sources, "advisory"),
        recipe: () => {
          throw new Error("Fixture compiler reports no build recipe");
        },
      },
    });
    const initial = await repository.initialize({ "a.sysml": "package A;\n" });
    const oid = initial.version.slice(7);
    const sources = await git(repository, ["rev-parse", `${oid}:sources`]);
    const altered = await git(
      repository,
      ["hash-object", "-w", "--stdin"],
      "invalid snapshot",
    );
    for (const snapshot of ["", `100644 blob ${altered}\t.ase-build.json\n`]) {
      const tree = await git(
        repository,
        ["mktree"],
        snapshot + `040000 tree ${sources}\tsources\n`,
      );
      const forged = await git(repository, [
        "commit-tree",
        tree,
        "-p",
        oid,
        "-m",
        "Altered build snapshot",
      ]);
      await git(repository, ["update-ref", "refs/heads/admitted", forged]);
      const history = await repository.history();
      equal(history.commits[0].version, `commit:${forged}`);
      equal(history.commits[0].sourceDigest, initial.sourceDigest);
      await rejects(() => repository.at(`commit:${forged}`), {
        code: "INVALID_REPOSITORY",
      });
      await rejects(() => repository.current(), { code: "INVALID_REPOSITORY" });
    }
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("file metadata HTTP treats tree, blob, empty tree and absent objects as missing commits", async () => {
  const { createModelRevisionHandler } = await import(
    "../../src/adapters/in/http/model/revisions.ts"
  );
  const projectDir = await Deno.makeTempDir({ prefix: "ase-files-http-" });
  try {
    const repository = await GitModelRepository.open({
      projectDir,
      compiler: {
        compile: (sources) => materialize([], sources, "files-http"),
        recipe: () => {
          throw new Error("Fixture compiler reports no build recipe");
        },
      },
    });
    const initial = await repository.initialize({ "a.sysml": "package A;\n" });
    const oid = initial.version.slice(7);
    const handler = createModelRevisionHandler({
      repository,
      runtime: {
        snapshot: { busy: false },
        inspectModelVersion() {
          throw new Error("File reads do not inspect execution");
        },
        adoptModelVersion() {
          throw new Error("File reads do not adopt execution");
        },
      },
      onChange: async () => {},
    });
    const objects = [
      await git(repository, ["rev-parse", `${oid}^{tree}`]),
      await git(repository, ["rev-parse", `${oid}:sources/a.sysml`]),
      await git(repository, ["mktree"], ""),
      "0".repeat(40),
    ];
    for (const object of objects) {
      const response = await handler(
        new Request(
          `http://localhost/api/model-files?version=commit:${object}`,
        ),
      );
      equal(response!.status, 404);
      const body = await response!.json();
      equal(body.code, "NOT_FOUND");
      equal(body.context.message, "Model commit not found");
      equal(response!.headers.get("cache-control"), "no-store");
    }
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});
