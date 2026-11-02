import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { GitReleaseTags } from "../../src/adapters/out/git/release-tags.ts";
import { repositoryWriterLock } from "../../src/adapters/out/git/writer-lock.ts";
import { materialize } from "../../src/adapters/model/builds/materialization/artifact.ts";
import type { SavedSystemSourceEvidence } from "../../src/domain/work/saved-systems.ts";

Deno.test("release tags bind exact Git objects, recover without overwrite, and report drift", async () => {
  const dir = await Deno.makeTempDir({ prefix: "release-tags-" });
  try {
    const repository = await GitModelRepository.open({
      projectDir: dir,
      repositoryId: "11111111-1111-1111-1111-111111111111",
      compiler: {
        compile: (sources) => materialize([], sources, "fixture"),
        recipe() {
          throw new Error("No fixture recipe");
        },
      },
    });
    const first = await repository.initialize({
      "main.sysml": "package First;\n",
    });
    const second = await repository.publishSystemSources(
      { "main.sysml": "package Second;\n" },
      first.version,
      "local-control",
    );
    const source: SavedSystemSourceEvidence = {
      branch: { kind: "main" },
      repositoryId: repository.repositoryId,
      branchRef: "refs/heads/admitted",
      sourceVersion: first.version,
      admittedHeadVersion: second.version,
      sourceDigest: first.sourceDigest,
    };
    const git = async (...args: string[]) => {
      const out = await new Deno.Command("git", {
        args: [`--git-dir=${repository.gitDir}`, ...args],
        clearEnv: true,
        env: {
          PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.invalid",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.invalid",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
      return new TextDecoder().decode(out.stdout).trim();
    };
    await git(
      "tag",
      "-a",
      "annotated",
      first.version.slice(7),
      "-m",
      "private annotation",
    );
    await git("tag", "other", second.version.slice(7));
    const blobPath = `${dir}/fixture-blob`;
    await Deno.writeTextFile(blobPath, "not a commit");
    const blob = await git("hash-object", "-w", blobPath);
    const tree = await git("rev-parse", `${first.version.slice(7)}^{tree}`);
    await git("update-ref", "refs/tags/blob", blob);
    await git("update-ref", "refs/tags/tree", tree);
    await git("tag", "-a", "annotated-blob", blob, "-m", "blob tag");
    await git("tag", "-a", "nested", "annotated", "-m", "nested commit tag");
    await git(
      "tag",
      "-a",
      "nested-blob",
      "annotated-blob",
      "-m",
      "nested blob tag",
    );
    const unrelated = new Deno.Command("git", {
      args: [`--git-dir=${repository.gitDir}`, "update-ref", "--stdin"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const unrelatedWriter = unrelated.stdin.getWriter();
    await unrelatedWriter.write(new TextEncoder().encode(
      Array.from(
        { length: 200 },
        (_, i) =>
          `create refs/tags/unrelated/${i} ${second.version.slice(7)}\n`,
      ).join(""),
    ));
    await unrelatedWriter.close();
    equal((await unrelated.output()).success, true);
    const notifications: string[] = [];
    let notifiedTag = "release/v1";
    let failNotification = false;
    const tags = new GitReleaseTags({
      projectDir: dir,
      repositoryId: repository.repositoryId,
      reader: () =>
        GitModelRepository.openReadOnly({
          projectDir: dir,
          repositoryId: repository.repositoryId,
        }),
      writerLock: await repositoryWriterLock(repository.stateDir),
      notifyCatalogue() {
        // The callback observes durable bytes, never a pending write intention.
        notifications.push(
          Deno.readTextFileSync(`${repository.gitDir}/refs/tags/${notifiedTag}`)
            .trim(),
        );
        if (failNotification) throw new Error("stream unavailable");
      },
    });
    const existing = await tags.prepare(
      { mode: "existing", name: "annotated" },
      source,
    );
    equal(existing.commitOid, first.version.slice(7));
    equal(existing.refOid === existing.commitOid, false);
    const nested = await tags.prepare(
      { mode: "existing", name: "nested" },
      source,
    );
    equal(nested.commitOid, first.version.slice(7));
    deepStrictEqual(await tags.list(source), [existing, nested]);
    await rejects(() =>
      tags.prepare({ mode: "existing", name: "other" }, source)
    );
    await rejects(() =>
      tags.prepare({ mode: "create", name: "annotated" }, source)
    );
    await rejects(() =>
      tags.prepare({ mode: "create", name: "../bad" }, source)
    );
    await rejects(() =>
      tags.prepare({ mode: "create", name: "foreign" }, {
        ...source,
        repositoryId: "foreign",
      })
    );
    const selection = { mode: "create" as const, name: "release/v1" };
    const binding = await tags.prepare(selection, source);
    await rejects(() => tags.ensure(selection, binding), /lock/);
    const cancelled = new AbortController();
    cancelled.abort();
    await rejects(() =>
      tags.runExclusive(() => tags.ensure(selection, binding, cancelled.signal))
    );
    deepStrictEqual(notifications, []); // Refused/missing-lock and aborted writes.
    await git("show-ref", "--verify", "refs/heads/admitted");
    equal(await tags.inspect(binding), "unavailable");
    await tags.runExclusive(() => tags.ensure(selection, binding));
    deepStrictEqual(notifications, [first.version.slice(7)]);
    await tags.runExclusive(() => tags.ensure(selection, binding));
    equal(notifications.length, 1); // The exact same ref is a read-only no-op.
    equal(await tags.inspect(binding), "verified");
    equal((await repository.current()).version, second.version);
    notifiedTag = "release/notify-failure";
    failNotification = true;
    const failureSelection = { mode: "create" as const, name: notifiedTag };
    const failureBinding = await tags.prepare(failureSelection, source);
    await tags.runExclusive(() =>
      tags.ensure(failureSelection, failureBinding)
    );
    equal(await tags.inspect(failureBinding), "verified");
    deepStrictEqual(notifications, [
      first.version.slice(7),
      first.version.slice(7),
    ]);
    failNotification = false;
    await git(
      "update-ref",
      "refs/tags/release/v1",
      second.version.slice(7),
      first.version.slice(7),
    );
    equal(await tags.inspect(binding), "unavailable");
    await rejects(() =>
      tags.runExclusive(() => tags.ensure(selection, binding))
    );
    await git(
      "update-ref",
      "refs/tags/annotated",
      first.version.slice(7),
      existing.refOid,
    );
    equal(await tags.inspect(existing), "unavailable"); // Same commit, different raw tag object.
    await git("update-ref", "-d", "refs/tags/annotated");
    equal(await tags.inspect(existing), "unavailable");
    await rejects(() =>
      tags.runExclusive(() =>
        tags.ensure({ mode: "existing", name: "annotated" }, existing)
      )
    );
    await git("symbolic-ref", "refs/tags/trap", "refs/heads/admitted");
    const trap = {
      name: "trap",
      refOid: first.version.slice(7),
      commitOid: first.version.slice(7),
    };
    await rejects(() => tags.prepare({ mode: "create", name: "trap" }, source));
    await rejects(() =>
      tags.prepare({ mode: "existing", name: "trap" }, source)
    );
    equal(await tags.inspect(trap), "unavailable");
    await rejects(() =>
      tags.runExclusive(() =>
        tags.ensure({ mode: "create", name: "trap" }, trap)
      )
    );
    await rejects(() => tags.list(source));
    equal(notifications.length, 2); // Drift, missing existing tags and symbolic traps never write.
    equal((await repository.current()).version, second.version);
    await git("symbolic-ref", "--delete", "refs/tags/trap");
    const bulk = new Deno.Command("git", {
      args: [`--git-dir=${repository.gitDir}`, "update-ref", "--stdin"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = bulk.stdin.getWriter();
    await writer.write(
      new TextEncoder().encode(
        Array.from(
          { length: 1001 },
          (_, i) => `create refs/tags/bulk/${i} ${first.version.slice(7)}\n`,
        ).join(""),
      ),
    );
    await writer.close();
    equal((await bulk.output()).success, true);
    await rejects(() => tags.list(source));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
