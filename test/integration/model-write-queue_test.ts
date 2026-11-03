// deno-lint-ignore-file require-await -- Async store/compiler doubles return deterministic in-memory responses.
import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { materialize } from "../../src/adapters/model/builds/materialization/artifact.ts";
import {
  ModelBuildService,
  sha256HexOfBytes,
} from "../../src/application/model/builds/service.ts";
import {
  BuildStoreError,
  type ModelBuildStore,
} from "../../src/application/model/builds/ports/out/build-store.port.ts";
import { ModelRepositoryError } from "../../src/application/model/repository.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import {
  changePublication,
  preparePublication,
} from "../../src/domain/model/publication/change.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import type { HostEdit } from "../../src/domain/model/editing/host-edit.ts";
import { modelSourceDigest } from "../../src/domain/model/value-objects/sources.ts";
import type { PendingChange } from "../../src/domain/governance/records/pending-change.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const hex = (char: string) => char.repeat(64);
const recipeInputs = {
  toolkit: { version: "fixture-1", bundleDigest: hex("b") },
  format: "fixture-format",
  normalizerVersion: 1,
  irVersion: "1",
  artifactSchema: 1,
  engineVersion: "fixture-engine",
};
const compiler = {
  compile: (sources: Sources) => materialize([], sources, "fixture-engine"),
  recipe: async () => recipeInputs,
};
const source = (name: string): Sources => ({
  "nested/model.sysml": `package ${name};\n`,
});

class MemoryBuildStore implements ModelBuildStore {
  blobs = new Map<string, Uint8Array>();
  projections = new Map<string, Uint8Array>();
  leases = new Map<string, { owner: string; expiresAt: number }>();
  async has(digest: string) {
    return this.blobs.has(digest);
  }
  async get(digest: string) {
    const bytes = this.blobs.get(digest);
    if (!bytes) {
      throw new BuildStoreError("BUILD_BLOB_MISSING", { digest }, "missing");
    }
    if (await sha256HexOfBytes(bytes) !== digest) {
      throw new BuildStoreError("BUILD_BLOB_CORRUPT", { digest }, "corrupt");
    }
    return bytes.slice();
  }
  async put(digest: string, bytes: Uint8Array) {
    const actual = await sha256HexOfBytes(bytes);
    if (actual !== digest) {
      throw new BuildStoreError("BUILD_BLOB_CONFLICT", { digest }, "conflict");
    }
    const stored = !this.blobs.has(digest);
    this.blobs.set(digest, bytes.slice());
    return { stored, bytes: bytes.length, digest };
  }
  #projectionKey(kind: string, version: string, key: string) {
    return `${kind}/${version}/${key}`;
  }
  async hasProjection(kind: string, version: string, key: string) {
    return this.projections.has(this.#projectionKey(kind, version, key));
  }
  async getProjection(kind: string, version: string, key: string) {
    const bytes = this.projections.get(this.#projectionKey(kind, version, key));
    if (!bytes) {
      throw new BuildStoreError("BUILD_BLOB_MISSING", { kind }, "missing");
    }
    return bytes.slice();
  }
  async putProjection(
    kind: string,
    version: string,
    key: string,
    bytes: Uint8Array,
  ) {
    this.projections.set(
      this.#projectionKey(kind, version, key),
      bytes.slice(),
    );
    return {
      stored: true,
      bytes: bytes.length,
      digest: await sha256HexOfBytes(bytes),
    };
  }
  async acquireLease(key: string, owner: string, ttlMs: number) {
    const current = this.leases.get(key);
    if (current && current.expiresAt > Date.now() && current.owner !== owner) {
      return false;
    }
    this.leases.set(key, { owner, expiresAt: Date.now() + ttlMs });
    return true;
  }
  async releaseLease(key: string, owner: string) {
    if (this.leases.get(key)?.owner === owner) this.leases.delete(key);
  }
  async sweep() {
    return {
      orphanChunkKeysRemoved: 0,
      orphanEntries: 0,
      expiredLeasesRemoved: 0,
    };
  }
  async stats() {
    return {
      blobCount: this.blobs.size,
      projectionCount: this.projections.size,
      leaseCount: this.leases.size,
      uncompressedBytes: 0,
      quotaBytes: null,
      overQuota: false,
    };
  }
  async close() {}
}

const edit: HostEdit = {
  op: "setFeatureValue",
  target: {
    id: "el-1",
    qualifiedName: "Sys::a",
    metaclass: "PartUsage",
    preimage: hex("a"),
  },
  value: "x",
  format: 1,
};
const changeId = "11111111-1111-4111-8111-111111111111";

function approvedChange(baseVersion: string) {
  const pin = {
    digest: "base-execution-digest",
    repositoryVersion: baseVersion,
    rootId: "root",
    configurationId: "configuration",
    configurationRevision: 0,
    sourceIds: ["source"],
  };
  const change: PendingChange = {
    id: changeId,
    kind: "mandate-change",
    status: "approved",
    baseRevision: 0,
    baseModelDigest: pin.digest,
    requestedAt: "now",
    decidedAt: "later",
    reason: "Exact extension",
    authorityExercise: exerciseOwnerAuthority(
      { identity: { systemId: "system" }, version: pin },
      "mandate-change",
    ),
  };
  return { change, pin, approval: changePublication(change, pin) };
}

Deno.test("W3 publishPrepared stores an exact v2 receipt, projects v1, and is idempotent", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    let repo = await GitModelRepository.open({ projectDir, compiler });
    const initial = await repo.initialize(source("Initial"));
    const store = new MemoryBuildStore();
    const buildService = new ModelBuildService({
      repositoryId: repo.repositoryId,
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
    repo = await GitModelRepository.open({
      projectDir,
      compiler,
      buildService,
      writeFence: {
        assertCurrent: async () => {},
        guard: (_fence, operation) => operation(),
      },
    });
    const { approval } = approvedChange(initial.version);
    const nextSources = source("Prepared");
    const descriptor = await buildService.ensure(
      await compiler.compile(nextSources),
      recipeInputs,
    );
    const fence = {
      repositoryId: repo.repositoryId,
      commandId: changeId,
      owner: "test-worker",
      fence: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const receipt = preparePublication(approval, {
      executionBase: {
        repositoryVersion: initial.version,
        sourceDigest: initial.sourceDigest,
      },
      replayedEdits: [edit],
      journalDigest: hex("e"),
      revalidation: {
        checkedAt: "2026-10-25T12:00:00.000Z",
        executionBaseVersion: initial.version,
        scopeDigest: hex("f"),
        authorityStillValid: true,
        preconditionsChecked: 1,
        baseUnchanged: true,
      },
      result: { sourceDigest: await modelSourceDigest(nextSources) },
      command: { commandId: changeId, commandDigest: hex("9") },
    });
    const input = {
      expectedHeadVersion: initial.version,
      sources: nextSources,
      author: `ase:approved-change:${changeId}`,
      receipt,
      descriptor,
      fence,
    };
    const published = await repo.publishPrepared(input);
    equal((await repo.current()).version, published.version);
    equal(await repo.headVersion(), published.version);

    const byChange = await repo.findPublication(changeId);
    assert(byChange?.receipt);
    equal(byChange.receipt.changeId, changeId);
    equal(byChange.receipt.baseModelDigest, "base-execution-digest");
    deepStrictEqual(byChange.receipt.edits, [edit]);

    const byCommand = await repo.findPublicationByCommand(changeId);
    assert(byCommand);
    deepStrictEqual(byCommand.receipt, receipt);

    const again = await repo.publishPrepared(input);
    equal(again.version, published.version);

    // A preparation against the old base now fences as stale, unwrapped.
    const staleReceipt = preparePublication(approval, {
      executionBase: {
        repositoryVersion: initial.version,
        sourceDigest: initial.sourceDigest,
      },
      replayedEdits: [edit],
      revalidation: {
        checkedAt: "2026-10-25T12:05:00.000Z",
        executionBaseVersion: initial.version,
        scopeDigest: hex("f"),
        authorityStillValid: true,
        preconditionsChecked: 1,
        baseUnchanged: true,
      },
      result: { sourceDigest: await modelSourceDigest(source("Stale")) },
    });
    const otherId = "22222222-2222-4222-8222-222222222222";
    const staleApproval = { ...staleReceipt.approval, changeId: otherId };
    await rejects(
      () =>
        repo.publishPrepared({
          expectedHeadVersion: initial.version,
          sources: source("Stale"),
          author: `ase:approved-change:${otherId}`,
          receipt: { ...staleReceipt, approval: staleApproval },
        }),
      (error: unknown) =>
        error instanceof ModelRepositoryError &&
        error.code === "STALE_REVISION",
    );

    // Anchor target carries no approval trailer (accept-proposal shape).
    await repo.anchorCommandPublication({
      commandId: "proposal-anchor-1",
      version: initial.version,
    });
    const anchored = await repo.findPublicationByCommand("proposal-anchor-1");
    equal(anchored?.revision.version, initial.version);
    equal(anchored?.receipt, undefined);
    await rejects(
      () =>
        repo.anchorCommandPublication({
          commandId: "proposal-anchor-1",
          version: published.version,
        }),
      (error: unknown) =>
        error instanceof ModelRepositoryError &&
        error.code === "INVALID_REQUEST",
    );
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("descriptor commits resolve through W2 while legacy history stays readable", async () => {
  const projectDir = await Deno.makeTempDir();
  try {
    let repo = await GitModelRepository.open({ projectDir, compiler });
    const legacy = await repo.initialize(source("Legacy"));
    const store = new MemoryBuildStore();
    const buildService = new ModelBuildService({
      repositoryId: repo.repositoryId,
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
    repo = await GitModelRepository.open({
      projectDir,
      compiler,
      buildService,
    });
    const descriptor = await repo.publishSystemSources(
      source("Descriptor"),
      legacy.version,
      "local-owner",
    );
    equal((await repo.at(legacy.version)).sourceDigest, legacy.sourceDigest);
    equal(
      (await repo.at(descriptor.version)).sourceDigest,
      descriptor.sourceDigest,
    );
    assert(store.blobs.size >= 1);

    // Without the build service, opening on a descriptor HEAD fails
    // explicitly with the W2 code — never as repository corruption.
    await rejects(
      () => GitModelRepository.open({ projectDir, compiler }),
      (error: unknown) =>
        error instanceof Error && error.name === "ModelBuildServiceError" &&
        (error as { code?: string }).code === "BUILD_UNAVAILABLE",
    );
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});
