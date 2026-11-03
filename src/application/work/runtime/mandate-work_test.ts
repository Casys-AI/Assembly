import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import {
  emptyChangePreview,
  unexpectedModelAuthoring,
} from "../../../../test/support/model-authoring.ts";
import { SystemRuntime } from "../../../../test/support/system-runtime.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { ModelPort } from "./ports.ts";
import type { ApprovedChangePublication } from "../../../domain/model/publication/change.ts";
import type {
  ChatDecision,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import type {
  PendingChange,
} from "../../../domain/governance/records/pending-change.ts";
import type { OperatorWorkContribution } from "../operators/conversations.ts";
import { recordedOperatorWork } from "../operators/journal.ts";
import { WorkBudgetService } from "../budget/service.ts";
import {
  budgetState,
  type WorkBudgetRecord,
} from "../../../domain/work/policies/budget.ts";

const request: ChatDecision = {
  kind: "propose_mandate_change",
  text: "Request the exact network host.",
  reason: "Read the requested site",
  requestedRights: { addNetworkHosts: ["recovery.example"] },
};
const ack: ChatDecision = {
  kind: "reply",
  text: "Network scope acknowledged by this operator.",
};

/** An empty controlled diff, bound to this fixture's actual immutable model
 * pins. This fixture does not compile or qualify source-file contents. */
function exactChangePreview(
  readModel: () => ExecutableModel,
): ModelPort["previewApprovedChange"] {
  return async (identity, change, expectedDigest) => {
    const model = readModel();
    deepStrictEqual(identity, model.identity);
    equal(expectedDigest, model.version.digest);
    ok(model.version.repositoryVersion);
    const preview = await emptyChangePreview(identity, change, expectedDigest);
    return {
      ...preview,
      base: {
        ...preview.base,
        repositoryVersion: model.version.repositoryVersion,
        modelDigest: model.version.digest,
      },
    };
  };
}

function fixture(batched = false) {
  let native = executableFixture({
    projectId: "unit",
    editingContextId: "unit",
    rootId: "root",
    systemId: "worker-system",
    catalogId: "catalog",
    builderId: "worker",
  });
  native.version.repositoryVersion = "source-1";
  let saved: SystemRuntimeState | null = null;
  const published = new Map<string, ApprovedChangePublication>();
  let decisions = 0, publications = 0;
  let onModelRead: (() => Promise<void>) | undefined;
  const steps: ChatDecision[] = [request, ack];
  const records = new Map<string, WorkBudgetRecord>();
  const budget = new WorkBudgetService({
    load: (id) => Promise.resolve(structuredClone(records.get(id) ?? null)),
    save: (record, expected) => {
      equal(records.get(record.scopeId)?.revision ?? null, expected);
      records.set(record.scopeId, structuredClone(record));
      return Promise.resolve();
    },
  });
  const fail = { completion: false, beforeAttempt: false };
  const create = () =>
    new SystemRuntime({
      workBudget: budget,
      store: {
        load: () => Promise.resolve(structuredClone(saved)),
        save: (state, expected) => {
          equal(saved?.revision ?? null, expected);
          if (
            fail.beforeAttempt &&
            Object.values(state.changeWorkContinuations ?? {}).some((entry) =>
              entry.attempt
            )
          ) {
            fail.beforeAttempt = false;
            throw new Error("Before work dispatch");
          }
          if (
            fail.completion &&
            state.events.some((event) =>
              event.kind === "operator-work-completed"
            )
          ) {
            fail.completion = false;
            throw new Error("Completion receipt unavailable");
          }
          saved = structuredClone(state);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      },
      model: {
        ...unexpectedModelAuthoring,
        initialize: () => Promise.resolve(structuredClone(native.identity)),
        readExecutableModel: async () => {
          await onModelRead?.();
          return structuredClone(native);
        },
        previewApprovedChange: exactChangePreview(() => native),
        findApprovedChange: (_identity, id) =>
          Promise.resolve(structuredClone(published.get(id) ?? null)),
        applyApprovedChange: (identity, change, expectedDigest, receipt) => {
          deepStrictEqual(identity, native.identity);
          equal(expectedDigest, native.version.digest);
          equal(
            change.diff?.base.repositoryVersion,
            native.version.repositoryVersion,
          );
          equal(change.diff?.base.modelDigest, native.version.digest);
          publications++;
          native = structuredClone(native);
          native.configuration.revision++;
          native.configuration.network = { allowedHosts: ["recovery.example"] };
          native.mandate.network = structuredClone(
            native.configuration.network,
          );
          native.version.configurationRevision = native.configuration.revision;
          native.version.digest = "network-granted";
          native.version.repositoryVersion = "source-2";
          receipt.edits = [];
          published.set(change.id, {
            model: structuredClone(native),
            receipt: structuredClone(receipt),
          });
          return Promise.resolve(structuredClone(native));
        },
        graph: () => Promise.resolve({}),
        activateCandidate: () => {
          throw new Error("No tool activation expected");
        },
      },
      agents: {
        label: "mandate-work",
        decide: (context) => {
          decisions++;
          const step = steps.shift();
          ok(step, "No repeated provider call is allowed");
          if (step === ack) {
            deepStrictEqual(context.configuration?.network?.allowedHosts, [
              "recovery.example",
            ]);
          }
          return Promise.resolve(structuredClone(step));
        },
        review: () => {
          throw new Error("No reviewer effect expected");
        },
        ...(batched
          ? {
            decideBatch: (
              context: import("../../../domain/work/dialogue.ts").ChatContext,
            ) => {
              decisions++;
              const step = steps.shift();
              ok(step, "No repeated provider call is allowed");
              if (step === ack) {
                deepStrictEqual(context.configuration?.network?.allowedHosts, [
                  "recovery.example",
                ]);
              }
              return Promise.resolve({
                calls: [
                  { id: `call-${decisions}`, decision: structuredClone(step) },
                  ...(step === request
                    ? [{
                      id: "waiting-reply",
                      decision: {
                        kind: "reply" as const,
                        text: "Waiting for the network decision.",
                      },
                    }]
                    : []),
                ],
              });
            },
          }
          : {}),
      },
      runner: {
        test: () => {
          throw new Error("No tool preparation expected");
        },
        run: () => {
          throw new Error("No tool effect expected");
        },
      },
    });
  const contribution: OperatorWorkContribution = {
    text: "Obtain the network scope, then acknowledge it.",
    correlationId: "network-phase",
    proof: {
      callerId: "main",
      invocationId: "network-invocation",
      caseId: "root-request",
      caseContext: {
        caseId: "root-request",
        number: 1,
        modelPin: { digest: "main-pin" },
      },
      modelVersion: { digest: "main-pin", repositoryVersion: "main-source" },
      behavior: {
        id: "worker-inbox",
        name: "Inbox",
        description: "Admitted inbox",
        callerNativeId: "main",
        targetNativeId: "worker",
        targetTypeId: "inbox-type",
        inputTypeId: "input",
        inputSchema: { type: "object" },
        sourceIds: [],
      },
    },
  };
  return {
    create,
    contribution,
    saved: () => saved!,
    fail,
    steps,
    records,
    observeModelRead: (observe: () => Promise<void>) => {
      onModelRead = observe;
    },
    enableBudget: async () => {
      const policy = {
        id: "root-budget",
        revision: 1,
        unit: "agent-invocation" as const,
        limit: 10,
        onExhausted: "wait" as const,
        exhaustionRecipient: "local-control" as const,
      };
      contribution.proof.caseContext!.budget = {
        scopeId: "root-request",
        ownerId: "main",
        policy,
      };
      await budget.adopt({
        scopeId: "root-request",
        ownerId: "main",
        previousPolicy: undefined,
        policy,
        modelVersion: contribution.proof.modelVersion,
      });
    },
    mutateNative: (change: (model: typeof native) => void) => change(native),
    counts: () => ({ decisions, publications }),
  };
}

Deno.test("a decided network change includes the resumed operator ACK in its exact work receipt", async () => {
  const f = fixture();
  await f.enableBudget();
  const runtime = f.create();
  await runtime.initialize();
  await runtime.submitWork(f.contribution);
  await runtime.idle();
  const change = runtime.snapshot.configuration!.changes[0];
  equal(
    recordedOperatorWork(
      runtime.snapshot,
      "worker",
      "main",
      f.contribution.correlationId,
    )!.result.status,
    "waiting",
  );
  await runtime.decideChange({
    changeId: change.id,
    expectedRevision: change.baseRevision,
    verdict: "approve",
  });
  await runtime.idle();
  const result = recordedOperatorWork(
    runtime.snapshot,
    "worker",
    "main",
    f.contribution.correlationId,
  )!.result;
  equal(result.status, "completed");
  equal(
    result.messages.filter((message) => message.text === ack.text).length,
    1,
  );
  deepStrictEqual(f.counts(), { decisions: 2, publications: 1 });
  equal(budgetState(f.records.get("root-request")!).view.consumed, 2);
  const ledger = structuredClone(f.records.get("root-request"));
  await runtime.decideChange({
    changeId: change.id,
    expectedRevision: change.baseRevision,
    verdict: "approve",
  });
  await runtime.idle();
  await runtime.resumeDecidedChanges();
  await runtime.idle();
  deepStrictEqual(f.records.get("root-request"), ledger);
});

Deno.test("a proposal followed by a batch reply remains waiting until its decided ACK receipt commits", async () => {
  const f = fixture(true);
  const runtime = f.create();
  await runtime.initialize();
  await runtime.submitWork(f.contribution);
  await runtime.idle();
  equal(
    recordedOperatorWork(
      runtime.snapshot,
      "worker",
      "main",
      f.contribution.correlationId,
    )!.result.status,
    "waiting",
  );
  const change = runtime.snapshot.configuration!.changes[0];
  const decision = {
    changeId: change.id,
    expectedRevision: change.baseRevision,
    verdict: "approve" as const,
  };
  await runtime.decideChange(decision);
  await runtime.idle();
  const result = recordedOperatorWork(
    runtime.snapshot,
    "worker",
    "main",
    f.contribution.correlationId,
  )!.result;
  equal(result.status, "completed");
  equal(
    result.messages.filter((message) => message.text === ack.text).length,
    1,
  );
  equal(runtime.snapshot.changeDecisionContinuations![change.id], "resumed");
  equal(
    JSON.stringify(runtime.snapshot.conversationContext ?? {}).includes(
      '"changeWorkContinuations"',
    ),
    false,
  );
  await runtime.decideChange(decision);
  await runtime.idle();
  await runtime.resumeDecidedChanges();
  await runtime.idle();
  deepStrictEqual(f.counts(), { decisions: 2, publications: 1 });
});

Deno.test("completing one exact network approval preserves another pending change in the same work", async () => {
  const f = fixture();
  f.steps[1] = {
    kind: "propose_mandate_change",
    text: "The next part needs another exact host.",
    reason: "Read the second requested site",
    requestedRights: { addNetworkHosts: ["second.example"] },
  };
  const runtime = f.create();
  await runtime.initialize();
  await runtime.submitWork(f.contribution);
  await runtime.idle();
  const first = runtime.snapshot.configuration!.changes[0];
  await runtime.decideChange({
    changeId: first.id,
    expectedRevision: first.baseRevision,
    verdict: "approve",
  });
  await runtime.idle();
  const state = runtime.snapshot;
  equal(
    state.configuration!.changes.find((change) => change.id === first.id)!
      .status,
    "approved",
  );
  const remaining = state.configuration!.changes.filter((change) =>
    change.status === "pending"
  );
  equal(remaining.length, 1);
  ok(remaining[0].id !== first.id);
  deepStrictEqual(remaining[0].requestedRights, {
    addNetworkHosts: ["second.example"],
  });
  equal(
    recordedOperatorWork(state, "worker", "main", f.contribution.correlationId)!
      .result.status,
    "waiting",
  );
  equal(state.changeDecisionContinuations![first.id], "resumed");
  deepStrictEqual(state.executionModel!.configuration.network?.allowedHosts, [
    "recovery.example",
  ]);
  deepStrictEqual(f.counts(), { decisions: 2, publications: 1 });
});

for (const other of ["Request", "same-Request work"] as const) {
  Deno.test(`network decision resumes its exact work without claiming another ${other}`, async () => {
    const f = fixture();
    const runtime = f.create();
    await runtime.initialize();
    await runtime.submitWork(f.contribution);
    await runtime.idle();
    const change = runtime.snapshot.configuration!.changes[0];
    f.steps.unshift({ kind: "reply", text: "B-private answer" });
    if (other === "Request") {
      await runtime.submit("B-private input", undefined, undefined, true);
    } else {
      const b = structuredClone(f.contribution);
      b.correlationId = "other-work";
      b.proof.invocationId = "other-invocation";
      b.text = "B-private input";
      await runtime.submitWork(b);
    }
    await runtime.idle();
    if (other !== "Request") {
      equal(
        recordedOperatorWork(runtime.snapshot, "worker", "main", "other-work")!
          .result.status,
        "completed",
      );
    }
    equal(
      recordedOperatorWork(
        runtime.snapshot,
        "worker",
        "main",
        f.contribution.correlationId,
      )!.result.status,
      "waiting",
    );
    await runtime.decideChange({
      changeId: change.id,
      expectedRevision: change.baseRevision,
      verdict: "approve",
    });
    await runtime.idle();
    const result = recordedOperatorWork(
      runtime.snapshot,
      "worker",
      "main",
      f.contribution.correlationId,
    )!.result;
    equal(result.status, "completed");
    equal(
      result.messages.some((message) => message.text.startsWith("B-private")),
      false,
    );
    equal(
      result.messages.filter((message) => message.text === ack.text).length,
      1,
    );
    deepStrictEqual(f.counts(), { decisions: 3, publications: 1 });
  });
}

Deno.test("startup recovers a published network decision before dispatch once with its original receipt", async () => {
  const f = fixture();
  const runtime = f.create();
  await runtime.initialize();
  await runtime.submitWork(f.contribution);
  await runtime.idle();
  const change = runtime.snapshot.configuration!.changes[0];
  f.fail.beforeAttempt = true;
  await runtime.decideChange({
    changeId: change.id,
    expectedRevision: change.baseRevision,
    verdict: "approve",
  });
  await rejects(() => runtime.idle(), /Before work dispatch/);
  equal(f.saved().changeDecisionContinuations![change.id], "feedback-sent");
  equal(f.saved().changeWorkContinuations![change.id].attempt, undefined);
  const restarted = f.create();
  await restarted.initialize();
  const result = recordedOperatorWork(
    restarted.snapshot,
    "worker",
    "main",
    f.contribution.correlationId,
  )!.result;
  equal(result.status, "completed");
  equal(
    result.messages.filter((message) => message.text === ack.text).length,
    1,
  );
  equal(restarted.snapshot.error, undefined);
  await restarted.initialize();
  await restarted.resumeDecidedChanges();
  deepStrictEqual(f.counts(), { decisions: 2, publications: 1 });
});

Deno.test("a lost post-return receipt fails closed across restart without repeating the ACK or publication", async () => {
  const f = fixture();
  const runtime = f.create();
  await runtime.initialize();
  await runtime.submitWork(f.contribution);
  await runtime.idle();
  const change = runtime.snapshot.configuration!.changes[0];
  f.fail.completion = true;
  await runtime.decideChange({
    changeId: change.id,
    expectedRevision: change.baseRevision,
    verdict: "approve",
  });
  await rejects(() => runtime.idle(), /Completion receipt unavailable/);
  equal(
    f.saved().messages.filter((message) => message.text === ack.text).length,
    1,
  );
  ok(f.saved().changeWorkContinuations![change.id].attempt);
  equal(f.saved().changeDecisionContinuations![change.id], "feedback-sent");
  const restarted = f.create();
  await rejects(() => restarted.initialize(), {
    code: "CASE_DISPATCH_UNKNOWN",
  });
  equal(
    recordedOperatorWork(
      restarted.snapshot,
      "worker",
      "main",
      f.contribution.correlationId,
    )!.result.status,
    "waiting",
  );
  deepStrictEqual(f.counts(), { decisions: 2, publications: 1 });
});

Deno.test("a revision interleaved during completion preserves the published approval and refuses an unreceipted dialogue replay", async () => {
  const f = fixture();
  const runtime = f.create();
  await runtime.initialize();
  await runtime.submitWork(f.contribution);
  await runtime.idle();
  const change = runtime.snapshot.configuration!.changes[0];
  const waitAction = runtime.snapshot.executionModel!.flows.conversation.nodes
    .find((node) => node.mechanism === "await_input")!.nativeId;
  let interleaved = false;
  f.observeModelRead(async () => {
    const state = runtime.snapshot;
    if (
      !interleaved && state.messages.some((message) =>
        message.text === ack.text
      ) &&
      state.events.at(-1)?.execution?.actionId === waitAction &&
      state.changeWorkContinuations?.[change.id]?.attempt
    ) {
      interleaved = true;
      ok(state.caseInvocation);
      // A genuine serialized canonical write occurs while workCompletion is
      // reading the controlled model port, after the returned native dialogue.
      await runtime.restoreCaseInvocation(state.caseInvocation);
    }
  });
  await runtime.decideChange({
    changeId: change.id,
    expectedRevision: change.baseRevision,
    verdict: "approve",
  });
  await rejects(
    () => runtime.idle(),
    /work completion source changed before its atomic approval/,
  );
  equal(interleaved, true);
  const state = f.saved();
  equal(
    state.configuration!.changes.find((entry) => entry.id === change.id)!
      .status,
    "approved",
  );
  equal(
    state.configuration!.changes.find((entry) => entry.id === change.id)!
      .publishedCommit,
    "source-2",
  );
  ok(state.changeWorkContinuations![change.id].attempt);
  equal(state.changeDecisionContinuations![change.id], "feedback-sent");
  equal(
    state.messages.filter((message) => message.text === ack.text).length,
    1,
  );
  equal(
    recordedOperatorWork(state, "worker", "main", f.contribution.correlationId)!
      .result.status,
    "waiting",
  );
  // This remains the existing fail-closed post-return policy: publication is
  // truth, but no automatic second dialogue can replace its missing receipt.
  const restarted = f.create();
  await rejects(() => restarted.initialize(), {
    code: "CASE_DISPATCH_UNKNOWN",
  });
  deepStrictEqual(f.counts(), { decisions: 2, publications: 1 });
  equal(
    f.saved().messages.filter((message) => message.text === ack.text).length,
    1,
  );
});

Deno.test("an incompatible source never completes or dispatches a pending change's work", async () => {
  const f = fixture();
  const runtime = f.create();
  await runtime.initialize();
  await runtime.submitWork(f.contribution);
  await runtime.idle();
  const change = runtime.snapshot.configuration!.changes[0];
  f.fail.beforeAttempt = true;
  await runtime.decideChange({
    changeId: change.id,
    expectedRevision: change.baseRevision,
    verdict: "approve",
  });
  await rejects(() => runtime.idle(), /Before work dispatch/);
  f.mutateNative((native) => {
    native.version.digest = "incompatible-source";
    native.version.repositoryVersion = "source-3";
  });
  const restarted = f.create();
  await restarted.initialize();
  equal(
    restarted.snapshot.changeDecisionContinuations![change.id],
    "feedback-sent",
  );
  equal(
    recordedOperatorWork(
      restarted.snapshot,
      "worker",
      "main",
      f.contribution.correlationId,
    )!.result.status,
    "waiting",
  );
  deepStrictEqual(f.counts(), { decisions: 1, publications: 1 });
});

Deno.test("a missing exact work-origin map cannot claim a legacy change's ACK or receipt", async () => {
  const f = fixture();
  const runtime = f.create();
  await runtime.initialize();
  await runtime.submitWork(f.contribution);
  await runtime.idle();
  const change = runtime.snapshot.configuration!.changes[0];
  delete f.saved().changeWorkContinuations;
  const restarted = f.create();
  await restarted.initialize();
  await restarted.decideChange({
    changeId: change.id,
    expectedRevision: change.baseRevision,
    verdict: "approve",
  });
  await rejects(() => restarted.idle(), { code: "CASE_SCOPE_MISSING" });
  equal(f.saved().messages.some((message) => message.text === ack.text), false);
  equal(
    recordedOperatorWork(
      restarted.snapshot,
      "worker",
      "main",
      f.contribution.correlationId,
    )!.result.status,
    "waiting",
  );
  deepStrictEqual(f.counts(), { decisions: 1, publications: 1 });
});

Deno.test("a refused network change completes only its explicit refusal ACK without granting rights", async () => {
  const f = fixture();
  f.steps[1] = {
    kind: "reply",
    text: "Refusal acknowledged without using that host.",
  };
  const runtime = f.create();
  await runtime.initialize();
  await runtime.submitWork(f.contribution);
  await runtime.idle();
  const change = runtime.snapshot.configuration!.changes[0];
  await runtime.decideChange({
    changeId: change.id,
    expectedRevision: change.baseRevision,
    verdict: "refuse",
  });
  await runtime.idle();
  const result = recordedOperatorWork(
    runtime.snapshot,
    "worker",
    "main",
    f.contribution.correlationId,
  )!.result;
  equal(result.status, "completed");
  equal(
    result.messages.filter((message) =>
      message.text === "Refusal acknowledged without using that host."
    ).length,
    1,
  );
  equal(
    runtime.snapshot.configuration!.network?.allowedHosts.includes(
      "recovery.example",
    ),
    false,
  );
  deepStrictEqual(f.counts(), { decisions: 2, publications: 0 });
});

Deno.test("startup resumes a recorded refusal once without publishing a grant", async () => {
  const f = fixture();
  f.steps[1] = { kind: "reply", text: "Refusal recovered without a grant." };
  const runtime = f.create();
  await runtime.initialize();
  await runtime.submitWork(f.contribution);
  await runtime.idle();
  const change = runtime.snapshot.configuration!.changes[0];
  f.fail.beforeAttempt = true;
  await runtime.decideChange({
    changeId: change.id,
    expectedRevision: change.baseRevision,
    verdict: "refuse",
  });
  await rejects(() => runtime.idle(), /Before work dispatch/);
  const restarted = f.create();
  await restarted.initialize();
  const result = recordedOperatorWork(
    restarted.snapshot,
    "worker",
    "main",
    f.contribution.correlationId,
  )!.result;
  equal(result.status, "completed");
  equal(
    result.messages.filter((message) =>
      message.text === "Refusal recovered without a grant."
    ).length,
    1,
  );
  await restarted.resumeDecidedChanges();
  await restarted.idle();
  deepStrictEqual(f.counts(), { decisions: 2, publications: 0 });
});

Deno.test("authoritative abandonment removes a pending work dialogue without an ACK or grant on restart", async () => {
  const f = fixture();
  const runtime = f.create();
  await runtime.initialize();
  await runtime.submitWork(f.contribution);
  await runtime.idle();
  const change = runtime.snapshot.configuration!.changes[0];
  await runtime.settleDelegatedCandidateActivations({
    caseId: f.contribution.proof.caseId!,
    abandon: true,
    closed: true,
  });
  equal(runtime.snapshot.changeWorkContinuations?.[change.id], undefined);
  equal(runtime.snapshot.changeDecisionContinuations?.[change.id], undefined);
  const restarted = f.create();
  await restarted.initialize();
  equal(
    restarted.snapshot.messages.some((message) => message.text === ack.text),
    false,
  );
  deepStrictEqual(f.counts(), { decisions: 1, publications: 0 });
});

Deno.test("unfinished change decisions resume exactly for pending, approved and refused states", async (t) => {
  interface Row {
    name: string;
    status?: PendingChange["status"];
    completedPublication?: boolean;
    decision?: "pending" | "feedback-sent" | "resumed";
    work?: boolean;
    expectResume: boolean;
  }
  const rows: Row[] = [
    {
      name: "no changes stays dormant",
      expectResume: false,
    },
    {
      name: "pending without publication or decision resumes",
      status: "pending",
      expectResume: true,
    },
    {
      name: "pending with a waiting decision resumes",
      status: "pending",
      decision: "pending",
      expectResume: true,
    },
    {
      name: "pending with completed publication and feedback resumes",
      status: "pending",
      completedPublication: true,
      decision: "feedback-sent",
      expectResume: true,
    },
    {
      name:
        "pending with completed publication and resumed decision still resumes",
      status: "pending",
      completedPublication: true,
      decision: "resumed",
      expectResume: true,
    },
    {
      name: "approved without publication or decision stays dormant",
      status: "approved",
      expectResume: false,
    },
    {
      name: "approved with completed publication and waiting decision resumes",
      status: "approved",
      completedPublication: true,
      decision: "pending",
      expectResume: true,
    },
    {
      name:
        "approved with completed publication and resumed decision stays dormant",
      status: "approved",
      completedPublication: true,
      decision: "resumed",
      expectResume: false,
    },
    {
      name: "refused with work continuation and waiting decision resumes",
      status: "refused",
      work: true,
      decision: "pending",
      expectResume: true,
    },
    {
      name:
        "refused with work continuation, completed publication and feedback resumes",
      status: "refused",
      work: true,
      completedPublication: true,
      decision: "feedback-sent",
      expectResume: true,
    },
    {
      name: "refused without work continuation stays dormant",
      status: "refused",
      decision: "pending",
      expectResume: false,
    },
    {
      name: "refused with work continuation but no decision stays dormant",
      status: "refused",
      work: true,
      expectResume: false,
    },
  ];
  for (const row of rows) {
    await t.step(row.name, async () => {
      const native = executableFixture({
        projectId: "unit",
        editingContextId: "unit",
        rootId: "root",
        systemId: "worker-system",
        catalogId: "catalog",
        builderId: "worker",
      });
      native.version.repositoryVersion = "source-1";
      const change: PendingChange = {
        id: "change-1",
        kind: "mandate-change",
        status: row.status ?? "pending",
        baseRevision: 0,
        reason: row.name,
        requestedAt: "now",
        ...(row.completedPublication
          ? { publication: { completed: true } }
          : {}),
      };
      let saved: SystemRuntimeState | null = {
        id: "session",
        revision: 0,
        catalogRevision: 0,
        messages: [],
        candidates: [],
        events: [],
        busy: false,
        phase: "ready",
        provider: "test",
        model: structuredClone(native.identity),
        executionModel: structuredClone(native),
        configuration: {
          ...structuredClone(native.configuration),
          changes: row.status ? [change] : [],
        },
        cases: [],
        ...(row.decision
          ? { changeDecisionContinuations: { "change-1": row.decision } }
          : {}),
        ...(row.work
          ? {
            changeWorkContinuations: {
              "change-1": {
                inputMessageId: "input-1",
                invocationKey: "key-1",
              },
            },
          }
          : {}),
      };
      let enqueued = 0;
      const service = new SystemRuntime({
        model: {
          ...unexpectedModelAuthoring,
          initialize: () => Promise.resolve(structuredClone(native.identity)),
          readExecutableModel: () => Promise.resolve(structuredClone(native)),
          previewApprovedChange: exactChangePreview(() => native),
          findApprovedChange: () => Promise.resolve(null),
          applyApprovedChange: () =>
            Promise.reject(new Error("No publication belongs here")),
          activateCandidate: () =>
            Promise.reject(new Error("No activation belongs here")),
          graph: () => Promise.resolve({}),
        },
        dispatch: {
          enqueue: (delivery) => {
            enqueued++;
            return Promise.resolve({
              id: delivery.id,
              threadId: "thread-1",
              jobId: "job-1",
              status: "queued" as const,
            });
          },
          inspect: () => Promise.resolve(null),
        },
        store: {
          load: () => Promise.resolve(structuredClone(saved)),
          save: (state, expected) => {
            equal(saved?.revision ?? null, expected);
            saved = structuredClone(state);
            return Promise.resolve();
          },
          close: () => Promise.resolve(),
        },
        agents: {
          label: "test",
          decide: () => Promise.resolve({ kind: "reply", text: "Idle." }),
          review: () => {
            throw new Error("Unexpected review");
          },
        },
        runner: {
          test: () => Promise.reject(new Error("Unexpected test")),
          run: () => Promise.reject(new Error("Unexpected effect")),
        },
      });
      await service.initialize(undefined, { resumeContinuations: false });
      equal(service.snapshot.error, undefined);
      // Incomplete publications are reconciled at startup by older suites;
      // every row here carries a completed publication or none, so the
      // observed resume bit is the truth table under test. The command is
      // only enqueued, never executed: no worker side effect follows.
      await service.resumeDecidedChanges();
      equal(
        enqueued > 0,
        row.expectResume,
        `expected resume=${row.expectResume}`,
      );
    });
  }
});
