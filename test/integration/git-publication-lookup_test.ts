import { MAX_APPROVAL_RECEIPT_BYTES } from "../../src/domain/model/publication/change.ts";
import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { resolveRepositoryLayout } from "../../src/adapters/out/filesystem/layout.ts";
import { materialize } from "../../src/adapters/model/builds/materialization/artifact.ts";
import {
  ModelBuildService,
  ModelBuildServiceError,
} from "../../src/application/model/builds/service.ts";
import {
  BuildStoreError,
  type ModelBuildStore,
} from "../../src/application/model/builds/ports/out/build-store.port.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";

async function writeObject(directory: string, kind: string, body: string) {
  const bytes = new TextEncoder().encode(
    `${kind} ${new TextEncoder().encode(body).length}\0${body}`,
  );
  const oid = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  await Deno.mkdir(`${directory}/.git/objects/${oid.slice(0, 2)}`, {
    recursive: true,
  });
  await Deno.writeFile(
    `${directory}/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`,
    deflateSync(bytes),
  );
  return oid;
}

// Build immutable Git objects directly in a temporary fixture: no Git write command.
Deno.test("publication grep skips a quoted author in a newer ordinary commit", async () => {
  const directory = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${directory}/.git/objects`, { recursive: true });
    await Deno.mkdir(`${directory}/.git/refs/heads`, { recursive: true });
    await Deno.writeTextFile(
      `${directory}/.git/HEAD`,
      "ref: refs/heads/admitted\n",
    );
    const object = (kind: string, body: string) =>
      writeObject(directory, kind, body);
    const tree = await object("tree", "");
    const commit = (message: string, parent?: string) =>
      object(
        "commit",
        `tree ${tree}\n${
          parent ? `parent ${parent}\n` : ""
        }author Test <test@local> 1 +0000\ncommitter Test <test@local> 1 +0000\n\n${message}\n`,
      );
    const id = crypto.randomUUID();
    const published = await commit(
      `Published\n\nASE-Author: ase:approved-change:${id}`,
    );
    const quoted = await commit(
      `Ordinary revision\n\nASE-Author: ase:approved-change:${id}\n\nQuoted for explanation only.\n\nASE-Author: local-owner`,
      published,
    );
    await Deno.writeTextFile(
      `${directory}/.git/refs/heads/admitted`,
      `${quoted}\n`,
    );
    const compiled = await materialize(
      [],
      { "model.sysml": "package Test;" },
      "fixture",
    );
    // Isolate the production lookup, retaining real Git traversal and message reads.
    const repo = Reflect.construct(GitModelRepository, [{
      projectDir: directory,
      compiler: { compile: () => Promise.resolve(compiled) },
    }, await resolveRepositoryLayout(directory)]) as GitModelRepository;
    repo.current = () =>
      Promise.resolve({ ...compiled, version: `commit:${quoted}` });
    const reads: string[] = [];
    repo.at = (version) => {
      reads.push(version);
      return Promise.resolve({ ...compiled, version });
    };
    equal(
      (await repo.findPublication(id))?.revision.version,
      `commit:${published}`,
    );
    deepStrictEqual(reads, [`commit:${published}`]);
    equal(await repo.findPublication(crypto.randomUUID()), null);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("publication lookup rejects oversized UTF-8 trailers before JSON parsing", async () => {
  const directory = await Deno.makeTempDir();
  const originalParse = JSON.parse;
  let watched = "", parsed = 0;
  JSON.parse = ((
    text: string,
    reviver?: (this: unknown, key: string, value: unknown) => unknown,
  ) => {
    if (text === watched) parsed++;
    return originalParse(text, reviver);
  }) as typeof JSON.parse;
  try {
    await Deno.mkdir(`${directory}/.git/objects`, { recursive: true });
    await Deno.mkdir(`${directory}/.git/refs/heads`, { recursive: true });
    await Deno.writeTextFile(
      `${directory}/.git/HEAD`,
      "ref: refs/heads/admitted\n",
    );
    const tree = await writeObject(directory, "tree", "");
    const compiled = await materialize(
      [],
      { "model.sysml": "package Test;" },
      "fixture",
    );
    const repo = Reflect.construct(GitModelRepository, [{
      projectDir: directory,
      compiler: { compile: () => Promise.resolve(compiled) },
    }, await resolveRepositoryLayout(directory)]) as GitModelRepository;
    let version = "";
    let revisionReads = 0;
    repo.current = () => Promise.resolve({ ...compiled, version });
    repo.at = () => {
      revisionReads++;
      throw new Error("Oversized receipt must fail before revision read");
    };
    for (
      const payload of [
        "[".repeat(MAX_APPROVAL_RECEIPT_BYTES),
        JSON.stringify("台".repeat(MAX_APPROVAL_RECEIPT_BYTES / 2)),
      ]
    ) {
      const changeId = crypto.randomUUID();
      const message =
        `Published\n\nASE-Approval: ${payload}\nASE-Author: ase:approved-change:${changeId}\n`;
      const oid = await writeObject(
        directory,
        "commit",
        `tree ${tree}\nauthor Test <test@local> 1 +0000\ncommitter Test <test@local> 1 +0000\n\n${message}`,
      );
      await Deno.writeTextFile(
        `${directory}/.git/refs/heads/admitted`,
        `${oid}\n`,
      );
      version = `commit:${oid}`;
      watched = payload;
      await rejects(() => repo.findPublication(changeId), {
        code: "INVALID_REPOSITORY",
        message: "Invalid approval receipt",
      });
      equal(parsed, 0);
      equal(revisionReads, 0);
    }
  } finally {
    JSON.parse = originalParse;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("strict publication lookup bypasses public at and never rebuilds missing descriptor bytes", async () => {
  const directory = await Deno.makeTempDir();
  const repositoryId = crypto.randomUUID();
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
  const compiler = {
    async compile(sources: Sources) {
      compileCount++;
      return await materialize([], sources, recipe.engineVersion);
    },
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
    acquireLease: () => Promise.resolve(true),
    releaseLease: () => Promise.resolve(),
    has: (digest: string) => Promise.resolve(blobs.has(digest)),
    hasProjection: () => Promise.resolve(false),
    getProjection: () => Promise.reject(new Error("Unused projection read")),
    putProjection: () => Promise.reject(new Error("Unused projection write")),
    sweep: () =>
      Promise.resolve({
        orphanChunkKeysRemoved: 0,
        orphanEntries: 0,
        expiredLeasesRemoved: 0,
      }),
    stats: () =>
      Promise.resolve({
        blobCount: blobs.size,
        projectionCount: 0,
        leaseCount: 0,
        uncompressedBytes: 0,
        quotaBytes: null,
        overQuota: false,
      }),
    close: () => Promise.resolve(),
  } satisfies ModelBuildStore;
  const buildService = new ModelBuildService({
    repositoryId,
    store,
    compiler,
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
    const repo = await GitModelRepository.open({
      projectDir: directory,
      repositoryId,
      compiler,
      buildService,
    });
    const initial = await repo.initialize({
      "model.sysml": "package Initial;",
    });
    const id = crypto.randomUUID();
    const published = await repo.publishSystemSources(
      { "model.sysml": "package Published;" },
      initial.version,
      `ase:approved-change:${id}`,
    );
    equal(compileCount, 2);
    const directAt = repo.at.bind(repo);
    let publicReads = 0;
    repo.at = (version, signal) => {
      publicReads++;
      return directAt(version, signal);
    };
    equal(
      (await repo.findPublication(id))?.revision.version,
      published.version,
    );
    equal(publicReads, 1);
    const descriptor = await repo.descriptorAt(published.version);
    if (!descriptor) throw new Error("Expected a descriptor publication");
    blobs.delete(descriptor.artifactDigest);
    buildService.clearMemory();
    await rejects(
      () => repo.findPublication(id, false),
      (error: unknown) =>
        error instanceof ModelBuildServiceError &&
        error.code === "BUILD_UNAVAILABLE",
    );
    equal(
      publicReads,
      1,
      "strict lookup must not delegate to a possibly rebuilding public override",
    );
    equal(compileCount, 2, "strict lookup cannot invoke the compiler");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
