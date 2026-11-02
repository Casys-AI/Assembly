import { parseModelRevisionRef } from "../../domain/model/value-objects/element-ref.ts";
import assert from "node:assert/strict";
import {
  type RequestSourceOwnerContextOptions,
  RequestSourceOwnerContexts,
} from "./request-source-owner-context.ts";
import { captureRequestSourceOwnerPhase } from "../../application/model/source-admission/request-source-owner.ts";
import { canonical } from "../../domain/primitives/canonical-json.ts";
import { sha256 } from "../../domain/primitives/execution-digest.ts";
import {
  buildDescriptor,
  buildKey,
  recipeDigest,
} from "../../domain/model/value-objects/build.ts";
import { modelSourceDigest } from "../../domain/model/value-objects/sources.ts";
import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";
import type { ModelRevision } from "../../domain/model/records/revision.ts";
import type { SystemRuntimeState } from "../../domain/work/dialogue.ts";
import {
  parseRequestSourceAdmission,
  requestSourceAdmissionDigest,
} from "../../application/model/source-admission/request-source-admission.ts";
import {
  type OpeningRecord,
  requestSpaceDigest,
  type SpaceController,
} from "../../domain/work/request-spaces.ts";
import type { AdmittedSourceChain } from "../out/postgres/request-source-admission-store.ts";
import { requestSpaceSeed } from "./request-space-runtime.ts";
import {
  requestControlBinding,
  requestControlModel,
  requestControlState,
  requestOpeningBase,
  requestSpaceScope,
  spaceControlAuthority,
  spaceUuid,
} from "../../../test/support/request-space-fixture.ts";
import { admissionFixture } from "../../../test/support/request-source-admission-fixture.ts";
import type { ScopedOperatorRef } from "../../domain/governance/authority.ts";
import { scopedOperator } from "../../domain/governance/policies/delegation-scope.ts";
import type { RequestExecutionBinding } from "../../application/model/evolution/request-adoption-ports.ts";

/** Controlled compiler/SQL fixtures exercise this adapter, not real native
 * compilation, PostgreSQL, RootGrant authorization or Git publication. */
async function fixture() {
  const base = await requestOpeningBase("c"),
    repositoryId = base.manifest.source!.repositoryId;
  const projectId = `git:${repositoryId}`;
  const sources = {
    "models/configuration.sysml":
      "package Fixture { attribute instruction = 1; }",
  };
  const digest = await modelSourceDigest(sources);
  const recipe = {
    toolkit: { version: "fixture", bundleDigest: "4".repeat(64) },
    format: "fixture",
    normalizerVersion: 1,
    irVersion: "1",
    artifactSchema: 1,
    engineVersion: "fixture",
  };
  async function build(sourceDigest: string) {
    const id = await recipeDigest(recipe);
    return buildDescriptor({
      repositoryId,
      sourceDigest,
      recipe,
      recipeDigest: id,
      buildKey: await buildKey(sourceDigest, id),
      artifactDigest: "7".repeat(64),
      bytes: 1,
    });
  }
  const descriptor = await build(digest);
  const model = requestControlModel();
  model.identity.projectId = projectId;
  model.identity.systemQualifiedName = "Fixture::system";
  model.version.authoritySchema = 2;
  base.manifest.source!.sourceDigest = digest;
  base.manifest.operators[0] = {
    ...base.manifest.operators[0],
    nativeSystemId: model.identity.systemId,
    build: descriptor,
    sourceDigest: digest,
  };
  base.manifestDigest = await requestSpaceDigest(base.manifest);
  const command = {
    openingKey: "source-context",
    text: "Keep this Request",
    source: { kind: "current-main" as const },
  };
  const record: OpeningRecord = {
    id: spaceUuid(401),
    caseId: spaceUuid(402),
    caseNumber: 7,
    executionSpaceId: spaceUuid(403),
    branchId: spaceUuid(404),
    initialContributionId: spaceUuid(405),
    scope: { ...requestSpaceScope },
    ownerId: "owner",
    command,
    commandDigest: await requestSpaceDigest({
      scope: requestSpaceScope,
      ownerId: "owner",
      command,
    }),
    base,
    baseDigest: await requestSpaceDigest(base),
    // Source-only fixture: initialized before execution admission.
    phase: "runtime-ready",
    admissionId: null,
    revision: 5,
    issues: [],
    createdAt: "2026-10-30T00:00:00.000Z",
  };
  const seed = requestSpaceSeed(record);
  const state: SystemRuntimeState = {
    ...requestControlState(),
    id: seed.runtimeId,
    model: structuredClone(model.identity),
    executionModel: structuredClone(model),
    cases: [{
      id: seed.caseId,
      number: seed.caseNumber,
      type: "request",
      caseTypeId: seed.caseTypeId,
      objective: "Keep this Request",
      owner: "operator",
      openedBy: seed.openedBy,
      openedFrom: {
        conversationId: seed.runtimeId,
        openingId: seed.openingId,
        messageId: seed.initialContributionId,
      },
      modelPin: {
        digest: model.version.digest,
        repositoryVersion: model.version.repositoryVersion,
      },
      status: "open",
      createdAt: seed.createdAt,
    }],
  };
  const head = {
    revision: 1,
    manifestDigest: base.manifestDigest,
    source: { repositoryId, version: base.manifest.source!.sourceVersion },
    sourceDigest: digest,
  };
  const data = {
    record: record as OpeningRecord | null,
    state: state as SystemRuntimeState | null,
    space: {
      caseId: record.caseId,
      parentExecutionSpaceId: "main",
      lifecycle: "active",
      closedAt: null as Date | null,
    },
    repository: { sourceScopeId: requestSpaceScope.systemId } as {
      sourceScopeId: string;
    } | null,
    chain: {
      baseline: structuredClone(head),
      head: structuredClone(head),
      receipts: [],
      softwareReceipts: [],
      cursor: { revision: head.revision, digest: head.manifestDigest },
      execution: {
        pin: {
          source: parseModelRevisionRef(head.source),
          modelDigest: model.version.digest,
          sourceAdmission: {
            revision: head.revision,
            manifestDigest: head.manifestDigest,
          },
          adoption: null,
        },
        adoptions: [],
        softwareAdoptions: [],
      },
    } as AdmittedSourceChain,
    revision: {
      version: head.source.version,
      sources,
      sourceDigest: digest,
      elements: [],
      documents: [],
      semanticDigest: "5".repeat(64),
      provenanceDigest: "6".repeat(64),
      sourceHashes: {},
      engineVersion: "fixture",
    } as ModelRevision,
    models: [structuredClone(model)],
    descriptor: descriptor as typeof descriptor | null,
    readerRepositoryId: repositoryId,
    readerProjectId: projectId,
    nativeCalls: 0,
    chainReads: 0,
    stateReads: 0,
    sourceVersions: [] as string[],
    descriptorVersions: [] as string[],
    onSource: undefined as (() => void | Promise<void>) | undefined,
    onCompile: undefined as (() => void | Promise<void>) | undefined,
  };
  const controller: SpaceController = {
    ownerId: "owner",
    capabilityId: "capability",
    capabilityRevision: 0,
    sessionId: "session",
    authority: spaceControlAuthority(),
  };
  // Only Prisma delegate promise shapes are bridged here. The adapter uses no
  // client constructor, transaction, state write, provisioning or Main surface.
  const storage = {
    scope: { ...requestSpaceScope },
    readCaseRuntimeState(
      executionSpaceId: string,
      caseId: string,
      operatorId: string,
    ) {
      assert.equal(executionSpaceId, record.executionSpaceId);
      assert.equal(caseId, record.caseId);
      assert.equal(operatorId, "operator");
      data.stateReads++;
      return Promise.resolve(structuredClone(data.state));
    },
    client: {
      executionSpace: {
        findUnique(
          input: { where: { projectId_systemId_executionSpaceId: object } },
        ) {
          assert.deepEqual(input.where.projectId_systemId_executionSpaceId, {
            ...requestSpaceScope,
            executionSpaceId: record.executionSpaceId,
          });
          return Promise.resolve(structuredClone(data.space));
        },
      },
      sourceRepository: {
        findUnique(
          input: { where: { projectId_systemId_repositoryId: object } },
        ) {
          assert.deepEqual(input.where.projectId_systemId_repositoryId, {
            ...requestSpaceScope,
            repositoryId,
          });
          return Promise.resolve(structuredClone(data.repository));
        },
      },
    },
  } as unknown as RequestSourceOwnerContextOptions["storage"];
  class ControlledContexts extends RequestSourceOwnerContexts {
    protected override async compile(
      _revision: ModelRevision,
    ): Promise<readonly ExecutableModel[]> {
      data.nativeCalls++;
      const captured = structuredClone(data.models);
      await data.onCompile?.();
      return captured;
    }
  }
  const options: RequestSourceOwnerContextOptions = {
    storage,
    repositoryId,
    sourceProjectId: projectId,
    openings: {
      forCase(caseId) {
        assert.equal(caseId, record.caseId);
        return Promise.resolve(structuredClone(data.record));
      },
    },
    readAdmittedSource(opening) {
      assert.deepEqual(opening, data.record);
      data.chainReads++;
      return Promise.resolve(structuredClone(data.chain));
    },
    reader: () =>
      Promise.resolve({
        repositoryId: data.readerRepositoryId,
        projectId: data.readerProjectId,
        async at(version) {
          data.sourceVersions.push(version);
          await data.onSource?.();
          return structuredClone(data.revision);
        },
        descriptorAt(version) {
          data.descriptorVersions.push(version);
          return Promise.resolve(structuredClone(data.descriptor));
        },
      }),
  };
  const contexts = new ControlledContexts(options);
  async function advance() {
    const priorDigest =
      data.chain.receipts.at(-1)?.payload.result.model.digest ??
        model.version.digest;
    const raw = await admissionFixture(
      record,
      data.chain.head,
      spaceUuid(410 + data.chain.head.revision),
      "d",
      priorDigest,
    );
    const nextSources = {
      "models/configuration.sysml":
        "package Fixture { attribute instruction = 2; }",
    };
    const sourceDigest = await modelSourceDigest(nextSources),
      nextBuild = await build(sourceDigest);
    const payload = await parseRequestSourceAdmission({
      ...raw,
      result: {
        ...raw.result,
        sourceDigest,
        build: nextBuild,
        buildDigest: await sha256(canonical(nextBuild)),
      },
    });
    const receipt = {
      revision: data.chain.head.revision + 1,
      manifestDigest: await requestSourceAdmissionDigest(payload),
      payload,
      recordedAt: "2026-10-30T00:01:00.000Z",
    };
    data.chain = {
      ...data.chain,
      head: {
        revision: receipt.revision,
        manifestDigest: receipt.manifestDigest,
        source: payload.result.source,
        sourceDigest,
      },
      receipts: [...data.chain.receipts, receipt],
    };
    data.revision = {
      ...data.revision,
      version: payload.result.source.version,
      sources: nextSources,
      sourceDigest,
    };
    data.descriptor = nextBuild;
    data.models = [{
      ...structuredClone(model),
      version: {
        ...model.version,
        digest: payload.result.model.digest,
        repositoryVersion: payload.result.source
          .version as typeof model.version.repositoryVersion,
      },
    }];
  }
  const binding = async () =>
    captureRequestSourceOwnerPhase({
      phase: "proposal",
      controller,
      sessionRevision: 0,
      context: await contexts.resolve(record.caseId, controller),
      binding: requestControlBinding,
      capturedAt: record.createdAt,
    });
  return {
    data,
    contexts,
    controller,
    record,
    model,
    storage,
    options,
    advance,
    binding,
  };
}

Deno.test("source owner resolves exact D2 A0 and rechecks persisted context without recompiling or mutating birth", async () => {
  const f = await fixture(),
    before = structuredClone({
      record: f.data.record,
      state: f.data.state,
      chain: f.data.chain,
    });
  const captured = await f.binding();
  assert.deepEqual(captured.priorModel.identity, f.model.identity);
  assert.deepEqual(f.data.sourceVersions, [f.data.chain.head.source.version]);
  assert.deepEqual(f.data.descriptorVersions, f.data.sourceVersions);
  assert.notEqual(
    captured.destination.host.systemId,
    captured.priorModel.identity.systemId,
    "host/native namespaces remain distinct",
  );
  const reads = f.data.chainReads;
  await f.contexts.assertCurrent(captured);
  await f.contexts.assertCurrent(captured);
  assert.equal(f.data.nativeCalls, 1);
  assert.equal(f.data.sourceVersions.length, 1);
  assert.equal(
    f.data.chainReads,
    reads + 2,
    "current metadata is never cached as authority",
  );
  assert.deepEqual({
    record: f.data.record,
    state: f.data.state,
    chain: f.data.chain,
  }, before);
});

async function memberSourceContextFixture() {
  const f = await fixture();
  await f.advance();
  f.data.record!.phase = "admitted";
  f.data.record!.admissionId = "admission";
  const member = structuredClone(f.model);
  member.identity.builderId = "member";
  member.identity.systemId = "member-system";
  member.version.digest = "e".repeat(64);
  member.version.repositoryVersion = f.data.chain.head.source.version;
  const memberState = {
    ...structuredClone(f.data.state!),
    id: "member-runtime",
    model: member.identity,
    executionModel: member,
    cases: [],
  };
  const requester = scopedOperator({
    ...member.identity,
    executionSpaceId: f.record.executionSpaceId,
  }, "member");
  const calls: unknown[] = [];
  let independentReads = 0, combinedReads = 0;
  const bindingFor = (selected?: ScopedOperatorRef) => {
    const state = selected ? memberState : f.data.state!;
    return {
      state,
      pin: {
        ...f.data.chain.execution.pin,
        modelDigest: state.executionModel!.version.digest,
        source: parseModelRevisionRef({
          repositoryId: f.record.base!.manifest.source!.repositoryId,
          version: state.executionModel!.version.repositoryVersion!,
        }),
      },
      admission: {
        permissions: {
          operatorIds: ["operator", "member"],
          modelDigests: [f.model.version.digest, member.version.digest],
        },
      },
    } as RequestExecutionBinding;
  };
  const executionBindings = {
    read: (_opening: OpeningRecord, selected?: ScopedOperatorRef) => {
      independentReads++;
      calls.push(selected);
      if (selected) assert.deepEqual(selected, requester);
      return Promise.resolve(bindingFor(selected));
    },
    readSourceContext: (
      _opening: OpeningRecord,
      selected: ScopedOperatorRef,
    ) => {
      combinedReads++;
      calls.push(selected);
      assert.deepEqual(selected, requester);
      return Promise.resolve(structuredClone({
        binding: bindingFor(selected),
        ownerState: f.data.state!,
        chain: f.data.chain,
      }));
    },
  };
  Object.assign(f.options, { executionBindings });
  f.data.models.push(structuredClone(member));
  return {
    ...f,
    member,
    memberState,
    requester,
    calls,
    executionBindings,
    independentReads: () => independentReads,
    combinedReads: () => combinedReads,
  };
}

Deno.test("host source context selects an admitted member at the source head even after another operator published", async () => {
  const f = await memberSourceContextFixture();
  const { member, requester, calls } = f;
  const context = await f.contexts.resolveForHost(f.record.caseId, requester);
  assert.deepEqual(context.priorModel.identity, member.identity);
  assert.equal(context.priorModel.version.digest, member.version.digest);
  assert.equal(context.targetOperatorId, "member");
  assert.equal(
    context.destination.expectedAdmittedSource.source.version,
    f.data.chain.head.source.version,
  );
  assert.equal(calls.filter(Boolean).length, 2);
  assert.equal(
    f.combinedReads(),
    2,
    "before and after native I/O each use a fresh combined snapshot",
  );
  assert.equal(
    f.independentReads(),
    0,
    "a member never falls back to separate binding reads",
  );
  assert.equal(
    f.data.chainReads,
    0,
    "the source chain comes from the same snapshot as its bindings",
  );
  assert.deepEqual(f.data.sourceVersions, [f.data.chain.head.source.version]);
  const originalDigest = member.version.digest;
  f.data.models.at(-1)!.version.digest = "f".repeat(64);
  await assert.rejects(
    () => f.contexts.resolveForHost(f.record.caseId, requester),
    /admitted-native-model-differs/,
  );
  member.version.digest = originalDigest;
});

Deno.test("member source context refuses a BO closure observed by its fresh post-compile combined snapshot", async () => {
  const f = await memberSourceContextFixture();
  f.data.onCompile = () => {
    f.data.state!.cases![0].status = "closed-done";
  };
  await assert.rejects(
    () => f.contexts.resolveForHost(f.record.caseId, f.requester),
    /open-request-required/,
  );
  assert.equal(f.combinedReads(), 2);
  assert.equal(f.independentReads(), 0);
  assert.equal(f.data.chainReads, 0);
  assert.equal(f.data.nativeCalls, 1);
});

Deno.test("member source context never falls back when its combined snapshot is unavailable", async () => {
  const f = await memberSourceContextFixture();
  const failure = new Error("combined snapshot unavailable");
  f.executionBindings.readSourceContext = () => Promise.reject(failure);
  await assert.rejects(
    () => f.contexts.resolveForHost(f.record.caseId, f.requester),
    (error) => {
      assert.equal(error, failure);
      return true;
    },
  );
  assert.equal(f.independentReads(), 0);
  assert.equal(f.data.chainReads, 0);
  assert.equal(f.data.nativeCalls, 0);
});

Deno.test("BO source context keeps its own latest result after a member publication advances the shared source", async () => {
  const f = await fixture();
  await f.advance();
  const prior = f.data.chain.receipts.at(-1)!;
  const version = parseModelRevisionRef({
    repositoryId: f.record.base!.manifest.source!.repositoryId,
    version: `commit:${"e".repeat(40)}`,
  });
  // The journal port supplies a verified source chain; compilation remains a
  // controlled port here, without claiming native publication qualification.
  const receipt = {
    ...structuredClone(prior),
    revision: prior.revision + 1,
    manifestDigest: "e".repeat(64),
    payload: {
      ...structuredClone(prior.payload),
      result: {
        ...structuredClone(prior.payload.result),
        source: version,
        model: {
          identity: {
            ...prior.payload.result.model.identity,
            builderId: "member",
            systemId: "member-system",
          },
          digest: "f".repeat(64),
        },
      },
    },
  };
  f.data.chain = {
    ...f.data.chain,
    receipts: [...f.data.chain.receipts, receipt],
    head: {
      revision: receipt.revision,
      manifestDigest: receipt.manifestDigest,
      source: version,
      sourceDigest: receipt.payload.result.sourceDigest,
    },
  };
  f.data.revision.version = version.version;
  f.data.models[0].version.repositoryVersion = version.version;
  for (
    const context of [
      await f.contexts.resolveForHost(f.record.caseId),
      await f.contexts.resolve(f.record.caseId, f.controller),
    ]
  ) {
    assert.equal(context.priorModel.identity.builderId, "operator");
    assert.equal(
      context.priorModel.version.digest,
      prior.payload.result.model.digest,
    );
    assert.equal(context.priorModel.version.repositoryVersion, version.version);
    assert.equal(
      context.destination.expectedAdmittedSource.source.version,
      version.version,
    );
  }
});

Deno.test("advanced source comes from D2 while the original R0 and B0 remain unchanged", async () => {
  const f = await fixture(),
    birth = structuredClone({ record: f.data.record, state: f.data.state });
  await f.advance();
  const current = await f.contexts.resolve(f.record.caseId, f.controller);
  assert.equal(current.destination.expectedAdmittedSource.revision, 2);
  assert.equal(
    current.priorModel.version.repositoryVersion,
    f.data.chain.head.source.version,
  );
  assert.equal(
    current.priorModel.version.digest,
    f.data.models[0].version.digest,
  );
  assert.notEqual(
    current.priorModel.version.digest,
    f.data.state!.executionModel!.version.digest,
  );
  assert.deepEqual({ record: f.data.record, state: f.data.state }, birth);
});

Deno.test("missing, foreign, uninitialized or closed Request facts refuse before source compilation", async () => {
  const mutations: Array<(f: Awaited<ReturnType<typeof fixture>>) => void> = [
    (f) => {
      f.data.record = null;
    },
    (f) => {
      f.data.record!.ownerId = "foreign";
    },
    (f) => {
      f.data.record!.scope.systemId = "foreign-host";
    },
    (f) => {
      f.data.record!.phase = "branch-ready";
    },
    (f) => {
      f.data.record!.executionSpaceId = "main";
    },
    (f) => {
      f.data.space.caseId = "foreign-case";
    },
    (f) => {
      f.data.space.lifecycle = "closed";
      f.data.space.closedAt = new Date();
    },
    (f) => {
      f.data.state = null;
    },
    (f) => {
      f.data.state!.cases![0].status = "closed-done";
    },
    (f) => {
      f.data.state!.cases![0].modelPin!.digest = "f".repeat(64);
    },
    (f) => {
      f.data.state!.executionModel!.version.digest = "f".repeat(64);
    },
    (f) => {
      f.data.repository = null;
    },
    (f) => {
      f.data.repository!.sourceScopeId = "foreign-source-scope";
    },
    (f) => {
      f.data.chain = {
        ...f.data.chain,
        baseline: { ...f.data.chain.baseline, manifestDigest: "f".repeat(64) },
      };
    },
    (f) => {
      f.data.chain = {
        ...f.data.chain,
        head: {
          ...f.data.chain.head,
          source: {
            ...f.data.chain.head.source,
            version: `commit:${"e".repeat(40)}`,
          },
        },
      };
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    mutate(f);
    await assert.rejects(() =>
      f.contexts.resolve(f.record.caseId, f.controller)
    );
    assert.equal(f.data.nativeCalls, 0);
    assert.deepEqual(f.data.sourceVersions, []);
  }
});

Deno.test("exact immutable reader, source bytes and build mismatches refuse without Main fallback", async () => {
  const mutations: Array<(f: Awaited<ReturnType<typeof fixture>>) => void> = [
    (f) => {
      f.data.readerRepositoryId = spaceUuid(9999);
    },
    (f) => {
      f.data.readerProjectId = "other-project";
    },
    (f) => {
      f.data.revision.version = `commit:${"e".repeat(40)}`;
    },
    (f) => {
      f.data.revision.sourceDigest = "e".repeat(64);
    },
    (f) => {
      f.data.revision.sources["models/configuration.sysml"] =
        "package Tampered;";
    },
    (f) => {
      f.data.descriptor = null;
    },
    (f) => {
      f.data.descriptor = {
        ...f.data.descriptor!,
        artifactDigest: "e".repeat(64),
      };
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    mutate(f);
    await assert.rejects(() =>
      f.contexts.resolve(f.record.caseId, f.controller)
    );
    assert.equal(f.data.nativeCalls, 0);
    assert.ok(
      f.data.sourceVersions.every((version) =>
        version === f.data.chain.head.source.version
      ),
    );
  }
});

Deno.test("missing, duplicate, mismatched native owner/model identity or version refuses", async () => {
  const mutations: Array<(f: Awaited<ReturnType<typeof fixture>>) => void> = [
    (f) => {
      f.data.models = [];
    },
    (f) => {
      f.data.models.push(structuredClone(f.data.models[0]));
    },
    (f) => {
      f.data.models[0].identity.rootId = "foreign-root";
    },
    (f) => {
      f.data.models[0].identity.builderId = "foreign-operator";
    },
    (f) => {
      f.data.models[0].version.digest = "e".repeat(64);
    },
    (f) => {
      f.data.models[0].version.repositoryVersion = `commit:${"e".repeat(40)}`;
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    mutate(f);
    await assert.rejects(() =>
      f.contexts.resolve(f.record.caseId, f.controller)
    );
  }
});

Deno.test("closure, ownership and admitted-head races across native reads refuse", async () => {
  const f = await fixture();
  f.data.onCompile = () => {
    f.data.state!.cases![0].status = "closed-done";
  };
  await assert.rejects(() => f.contexts.resolve(f.record.caseId, f.controller));
  const owner = await fixture();
  owner.data.onCompile = () => {
    owner.data.record!.ownerId = "foreign";
  };
  await assert.rejects(() =>
    owner.contexts.resolve(owner.record.caseId, owner.controller)
  );
  const moved = await fixture();
  moved.data.onCompile = () => moved.advance();
  await assert.rejects(() =>
    moved.contexts.resolve(moved.record.caseId, moved.controller)
  );
});

Deno.test("assertCurrent rechecks source visibility, open lifecycle and exact captured A0 without native I/O", async () => {
  for (const kind of ["closed", "visibility", "advanced"] as const) {
    const f = await fixture(), captured = await f.binding();
    if (kind === "closed") f.data.state!.cases![0].status = "closed-done";
    if (kind === "visibility") f.data.repository = null;
    if (kind === "advanced") await f.advance();
    await assert.rejects(() => f.contexts.assertCurrent(captured));
    assert.equal(f.data.nativeCalls, 1);
    assert.equal(f.data.sourceVersions.length, 1);
  }
});

Deno.test("caller controller is snapshotted and a source technical failure remains observable", async () => {
  const f = await fixture();
  f.data.onSource = () => {
    f.controller.ownerId = "foreign";
  };
  assert.equal(
    (await f.contexts.resolve(f.record.caseId, f.controller)).openingOwnerId,
    "owner",
  );
  const broken = await fixture(),
    failure = new Error("Exact source read unavailable");
  broken.data.onSource = () => {
    throw failure;
  };
  await assert.rejects(
    () => broken.contexts.resolve(broken.record.caseId, broken.controller),
    (error) => error === failure,
  );
});

Deno.test("source context supplies actual prior owner facts but does not grant modeled owner authority", async () => {
  const f = await fixture();
  f.data.models[0].ownerAuthority = {
    ...f.data.models[0].ownerAuthority!,
    ownerSource: "implicit-legacy",
  };
  const context = await f.contexts.resolve(f.record.caseId, f.controller);
  assert.equal(
    context.priorModel.ownerAuthority?.ownerSource,
    "implicit-legacy",
  );
  assert.throws(() =>
    captureRequestSourceOwnerPhase({
      phase: "proposal",
      controller: f.controller,
      sessionRevision: 0,
      context,
      binding: requestControlBinding,
      capturedAt: f.record.createdAt,
    })
  );
});

Deno.test("production context compiler rejects malformed native source rather than trusting the supplied runtime", async () => {
  const f = await fixture();
  // The exact synthetic source/build contains no native IR. This uses the real
  // existing source validator, not ControlledContexts' compiler substitute.
  const contexts = new RequestSourceOwnerContexts(f.options);
  await assert.rejects(
    () => contexts.resolve(f.record.caseId, f.controller),
    /Expected one native ConversationSystem definition/,
  );
});

Deno.test("source context permits only genuine unadmitted B0 without an execution binding", async () => {
  const initial = await fixture();
  await initial.contexts.resolve(initial.record.caseId, initial.controller);
  for (
    const mutation of [
      "adoption-pin",
      "adoption-event",
      "admitted",
      "unexpected-admission",
    ] as const
  ) {
    const f = await fixture();
    if (mutation === "adoption-pin") {
      f.data.chain = {
        ...f.data.chain,
        execution: {
          ...f.data.chain.execution,
          pin: {
            ...f.data.chain.execution.pin,
            adoption: {
              commandId: "adoption",
              receiptDigest: "a".repeat(64),
              committedRuntimeRevision: 2,
            },
          },
        },
      };
    }
    if (mutation === "adoption-event") {
      f.data.state!.events.push({
        id: "adoption",
        at: "2026-10-30T00:00:00.000Z",
        kind: "model-version-admitted",
        label: "adopted",
      });
    }
    if (mutation === "admitted") f.data.record!.phase = "admitted";
    if (mutation === "unexpected-admission") {
      f.data.record!.admissionId = spaceUuid(406);
    }
    await assert.rejects(
      () => f.contexts.resolve(f.record.caseId, f.controller),
      (error: unknown) => error instanceof Error,
      mutation,
    );
  }
});
