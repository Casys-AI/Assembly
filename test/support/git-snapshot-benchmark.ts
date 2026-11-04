import { createColdBuildStore } from "./cold-build-store.ts";
/** Disposable, deterministic publication fixture and test-local observations.
 * No provider/native compilation, production state, or production telemetry API.
 */
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import { materialize } from "../../src/domain/model/value-objects/artifact.ts";
import { ModelBuildService } from "../../src/application/model/builds/service.ts";
import { BuildStoreError } from "../../src/application/model/builds/ports/out/build-store.port.ts";
import {
  changePublication,
  preparePublication,
} from "../../src/domain/model/publication/change.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import type { PendingChange } from "../../src/domain/governance/records/pending-change.ts";

export interface GitTrace {
  commands: Array<{ args: string[]; start: number; end?: number }>;
  locks: Array<{ requested: number; acquired: number; released?: number }>;
  stop(): void;
}

/** All subprocesses are real. Patch only observation surfaces, restored in finally. */
export function traceGit(): GitTrace {
  const Command = Deno.Command;
  const lock = Deno.FsFile.prototype.lock;
  const unlock = Deno.FsFile.prototype.unlock;
  const active = new WeakMap<Deno.FsFile, GitTrace["locks"][number]>();
  const trace: GitTrace = {
    commands: [],
    locks: [],
    stop() {
      Deno.Command = Command;
      Deno.FsFile.prototype.lock = lock;
      Deno.FsFile.prototype.unlock = unlock;
    },
  };
  Deno.Command = class extends Command {
    #args: string[] | undefined;
    constructor(command: string | URL, options?: Deno.CommandOptions) {
      super(command, options);
      if (String(command) === "git") this.#args = [...options?.args ?? []];
    }
    override spawn() {
      const record = this.#args
        ? {
          args: this.#args,
          start: performance.now(),
          end: undefined as number | undefined,
        }
        : undefined;
      if (record) trace.commands.push(record);
      const child = super.spawn();
      if (record) {
        child.status.then(() => {
          record.end = performance.now();
        }, () => {
          record.end = performance.now();
        });
      }
      return child;
    }
  };
  Deno.FsFile.prototype.lock = async function (exclusive?: boolean) {
    const requested = performance.now();
    await lock.call(this, exclusive);
    const row = {
      requested,
      acquired: performance.now(),
      released: undefined as number | undefined,
    };
    trace.locks.push(row);
    active.set(this, row);
  };
  Deno.FsFile.prototype.unlock = async function () {
    try {
      return await unlock.call(this);
    } finally {
      const row = active.get(this);
      if (row) row.released = performance.now();
      active.delete(this);
    }
  };
  return trace;
}

export const benchmarkRecipe = {
  toolkit: { version: "fixture", bundleDigest: "b".repeat(64) },
  format: "fixture-json-v1",
  normalizerVersion: 1,
  irVersion: "0.1",
  artifactSchema: 1,
  engineVersion: "fixture-engine",
};

export async function snapshotFixture() {
  const directory = await Deno.makeTempDir({ prefix: "assembly-git67-" });
  const blobs = new Map<string, Uint8Array>();
  const repositoryId = "66666666-6666-4666-8666-666666666667";
  const compiler = {
    compile: (sources: Sources) =>
      materialize([], sources, benchmarkRecipe.engineVersion),
    recipe: () => Promise.resolve(benchmarkRecipe),
  };
  const store = {
    ...createColdBuildStore(),
    has: (digest: string) => Promise.resolve(blobs.has(digest)),
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
  };
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
  const repository = await GitModelRepository.open({
    projectDir: directory,
    repositoryId,
    compiler,
    buildService,
  });
  return {
    directory,
    repository,
    compiler,
    buildService,
    async prepare(
      base: Awaited<ReturnType<GitModelRepository["current"]>>,
      sources: Sources,
    ) {
      const compileStart = performance.now();
      const compiled = await compiler.compile(sources);
      const compilationMs = performance.now() - compileStart;
      const descriptor = await buildService.ensure(compiled, benchmarkRecipe);
      const pin = {
        digest: "base-model",
        repositoryVersion: base.version,
        rootId: "root",
        configurationId: "configuration",
        configurationRevision: 0,
        sourceIds: ["source"],
      };
      const change: PendingChange = {
        id: crypto.randomUUID(),
        kind: "mandate-change",
        status: "approved",
        baseRevision: 0,
        baseModelDigest: pin.digest,
        requestedAt: "now",
        decidedAt: "later",
        reason: "snapshot benchmark",
        authorityExercise: exerciseOwnerAuthority({
          identity: { systemId: "system" },
          version: pin,
        }, "mandate-change"),
      };
      const receipt = preparePublication(changePublication(change, pin), {
        executionBase: {
          repositoryVersion: base.version,
          sourceDigest: base.sourceDigest,
        },
        replayedEdits: [],
        revalidation: {
          checkedAt: new Date().toISOString(),
          executionBaseVersion: base.version,
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
      return {
        expectedHeadVersion: base.version,
        sources,
        author: `ase:approved-change:${change.id}`,
        receipt,
        descriptor,
        compilationMs,
      };
    },
    cleanup: () => Deno.remove(directory, { recursive: true }),
  };
}

export function corpus(
  count: number,
  generation = 0,
  changed = count,
  bytesPerFile = 960,
): Sources {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const prefix = `// café 臺灣 🚀\r\npackage Model${index}_${
      index < changed ? generation : 0
    };\n`;
    if (bytesPerFile === 960) {
      return [
        `nested/group${index % 4}/model${index}.sysml`,
        prefix + "// bounded corpus line\n".repeat(40),
      ];
    }
    const padding = " ".repeat(
      Math.max(0, bytesPerFile - new TextEncoder().encode(prefix).length),
    );
    return [`nested/group${index % 4}/model${index}.sysml`, prefix + padding];
  }));
}
