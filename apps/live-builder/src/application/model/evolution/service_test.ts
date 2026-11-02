// deno-lint-ignore-file require-await -- Port doubles expose async contracts.
import assert from "node:assert/strict";
import type { EvolutionAuthorityExercise } from "../../../domain/model/evolution/policy.ts";
import { assertEvolutionTransition } from "./invariants.ts";
import {
  type EvolutionAdoptionReceipt,
  type EvolutionDossier,
  EvolutionError,
  type EvolutionPreparationInput,
  type EvolutionProposal,
  type EvolutionPublication,
  type EvolutionStorePort,
  hasEvolutionBarrier,
} from "./ports.ts";
import { EvolutionService } from "./service.ts";

function fixture() {
  const records = new Map<string, EvolutionDossier>();
  const durableAdoptions = new Map<string, EvolutionAdoptionReceipt>();
  let actualPreparer = "author", originClosed = false;
  let safe = false,
    revoked = false,
    failAfterPublication = false,
    failAfterAdoption = false;
  let publication: EvolutionPublication | null = null;
  let publications = 0, adoptions = 0;
  const proposal: EvolutionProposal = {
    id: "proposal",
    version: "candidate",
    baseVersion: "base",
    sourceDigest: "sources",
    recipeDigest: "recipe",
    digest: "exact-proposal",
    targets: [{
      operatorId: "member",
      previousDigest: "old",
      candidateDigest: "new",
    }],
    categories: [
      "flow",
      "instructions",
      "budgets",
      "context",
      "memory",
      "contracts",
    ],
  };
  const store: EvolutionStorePort = {
    async create(d) {
      assert(!records.has(d.id));
      records.set(d.id, structuredClone(d));
      return structuredClone(d);
    },
    async get(id) {
      return structuredClone(records.get(id) ?? null);
    },
    async listPending() {
      return [...records.values()].filter((d) =>
        !["cancelled", "superseded", "adopted"].includes(d.status)
      ).map((d) => structuredClone(d));
    },
    async compareAndSwap(id, revision, d) {
      const previous = records.get(id)!;
      if (previous.revision !== revision) {
        throw new EvolutionError("EVOLUTION_CONFLICT", "changed");
      }
      assertEvolutionTransition(previous, d);
      records.set(id, structuredClone(d));
      return structuredClone(d);
    },
    async targetOwner(_repositoryId, operatorId) {
      return [...records.values()].find((d) =>
        hasEvolutionBarrier(d.status) &&
        d.proposal.targets.some((t) => t.operatorId === operatorId)
      )?.id ?? null;
    },
  };
  const receipt = (
    act: EvolutionAuthorityExercise["act"],
    actorId: string,
  ): EvolutionAuthorityExercise => ({
    act,
    operatorNativeId: actorId,
    systemQualifiedName: "System",
    authorityDigest: "prior",
    policyId: "grant",
    policyRevision: 1,
    mandateNativeId: "mandate-native",
    mandateId: "mandate",
    mandateRevision: 1,
    targets: ["member"],
    categories: [...proposal.categories],
    proposalDigest: proposal.digest,
  });
  const service = new EvolutionService({
    store,
    now: () => "2026-10-27T00:00:00Z",
    authority: {
      async authorize(act, actorId) {
        if (revoked) {
          throw new EvolutionError("REVOKED", "Prior grant was revoked");
        }
        return receipt(act, actorId);
      },
      async revalidate() {
        if (revoked) {
          throw new EvolutionError("REVOKED", "Prior grant was revoked");
        }
      },
    },
    repository: {
      async prepare() {
        return structuredClone(proposal);
      },
      async revalidate() {},
      async publish(d) {
        assert.equal(await store.targetOwner(d.repositoryId, "member"), d.id);
        assert.equal(d.status, "publishing");
        publications++;
        publication = {
          commandId: proposal.id,
          commandDigest: "command",
          version: "published",
          sourceDigest: proposal.sourceDigest,
          proposalDigest: proposal.digest,
        };
        if (failAfterPublication) {
          failAfterPublication = false;
          throw new Error("crash after Git CAS");
        }
        return publication;
      },
      async findPublication() {
        return publication;
      },
    },
    targets: {
      async captureOrigin({ actorId, origin }) {
        if (
          originClosed || actorId !== actualPreparer ||
          origin.operatorId !== actualPreparer ||
          origin.requestId !== "closed-origin" ||
          origin.designerScopeId !== undefined
        ) {
          throw new EvolutionError(
            "EVOLUTION_ORIGIN_INVALID",
            "Claimed scope is not the preparer's current real invocation",
          );
        }
        assert.equal(origin.targetScopes, undefined);
        return { operatorId: actualPreparer, requestId: "closed-origin" };
      },
      async withArmingTargets(_d, saveArmed) {
        return await saveArmed();
      },
      async withReservedTargets(d, operation) {
        assert.equal(await store.targetOwner(d.repositoryId, "member"), d.id);
        return await operation({
          safe,
          blockers: safe ? [] : [{
            code: "PARKED_CONTINUATION",
            operatorId: "member",
            detail: "Existing contribution still depends on old behavior",
          }],
        });
      },
      async inspectAdoption(_d, target) {
        return durableAdoptions.get(target.operatorId) ?? null;
      },
      async adoptExact(d, target, publication) {
        adoptions++;
        const r = {
          ...target,
          version: publication.version,
          proposalDigest: d.proposal.digest,
          effectiveAt: "2026-10-27T00:00:01Z",
        };
        durableAdoptions.set(target.operatorId, r);
        if (failAfterAdoption) {
          failAfterAdoption = false;
          throw new Error("crash after runtime adoption");
        }
        return r;
      },
    },
  });
  const input: EvolutionPreparationInput = {
    id: "evolution",
    repositoryId: "repository",
    actorId: "author",
    finalizerActorId: "finalizer",
    origin: { operatorId: "author", requestId: "closed-origin" },
    expectedVersion: "base",
    sources: { "system.sysml": "candidate" },
    reason: "Change behavior",
  };
  return {
    service,
    store,
    input,
    setSafe(value: boolean) {
      safe = value;
    },
    revoke() {
      revoked = true;
    },
    crashAfterPublication() {
      failAfterPublication = true;
    },
    crashAfterAdoption() {
      failAfterAdoption = true;
    },
    counts: () => ({ publications, adoptions }),
    closeOrigin() {
      originClosed = true;
    },
    setPreparer(actorId: string) {
      actualPreparer = actorId;
    },
  };
}

async function arm(f: ReturnType<typeof fixture>) {
  await f.service.prepare(f.input);
  await f.service.accept(f.input.id, "decider");
  return await f.service.authorizeAdoption(f.input.id, "finalizer");
}

Deno.test("evolution acceptance stays off HEAD; armed target waits for proven boundary", async () => {
  const f = fixture();
  await f.service.prepare(f.input);
  const accepted = await f.service.accept(f.input.id, "decider");
  assert.equal(accepted.status, "accepted");
  assert.equal(await f.store.targetOwner("repository", "member"), null);
  assert.deepEqual(f.counts(), { publications: 0, adoptions: 0 });
  await f.service.authorizeAdoption(f.input.id, "finalizer");
  // Closure after preparation cannot revoke the already-proven provenance.
  f.closeOrigin();
  const waiting = await f.service.finalize(f.input.id);
  assert.equal(waiting.blockers[0].code, "PARKED_CONTINUATION");
  assert.equal(waiting.status, "armed");
  f.setSafe(true);
  const adopted = await f.service.finalize(f.input.id);
  assert.equal(adopted.status, "adopted");
  assert.equal(adopted.origin.requestId, "closed-origin");
  assert.deepEqual(adopted.accounting, {
    id: "evolution:repository:evolution",
    agentInvocations: 0,
  });
  assert.equal(await f.store.targetOwner("repository", "member"), null);
});

Deno.test("evolution recovers Git CAS and runtime receipt without repeated effects", async () => {
  const f = fixture();
  await arm(f);
  f.setSafe(true);
  f.crashAfterPublication();
  let d = await f.service.finalize(f.input.id);
  assert.equal(d.status, "publishing");
  assert.equal(await f.store.targetOwner("repository", "member"), f.input.id);
  await assert.rejects(
    f.service.cancel(f.input.id, "decider"),
    /Publication has started/,
  );
  f.crashAfterAdoption();
  d = (await f.service.recover("repository"))[0];
  assert.equal(d.status, "published-awaiting-adoption");
  assert.equal(d.adoptions.length, 0);
  d = (await f.service.recover("repository"))[0];
  assert.equal(d.status, "adopted");
  assert.deepEqual(f.counts(), { publications: 1, adoptions: 1 });
});

Deno.test("revocation prevents effects; authorized cancellation releases only unpublished barrier", async () => {
  const f = fixture();
  await arm(f);
  f.setSafe(true);
  f.revoke();
  const d = await f.service.finalize(f.input.id);
  assert.equal(d.status, "armed");
  assert.equal(d.blockers[0].code, "REVOKED");
  assert.deepEqual(f.counts(), { publications: 0, adoptions: 0 });
  const g = fixture();
  await arm(g);
  const cancelled = await g.service.cancel(g.input.id, "decider");
  assert.equal(cancelled.cancellation?.act, "accept");
  assert.equal(await g.store.targetOwner("repository", "member"), null);
});

Deno.test("self-modification preparation does not wait for its own activation", async () => {
  const f = fixture();
  f.input.actorId = "member";
  f.input.finalizerActorId = "member";
  f.input.origin.operatorId = "member";
  f.setPreparer("member");
  const d = await f.service.prepare(f.input);
  assert.equal(d.status, "prepared");
  assert.equal(d.preparation.operatorNativeId, "member");
  assert.deepEqual(f.counts(), { publications: 0, adoptions: 0 });
});

Deno.test("evolution preparation rejects forged foreign or nonexistent origin before storing a dossier", async () => {
  for (
    const forged of [
      { operatorId: "foreign", requestId: "closed-origin" },
      { operatorId: "author", requestId: "foreign-request" },
      { operatorId: "author", requestId: "nonexistent-request" },
      { operatorId: "author", designerScopeId: "foreign-designer" },
    ]
  ) {
    const f = fixture();
    f.input.origin = forged;
    await assert.rejects(f.service.prepare(f.input), {
      code: "EVOLUTION_ORIGIN_INVALID",
    });
    assert.equal(await f.store.get(f.input.id), null);
    assert.deepEqual(f.counts(), { publications: 0, adoptions: 0 });
  }
});

Deno.test("evolution preparation discards caller-provided target divider scopes", async () => {
  const f = fixture();
  f.input.origin.targetScopes = [{
    operatorId: "member",
    requestId: "foreign-request",
  }];
  const d = await f.service.prepare(f.input);
  assert.equal(d.origin.targetScopes, undefined);
});

Deno.test("evolution reconciles an adoption receipt committed atomically with its dossier", async () => {
  const f = fixture();
  const adopt = f.service.ports.targets.adoptExact;
  f.service.ports.targets.adoptExact = async (d, target, publication) => {
    const receipt = await adopt(d, target, publication);
    await f.store.compareAndSwap(d.id, d.revision, {
      ...d,
      revision: d.revision + 1,
      status: "adopted",
      adoptions: [receipt],
      blockers: [],
    });
    return receipt;
  };
  await arm(f);
  f.setSafe(true);
  const result = await f.service.finalize(f.input.id);
  assert.equal(result.status, "adopted");
  assert.equal(result.adoptions.length, 1);
  assert.deepEqual(f.counts(), { publications: 1, adoptions: 1 });
  assert.deepEqual(result.blockers, []);
});

Deno.test("evolution refuses an atomic commit carrying another adoption receipt", async () => {
  const f = fixture();
  const adopt = f.service.ports.targets.adoptExact;
  f.service.ports.targets.adoptExact = async (d, target, publication) => {
    const receipt = await adopt(d, target, publication);
    await f.store.compareAndSwap(d.id, d.revision, {
      ...d,
      revision: d.revision + 1,
      adoptions: [{ ...receipt, effectiveAt: "different" }],
    });
    return receipt;
  };
  await arm(f);
  f.setSafe(true);
  const result = await f.service.finalize(f.input.id);
  assert.equal(result.status, "published-awaiting-adoption");
  assert.equal(result.blockers[0].code, "EVOLUTION_RECEIPT_MISMATCH");
  assert.equal(await f.store.targetOwner("repository", "member"), f.input.id);
});
