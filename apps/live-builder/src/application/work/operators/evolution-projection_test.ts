// deno-lint-ignore-file require-await -- In-memory read ports retain their asynchronous contract.
import assert from "node:assert/strict";
import type { EvolutionAuthorityExercise } from "../../../domain/model/evolution/policy.ts";
import type { ProposalRecord } from "../../../domain/model/records/revision.ts";
import type {
  EvolutionDossier,
  EvolutionStorePort,
} from "../../model/evolution/ports.ts";
import { EvolutionConversationProjection } from "./evolution-projection.ts";

function fixture() {
  const exercise: EvolutionAuthorityExercise = {
    act: "prepare",
    operatorNativeId: "author",
    systemQualifiedName: "System",
    authorityDigest: "authority",
    policyId: "policy",
    policyRevision: 1,
    mandateNativeId: "mandate-native",
    mandateId: "mandate",
    mandateRevision: 1,
    targets: ["target"],
    categories: ["instructions"],
    proposalDigest: "proposal-digest",
  };
  const dossier: EvolutionDossier = {
    v: 1,
    id: "dossier",
    repositoryId: "repository",
    revision: 0,
    status: "prepared",
    origin: { operatorId: "author", requestId: "actual-closed-request" },
    finalizerActorId: "finalizer",
    accounting: { id: "evolution:repository:dossier", agentInvocations: 0 },
    createdAt: "2026-10-27T00:00:00Z",
    updatedAt: "2026-10-27T00:00:00Z",
    proposal: {
      id: "proposal",
      version: "commit:candidate",
      baseVersion: "commit:base",
      sourceDigest: "candidate-sources",
      recipeDigest: "recipe",
      digest: "proposal-digest",
      targets: [{
        operatorId: "target",
        previousDigest: "previous",
        candidateDigest: "candidate",
      }],
      categories: ["instructions"],
    },
    preparation: exercise,
    adoptions: [],
    blockers: [],
  };
  const proposal: ProposalRecord = {
    id: "proposal",
    branch: "staged-proposal",
    author: "agent:author",
    reason: "Clarify the admitted instruction",
    baseVersion: "commit:base",
    proposalVersion: "commit:candidate",
    createdAt: dossier.createdAt,
    status: "proposed",
    validation: "validated",
    sourceDigest: "candidate-sources",
    diff: [],
    authorization: {
      kind: "operator-evolution",
      operatorNativeId: "author",
      exercise,
    } as NonNullable<
      ProposalRecord["authorization"]
    >,
  };
  let records = [dossier];
  const reads: string[] = [];
  const store: EvolutionStorePort = {
    async get() {
      return structuredClone(dossier);
    },
    async listPending() {
      return structuredClone(records);
    },
    async listRecent(_repository, limit) {
      assert.equal(limit, 256);
      return structuredClone(records.slice(0, limit));
    },
    async create() {
      throw new Error("Read projection must not create a dossier");
    },
    async compareAndSwap() {
      throw new Error("Read projection must not mutate a dossier");
    },
    async targetOwner() {
      throw new Error("Read projection grants no target reservation");
    },
  };
  const projection = new EvolutionConversationProjection({
    repositoryId: "repository",
    store,
    repository: {
      async proposal(id) {
        reads.push(id);
        return structuredClone(proposal);
      },
      async header(version) {
        reads.push(version);
        return {
          version,
          sourceDigest: version === "commit:base"
            ? "base-sources"
            : "candidate-sources",
          sources: { "private.sysml": "do-not-ship-source-bytes" },
        };
      },
    },
  });
  const labels = new Map<string, string | null>([["author", "Author"], [
    "target",
    "Target",
  ]]);
  return {
    projection,
    dossier,
    proposal,
    labels,
    reads,
    setRecords: (value: EvolutionDossier[]) => {
      records = value;
    },
  };
}

Deno.test("evolution cards retain exact origin, immutable diff pins and host labels without source bytes", async () => {
  const f = fixture();
  const record = await f.projection.record(f.dossier, f.labels);
  assert.deepEqual(record.origin, {
    operatorId: "author",
    requestId: "actual-closed-request",
  });
  assert.deepEqual(record.base, {
    version: "commit:base",
    sourceDigest: "base-sources",
  });
  assert.deepEqual(record.candidate, {
    version: "commit:candidate",
    sourceDigest: "candidate-sources",
  });
  assert.equal(record.targets[0].name, "Target");
  assert.equal(record.preparer.name, "Author");
  assert.equal(record.finalizer.name, null);
  assert.equal(record.proposalId, "proposal");
  assert.equal(record.proposalDigest, "proposal-digest");
  assert.equal(
    JSON.stringify(record).includes("do-not-ship-source-bytes"),
    false,
  );
  f.dossier.status = "accepted";
  f.dossier.revision = 1;
  f.labels.set("author", "Changed later");
  const next = await f.projection.record(f.dossier, f.labels);
  assert.equal(record.status, "prepared");
  assert.equal(record.preparer.name, "Author");
  assert.equal(next.status, "accepted");
  assert.equal(next.preparer.name, "Changed later");
  assert.equal(
    f.reads.length,
    3,
    "Immutable metadata is cached without re-reading source trees",
  );
});

Deno.test("evolution conversation index scopes actual origins, bounds records/blockers and changes read identity", async () => {
  const f = fixture();
  const before = await f.projection.read(f.labels);
  f.dossier.blockers = Array.from(
    { length: 20 },
    () => ({ code: "CHECKPOINT", detail: "x".repeat(1000) }),
  );
  f.dossier.revision++;
  const current = await f.projection.read(f.labels);
  assert.notEqual(current.version, before.version);
  assert.equal(current.items[0].blockers.length, 16);
  assert.equal(current.items[0].blockers[0].detail.length, 500);
  const unrelated = {
    ...structuredClone(f.dossier),
    id: "unrelated",
    origin: { operatorId: "foreign", requestId: "foreign-request" },
  };
  const unscoped = {
    ...structuredClone(f.dossier),
    id: "unscoped",
    origin: { operatorId: "author" },
  };
  f.setRecords([
    unrelated,
    unscoped,
    ...Array.from(
      { length: 70 },
      (_, i) => ({ ...structuredClone(f.dossier), id: `own-${i}` }),
    ),
  ]);
  const bounded = await f.projection.read(f.labels);
  assert.equal(bounded.items.length, 64);
  assert.equal(bounded.truncated, true);
  assert.equal(
    bounded.items.some((d) => ["unrelated", "unscoped"].includes(d.dossierId)),
    false,
  );
});

Deno.test("evolution projection refuses mismatched source identities rather than inventing a diff", async () => {
  const f = fixture();
  f.proposal.sourceDigest = "tampered";
  await assert.rejects(() => f.projection.record(f.dossier, f.labels), {
    code: "EVOLUTION_SOURCE_CHANGED",
  });
  const g = fixture();
  g.dossier.origin.designerScopeId = "another-scope";
  await assert.rejects(() => g.projection.record(g.dossier, g.labels), {
    code: "EVOLUTION_ORIGIN_INVALID",
  });
});
