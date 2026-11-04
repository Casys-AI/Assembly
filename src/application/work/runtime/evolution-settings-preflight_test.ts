import assert from "node:assert/strict";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import type { WorkspaceEvolutionContext } from "../evolution/workspace-targets.ts";
import type {
  EvolutionDossier,
  EvolutionStorePort,
} from "../../model/evolution/ports.ts";
import type { EvolutionAuthorityExercise } from "../../../domain/model/evolution/policy.ts";
import type { ScopedExecutableModel } from "../../../domain/model/evolution/semantic-effects.ts";
import type { BehaviorSettingsValidationTarget } from "./behavior-settings-validation.ts";
import type { WorkBudgetRecord } from "../../../domain/work/policies/budget.ts";
import { WorkBudgetService } from "../budget/service.ts";
import { createEvolutionSettingsPreflight } from "./evolution-settings-preflight.ts";
import type { EvolutionSettingsAssessment } from "../../model/evolution/assessment.ts";

async function fixture() {
  const a = artifactModel("first"), b = artifactModel("second");
  a.workBudgetPolicy = {
    id: "same-ledger",
    revision: 1,
    elementId: "budget",
    sourceIds: [],
    unit: "agent-invocation",
    limit: 5,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
  };
  const nextA = structuredClone(a), nextB = structuredClone(b);
  nextA.version.digest = "first-next";
  nextB.version.digest = "second-next";
  nextA.workBudgetPolicy!.limit = 8;
  nextA.workBudgetPolicy!.revision = 2;
  nextB.policy.maxAgentDecisions++;
  nextA.version.repositoryVersion =
    nextB.version.repositoryVersion =
      "candidate-branch";
  const scoped = (model: typeof a): ScopedExecutableModel => ({
    model,
    systemQualifiedName: model.identity.systemId,
    evidence: { digestInputs: [], sourceFacts: {}, sourceCategories: {} },
  });
  const assessment: EvolutionSettingsAssessment = {
    before: [scoped(a), scoped(b)],
    after: [scoped(nextA), scoped(nextB)],
    effects: [a, b].map((model) => ({
      targetNativeId: model.identity.builderId,
      systemQualifiedName: model.identity.systemId,
      category: "budgets",
      before: {},
      after: {},
    })),
  };
  const proposal = {
    id: "proposal",
    version: "candidate-branch",
    baseVersion: "commit:shared-source",
    sourceDigest: "candidate-sources",
    recipeDigest: "recipe",
    digest: "exact-proposal",
    targets: [a, b].map((model, index) => ({
      operatorId: model.identity.builderId,
      previousDigest: model.version.digest,
      candidateDigest: [nextA, nextB][index]!.version.digest,
    })),
    categories: ["budgets" as const],
  };
  assessment.proposal = proposal;
  const receipt = {
    act: "adopt",
    operatorNativeId: "decider",
    systemQualifiedName: "Test::Decider",
    authorityDigest: "authority",
    policyId: "policy",
    policyRevision: 1,
    mandateNativeId: "mandate",
    mandateId: "mandate",
    mandateRevision: 1,
    targets: ["first", "second"],
    categories: ["budgets"],
    proposalDigest: proposal.digest,
  } as EvolutionAuthorityExercise;
  const dossier: EvolutionDossier = {
    v: 1,
    id: "dossier",
    repositoryId: "repo",
    revision: 4,
    status: "published-awaiting-adoption",
    adoptions: [],
    blockers: [],
    origin: { operatorId: "first" },
    finalizerActorId: "decider",
    accounting: { id: "evolution:repo:dossier", agentInvocations: 0 },
    createdAt: "2026-10-27T00:00:00Z",
    updatedAt: "2026-10-27T00:00:00Z",
    proposal,
    preparation: { ...receipt, act: "prepare" },
    adoptionAuthorization: receipt,
    publication: {
      commandId: "command",
      commandDigest: "command-digest",
      version: "published",
      sourceDigest: proposal.sourceDigest,
      proposalDigest: proposal.digest,
    },
  };
  const target = (model: typeof a): BehaviorSettingsValidationTarget => ({
    operatorNativeId: model.identity.builderId,
    snapshot: {
      id: model.identity.builderId,
      revision: 0,
      catalogRevision: 0,
      provider: "test",
      phase: "ready",
      busy: false,
      executionModel: structuredClone(model),
      messages: [],
      events: [],
      candidates: [],
    },
    budgetScopes: [],
  });
  const first = target(nextA), second = target(b);
  first.snapshot.executionModel!.version.repositoryVersion = "published";
  const settle = (
    runtime: BehaviorSettingsValidationTarget,
    old: typeof a,
    next: typeof a,
  ) => {
    runtime.snapshot.executionModel = structuredClone(next);
    runtime.snapshot.executionModel.version.repositoryVersion = "published";
    runtime.snapshot.events.push({
      id: `adoption-${old.identity.builderId}`,
      at: "2026-10-27T00:00:00Z",
      kind: "effective-model-updated",
      label: "adopted",
      effectiveModelUpdate: {
        id: `effective-${old.identity.builderId}`,
        activatedAt: "2026-10-27T00:00:00Z",
        kind: "model",
        operatorId: old.identity.builderId,
        dossierId: "dossier",
        actorId: "decider",
        from: {
          digest: old.version.digest,
          repositoryVersion: old.version.repositoryVersion,
        },
        to: { digest: next.version.digest, repositoryVersion: "published" },
      },
    });
  };
  settle(first, a, nextA);
  const records = new Map<string, WorkBudgetRecord>();
  const budget = new WorkBudgetService({
    load: (id) => Promise.resolve(structuredClone(records.get(id) ?? null)),
    save: (record) => {
      records.set(record.scopeId, structuredClone(record));
      return Promise.resolve();
    },
  });
  await budget.adopt({
    scopeId: "shared-scope",
    ownerId: "first",
    previousPolicy: undefined,
    policy: a.workBudgetPolicy,
    modelVersion: a.version,
  });
  await budget.reserve({
    scopeId: "shared-scope",
    ownerId: "first",
    policy: a.workBudgetPolicy,
    modelVersion: a.version,
    attemptId: "consumed",
    operation: "decide",
  });
  await budget.settle({
    scopeId: "shared-scope",
    ownerId: "first",
    attemptId: "consumed",
    outcome: "returned",
  });
  await budget.adopt({
    scopeId: "shared-scope",
    ownerId: "first",
    previousPolicy: a.workBudgetPolicy,
    policy: nextA.workBudgetPolicy,
    modelVersion: nextA.version,
  });
  second.budget = budget;
  second.budgetScopes = [{
    scopeId: "shared-scope",
    ownerId: "first",
    designer: true,
  }];
  let gets = 0;
  const store = {
    get: (id: string) => {
      gets++;
      return Promise.resolve(
        id === dossier.id ? structuredClone(dossier) : null,
      );
    },
    listPending: () => {
      throw new Error(
        "A closed dossier must be read by its durable receipt identity",
      );
    },
  } as unknown as EvolutionStorePort;
  const context = {
    validationTargets: () => Promise.resolve([first, second]),
  } as unknown as WorkspaceEvolutionContext;
  const preflight = createEvolutionSettingsPreflight({
    context,
    store,
    repositoryId: "repo",
  });
  return {
    assessment,
    dossier,
    first,
    second,
    preflight,
    records,
    settleSecond: () => settle(second, b, nextB),
    gets: () => gets,
  };
}

Deno.test("partial adoption preflight preserves a shared ledger and validates the remaining target", async () => {
  const f = await fixture(),
    ledger = structuredClone(f.records.get("shared-scope"));
  await f.preflight(f.assessment);
  assert.deepEqual(f.records.get("shared-scope"), ledger);
  assert.equal(f.gets(), 1);
});
Deno.test("candidate pins require exact same-proposal durable adoption evidence", async () => {
  const f = await fixture();
  f.first.snapshot.events = [];
  await assert.rejects(() => f.preflight(f.assessment), /activation evidence/);
  const g = await fixture();
  g.dossier.publication!.sourceDigest = "other-sources";
  await assert.rejects(
    () => g.preflight(g.assessment),
    /matching durable evolution publication/,
  );
});
Deno.test("a fully adopted closed dossier is found by receipt identity on restart", async () => {
  const f = await fixture();
  f.settleSecond();
  f.dossier.status = "adopted";
  await f.preflight(f.assessment);
  assert.equal(f.gets(), 2);
});
Deno.test("preparation never treats an already-candidate pin as prior authority", async () => {
  const f = await fixture();
  delete f.assessment.proposal;
  await assert.rejects(() => f.preflight(f.assessment), /receipted candidate/);
});

Deno.test("a closed adopted dossier cannot conceal an old target pin", async () => {
  const f = await fixture();
  f.dossier.status = "adopted";
  await assert.rejects(
    () => f.preflight(f.assessment),
    /unadopted runtime target/,
  );
});
