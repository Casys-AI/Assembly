import assert from "node:assert/strict";
import {
  corpus,
  snapshotFixture,
  traceGit,
} from "../support/git-snapshot-benchmark.ts";
import { gitBlobIdentity } from "../../src/adapters/out/git/blob-identity.ts";
import { modelSourceDigest } from "../../src/domain/model/value-objects/sources.ts";

async function git(directory: string, args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args: [`--git-dir=${directory}/.git`, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(result.success, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

Deno.test("Git snapshots reuse only unchanged exact-parent paths and preserve deleted/added UTF8 sources", async () => {
  const f = await snapshotFixture();
  try {
    const sources = corpus(64);
    const initialTrace = traceGit();
    let initial;
    try {
      initial = await f.repository.initialize(sources);
      assert.equal(
        initialTrace.commands.filter((row) => row.args.includes("hash-object"))
          .length,
        65,
      );
    } finally {
      initialTrace.stop();
    }
    const next = { ...sources };
    delete next["nested/group2/model62.sysml"];
    delete next["nested/group3/model63.sysml"];
    next["nested/group0/model0.sysml"] =
      "// café e\u0301 臺灣 🚀\r\npackage Changed;\n";
    next["added/deep/copy.sysml"] = sources["nested/group1/model1.sysml"]!;
    next["added/deep/empty.sysml"] = "";
    const input = await f.prepare(initial, next);
    const trace = traceGit();
    let published;
    try {
      published = await f.repository.publishPrepared(input);
      // One changed path, two added paths (even when bytes already exist), descriptor.
      assert.equal(
        trace.commands.filter((row) => row.args.includes("hash-object")).length,
        4,
      );
    } finally {
      trace.stop();
    }
    assert.deepEqual(published.sources, next);
    assert.equal(published.sourceDigest, await modelSourceDigest(next));
    assert.deepEqual((await f.repository.at(initial.version)).sources, sources);
    assert.deepEqual((await f.repository.at(published.version)).sources, next);
    const firstBlob = await git(f.directory, [
      "rev-parse",
      `${initial.version.slice(7)}:sources/nested/group1/model1.sysml`,
    ]);
    const copyBlob = await git(f.directory, [
      "rev-parse",
      `${published.version.slice(7)}:sources/added/deep/copy.sysml`,
    ]);
    assert.equal(copyBlob, firstBlob);
    assert.equal(
      copyBlob,
      await gitBlobIdentity(next["added/deep/copy.sysml"]!),
    );
    const emptyBlob = await git(f.directory, [
      "rev-parse",
      `${published.version.slice(7)}:sources/added/deep/empty.sysml`,
    ]);
    assert.equal(emptyBlob, await gitBlobIdentity(""));
    assert.equal(
      (await f.repository.descriptorAt(published.version))?.artifactDigest,
      input.descriptor.artifactDigest,
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("Git snapshots retain direct writes when every existing source changes", async () => {
  const f = await snapshotFixture();
  try {
    const initial = await f.repository.initialize(corpus(64));
    const sources = corpus(64, 1);
    const input = await f.prepare(initial, sources);
    const trace = traceGit();
    try {
      const next = await f.repository.publishPrepared(input);
      assert.equal(
        trace.commands.filter((row) => row.args.includes("hash-object")).length,
        65,
      );
      assert.deepEqual(next.sources, sources);
    } finally {
      trace.stop();
    }
  } finally {
    await f.cleanup();
  }
});

Deno.test("Git snapshot object-write failure leaves all refs unchanged and retry is idempotent", async () => {
  const f = await snapshotFixture();
  const Command = Deno.Command;
  try {
    const initial = await f.repository.initialize(corpus(16));
    const input = await f.prepare(initial, corpus(16, 1, 1));
    const refs = await git(f.directory, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ]);
    Deno.Command = class extends Command {
      constructor(command: string | URL, options?: Deno.CommandOptions) {
        if (
          String(command) === "git" && options?.args?.includes("hash-object")
        ) throw new Error("injected object-write interruption");
        super(command, options);
      }
    };
    await assert.rejects(() => f.repository.publishPrepared(input));
    Deno.Command = Command;
    assert.equal(
      await git(f.directory, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
      ]),
      refs,
    );
    assert.equal((await f.repository.current()).version, initial.version);
    const published = await f.repository.publishPrepared(input);
    const trace = traceGit();
    try {
      assert.equal(
        (await f.repository.publishPrepared(input)).version,
        published.version,
      );
      assert.equal(
        trace.commands.filter((row) => row.args.includes("hash-object")).length,
        0,
      );
    } finally {
      trace.stop();
    }
  } finally {
    Deno.Command = Command;
    await f.cleanup();
  }
});

Deno.test("Git snapshot lost response after atomic ref transaction recovers the same effect", async () => {
  const f = await snapshotFixture();
  const Command = Deno.Command;
  try {
    const initial = await f.repository.initialize(corpus(16));
    const input = await f.prepare(initial, corpus(16, 1, 1));
    let interrupted = false;
    Deno.Command = class extends Command {
      #transaction: boolean;
      constructor(command: string | URL, options?: Deno.CommandOptions) {
        super(command, options);
        this.#transaction = String(command) === "git" &&
          !!options?.args?.includes("update-ref");
      }
      override spawn() {
        const child = super.spawn();
        if (this.#transaction && !interrupted) {
          const output = child.output.bind(child);
          child.output = async () => {
            const result = await output();
            if (result.success) {
              interrupted = true;
              throw new Error("injected lost committed response");
            }
            return result;
          };
        }
        return child;
      }
    };
    await assert.rejects(() => f.repository.publishPrepared(input));
    Deno.Command = Command;
    assert(interrupted);
    const committed = await f.repository.current();
    assert.notEqual(committed.version, initial.version);
    assert.deepEqual(committed.sources, input.sources);
    const trace = traceGit();
    try {
      assert.equal(
        (await f.repository.publishPrepared(input)).version,
        committed.version,
      );
      assert.equal(
        trace.commands.filter((row) => row.args.includes("hash-object")).length,
        0,
      );
    } finally {
      trace.stop();
    }
  } finally {
    Deno.Command = Command;
    await f.cleanup();
  }
});

Deno.test("Git snapshot reuse follows a proposal's immutable old base after HEAD advances", async () => {
  const f = await snapshotFixture();
  try {
    const original = corpus(16);
    const initial = await f.repository.initialize(original);
    const advanced = await f.repository.publishPrepared(
      await f.prepare(initial, corpus(16, 1, 1)),
    );
    const proposedSources = {
      ...original,
      "nested/group1/model1.sysml": "package Independent;\n",
    };
    const trace = traceGit();
    let proposal;
    try {
      proposal = await f.repository.propose({
        baseVersion: initial.version,
        sources: proposedSources,
        author: "local-review",
        reason: "Exact old-base proposal",
      });
      // Wrong HEAD reuse would write model0 again, despite it matching the exact base.
      assert.equal(
        trace.commands.filter((row) => row.args.includes("hash-object")).length,
        2,
      );
    } finally {
      trace.stop();
    }
    assert(proposal.proposalVersion);
    assert.equal(
      await git(f.directory, [
        "show",
        "-s",
        "--format=%P",
        proposal.proposalVersion.slice(7),
      ]),
      initial.version.slice(7),
    );
    assert.deepEqual(
      (await f.repository.at(proposal.proposalVersion)).sources,
      proposedSources,
    );
    assert.equal((await f.repository.current()).version, advanced.version);
  } finally {
    await f.cleanup();
  }
});
