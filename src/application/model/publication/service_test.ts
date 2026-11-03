// deno-lint-ignore-file require-await -- Async port doubles return deterministic in-memory responses.
import assert from "node:assert/strict";
import { exerciseOwnerAuthority } from "../../../domain/governance/authority.ts";
import {
  changePublication,
  type RevalidationEvidence,
  type SourcePublication,
} from "../../../domain/model/publication/change.ts";
import type { CompiledModel } from "../../../domain/model/records/compiled-model.ts";
import type { ModelSources as Sources } from "../../../domain/model/value-objects/sources.ts";
import type { HostEdit } from "../../../domain/model/editing/host-edit.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";
import { parseModelRevisionRef } from "../../../domain/model/value-objects/element-ref.ts";
import {
  buildOperationJournal,
  type ElementIncarnationRef,
  type ModelOperationJournal,
} from "../../../domain/model/editing/write-command.ts";
import { recipeDigest } from "../../../domain/model/value-objects/build.ts";
import type { HostEditExecutorPort } from "./ports/out/host-edit-executor.port.ts";
import type { PublicationRepositoryPort } from "./ports/out/publication-repository.port.ts";
import type { PublicationRevalidationPort } from "./ports/out/publication-revalidation.port.ts";
import { ModelPublicationError, ModelPublicationService } from "./service.ts";
import { ModelRepositoryError } from "../repository.ts";

const hex = (char: string) => char.repeat(64);
const repositoryId = "git:repo-1";
const baseVersion = "commit:" + "1".repeat(40);
const headVersion = "commit:" + "2".repeat(40);
const recipe = {
  toolkit: { version: "1.0.0", bundleDigest: hex("b") },
  format: "full-json-v1",
  normalizerVersion: 1,
  irVersion: "1",
  artifactSchema: 1,
  engineVersion: "engine-1",
};

async function revision(
  version: string,
  sources: Sources,
): Promise<ModelRevision> {
  return {
    version,
    sources,
    elements: [],
    documents: [],
    sourceDigest: await modelSourceDigest(sources),
    semanticDigest: hex("c"),
    provenanceDigest: hex("d"),
    sourceHashes: {},
    engineVersion: "engine-1",
  };
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

async function fixture(
  baseSources: Sources = { "core.sysml": "package Sys;" },
): Promise<{
  approval: SourcePublication;
  journal: ModelOperationJournal;
  base: ModelRevision;
}> {
  const base = await revision(baseVersion, baseSources);
  const pin = {
    digest: "base-model",
    repositoryVersion: baseVersion,
    rootId: "root",
    configurationId: "configuration",
    configurationRevision: 0,
    sourceIds: ["source"],
  };
  const change: PendingChange = {
    id: "11111111-1111-4111-8111-111111111111",
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
  return {
    approval: changePublication(change, pin),
    journal: buildOperationJournal({
      base: parseModelRevisionRef({ repositoryId, version: baseVersion }),
      baseSourceDigest: base.sourceDigest,
      edits: [edit],
    }),
    base,
  };
}

function fakeRepository(head: ModelRevision) {
  const calls: string[] = [];
  const repo: PublicationRepositoryPort & {
    calls: string[];
    published?: { revision: ModelRevision; receipt?: SourcePublication };
    publishError?: Error;
  } = {
    calls,
    async current() {
      return structuredClone(head);
    },
    async at() {
      return structuredClone(head);
    },
    async header(version) {
      return {
        version,
        sources: head.sources,
        sourceDigest: head.sourceDigest,
      };
    },
    async headVersion() {
      return head.version;
    },
    async findPublication() {
      return repo.published
        ? { revision: repo.published.revision, receipt: repo.published.receipt }
        : null;
    },
    async findPublicationByCommand() {
      return null;
    },
    async publishPrepared(input) {
      calls.push("publishPrepared");
      if (repo.publishError) throw repo.publishError;
      const published = await revision(headVersion, input.sources);
      repo.published = { revision: published, receipt: input.receipt.approval };
      return published;
    },
  };
  return repo;
}

function fakeExecutor(
  inventoryRefs: ElementIncarnationRef[] = [],
): HostEditExecutorPort {
  return {
    async apply(baseRev, edits) {
      return {
        sources: { ...baseRev.sources, "core.sysml": "package Sys; // edited" },
        resolvedEdits: [...edits],
      };
    },
    async verify() {},
    async incarnationInventory() {
      return {
        incarnations: inventoryRefs,
        qualifiedNames: inventoryRefs.map((ref) => ref.qualifiedName),
      };
    },
  };
}

const compiler = {
  async compile(sources: Sources): Promise<CompiledModel> {
    const { version: _version, ...compiled } = await revision("x", sources);
    return compiled;
  },
  async recipe() {
    return recipe;
  },
};

function evidence(
  baseRev: ModelRevision,
  unchanged: boolean,
): RevalidationEvidence {
  return {
    checkedAt: "2026-10-25T12:00:00.000Z",
    executionBaseVersion: baseRev.version,
    scopeDigest: hex("f"),
    authorityStillValid: true,
    preconditionsChecked: 1,
    baseUnchanged: unchanged,
  };
}

function service(
  repo: PublicationRepositoryPort,
  overrides: {
    executor?: HostEditExecutorPort;
    revalidator?: PublicationRevalidationPort;
  } = {},
) {
  return new ModelPublicationService({
    repositoryId,
    repository: repo,
    compiler,
    executor: overrides.executor ?? fakeExecutor(),
    revalidator: overrides.revalidator ?? {
      async revalidate({ executionBase }) {
        return evidence(executionBase, executionBase.version === baseVersion);
      },
    },
  });
}

Deno.test("prepare on the approved base leaves the approval untouched and binds S/R/K/A", async () => {
  const { approval, journal, base } = await fixture();
  const repo = fakeRepository(base);
  const outcome = await service(repo).prepare({ approval, journal });
  assert.equal(outcome.status, "prepared");
  if (outcome.status !== "prepared") return;
  assert.deepStrictEqual(outcome.prepared.approval, approval);
  assert.equal(outcome.prepared.executionBase.repositoryVersion, baseVersion);
  assert.equal(
    outcome.prepared.result.recipeDigest,
    await recipeDigest(recipe),
  );
  assert.match(outcome.prepared.result.artifactDigest!, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(repo.calls, []);
});

Deno.test("moved HEAD replays disjoint operations but a changed incarnation needs a decision", async () => {
  const { approval, journal } = await fixture();
  const head = await revision(headVersion, {
    "core.sysml": "package Sys; // moved",
  });
  const intact: ElementIncarnationRef = {
    nativeId: "el-1",
    qualifiedName: "Sys::a",
    metaclass: "PartUsage",
    preimageDigest: hex("a"),
  };
  const disjoint = await service(fakeRepository(head), {
    executor: fakeExecutor([intact]),
  }).prepare({ approval, journal });
  assert.equal(disjoint.status, "prepared");

  const changed = await service(fakeRepository(head), {
    executor: fakeExecutor([{ ...intact, preimageDigest: hex("e") }]),
  }).prepare({ approval, journal });
  assert.equal(changed.status, "needs-decision");
  if (changed.status === "needs-decision") {
    assert.equal(changed.reason.block?.code, "INCARNATION_CHANGED");
  }
});

Deno.test("revoked or unprovable authority needs a decision; scope refusal refuses", async () => {
  const { approval, journal, base } = await fixture();
  const needs = await service(fakeRepository(base), {
    revalidator: {
      async revalidate() {
        throw new ModelPublicationError(
          "NEEDS_DECISION",
          { changeId: approval.changeId, reason: "MANDATE_REVOKED" },
          "Mandate no longer covers this approval",
        );
      },
    },
  }).prepare({ approval, journal });
  assert.equal(needs.status, "needs-decision");

  const refused = await service(fakeRepository(base), {
    revalidator: {
      async revalidate() {
        throw new ModelPublicationError(
          "REFUSED",
          { changeId: approval.changeId, reason: "OUT_OF_SCOPE" },
          "Candidate leaves the approved scope",
        );
      },
    },
  }).prepare({ approval, journal });
  assert.equal(refused.status, "refused");
});

Deno.test("an existing v1 publication is idempotent; a forged one refuses", async () => {
  const { approval, journal, base } = await fixture();
  const repo = fakeRepository(base);
  const published = await revision(headVersion, base.sources);
  repo.published = {
    revision: published,
    receipt: {
      ...structuredClone(approval),
      edits: [edit],
    } as SourcePublication,
  };
  const existing = await service(repo).prepare({ approval, journal });
  assert.equal(existing.status, "already-published");

  const forged = structuredClone(approval) as Extract<
    SourcePublication,
    { decidedAt: string }
  >;
  forged.decidedAt = "forged";
  repo.published = { revision: published, receipt: forged };
  const mismatch = await service(repo).prepare({ approval, journal });
  assert.equal(mismatch.status, "refused");
});

Deno.test("stale publish re-prepares from scratch and then publishes", async () => {
  const { approval, journal, base } = await fixture();
  const repo = fakeRepository(base);
  repo.publishError = new ModelRepositoryError(
    "STALE_REVISION",
    "head moved",
  );
  let calls = 0;
  const racing = service({
    ...repo,
    async publishPrepared(input) {
      calls++;
      if (calls === 1) throw repo.publishError!;
      return await revision(headVersion, input.sources);
    },
  });
  const outcome = await racing.prepareAndPublish({ approval, journal });
  assert.equal(outcome.status, "published");
  assert.equal(calls, 2);
});

Deno.test("a recipe change under a queued command needs a decision", async () => {
  const { approval, journal, base } = await fixture();
  const outcome = await service(fakeRepository(base)).prepare({
    approval,
    journal,
    expectedRecipeDigest: hex("0"),
  });
  assert.equal(outcome.status, "needs-decision");
  if (outcome.status === "needs-decision") {
    assert.equal(outcome.reason.code, "RECIPE_CHANGED");
  }
});

Deno.test("queued publication cannot adopt a legacy effect without its atomic command digest", async () => {
  const f = await fixture();
  const repo = fakeRepository(f.base);
  repo.published = { revision: f.base, receipt: f.approval };
  const result = await service(repo).prepare({
    approval: f.approval,
    journal: f.journal,
    command: { commandId: f.approval.changeId, commandDigest: hex("9") },
  });
  assert.equal(result.status, "refused");
  if (result.status === "refused") {
    assert.equal(result.reason.code, "WRITE_COMMAND_ANCHOR_MISMATCH");
  }
  assert.deepEqual(repo.calls, []);
});
