import { WorkBudgetService } from "../budget/service.ts";
import {
  budgetState,
  type WorkBudgetRecord,
} from "../../../domain/work/policies/budget.ts";
import type { RequestOperatorStorage } from "./runtime-ports.ts";
import type { ScopedOperatorRef } from "../../../domain/governance/authority.ts";
import { canonicalDigest } from "../../../domain/primitives/execution-digest.ts";
import { parseModelRevisionRef } from "../../../domain/model/value-objects/element-ref.ts";
import assert, { equal } from "node:assert/strict";
import { createTestNativeExecution } from "../../../../test/support/native-execution.ts";
import { emptyChangePreview } from "../../../../test/support/model-authoring.ts";
import type { SystemRuntime } from "../runtime/system.ts";
import { requestAuthorityRoute } from "../../governance/request-authority-routing.ts";
import { buildRequestDelegatedAuthority } from "../../model/source-admission/request-delegated-authority.ts";
import { mainExecutionSpace } from "../../../domain/governance/operator-authority.ts";
import {
  ownerChangesOf,
  requestSpaceInitialDelivery,
  RequestSpaceRuntime,
  type RequestSpaceRuntimeOptions,
} from "./runtime.ts";
import { requestSpaceSeed } from "../runtime/initialization.ts";
import { AjvSchemaValidator } from "../../../infrastructure/ajv-schema-validation.ts";
import { requestNetworkProposalDigest } from "../../../domain/governance/records/request-network-change.ts";
import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import {
  type OpeningRecord,
  requestSpaceDigest,
  RequestSpaceError,
  type SpaceExecutionAdmission,
} from "../../../domain/work/request-spaces.ts";
import type { OperatorExecutionDelivery } from "../operators/execution.ts";
import {
  requestControlModel,
  requestOpeningBase,
  requestSpaceScope,
  spaceControlAuthority,
} from "../../../../test/support/request-space-fixture.ts";

type FixtureOperatorStorage = RequestOperatorStorage & {
  readonly scope: ScopedOperatorRef;
};

async function fixture(
  onDependencies?: (snapshot: () => SystemRuntimeState | undefined) => void,
  initialSkills?: { initialize(): Promise<void> },
) {
  let branchRetainsBase = true;
  const base = await requestOpeningBase();
  const model = requestControlModel();
  model.version.digest = "a".repeat(64);
  model.version.repositoryVersion = base.manifest.source!.sourceVersion;
  model.caseTypes = [{
    id: "request-type",
    name: "Request",
    type: "request",
    envelope: "conversational",
    behaviorId: model.flows.conversation.rootNativeId,
    ownerId: "operator",
    sourceIds: ["request-type"],
  }];
  const command = {
    openingKey: "opening",
    text: "  Preserve full text\n" + "detail ".repeat(500),
    source: { kind: "current-main" as const },
  };
  let record: OpeningRecord = {
    id: "opening",
    caseId: "case",
    caseNumber: 7,
    executionSpaceId: "space",
    branchId: "branch",
    initialContributionId: "input",
    scope: requestSpaceScope,
    ownerId: "owner",
    command,
    commandDigest: await requestSpaceDigest({
      scope: requestSpaceScope,
      ownerId: "owner",
      command,
    }),
    base,
    baseDigest: await requestSpaceDigest(base),
    phase: "branch-ready",
    admissionId: null,
    revision: 2,
    issues: [],
    createdAt: "2026-10-29T00:00:00Z",
  };
  const admission: SpaceExecutionAdmission = {
    id: "admission",
    scope: requestSpaceScope,
    executionSpaceId: "space",
    openingId: "opening",
    ownerId: "owner",
    capabilityId: "capability",
    capabilityRevision: 0,
    baseDigest: record.baseDigest!,
    authority: spaceControlAuthority(),
    permissions: {
      operatorIds: ["operator"],
      acts: ["conversation"],
      sourceVersion: model.version.repositoryVersion!,
      modelDigests: [model.version.digest],
      resourceIds: [],
    },
    revision: 0,
    status: "active",
    expiresAt: "2099-01-01T00:00:00Z",
    createdAt: record.createdAt,
  };
  let saved: SystemRuntimeState | null = null;
  let modelReads = 0,
    inspectionReads = 0,
    stateWrites = 0,
    executionUnavailable = false,
    failSource = false,
    closed = false,
    checks = 0,
    acceptedReplay = false,
    failStateSave = false;
  const deliveries: OperatorExecutionDelivery[] = [];
  const retainedChecks: string[] = [];
  const unavailableRetainedVersions = new Set<string>();
  const never = () => {
    throw new Error("Unexpected active dependency");
  };
  const state = {
    load: () => Promise.resolve(structuredClone(saved)),
    save: (next: SystemRuntimeState, expected: number | null) => {
      stateWrites++;
      if (failStateSave) {
        return Promise.reject(new Error("controlled save failure"));
      }
      if ((saved?.revision ?? null) !== expected) {
        return Promise.reject(new Error("CAS lost"));
      }
      saved = structuredClone(next);
      return Promise.resolve();
    },
  };
  let memberSaved: SystemRuntimeState | null = null;
  let memberOpenFails = false;
  let failMemberSave = false;
  const memberState = {
    load: () => Promise.resolve(structuredClone(memberSaved)),
    save: (next: SystemRuntimeState, expected: number | null) => {
      if (failMemberSave) {
        return Promise.reject(new Error("member save failure"));
      }
      if ((memberSaved?.revision ?? null) !== expected) {
        return Promise.reject(new Error("CAS lost"));
      }
      memberSaved = structuredClone(next);
      return Promise.resolve();
    },
  };
  let memberModel: ReturnType<typeof requestControlModel> | undefined;
  const additionalTeamModels: ReturnType<typeof requestControlModel>[] = [];
  const additionalTeamStates = new Map<string, SystemRuntimeState>();
  const view = {
    scope: { ...requestSpaceScope, executionSpaceId: "space", caseId: "case" },
    execution: { inspect: () => Promise.resolve([]) },
    dispatch: {
      inspectAccepted: () =>
        Promise.resolve(
          acceptedReplay
            ? {
              receipt: {
                id: "input",
                threadId: "thread",
                jobId: "job",
                status: "completed",
              },
              delivery: structuredClone(deliveries[0]),
            }
            : null,
        ),
      enqueue: (delivery: OperatorExecutionDelivery) => {
        deliveries.push(structuredClone(delivery));
        return Promise.resolve({
          id: delivery.id,
          threadId: "thread",
          jobId: "job",
          status: "queued" as const,
        });
      },
    },
  };
  const options = {
    storage: {
      scope: requestSpaceScope,
      caseNumbers: () => ({ allocate: never }),
      readCaseRuntimeState: (
        space: string,
        caseId: string,
        operatorId: string,
      ) => {
        assert.equal(space, "space");
        assert.equal(caseId, "case");
        return Promise.resolve(
          structuredClone(
            operatorId === "operator"
              ? saved
              : operatorId === "member"
              ? memberSaved
              : additionalTeamStates.get(operatorId) ?? null,
          ),
        );
      },
      caseSpace: (space: string, caseId: string) => {
        if (closed || space !== "space" || caseId !== "case") {
          throw new Error("Case execution space is unavailable");
        }
        return Promise.resolve({
          operator: (operatorId: string) => {
            if (memberOpenFails && operatorId !== "operator") {
              return Promise.reject(
                new Error("Member operator store unavailable"),
              );
            }
            return Promise.resolve({
              scope: {
                ...requestSpaceScope,
                executionSpaceId: "space",
                operatorId,
              },
              state: operatorId === "operator" ? state : memberState,
              budget: { load: () => Promise.resolve(null), save: never },
            });
          },
        });
      },
    },
    native: {
      scope: { ...requestSpaceScope, executionSpaceId: "main" },
      forCaseSpace: () => Promise.resolve(view),
    },
    admittedSource: { read: never },
    lifecycle: { read: never },
    waitingRuns: { read: never },
    onNoticeError: never,
    openings: {
      get: () => Promise.resolve(structuredClone(record)),
      forCase: () => Promise.resolve(structuredClone(record)),
    },
    source: {
      verify: () =>
        failSource || executionUnavailable
          ? Promise.reject(new Error("Host execution is unavailable"))
          : Promise.resolve(),
      readModelsForInspection: () => {
        inspectionReads++;
        return failSource
          ? Promise.reject(new Error("Source unavailable"))
          : Promise.resolve([
            structuredClone(model),
            ...(memberModel ? [structuredClone(memberModel)] : []),
            ...structuredClone(additionalTeamModels),
          ]);
      },
      readModels: () => {
        modelReads++;
        return failSource || executionUnavailable
          ? Promise.reject(
            new Error("Source unavailable or host execution is unavailable"),
          )
          : Promise.resolve([
            structuredClone(model),
            ...(memberModel ? [structuredClone(memberModel)] : []),
            ...structuredClone(additionalTeamModels),
          ]);
      },
    },
    branches: {
      sourceVersion: () => Promise.resolve(`commit:${"b".repeat(40)}`),
      assertRetainedExecutionVersion: (
        _record: OpeningRecord,
        version: string,
      ) => {
        retainedChecks.push(version);
        return branchRetainsBase && !unavailableRetainedVersions.has(version)
          ? Promise.resolve()
          : Promise.reject(new Error("Request retained base unavailable"));
      },
      assertVersion: (_record: OpeningRecord, version: string) =>
        branchRetainsBase && version === base.manifest.source!.sourceVersion
          ? Promise.resolve()
          : Promise.reject(new Error("Request retained base unavailable")),
    },
    admissions: {
      assertDispatch: () => {
        checks++;
        return Promise.resolve();
      },
    },
    dependencies: (
      _stores: unknown,
      _model: unknown,
      currentSnapshot: () => SystemRuntimeState | undefined,
    ) => {
      onDependencies?.(currentSnapshot);
      return {
        ...(initialSkills ? { initialSkills } : {}),
        schemaValidator: new AjvSchemaValidator(),
        clock: { now: () => "2026-10-30T00:00:00Z" },
        agents: { label: "controlled", decide: never, review: never },
        runner: { test: never, run: never },
      };
    },
  } as unknown as RequestSpaceRuntimeOptions<FixtureOperatorStorage>;
  return {
    factory: () => new RequestSpaceRuntime(options),
    record: () => structuredClone(record),
    branchId: (id: string) => {
      record.branchId = id;
    },
    markDispatched: () => {
      record.phase = "dispatched";
      record.admissionId = "admission";
    },
    admission,
    retainedChecks,
    unavailableRetainedVersions,
    options,
    model: () => structuredClone(model),
    addInitialSkill: () => {
      model.initialSkills = [{
        nativeId: "seed",
        id: "assembly-modeling",
        source: "bundle:assembly-modeling",
        digest: "d".repeat(64),
        loaded: true,
        sourceIds: ["seed"],
      }];
    },
    read: () => structuredClone(saved!),
    modelReads: () => modelReads,
    inspectionReads: () => inspectionReads,
    stateWrites: () => stateWrites,
    failStateSave: (fail: boolean) => {
      failStateSave = fail;
    },
    disableExecutionHost: () => {
      executionUnavailable = true;
    },
    closeCaseState: () => {
      saved!.cases![0].status = "closed-done";
      saved!.cases![0].closedAt = "2026-10-30T00:00:00Z";
      delete saved!.caseInvocation;
    },
    checks: () => checks,
    deliveries,
    branchRetainsBase: (value: boolean) => {
      branchRetainsBase = value;
    },
    sourceFailure: (value: boolean) => {
      failSource = value;
    },
    close: () => {
      closed = true;
    },
    allowClosedReplay: () => {
      acceptedReplay = true;
    },
    admit: () => {
      record = { ...record, phase: "admitted", admissionId: admission.id };
    },
    setAdmissionPhase: (
      phase: OpeningRecord["phase"],
      admissionId: string | null,
    ) => {
      record = { ...record, phase, admissionId };
    },
    changeState: (next: SystemRuntimeState) => {
      saved = structuredClone(next);
    },
    memberRead: () => structuredClone(memberSaved),
    memberStore: memberState,
    failMemberSave: (fail: boolean) => {
      failMemberSave = fail;
    },
    memberModel: () => memberModel!,
    addTeamState: (
      model: ReturnType<typeof requestControlModel>,
      state: SystemRuntimeState,
    ) => {
      additionalTeamModels.push(structuredClone(model));
      additionalTeamStates.set(
        model.identity.builderId,
        structuredClone(state),
      );
    },
    failMemberOpen: () => {
      memberOpenFails = true;
    },
    addTeamMember: async (maxFlowSteps = 1) => {
      const { legacyOwnerAuthority } = await import(
        "../../../domain/governance/authority.ts"
      );
      const { creationAuthorityExercise } = await import(
        "../../../domain/governance/policies/operator-creation-policy.ts"
      );
      const systemId = model.identity.systemId;
      const root = {
        ...legacyOwnerAuthority(systemId),
        ownerSource: "modeled" as const,
      };
      const policy = {
        id: "create-team",
        revision: 1,
        elementId: "grant-element",
        sourceIds: ["grant-element"],
        holderNativeId: "operator",
        mandateNativeId: "worker-mandate",
        systemId,
        enabled: true,
        rootAuthority: root,
        networkHosts: [],
        maxChildren: 2,
        maxDelegationDepth: 1,
        children: [] as string[],
      };
      const spec = {
        kind: "request-team-member" as const,
        instruction: "Help on this Case",
        provision: {
          budget: {
            maxAgentDecisions: 1,
            maxToolProposals: 0,
            maxFlowSteps,
          },
          networkHosts: [],
          mayPropose: [],
          mayInvokeActiveCatalog: false,
          mayAddNetworkHosts: true,
        },
      };
      model.operatorCreationPolicies = [policy] as never;
      const change = {
        id: "create-member",
        kind: "operator-creation",
        role: "operator",
        name: "Helper",
        status: "approved",
        requestedBy: "operator",
        caseId: "case",
        teamOrigin: { operatorId: "operator", requestId: "case" },
        baseRevision: 0,
        requestedAt: "now",
        reason: "Help",
        operator: spec,
        authority: "builder",
        decidedAt: "now",
      } as never;
      (change as { authorityExercise?: unknown }).authorityExercise =
        creationAuthorityExercise(model, change, {
          actorId: "operator",
          policyId: policy.id,
          policyRevision: 1,
        }, {
          space: {
            projectId: model.identity.projectId,
            systemId: model.identity.systemId,
            executionSpaceId: "space",
          },
          branchTeamSize: 0,
          currentCaseId: "case",
        });
      policy.children = ["member-system"];
      model.configuration = {
        ...model.configuration,
        changes: [change] as never,
      };
      memberModel = requestControlModel();
      memberModel.identity = {
        ...memberModel.identity,
        builderId: "member",
        systemId: "member-system",
        systemQualifiedName: "AssemblyLiveBuilder::memberSystem",
      };
      memberModel.ownerAuthority = {
        ...memberModel.ownerAuthority!,
        systemId: "member-system",
      };
      memberModel.version.digest = "c".repeat(64);
      memberModel.version.repositoryVersion =
        base.manifest.source!.sourceVersion;
      memberModel.operatorTeam = {
        parentOperatorId: "operator",
        requestOwnerId: "operator",
        requestId: "case",
        creationPolicyId: policy.id,
      };
      memberModel.operator = {
        name: "Helper",
        instruction: spec.instruction,
        primary: false,
        humanInput: false,
      };
      memberModel.policy = { ...memberModel.policy, ...spec.provision.budget };
      memberModel.mandate = {
        ...memberModel.mandate,
        mayPropose: [],
        mayInvoke: false,
      };
      memberModel.configuration = {
        ...memberModel.configuration,
        network: { allowedHosts: [] },
      };
      admission.permissions.operatorIds = ["operator", "member"];
      admission.permissions.modelDigests = [
        model.version.digest,
        "c".repeat(64),
      ];
    },
  };
}

Deno.test("failed Request initialization sends no conversation notification", async () => {
  const f = await fixture();
  let notifications = 0;
  let abandoned: SystemRuntime | undefined;
  f.options.bindRequestAuthority = (_record, runtime) => {
    abandoned = runtime;
  };
  f.options.onConversationStateChanged = () => {
    notifications++;
  };
  f.failStateSave(true);
  await assert.rejects(
    f.factory().provision(f.record()),
    /controlled save failure/,
  );
  assert.equal(notifications, 0);
  f.failStateSave(false);
  await abandoned!.initializeRequestSpace(
    requestSpaceSeed(f.record()),
    f.model(),
  );
  await abandoned!.receiveOperatorNotice({
    kind: "request-completed",
    caseId: "stale",
    owner: "operator",
    openedBy: "operator",
    status: "closed-done",
    result: "stale",
  }, { conversationId: "fixture" });
  assert.equal(notifications, 0);
});

Deno.test("a failed member initialization releases its observer", async () => {
  const f = await fixture();
  await f.addTeamMember();
  f.admit();
  f.failMemberSave(true);
  let member: SystemRuntime | undefined, notifications = 0;
  let bo: SystemRuntime | undefined;
  f.options.bindRequestAuthority = (_record, current) => {
    if (!bo) bo = current;
    else member = current;
  };
  f.options.onConversationStateChanged = () => {
    notifications++;
  };
  const runtime = f.factory();
  await runtime.provision(f.record());
  assert.ok(member);
  const count = notifications;
  f.failMemberSave(false);
  await member.initialize(f.memberModel(), {
    resumeCandidateContinuations: false,
    runtimeId: "request:space:member",
  });
  await member.receiveOperatorNotice({
    kind: "request-completed",
    caseId: "stale",
    owner: "operator",
    openedBy: "operator",
    status: "closed-done",
    result: "stale",
  }, { conversationId: "fixture" });
  assert.equal(notifications, count);
  runtime.closeConversationObservers();
});

Deno.test("replacing a Request runtime generation releases its old observer", async () => {
  const f = await fixture();
  let old: SystemRuntime | undefined, notifications = 0;
  f.options.bindRequestAuthority = (_record, current) => {
    old ??= current;
  };
  f.options.onConversationStateChanged = () => {
    notifications++;
  };
  const runtime = f.factory();
  await runtime.provision(f.record());
  f.admit();
  const source = f.record().base!.manifest.source!;
  f.options.executionBindings = {
    read: () => {
      const state = f.read();
      return Promise.resolve({
        state,
        pin: {
          source: parseModelRevisionRef({
            repositoryId: source.repositoryId,
            version: source.sourceVersion,
          }),
          modelDigest: state.executionModel!.version.digest,
          sourceAdmission: {
            revision: 1,
            manifestDigest: f.record().base!.manifestDigest,
          },
          adoption: null,
        },
        admission: f.admission,
      });
    },
  };
  await runtime.restoreInstructionAdoption(f.record());
  const count = notifications;
  await old!.receiveOperatorNotice({
    kind: "request-completed",
    caseId: "stale",
    owner: "operator",
    openedBy: "operator",
    status: "closed-done",
    result: "stale",
  }, { conversationId: "fixture" });
  assert.equal(notifications, count);
  runtime.closeConversationObservers();
});

Deno.test("Request conversation observers follow persisted BO and member state and stop cleanly", async () => {
  const f = await fixture();
  await f.addTeamMember();
  f.admit();
  const bound: SystemRuntime[] = [];
  const observed: Array<
    { caseId: string; bo: number | undefined; member: number | undefined }
  > = [];
  f.options.bindRequestAuthority = (_record, runtime) => {
    bound.push(runtime);
  };
  f.options.onConversationStateChanged = (record) => {
    observed.push({
      caseId: record.caseId,
      bo: f.read()?.revision,
      member: f.memberRead()?.revision,
    });
  };
  const runtime = f.factory();
  await runtime.provision(f.record());
  const bo = bound.find((item) =>
    item.snapshot.executionModel?.identity.builderId === "operator"
  )!;
  const member = bound.find((item) =>
    item.snapshot.executionModel?.identity.builderId === "member"
  )!;
  assert.ok(bo && member);
  assert.ok(observed.some((entry) => entry.bo === f.read().revision));
  assert.ok(
    observed.some((entry) => entry.member === f.memberRead()!.revision),
  );
  assert.ok(observed.every((entry) => entry.caseId === "case"));
  const notice = (caseId: string) => ({
    kind: "request-completed" as const,
    caseId,
    owner: "operator",
    openedBy: "operator",
    status: "closed-done" as const,
    result: "observed",
  });
  const origin = { conversationId: "fixture" };
  let count = observed.length;
  await bo.receiveOperatorNotice(notice("bo-update"), origin);
  assert.equal(observed.length, count + 1);
  assert.equal(observed.at(-1)!.bo, f.read().revision);
  count = observed.length;
  await member.receiveOperatorNotice(notice("member-update"), origin);
  assert.equal(observed.length, count + 1);
  assert.equal(observed.at(-1)!.member, f.memberRead()!.revision);
  f.failStateSave(true);
  count = observed.length;
  await assert.rejects(
    bo.receiveOperatorNotice(notice("failed"), origin),
    /controlled save failure/,
  );
  assert.equal(observed.length, count);
  f.failStateSave(false);
  runtime.closeConversationObservers();
  runtime.closeConversationObservers();
  await bo.receiveOperatorNotice(notice("after-close-bo"), origin);
  await member.receiveOperatorNotice(notice("after-close-member"), origin);
  assert.equal(observed.length, count);
});

Deno.test("Request runtime constructor rejects foreign native scope and non-main views", async () => {
  const f = await fixture();
  const original = f.options.native.scope;
  for (
    const changed of [
      { projectId: "foreign-project" },
      { systemId: "foreign-system" },
      { executionSpaceId: "request-space" },
    ]
  ) {
    f.options.native = {
      ...f.options.native,
      scope: { ...original, ...changed },
    };
    assert.throws(
      f.factory,
      (error: unknown) =>
        error instanceof RequestSpaceError && error.code === "FORBIDDEN" &&
        error.message ===
          "The admitted Request runtime belongs to another host",
    );
  }
});

Deno.test("Request dependency snapshot getter is lazy and belongs to the constructed runtime", async () => {
  let current: (() => SystemRuntimeState | undefined) | undefined;
  const f = await fixture((snapshot) => {
    assert.equal(snapshot(), undefined);
    current = snapshot;
  });
  await f.factory().provision(f.record());
  assert.equal(current!()!.id, "request:space:operator");
  assert.deepEqual(current!()!.executionModel, f.read().executionModel);
  assert.deepEqual(current!()!.cases, f.read().cases);
});

Deno.test("Request worker refuses an unadmitted durable opening before constructing or mutating a runtime", async () => {
  let dependencyConstructions = 0;
  const f = await fixture(() => {
    dependencyConstructions++;
  });
  const delivery: OperatorExecutionDelivery = {
    id: "input",
    kind: "contribution",
    identity: {
      operatorId: "operator",
      invocationKey: "local:case",
      scope: { kind: "request", scopeId: "case", rootRequestId: "case" },
      purpose: "conversation",
    },
    modelPin: {
      modelDigest: "a".repeat(64),
      repositoryVersion: f.record().base!.manifest.source!.sourceVersion,
    },
  };
  for (
    const [phase, admissionId] of [
      ["branch-ready", "admission"],
      ["runtime-ready", "admission"],
      ["admitted", null],
      ["dispatched", ""],
    ] as const
  ) {
    f.setAdmissionPhase(phase, admissionId);
    await assert.rejects(
      f.factory().processAcceptedContribution(delivery, {
        ...requestSpaceScope,
        executionSpaceId: "space",
        caseId: "case",
      }),
      (error) =>
        error instanceof RequestSpaceError &&
        error.code === "ADMISSION_REFUSED",
    );
    assert.equal(f.read(), null);
    assert.equal(f.modelReads(), 0);
    assert.equal(dependencyConstructions, 0);
    assert.deepEqual(f.deliveries, []);
  }
});

Deno.test("Request factory caches exact concurrent provisioning, evicts failures and preserves restored work", async () => {
  const f = await fixture(), runtime = f.factory();
  f.sourceFailure(true);
  await assert.rejects(
    () => runtime.provision(f.record()),
    /Source unavailable/,
  );
  f.sourceFailure(false);
  await Promise.all([
    runtime.provision(f.record()),
    runtime.provision(f.record()),
  ]);
  assert.equal(f.modelReads(), 2);
  const state = f.read();
  state.busy = true;
  state.phase = "in flight";
  state.messages.push({
    id: "retained",
    role: "assistant",
    text: "history",
    at: f.record().createdAt,
  });
  f.changeState(state);
  await runtime.provision(f.record());
  await f.factory().provision(f.record());
  assert.deepEqual(f.read(), state);
  await assert.rejects(
    () =>
      runtime.provision({ ...f.record(), initialContributionId: "divergent" }),
    /differs/,
  );
  assert.deepEqual(f.read(), state);
  f.close();
  await assert.rejects(() => runtime.provision(f.record()), /unavailable/);
});

Deno.test("Request enqueue uses recorded input, full text, exact pin/date and local root identity", async () => {
  const f = await fixture(), runtime = f.factory();
  await runtime.provision(f.record());
  assert.equal(f.deliveries.length, 0);
  f.admit();
  await runtime.enqueue(f.record(), f.admission);
  await runtime.enqueue(f.record(), f.admission);
  const delivery = f.deliveries[0];
  assert.deepEqual(f.deliveries[1], delivery);
  assert.equal(f.checks(), 2);
  assert.equal(delivery.id, f.record().initialContributionId);
  assert.equal(delivery.payload!.text, f.record().command.text);
  assert.equal(delivery.payload!.receivedAt, f.record().createdAt);
  assert.deepEqual(delivery.payload!.invocation, {
    kind: "local",
    caseId: "case",
  });
  assert.deepEqual(delivery.identity.scope, {
    kind: "request",
    scopeId: "case",
    rootRequestId: "case",
  });
  assert.equal(delivery.modelPin.modelDigest, "a".repeat(64));
  assert.equal(
    f.read().messages.length,
    0,
    "Only claimed worker materializes canonical input",
  );
  await assert.rejects(
    () =>
      runtime.processAcceptedContribution({
        ...delivery,
        identity: { ...delivery.identity, operatorId: "foreign" },
      }, { ...requestSpaceScope, executionSpaceId: "space", caseId: "case" }),
    /routing is unavailable/,
  );
  const state = f.read();
  state.cases![0].status = "closed-done";
  state.cases![0].closedAt = "2026-10-30T00:00:00Z";
  f.changeState(state);
  await runtime.provision(f.record());
  assert.equal(f.read().cases![0].status, "closed-done");
  await assert.rejects(
    () => runtime.enqueue(f.record(), f.admission),
    /Case is closed/,
  );
  assert.equal(f.deliveries.length, 2);
  f.allowClosedReplay();
  await runtime.enqueue(f.record(), f.admission);
  assert.deepEqual(f.deliveries[2], delivery);
  assert.deepEqual(f.read(), state);
});

Deno.test("Request seed activation is explicit after inert birth and preparation failure keeps that birth intact", async () => {
  let initializations = 0, fail = true;
  let current: (() => SystemRuntimeState | undefined) | undefined;
  const f = await fixture((snapshot) => {
    current = snapshot;
  }, {
    initialize() {
      initializations++;
      assert.equal(current!()!.id, f.read().id);
      assert.equal(f.read().revision, 0);
      return fail
        ? Promise.reject(new Error("Interrupted seed retention"))
        : Promise.resolve();
    },
  });
  f.addInitialSkill();
  const runtime = f.factory();
  await runtime.provision(f.record());
  const birth = f.read();
  assert.equal(initializations, 0);
  await assert.rejects(
    runtime.prepareInitialSkills(f.record()),
    /Interrupted seed retention/,
  );
  assert.deepEqual(f.read(), birth);
  assert.deepEqual(f.deliveries, []);
  fail = false;
  await runtime.prepareInitialSkills(f.record());
  assert.equal(initializations, 2);
  assert.deepEqual(f.read(), birth);
  assert.deepEqual(f.deliveries, []);
});

Deno.test("Empty-seed Request preparation stays inert and seeded models require their scoped initializer", async () => {
  let initializations = 0;
  const empty = await fixture(undefined, {
    initialize() {
      initializations++;
      return Promise.resolve();
    },
  });
  await empty.factory().prepareInitialSkills(empty.record());
  assert.equal(initializations, 0);
  const seeded = await fixture();
  seeded.addInitialSkill();
  await assert.rejects(
    seeded.factory().prepareInitialSkills(seeded.record()),
    /initial skill initializer is unavailable/,
  );
  assert.equal(seeded.read().revision, 0);
  assert.deepEqual(seeded.deliveries, []);
});

Deno.test("inert durable Request read works after active handle closure and starts no delivery", async () => {
  const f = await fixture();
  const runtime = f.factory();
  await runtime.provision(f.record());
  const before = f.read();
  f.close();
  assert.deepEqual(await f.factory().read(f.record()), before);
  assert.deepEqual(f.read(), before);
  assert.deepEqual(f.deliveries, []);
  f.sourceFailure(true);
  await assert.rejects(
    () => f.factory().read(f.record()),
    /Source unavailable/,
  );
});

Deno.test("continued Request message uses the real registry and existing exact scoped dispatch", async () => {
  const f = await fixture();
  const runtime = f.factory();
  await runtime.provision(f.record());
  f.markDispatched();
  const before = f.read();
  const command = {
    agentId: "operator",
    caseId: "case",
    text: "Continue this Request",
    expectedRevision: before.revision,
  };
  assert.equal(await runtime.submitHuman(f.record(), command), "case");
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].kind, "contribution");
  assert.deepEqual(f.deliveries[0].identity.scope, {
    kind: "request",
    scopeId: "case",
    rootRequestId: "case",
  });
  assert.deepEqual(f.deliveries[0].modelPin, {
    modelDigest: before.executionModel!.version.digest,
    repositoryVersion: before.executionModel!.version.repositoryVersion,
  });
  assert.ok(
    f.deliveries[0].payload,
    "The accepted contribution retains its payload",
  );
  assert.equal(f.deliveries[0].payload.text, command.text);
  assert.deepEqual(f.read().cases, before.cases);
  await assert.rejects(
    () => runtime.submitHuman(f.record(), { ...command, agentId: "peer" }),
    /unavailable/,
  );
  await assert.rejects(
    () =>
      runtime.submitHuman(f.record(), {
        ...command,
        expectedRevision: before.revision + 1,
      }),
    /conversation/i,
  );
  assert.equal(f.deliveries.length, 1);
});

Deno.test("closed Request history remains readable when host execution and active runtime access are unavailable", async () => {
  const f = await fixture();
  await f.factory().provision(f.record());
  f.closeCaseState();
  f.disableExecutionHost();
  f.close();
  const before = f.read(),
    writes = f.stateWrites(),
    executableReads = f.modelReads();
  const result = await f.factory().read(f.record());
  assert.equal(result.cases![0].status, "closed-done");
  assert.deepEqual(result, before);
  assert.deepEqual(f.read(), before);
  assert.equal(f.stateWrites(), writes);
  assert.equal(
    f.modelReads(),
    executableReads,
    "historical GET must not invoke the executable source path",
  );
  assert.equal(f.inspectionReads(), 1);
  assert.deepEqual(f.deliveries, []);
});

Deno.test("continued Request POST retains fresh executable-host preflight with a cached runtime", async () => {
  const f = await fixture();
  const runtime = f.factory();
  await runtime.provision(f.record());
  f.markDispatched();
  f.disableExecutionHost();
  const before = f.read(),
    writes = f.stateWrites(),
    executableReads = f.modelReads();
  await assert.rejects(() =>
    runtime.submitHuman(f.record(), {
      agentId: "operator",
      caseId: "case",
      text: "Continue exact Request",
      expectedRevision: before.revision,
    }), /host execution is unavailable/);
  assert.equal(f.inspectionReads(), 1);
  assert.equal(f.modelReads(), executableReads + 1);
  assert.equal(f.stateWrites(), writes);
  assert.deepEqual(f.read(), before);
  assert.deepEqual(f.deliveries, []);
});

Deno.test("Restart preserves B0 runtime when the admitted source advances; loss of retained B0 refuses", async () => {
  const f = await fixture(), initial = f.factory();
  await initial.provision(f.record());
  const birth = f.read();
  await f.factory().provision(f.record());
  assert.deepEqual(f.read(), birth);
  f.branchRetainsBase(false);
  await assert.rejects(
    () => f.factory().read(f.record()),
    /retained base unavailable/,
  );
  assert.deepEqual(f.read(), birth);
});

Deno.test("Request runtime retains B0 and bound R across pending source publication, warm and cold reconstruction", async () => {
  const f = await fixture(), runtime = f.factory();
  const birth = f.record().base!.manifest.source!, b0 = birth.sourceVersion;
  // Current-source consultation remains refused while an unadmitted descendant
  // is physically published. Runtime must use its separate retention proof.
  f.options.branches.assertVersion = () =>
    Promise.reject(new Error("Source publication is pending admission"));
  await runtime.provision(f.record());
  assert.deepEqual(f.retainedChecks, [b0]);
  f.admit();
  f.options.executionBindings = {
    read: () => {
      const state = f.read(), model = state.executionModel!;
      const adopted = model.version.repositoryVersion !== b0;
      return Promise.resolve({
        state,
        pin: {
          source: parseModelRevisionRef({
            repositoryId: birth.repositoryId,
            version: model.version.repositoryVersion!,
          }),
          modelDigest: model.version.digest,
          sourceAdmission: {
            revision: adopted ? 2 : 1,
            manifestDigest: "c".repeat(64),
          },
          adoption: adopted
            ? {
              commandId: "adoption",
              receiptDigest: "d".repeat(64),
              committedRuntimeRevision: state.revision,
            }
            : null,
        },
        admission: {
          ...f.admission,
          revision: adopted ? 1 : 0,
          permissions: {
            ...f.admission.permissions,
            sourceVersion: model.version.repositoryVersion!,
            modelDigests: [model.version.digest],
          },
        },
      });
    },
  };
  await runtime.restoreInstructionAdoption(f.record());
  // R == B0 needs no duplicate retained check after the birth proof.
  assert.deepEqual(f.retainedChecks, [b0, b0]);
  const state = f.read(), currentModel = f.model();
  const r1 = `commit:${"e".repeat(40)}`;
  currentModel.version.repositoryVersion = r1;
  currentModel.version.digest = "f".repeat(64);
  state.executionModel = currentModel;
  state.revision += 2;
  f.changeState(state);
  f.options.resolveExecutionModel = () =>
    Promise.resolve(structuredClone(currentModel));
  const writes = f.stateWrites();
  for (const target of [runtime, runtime, f.factory()]) {
    const start = f.retainedChecks.length;
    await target.restoreInstructionAdoption(f.record());
    assert.deepEqual(f.retainedChecks.slice(start), [b0, r1]);
    assert.equal(f.read().executionModel!.version.repositoryVersion, r1);
    assert.equal(f.stateWrites(), writes);
  }
  f.unavailableRetainedVersions.add(r1);
  await assert.rejects(
    () => runtime.restoreInstructionAdoption(f.record()),
    /Request retained base unavailable/,
  );
  assert.equal(f.stateWrites(), writes);
  assert.deepEqual(f.deliveries, []);
});

Deno.test("Absent execution binding cannot restore persisted R1 as B0, warm or cold", async () => {
  const f = await fixture(), warm = f.factory();
  await warm.provision(f.record());
  f.admit();
  const state = f.read();
  state.executionModel!.version.repositoryVersion = `commit:${"e".repeat(40)}`;
  state.executionModel!.version.digest = "f".repeat(64);
  state.revision += 2;
  f.changeState(state);
  const writes = f.stateWrites();
  assert.equal(f.options.executionBindings, undefined);
  for (const runtime of [warm, f.factory()]) {
    await assert.rejects(
      () => runtime.restoreInstructionAdoption(f.record()),
      /birth differs|cached execution pin changed/,
    );
    assert.deepEqual(f.read(), state);
    assert.equal(f.stateWrites(), writes);
    assert.deepEqual(f.deliveries, []);
  }
});

Deno.test("member rehydration keeps its birth membership after an independently adopted network change", async () => {
  const f = await fixture(), warm = f.factory();
  await f.addTeamMember();
  await warm.provision(f.record());
  f.admit();
  await warm.provision(f.record());
  const born = structuredClone(f.memberModel());
  const advanced = structuredClone(born);
  advanced.configuration.network = { allowedHosts: ["docs.example.org"] };
  advanced.version = {
    ...advanced.version,
    digest: "e".repeat(64),
    repositoryVersion: `commit:${"e".repeat(40)}`,
  };
  const saved = f.memberRead()!;
  saved.executionModel = advanced;
  saved.configuration!.network = structuredClone(
    advanced.configuration.network,
  );
  await f.memberStore.save(saved, saved.revision);
  const admission = structuredClone(f.admission);
  admission.revision++;
  admission.permissions.modelDigests[1] = advanced.version.digest;
  f.options.executionBindings = {
    read: () =>
      Promise.resolve({
        state: f.read(),
        admission,
        pin: {
          source: parseModelRevisionRef({
            repositoryId: f.record().base!.manifest.source!.repositoryId,
            version: f.model().version.repositoryVersion!,
          }),
          modelDigest: f.model().version.digest,
          sourceAdmission: { revision: 1, manifestDigest: "a".repeat(64) },
          adoption: null,
        },
      }),
  };
  f.options.resolveTeamModels = () => Promise.resolve([f.model(), advanced]);
  // The resolver supplies the journal-proved creation image, not today's rights.
  const births = new Map([["member", born]]);
  f.options.resolveTeamCreationModels = () => Promise.resolve(births);
  for (const runtime of [warm, f.factory()]) {
    await runtime.restoreInstructionAdoption(f.record());
    const [member] = await runtime.readTeam(f.record());
    assert.deepEqual(member.executionModel, advanced);
    assert.deepEqual(await runtime.unavailableTeamMembers(f.record()), []);
  }
  for (const tamper of ["expanded-provision", "foreign-identity"] as const) {
    const forged = structuredClone(born);
    if (tamper === "expanded-provision") {
      forged.configuration.network = { allowedHosts: ["docs.example.org"] };
    } else forged.identity.systemId = "foreign-system";
    births.set("member", forged);
    await assert.rejects(
      () => f.factory().restoreInstructionAdoption(f.record()),
      /missing from the verified team|creation identity/,
      tamper,
    );
  }
});

Deno.test("admitted Request space opens its verified team member and reads its state; human input stays with the BO", async () => {
  const f = await fixture(), runtime = f.factory();
  await f.addTeamMember();
  await runtime.provision(f.record());
  assert.equal(f.memberRead(), null);
  f.admit();
  await runtime.enqueue(f.record(), f.admission);
  const member = f.memberRead();
  assert.equal(member?.executionModel?.identity.builderId, "member");
  assert.equal(member?.executionModel?.operatorTeam?.requestId, "case");
  // The member's runtime is its Request-space runtime: its information
  // scope (declared reads, memory, skills) binds this exact identity.
  assert.equal(member?.id, `request:${f.record().executionSpaceId}:member`);
  const team = await runtime.readTeam(f.record());
  assert.equal(team.length, 1);
  assert.equal(team[0]?.executionModel?.identity.builderId, "member");
  const requester = {
    projectId: member!.executionModel!.identity.projectId,
    systemId: member!.executionModel!.identity.systemId,
    executionSpaceId: f.record().executionSpaceId,
    operatorId: "member",
  };
  assert.equal((await runtime.read(f.record(), requester)).id, member!.id);
  await runtime.assertExecuting(f.record(), member!.executionModel!);
  await assert.rejects(() =>
    runtime.assertExecuting(f.record(), {
      ...member!.executionModel!,
      version: { ...member!.executionModel!.version, digest: "f".repeat(64) },
    }), /executing model/);
  assert.equal(
    await runtime.withInstructionAdoptionReservation(
      f.record(),
      "member-adoption",
      ({ runtime: selected, stores }) => {
        assert.equal(selected.snapshot.id, member!.id);
        assert.equal(stores.scope.operatorId, "member");
        return Promise.resolve(selected.snapshot.id);
      },
      requester,
    ),
    member!.id,
  );
  await assert.rejects(
    () => runtime.read(f.record(), { ...requester, systemId: "foreign" }),
    /target/,
  );
  await assert.rejects(
    () => runtime.read(f.record(), { ...requester, operatorId: "unadmitted" }),
    /target/,
  );
  await assert.rejects(
    () =>
      runtime.submitHuman(f.record(), {
        agentId: "member",
        caseId: "case",
        text: "hello",
        expectedRevision: 0,
      } as never),
    /unavailable/,
  );
  const wrongSource = f.memberRead()!;
  wrongSource.executionModel!.version.repositoryVersion = `commit:${
    "f".repeat(40)
  }`;
  await f.memberStore.save(wrongSource, wrongSource.revision);
  assert.equal(
    (await runtime.readTeam(f.record())).length,
    0,
    "a matching digest cannot replace the member's exact executed source",
  );
});

Deno.test("a member proposes through its exact Request preview and authority lifecycle", async () => {
  const f = await fixture();
  f.branchId("22222222-2222-4222-8222-222222222222");
  await f.addTeamMember(60);
  f.admit();
  const native = createTestNativeExecution({
    ...f.memberStore,
    close: () => Promise.resolve(),
  });
  const caseSpace = f.options.storage.caseSpace.bind(f.options.storage);
  f.options.storage.caseSpace = async (...args) => {
    const space = await caseSpace(...args);
    return {
      ...space,
      operator: async (operatorId) => {
        const stores = await space.operator(operatorId);
        return operatorId === "member"
          ? {
            ...stores,
            state: native.store,
            budget: {
              load: () => Promise.resolve(null),
              save: () => {
                throw new Error("No budget policy is bound in this fixture");
              },
            },
          } as unknown as typeof stores
          : stores;
      },
    };
  };
  f.options.native.forCaseSpace = () => Promise.resolve(native as never);
  const dependencies = f.options.dependencies;
  f.options.dependencies = (...args) => ({
    ...dependencies(...args),
    agents: {
      label: "member-network-proposal",
      decide: () =>
        Promise.resolve({
          kind: "propose_mandate_change",
          text: "Request the exact host",
          reason: "Read the Case source",
          requestedRights: { addNetworkHosts: ["docs.example.org"] },
        }),
      review: () => {
        throw new Error("No review expected");
      },
    },
  });
  const previews: Array<
    {
      opening: OpeningRecord;
      model: unknown;
      change: PendingChange;
      teamSize?: number;
    }
  > = [];
  f.options.networkChanges = {
    prepare: async (opening, model, change, teamSize) => {
      previews.push(structuredClone({ opening, model, change, teamSize }));
      return {
        diff: {
          ...await emptyChangePreview(
            model.identity,
            change,
            model.version.digest,
          ),
          files: [{
            path: "model.sysml",
            kind: "changed",
            additions: 1,
            deletions: 1,
          }],
          patch: "exact member network diff",
          sourceDigest: "e".repeat(64),
          additions: 1,
          deletions: 1,
          base: {
            repositoryVersion: model.version.repositoryVersion!,
            modelDigest: model.version.digest,
            sourceDigest: "d".repeat(64),
          },
        },
        changes: [],
        expectedVersion: model.version.repositoryVersion!,
        proposalIntentDigest: "e".repeat(64),
      };
    },
  };
  const bound: SystemRuntime[] = [],
    recovered: string[] = [],
    proposed: PendingChange[] = [];
  f.options.bindRequestAuthority = (opening, runtime) => {
    assert.deepEqual(opening, f.record());
    bound.push(runtime);
    runtime.bindOperatorAuthorityLifecycle({
      proposed: (change) => {
        proposed.push(structuredClone(change));
        return Promise.resolve();
      },
      approved: () => Promise.resolve(),
      closed: () => Promise.resolve(),
    });
  };
  f.options.recoverRequestAuthority = (_opening, runtime) => {
    recovered.push(runtime.snapshot.executionModel!.identity.builderId);
    if (runtime.snapshot.executionModel!.identity.builderId === "member") {
      native.bind(runtime);
    }
    return Promise.resolve();
  };
  await f.factory().provision(f.record());
  const member = bound.find((runtime) =>
    runtime.snapshot.executionModel?.identity.builderId === "member"
  );
  assert.ok(
    member,
    "the admitted member must receive the same authority lifecycle binding as the BO",
  );
  assert.deepEqual(recovered, ["operator", "member"]);
  const model = member.snapshot.executionModel!;
  await member.submitWork({
    text: "Read docs for this Case",
    correlationId: "member-network",
    proof: {
      callerId: "operator",
      invocationId: "member-network-invocation",
      caseId: "case",
      caseContext: {
        caseId: "case",
        number: 7,
        record: f.read().cases![0],
        modelPin: { digest: f.model().version.digest },
      },
      modelVersion: {
        digest: f.model().version.digest,
        repositoryVersion: f.model().version.repositoryVersion!,
      },
      behavior: {
        id: "member-inbox",
        name: "Inbox",
        description: "Case work",
        callerNativeId: "operator",
        targetNativeId: "member",
        targetTypeId: "inbox-type",
        inputTypeId: "input",
        inputSchema: { type: "object" },
        sourceIds: [],
      },
    },
  });
  await native.idle();
  assert.equal(member.snapshot.error, undefined);
  assert.equal(previews.length, 1, JSON.stringify(member.snapshot.messages));
  assert.deepEqual(previews[0].opening, f.record());
  assert.deepEqual(previews[0].model, model);
  assert.equal(previews[0].teamSize, 1);
  assert.equal(previews[0].change.requestedBy, "member");
  assert.equal(previews[0].change.caseId, "case");
  assert.equal(previews[0].change.baseModelDigest, model.version.digest);
  assert.equal(proposed.length, 1);
  assert.deepEqual(
    proposed[0],
    member.snapshot.configuration!.changes.find((change) =>
      change.id === proposed[0].id
    ),
  );
  assert.equal(proposed[0].status, "pending");
  assert.equal(
    f.read().configuration!.changes.some((change) =>
      change.id === proposed[0].id
    ),
    false,
  );
  const main = f.read();
  main.id = "main-runtime";
  main.executionModel!.operatorAuthorityPolicies = [{
    id: "member-network",
    revision: 1,
    elementId: "member-network-native",
    sourceIds: ["member-network-native"],
    rootAuthority: structuredClone(main.executionModel!.ownerAuthority!),
    holderNativeId: "operator",
    mandateNativeId: "operator-mandate",
    systemId: main.executionModel!.identity.systemId,
    enabled: true,
    recipients: ["member"],
    recipientExecutionSpaceId: "space",
    acts: ["addNetworkHosts"],
    networkHosts: ["docs.example.org"],
    toolIds: [],
    maxDelegationDepth: 0,
  }];
  const space = {
    projectId: model.identity.projectId,
    systemId: model.identity.systemId,
    executionSpaceId: "space",
  };
  const change = proposed[0];
  const facts = {
    opening: f.record(),
    admission: f.admission,
    request: member.snapshot,
    states: [f.read(), member.snapshot],
    main,
    space,
    change,
  };
  const route = requestAuthorityRoute({
    space,
    requester: member.snapshot,
    states: facts.states,
    change,
    root: {
      kind: "verified-opening",
      openingId: f.record().id,
      parent: {
        space: mainExecutionSpace(main.executionModel!.identity),
        state: main,
      },
    },
  });
  const envelope = buildRequestDelegatedAuthority({
    ...facts,
    route,
    destination: {
      v: 1,
      kind: "request",
      repositoryId: f.record().base!.manifest.source!.repositoryId,
      host: f.record().scope,
      openingId: f.record().id,
      caseId: "case",
      executionSpaceId: "space",
      branchId: f.record().branchId!,
      ref: `refs/heads/requests/${f.record().branchId}`,
      expectedAdmittedSource: {
        revision: 1,
        source: parseModelRevisionRef({
          repositoryId: f.record().base!.manifest.source!.repositoryId,
          version: model.version.repositoryVersion!,
        }),
        sourceDigest: "d".repeat(64),
      },
    },
    origin: {
      effectKey: "member-authority-effect",
      inputMessageId: "member-authority-input",
    } as never,
    capturedAt: "2026-11-02T00:00:00Z",
  });
  const before = member.snapshot;
  const decision = await member.withEvolutionReservation(
    "member-decision",
    async () =>
      member.recordRequestNetworkDecision({
        reservationId: "member-decision",
        caseId: "case",
        openingId: f.record().id,
        executionSpaceId: "space",
        changeId: change.id,
        expectedRevision: before.revision,
        configurationRevision: change.baseRevision,
        proposalIntentDigest: await requestNetworkProposalDigest(change),
        verdict: "approve",
        authority: envelope,
        policyModel: main.executionModel!,
      }, (next, expected) => native.store.save(next, expected)),
  );
  assert.equal(decision.status, "approved");
  assert.equal(
    member.snapshot.requestNetworkDecisions![change.id].authority!.kind,
    "delegated",
  );
  assert.equal(
    f.read().configuration!.changes.some((entry) => entry.id === change.id),
    false,
  );
});

Deno.test("branch team verifies a member's child from that member's durable creation receipt", async () => {
  const f = await fixture();
  await f.addTeamMember();
  const member = f.memberModel();
  const { legacyOwnerAuthority } = await import(
    "../../../domain/governance/authority.ts"
  );
  const { creationAuthorityExercise } = await import(
    "../../../domain/governance/policies/operator-creation-policy.ts"
  );
  const policy = {
    id: "member-create",
    revision: 1,
    elementId: "member-create-element",
    sourceIds: ["member-create-element"],
    holderNativeId: "member",
    mandateNativeId: "member-mandate",
    systemId: member.identity.systemId,
    enabled: true,
    rootAuthority: {
      ...legacyOwnerAuthority(member.identity.systemId),
      ownerSource: "modeled" as const,
    },
    networkHosts: [],
    maxChildren: 3,
    maxDelegationDepth: 1,
    children: [] as string[],
  };
  member.operatorCreationPolicies = [policy];
  const change: PendingChange = {
    id: "member-creates-child",
    kind: "operator-creation",
    role: "operator",
    name: "Child",
    status: "approved",
    requestedBy: "member",
    caseId: "case",
    teamOrigin: { operatorId: "operator", requestId: "case" },
    baseRevision: member.configuration.revision,
    requestedAt: "2026-11-02T00:00:00Z",
    decidedAt: "2026-11-02T00:00:01Z",
    reason: "Help with Case",
    authority: "builder",
    operator: {
      kind: "request-team-member",
      instruction: "Help this member",
      provision: {
        budget: { maxAgentDecisions: 1, maxToolProposals: 0, maxFlowSteps: 1 },
        networkHosts: [],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
        mayAddNetworkHosts: true,
      },
    },
  };
  change.authorityExercise = creationAuthorityExercise(member, change, {
    actorId: "member",
    policyId: policy.id,
    policyRevision: 1,
  }, {
    space: {
      projectId: member.identity.projectId,
      systemId: member.identity.systemId,
      executionSpaceId: "space",
    },
    branchTeamSize: 1,
    currentCaseId: "case",
  });
  policy.children.push("child-system");
  f.admit();
  const runtime = f.factory();
  await runtime.provision(f.record());
  const parentState = f.memberRead()!;
  parentState.configuration!.changes.push(change);
  await f.memberStore.save(parentState, parentState.revision);
  const child = structuredClone(member);
  child.identity.builderId = "child";
  child.identity.systemId = "child-system";
  child.ownerAuthority!.systemId = "child-system";
  child.version.digest = "d".repeat(64);
  child.operator!.instruction = "Help this member";
  child.operatorTeam = {
    parentOperatorId: "member",
    requestOwnerId: "operator",
    requestId: "case",
    creationPolicyId: policy.id,
  };
  delete child.operatorCreationPolicies;
  child.configuration.changes = [];
  f.addTeamState(child, {
    ...structuredClone(parentState),
    id: "child-runtime",
    model: child.identity,
    executionModel: child,
    configuration: child.configuration,
  });
  f.admission.permissions.operatorIds.push("child");
  f.admission.permissions.modelDigests.push(child.version.digest);
  assert.deepEqual(
    (await runtime.readTeam(f.record())).map((state) =>
      state.executionModel!.identity.builderId
    ),
    ["child", "member"],
  );
  assert.deepEqual(
    member.configuration.changes,
    [],
    "the receipt exists only in durable member state",
  );
});

Deno.test("owner changes deduplicate on the change id across bound and resumed copies", () => {
  const change = {
    id: "create-member",
    kind: "operator-creation",
    status: "approved",
  } as never;
  const resumed = {
    ...(change as object),
    publishedCommit: "commit:x",
  } as never;
  const changes = ownerChangesOf(
    { configuration: { changes: [change] } },
    { configuration: { changes: [resumed] } },
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.id, "create-member");
});

Deno.test("an empty branch team leaves the BO runtime exactly as without a space registry", async () => {
  const f = await fixture(), runtime = f.factory();
  const captured: unknown[] = [];
  f.options.bindRequestAuthority = (_record, bound) => {
    captured.push(bound);
  };
  await runtime.provision(f.record());
  f.markDispatched();
  const before = f.read();
  assert.equal(
    await runtime.submitHuman(f.record(), {
      agentId: "operator",
      caseId: "case",
      text: "Continue exact Request",
      expectedRevision: before.revision,
    }),
    "case",
  );
  assert.equal(f.deliveries.length, 1);
  assert.equal(captured.length, 1);
  // No registry is bound to the BO: delegated publication, Case close and
  // Case resume keep their direct pre-team paths.
  assert.equal(
    (captured[0] as { operatorRegistry?: unknown }).operatorRegistry,
    undefined,
  );
  assert.deepEqual(await runtime.unavailableTeamMembers(f.record()), []);
});

Deno.test("a member that fails to open is reported unavailable and never blocks the BO", async () => {
  const f = await fixture(), runtime = f.factory();
  await f.addTeamMember();
  await runtime.provision(f.record());
  f.failMemberOpen();
  f.admit();
  await runtime.enqueue(f.record(), f.admission);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.read().executionModel?.identity.builderId, "operator");
  assert.equal(f.memberRead(), null);
  assert.deepEqual(await runtime.unavailableTeamMembers(f.record()), [{
    operatorId: "member",
    code: "MEMBER_UNAVAILABLE",
  }]);
});

Deno.test("4.8d D3: a Request opened by the Main Operator is born opened by it, in the person's space", async () => {
  const f = await fixture();
  const record = f.record();
  equal(requestSpaceSeed(record).openedBy, record.ownerId);
  const opened: OpeningRecord = {
    ...record,
    command: {
      ...record.command,
      opener: {
        operator: {
          ...requestSpaceScope,
          executionSpaceId: "main",
          operatorId: "operator",
        },
        origin: {
          conversationId: "main-runtime",
          designerScopeId: "main:designer",
          openingId: "mo-opening",
        },
      },
    },
  };
  const seed = requestSpaceSeed(opened);
  equal(seed.openedBy, "operator");
  equal(seed.text, record.command.text);
});

Deno.test("4.8d D3: the Main Operator's opening text is its own input, never the person's", async () => {
  const f = await fixture(), runtime = f.factory();
  const person = f.record();
  await runtime.provision(person);
  f.admit();
  await runtime.enqueue(person, f.admission);
  equal(f.deliveries[0].payload!.origin, "human");
  const opener = {
    operator: {
      ...requestSpaceScope,
      executionSpaceId: "main",
      operatorId: "operator",
    },
    origin: {
      conversationId: "main-runtime",
      designerScopeId: "main:designer",
      openingId: "mo-opening",
    },
  };
  // The same delivery shape, authored by an operator: its URLs are never
  // the person's selection, and its hosts follow the network route.
  const delivery = requestSpaceInitialDelivery(
    { ...person, command: { ...person.command, opener } },
    f.deliveries[0].modelPin,
  );
  equal(delivery.payload!.origin, "delegation");
  equal(delivery.payload!.text, person.command.text);
});

Deno.test("Human refusal preparation keeps the BO target before its decision commits", async () => {
  const f = await fixture(), runtime = f.factory();
  const record = f.record();
  await runtime.provision(record);
  const state = f.read(), model = state.executionModel!;
  const pending: PendingChange = {
    id: "human-network-refusal",
    kind: "mandate-change",
    status: "pending",
    baseRevision: model.configuration.revision,
    baseModelDigest: model.version.digest,
    requestedAt: "2026-10-30T00:00:00.000Z",
    reason: "network",
    requestedBy: record.base!.requestOwner.operatorId,
    caseId: record.caseId,
    requestedRights: { addNetworkHosts: ["example.org"] },
    diff: {
      title: "Network",
      author: "owner",
      base: {
        repositoryVersion: model.version.repositoryVersion!,
        modelDigest: model.version.digest,
        sourceDigest: "c".repeat(64),
      },
      sourceDigest: "d".repeat(64),
      files: [],
      patch: "",
      additions: 1,
      deletions: 1,
    },
  };
  state.configuration!.changes.push(pending);
  f.changeState(state);
  const refused = {
    ...pending,
    status: "refused" as const,
    authority: "human" as const,
    decidedAt: "2026-10-30T00:01:00.000Z",
  };
  const decision = {
    openingId: record.id,
    executionSpaceId: record.executionSpaceId,
    caseId: record.caseId,
    commandId: pending.id,
    expectedRevision: state.revision,
    configurationRevision: pending.baseRevision,
    proposalIntentDigest: await requestNetworkProposalDigest(pending),
    verdict: "refuse" as const,
  };
  let inspectedTarget: unknown;
  f.options.waitingRuns.read = (scope, target) => {
    inspectedTarget = { scope, target };
    return Promise.resolve([]);
  };
  // The real decision adapter prepares the wake before committing the refused
  // state. With no durable checkpoint, preparation must reach the BO wait
  // lookup and report retryable unavailability, rather than reject the decision.
  await assert.rejects(
    runtime.prepareNetworkRefusal(record, refused, decision),
    (error: unknown) =>
      error instanceof RequestSpaceError && error.code === "UNAVAILABLE",
  );
  assert.deepEqual(inspectedTarget, {
    scope: {
      ...record.scope,
      executionSpaceId: record.executionSpaceId,
      operatorId: record.base!.requestOwner.operatorId,
    },
    target: undefined,
  });
  assert.deepEqual(f.read(), state);
  await assert.rejects(
    runtime.networkRefusalStatus(record, refused, decision),
    /recorded Request refusal target changed/,
  );
  const changed = structuredClone(state);
  changed.configuration!.changes[0].reason = "different proposal";
  f.changeState(changed);
  await assert.rejects(
    runtime.prepareNetworkRefusal(record, refused, decision),
    /recorded Request refusal target changed/,
  );
});

Deno.test("4.8d D4: a refusal the MO decided under its mandate continues like the person's", async () => {
  const f = await fixture(), runtime = f.factory();
  const record = f.record();
  await runtime.provision(record);
  const model = f.read().executionModel!;
  const refused = {
    id: "network-change",
    kind: "mandate-change" as const,
    status: "refused" as const,
    authority: "builder" as const,
    baseRevision: model.configuration.revision,
    baseModelDigest: model.version.digest,
    requestedAt: "2026-10-30T00:00:00.000Z",
    decidedAt: "2026-10-30T00:01:00.000Z",
    reason: "network",
    requestedBy: record.base!.requestOwner.operatorId,
    caseId: record.caseId,
    requestedRights: { addNetworkHosts: ["example.org"] },
    diff: {
      title: "Network",
      author: "owner",
      base: {
        repositoryVersion: model.version.repositoryVersion!,
        modelDigest: model.version.digest,
        sourceDigest: "c".repeat(64),
      },
      sourceDigest: "d".repeat(64),
      files: [],
      patch: "",
      additions: 1,
      deletions: 1,
    },
  };
  const decision = {
    openingId: record.id,
    executionSpaceId: record.executionSpaceId,
    caseId: record.caseId,
    commandId: refused.id,
    expectedRevision: 1,
    configurationRevision: refused.baseRevision,
    proposalIntentDigest: await requestNetworkProposalDigest(refused),
    verdict: "refuse" as const,
  };
  // A builder refusal without the MO's delegated receipt is not a decision.
  await assert.rejects(
    () => runtime.networkRefusalStatus(record, refused, decision),
    /refusal differs/,
  );
  const delegated = {
    ...refused,
    authorityExercise: {
      delegation: { actorId: "operator" },
    } as unknown as PendingChange["authorityExercise"],
  };
  const saved = f.read();
  saved.configuration!.changes.push(delegated);
  saved.requestNetworkDecisions = { [delegated.id]: decision };
  f.changeState(saved);
  equal(
    await runtime.networkRefusalStatus(record, delegated, decision),
    "pending",
  );
  const digest = await canonicalDigest({ change: delegated, decision });
  const delivery = requestSpaceInitialDelivery(record, {
    modelDigest: model.version.digest,
    repositoryVersion: model.version.repositoryVersion,
  });
  delivery.payload!.networkRefusal = {
    changeId: delegated.id,
    proposalIntentDigest: decision.proposalIntentDigest,
    decisionDigest: digest,
    threadId: "thread",
    checkpointId: "checkpoint",
    originalInputMessageId: record.initialContributionId,
  };
  const view = await f.options.native.forCaseSpace("space", "case");
  view.dispatch.inspectAccepted = () =>
    Promise.resolve({
      delivery,
      receipt: {
        id: delivery.id,
        threadId: "thread",
        jobId: "job",
        status: "completed",
      },
    });
  // The null row still counts: cardinality refuses before parsing the other row.
  f.options.waitingRuns.read = (scope, target) => {
    assert.deepEqual(scope, {
      ...record.scope,
      executionSpaceId: record.executionSpaceId,
      operatorId: record.base!.requestOwner.operatorId,
    });
    assert.deepEqual(target, {
      threadId: "thread",
      checkpointId: "checkpoint",
    });
    return Promise.resolve([
      { snapshotJson: null },
      { snapshotJson: "{" },
    ]);
  };
  await assert.rejects(
    runtime.networkRefusalStatus(record, delegated, decision),
    /The recorded refusal wait is unavailable/,
  );
});

Deno.test("4.8d Q3: the Main Operator writes to the BO as its own input, once per resume identity", async () => {
  const f = await fixture(), runtime = f.factory();
  const record = f.record();
  await runtime.provision(record);
  f.admit();
  await runtime.enqueue(record, f.admission);
  const written = {
    resumeId: "r1",
    instruction: "Also compare page two.",
    at: "2026-10-31T01:00:00Z",
  };
  await runtime.submitFromMain(record, written, f.admission);
  await runtime.submitFromMain(record, written, f.admission);
  const sent = f.deliveries.filter((delivery) =>
    delivery.id.startsWith("main-input:")
  );
  equal(sent.length, 2, "the native queue dedupes the same identity");
  equal(sent[0].id, sent[1].id);
  equal(sent[0].payload!.origin, "delegation");
  equal(sent[0].payload!.text, written.instruction);
  await runtime.submitFromMain(
    record,
    { ...written, resumeId: "r2" },
    f.admission,
  );
  equal(
    new Set(
      f.deliveries.filter((d) => d.id.startsWith("main-input:")).map((d) =>
        d.id
      ),
    ).size,
    2,
  );
});

Deno.test("Q7 Main order to admitted member carries a crossing receipt and one BO notice", async () => {
  const f = await fixture();
  await f.addTeamMember(61);
  f.admit();
  const runtime = f.factory();
  await runtime.provision(f.record());
  const owner = f.read()!.executionModel!;
  const main = {
    ...f.read()!,
    id: "main-runtime",
    designer: { scopeId: "main-design" },
  };
  f.options.mainSnapshot = () => main;
  const opener = {
    operator: {
      projectId: owner.identity.projectId,
      systemId: owner.identity.systemId,
      executionSpaceId: "main",
      operatorId: owner.identity.builderId,
    },
    origin: {
      conversationId: "main-runtime",
      designerScopeId: "main-design",
      openingId: "order-1",
      messageId: "main-input",
    },
  };
  const written = {
    operatorId: "member",
    resumeId: "order-1",
    instruction: "Read page two",
    at: "2026-11-02T00:00:00Z",
  };
  await runtime.submitFromMain(f.record(), written, f.admission, opener);
  await runtime.submitFromMain(f.record(), written, f.admission, opener);
  const delivery = f.deliveries.find((item) =>
    item.identity.operatorId === "member"
  );
  assert.ok(delivery);
  const invocation = delivery.payload!.invocation as {
    kind: string;
    work: {
      mainOrder?: { openingId: string; caller: { executionSpaceId: string } };
      behaviorId?: string;
    };
  };
  assert.equal(invocation.kind, "delegated");
  assert.equal(invocation.work.behaviorId, undefined);
  assert.equal(invocation.work.mainOrder?.openingId, f.record().id);
  assert.equal(invocation.work.mainOrder?.caller.executionSpaceId, "main");
  const notices = f.read()!.messages.filter((item) =>
    item.operatorNotice?.kind === "subordinate-order"
  );
  assert.equal(notices.length, 1);
  await assert.rejects(() =>
    runtime.submitFromMain(
      f.record(),
      { ...written, operatorId: "forged" },
      f.admission,
      opener,
    )
  );
});

Deno.test("Request runtime closure persists the authenticated person's judgment", async () => {
  const f = await fixture();
  const runtime = f.factory();
  await runtime.provision(f.record());
  f.admit();
  const before = f.read();
  await assert.rejects(
    () => runtime.closeCase(f.record(), "done", { closedBy: "person" }),
    { code: "CASE_VERDICT_REQUIRED" },
  );
  assert.deepEqual(f.read(), before);
  await runtime.closeCase(f.record(), "done", {
    closedBy: "person",
    verdict: "accepted",
  });
  const record = f.read().cases![0];
  equal(record.status, "closed-done");
  equal(record.closedBy, "person");
  equal(record.verdict, "accepted");
  assert.deepEqual(f.deliveries, []);
});

Deno.test("Request initial outcome validates durable lifecycle and preserves concurrent closure errors", async () => {
  const f = await fixture(), runtime = f.factory();
  await runtime.provision(f.record());
  const record = f.record(), state = f.read();
  state.activeInputMessageId = record.initialContributionId;
  state.busy = false;
  state.messages.push({
    id: record.initialContributionId,
    role: "user",
    caseId: record.caseId,
    text: record.command.text,
    at: record.createdAt,
  });
  let space: unknown = {
    caseId: record.caseId,
    parentExecutionSpaceId: "main",
    lifecycle: "active",
    closedAt: null,
  };
  const reads: unknown[] = [];
  f.options.lifecycle.read = (input) => {
    reads.push(input);
    return Promise.resolve(space as never);
  };
  const active = structuredClone(space) as Record<string, unknown>;
  for (
    const invalid of [
      null,
      { ...active, caseId: "foreign" },
      { ...active, parentExecutionSpaceId: "foreign" },
      { ...active, lifecycle: "opening" },
      { ...active, closedAt: "now" },
      { ...active, lifecycle: "closed" },
    ]
  ) {
    space = invalid;
    await assert.rejects(
      runtime.initialExecutionOutcome(record, state),
      (error: unknown) =>
        error instanceof RequestSpaceError &&
        error.code === "UNAVAILABLE" &&
        error.message === "The Request execution space is unavailable",
    );
  }
  assert.deepEqual(reads[0], record);
  space = active;
  const view = await f.options.native.forCaseSpace("space", "case");
  const delivery = requestSpaceInitialDelivery(record, {
    modelDigest: state.executionModel!.version.digest,
    repositoryVersion: state.executionModel!.version.repositoryVersion!,
  });
  view.dispatch.inspectAccepted = () =>
    Promise.resolve({
      delivery,
      receipt: {
        id: delivery.id,
        threadId: "initial-thread",
        jobId: "job",
        status: "completed",
      },
    });
  view.execution.inspect = () =>
    Promise.resolve([{
      threadId: "initial-thread",
      contributionId: delivery.id,
      identity: delivery.identity,
      modelDigest: delivery.modelPin.modelDigest,
      repositoryVersion: delivery.modelPin.repositoryVersion,
      status: "refused",
      refusal: { code: "NATIVE_EXECUTION_ADMISSION_REFUSED" },
      unsettledEffects: [],
    }] as unknown as Awaited<ReturnType<typeof view.execution.inspect>>);
  assert.equal(await runtime.initialExecutionOutcome(record, state), "refused");
  const inspect = view.execution.inspect;
  view.execution.inspect = async (...args) => {
    space = { ...active, lifecycle: "closed", closedAt: "now" };
    return await inspect(...args);
  };
  assert.equal(await runtime.initialExecutionOutcome(record, state), undefined);
  let nativeReads = 0;
  f.options.native.forCaseSpace = () => {
    nativeReads++;
    return Promise.reject(new Error("Case execution space is unavailable"));
  };
  space = { ...active, lifecycle: "closed", closedAt: "now" };
  assert.equal(await runtime.initialExecutionOutcome(record, state), undefined);
  assert.equal(nativeReads, 0);
  space = active;
  await assert.rejects(
    runtime.initialExecutionOutcome(record, state),
    /Case execution space is unavailable/,
  );
  f.options.native.forCaseSpace = () => {
    space = { ...active, lifecycle: "closed", closedAt: "now" };
    return Promise.reject(new Error("Case execution space is unavailable"));
  };
  assert.equal(await runtime.initialExecutionOutcome(record, state), undefined);
  space = active;
  const failure = new Error("Native journal failed");
  f.options.native.forCaseSpace = () => {
    space = { ...active, lifecycle: "closed", closedAt: "now" };
    return Promise.reject(failure);
  };
  await assert.rejects(
    runtime.initialExecutionOutcome(record, state),
    (error: unknown) => error === failure,
  );
  assert.equal(f.stateWrites(), 1);
  assert.deepEqual(f.deliveries, []);
});

Deno.test("Request adoption continuation preserves journal, exact wait, pin and accepted replay boundaries", async () => {
  const f = await fixture(), runtime = f.factory();
  await runtime.provision(f.record());
  const record = f.record(), state = f.read(), model = state.executionModel!;
  const initial = requestSpaceInitialDelivery(record, {
    modelDigest: model.version.digest,
    repositoryVersion: model.version.repositoryVersion!,
  });
  const proof = { changeId: "change", proposalIntentDigest: "proposal" };
  state.configuration!.changes.push({
    id: "change",
    caseId: record.caseId,
    kind: "mandate-change",
    status: "approved",
    requestedBy: "operator",
  } as PendingChange);
  const intent = {
    target: {
      openingId: record.id,
      caseId: record.caseId,
      executionSpaceId: record.executionSpaceId,
      operatorId: "operator",
    },
    decision: { kind: "request-human-adoption-decision" },
    network: proof,
    team: proof,
    previous: {
      pin: {
        modelDigest: model.version.digest,
        source: { version: model.version.repositoryVersion },
      },
    },
    candidate: {
      model: { version: { digest: "c".repeat(64) } },
      source: { version: `commit:${"d".repeat(40)}` },
    },
  };
  const dossier = {
    id: "adoption",
    status: "adopted",
    intent,
    receipt: { receiptDigest: "receipt" },
  } as unknown as Parameters<
    RequestSpaceRuntime["ensureNetworkContinuation"]
  >[1];
  const adoption = {
    manifest: {
      commandId: dossier.id,
      intent,
      nativeRetirement: {
        predecessorThreadIds: ["before"],
        successorThreadIds: ["after"],
      },
    },
    receipt: dossier.receipt,
  };
  let adoptions: unknown[] = [adoption];
  const events: string[] = [];
  let rows: { snapshotJson: string | null }[] = [];
  const snapshot = {
    threadId: "before",
    checkpointId: "checkpoint",
    localState: {
      changeApprovalWait: {
        ...proof,
        identity: initial.identity,
        modelDigest: model.version.digest,
        repositoryVersion: model.version.repositoryVersion,
        inputMessageId: record.initialContributionId,
      },
    },
  };
  const validRow = () => ({ snapshotJson: JSON.stringify(snapshot) });
  let query: unknown;
  f.options.admittedSource.read = () => {
    events.push("chain");
    return Promise.resolve({ execution: { adoptions } } as never);
  };
  f.options.waitingRuns.read = (scope, target) => {
    events.push("runs");
    query = { scope, target };
    return Promise.resolve(rows);
  };
  const binding = {
    state,
    admission: f.admission,
    pin: {
      modelDigest: intent.candidate.model.version.digest,
      source: parseModelRevisionRef({
        repositoryId: "repo",
        version: intent.candidate.source.version,
      }),
      sourceAdmission: { revision: 2, manifestDigest: "e".repeat(64) },
      adoption: {
        commandId: dossier.id,
        receiptDigest: "receipt",
        committedRuntimeRevision: state.revision,
      },
    },
  };
  f.options.executionBindings = {
    read: () => {
      events.push("binding");
      return Promise.resolve(binding);
    },
  };
  const view = await f.options.native.forCaseSpace("space", "case");
  let accepted: Awaited<
    ReturnType<NonNullable<typeof view.dispatch.inspectAccepted>>
  > = null;
  view.dispatch.inspectAccepted = () => Promise.resolve(accepted);
  const continuation = () => runtime.ensureNetworkContinuation(record, dossier);
  for (
    const invalid of [[], [{
      ...adoption,
      receipt: { receiptDigest: "other" },
    }], [{ ...adoption, manifest: { ...adoption.manifest, intent: {} } }]]
  ) {
    adoptions = invalid;
    events.length = 0;
    await assert.rejects(continuation(), /network adoption journal differs/);
    assert.deepEqual(events, ["chain"]);
  }
  adoptions = [adoption];
  for (
    const invalid of [[], [{ snapshotJson: null }], [validRow(), validRow()], [{
      snapshotJson: JSON.stringify({ ...snapshot, threadId: "foreign" }),
    }], [{
      snapshotJson: JSON.stringify({
        ...snapshot,
        localState: {
          changeApprovalWait: {
            ...snapshot.localState.changeApprovalWait,
            modelDigest: "foreign",
          },
        },
      }),
    }]]
  ) {
    rows = invalid;
    await assert.rejects(
      continuation(),
      /exact retired network wait is unavailable/,
    );
  }
  rows = [{ snapshotJson: "{" }];
  await assert.rejects(continuation(), SyntaxError);
  rows = [validRow(), { snapshotJson: null }];
  binding.pin.adoption.commandId = "foreign";
  await assert.rejects(continuation(), /network adoption pin changed/);
  assert.equal(f.deliveries.length, 0);
  binding.pin.adoption.commandId = dossier.id;
  events.length = 0;
  await continuation();
  assert.deepEqual(events, ["chain", "runs", "binding"]);
  assert.deepEqual(query, {
    scope: {
      ...record.scope,
      executionSpaceId: record.executionSpaceId,
      operatorId: "operator",
    },
    target: { threadId: "before" },
  });
  const delivery = f.deliveries[0];
  assert.equal(delivery.id, "network-adoption:receipt");
  assert.deepEqual(delivery.modelPin, {
    modelDigest: intent.candidate.model.version.digest,
    repositoryVersion: intent.candidate.source.version,
  });
  assert.deepEqual(delivery.payload!.networkAdoption, {
    commandId: dossier.id,
    receiptDigest: "receipt",
    ...proof,
    predecessorThreadId: "before",
    checkpointId: "checkpoint",
    successorThreadId: "after",
    originalInputMessageId: record.initialContributionId,
  });
  accepted = {
    delivery,
    receipt: {
      id: delivery.id,
      threadId: "after",
      jobId: "job",
      status: "completed",
    },
  };
  binding.pin.adoption.commandId = "changed-after-acceptance";
  await continuation();
  assert.equal(f.deliveries.length, 1);
  accepted.receipt.threadId = "foreign";
  await assert.rejects(continuation(), /accepted network continuation differs/);
  accepted.receipt.threadId = "after";
  accepted.receipt.status = "failed";
  await assert.rejects(
    continuation(),
    (error: unknown) =>
      error instanceof RequestSpaceError && error.code === "UNAVAILABLE",
  );
  accepted = null;
  binding.pin.adoption.commandId = dossier.id;
  await runtime.ensureTeamContinuation(record, dossier);
  assert.equal(f.deliveries[1].id, "team-adoption:receipt");
  assert.deepEqual(
    f.deliveries[1].payload!.teamAdoption,
    delivery.payload!.networkAdoption,
  );
});

Deno.test("Request member delegated Case budget uses only the BO ledger", async (t) => {
  for (const adopted of [false, true]) {
    await t.step(
      adopted
        ? "adopted BO budget pays and settles the decision"
        : "missing BO adoption suspends before the LLM",
      async () => {
        const f = await fixture();
        await f.addTeamMember(60);
        f.admit();
        const native = createTestNativeExecution({
          ...f.memberStore,
          close: () => Promise.resolve(),
        });
        let ledger: WorkBudgetRecord | null = null;
        const bank = {
          load: (scopeId: string) => {
            assert.equal(scopeId, "case");
            return Promise.resolve(structuredClone(ledger));
          },
          save: (record: WorkBudgetRecord, expected: number | null) => {
            assert.equal(record.scopeId, "case");
            assert.equal(record.ownerId, "operator");
            assert.equal(ledger?.revision ?? null, expected);
            ledger = structuredClone(record);
            return Promise.resolve();
          },
        };
        let memberLedgerAccesses = 0;
        const memberBank = {
          load: () => {
            memberLedgerAccesses++;
            return Promise.resolve(null);
          },
          save: () => {
            memberLedgerAccesses++;
            throw new Error("Member ledger must not pay BO Case work");
          },
        };
        const caseSpace = f.options.storage.caseSpace.bind(f.options.storage);
        f.options.storage.caseSpace = async (...args) => {
          const space = await caseSpace(...args);
          return {
            ...space,
            operator: async (operatorId) => {
              const stores = await space.operator(operatorId);
              return {
                ...stores,
                ...(operatorId === "member" ? { state: native.store } : {}),
                budget: operatorId === "operator" ? bank : memberBank,
              };
            },
          };
        };
        f.options.native.forCaseSpace = () => Promise.resolve(native as never);
        const dependencies = f.options.dependencies;
        let decisions = 0;
        f.options.dependencies = (...args) => ({
          ...dependencies(...args),
          agents: {
            label: "budgeted-member",
            decide: () => {
              decisions++;
              return Promise.resolve({
                kind: "reply",
                text: "Case work complete",
              });
            },
            review: () => {
              throw new Error("No review expected");
            },
          },
        });
        const bound: SystemRuntime[] = [];
        f.options.bindRequestAuthority = (_opening, runtime) => {
          bound.push(runtime);
        };
        f.options.recoverRequestAuthority = (_opening, runtime) => {
          if (
            runtime.snapshot.executionModel!.identity.builderId === "member"
          ) native.bind(runtime);
          return Promise.resolve();
        };
        await f.factory().provision(f.record());
        const member = bound.find((runtime) =>
          runtime.snapshot.executionModel!.identity.builderId === "member"
        );
        assert.ok(member);
        const policy = {
          id: "bo-case-budget",
          revision: 1,
          unit: "agent-invocation" as const,
          limit: 3,
          onExhausted: "wait" as const,
          exhaustionRecipient: "local-control" as const,
        };
        const model = f.model();
        if (adopted) {
          await new WorkBudgetService(bank).adopt({
            scopeId: "case",
            ownerId: "operator",
            policy,
            previousPolicy: undefined,
            modelVersion: model.version,
          });
        }
        await member.submitWork({
          text: "Do this Case work",
          correlationId: "budgeted-work",
          proof: {
            callerId: "operator",
            invocationId: "budgeted-invocation",
            caseId: "case",
            caseContext: {
              caseId: "case",
              number: 7,
              record: f.read().cases![0],
              modelPin: { digest: model.version.digest },
              budget: { scopeId: "case", ownerId: "operator", policy },
            },
            modelVersion: {
              digest: model.version.digest,
              repositoryVersion: model.version.repositoryVersion!,
            },
            behavior: {
              id: "member-inbox",
              name: "Inbox",
              description: "Case work",
              callerNativeId: "operator",
              targetNativeId: "member",
              targetTypeId: "inbox-type",
              inputTypeId: "input",
              inputSchema: { type: "object" },
              sourceIds: [],
            },
          },
        });
        await native.idle();
        assert.equal(
          decisions,
          adopted ? 1 : 0,
          JSON.stringify(member.snapshot.budgetSuspension),
        );
        assert.equal(
          memberLedgerAccesses,
          0,
          "carried BO budget must never consult the member partition",
        );
        if (adopted) {
          const record = await new WorkBudgetService(bank).readRecord(
            "case",
            "operator",
          );
          assert.deepEqual(record.events.map((event) => event.kind), [
            "policy",
            "reserve",
            "settle",
          ]);
          const reservation = record.events[1], settlement = record.events[2];
          assert.equal(reservation.kind, "reserve");
          assert.equal(settlement.kind, "settle");
          if (reservation.kind === "reserve" && settlement.kind === "settle") {
            assert.equal(reservation.operation, "decide");
            assert.equal(settlement.attemptId, reservation.attemptId);
            assert.equal(settlement.outcome, "returned");
          }
          assert.equal(budgetState(record).view.consumed, 1);
          assert.equal(budgetState(record).view.reserved, 0);
          assert.equal(member.snapshot.budgetSuspension, undefined);
        } else {
          assert.equal(
            ledger,
            null,
            "delegation cannot adopt a missing BO policy",
          );
          assert.equal(member.snapshot.budgetSuspension?.reason, "unavailable");
        }
      },
    );
  }
});
