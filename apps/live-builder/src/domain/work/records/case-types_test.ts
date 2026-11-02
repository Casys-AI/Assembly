import assert from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { caseTypesForModel } from "./case-types.ts";

function legacyModel() {
  return executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "builder",
  });
}

Deno.test("implicit Request derives the admitted 1.3 contract without rewriting it", () => {
  const model = legacyModel();
  model.version.repositoryVersion = "historical-version";
  const original = structuredClone(model);
  const [request] = caseTypesForModel(model);
  assert.equal(request.id, "system:request");
  assert.equal(request.type, "request");
  assert.equal(request.envelope, "conversational");
  assert.equal(request.ownerId, model.identity.builderId);
  assert.equal(request.behaviorId, model.flows.conversation.rootNativeId);
  assert.equal(request.maxInvocations, undefined);
  request.sourceIds.push("runtime-only");
  assert.deepEqual(model, original);
  assert.equal(Object.hasOwn(model, "caseTypes"), false);
});

Deno.test("implicit Request retains a legacy invocation ceiling including zero", () => {
  const model = legacyModel();
  model.workBudgetPolicy = {
    id: "budget",
    revision: 1,
    elementId: "budget-policy",
    sourceIds: ["budget-policy"],
    unit: "agent-invocation",
    limit: 0,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
  };
  assert.equal(caseTypesForModel(model)[0].maxInvocations, 0);
  model.workBudgetPolicy.limit = 12;
  assert.equal(caseTypesForModel(model)[0].maxInvocations, 12);
});

Deno.test("explicit CaseTypes replace the implicit Request and are isolated copies", () => {
  const model = legacyModel();
  model.caseTypes = [{
    id: "watch-type",
    name: "Watch",
    type: "watch",
    envelope: "reassessment",
    behaviorId: "watch-behavior",
    ownerId: "builder",
    sourceIds: ["watch-type"],
  }];
  const types = caseTypesForModel(model);
  assert.deepEqual(types, model.caseTypes);
  assert.equal(types.some((type) => type.type === "request"), false);
  types[0].sourceIds.push("runtime-only");
  assert.deepEqual(model.caseTypes[0].sourceIds, ["watch-type"]);
});

Deno.test("adding only a scheduled declaration retains the central Request conversation", () => {
  const model = legacyModel();
  model.caseTypes = [{
    id: "job-type",
    name: "Morning summary",
    type: "job",
    envelope: "deterministic",
    behaviorId: model.flows.conversation.rootNativeId,
    ownerId: "builder",
    schedule: { kind: "daily-at", hour: 8, minute: 0 },
    sourceIds: ["job-type"],
  }];
  const original = structuredClone(model);
  assert.deepEqual(caseTypesForModel(model).map((type) => type.type), [
    "job",
    "request",
  ]);
  assert.deepEqual(model, original);
});

Deno.test("a new team-only contract never acquires an implicit independent Request", () => {
  const model = legacyModel();
  model.operatorTeam = {
    parentOperatorId: "parent",
    requestOwnerId: "root-owner",
    requestId: "root-request",
  };
  model.caseTypes = [];
  assert.deepEqual(caseTypesForModel(model), []);
});
