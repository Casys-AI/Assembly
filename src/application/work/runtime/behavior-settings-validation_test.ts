import assert from "node:assert/strict";
import {
  artifactModel,
  reuseBehavior,
} from "../../../../test/support/tool-artifact-fixture.ts";
import {
  type BehaviorSettingsValidationInput,
  type BehaviorSettingsValidationTarget,
  validateBehaviorSettingsChange,
} from "./behavior-settings-validation.ts";
import type { ScopedExecutableModel } from "../../../domain/model/evolution/semantic-effects.ts";
import type { EvolutionCategory } from "../../../domain/model/evolution/policy.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { ChatContext } from "../conversation/chat-context.ts";
import type { MemoryRecord } from "../../../domain/memory/entities/memory-record.ts";
import { WorkBudgetService } from "../budget/service.ts";
import type { WorkBudgetRecord } from "../../../domain/work/policies/budget.ts";

function scoped(model: ExecutableModel): ScopedExecutableModel {
  return {
    systemQualifiedName: model.identity.systemId,
    model,
    evidence: { digestInputs: [], sourceFacts: {}, sourceCategories: {} },
  };
}
function target(model: ExecutableModel): BehaviorSettingsValidationTarget {
  return {
    operatorNativeId: model.identity.builderId,
    snapshot: {
      id: "session",
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
  };
}
function input(
  previous: ExecutableModel,
  next: ExecutableModel,
  category: EvolutionCategory,
): BehaviorSettingsValidationInput {
  return {
    before: [scoped(previous)],
    after: [scoped(next)],
    affectedOperatorIds: [previous.identity.builderId],
    targets: [target(previous)],
    effects: [{
      targetNativeId: previous.identity.builderId,
      systemQualifiedName: previous.identity.systemId,
      category,
      before: {},
      after: {},
    }],
  };
}
function payload(model: ExecutableModel): ChatContext {
  return {
    mandate: structuredClone(model.mandate),
    configuration: { ...structuredClone(model.configuration), changes: [] },
    messages: [],
    candidates: [],
    activeTools: [],
    contracts: structuredClone(model.contracts),
    executionPolicy: structuredClone(model.policy),
    modelVersion: {
      digest: model.version.digest,
      repositoryVersion: model.version.repositoryVersion,
    },
    admittedModelVersion: {
      digest: model.version.digest,
      repositoryVersion: model.version.repositoryVersion,
    },
    ...(model.operator
      ? {
        operator: {
          nativeId: model.identity.builderId,
          name: model.operator.name,
          instruction: model.operator.instruction,
        },
      }
      : {}),
  };
}
async function budgetFixture() {
  const previous = artifactModel("account-owner");
  previous.workBudgetPolicy = {
    id: "retained-ledger",
    revision: 1,
    elementId: "budget",
    sourceIds: [],
    unit: "agent-invocation",
    limit: 5,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
  };
  const records = new Map<string, WorkBudgetRecord>();
  const port = new WorkBudgetService({
    load: (scopeId) =>
      Promise.resolve(structuredClone(records.get(scopeId) ?? null)),
    save(record, expected) {
      assert.equal(records.get(record.scopeId)?.revision ?? null, expected);
      records.set(record.scopeId, structuredClone(record));
      return Promise.resolve();
    },
  });
  await port.adopt({
    scopeId: "retained-case",
    ownerId: "account-owner",
    previousPolicy: undefined,
    policy: previous.workBudgetPolicy,
    modelVersion: previous.version,
  });
  for (const attemptId of ["consumed", "reserved"]) {
    await port.reserve({
      scopeId: "retained-case",
      ownerId: "account-owner",
      policy: previous.workBudgetPolicy,
      modelVersion: previous.version,
      operation: "decide",
      attemptId,
    });
  }
  await port.settle({
    scopeId: "retained-case",
    ownerId: "account-owner",
    attemptId: "consumed",
    outcome: "returned",
  });
  const next = structuredClone(previous);
  next.workBudgetPolicy!.revision++;
  next.version.digest = "next";
  const request = input(previous, next, "budgets");
  request.targets[0].budget = port;
  request.targets[0].budgetScopes = [{
    scopeId: "retained-case",
    ownerId: "account-owner",
    designer: true,
  }];
  request.targets[0].snapshot.workBudgetBinding = {
    budgetId: "retained-ledger",
    scopeId: "retained-case",
  };
  return { previous, next, port, records, request };
}

Deno.test("budget preflight preserves the real ledger and refuses below consumed plus reserved", async () => {
  const f = await budgetFixture();
  const ledger = structuredClone(f.records.get("retained-case"));
  f.next.workBudgetPolicy!.limit = 1;
  await assert.rejects(
    () => validateBehaviorSettingsChange(f.request),
    /below consumed and reserved/,
  );
  assert.deepEqual(f.records.get("retained-case"), ledger);
  f.next.workBudgetPolicy!.limit = 2;
  const result = await validateBehaviorSettingsChange(f.request);
  assert.deepEqual(result.budgets, [{
    scopeId: "retained-case",
    ownerId: "account-owner",
    consumed: 1,
    reserved: 1,
    nextLimit: 2,
  }]);
  assert.deepEqual(f.records.get("retained-case"), ledger);
});

Deno.test("budget preflight refuses missing started ledgers and omitted retained bindings", async () => {
  const f = await budgetFixture();
  f.records.clear();
  await assert.rejects(
    () => validateBehaviorSettingsChange(f.request),
    /initial adoption/,
  );
  f.request.targets[0].budgetScopes = [];
  await assert.rejects(
    () => validateBehaviorSettingsChange(f.request),
    /Missing retained budget scope/,
  );
});

Deno.test("pending initial adoption is distinguished from a missing started ledger", async () => {
  const f = await budgetFixture();
  f.records.clear();
  f.request.targets[0].budgetScopes[0].pending = true;
  await assert.rejects(
    () => validateBehaviorSettingsChange(f.request),
    /actual pending initial scope/,
  );
  f.request.targets[0].snapshot.caseBudgetPending = true;
  await validateBehaviorSettingsChange(f.request);
  assert.equal(f.records.size, 0);
});

Deno.test("context preflight uses the entire candidate payload and cannot silently drop loaded resources", async () => {
  const previous = artifactModel("reader"), next = structuredClone(previous);
  previous.contextPolicy = {
    id: "context",
    revision: 1,
    elementId: "context",
    sourceIds: [],
    kind: "separated-context",
    pattern: "5.1",
    recentMessages: 8,
    maxMessageCharacters: 1024,
    maxCollectionItems: 8,
    maxContextCharacters: 100000,
  };
  next.contextPolicy = {
    ...previous.contextPolicy,
    revision: 2,
    maxContextCharacters: 4096,
  };
  next.version.digest = "next";
  const request = input(previous, next, "context");
  await assert.rejects(
    () => validateBehaviorSettingsChange(request),
    /complete unprojected/,
  );
  request.targets[0].decisionContext = payload(next);
  request.targets[0].decisionContext!.modelSources = {
    version: "commit:retained",
    sources: { "retained.sysml": "x".repeat(10000) },
  };
  await assert.rejects(
    () => validateBehaviorSettingsChange(request),
    /required decision context/,
  );
  next.contextPolicy.maxContextCharacters = 100000;
  const result = await validateBehaviorSettingsChange(request);
  assert.ok(result.context[0].projectedCharacters > 10000);
  assert.equal(
    request.targets[0].decisionContext!.modelSources.sources["retained.sysml"]
      .length,
    10000,
  );
});

Deno.test("instruction compatibility tests the new instruction, not the old payload", async () => {
  const previous = artifactModel("writer");
  previous.operator = {
    name: "Writer",
    instruction: "Old instruction",
    primary: false,
    humanInput: false,
  };
  previous.contextPolicy = {
    id: "context",
    revision: 1,
    elementId: "context",
    sourceIds: [],
    kind: "separated-context",
    pattern: "5.1",
    recentMessages: 8,
    maxMessageCharacters: 1024,
    maxCollectionItems: 8,
    maxContextCharacters: 100000,
  };
  const next = structuredClone(previous);
  next.operator!.instruction = "New instruction";
  next.version.digest = "next";
  const request = input(previous, next, "instructions");
  request.targets[0].decisionContext = payload(next);
  request.targets[0].decisionContext!.operator!.instruction =
    previous.operator.instruction;
  await assert.rejects(
    () => validateBehaviorSettingsChange(request),
    /omits changed executable settings/,
  );
  request.targets[0].decisionContext!.operator!.instruction =
    next.operator!.instruction;
  await validateBehaviorSettingsChange(request);
});

Deno.test("memory preflight preserves note statuses, provenance and review history", async () => {
  const previous = artifactModel("memory-owner");
  previous.memoryPolicy = {
    id: "memory",
    revision: 1,
    elementId: "memory",
    sourceIds: [],
    kind: "governed-memory",
    pattern: "5.2",
    ownerId: "memory-owner",
    allowedScopes: ["project", "legacy"],
    requireSourceRefs: true,
    requireKnownOutcome: false,
    maxValidityMs: 100000,
    allowSelfAdmission: false,
  };
  const next = structuredClone(previous);
  next.memoryPolicy!.allowedScopes = ["project"];
  next.memoryPolicy!.allowSelfAdmission = true;
  next.memoryPolicy!.revision++;
  next.version.digest = "next";
  const request = input(previous, next, "memory");
  const note = (
    id: string,
    status: MemoryRecord["status"],
    scope: string,
  ): MemoryRecord => ({
    id,
    ownerId: "memory-owner",
    contributorId: "memory-owner",
    revision: 1,
    digest: "note-digest",
    content: {
      text: "Retain this exact note",
      origin: { decisionId: "original", sourceRefs: ["source"] },
      scope: [scope],
      validUntil: "2026-10-28T00:00:00Z",
      outcome: { status: "pending" },
    },
    status,
    createdAt: "2026-10-27T00:00:00Z",
    updatedAt: "2026-10-27T00:00:00Z",
    history: [],
  });
  request.targets[0].memoryRecords = [
    note("candidate", "candidate", "project"),
    note("review", "revision-requested", "project"),
    note("admitted-old-scope", "admitted", "legacy"),
  ];
  request.targets[0].memoryAuditAt = "2026-10-27T01:00:00Z";
  const audit = structuredClone(request.targets[0].memoryRecords);
  const result = await validateBehaviorSettingsChange(request);
  assert.deepEqual(request.targets[0].memoryRecords, audit);
  assert.deepEqual(
    result.memory[0].preservedNoteIds,
    audit.map((note) => note.id),
  );
  assert.deepEqual(
    result.memory[0].unavailableGuidanceIds,
    audit.map((note) => note.id),
  );
});

Deno.test("changed typed behavior requires coverage of every existing caller", async () => {
  const a = artifactModel("caller-a"), b = artifactModel("caller-b");
  a.behaviors = [{
    ...reuseBehavior("caller-a"),
    targetNativeId: "shared-behavior",
    inputTypeId: "SharedInput",
  }];
  b.behaviors = [{
    ...reuseBehavior("caller-b"),
    targetNativeId: "shared-behavior",
    inputTypeId: "SharedInput",
  }];
  const next = structuredClone(a);
  next.behaviors![0].inputSchema.properties = {
    replacement: { type: "string" },
  };
  next.version.digest = "next";
  const request = input(a, next, "contracts");
  request.before = [scoped(a), scoped(b)];
  request.after = [scoped(next), scoped(b)];
  await assert.rejects(
    () => validateBehaviorSettingsChange(request),
    /outside the coordinated scope: caller-b/,
  );
  request.affectedOperatorIds = ["caller-a", "caller-b"];
  request.targets = [target(a), target(b)];
  await assert.rejects(
    () => validateBehaviorSettingsChange(request),
    /Incompatible executable consumers/,
  );
  const updatedB = structuredClone(b);
  updatedB.behaviors![0].inputSchema = structuredClone(
    next.behaviors![0].inputSchema,
  );
  request.after = [scoped(next), scoped(updatedB)];
  const result = await validateBehaviorSettingsChange(request);
  assert.deepEqual(result.affectedConsumers, ["caller-a", "caller-b"]);
  assert.notDeepEqual(b.behaviors, request.after[1].model.behaviors);
});
