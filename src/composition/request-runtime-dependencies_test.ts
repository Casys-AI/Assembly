import assert from "node:assert/strict";
import {
  artifactModel,
  reuseBehavior,
} from "../../test/support/tool-artifact-fixture.ts";
import type { MemoryStorePort } from "../application/memory/ports/store.ts";
import { createMemoryArtifactSources } from "../../test/support/memory-artifact-sources.ts";
import { skillContentDigest } from "../domain/skills/context-skills.ts";
import type { SkillCatalogRecord } from "../domain/skills/records/catalog.ts";
import type { SkillStorePort } from "../application/skills/ports.ts";
import { AjvSchemaValidator } from "../infrastructure/ajv-schema-validation.ts";
import type { OperatorStorage } from "../adapters/out/postgres/host-storage.ts";
import { DenoToolRunner } from "../adapters/out/sandbox/runner.ts";
import { executionDigest } from "../domain/primitives/execution-digest.ts";
import type {
  MemoryContent,
  MemoryRecord,
} from "../domain/memory/entities/memory-record.ts";
import type { NativeBehaviorContract } from "../domain/model/execution/native-contracts.ts";
import type { BehaviorInvocationRequest } from "../domain/work/execution/modeled-behavior.ts";
import type {
  Message,
  ModelSourceRevision,
  SystemRuntimeState,
} from "../domain/work/dialogue.ts";
import {
  runtimeProvenanceRecord,
  unknownRuntimeProvenance,
} from "../domain/work/value-objects/runtime-provenance.ts";
import {
  RequestRuntimeDependencies,
  type RequestRuntimeDependenciesOptions,
} from "./request-runtime-dependencies.ts";

const ownerId = "same-native-owner";
const at = "2026-10-29T00:00:00Z";
const sourceVersion = `commit:${"a".repeat(40)}`;
const hostScope = { projectId: "host-project", systemId: "host-system" };
const fields = {
  "context-evidence": { messageId: "string", messageDigest: "string" },
  "memory-capture": { id: "string", contentJson: "string" },
  "memory-recall": { id: "string" },
  "memory-review": {
    id: "string",
    expectedRevision: "integer",
    expectedDigest: "string",
    decision: "string",
    reason: "string",
  },
  "skill-list": {},
  "skill-install": { id: "string", url: "string", expectedDigest: "string" },
  "skill-load": { id: "string", expectedDigest: "string" },
  "skill-unload": { id: "string", expectedDigest: "string" },
} as const;
type Kind = keyof typeof fields;

function behavior(kind: Kind): NativeBehaviorContract {
  return {
    id: `${kind}-access`,
    name: kind,
    description: "Scoped local exposure",
    callerNativeId: ownerId,
    targetNativeId: `${kind}-target`,
    targetTypeId: `${kind}-type`,
    inputTypeId: `${kind}-input`,
    sourceIds: [kind],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        Object.entries(fields[kind]).map(([key, type]) => [key, { type }]),
      ),
      required: Object.keys(fields[kind]).filter((key) =>
        !(kind === "memory-recall" && key === "id") &&
        !(kind === "skill-install" && key === "expectedDigest")
      ),
    },
  };
}

function modelFixture() {
  const model = artifactModel(ownerId);
  model.version.repositoryVersion = sourceVersion;
  model.version.digest = "b".repeat(64);
  model.policy.mayProposeSysmlRevision = true;
  const defaultKinds = (Object.keys(fields) as Kind[]).filter((kind) =>
    kind !== "skill-load" && kind !== "skill-unload"
  );
  model.behaviors = defaultKinds.map(behavior);
  model.operatorEntries = defaultKinds.map((kind) => ({
    id: `${kind}-target`,
    kind,
    typeId: `${kind}-type`,
    performerId: ownerId,
    allocationId: `${kind}-allocation`,
    sourceIds: [kind],
  }));
  model.contextPolicy = {
    id: "context-policy",
    revision: 1,
    elementId: "context",
    sourceIds: ["context"],
    kind: "separated-context",
    pattern: "5.1",
    recentMessages: 8,
    maxMessageCharacters: 1000,
    maxCollectionItems: 4,
    maxContextCharacters: 100000,
  };
  model.memoryPolicy = {
    id: "memory-policy",
    revision: 1,
    elementId: "memory",
    sourceIds: ["memory"],
    kind: "governed-memory",
    pattern: "5.2",
    ownerId,
    allowedScopes: ["construction"],
    requireSourceRefs: true,
    requireKnownOutcome: false,
    maxValidityMs: 3_600_000,
    allowSelfAdmission: true,
  };
  model.skillPolicy = {
    id: "skills-policy",
    revision: 1,
    elementId: "skills",
    sourceIds: ["skills"],
    kind: "lazy-skills",
    ownerId,
    allowedHosts: ["example.org"],
    maxSkillBytes: 65536,
    maxInstalledSkills: 8,
    maxLoadedSkills: 4,
    maxLoadedCharacters: 48000,
  };
  return model;
}

function shared(overrides: Partial<RequestRuntimeDependenciesOptions> = {}) {
  const sourceReads: string[] = [],
    overviewReads: Array<string | undefined> = [];
  let revisionVersion = sourceVersion;
  const options: RequestRuntimeDependenciesOptions = {
    hostScope,
    sourceProjectId: "shared-model",
    artifactSourcesForScope: () => {
      throw new Error("No scoped skill source use expected without a seed");
    },
    agents: {
      label: "controlled",
      decide: () => {
        throw new Error("Unexpected agent");
      },
      review: () => {
        throw new Error("Unexpected review");
      },
    },
    runner: new DenoToolRunner(),
    clock: { now: () => at },
    schemaValidator: new AjvSchemaValidator(),
    runtimeProvenance: {
      collect: () => runtimeProvenanceRecord(unknownRuntimeProvenance()),
    },
    modelContext: {
      readSourceRevision(model): Promise<ModelSourceRevision> {
        sourceReads.push(model.version.repositoryVersion!);
        return Promise.resolve({
          version: revisionVersion,
          sources: { "model.sysml": "package Exact {}" },
        });
      },
      toolingQuery: () => Promise.reject(new Error("Unexpected tooling")),
      reader: {
        overview(version) {
          overviewReads.push(version);
          return Promise.resolve({
            version: version!,
            sourceDigest: "source-digest",
            files: [],
            roots: { items: [], total: 0, truncated: false },
            limits: {
              maxPageSize: 40,
              maxSourceBytes: 120000,
              maxInspectSourceBytes: 24000,
            },
            coverage: "bounded-discovery-not-exhaustive-impact" as const,
          });
        },
        query: () => Promise.reject(new Error("Unexpected source query")),
      },
    },
    ...overrides,
  };
  return {
    options,
    factory: new RequestRuntimeDependencies(options),
    sourceReads,
    overviewReads,
    setRevision: (value: string) => {
      revisionVersion = value;
    },
  };
}

function scoped(spaceId: string, model = modelFixture()) {
  const records = new Map<string, MemoryRecord>();
  let memoryReads = 0, skillReads = 0;
  const memory: MemoryStorePort = {
    load(owner, id) {
      assert.equal(owner, ownerId);
      memoryReads++;
      return Promise.resolve(structuredClone(records.get(id) ?? null));
    },
    list(owner) {
      assert.equal(owner, ownerId);
      memoryReads++;
      return Promise.resolve(structuredClone([...records.values()]));
    },
    save(record, expected) {
      assert.equal(record.ownerId, ownerId);
      const prior = records.get(record.id);
      assert.equal(prior?.revision ?? null, expected?.revision ?? null);
      assert.equal(prior?.digest ?? null, expected?.digest ?? null);
      records.set(record.id, structuredClone(record));
      return Promise.resolve();
    },
  };
  const skills: SkillStorePort = {
    load(owner) {
      assert.equal(owner, ownerId);
      skillReads++;
      return Promise.resolve(null);
    },
    save: () => {
      throw new Error("No private skill materialization");
    },
  };
  const stores = {
    scope: { ...hostScope, executionSpaceId: spaceId, operatorId: ownerId },
    memory,
    skills,
  } as unknown as OperatorStorage;
  const caseId = `case-${spaceId}`;
  let snapshot: SystemRuntimeState | undefined = {
    id: `request:${spaceId}:${ownerId}`,
    revision: 0,
    catalogRevision: 0,
    model: structuredClone(model.identity),
    executionModel: structuredClone(model),
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "idle",
    provider: "controlled",
    caseInvocation: { kind: "local", caseId },
    cases: [{
      id: caseId,
      number: 1,
      type: "request",
      objective: "Scoped Request",
      owner: ownerId,
      openedBy: "human",
      openedFrom: { conversationId: `request:${spaceId}:${ownerId}` },
      modelPin: {
        digest: model.version.digest,
        repositoryVersion: sourceVersion,
      },
      status: "open",
      createdAt: at,
    }],
  };
  function message(id: string, role: Message["role"], text: string): Message {
    return {
      id,
      role,
      text,
      at,
      caseId,
      execution: {
        digest: model.version.digest,
        repositoryVersion: sourceVersion,
        actionId: "observed",
        sourceIds: ["native"],
      },
    };
  }
  let invocation = 0;
  function request(
    kind: Kind,
    input: Record<string, unknown>,
  ): BehaviorInvocationRequest {
    return {
      behavior: behavior(kind),
      callerId: ownerId,
      invocationId: `${spaceId}:${++invocation}`,
      modelVersion: {
        digest: model.version.digest,
        repositoryVersion: sourceVersion,
      },
      input,
    };
  }
  return {
    stores,
    model,
    records,
    caseId,
    message,
    request,
    snapshot: () => snapshot,
    replaceSnapshot: (next: SystemRuntimeState | undefined) => {
      snapshot = next;
    },
    memoryReads: () => memoryReads,
    skillReads: () => skillReads,
  };
}

function content(text: string): MemoryContent {
  return {
    text,
    origin: { decisionId: "decision", sourceRefs: ["message:source"] },
    scope: ["construction"],
    validUntil: "2026-10-29T00:30:00Z",
    outcome: { status: "pending" },
  };
}

Deno.test("Request dependencies isolate identical native owners and retain governed memory/skills", async () => {
  const host = shared(), a = scoped("a"), b = scoped("b");
  const da = host.factory.create(a.stores, a.model, a.snapshot);
  const db = host.factory.create(b.stores, b.model, b.snapshot);
  assert.equal(da.runner, host.factory.runner);
  assert.equal(db.runner, da.runner);
  assert.notEqual(da.information, db.information);
  assert.notEqual(da.behaviors, db.behaviors);
  for (const entry of [a, b]) {
    entry.snapshot()!.messages = [
      entry.message("decision", "assistant", "Observed"),
      entry.message("source", "tool", entry.caseId),
    ];
  }
  await da.behaviors!.invoke(
    a.request("memory-capture", {
      id: "note",
      contentJson: JSON.stringify(content("A only")),
    }),
  );
  assert.equal(a.records.get("note")?.content.text, "A only");
  assert.equal(b.records.size, 0);
  const note = a.records.get("note")!;
  await da.behaviors!.invoke(a.request("memory-review", {
    id: note.id,
    expectedRevision: note.revision,
    expectedDigest: note.digest,
    decision: "admit",
    reason: "Verified local evidence",
  }));
  const ai = await da.information!.read(a.model),
    bi = await db.information!.read(b.model);
  assert.equal(ai.memoryGuidance[0]?.content.text, "A only");
  assert.deepEqual(bi.memoryGuidance, []);
  assert.equal(ai.skills!.policy.id, a.model.skillPolicy!.id);
  assert.equal(a.skillReads(), 1);
  assert.equal(b.skillReads(), 1);
  assert.deepEqual(host.overviewReads, [sourceVersion, sourceVersion]);
  assert.deepEqual(host.sourceReads, [sourceVersion, sourceVersion]);
});

Deno.test("Request evidence and memory provenance follow the current live Case snapshot", async () => {
  const host = shared(),
    a = scoped("a"),
    deps = host.factory.create(a.stores, a.model, a.snapshot);
  const source = a.message("source", "tool", "Current A evidence");
  const evidence = a.request("context-evidence", {
    messageId: source.id,
    messageDigest: await executionDigest(source),
  });
  await assert.rejects(() => deps.behaviors!.invoke(evidence));
  const next = structuredClone(a.snapshot()!);
  next.messages = [
    a.message("decision", "assistant", "Current decision"),
    source,
  ];
  a.replaceSnapshot(next);
  const reply = await deps.behaviors!.invoke(evidence);
  assert.equal(
    (reply.result as { message: Message }).message.text,
    source.text,
  );
  await deps.behaviors!.invoke(
    a.request("memory-capture", {
      id: "live",
      contentJson: JSON.stringify(content("Verified now")),
    }),
  );
  next.messages = [];
  a.replaceSnapshot(structuredClone(next));
  await assert.rejects(() =>
    deps.behaviors!.invoke(
      a.request("memory-capture", {
        id: "absent",
        contentJson: JSON.stringify(content("Missing now")),
      }),
    )
  );
  assert.equal(a.records.has("absent"), false);
  const foreignCase = a.message("source", "tool", "Other Case");
  foreignCase.caseId = "another-case";
  next.messages = [a.message("decision", "assistant", "Decision"), foreignCase];
  a.replaceSnapshot(next);
  await assert.rejects(() =>
    deps.behaviors!.invoke(
      a.request("memory-capture", {
        id: "foreign-case",
        contentJson: JSON.stringify(content("Wrong Case")),
      }),
    )
  );
});

Deno.test("Request dependencies reject foreign scopes, callers, pins and sibling snapshots", async () => {
  const host = shared(),
    a = scoped("a"),
    deps = host.factory.create(a.stores, a.model, a.snapshot);
  for (
    const patch of [
      { executionSpaceId: "main" },
      { operatorId: "foreign" },
      { projectId: "foreign" },
      { systemId: "foreign" },
    ]
  ) {
    assert.throws(() =>
      host.factory.create(
        { ...a.stores, scope: { ...a.stores.scope, ...patch } },
        a.model,
        a.snapshot,
      )
    );
  }
  const changed = structuredClone(a.model);
  changed.version.repositoryVersion = `commit:${"c".repeat(40)}`;
  await assert.rejects(() => deps.information!.read(changed));
  for (
    const mutate of [
      (request: BehaviorInvocationRequest) => {
        request.callerId = "foreign";
      },
      (request: BehaviorInvocationRequest) => {
        request.modelVersion.digest = "foreign";
      },
      (request: BehaviorInvocationRequest) => {
        request.modelVersion.repositoryVersion = "foreign";
      },
    ]
  ) {
    const request = a.request("memory-recall", {});
    mutate(request);
    await assert.rejects(() => deps.behaviors!.invoke(request));
  }
  assert.equal(a.memoryReads(), 0);
  a.replaceSnapshot(scoped("b").snapshot());
  await assert.rejects(
    () => deps.information!.read(a.model),
    /another Request/,
  );
});

Deno.test("Request private and workspace actions have no shared Main ports", async () => {
  const host = shared(),
    a = scoped("a"),
    deps = host.factory.create(a.stores, a.model, a.snapshot);
  assert.equal("artifactSources" in deps, false);
  assert.equal("workBudget" in deps, false);
  assert.equal("modelDiagnostics" in deps, false);
  assert.equal(
    await deps.behaviors!.supports(reuseBehavior(ownerId), {
      digest: a.model.version.digest,
      repositoryVersion: sourceVersion,
    }),
    false,
  );
  await assert.rejects(
    () =>
      deps.behaviors!.invoke(
        a.request("skill-install", {
          id: "private",
          url: "https://example.org/SKILL.md",
        }),
      ),
    /Skill download is unavailable/,
  );
  assert.equal(a.skillReads(), 1);
  assert.equal(a.records.size, 0);
});

Deno.test("Request information refuses absent live state and an inexact source reader", async () => {
  const host = shared(),
    a = scoped("a"),
    deps = host.factory.create(a.stores, a.model, a.snapshot);
  const snapshot = a.snapshot();
  a.replaceSnapshot(undefined);
  await assert.rejects(
    () => deps.information!.read(a.model),
    /Live Request information/,
  );
  a.replaceSnapshot(snapshot);
  host.setRevision(`commit:${"d".repeat(40)}`);
  await assert.rejects(
    () => deps.information!.read(a.model),
    /another Request revision/,
  );
  assert.deepEqual(host.overviewReads, []);
});

Deno.test("Request factory pairs one bundle reader with inspection and explicit scoped initial skill preparation", async () => {
  const content = "# Scoped bundle\nExact Request instructions.\n";
  const model = modelFixture();
  const digest = await skillContentDigest(content);
  model.initialSkills = [{
    nativeId: "initial-skill",
    id: "assembly-modeling",
    source: "bundle:assembly-modeling",
    digest,
    loaded: true,
    sourceIds: ["initial-skill"],
  }];
  for (const kind of ["skill-load", "skill-unload"] as const) {
    model.behaviors!.push(behavior(kind));
    model.operatorEntries!.push({
      id: `${kind}-target`,
      kind,
      typeId: `${kind}-type`,
      performerId: ownerId,
      allocationId: `${kind}-allocation`,
      sourceIds: [kind],
    });
  }
  const requestedScopes: string[] = [];
  const sources = new Map<
    string,
    ReturnType<typeof createMemoryArtifactSources>
  >();
  let bundleReads = 0;
  const readBundledSkill = (source: string, maximumBytes: number) => {
    assert.equal(source, model.initialSkills![0]!.source);
    assert.equal(maximumBytes, model.skillPolicy!.maxSkillBytes);
    bundleReads++;
    return Promise.resolve(content);
  };
  const host = shared({
    readBundledSkill,
    artifactSourcesForScope(scope) {
      assert.deepEqual({
        projectId: scope.projectId,
        systemId: scope.systemId,
        operatorId: scope.operatorId,
      }, { ...hostScope, operatorId: ownerId });
      assert.notEqual(scope.executionSpaceId, "main");
      requestedScopes.push(scope.executionSpaceId);
      let service = sources.get(scope.executionSpaceId);
      if (!service) {
        service = createMemoryArtifactSources();
        sources.set(scope.executionSpaceId, service);
      }
      return Promise.resolve({
        publishSkill: service.publishSkill.bind(service),
        resolveSkill: service.resolveSkill.bind(service),
      });
    },
  });
  assert.equal(host.factory.readBundledSkill, readBundledSkill);
  assert.deepEqual(await host.factory.inspectInitialSkills(model), {
    supported: true,
    issues: [],
  });
  assert.equal(requestedScopes.length, 0);
  const entries = [
    scoped("a", structuredClone(model)),
    scoped("b", structuredClone(model)),
  ];
  const catalogs = new Map<string, SkillCatalogRecord>();
  const scopedStores = new Map<string, OperatorStorage>();
  for (const entry of entries) {
    const skills: SkillStorePort = {
      load: () =>
        Promise.resolve(structuredClone(catalogs.get(entry.caseId) ?? null)),
      save(record, expected) {
        assert.equal(catalogs.get(entry.caseId)?.revision ?? null, expected);
        catalogs.set(entry.caseId, structuredClone(record));
        return Promise.resolve();
      },
    };
    scopedStores.set(
      entry.caseId,
      { ...entry.stores, skills } as unknown as OperatorStorage,
    );
  }
  const [a, b] = entries;
  const da = host.factory.create(
    scopedStores.get(a.caseId)!,
    a.model,
    a.snapshot,
  );
  const db = host.factory.create(
    scopedStores.get(b.caseId)!,
    b.model,
    b.snapshot,
  );
  assert(da.initialSkills && db.initialSkills);
  assert.equal(requestedScopes.length, 0);
  assert.equal(catalogs.size, 0, "Constructing dependencies remains inert");
  await da.initialSkills.initialize();
  await db.initialSkills.initialize();
  assert.equal(catalogs.get(a.caseId)!.operations.length, 1);
  assert.equal(catalogs.get(b.caseId)!.operations.length, 1);
  assert.equal(
    (await da.information!.read(a.model)).skills!.loaded[0]!.content,
    content,
  );
  assert.equal(
    (await db.information!.read(b.model)).skills!.loaded[0]!.content,
    content,
  );
  assert(
    new Set(requestedScopes).has("a") && new Set(requestedScopes).has("b"),
  );
  await da.behaviors!.invoke(
    a.request("skill-unload", {
      id: "assembly-modeling",
      expectedDigest: digest,
    }),
  );
  const restored = new RequestRuntimeDependencies(host.options).create(
    scopedStores.get(a.caseId)!,
    a.model,
    a.snapshot,
  );
  await restored.initialSkills!.initialize();
  assert.deepEqual(
    (await restored.information!.read(a.model)).skills!.loaded,
    [],
  );
  assert.equal(
    (await db.information!.read(b.model)).skills!.loaded[0]!.content,
    content,
  );
  assert.equal(
    catalogs.get(a.caseId)!.operations.length,
    2,
    "Restoration does not reinstall or reload an unloaded seed",
  );
  assert.equal(catalogs.get(b.caseId)!.operations.length, 1);
  assert(bundleReads > 0);
  assert.equal("artifactSources" in da, false);
  // In-memory source adapters above verify scope selection/behavior wiring only;
  // durable binding/repository isolation remains the real PG/Git witness's gate.
});

Deno.test("Request initial skill preparation refuses missing live birth or unsupported exact bundle before scoped source use", async () => {
  const content = "# Exact seed\n";
  const model = modelFixture();
  model.initialSkills = [{
    nativeId: "initial",
    id: "initial",
    source: "bundle:assembly-modeling",
    digest: await skillContentDigest(content),
    loaded: false,
    sourceIds: ["initial"],
  }];
  let sourceUses = 0;
  const host = shared({
    readBundledSkill: () => Promise.resolve(`${content}changed`),
    artifactSourcesForScope: () => {
      sourceUses++;
      throw new Error("No source use permitted");
    },
  });
  const a = scoped("a", model),
    deps = host.factory.create(a.stores, a.model, a.snapshot);
  assert(deps.initialSkills);
  const birth = a.snapshot();
  a.replaceSnapshot(undefined);
  await assert.rejects(
    () => deps.initialSkills!.initialize(),
    /Live Request skill initialization/,
  );
  a.replaceSnapshot(birth);
  assert.deepEqual(await host.factory.inspectInitialSkills(model), {
    supported: false,
    issues: ["INITIAL_SKILL_CONTENT_DIFFERS"],
  });
  await assert.rejects(
    () => deps.initialSkills!.initialize(),
    /INITIAL_SKILL_CONTENT_DIFFERS/,
  );
  assert.equal(sourceUses, 0);
});
