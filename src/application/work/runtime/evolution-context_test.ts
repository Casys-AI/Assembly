import assert from "node:assert/strict";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import { SystemRuntime } from "../../../../test/support/system-runtime.ts";
import { unexpectedModelAuthoring } from "../../../../test/support/model-authoring.ts";
import type { SystemRuntimeState } from "./state.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { ScopedExecutableModel } from "../../../domain/model/evolution/semantic-effects.ts";
import type { DecisionInformation } from "../context/information-ports.ts";
import { assembleCandidateDecisionContext } from "../conversation/decision-context.ts";
import { mainCreationScope } from "../../../domain/governance/policies/operator-creation-policy.ts";
import { validateBehaviorSettingsChange } from "./behavior-settings-validation.ts";
import {
  memoryGuidance,
  memoryView,
} from "../../../domain/memory/governed-memory-promotion.ts";
import type { MemoryRecord } from "../../../domain/memory/entities/memory-record.ts";

const now = "2026-10-27T05:00:00.000Z";
function scoped(model: ExecutableModel): ScopedExecutableModel {
  return {
    systemQualifiedName: model.identity.systemId,
    model,
    evidence: { digestInputs: [], sourceFacts: {}, sourceCategories: {} },
  };
}
async function fixture(memoryRecords?: MemoryRecord[]) {
  const model = artifactModel("operator");
  model.policy.mayProposeSysmlRevision = true;
  model.operator = {
    name: "Admitted operator",
    instruction: "Old instruction",
    primary: true,
    humanInput: true,
  };
  model.contextPolicy = {
    id: "context",
    revision: 1,
    elementId: "context",
    sourceIds: [],
    kind: "separated-context",
    pattern: "5.1",
    recentMessages: 4,
    maxMessageCharacters: 4096,
    maxCollectionItems: 16,
    maxContextCharacters: 100000,
  };
  model.skillPolicy = {
    id: "skills",
    revision: 1,
    elementId: "skills",
    sourceIds: [],
    kind: "lazy-skills",
    ownerId: "operator",
    allowedHosts: [],
    maxSkillBytes: 20000,
    maxInstalledSkills: 4,
    maxLoadedSkills: 2,
    maxLoadedCharacters: 20000,
  };
  model.behaviors = [{
    id: "registered-behavior",
    name: "Read local metadata",
    description: "Existing declared exposure",
    callerNativeId: "operator",
    targetNativeId: "registered-target",
    targetTypeId: "Fixture::Metadata",
    inputTypeId: "Fixture::Input",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
    sourceIds: ["registered-behavior"],
  }];
  if (memoryRecords) {
    model.memoryPolicy = {
      id: "memory",
      revision: 1,
      elementId: "memory",
      sourceIds: [],
      kind: "governed-memory",
      pattern: "5.2",
      ownerId: "operator",
      allowedScopes: ["local"],
      requireKnownOutcome: false,
      requireSourceRefs: true,
      maxValidityMs: 10000000,
      allowSelfAdmission: false,
    };
    model.operatorEntries = [{
      id: "memory-target",
      kind: "memory-recall",
      performerId: "operator",
      typeId: "Fixture::Recall",
      allocationId: "allocation",
      sourceIds: [],
    }];
    model.behaviors.push({
      id: "recall",
      name: "Recall",
      description: "Actual current read permission",
      callerNativeId: "operator",
      targetNativeId: "memory-target",
      targetTypeId: "Fixture::Recall",
      inputTypeId: "Fixture::RecallInput",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" } },
        required: [],
      },
      sourceIds: [],
    });
  }
  const source = "package Retained { // actual loaded bytes\n" +
    "// retained source and evidence\n".repeat(300) + "}";
  const pin = {
    digest: model.version.digest,
    repositoryVersion: model.version.repositoryVersion!,
  };
  const info: DecisionInformation = {
    memoryGuidance: (memoryRecords ?? []).filter((record) =>
      record.content.scope.every((scope) =>
        model.memoryPolicy!.allowedScopes.includes(scope)
      )
    ).map((record) =>
      memoryView(
        record,
        now,
        model.memoryPolicy
          ? { ...model.memoryPolicy, modelVersion: pin, permissions: {} }
          : undefined,
      )
    ).filter((view) => view.usableAsGuidance).map(memoryGuidance),
    modelContext: {
      version: pin.repositoryVersion,
      sourceDigest: "source-digest",
      files: [{
        path: "retained.sysml",
        sha256: "a".repeat(64),
        byteLength: source.length,
        characters: source.length,
      }],
      roots: { items: [], total: 0, truncated: false },
      coverage: "bounded-discovery-not-exhaustive-impact",
      limits: {
        maxPageSize: 50,
        maxSourceBytes: 20000,
        maxInspectSourceBytes: 10000,
      },
      loadedSources: [{ path: "retained.sysml", characters: source.length }],
      maxLoadedCharacters: 20000,
    },
    modelSources: {
      version: pin.repositoryVersion,
      sources: { "retained.sysml": source },
    },
    skills: {
      policy: { ...model.skillPolicy },
      catalog: [],
      loaded: [{
        id: "loaded",
        name: "Loaded",
        description: "Actual loaded instructions",
        digest: "b".repeat(64),
        byteLength: 6000,
        content: "Keep this exact loaded instruction. ".repeat(150),
        source: {
          kind: "bundled",
          location: "bundle:loaded",
          acquiredAt: now,
          modelVersion: pin,
        },
        installedAt: now,
        loaded: true,
        loadedAt: now,
        loadedBy: pin,
      }],
    },
  };
  const reads: string[] = [],
    supportReads: string[] = [],
    sourceReads: Array<string | undefined> = [];
  let saved: SystemRuntimeState | null = null;
  const runtime = new SystemRuntime({
    model: {
      ...unexpectedModelAuthoring,
      initialize: () => Promise.resolve(model.identity),
      readExecutableModel: (_identity, repositoryVersion) => {
        sourceReads.push(repositoryVersion);
        assert.ok(
          repositoryVersion === undefined ||
            repositoryVersion === pin.repositoryVersion,
        );
        return Promise.resolve(structuredClone(model));
      },
      applyApprovedChange: () => {
        throw new Error("No publication");
      },
      activateCandidate: () => {
        throw new Error("No activation");
      },
      graph: () => Promise.resolve({}),
    },
    store: {
      load: () => Promise.resolve(structuredClone(saved)),
      save: (state, expected) => {
        assert.equal(saved?.revision ?? null, expected);
        saved = structuredClone(state);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    },
    information: {
      consultModel: () => {
        throw new Error("Preflight cannot consult");
      },
      read: (current) => {
        reads.push(current.version.digest);
        assert.equal(
          current.version.digest,
          pin.digest,
          "Unadopted candidates cannot use the information reader",
        );
        return Promise.resolve(structuredClone(info));
      },
    },
    behaviors: {
      supports: (_behavior, version) => {
        supportReads.push(version.digest);
        assert.equal(version.digest, pin.digest);
        return Promise.resolve(true);
      },
      invoke: () => {
        throw new Error("No invocation");
      },
    },
    agents: {
      label: "Scripted fixture",
      decide: () =>
        Promise.resolve({ kind: "reply", text: "Actual completed response" }),
      review: () => {
        throw new Error("No review");
      },
    },
    runner: {
      test: () => {
        throw new Error("No test");
      },
      run: () => {
        throw new Error("No effect");
      },
    },
  });
  await runtime.initialize();
  await runtime.submit("Human task with actual retained context");
  await runtime.idle();
  assert.equal(runtime.snapshot.error, undefined);
  reads.length = 0;
  supportReads.length = 0;
  sourceReads.length = 0;
  return { runtime, model, info, pin, reads, supportReads, sourceReads };
}

Deno.test("evolution reads only the real admitted context before pure complete candidate assembly", async () => {
  const f = await fixture();
  const candidate = structuredClone(f.model);
  candidate.version.digest = "unadopted-candidate";
  candidate.version.repositoryVersion = "proposal:unpublished";
  candidate.operator!.instruction = "Exact new candidate instruction";
  candidate.policy.maxAgentDecisions++;
  candidate.configuration.revision++;
  candidate.contextPolicy!.maxMessageCharacters = 1024;
  candidate.behaviors![0].inputSchema = {
    type: "object",
    additionalProperties: false,
    properties: { query: { type: "string" } },
    required: ["query"],
  };
  const snapshot = f.runtime.snapshot;
  const target = await f.runtime.evolutionValidationTarget(candidate);
  assert.deepEqual(f.reads, [f.pin.digest]);
  assert.ok(f.supportReads.every((pin) => pin === f.pin.digest));
  assert.deepEqual(f.sourceReads, [f.pin.repositoryVersion]);
  assert.deepEqual(f.runtime.snapshot, snapshot);
  const context = assembleCandidateDecisionContext(
    target.admittedDecisionContext!,
    f.model,
    candidate,
    target.snapshot,
    mainCreationScope(f.model.identity),
  );
  assert.equal(context.operator!.instruction, candidate.operator!.instruction);
  assert.deepEqual(context.executionPolicy, candidate.policy);
  assert.deepEqual(
    context.configuration!.revision,
    candidate.configuration.revision,
  );
  assert.deepEqual(context.contracts, candidate.contracts);
  assert.deepEqual(context.modeledBehaviors, candidate.behaviors);
  assert.deepEqual(context.modelVersion, {
    digest: candidate.version.digest,
    repositoryVersion: candidate.version.repositoryVersion,
  });
  assert.deepEqual(context.admittedModelVersion, context.modelVersion);
  assert.deepEqual(context.modelSources, f.info.modelSources);
  assert.deepEqual(context.modelContext, f.info.modelContext);
  assert.deepEqual(context.skills, f.info.skills);
  assert.deepEqual(context.messages, snapshot.messages);
  const request = {
    before: [scoped(f.model)],
    after: [scoped(candidate)],
    effects: [{
      targetNativeId: "operator",
      systemQualifiedName: f.model.identity.systemId,
      category: "instructions" as const,
      before: f.model.operator,
      after: candidate.operator,
    }],
    affectedOperatorIds: ["operator"],
    targets: [target],
  };
  const result = await validateBehaviorSettingsChange(request);
  assert.ok(result.context[0].projectedCharacters > 14000);
  assert.deepEqual(f.reads, [f.pin.digest]);
  candidate.contextPolicy!.maxContextCharacters = 4096;
  await assert.rejects(
    () => validateBehaviorSettingsChange(request),
    /required decision context/,
  );
  assert.deepEqual(f.reads, [f.pin.digest]);
});

function note(
  id: string,
  scope = "local",
  status: MemoryRecord["status"] = "admitted",
): MemoryRecord {
  return {
    id,
    ownerId: "operator",
    contributorId: "operator",
    revision: 1,
    digest: "note-digest",
    createdAt: now,
    updatedAt: now,
    status,
    content: {
      text: `Exact retained ${id}`,
      origin: { decisionId: "decision", sourceRefs: ["message:source"] },
      scope: [scope],
      validUntil: "2026-10-28T00:00:00.000Z",
      outcome: { status: "pending" },
    },
    history: [],
  };
}
Deno.test("candidate memory usability uses retained notes and current recall scope without admissions or mutations", async () => {
  const records = [
    note("admitted"),
    note("candidate", "local", "candidate"),
    note("hidden", "secret"),
  ];
  const retained = structuredClone(records);
  const f = await fixture(records);
  const candidate = structuredClone(f.model);
  candidate.version.digest = "memory-candidate";
  candidate.version.repositoryVersion = "proposal:memory";
  candidate.memoryPolicy!.requireKnownOutcome = true;
  const target = await f.runtime.evolutionValidationTarget(candidate);
  const audit = { memoryRecords: records, memoryAuditAt: now };
  const context = assembleCandidateDecisionContext(
    target.admittedDecisionContext!,
    f.model,
    candidate,
    target.snapshot,
    mainCreationScope(f.model.identity),
    audit,
  );
  assert.deepEqual(context.memoryGuidance, []);
  assert.deepEqual(records, retained);
  assert.deepEqual(f.reads, [f.pin.digest]);
  candidate.memoryPolicy!.requireKnownOutcome = false;
  candidate.memoryPolicy!.allowedScopes.push("secret");
  assert.throws(
    () =>
      assembleCandidateDecisionContext(
        target.admittedDecisionContext!,
        f.model,
        candidate,
        target.snapshot,
        mainCreationScope(f.model.identity),
        audit,
      ),
    /current admitted recall scope/,
  );
  assert.deepEqual(records, retained);
  const unavailable = structuredClone(target.admittedDecisionContext!);
  unavailable.modeledBehaviors = [];
  assert.throws(
    () =>
      assembleCandidateDecisionContext(
        unavailable,
        f.model,
        candidate,
        target.snapshot,
        mainCreationScope(f.model.identity),
        audit,
      ),
    /current memory recall permission/,
  );
  assert.throws(
    () =>
      assembleCandidateDecisionContext(
        target.admittedDecisionContext!,
        f.model,
        candidate,
        target.snapshot,
        mainCreationScope(f.model.identity),
      ),
    /retained host audit/,
  );
  const noRecallModel = structuredClone(f.model);
  noRecallModel.behaviors = noRecallModel.behaviors!.filter((behavior) =>
    behavior.id !== "recall"
  );
  noRecallModel.operatorEntries = [];
  const noRecallCandidate = structuredClone(candidate);
  noRecallCandidate.behaviors = structuredClone(noRecallModel.behaviors);
  noRecallCandidate.operatorEntries = [];
  const noRecallPayload = structuredClone(target.admittedDecisionContext!);
  noRecallPayload.modeledBehaviors = structuredClone(noRecallModel.behaviors);
  noRecallPayload.memoryGuidance = [];
  const noRecallSnapshot = structuredClone(target.snapshot);
  noRecallSnapshot.executionModel = noRecallModel;
  assert.deepEqual(
    assembleCandidateDecisionContext(
      noRecallPayload,
      noRecallModel,
      noRecallCandidate,
      noRecallSnapshot,
      mainCreationScope(noRecallModel.identity),
      audit,
    ).memoryGuidance,
    [],
  );
  assert.deepEqual(records, retained);
});
