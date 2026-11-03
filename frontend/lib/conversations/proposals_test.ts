import { deepStrictEqual, equal } from "node:assert/strict";
import { evolutionAuthorization } from "../../test/support/evolution-fixture.ts";
import {
  canActOnRead,
  createChatProposalApi,
  createChatProposals,
  operatorsIdle,
  proposalOwner,
  type ProposalPreview,
} from "./proposals.ts";
import type {
  SourceProposal,
  SourceRevisions,
} from "../model/revisions/api.ts";

export function proposal(agentId = "alpha", id = "proposal-a"): SourceProposal {
  return {
    id,
    author: `agent:${agentId}`,
    reason: "Quota de collecte",
    status: "proposed",
    baseVersion: "commit:base",
    proposalVersion: "commit:proposed",
    sourceDigest: "a".repeat(64),
    createdAt: "2026-10-23T09:00:00Z",
    authorization: {
      kind: "operator",
      operatorNativeId: agentId,
      systemQualifiedName: "System",
      operatorQualifiedName: "System::agent",
      mandateId: "mandate",
      mandateRevision: 1,
      policyId: "policy",
      policyRevision: 1,
      policyDigest: "b".repeat(64),
      operations: ["set-value"],
    },
  };
}
export function revisions(
  agentId = "alpha",
  proposals = [proposal(agentId)],
): SourceRevisions {
  return {
    agentId,
    version: "commit:base",
    sourceDigest: "b".repeat(64),
    proposals,
    runtime: { available: null, active: null, executable: true },
  };
}
export function preview(agentId = "alpha"): ProposalPreview {
  return {
    proposalId: "proposal-a",
    agentId,
    baseVersion: "commit:base",
    proposalVersion: "commit:proposed",
    expectedVersion: "commit:base",
    sourceDigest: "a".repeat(64),
    stale: false,
    completeness: true,
    rows: [{
      id: "quota",
      label: "Collecte / quota",
      before: "1",
      after: "25",
    }],
    sourceChanges: [],
  };
}
function fixture() {
  const decisions: unknown[] = [];
  let comparison = preview();
  let current = revisions();
  const store = createChatProposals({
    systemId: () => "system",
    canWrite: () => true,
    afterChange: () => Promise.resolve(),
    api: {
      read: (agentId) => Promise.resolve({ ...current, agentId }),
      preview: () => Promise.resolve(comparison),
      decide: (id, value) => {
        decisions.push({ id, ...value });
        return Promise.resolve({ accepted: true });
      },
      adopt: () => Promise.resolve({ adopted: true }),
    },
  });
  return {
    store,
    decisions,
    setPreview: (value: ProposalPreview) => comparison = value,
    setRevisions: (value: SourceRevisions) => current = value,
  };
}

Deno.test("generic conversation decisions never accept or reject operator evolutions", async () => {
  const f = fixture(),
    p = { ...proposal(), authorization: evolutionAuthorization("alpha") };
  f.setRevisions(revisions("alpha", [p]));
  await f.store.refresh("alpha");
  for (const verdict of ["approve", "refuse"] as const) {
    equal(f.store.canDecide(p, "alpha", verdict), false);
    equal(await f.store.decide(p, "alpha", verdict), false);
  }
  equal(f.decisions.length, 0);
  f.store.dispose();
});

Deno.test("chat proposals require exact author and host-recorded operator identity", () => {
  equal(proposalOwner(proposal()), "alpha");
  equal(proposalOwner({ ...proposal(), author: "agent:beta" }), undefined);
  equal(
    proposalOwner({ ...proposal(), authorization: { kind: "local-owner" } }),
    undefined,
  );
  equal(proposalOwner({ ...proposal(), authorization: undefined }), undefined);
});
Deno.test("source acceptance uses the exact viewed digest and current base, never another agent", async () => {
  const f = fixture(), p = proposal();
  await f.store.refresh("alpha");
  equal(f.store.canDecide(p, "alpha", "approve"), false);
  await f.store.loadPreview(p, "alpha");
  equal(f.store.canDecide(p, "beta", "approve"), false);
  equal(await f.store.decide(p, "alpha", "approve"), true);
  deepStrictEqual(f.decisions, [{
    id: p.id,
    verdict: "approve",
    expectedVersion: "commit:base",
    sourceDigest: p.sourceDigest,
  }]);
});
Deno.test("stale proposals remain rejectable but cannot be accepted from old before/after", async () => {
  const f = fixture(), p = proposal();
  f.setPreview({ ...preview(), stale: true });
  await f.store.refresh("alpha");
  await f.store.loadPreview(p, "alpha");
  equal(f.store.canDecide(p, "alpha", "approve"), false);
  equal(await f.store.decide(p, "alpha", "approve"), false);
  equal(f.decisions.length, 0);
  equal(await f.store.decide(p, "alpha", "refuse", "Réduire le quota"), true);
});
Deno.test("a preview from a different version or identity never enables acceptance", async () => {
  for (
    const wrong of [{ agentId: "beta" }, { expectedVersion: "commit:other" }, {
      sourceDigest: "c".repeat(64),
    }, { proposalVersion: "commit:other" }]
  ) {
    const f = fixture(), p = proposal();
    f.setPreview({ ...preview(), ...wrong });
    await f.store.refresh("alpha");
    await f.store.loadPreview(p, "alpha");
    equal(f.store.canDecide(p, "alpha", "approve"), false);
    equal(Boolean(f.store.previewError(p, "alpha")), true);
  }
});
Deno.test("two open conversations keep their own proposals without cancelling each other's reads", async () => {
  const finish = new Map<string, (value: SourceRevisions) => void>();
  const aborted: string[] = [];
  const store = createChatProposals({
    systemId: () => "system",
    canWrite: () => true,
    afterChange: () => Promise.resolve(),
    api: {
      read: (id, signal) => {
        signal?.addEventListener("abort", () => aborted.push(id));
        return new Promise((resolve) => finish.set(id, resolve));
      },
      preview: () => Promise.resolve(preview()),
      decide: () => Promise.resolve({}),
      adopt: () => Promise.resolve({}),
    },
  });
  // The central conversation loads, then an operator opens beside it.
  const central = store.refresh("alpha");
  const side = store.refresh("beta");
  equal(store.loadingFor("alpha"), true);
  equal(store.loadingFor("beta"), true);
  finish.get("beta")!(revisions("beta"));
  finish.get("alpha")!(revisions("alpha"));
  await Promise.all([central, side]);
  deepStrictEqual(aborted, []);
  equal(store.visible("alpha")?.agentId, "alpha");
  equal(store.visible("beta")?.agentId, "beta");
  equal(store.loadingFor("alpha"), false);
  equal(store.loadingFor("beta"), false);
});
Deno.test("a newer read of the same agent supersedes the older one and errors stay with their agent", async () => {
  const pending: Array<(value: SourceRevisions) => void> = [];
  let failBeta = false;
  const store = createChatProposals({
    systemId: () => "system",
    canWrite: () => true,
    afterChange: () => Promise.resolve(),
    api: {
      read: (id) =>
        id === "beta" && failBeta
          ? Promise.reject(new Error("Lecture refusée"))
          : new Promise((resolve) => pending.push(resolve)),
      preview: () => Promise.resolve(preview()),
      decide: () => Promise.resolve({}),
      adopt: () => Promise.resolve({}),
    },
  });
  const older = store.refresh("alpha");
  const newer = store.refresh("alpha");
  pending[1](revisions("alpha", [proposal("alpha", "newer")]));
  pending[0](revisions("alpha", [proposal("alpha", "older")]));
  await Promise.all([older, newer]);
  equal(store.visible("alpha")?.proposals[0].id, "newer");
  failBeta = true;
  await store.refresh("beta");
  equal(store.errorFor("beta"), "Lecture refusée");
  equal(store.errorFor("alpha"), "");
  equal(store.visible("alpha")?.proposals[0].id, "newer");
});
Deno.test("a decision in one conversation rereads the others, which stay undecidable until reread", async () => {
  let version = "commit:base";
  let failBeta = false;
  const store = createChatProposals({
    systemId: () => "system",
    canWrite: () => true,
    afterChange: () => {
      version = "commit:next";
      return Promise.resolve();
    },
    api: {
      read: (id) =>
        id === "beta" && failBeta
          ? Promise.reject(new Error("Relecture impossible"))
          : Promise.resolve({ ...revisions(id), version }),
      preview: (_id, agentId) =>
        Promise.resolve({ ...preview(agentId), expectedVersion: version }),
      decide: () => Promise.resolve({}),
      adopt: () => Promise.resolve({}),
    },
  });
  await store.refresh("alpha");
  await store.refresh("beta");
  await store.loadPreview(proposal("beta"), "beta");
  equal(store.canDecide(proposal("beta"), "beta", "approve"), true);
  await store.loadPreview(proposal("alpha"), "alpha");
  equal(await store.decide(proposal("alpha"), "alpha", "approve"), true);
  // Beta was reread at the new source version and is decidable again.
  equal(store.visible("beta")?.version, "commit:next");
  equal(store.isStale("beta"), false);
  equal(store.canDecide(proposal("beta"), "beta", "refuse"), true);
  // When the reread fails, the old read stays visible but undecidable.
  failBeta = true;
  await store.loadPreview(proposal("alpha"), "alpha");
  equal(await store.decide(proposal("alpha"), "alpha", "refuse"), true);
  equal(store.isStale("beta"), true);
  equal(store.canDecide(proposal("beta"), "beta", "refuse"), false);
  equal(store.pending.value, "");
});
/** A read the test answers by hand, to stage races. */
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

Deno.test("a first read overtaken by a decision elsewhere is discarded and read again", async () => {
  let version = "commit:base";
  const betaReads: Array<ReturnType<typeof deferred<SourceRevisions>>> = [];
  const store = createChatProposals({
    systemId: () => "system",
    canWrite: () => true,
    afterChange: () => {
      version = "commit:next";
      return Promise.resolve();
    },
    api: {
      read: (id) => {
        if (id !== "beta") {
          return Promise.resolve({ ...revisions(id), version });
        }
        betaReads.push(deferred<SourceRevisions>());
        return betaReads.at(-1)!.promise;
      },
      preview: (_id, agentId) =>
        Promise.resolve({ ...preview(agentId), expectedVersion: version }),
      decide: () => Promise.resolve({}),
      adopt: () => Promise.resolve({}),
    },
  });
  await store.refresh("alpha");
  await store.loadPreview(proposal("alpha"), "alpha");
  // Beta's first read leaves at the base version, then alpha decides.
  const betaFirst = store.refresh("beta");
  equal(await store.decide(proposal("alpha"), "alpha", "approve"), true);
  equal(store.generation.value, 1);
  betaReads[0].resolve({ ...revisions("beta"), version: "commit:base" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The old answer was discarded and beta is read again, still undecidable.
  equal(betaReads.length, 2);
  equal(store.visible("beta"), null);
  equal(store.canDecide(proposal("beta"), "beta", "refuse"), false);
  betaReads[1].resolve({ ...revisions("beta"), version: "commit:next" });
  await betaFirst;
  equal(store.visible("beta")?.version, "commit:next");
  equal(store.isStale("beta"), false);
  equal(store.canDecide(proposal("beta"), "beta", "refuse"), true);
});

Deno.test("an outside change, such as a decision in Evolution, makes every thread stale until reread", async () => {
  let version = "commit:base";
  let hold: ReturnType<typeof deferred<SourceRevisions>> | null = null;
  const store = createChatProposals({
    systemId: () => "system",
    canWrite: () => true,
    afterChange: () => Promise.resolve(),
    api: {
      read: (id) =>
        hold ? hold.promise : Promise.resolve({ ...revisions(id), version }),
      preview: (_id, agentId) =>
        Promise.resolve({ ...preview(agentId), expectedVersion: version }),
      decide: () => Promise.resolve({}),
      adopt: () => Promise.resolve({}),
    },
  });
  await store.refresh("alpha");
  equal(store.canDecide(proposal("alpha"), "alpha", "refuse"), true);
  // Evolution accepted the proposal: same runtime revision, new sources.
  version = "commit:next";
  hold = deferred<SourceRevisions>();
  const reread = store.invalidate();
  equal(store.isStale("alpha"), true);
  equal(store.canAct("alpha"), false);
  equal(store.canDecide(proposal("alpha"), "alpha", "refuse"), false);
  hold.resolve({
    ...revisions("alpha", [{ ...proposal("alpha"), status: "accepted" }]),
    version,
  });
  await reread;
  equal(store.visible("alpha")?.proposals[0].status, "accepted");
  equal(store.canDecide(proposal("alpha"), "alpha", "refuse"), false);
});

Deno.test("activation shares the decision predicate: a failed reread after a decision keeps it disabled", async () => {
  let failBeta = false;
  const ready = (agentId: string): SourceRevisions => ({
    ...revisions(agentId, [{
      ...proposal(agentId),
      status: "accepted",
      acceptedVersion: "commit:accepted",
    }, proposal(agentId, "proposal-b")]),
    runtime: {
      available: { digest: "new", repositoryVersion: "commit:accepted" },
      active: { digest: "old" },
      executable: true,
    },
  });
  const store = createChatProposals({
    systemId: () => "system",
    canWrite: () => true,
    afterChange: () => Promise.resolve(),
    api: {
      read: (id) =>
        id === "beta" && failBeta
          ? Promise.reject(new Error("Relecture impossible"))
          : Promise.resolve(ready(id)),
      preview: (_id, agentId) => Promise.resolve(preview(agentId)),
      decide: () => Promise.resolve({}),
      adopt: () => Promise.resolve({}),
    },
  });
  await store.refresh("alpha");
  await store.refresh("beta");
  equal(store.canAdopt("beta"), true);
  failBeta = true;
  equal(
    await store.decide(proposal("alpha", "proposal-b"), "alpha", "refuse"),
    true,
  );
  equal(store.errorFor("beta"), "Relecture impossible");
  equal(store.canAdopt("beta"), false);
  equal(await store.adopt("beta"), false);
});
Deno.test("the activation waits while any operator runs: one rule, shared with the Revisions page", async () => {
  equal(operatorsIdle(), true);
  equal(operatorsIdle([]), true);
  equal(operatorsIdle([{ busy: false }, {}]), true);
  equal(operatorsIdle([{ busy: false }, { busy: true }]), false);
  const roster = [{ busy: false }, { busy: false }];
  const store = createChatProposals({
    systemId: () => "system",
    canWrite: () => true,
    canAdopt: () => operatorsIdle(roster),
    afterChange: () => Promise.resolve(),
    api: {
      read: (id) =>
        Promise.resolve({
          ...revisions(id, [{
            ...proposal(id),
            status: "accepted",
            acceptedVersion: "commit:accepted",
          }]),
          runtime: {
            available: { digest: "new", repositoryVersion: "commit:accepted" },
            active: { digest: "old" },
            executable: true,
          },
        }),
      preview: (_id, agentId) => Promise.resolve(preview(agentId)),
      decide: () => Promise.resolve({}),
      adopt: () => Promise.resolve({}),
    },
  });
  await store.refresh("alpha");
  equal(store.canAdopt("alpha"), true);
  roster[1].busy = true;
  equal(store.canAdopt("alpha"), false);
  equal(await store.adopt("alpha"), false);
  roster[1].busy = false;
  equal(store.canAdopt("alpha"), true);
});
Deno.test("a confirmed decision advances the generation at once, while slow rereads keep every panel inactive", async () => {
  const slowState = deferred<void>();
  const store = createChatProposals({
    systemId: () => "system",
    canWrite: () => true,
    // The runtime state read (/api/state) is slow to answer.
    afterChange: () => slowState.promise,
    api: {
      read: (id) => Promise.resolve(revisions(id)),
      preview: (_id, agentId) => Promise.resolve(preview(agentId)),
      decide: () => Promise.resolve({}),
      adopt: () => Promise.resolve({}),
    },
  });
  await store.refresh("alpha");
  const decision = store.decide(proposal("alpha"), "alpha", "refuse");
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(store.generation.value, 1);
  equal(store.inFlight.value, true);
  // An Evolution read made before the decision is not actionable any more.
  equal(
    canActOnRead({
      canWrite: true,
      pending: store.inFlight.value,
      generation: store.generation.value,
      readGeneration: 0,
      loading: false,
      error: "",
    }),
    false,
  );
  slowState.resolve();
  equal(await decision, true);
  equal(store.inFlight.value, false);
  equal(store.isStale("alpha"), false);
});

Deno.test("a change tracked from Evolution blocks every thread until it settles", async () => {
  const store = createChatProposals({
    systemId: () => "system",
    canWrite: () => true,
    afterChange: () => Promise.resolve(),
    api: {
      read: (id) => Promise.resolve(revisions(id)),
      preview: () => Promise.resolve(preview()),
      decide: () => Promise.resolve({}),
      adopt: () => Promise.resolve({}),
    },
  });
  await store.refresh("alpha");
  const request = deferred<void>();
  const change = store.track(() => request.promise);
  equal(store.inFlight.value, true);
  equal(store.canDecide(proposal("alpha"), "alpha", "refuse"), false);
  request.resolve();
  await change;
  equal(store.canDecide(proposal("alpha"), "alpha", "refuse"), true);
});
Deno.test("chat preview API makes only explicit decision writes with exact identities", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const api = createChatProposalApi((path, init) => {
    calls.push({ path, init });
    return Promise.resolve(Response.json({}));
  });
  await api.preview("proposal/1", "agent:beta");
  await api.decide("proposal/1", {
    verdict: "refuse",
    expectedVersion: "commit:a",
    sourceDigest: "d",
    reason: "Ajustement demandé",
  });
  equal(
    calls[0].path,
    "/api/model-revisions/proposal%2F1/preview?agentId=agent%3Abeta",
  );
  equal(calls[0].init?.method, undefined);
  equal(calls[1].init?.method, "POST");
  deepStrictEqual(JSON.parse(calls[1].init!.body as string), {
    verdict: "refuse",
    expectedVersion: "commit:a",
    sourceDigest: "d",
    reason: "Ajustement demandé",
  });
});
