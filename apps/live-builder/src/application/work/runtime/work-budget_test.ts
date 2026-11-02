import { unexpectedModelAuthoring } from "../../../../test/support/model-authoring.ts";
import { compileNativeFixtureFlows } from "../../../../test/support/execution-fixture.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { WorkBudgetRecord } from "../../../domain/work/policies/budget.ts";
import { SystemRuntime } from "../../../../test/support/system-runtime.ts";
import { createTestNativeExecution } from "../../../../test/support/native-execution.ts";
import { nativeExecutionIdentity } from "./execution.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { invocationKey } from "../operators/journal.ts";
import { designerExecutionContext } from "../cases/runtime.ts";
import type { ModelPort } from "./ports.ts";
import { WorkBudgetService } from "../budget/service.ts";
import {
  planBudgetCeilingTransition,
  verifyBudgetCeilingMemberSnapshot,
  verifyScalarBudgetCandidate,
} from "./budget-transition.ts";
import {
  type BudgetProposalCheckpoint,
  verifyScalarBudgetFamily,
} from "../../../adapters/work/runtime/native-budget-proposal.ts";

function fixture(promotion = false, reviewer = false) {
  const model = artifactModel("builder");
  model.workBudgetPolicy = {
    id: "budget",
    revision: 1,
    unit: "agent-invocation",
    limit: 2,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
    elementId: "budget-native",
    sourceIds: [],
  };
  if (reviewer) {
    model.identity.reviewerId = "reviewer-native";
    model.configuration.reviewer = {
      id: "reviewer",
      name: "Reviewer",
      mandateRevision: 1,
    };
    model.configuration.builder.admissionAuthority = "reviewer";
    model.flows = compileNativeFixtureFlows(128, "reviewer-native");
  }
  let tests = 0, reviews = 0, admissions = 0;
  let state: SystemRuntimeState | null = null;
  let record: WorkBudgetRecord | null = null;
  const records = new Map<string, WorkBudgetRecord>();
  let calls = 0, failStorage = false, unreadable = false;
  let failBeforeAck = false;
  let failFinalization = false;
  const workBudget = new WorkBudgetService({
    load: (scopeId) => {
      if (unreadable) throw new Error("unreadable ledger");
      return Promise.resolve(structuredClone(records.get(scopeId) ?? null));
    },
    save(next) {
      if (failStorage) throw new Error("disk full");
      record = structuredClone(next);
      records.set(next.scopeId, structuredClone(next));
      return Promise.resolve();
    },
  });
  const forbidden = () => {
    throw new Error("Unexpected effect");
  };
  const sourceVersions = new Map<string, typeof model>();
  const native: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize: () => Promise.resolve(structuredClone(model.identity)),
    readExecutableModel: (_identity, version) => {
      if (version !== undefined) {
        const saved = sourceVersions.get(version);
        if (!saved) throw new Error("Exact source version is unavailable");
        return Promise.resolve(structuredClone(saved));
      }
      const current = structuredClone(model);
      if (
        current.version.repositoryVersion &&
        !sourceVersions.has(current.version.repositoryVersion)
      ) {
        sourceVersions.set(
          current.version.repositoryVersion,
          structuredClone(current),
        );
      }
      return Promise.resolve(current);
    },
    applyApprovedChange: forbidden,
    activateCandidate: (_identity, candidate) => {
      const binding = {
        elementId: "native-" + candidate.id,
        graphPath: "fixture",
      };
      model.catalog.push({
        nativeId: binding.elementId,
        candidateId: candidate.id,
        contractId: model.contracts[0]!.nativeId,
        name: candidate.name,
        kind: candidate.kind,
        digest: candidate.digest,
        status: "active",
      });
      return Promise.resolve(binding);
    },
    graph: () => Promise.resolve({}),
  };
  const retained = createTestNativeExecution({
    load: () => Promise.resolve(structuredClone(state)),
    save(next, expected) {
      equal(state?.revision ?? null, expected);
      if (
        failFinalization && state?.busy && !next.busy && next.budgetSuspension
      ) {
        failFinalization = false;
        throw new Error("injected before budget work finalization");
      }
      state = structuredClone(next);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  }, workBudget);
  const create = (withBudget = true) =>
    new SystemRuntime({
      model: native,
      store: retained.store,
      stateHistory: retained.stateHistory,
      execution: retained.execution,
      dispatch: retained.dispatch,
      artifactSources: retained.artifactSources,
      agents: {
        label: "test",
        decide(context) {
          calls++;
          ok(context.workBudget);
          if (promotion && calls === 1) {
            return Promise.resolve({
              kind: "propose_tool",
              text: "Build",
              tool: {
                name: "reader",
                description: "Reader",
                kind: "read_web_page",
                code: "export default ({html}) => ({title:'Page',text:html})",
              },
            });
          }
          return Promise.resolve({ kind: "reply", text: "done" });
        },
        review: (candidate) => {
          reviews++;
          return Promise.resolve({
            candidateDigest: candidate.digest,
            verdict: "approve",
            reason: "reviewed",
          });
        },
        admit: (candidate) => {
          admissions++;
          return Promise.resolve({
            candidateDigest: candidate.digest,
            verdict: "approve",
            reason: "admitted",
          });
        },
      },
      runner: {
        run: forbidden,
        test: () => {
          tests++;
          return Promise.resolve({ passed: true, checks: [] });
        },
      },
      ...(withBudget ? { workBudget } : {}),
    });
  const open = async (withBudget = true) => {
    const runtime = create(withBudget);
    await runtime.initialize();
    const controlIdle = runtime.idle.bind(runtime);
    const process = runtime.processAcceptedContribution.bind(runtime);
    runtime.processAcceptedContribution = async (delivery) => {
      await process(delivery);
      if (failBeforeAck && runtime.snapshot.budgetSuspension) {
        failBeforeAck = false;
        throw new Error("injected before transport acknowledgement");
      }
    };
    retained.bind(runtime);
    runtime.idle = async () => {
      await controlIdle();
      await retained.idle();
      await controlIdle();
    };
    return runtime;
  };
  return {
    model,
    open,
    execution: retained.execution,
    checkpoints: retained.checkpoints,
    dispatch: retained.dispatch,
    failBeforeAck: () => {
      failBeforeAck = true;
    },
    failFinalization: () => {
      failFinalization = true;
    },
    retryFailed: () => retained.retryFailed(),
    workBudget,
    calls: () => calls,
    clear: () => {
      record = null;
      records.clear();
    },
    fail: () => {
      failStorage = true;
    },
    unreadable: () => {
      unreadable = true;
    },
    uncertain: () => {
      state!.budgetSuspension!.dispatchStarted = true;
    },
    record: () => record,
    counts: () => ({ tests, reviews, admissions }),
  };
}
async function turn(service: SystemRuntime, text = "Continue") {
  const invocation = service.snapshot.caseInvocation;
  await service.submit(
    text,
    undefined,
    invocation?.kind === "local" ? invocation.caseId : undefined,
  );
  await service.idle();
}
Deno.test("budget accumulates across messages and reload; publication grants no credit; adoption preserves usage", async () => {
  const f = fixture(), first = await f.open();
  await turn(first);
  await turn(first);
  equal(f.calls(), 2);
  await turn(first);
  equal(f.calls(), 2);
  equal(first.snapshot.budgetSuspension?.reason, "exhausted");
  const identity = nativeExecutionIdentity(
    first.snapshot,
    "conversation",
    first.snapshot.activeInputMessageId,
  );
  const suspended = (await f.execution.inspect(identity.operatorId)).find((
    item,
  ) => canonical(item.identity) === canonical(identity));
  ok(
    suspended?.checkpointId,
    "The exact suspended conversation has a native checkpoint",
  );
  equal(suspended.status, "waiting");
  ok(suspended.waits.some((wait) => wait.kind === "budget"));
  const reloaded = await f.open();
  const retainedInput = reloaded.snapshot.activeInputMessageId;
  const retainedSuspension = structuredClone(
    reloaded.snapshot.budgetSuspension,
  );
  const retainedMessages = structuredClone(reloaded.snapshot.messages);
  const retainedEvents = structuredClone(reloaded.snapshot.events);
  const retainedBudget = structuredClone(f.record());
  const retainedExecutions = await f.execution.inspect(identity.operatorId);
  for (const publication of [false, true]) {
    if (publication) {
      f.model.workBudgetPolicy!.limit = 3;
      f.model.workBudgetPolicy!.revision = 2;
      f.model.version.digest = "version2";
      f.model.version.repositoryVersion = "commit:budget-v2";
    }
    await rejects(
      () => turn(reloaded),
      (error: unknown) =>
        error instanceof Error && "code" in error &&
        error.code === "CASE_BUSY" &&
        "context" in error &&
        (error.context as { reason?: string })?.reason === "BUDGET_WAIT_ACTIVE",
    );
    equal(reloaded.snapshot.activeInputMessageId, retainedInput);
    deepStrictEqual(reloaded.snapshot.budgetSuspension, retainedSuspension);
    deepStrictEqual(reloaded.snapshot.messages, retainedMessages);
    deepStrictEqual(reloaded.snapshot.events, retainedEvents);
    deepStrictEqual(f.record(), retainedBudget);
    deepStrictEqual(
      await f.execution.inspect(identity.operatorId),
      retainedExecutions,
    );
    equal(f.calls(), 2);
  }
  await reloaded.adoptModelVersion({ expectedDigest: "version2" });
  equal(f.calls(), 2);
  equal(reloaded.snapshot.workBudget?.consumed, 2);
  await turn(reloaded);
  equal(f.calls(), 3);
  equal(reloaded.snapshot.workBudget?.consumed, 3);
});
Deno.test("missing durable designer ledger and failed designer budget storage never dispatch", async () => {
  const f = fixture(), first = await f.open();
  equal(f.record(), null, "An empty conversation has no budget scope");
  await turn(first);
  equal(f.calls(), 1);
  equal(
    first.snapshot.workBudgetBinding?.scopeId,
    first.snapshot.designer?.scopeId,
  );
  ok(f.record());
  f.clear();
  const restarted = await f.open();
  const before = restarted.snapshot;
  const executions = await f.execution.inspect(f.model.identity.builderId);
  await rejects(
    () => turn(restarted),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CASE_BUSY" &&
      "context" in error &&
      (error.context as { reason?: string })?.reason === "BUDGET_WAIT_ACTIVE",
  );
  equal(f.calls(), 1, "Losing the bound ledger must never grant fresh credit");
  equal(restarted.snapshot.budgetSuspension?.reason, "unavailable");
  equal(restarted.snapshot.activeInputMessageId, before.activeInputMessageId);
  deepStrictEqual(restarted.snapshot.messages, before.messages);
  deepStrictEqual(restarted.snapshot.events, before.events);
  equal(f.record(), null);
  deepStrictEqual(
    await f.execution.inspect(f.model.identity.builderId),
    executions,
  );
  const failed = fixture();
  failed.fail();
  const s = await failed.open();
  await turn(s);
  equal(failed.calls(), 0);
  equal(s.snapshot.budgetSuspension?.reason, "unavailable");
});
Deno.test("a declared budget without its port cannot dispatch", async () => {
  const f = fixture(), s = await f.open(false);
  await turn(s);
  equal(f.calls(), 0);
  equal(s.snapshot.budgetSuspension?.reason, "unavailable");
});

Deno.test("promotion admission suspends exactly, survives restart and resumes without repeated tests or candidate", async () => {
  const f = fixture(true);
  f.model.workBudgetPolicy!.limit = 1;
  const s = await f.open();
  await turn(s);
  equal(f.calls(), 1);
  equal(f.counts().tests, 1);
  equal(f.counts().admissions, 0);
  equal(s.snapshot.candidates.length, 1);
  equal(s.snapshot.candidates[0]!.stage, "reviewing");
  const candidate = s.snapshot.candidates[0]!;
  const promotion = (await f.execution.inspect(f.model.identity.builderId))
    .find((item) =>
      item.identity.purpose === "promotion" &&
      item.identity.subjectId === candidate.promotionExecution?.subjectId
    );
  ok(promotion?.checkpointId, "The exact promotion has a native checkpoint");
  equal(promotion.status, "waiting");
  ok(promotion.waits.some((wait) => wait.kind === "budget"));
  const r = await f.open();
  equal(r.snapshot.candidates[0]!.stage, "reviewing");
  f.model.workBudgetPolicy!.limit = 3;
  f.model.workBudgetPolicy!.revision = 2;
  f.model.version.digest = "v2";
  f.model.version.repositoryVersion = "commit:budget-v2";
  await r.adoptModelVersion({ expectedDigest: "v2" });
  await turn(r);
  equal(f.counts().admissions, 1);
  equal(f.counts().tests, 1);
  equal(r.snapshot.candidates.length, 1);
  equal(r.snapshot.candidates[0]!.stage, "active");
  equal(f.calls(), 2);
});
Deno.test("scalar budget proof rejects missing, changed and unknown official evidence", async () => {
  const f = fixture(true);
  f.model.workBudgetPolicy!.limit = 1;
  const runtime = await f.open();
  await turn(runtime);
  const state = runtime.snapshot,
    previous = structuredClone(state.executionModel!);
  const target = structuredClone(previous);
  target.workBudgetPolicy!.limit = 3;
  target.workBudgetPolicy!.revision = 2;
  target.version.digest = "scalar-proof-v2";
  target.version.repositoryVersion = "commit:scalar-proof-v2";
  const snapshots = await f.execution.inspect(previous.identity.builderId);
  const record = f.record()!;
  const plan = (saved = snapshots) =>
    planBudgetCeilingTransition({
      state,
      previous,
      target,
      record,
      snapshots: saved,
      id: "scalar-proof",
      authorizationEventId: "scalar-proof-authorized",
    });
  const transition = await plan();
  ok(transition.manifest.family.scalarProposal);
  const parentMember = transition.manifest.members.find((member) =>
    member.id === transition.manifest.family.scalarProposal!.parentMemberId
  )!;
  const parentSnapshot = snapshots.find((snapshot) =>
    snapshot.threadId === parentMember.threadId
  )!;
  await verifyBudgetCeilingMemberSnapshot(
    transition.manifest,
    parentMember,
    parentSnapshot,
  );
  const changedProof = structuredClone(parentSnapshot);
  changedProof.scalarBudgetProposal!.decisionDigest = "foreign-decision";
  await rejects(
    () =>
      verifyBudgetCeilingMemberSnapshot(
        transition.manifest,
        parentMember,
        changedProof,
      ),
    /retained scalar proposal proof changed/,
  );
  const changedCheckpoint = structuredClone(parentSnapshot);
  changedCheckpoint.checkpointId = "foreign-checkpoint";
  await rejects(
    () =>
      verifyBudgetCeilingMemberSnapshot(
        transition.manifest,
        parentMember,
        changedCheckpoint,
      ),
    /retained native checkpoint changed/,
  );
  const missingProof = structuredClone(parentSnapshot);
  delete missingProof.scalarBudgetProposal;
  await rejects(
    () =>
      verifyBudgetCeilingMemberSnapshot(
        transition.manifest,
        parentMember,
        missingProof,
      ),
    /retained scalar proposal proof changed/,
  );
  const adoptedState = structuredClone(state);
  adoptedState.budgetCeilingTransition = transition;
  await verifyScalarBudgetCandidate(adoptedState);
  adoptedState.candidates[0].promotionExecution!.modelDigest =
    target.version.digest;
  await verifyScalarBudgetCandidate(adoptedState);
  adoptedState.candidates[0].promotionExecution!.modelDigest =
    "foreign-third-pin";
  await rejects(
    () => verifyScalarBudgetCandidate(adoptedState),
    /scalar continuation candidate or native identity changed/,
  );
  const checkpoints = await f.checkpoints();
  const sources = new Map<string, BudgetProposalCheckpoint>();
  for (const member of transition.manifest.members) {
    const checkpoint = checkpoints.find((item) =>
      item.threadId === member.threadId && item.runId === member.runId
    )!;
    const effect = checkpoint.effects.find((item) =>
      item.key === member.settledEffectKey
    )!;
    ok(effect?.settled);
    ok(checkpoint.wait);
    sources.set(member.id, {
      request: checkpoint.request,
      snapshot: snapshots.find((item) => item.threadId === member.threadId)!,
      wait: checkpoint.wait,
      contributionConsumed: checkpoint.contributionConsumed,
      effect: {
        runId: checkpoint.runId,
        contributionId: checkpoint.request.contribution.id,
        nodeId: effect.node.nativeId,
        status: "completed",
        result: effect.result,
      },
    });
  }
  await verifyScalarBudgetFamily(
    transition.manifest,
    (member) => Promise.resolve(sources.get(member.id)!),
  );
  const parentId = transition.manifest.family.scalarProposal.parentMemberId;
  const childId = transition.manifest.family.scalarProposal.childMemberId;
  const mutations: Array<
    [string, string, (source: BudgetProposalCheckpoint) => void]
  > = [
    ["decision text", parentId, (source) => {
      (source.wait.inputs.choice as { text: string }).text += " changed";
    }],
    ["decision draft", parentId, (source) => {
      (source.wait.inputs.choice as { tool: { code: string } }).tool
        .code += " changed";
    }],
    ["missing decision", parentId, (source) => {
      delete source.wait.inputs.choice;
    }],
    ["missing receipt", parentId, (source) => {
      delete source.effect;
    }],
    ["missing consumption proof", parentId, (source) => {
      source.contributionConsumed = false;
    }],
    ["unknown receipt", parentId, (source) => {
      source.effect!.status = "unknown";
    }],
    ["started receipt", childId, (source) => {
      source.effect!.status = "started";
    }],
    ["receipt result", parentId, (source) => {
      source.effect!.result = { suspend: true, suspensionKind: "decision" };
    }],
    ["checkpoint pin", parentId, (source) => {
      source.wait.modelPin.version.digest = "foreign";
    }],
    ["checkpoint scope", childId, (source) => {
      source.wait.executionScope.scopeId = "foreign";
    }],
    ["checkpoint candidate", childId, (source) => {
      source.wait.promotionId = "foreign";
    }],
    ["child contribution", childId, (source) => {
      source.request.contribution.id = "foreign";
    }],
  ];
  for (const [label, memberId, mutate] of mutations) {
    const changed = new Map(
      [...sources].map(([id, source]) => [id, structuredClone(source)]),
    );
    mutate(changed.get(memberId)!);
    await rejects(
      () =>
        verifyScalarBudgetFamily(
          transition.manifest,
          (member) => Promise.resolve(changed.get(member.id)!),
        ),
      /BUDGET_CEILING_CONTINUATION_REFUSED/,
      label,
    );
  }
  const missing = structuredClone(snapshots);
  delete missing.find((item) => item.identity.purpose === "conversation")!
    .scalarBudgetProposal;
  await rejects(
    () => plan(missing),
    /scalar parent lacks its exact official decision/,
  );
  const foreignChild = structuredClone(snapshots);
  foreignChild.find((item) => item.identity.purpose === "promotion")!
    .localState!.promotionId = "foreign";
  await rejects(
    () => plan(foreignChild),
    /scalar parent lacks its exact official decision/,
  );
  equal(f.calls(), 1);
  deepStrictEqual(f.counts(), { tests: 1, reviews: 0, admissions: 0 });
  equal(runtime.snapshot.candidates.length, 1);
  deepStrictEqual(f.record(), record);
});

Deno.test("review is charged and suspension preserves the same promotion continuation", async () => {
  const f = fixture(true, true);
  f.model.workBudgetPolicy!.limit = 1;
  const s = await f.open();
  await turn(s);
  equal(f.counts().reviews, 0);
  equal(s.snapshot.budgetSuspension?.operation, "review");
  const r = await f.open();
  f.model.workBudgetPolicy!.limit = 3;
  f.model.workBudgetPolicy!.revision = 2;
  f.model.version.digest = "v2";
  f.model.version.repositoryVersion = "commit:budget-v2";
  await r.adoptModelVersion({ expectedDigest: "v2" });
  await turn(r);
  equal(f.counts().reviews, 1);
  equal(f.counts().admissions, 0);
  equal(f.counts().tests, 1);
  equal(r.snapshot.candidates.length, 1);
  equal(r.snapshot.candidates[0]!.stage, "active");
});

Deno.test("restart with an unreadable ledger preserves pending promotion and uncertain dispatch", async () => {
  const f = fixture(true);
  f.model.workBudgetPolicy!.limit = 1;
  const s = await f.open();
  await turn(s);
  const pending = s.snapshot.budgetSuspension!;
  ok(pending.candidateId);
  f.uncertain();
  f.unreadable();
  const restarted = await f.open();
  equal(restarted.snapshot.budgetSuspension?.candidateId, pending.candidateId);
  equal(restarted.snapshot.budgetSuspension?.nodeId, pending.nodeId);
  equal(restarted.snapshot.budgetSuspension?.dispatchStarted, true);
  equal(restarted.snapshot.budgetSuspension?.reason, "unavailable");
  equal(restarted.snapshot.candidates[0]!.stage, "reviewing");
  const before = restarted.snapshot;
  const executions = await f.execution.inspect(f.model.identity.builderId);
  const budget = structuredClone(f.record());
  await rejects(
    () => turn(restarted),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CASE_BUSY" &&
      "context" in error &&
      (error.context as { reason?: string })?.reason === "BUDGET_WAIT_ACTIVE",
  );
  equal(restarted.snapshot.activeInputMessageId, before.activeInputMessageId);
  deepStrictEqual(restarted.snapshot.budgetSuspension, before.budgetSuspension);
  deepStrictEqual(restarted.snapshot.messages, before.messages);
  deepStrictEqual(restarted.snapshot.events, before.events);
  deepStrictEqual(f.record(), budget);
  deepStrictEqual(
    await f.execution.inspect(f.model.identity.builderId),
    executions,
  );
  equal(f.calls(), 1);
  equal(f.counts().admissions, 0);
  equal(f.counts().tests, 1);
});

Deno.test("initial promotion preserves its exact pending Case and checkpoint without reviewer dispatch when budget storage fails", async () => {
  const f = fixture(false, true);
  f.model.initialTools = [{
    id: "seed",
    nativeId: "seed-native",
    sourceIds: [],
    draft: {
      name: "selected-reader",
      description: "Exact reader",
      kind: "read_web_page",
      code: "export default ({html}) => ({title:'Page',text:html})",
    },
  }];
  const s = await f.open();
  equal(f.record(), null);
  f.fail();
  await s.prepareInitialTools();
  await s.idle();
  equal(f.counts().reviews, 0);
  equal(f.counts().admissions, 0);
  equal(f.calls(), 0);
  const before = s.snapshot;
  const candidate = before.candidates[0]!;
  equal(before.candidates.length, 1);
  equal(candidate.stage, "reviewing");
  equal(candidate.error, undefined);
  equal(candidate.errorCode, undefined);
  const initialization = before.cases!.find((record) =>
    record.id === candidate.caseId
  )!;
  ok(initialization);
  ok(["open", "waiting"].includes(initialization.status));
  equal(initialization.closedAt, undefined);
  equal(initialization.budget?.scopeId, initialization.id);
  const intentions = Object.values(before.initialToolsPreparations!);
  equal(intentions.length, 1);
  const intention = intentions[0];
  equal(intention.caseId, initialization.id);
  equal(intention.phase, "pending");
  equal(intention.terminal, undefined);
  deepStrictEqual(initialization.modelPin, intention.modelVersion);
  equal(before.caseBudgetPending, true);
  equal(before.budgetSuspension?.reason, "unavailable");
  equal(before.budgetSuspension?.candidateId, candidate.id);
  equal(before.budgetSuspension?.operation, "review");
  equal(before.budgetSuspension?.dispatchStarted, false);
  equal(before.workBudget, undefined);
  equal(before.budgetCeilingTransition, undefined);
  equal(f.record(), null);
  const executions = await f.execution.inspect(f.model.identity.builderId);
  const promotion = executions.find((execution) =>
    execution.threadId === candidate.promotionExecution?.threadId
  )!;
  ok(promotion?.checkpointId);
  equal(promotion.status, "waiting");
  equal(promotion.identity.scope.scopeId, initialization.id);
  equal(promotion.modelDigest, intention.modelVersion.digest);
  equal(promotion.repositoryVersion, intention.modelVersion.repositoryVersion);
  equal(promotion.waits.length, 1);
  equal(promotion.waits[0].kind, "budget");
  equal(promotion.waits[0].mechanism, "review_candidate");
  ok(
    before.events.some((event) =>
      event.kind === "work-budget-wait" && event.label === "disk full"
    ),
  );
  // Reopening observes the same unavailable wait. It grants neither budget
  // credit nor an automatic dispatch while the injected storage failure remains.
  const reopened = await f.open();
  deepStrictEqual(reopened.snapshot.candidates, before.candidates);
  deepStrictEqual(reopened.snapshot.cases, before.cases);
  deepStrictEqual(
    reopened.snapshot.initialToolsPreparations,
    before.initialToolsPreparations,
  );
  deepStrictEqual(reopened.snapshot.caseInvocation, before.caseInvocation);
  deepStrictEqual(
    reopened.snapshot.workBudgetBinding,
    before.workBudgetBinding,
  );
  deepStrictEqual(reopened.snapshot.budgetSuspension, before.budgetSuspension);
  equal(reopened.snapshot.caseBudgetPending, true);
  equal(reopened.snapshot.workBudget, undefined);
  equal(reopened.snapshot.budgetCeilingTransition, undefined);
  deepStrictEqual(
    await f.execution.inspect(f.model.identity.builderId),
    executions,
  );
  equal(f.record(), null);
  equal(f.calls(), 0);
  deepStrictEqual(f.counts(), { tests: 1, reviews: 0, admissions: 0 });
});

Deno.test("the exact delivery retries its acquired budget wait after transport acknowledgement fails", async () => {
  const f = fixture();
  f.model.workBudgetPolicy!.limit = 1;
  const runtime = await f.open();
  await turn(runtime, "First completed input");
  f.failBeforeAck();
  await runtime.submit("Input that reaches the budget wait");
  await rejects(
    () => runtime.idle(),
    /injected before transport acknowledgement/,
  );
  const before = runtime.snapshot;
  const inputId = before.activeInputMessageId!;
  const identity = nativeExecutionIdentity(before, "conversation", inputId);
  const wait = await f.execution.inspect(identity.operatorId);
  ok(wait.some((snapshot) =>
    snapshot.contributionId === inputId &&
    snapshot.status === "waiting" && snapshot.waits.some((entry) =>
      entry.kind === "budget"
    )
  ));
  const budget = structuredClone(f.record());
  equal((await f.dispatch.inspect(identity, inputId))?.status, "failed");
  await f.retryFailed();
  equal((await f.dispatch.inspect(identity, inputId))?.status, "completed");
  equal(runtime.snapshot.activeInputMessageId, inputId);
  deepStrictEqual(runtime.snapshot.budgetSuspension, before.budgetSuspension);
  deepStrictEqual(runtime.snapshot.messages, before.messages);
  deepStrictEqual(await f.execution.inspect(identity.operatorId), wait);
  deepStrictEqual(f.record(), budget);
  equal(f.calls(), 1);
  await rejects(
    () => runtime.submit("Another input"),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CASE_BUSY",
  );
});

Deno.test("retry finalizes an acquired budget wait after the business finalization CAS fails", async () => {
  const f = fixture();
  f.model.workBudgetPolicy!.limit = 1;
  const runtime = await f.open();
  await turn(runtime, "First completed input");
  f.failFinalization();
  await runtime.submit("Input that reaches the budget wait");
  await rejects(
    () => runtime.idle(),
    /injected before budget work finalization/,
  );
  const before = runtime.snapshot;
  equal(before.busy, true);
  const inputId = before.activeInputMessageId!;
  const identity = nativeExecutionIdentity(before, "conversation", inputId);
  const wait = await f.execution.inspect(identity.operatorId);
  ok(wait.some((snapshot) =>
    snapshot.contributionId === inputId &&
    snapshot.status === "waiting" && snapshot.waits.some((entry) =>
      entry.kind === "budget"
    )
  ));
  const budget = structuredClone(f.record());
  await f.retryFailed();
  equal(runtime.snapshot.busy, false);
  equal(runtime.snapshot.activeInputMessageId, inputId);
  deepStrictEqual(runtime.snapshot.budgetSuspension, before.budgetSuspension);
  deepStrictEqual(runtime.snapshot.messages, before.messages);
  deepStrictEqual(await f.execution.inspect(identity.operatorId), wait);
  deepStrictEqual(f.record(), budget);
  equal(f.calls(), 1);
  equal((await f.dispatch.inspect(identity, inputId))?.status, "completed");
});

Deno.test("a delegated budget wait receives its waiting receipt after finalization retries", async () => {
  const f = fixture();
  f.model.workBudgetPolicy!.limit = 1;
  const runtime = await f.open();
  await turn(runtime, "Consume the designer budget");
  const designerContext = designerExecutionContext(runtime.snapshot)!;
  const contribution = {
    text: "Delegated work awaiting budget",
    correlationId: "budget-delegation",
    proof: {
      callerId: "caller",
      invocationId: "budget-invocation",
      designerContext,
      modelVersion: {
        digest: "caller-pin",
        repositoryVersion: "caller-source",
      },
      behavior: {
        id: "inbox",
        name: "Inbox",
        description: "Admitted inbox",
        callerNativeId: "caller",
        targetNativeId: f.model.identity.builderId,
        targetTypeId: "inbox-type",
        inputTypeId: "input",
        inputSchema: { type: "object" },
        sourceIds: [],
      },
    },
  };
  f.failFinalization();
  await runtime.submitWork(contribution);
  await rejects(
    () => runtime.idle(),
    /injected before budget work finalization/,
  );
  const before = runtime.snapshot;
  equal(before.busy, true);
  const inputId = before.activeInputMessageId!;
  const identity = nativeExecutionIdentity(before, "conversation", inputId);
  const wait = await f.execution.inspect(identity.operatorId);
  ok(wait.some((snapshot) =>
    snapshot.contributionId === inputId &&
    snapshot.status === "waiting" && snapshot.waits.some((entry) =>
      entry.kind === "budget"
    )
  ));
  const budget = structuredClone(f.record());
  await f.retryFailed();
  equal(runtime.snapshot.busy, false);
  const receipts = runtime.snapshot.events.filter((event) =>
    event.id === `accepted-work-completion:${inputId}`
  );
  equal(receipts.length, 1);
  ok("work" in receipts[0]!);
  equal((receipts[0] as { work: { status: string } }).work.status, "waiting");
  deepStrictEqual(runtime.snapshot.budgetSuspension, before.budgetSuspension);
  deepStrictEqual(runtime.snapshot.messages, before.messages);
  deepStrictEqual(await f.execution.inspect(identity.operatorId), wait);
  deepStrictEqual(f.record(), budget);
  equal(f.calls(), 1);
  equal((await f.dispatch.inspect(identity, inputId))?.status, "completed");
});

Deno.test("a contribution accepted before budget suspension fails before materialization under the worker claim", async () => {
  const f = fixture();
  f.model.workBudgetPolicy!.limit = 1;
  const runtime = await f.open();
  await turn(runtime, "First completed input");
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reserve = f.workBudget.reserve.bind(f.workBudget);
  f.workBudget.reserve = async (input) => {
    entered();
    await gate;
    return await reserve(input);
  };
  await runtime.submit("Input that reaches the budget wait");
  await inside;
  const before = runtime.snapshot;
  const id = crypto.randomUUID();
  const identity = nativeExecutionIdentity(before, "conversation", id);
  const receipt = await f.dispatch.enqueue({
    id,
    identity,
    kind: "contribution",
    modelPin: {
      modelDigest: before.executionModel!.version.digest,
      repositoryVersion: before.executionModel!.version.repositoryVersion,
    },
    payload: {
      text: "Input accepted before the budget wait",
      origin: "human",
      invocation: structuredClone(before.caseInvocation),
      receivedAt: "2026-10-24T00:00:00.000Z",
    },
  });
  release();
  await rejects(
    () => runtime.idle(),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CASE_BUSY",
  );
  const after = runtime.snapshot;
  equal(after.activeInputMessageId, before.activeInputMessageId);
  equal(after.budgetSuspension?.reason, "exhausted");
  equal(after.messages.some((message) => message.id === id), false);
  equal(
    after.events.some((event) => event.id === `accepted-delivery:${id}`),
    false,
  );
  equal(f.calls(), 1);
  equal((await f.dispatch.inspect(identity, id))?.status, "failed");
  equal(receipt.id, id);
});

Deno.test("an independent Request remains admissible while the designer input waits for budget", async () => {
  const f = fixture();
  f.model.workBudgetPolicy!.limit = 1;
  const runtime = await f.open();
  await turn(runtime, "First designer input");
  await turn(runtime, "Designer input reaches budget wait");
  const before = runtime.snapshot;
  ok(before.caseInvocation);
  const key = invocationKey(before.caseInvocation);
  const identity = nativeExecutionIdentity(
    before,
    "conversation",
    before.activeInputMessageId,
  );
  const checkpoint = (await f.execution.inspect(identity.operatorId)).find((
    item,
  ) => canonical(item.identity) === canonical(identity));
  ok(checkpoint?.checkpointId);
  const caseId = await runtime.submit(
    "Independent Request",
    undefined,
    undefined,
    true,
  );
  await runtime.idle();
  ok(caseId);
  equal(f.calls(), 2);
  const saved = runtime.snapshot.invocationContinuations?.[key];
  equal(saved?.activeInputMessageId, before.activeInputMessageId);
  deepStrictEqual(saved?.budgetSuspension, before.budgetSuspension);
  const retained = (await f.execution.inspect(identity.operatorId)).find((
    item,
  ) => canonical(item.identity) === canonical(identity));
  equal(retained?.checkpointId, checkpoint.checkpointId);
});
