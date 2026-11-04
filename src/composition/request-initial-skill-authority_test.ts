import assert from "node:assert/strict";
import { artifactModel } from "../../test/support/tool-artifact-fixture.ts";
import { ContextSkillsService } from "../application/skills/context-skills.ts";
import { ArtifactSourceService } from "../application/work/artifacts/publication.ts";
import { createRequestCase } from "../application/work/cases/runtime.ts";
import type { NativeBehaviorContract } from "../domain/model/execution/native-contracts.ts";
import {
  skillContentDigest,
  SkillError,
} from "../domain/skills/context-skills.ts";
import type { QueuedArtifactSourcePublication } from "../domain/work/artifacts/source-publication.ts";
import { SkillsBehavior } from "../application/skills/behavior.ts";
import {
  assertRequestInitialSkillPublication,
  type RequestInitialSkillPublicationContext,
} from "../application/skills/request-initial-skills.ts";

const ownerId = "request-operator";
const text =
  "# Request instructions\nExact source-selected bundled instructions.\n";
const kinds = [
  "skill-install",
  "skill-list",
  "skill-load",
  "skill-unload",
] as const;

function behavior(kind: typeof kinds[number]): NativeBehaviorContract {
  const fields = kind === "skill-list"
    ? []
    : kind === "skill-install"
    ? ["id", "url", "expectedDigest"]
    : ["id", "expectedDigest"];
  return {
    id: `${kind}-access`,
    name: kind,
    description: "Source-owned skill access",
    callerNativeId: ownerId,
    targetNativeId: `${kind}-target`,
    targetTypeId: `${kind}-type`,
    inputTypeId: `${kind}-input`,
    sourceIds: [`${kind}-source`],
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        fields.map((name) => [name, { type: "string" }]),
      ),
      required: fields.filter((field) =>
        kind !== "skill-install" || field !== "expectedDigest"
      ),
      additionalProperties: false,
    },
  };
}

async function fixture() {
  const model = artifactModel(ownerId);
  model.identity.projectId = "git:repository";
  model.version.digest = "b".repeat(64);
  model.version.repositoryVersion = `commit:${"a".repeat(40)}`;
  model.behaviors = kinds.map(behavior);
  model.operatorEntries = kinds.map((kind) => ({
    id: `${kind}-target`,
    kind,
    typeId: `${kind}-type`,
    performerId: "admitted-performer",
    allocationId: `${kind}-allocation`,
    sourceIds: [`${kind}-source`],
  }));
  model.skillPolicy = {
    kind: "lazy-skills",
    id: "scoped-skills",
    revision: 1,
    elementId: "skills-policy",
    sourceIds: ["skills-policy"],
    ownerId,
    allowedHosts: [],
    maxSkillBytes: 65536,
    maxInstalledSkills: 8,
    maxLoadedSkills: 4,
    maxLoadedCharacters: 48000,
  };
  model.initialSkills = [{
    nativeId: "initial-assembly-skill",
    id: "assembly-modeling",
    source: "bundle:assembly-modeling",
    digest: await skillContentDigest(text),
    loaded: true,
    sourceIds: ["initial-assembly-skill"],
  }];
  model.caseTypes = [{
    id: "request-type",
    name: "Request",
    type: "request",
    envelope: "conversational",
    behaviorId: model.flows.conversation.rootNativeId,
    ownerId,
    sourceIds: ["request-type"],
  }];
  const scope = {
    projectId: "host-project",
    systemId: "host-system",
    executionSpaceId: "request-a",
    operatorId: ownerId,
  };
  const birth = {
    runtimeId: `request:${scope.executionSpaceId}:${ownerId}`,
    openingId: "opening-a",
    caseId: "case-a",
    caseNumber: 1,
    caseTypeId: "request-type",
    initialContributionId: "input-a",
    createdAt: "2026-10-29T00:00:00Z",
    openedBy: "modeled-local-owner",
    text: "Own Request input",
  };
  const context: RequestInitialSkillPublicationContext = {
    scope,
    birth,
    model,
    source: {
      repositoryId: "repository",
      projectId: model.identity.projectId,
      version: model.version.repositoryVersion,
      sourceDigest: "c".repeat(64),
    },
    state: {
      id: birth.runtimeId,
      revision: 0,
      catalogRevision: 0,
      model: structuredClone(model.identity),
      executionModel: structuredClone(model),
      messages: [],
      candidates: [],
      cases: [],
      events: [],
      busy: false,
      phase: "ready",
      provider: "controlled",
    },
  };
  createRequestCase(
    context.state,
    {
      id: birth.caseId,
      caseTypeId: birth.caseTypeId,
      objective: birth.text,
      openedBy: birth.openedBy,
      openedFrom: {
        conversationId: birth.runtimeId,
        openingId: birth.openingId,
        messageId: birth.initialContributionId,
      },
    },
    { now: () => birth.createdAt },
    birth.caseNumber,
  );
  let currentModel = structuredClone(model);
  let bundleReads = 0, currentChecks = 0, writes = 0;
  const readBundledSkill = (source: string, maximumBytes: number) => {
    assert.equal(source, "bundle:assembly-modeling");
    assert.equal(maximumBytes, model.skillPolicy!.maxSkillBytes);
    bundleReads++;
    return Promise.resolve(text);
  };
  const forbidden = () => {
    throw new Error("Read-only fixture invoked a write/storage port");
  };
  let captured: QueuedArtifactSourcePublication | undefined;
  // Capture the real service's publication envelope before any retention write.
  // This fixture makes no claim of Git/SQL qualification.
  const sources = new ArtifactSourceService({
    scope,
    repositoryId: context.source.repositoryId,
    sourceScopeId: "source-scope",
    sourceHeader: () =>
      Promise.resolve({
        version: context.source.version,
        sourceDigest: context.source.sourceDigest,
      }),
    repository: {
      retain: forbidden,
      read: forbidden,
      findByCommand: forbidden,
    },
    bindings: { bind: forbidden, read: forbidden },
    queuedPublisher: {
      publish(publication) {
        captured = structuredClone(publication);
        return Promise.reject(
          new SkillError(
            "forbidden",
            "Fixture captured the production publication",
          ),
        );
      },
    },
  });
  const service: ContextSkillsService = new ContextSkillsService({
    now: () => birth.createdAt,
    store: {
      load: () => Promise.resolve(null),
      save: () => {
        writes++;
        return forbidden();
      },
    },
    download: { download: forbidden },
    artifactSources: () => Promise.resolve(sources),
    assertCurrentAuthority: (authority, permission) =>
      skills.assertCurrentAuthority(authority, permission),
  });
  const skills: SkillsBehavior = new SkillsBehavior({
    entries: new Map(
      model.operatorEntries.map((
        entry,
      ) => [entry.id, { ownerId, kind: entry.kind }]),
    ),
    resolveCallerModel: (callerId, version) =>
      Promise.resolve(
        callerId === ownerId &&
          version.digest === currentModel.version.digest &&
          version.repositoryVersion === currentModel.version.repositoryVersion
          ? structuredClone(currentModel)
          : null,
      ),
    skills: () => Promise.resolve(service),
    readBundledSkill,
  });
  await assert.rejects(() => skills.initialize(model), /Fixture captured/);
  assert(captured);
  return {
    model,
    context,
    publication: captured,
    readBundledSkill,
    validation: {
      readBundledSkill,
      assertCurrentAuthority(authority, permission) {
        currentChecks++;
        return skills.assertCurrentAuthority(authority, permission);
      },
    } satisfies Parameters<typeof assertRequestInitialSkillPublication>[2],
    setCurrent(next: typeof model) {
      currentModel = structuredClone(next);
    },
    counts: () => ({ bundleReads, currentChecks, writes }),
  };
}

import { RequestInitialSkillAuthority } from "../application/work/request-spaces/request-initial-skill-authority.ts";
import { createRequestInitialSkillRuntimeReader } from "../adapters/out/postgres/request-initial-skill-runtime-reader.ts";
import type { PostgresHostStorage } from "../adapters/out/postgres/host-storage.ts";
import type { OpeningRecord } from "../domain/work/request-spaces/opening.ts";
import { requestSpaceDigest } from "../domain/work/request-spaces/scope.ts";
import { savedManifest } from "../domain/work/records/saved-systems.ts";
import { encodeRuntimeSnapshotPayload } from "../adapters/out/postgres/runtime-snapshot-codec.ts";

async function durableFixture() {
  const f = await fixture();
  const { scope, birth, model, source } = f.context;
  const manifest = savedManifest({
    origin: {
      projectId: scope.projectId,
      systemId: scope.systemId,
      executionSpaceId: "main",
    },
    source: {
      branch: { kind: "main" },
      sourceVersion: source.version,
      repositoryId: source.repositoryId,
      branchRef: "refs/heads/admitted",
      admittedHeadVersion: source.version,
      sourceDigest: source.sourceDigest,
    },
    registeredOperatorIds: [scope.operatorId],
    operators: [{
      operatorId: scope.operatorId,
      repositoryVersion: source.version,
      modelDigest: model.version.digest,
      sourceDigest: source.sourceDigest,
      settingsDigest: "settings",
      build: null,
      tools: [],
    }],
    prerequisites: [],
  });
  const base = {
    sourceKind: "current-main" as const,
    manifest,
    manifestDigest: await requestSpaceDigest(manifest),
    requestOwner: {
      operatorId: scope.operatorId,
      caseTypeId: birth.caseTypeId,
    },
  };
  const command = {
    openingKey: "key",
    text: birth.text,
    source: { kind: "current-main" as const },
  };
  const host = { projectId: scope.projectId, systemId: scope.systemId };
  const record: OpeningRecord = {
    id: birth.openingId,
    scope: host,
    ownerId: birth.openedBy,
    command,
    commandDigest: await requestSpaceDigest({
      scope: host,
      ownerId: birth.openedBy,
      command,
    }),
    caseId: birth.caseId,
    caseNumber: birth.caseNumber,
    executionSpaceId: scope.executionSpaceId,
    branchId: "request-branch",
    initialContributionId: birth.initialContributionId,
    base,
    baseDigest: await requestSpaceDigest(base),
    phase: "branch-ready",
    admissionId: null,
    revision: 2,
    issues: [],
    createdAt: birth.createdAt,
  };
  let currentRecord: OpeningRecord | null = record;
  let state: typeof f.context.state | null = structuredClone(f.context.state);
  let closed = false, stateReads = 0, writes = 0, verifiedModelReads = 0;
  let sourceAvailable = true,
    relationAvailable = true,
    branchRetainsBase = true,
    originRelationReads = 0;
  const forbidden = () => {
    writes++;
    throw new Error("Durable authority entered a store/provision/write port");
  };
  const storage = {
    scope: host,
    caseSpace: forbidden,
    operator: forbidden,
    client: {
      executionSpace: {
        findUnique: () =>
          Promise.resolve({
            ...host,
            executionSpaceId: scope.executionSpaceId,
            parentExecutionSpaceId: "main",
            caseId: birth.caseId,
            lifecycle: closed ? "closed" : "active",
            closedAt: closed ? new Date() : null,
            case: { ...host, caseId: birth.caseId },
          }),
      },
      runtimeState: {
        findFirst: () => {
          stateReads++;
          return Promise.resolve(
            state
              ? {
                revision: BigInt(state.revision),
                payload: encodeRuntimeSnapshotPayload(JSON.stringify(state)),
              }
              : null,
          );
        },
      },
    },
  } as unknown as PostgresHostStorage;
  const authority = new RequestInitialSkillAuthority({
    runtime: createRequestInitialSkillRuntimeReader(storage),
    openings: {
      begin: forbidden,
      selectBase: forbidden,
      advance: forbidden,
      issue: forbidden,
      get: forbidden,
      forCase: (caseId) => {
        assert.equal(caseId, birth.caseId);
        return Promise.resolve(structuredClone(currentRecord));
      },
    },
    sourceProvenance: {
      assertOriginRelation() {
        originRelationReads++;
        if (!relationAvailable) {
          throw new Error("Current origin relation unavailable");
        }
        return Promise.resolve();
      },
    },
    source: {
      resolve: forbidden,
      readModelsForInspection: forbidden,
      verify() {
        throw new Error(
          "Verified model read must not be preceded by duplicate verification",
        );
      },
      readModels() {
        verifiedModelReads++;
        if (!sourceAvailable) {
          throw new Error("Verified retained source is unavailable");
        }
        return Promise.resolve([structuredClone(model)]);
      },
    },
    branches: {
      ensure: forbidden,
      assertRetainedExecutionVersion: () => Promise.resolve(),
      assertVersion: (_record: OpeningRecord, version: string) =>
        branchRetainsBase && version === source.version
          ? Promise.resolve()
          : Promise.reject(new Error("Request retained base unavailable")),
      sourceVersion: () => Promise.resolve(`commit:${"e".repeat(40)}`),
    },
    readBundledSkill: f.readBundledSkill,
  });
  return {
    f,
    authority,
    record,
    counts: () => ({
      stateReads,
      writes,
      verifiedModelReads,
      originRelationReads,
    }),
    branchRetainsBase(value: boolean) {
      branchRetainsBase = value;
    },
    relationAvailable(value: boolean) {
      relationAvailable = value;
    },
    sourceAvailable(value: boolean) {
      sourceAvailable = value;
    },
    close: () => {
      closed = true;
    },
    opening: (value: OpeningRecord | null) => {
      currentRecord = value;
    },
    state: (value: typeof state) => {
      state = value;
    },
  };
}

Deno.test("Durable Request seed authority rereads scoped birth/model without opening stores or cached handles", async () => {
  const f = await durableFixture();
  await f.authority.assertArtifactSourcePublication(f.f.publication);
  assert(
    f.counts().stateReads >= 3,
    "Current skill authority is revalidated around exact byte reads",
  );
  assert.equal(
    f.counts().verifiedModelReads,
    f.counts().stateReads,
    "Each independent authority check reads the verified models exactly once",
  );
  assert.equal(f.counts().writes, 0);
  assert.equal(f.f.counts().writes, 0);
  const before = f.counts();
  f.sourceAvailable(false);
  await assert.rejects(
    f.authority.assertArtifactSourcePublication(f.f.publication),
    /Verified retained source is unavailable/,
  );
  assert.equal(f.counts().verifiedModelReads, before.verifiedModelReads + 1);
  assert.equal(
    f.counts().stateReads,
    before.stateReads,
    "A later retained-source refusal precedes runtime-state use",
  );
  assert.equal(f.counts().writes, 0);
});

Deno.test("Durable Request seed authority refuses missing/closed/changed birth and foreign targets read-only", async () => {
  const f = await durableFixture();
  for (
    const target of [
      { ...f.f.publication.target, executionSpaceId: "main" },
      { ...f.f.publication.target, systemId: "foreign" },
      { ...f.f.publication.target, ownerId: "foreign" },
    ]
  ) {
    await assert.rejects(
      f.authority.assertArtifactSourcePublication({
        ...f.f.publication,
        target,
      }),
    );
  }
  assert.equal(f.counts().stateReads, 0);
  f.opening(null);
  await assert.rejects(
    f.authority.assertArtifactSourcePublication(f.f.publication),
  );
  f.opening({ ...f.record, phase: "source-selected" });
  await assert.rejects(
    f.authority.assertArtifactSourcePublication(f.f.publication),
  );
  f.opening(f.record);
  f.state(null);
  await assert.rejects(
    f.authority.assertArtifactSourcePublication(f.f.publication),
  );
  const changed = structuredClone(f.f.context.state);
  changed.executionModel!.skillPolicy!.revision++;
  f.state(changed);
  await assert.rejects(
    f.authority.assertArtifactSourcePublication(f.f.publication),
    /birth differs/,
  );
  f.state(structuredClone(f.f.context.state));
  f.close();
  await assert.rejects(
    f.authority.assertArtifactSourcePublication(f.f.publication),
  );
  assert.equal(f.counts().writes, 0);
});

Deno.test("durable skill authority joins narrow current origin checks with one exact model traversal per check", async () => {
  const f = await durableFixture();
  await f.authority.assertArtifactSourcePublication(f.f.publication);
  assert.equal(f.counts().originRelationReads, f.counts().verifiedModelReads);
  assert.equal(f.counts().verifiedModelReads, f.counts().stateReads);
  assert(f.counts().originRelationReads >= 3);
  const before = f.counts();
  f.relationAvailable(false);
  await assert.rejects(
    f.authority.assertArtifactSourcePublication(f.f.publication),
    /Current origin relation unavailable/,
  );
  assert.equal(f.counts().originRelationReads, before.originRelationReads + 1);
  assert.equal(f.counts().verifiedModelReads, before.verifiedModelReads);
  assert.equal(f.counts().stateReads, before.stateReads);
  assert.equal(f.counts().writes, 0);
});

Deno.test("Seed authority accepts advanced admitted head only while the exact B0 is retained", async () => {
  const f = await durableFixture();
  await f.authority.assertArtifactSourcePublication(f.f.publication);
  f.branchRetainsBase(false);
  await assert.rejects(
    () => f.authority.assertArtifactSourcePublication(f.f.publication),
    /retained base unavailable/,
  );
  assert.equal(f.counts().writes, 0);
});
