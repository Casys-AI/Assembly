import assert from "node:assert/strict";
import {
  artifactModel,
  publishedArtifact,
} from "../../../../test/support/tool-artifact-fixture.ts";
import { WorkBudgetService } from "../budget/service.ts";
import type { WorkBudgetRecord } from "../../../domain/work/policies/budget.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import {
  nativeExecutionIdentity,
  type NativeExecutionSnapshot,
} from "../native-execution/contract.ts";
import {
  adoptBudgetCeiling,
  assertBudgetResumeAdmission,
  bindBudgetResume,
  type BudgetCeilingAdoptionHost,
  budgetCeilingModelEquivalent,
  budgetContinuationReplayEvidence,
  completedHistoricalBudgetAwait,
  nativeBudgetCeilingAdvanceEvidence,
  planBudgetCeilingTransition,
  recordBudgetContinuationSelection,
  requireStrictBudgetCeilingIncrease,
  validateNativeBudgetCeilingAdvance,
} from "./budget-transition.ts";

async function fixture() {
  const previous = artifactModel("owner");
  previous.operator = {
    name: "Owner",
    instruction: "Do bounded work",
    primary: true,
    humanInput: true,
  };
  previous.workBudgetPolicy = {
    id: "budget",
    revision: 1,
    unit: "agent-invocation",
    limit: 0,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
    elementId: "native-budget",
    sourceIds: ["native-budget"],
  };
  const target = structuredClone(previous);
  target.workBudgetPolicy!.revision = 2;
  target.workBudgetPolicy!.limit = 2;
  target.version.digest = "raised-model";
  target.version.repositoryVersion = "commit:raised";
  const choose = previous.flows.conversation.nodes.find((node) =>
    node.mechanism === "choose_move"
  )!;
  const state: SystemRuntimeState = {
    id: "runtime",
    revision: 1,
    catalogRevision: 0,
    executionModel: previous,
    model: previous.identity,
    configuration: previous.configuration,
    provider: "test",
    phase: "waiting",
    busy: false,
    candidates: [],
    events: [],
    designer: {
      scopeId: "designer",
      budget: { budgetId: "budget", scopeId: "designer" },
    },
    caseInvocation: { kind: "designer", scopeId: "designer" },
    messages: [{
      id: "original",
      role: "user",
      text: "Work",
      at: "now",
      designerScopeId: "designer",
    }],
    activeInputMessageId: "original",
    workBudgetBinding: { budgetId: "budget", scopeId: "designer" },
    budgetSuspension: {
      nodeId: choose.id,
      operation: "decide",
      recipient: "local-control",
      reason: "exhausted",
      diagnostic: "exhausted",
      attemptId: "never-dispatched",
      dispatchStarted: false,
    },
  };
  let record: WorkBudgetRecord | null = null;
  const budget = new WorkBudgetService({
    load: () => Promise.resolve(structuredClone(record)),
    save: (next, expected) => {
      assert.equal(expected, record?.revision ?? null);
      record = structuredClone(next);
      return Promise.resolve();
    },
  });
  await budget.adopt({
    scopeId: "designer",
    ownerId: "owner",
    policy: previous.workBudgetPolicy,
    previousPolicy: undefined,
    modelVersion: previous.version,
  });
  await assert.rejects(
    () =>
      budget.reserve({
        scopeId: "designer",
        ownerId: "owner",
        policy: previous.workBudgetPolicy,
        operation: "decide",
        attemptId: "never-dispatched",
        modelVersion: previous.version,
      }),
    /exhausted/,
  );
  const snapshot: NativeExecutionSnapshot = {
    contributionId: "original",
    identity: nativeExecutionIdentity(state, "conversation", "original"),
    threadId: "thread",
    runId: "run",
    checkpointNamespace: "namespace",
    checkpointId: "checkpoint",
    modelDigest: previous.version.digest,
    repositoryVersion: previous.version.repositoryVersion,
    flowRootId: previous.flows.conversation.rootNativeId,
    status: "waiting",
    waits: [{ nodeId: choose.id, kind: "budget" }],
    unsettledEffects: [],
    pendingContributions: [],
    budgetContinuationSource: {
      sourceKind: "settled-budget-wait",
      occurrenceId: choose.id,
      preparedNodeId: "prepared-choose",
      settledEffectKey: "refused-effect",
    },
  };
  const host: BudgetCeilingAdoptionHost = {
    get state() {
      return state;
    },
    ports: {
      clock: { now: () => "now" },
      workBudget: budget,
      model: {
        readExecutableModel: (_identity, version) =>
          Promise.resolve(
            structuredClone(
              version === previous.version.repositoryVersion
                ? previous
                : target,
            ),
          ),
      },
      execution: {
        inspect: () => Promise.resolve([structuredClone(snapshot)]),
        run: () => Promise.reject(new Error("Adoption must not execute")),
        closeScope: () => Promise.reject(new Error("Adoption must not close")),
        retireAndAdvance: () =>
          Promise.reject(new Error("Unfinished work must not retire")),
      },
    },
    update(change) {
      change(state);
      state.revision++;
      return Promise.resolve();
    },
  };
  const plan = () =>
    planBudgetCeilingTransition({
      state,
      previous,
      target,
      record: structuredClone(record!),
      snapshots: [snapshot],
      id: "transition",
      authorizationEventId: "authorization",
    });
  return {
    state,
    previous,
    target,
    budget,
    snapshot,
    host,
    plan,
    record: () => structuredClone(record!),
  };
}

Deno.test("budget ceiling accepts only the exact higher policy and recognized source provenance", async () => {
  const f = await fixture();
  await requireStrictBudgetCeilingIncrease(f.previous, f.target);
  for (
    const change of [
      (model: typeof f.target) => model.workBudgetPolicy!.limit = 0,
      (model: typeof f.target) => model.workBudgetPolicy!.revision = 1,
      (model: typeof f.target) => model.workBudgetPolicy!.id = "another",
      (model: typeof f.target) => model.operator!.instruction += "changed",
      (model: typeof f.target) => model.policy.maxAgentDecisions++,
      (model: typeof f.target) => model.version.configurationRevision++,
      (model: typeof f.target) => model.identity.builderId = "foreign",
      (model: typeof f.target) => delete model.version.repositoryVersion,
      (model: typeof f.target) =>
        Object.assign(model.version, { unknownProvenance: "ignored?" }),
    ]
  ) {
    const altered = structuredClone(f.target);
    change(altered);
    await assert.rejects(
      () => requireStrictBudgetCeilingIncrease(f.previous, altered),
      /BUDGET_CEILING_CONTINUATION_REFUSED/,
    );
  }
});

Deno.test("budget ceiling refuses every unexplained blocker and incomplete native source projection", async () => {
  const mutations: Array<(f: Awaited<ReturnType<typeof fixture>>) => void> = [
    (f) => f.state.budgetSuspension!.dispatchStarted = true,
    (f) => f.state.budgetSuspension!.reason = "unavailable",
    (f) => delete f.state.budgetSuspension!.attemptId,
    (f) => f.state.budgetSuspension!.attemptId = "foreign-attempt",
    (f) => f.state.budgetSuspension!.operation = "admit",
    (f) => f.state.workBudgetBinding!.scopeId = "foreign",
    (f) =>
      f.state.pendingContributions = {
        pending: {
          invocationKey: "other",
          inputMessageId: "other",
          targetOperatorId: "other",
          invocationId: "other",
          behaviorId: "other",
          status: "pending",
        },
      },
    (f) => f.snapshot.unsettledEffects.push("unknown"),
    (f) => f.snapshot.openImmutableConsultationGroups = ["unpublished"],
    (f) => f.snapshot.pendingContributions.push("pending"),
    (f) => f.snapshot.status = "uncertain",
    (f) => f.snapshot.checkpointId = undefined,
    (f) => f.snapshot.runId = undefined,
    (f) => f.snapshot.checkpointNamespace = undefined,
    (f) => f.snapshot.budgetContinuationSource = undefined,
    (f) => f.snapshot.identity.subjectId = "another-input",
    (f) => f.snapshot.identity.invocationKey = "another-invocation",
    (f) => f.snapshot.repositoryVersion = "foreign-pin",
    (f) =>
      f.snapshot.budgetContinuationSource!.sourceKind = "unconsumed-input-wait",
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    const before = f.record();
    mutate(f);
    await assert.rejects(f.plan, /BUDGET_CEILING_CONTINUATION_REFUSED/);
    assert.deepEqual(f.record(), before);
    assert.equal(f.state.events.length, 0);
  }
});

Deno.test("budget ceiling phases recover their own exact intent and policy write without dispatch or duplicate activation", async () => {
  for (const boundary of ["intent", "policy", "adoption"] as const) {
    const f = await fixture();
    const update = f.host.update.bind(f.host);
    let interrupted = false;
    f.host.update = async (change) => {
      await update(change);
      if (
        !interrupted &&
        (boundary === "intent" &&
            f.state.budgetCeilingTransition?.phase === "authorized-intent" ||
          boundary === "adoption" &&
            f.state.budgetCeilingTransition?.phase ===
              "adopted-continuations-pending")
      ) {
        interrupted = true;
        throw new Error("controlled canonical boundary");
      }
    };
    if (boundary === "policy") {
      const advance = f.budget.advanceCeiling.bind(f.budget);
      f.budget.advanceCeiling = async (input) => {
        const value = await advance(input);
        if (!interrupted) {
          interrupted = true;
          throw new Error("controlled policy boundary");
        }
        return value;
      };
    }
    const prefix = f.record();
    await assert.rejects(
      () => adoptBudgetCeiling(f.host, f.target),
      /controlled/,
    );
    await adoptBudgetCeiling(f.host, f.target);
    await adoptBudgetCeiling(f.host, f.target);
    assert.deepEqual(
      f.record().events.slice(0, prefix.revision),
      prefix.events,
    );
    assert.equal(
      f.record().events.filter((event) => event.kind === "policy").length,
      2,
    );
    assert.equal(
      f.state.budgetCeilingTransition!.phase,
      "adopted-continuations-pending",
    );
    assert.equal(
      f.state.events.filter((event) => event.kind === "effective-model-updated")
        .length,
      1,
    );
    assert.equal(
      f.state.events.filter((event) =>
        event.kind === "model-version-admission-authorized"
      ).length,
      1,
    );
    assert.equal(f.state.budgetSuspension!.attemptId, "never-dispatched");
    assert.equal(f.state.activeInputMessageId, "original");
    assert.equal(f.state.budgetCeilingTransition!.resume, undefined);
    assert.throws(
      () => assertBudgetResumeAdmission(f.state, { origin: "delegation" }),
      /only the recorded/,
    );
  }
});

Deno.test("budget ceiling resume evidence binds the new delivery to the original work and exact selected successor", async () => {
  const f = await fixture();
  await adoptBudgetCeiling(f.host, f.target);
  const transition = f.state.budgetCeilingTransition!;
  const delivery = {
    id: "new-instruction",
    kind: "contribution" as const,
    identity: {
      ...structuredClone(f.snapshot.identity),
      subjectId: "new-instruction",
    },
    modelPin: {
      modelDigest: f.target.version.digest,
      repositoryVersion: f.target.version.repositoryVersion,
    },
    payload: {
      origin: "human",
      text: "Resume",
      receivedAt: "now",
      invocation: structuredClone(f.state.caseInvocation),
    },
  };
  assert.equal(await bindBudgetResume(f.state, delivery), true);
  f.state.messages.push({
    id: delivery.id,
    role: "user",
    text: "Resume",
    at: "now",
  });
  const contribution = {
    id: delivery.id,
    kind: "resume" as const,
    inputMessageId: "original",
  };
  const member = transition.manifest.members[0];
  const evidence = await nativeBudgetCeilingAdvanceEvidence(
    f.state,
    f.record(),
    member.id,
    contribution,
  );
  assert.equal(evidence.originalContributionId, "original");
  assert.equal(evidence.resume.id, "new-instruction");
  await validateNativeBudgetCeilingAdvance(
    evidence,
    f.state,
    f.record(),
    member.identity,
    contribution,
  );
  await assert.rejects(
    () =>
      validateNativeBudgetCeilingAdvance(
        { ...evidence, originalInputMessageId: "new-instruction" },
        f.state,
        f.record(),
        member.identity,
        contribution,
      ),
    /evidence differs/,
  );
  await assert.rejects(
    () =>
      nativeBudgetCeilingAdvanceEvidence(f.state, f.record(), member.id, {
        ...contribution,
        id: "another-delivery",
      }),
    /authenticated resume/,
  );
  const receipt = {
    id: "selection",
    predecessorRunId: member.runId,
    successorRunId: "successor",
    source: {
      threadId: member.threadId,
      checkpointNamespace: member.checkpointNamespace,
      checkpointId: member.checkpointId,
      preparedNodeId: member.preparedNodeId,
      settledEffectKey: member.settledEffectKey,
    },
    evidence,
  };
  recordBudgetContinuationSelection(f.state, receipt);
  recordBudgetContinuationSelection(f.state, receipt);
  assert.equal(transition.selected.length, 1);
  assert.equal(transition.phase, "complete");
  assert.throws(
    () =>
      recordBudgetContinuationSelection(f.state, {
        ...receipt,
        successorRunId: "foreign",
      }),
    /different successor/,
  );
  const input = {
    scopeId: "designer",
    ownerId: "owner",
    policy: f.target.workBudgetPolicy,
    operation: "decide" as const,
    attemptId: "never-dispatched",
    modelVersion: f.target.version,
    ceilingTransition: {
      id: transition.manifest.id,
      manifestDigest: transition.manifestDigest,
      originRevision: transition.manifest.budget.originRevision,
      refusedAttemptId: "never-dispatched",
    },
  };
  await f.budget.reserve(input);
  await assert.rejects(() => f.budget.reserve(input), /already reserved/);
  assert.equal(
    f.record().events.filter((event) => event.kind === "reserve").length,
    1,
  );
  assert.equal(
    await executionDigest(transition.manifest),
    transition.manifestDigest,
  );
});

Deno.test("budget ceiling excludes only exactly completed historical input waits and refuses a second retained lineage", async () => {
  const f = await fixture();
  const awaiting = f.previous.flows.conversation.nodes.find((node) =>
    node.mechanism === "await_input"
  )!;
  const old = structuredClone(f.snapshot);
  old.identity.subjectId = "old-input";
  old.contributionId = "old-input";
  old.threadId = "old-thread";
  old.waits = [{
    nodeId: awaiting.id,
    mechanism: "await_input",
    kind: "input",
  }];
  old.localState = { reply: { kind: "reply", text: "Old work completed" } };
  f.state.messages.unshift({
    id: "old-input",
    role: "user",
    text: "Old work",
    at: "before",
    designerScopeId: "designer",
  }, {
    id: "old-reply",
    role: "assistant",
    text: "Old work completed",
    at: "before",
    designerScopeId: "designer",
  });
  assert.equal(completedHistoricalBudgetAwait(f.state, old), true);
  const planned = await planBudgetCeilingTransition({
    state: f.state,
    previous: f.previous,
    target: f.target,
    record: f.record(),
    snapshots: [old, f.snapshot],
    id: "intent",
    authorizationEventId: "authorization",
  });
  assert.equal(planned.manifest.members.length, 1);
  for (
    const mutate of [
      (entry: typeof old) => entry.localState = {},
      (entry: typeof old) => entry.unsettledEffects = ["unknown"],
      (entry: typeof old) => entry.openImmutableConsultationGroups = ["open"],
      (entry: typeof old) =>
        entry.localState = { reply: { kind: "reply", text: "Another reply" } },
      (entry: typeof old) => entry.waits[0].nodeId = "foreign-await",
      (entry: typeof old) => entry.flowRootId = "foreign-flow",
      (entry: typeof old) => entry.waits[0].kind = "budget",
    ]
  ) {
    const altered = structuredClone(old);
    mutate(altered);
    assert.equal(completedHistoricalBudgetAwait(f.state, altered), false);
    await assert.rejects(
      () =>
        planBudgetCeilingTransition({
          state: f.state,
          previous: f.previous,
          target: f.target,
          record: f.record(),
          snapshots: [altered, f.snapshot],
          id: "intent",
          authorizationEventId: "authorization",
        }),
      /BUDGET_CEILING_CONTINUATION_REFUSED/,
    );
  }
  // A complete technical selection still retains the historical business pins.
  f.state.budgetCeilingTransition = {
    ...planned,
    phase: "complete",
    selected: [{
      memberId: planned.manifest.members[0].id,
      receiptId: "selected",
      successorRunId: "successor",
    }],
  };
  const next = structuredClone(f.target);
  next.workBudgetPolicy!.revision++;
  next.workBudgetPolicy!.limit++;
  next.version.digest = "third-model";
  next.version.repositoryVersion = "commit:third";
  const before = f.record();
  await assert.rejects(
    () =>
      planBudgetCeilingTransition({
        state: f.state,
        previous: f.target,
        target: next,
        record: before,
        snapshots: [f.snapshot],
        id: "another",
        authorizationEventId: "another-auth",
      }),
    /second ceiling lineage/,
  );
  assert.deepEqual(f.record(), before);
});

Deno.test("budget selection replay follows only its own exact admitted catalog publication", async () => {
  const f = await fixture();
  const artifact = await publishedArtifact();
  const candidate: import("../../../domain/work/candidates.ts").Candidate =
    structuredClone(artifact.candidate);
  const admission = structuredClone(candidate.admission);
  const binding = structuredClone(candidate.binding);
  candidate.stage = "awaiting-admission";
  delete candidate.admission;
  delete candidate.binding;
  candidate.designerScopeId = "designer";
  candidate.promotionModelDigest = f.previous.version.digest;
  candidate.promotionExecution = {
    subjectId: "promotion-subject",
    inputMessageId: "original",
    modelDigest: f.previous.version.digest,
  };
  f.state.candidates.push(candidate);
  const admit = f.previous.flows.promotion.nodes.find((node) =>
    node.mechanism === "decide_admission"
  )!;
  const awaiting = f.previous.flows.conversation.nodes.find((node) =>
    node.mechanism === "await_input"
  )!;
  f.state.budgetSuspension = {
    ...f.state.budgetSuspension!,
    operation: "admit",
    candidateId: candidate.id,
    nodeId: admit.id,
  };
  let ledger = f.record();
  const refusal = ledger.events.at(-1)!;
  assert.equal(refusal.kind, "refused");
  if (refusal.kind === "refused") refusal.operation = "admit";
  f.host.ports.workBudget = new WorkBudgetService({
    load: () => Promise.resolve(structuredClone(ledger)),
    save: (next, expected) => {
      assert.equal(expected, ledger.revision);
      ledger = structuredClone(next);
      return Promise.resolve();
    },
  });
  f.snapshot.waits = [{
    nodeId: awaiting.id,
    mechanism: "await_input",
    kind: "input",
  }];
  f.snapshot.budgetContinuationSource = {
    sourceKind: "unconsumed-input-wait",
    occurrenceId: awaiting.id,
    preparedNodeId: "prepared-await",
    settledEffectKey: "unconsumed-key",
  };
  const promotion = {
    ...structuredClone(f.snapshot),
    identity: nativeExecutionIdentity(
      f.state,
      "promotion",
      "promotion-subject",
    ),
    threadId: "promotion-thread",
    runId: "promotion-run",
    flowRootId: f.previous.flows.promotion.rootNativeId,
    waits: [{
      nodeId: admit.id,
      mechanism: "decide_admission",
      kind: "budget" as const,
    }],
    budgetContinuationSource: {
      sourceKind: "settled-budget-wait" as const,
      occurrenceId: admit.id,
      preparedNodeId: "prepared-admission",
      settledEffectKey: "admission-refused",
    },
  };
  f.host.ports.execution = {
    ...f.host.ports.execution!,
    inspect: () => Promise.resolve(structuredClone([f.snapshot, promotion])),
  };
  const outerInputPlan = await planBudgetCeilingTransition({
    state: f.state,
    previous: f.previous,
    target: f.target,
    record: ledger,
    snapshots: [f.snapshot, promotion],
    id: "input-form",
    authorizationEventId: "input-authorization",
  });
  assert.equal(outerInputPlan.manifest.members.length, 2);
  const submit = f.previous.flows.conversation.nodes.find((node) =>
    node.mechanism === "submit_proposal"
  )!;
  candidate.batchCall = { batchId: "retained-batch", callId: "retained-call" };
  f.state.activeBatchCall = structuredClone(candidate.batchCall);
  f.state.budgetPromotionCandidateId = candidate.id;
  f.state.conversationBatches = [{
    id: "retained-batch",
    inputMessageId: "original",
    designerScopeId: "designer",
    invocationKey: f.snapshot.identity.invocationKey,
    modelDigest: f.previous.version.digest,
    createdAt: "now",
    sourceDecision: {},
    calls: [{
      id: "retained-call",
      status: "started",
      candidateId: candidate.id,
      decision: {
        kind: "propose_tool",
        text: "Prepare exact candidate",
        tool: {
          name: candidate.name,
          kind: candidate.kind,
          description: candidate.description,
          code: candidate.code,
        },
      },
    }],
  }];
  f.snapshot.waits = [{
    nodeId: submit.id,
    mechanism: "submit_proposal",
    kind: "budget",
  }];
  f.snapshot.budgetContinuationSource = {
    sourceKind: "settled-budget-wait",
    occurrenceId: submit.id,
    preparedNodeId: "prepared-submit",
    settledEffectKey: "parent-budget-wait",
  };
  const foreign = structuredClone(promotion);
  foreign.identity.subjectId = "another-promotion";
  await assert.rejects(
    () =>
      planBudgetCeilingTransition({
        state: f.state,
        previous: f.previous,
        target: f.target,
        record: ledger,
        snapshots: [f.snapshot, foreign],
        id: "foreign",
        authorizationEventId: "foreign-authorization",
      }),
    /unexplained native blocker/,
  );
  const ownCall = f.state.conversationBatches[0].calls[0];
  ownCall.candidateId = "foreign-candidate";
  await assert.rejects(
    () =>
      planBudgetCeilingTransition({
        state: f.state,
        previous: f.previous,
        target: f.target,
        record: ledger,
        snapshots: [f.snapshot, promotion],
        id: "foreign-call",
        authorizationEventId: "foreign-call-authorization",
      }),
    /parent budget wait/,
  );
  ownCall.candidateId = candidate.id;
  await adoptBudgetCeiling(f.host, f.target);
  const transition = f.state.budgetCeilingTransition!;
  await bindBudgetResume(f.state, {
    id: "resume",
    kind: "contribution",
    identity: { ...f.snapshot.identity, subjectId: "resume" },
    modelPin: {
      modelDigest: f.target.version.digest,
      repositoryVersion: f.target.version.repositoryVersion,
    },
    payload: {
      origin: "human",
      text: "Resume",
      receivedAt: "now",
      invocation: f.state.caseInvocation,
    },
  });
  f.state.messages.push({
    id: "resume",
    role: "user",
    text: "Resume",
    at: "now",
  });
  // Materialize the immutable accepted revision used by native evidence.
  await f.host.update(() => {});
  const accepted = structuredClone(f.state);
  const history = {
    loadRevision: (revision: number) =>
      Promise.resolve(
        revision === accepted.revision ? structuredClone(accepted) : null,
      ),
  };
  const receipts = [];
  for (const member of transition.manifest.members) {
    const evidence = await nativeBudgetCeilingAdvanceEvidence(
      f.state,
      ledger,
      member.id,
      { id: "resume", kind: "resume", inputMessageId: "original" },
    );
    const receipt = {
      id: `selection:${member.id}`,
      predecessorRunId: member.runId,
      successorRunId: `next:${member.runId}`,
      source: {
        threadId: member.threadId,
        checkpointNamespace: member.checkpointNamespace,
        checkpointId: member.checkpointId,
        preparedNodeId: member.preparedNodeId,
        settledEffectKey: member.settledEffectKey,
      },
      evidence,
    };
    recordBudgetContinuationSelection(f.state, receipt);
    receipts.push(receipt);
  }
  assert.equal(transition.phase, "complete");
  candidate.stage = "active";
  candidate.admission = admission;
  candidate.binding = binding;
  f.state.executionModel = structuredClone(f.target);
  f.state.executionModel.version.repositoryVersion =
    "commit:catalog-after-budget";
  f.state.executionModel.catalog.push({
    ...artifact.model.catalog[0],
    candidateId: candidate.id,
  });
  const activeEvent = {
    id: "published-retained-candidate",
    at: "now",
    kind: "tool-active",
    label: "Activated exact retained candidate",
    candidateId: candidate.id,
    elementId: candidate.binding!.elementId,
  };
  f.state.events.push(activeEvent);
  const receipt = receipts[0];
  assert.throws(
    () => recordBudgetContinuationSelection(f.state, receipt),
    /current owner, target or resume/,
  );
  const proof = await budgetContinuationReplayEvidence(
    f.state,
    receipt,
    f.target,
  );
  assert.ok(proof);
  assert.equal(
    await budgetCeilingModelEquivalent(
      f.state,
      f.previous.version.digest,
      f.target.version.digest,
      { candidateId: candidate.id },
      history,
    ),
    true,
  );
  assert.equal(
    await budgetCeilingModelEquivalent(
      f.state,
      f.previous.version.digest,
      f.target.version.digest,
      { candidateId: candidate.id },
    ),
    false,
  );
  recordBudgetContinuationSelection(f.state, receipt, proof);
  recordBudgetContinuationSelection(f.state, receipt, proof);
  assert.equal(transition.selected.length, 2);
  const exactSelection = transition.selected.shift()!;
  assert.throws(
    () => recordBudgetContinuationSelection(f.state, receipt, proof),
    /current owner, target or resume/,
  );
  transition.selected.unshift(exactSelection);
  const knownEvent = f.state.events.pop()!;
  assert.equal(
    await budgetCeilingModelEquivalent(
      f.state,
      f.previous.version.digest,
      f.target.version.digest,
      { candidateId: candidate.id },
      history,
    ),
    false,
  );
  await assert.rejects(
    () => budgetContinuationReplayEvidence(f.state, receipt, f.target),
    /canonical admission/,
  );
  f.state.events.push(knownEvent);
  const other = structuredClone(candidate);
  other.id = "another-publication";
  other.admission = { ...other.admission!, candidateId: other.id };
  f.state.candidates.push(other);
  f.state.executionModel.catalog = [{
    ...f.state.executionModel.catalog[0],
    candidateId: other.id,
  }];
  f.state.events.push({
    ...activeEvent,
    id: "another-event",
    candidateId: other.id,
  });
  await assert.rejects(
    () => budgetContinuationReplayEvidence(f.state, receipt, f.target),
    /outside the retained budget family/,
  );
  assert.equal(
    await budgetCeilingModelEquivalent(
      f.state,
      f.previous.version.digest,
      f.target.version.digest,
      { candidateId: candidate.id },
      history,
    ),
    false,
  );
  f.state.executionModel.catalog = [{
    ...artifact.model.catalog[0],
    candidateId: candidate.id,
  }];
  f.state.events.pop();
  const authorization = f.state.events.find((event) =>
    event.id === transition.manifest.authorizationEventId
  )!;
  authorization.authorityExercise!.mandateRevision++;
  const exactProof = await budgetContinuationReplayEvidence(
    f.state,
    receipt,
    f.target,
  );
  assert.throws(
    () => recordBudgetContinuationSelection(f.state, receipt, exactProof),
    /current owner, target or resume/,
  );
});
