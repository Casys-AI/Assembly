import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { SystemRuntime } from "../../../../test/support/system-runtime.ts";
import {
  enableCommandFixtureProfile,
  executableFixture,
} from "../../../../test/support/execution-fixture.ts";
import { legacyOwnerAuthority } from "../../../domain/governance/authority.ts";
import { createTestNativeExecution } from "../../../../test/support/native-execution.ts";
import { OperatorAuthorityError } from "../../../domain/governance/operator-authority.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import { ChangePublicationError } from "../../../domain/model/publication/change.ts";
import type {
  ChatDecision,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import type { ModelPort } from "./ports.ts";
import {
  nativeExecutionIdentity,
  runtimeRevisionReference,
} from "./execution.ts";
import { OperatorConversations } from "../operators/conversations.ts";
import {
  commandBusinessDecision,
  enqueueOperatorCommand,
  type OperatorCommandOrigin,
  OperatorCommandPending,
  parseAcceptedCommand,
  recordedCommandOutcome,
} from "../operators/command-delivery.ts";

const delegated = {
  actorId: "designer",
  policyId: "network",
  policyRevision: 1,
};
const input = {
  changeId: "request",
  expectedRevision: 0,
  verdict: "approve" as const,
};
const command: Extract<ChatDecision, { kind: "decide_operator_change" }> = {
  kind: "decide_operator_change",
  text: "Decide the recorded request",
  operatorId: "operator",
  ...input,
  policyId: "network",
  policyRevision: 1,
};
// A controlled receipt for the target worker, not proof of a native source.
const origin = {
  businessRevision: {
    __assemblyRuntimeRevision: {
      systemId: "designer-system",
      operatorId: delegated.actorId,
      invocationKey: "local:source-request",
      revision: 1,
      modelDigest: "designer-model",
    },
  },
  effectKey: "source-effect",
  inputMessageId: "source-input",
};
function bindControlledAuthority(service: SystemRuntime) {
  let checks = 0;
  service.bindOperatorCommandAuthority((actualCommand, actualOrigin) => {
    deepStrictEqual(actualCommand, { kind: "decide-change", input, delegated });
    deepStrictEqual(actualOrigin, origin);
    checks++;
    return Promise.resolve();
  });
  return () => checks;
}
async function enqueueDelegated(
  service: SystemRuntime,
  decision: {
    changeId: string;
    expectedRevision: number;
    verdict: "approve" | "refuse";
  } = input,
) {
  let pending!: OperatorCommandPending;
  await rejects(
    () => service.decideChange(decision, delegated, origin),
    (error) => {
      ok(error instanceof OperatorCommandPending);
      pending = error;
      deepStrictEqual(error.origin, origin);
      ok(error.receipt.id && error.receipt.threadId && error.receipt.jobId);
      return true;
    },
  );
  return pending;
}
async function runtime(
  id: string,
  decision: ChatDecision,
  mayProposeSysmlRevision = true,
) {
  const model = executableFixture({
    projectId: "unit",
    editingContextId: "unit",
    rootId: "root",
    systemId: id,
    catalogId: `${id}-catalog`,
    builderId: id,
  });
  model.version.repositoryVersion = "admitted";
  model.policy.mayProposeSysmlRevision = mayProposeSysmlRevision;
  if (decision.kind === "decide_operator_change") {
    enableCommandFixtureProfile(model);
  }
  model.ownerAuthority = {
    ...legacyOwnerAuthority(id),
    ownerSource: "modeled",
  };
  model.operatorAuthorityPolicies = [{
    id: "network",
    revision: 1,
    elementId: "policy",
    sourceIds: ["policy"],
    rootAuthority: structuredClone(model.ownerAuthority),
    holderNativeId: "designer",
    mandateNativeId: "designer-mandate",
    systemId: id,
    enabled: true,
    recipients: ["operator"],
    acts: ["addNetworkHosts"],
    networkHosts: ["example.org"],
    toolIds: [],
    maxDelegationDepth: 0,
  }];
  let saved: SystemRuntimeState | null = null;
  const source = {
    initialize: () => Promise.resolve(structuredClone(model.identity)),
    readExecutableModel: () => Promise.resolve(structuredClone(model)),
    findApprovedChange: () => Promise.resolve(null),
    applyApprovedChange: () => {
      throw new Error("Unexpected publication");
    },
  } as unknown as ModelPort;
  const store = {
    load: () => Promise.resolve(structuredClone(saved)),
    save: (state: SystemRuntimeState, expected: number | null) => {
      equal(saved?.revision ?? null, expected);
      saved = structuredClone(state);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  const native = createTestNativeExecution(store);
  let providerCalls = 0;
  const service = new SystemRuntime({
    model: source,
    ...(decision.kind === "decide_operator_change"
      ? {
        information: {
          read: () => Promise.resolve({ memoryGuidance: [] }),
          consultAdmittedModelSource(current, input) {
            equal(current.version.digest, model.version.digest);
            equal(current.version.repositoryVersion, "admitted");
            deepStrictEqual(input, {
              operation: "read_source",
              path: "conversation.sysml",
              version: "admitted",
            });
            return Promise.resolve({
              modelVersion: {
                digest: current.version.digest,
                repositoryVersion: current.version.repositoryVersion,
              },
              result: { path: input.path },
            });
          },
        },
      }
      : {}),
    store: native.store,
    execution: native.execution,
    dispatch: native.dispatch,
    stateHistory: native.stateHistory,
    agents: {
      label: "operator-authority-fixture",
      decide: (context) => {
        providerCalls++;
        const observed = context.messages.findLast((message) =>
          message.role === "tool" &&
          message.text.startsWith("Delegated decision result")
        );
        if (!observed) return Promise.resolve(structuredClone(decision));
        const result = JSON.parse(
          observed.text.split("\n").slice(1).join("\n"),
        );
        return Promise.resolve({
          kind: "reply" as const,
          text: result.status === "refused"
            ? `The request remains with the person: ${result.code}.`
            : "The recorded decision completed.",
        });
      },
      review: () => {
        throw new Error("Unexpected review");
      },
    },
    runner: {
      run: () => {
        throw new Error("Unexpected invocation");
      },
      test: () => {
        throw new Error("Unexpected test");
      },
    },
  });
  await service.initialize();
  native.bind(service);
  return {
    service,
    native,
    providerCalls: () => providerCalls,
    model,
    source,
    rewrite: (change: (state: SystemRuntimeState) => void) => change(saved!),
  };
}
async function fixture() {
  const target = await runtime("operator", { kind: "reply", text: "Ready" });
  await target.service.submit(
    "Open the operator request",
    undefined,
    undefined,
    true,
  );
  await target.service.idle();
  target.rewrite((state) =>
    state.configuration!.changes = [{
      id: "request",
      kind: "mandate-change",
      status: "pending",
      requestedBy: "operator",
      caseId: state.cases![0].id,
      baseModelDigest: target.model.version.digest,
      baseRevision: 0,
      requestedAt: "now",
      reason: "Read one host",
      requestedRights: { addNetworkHosts: ["example.org"] },
    }]
  );
  // Rebind the real worker to the retained queue/saver/history, preserving the
  // original Request's native waits rather than constructing a second ledger.
  const native = target.native;
  const service = new SystemRuntime({
    model: target.source,
    store: native.store,
    execution: native.execution,
    dispatch: native.dispatch,
    stateHistory: native.stateHistory,
    agents: {
      label: "target",
      decide: () => Promise.resolve({ kind: "reply", text: "Ready" }),
      review: () => {
        throw new Error("Unexpected review");
      },
    },
    runner: {
      run: () => {
        throw new Error("Unexpected invocation");
      },
      test: () => {
        throw new Error("Unexpected test");
      },
    },
  });
  await service.initialize();
  native.bind(service);
  return { ...target, service, native };
}
Deno.test("out-of-bounds delegated attempt changes only its exact durable refusal receipt", async () => {
  const f = await fixture();
  f.model.operatorAuthorityPolicies![0].networkHosts = ["other.example"];
  const before = f.service.snapshot;
  const authorityChecks = bindControlledAuthority(f.service);
  const pending = await enqueueDelegated(f.service);
  await f.service.idle();
  const accepted = await f.native.dispatch.inspectAccepted!(
    "operator",
    pending.receipt.id,
  );
  ok(accepted);
  equal(accepted.receipt.status, "completed");
  const command = parseAcceptedCommand(accepted.delivery)!;
  ok(command.decisionBaseline);
  equal(
    command.decisionBaseline.format,
    "operator-command-decision-baseline/v1",
  );
  equal(
    command.decisionBaseline.digest,
    await executionDigest(commandBusinessDecision(before, command.command)),
  );
  const after = f.service.snapshot;
  const result = await recordedCommandOutcome(after, command);
  ok(result?.outcome);
  equal(result.event.kind, "operator-command-refused");
  equal(result.outcome.acceptedDigest, await executionDigest(command));
  equal(result.outcome.revision, before.revision + 1);
  equal(after.events.length, before.events.length + 1);
  equal(result.outcome.result.status, "refused");
  await rejects(
    () => f.service.resumeOperatorCommand(command.command, origin),
    (error) => {
      ok(error instanceof OperatorAuthorityError);
      equal(error.code, "AUTHORITY_OUT_OF_BOUNDS");
      return true;
    },
  );
  equal(authorityChecks(), 1);
  // Only the exact refusal CAS is added; queue acceptance already retained
  // the baseline. No business state, message or native outcome is fabricated.
  deepStrictEqual({
    ...after,
    revision: before.revision,
    events: before.events,
  }, before);
});

for (
  const refusal of [
    "busy",
    "publication-revoked",
    "notification-retry",
    "stale-change",
    "stale-conversation",
  ] as const
) {
  Deno.test(`delegated ${refusal} gives coded feedback, keeps request pending and completes designer turn`, async () => {
    const target = await fixture();
    const designer = await runtime(
      "designer",
      command,
    );
    const manager = new OperatorConversations({
      primary: designer.service,
      factory: {
        open: () => Promise.resolve(target.service),
        close: () => Promise.resolve(),
      },
    });
    designer.service.bindOperatorRegistry(manager);
    target.service.bindOperatorRegistry(manager);
    await manager.initialize({
      repositoryVersion: "admitted",
      units: [designer, target].map((entry) => ({
        systemQualifiedName: `Example::${entry.model.identity.systemId}`,
        model: entry.service.snapshot.executionModel!,
      })),
    });
    // Controlled authority boundary: check the exact command and the origin
    // received from this designer turn. This is not a native provenance proof.
    let expectedOrigin: OperatorCommandOrigin | undefined;
    let authorityChecks = 0;
    target.service.bindOperatorCommandAuthority(
      (actualCommand, actualOrigin) => {
        deepStrictEqual(actualCommand, {
          kind: "decide-change",
          input,
          delegated,
        });
        ok(expectedOrigin);
        deepStrictEqual(actualOrigin, expectedOrigin);
        const source = actualOrigin.businessRevision.__assemblyRuntimeRevision;
        const designerState = designer.service.snapshot;
        equal(source.operatorId, delegated.actorId);
        equal(
          source.operatorId,
          designerState.executionModel!.identity.builderId,
        );
        equal(source.systemId, designerState.id);
        equal(source.modelDigest, designerState.executionModel!.version.digest);
        ok(Number.isSafeInteger(source.revision));
        ok(source.revision <= designerState.revision);
        ok(
          source.invocationKey && actualOrigin.effectKey &&
            actualOrigin.inputMessageId,
        );
        authorityChecks++;
        const policy = target.model.operatorAuthorityPolicies![0];
        equal(policy.id, delegated.policyId);
        equal(policy.revision, delegated.policyRevision);
        equal(policy.enabled, true);
        return Promise.resolve();
      },
    );
    designer.service.bindOperatorAuthorityLifecycle({
      decide: (chosen, sourceOrigin) => {
        ok(sourceOrigin);
        expectedOrigin = structuredClone(sourceOrigin);
        return manager.decideChange(
          {
            agentId: chosen.operatorId,
            changeId: chosen.changeId,
            expectedRevision: target.service.snapshot.revision +
              (refusal === "stale-conversation" ? 1 : 0),
            configurationRevision: chosen.expectedRevision +
              (refusal === "stale-change" ? 1 : 0),
            verdict: chosen.verdict,
          },
          delegated,
          sourceOrigin,
        );
      },
      proposed: () => Promise.resolve(),
      approved: () => Promise.resolve(),
      closed: () => Promise.resolve(),
    });
    let release: (() => void) | undefined;
    let busySubmission: ReturnType<typeof target.service.submit> | undefined;
    if (refusal === "busy") {
      let entered!: () => void;
      const portEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const read = target.source.readExecutableModel;
      target.source.readExecutableModel = () => {
        target.source.readExecutableModel = read;
        return new Promise((resolve) => {
          release = () => resolve(structuredClone(target.model));
          entered();
        });
      };
      busySubmission = target.service.submit(
        "Another operator request",
        undefined,
        undefined,
        true,
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          portEntered,
          // An early acceptance error must surface rather than hang behind a
          // port barrier or become an unobserved rejected submission.
          busySubmission.then(() => portEntered),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(new Error("Busy fixture did not enter its model port")),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      ok(release);
      equal(target.service.snapshot.busy, true);
      // Direct delegated control without source evidence refuses before enqueue;
      // the manager below independently checks the busy target.
      const beforeDirect = target.service.snapshot;
      await rejects(
        () => target.service.decideChange(input, delegated),
        /Delegated decisions require durable source evidence/,
      );
      deepStrictEqual(target.service.snapshot, beforeDirect);
    }
    let publicationAttempts = 0;
    if (refusal === "publication-revoked" || refusal === "notification-retry") {
      target.source.applyApprovedChange = () => {
        publicationAttempts++;
        target.model.operatorAuthorityPolicies![0].enabled = false;
        return Promise.reject(
          new ChangePublicationError(
            "PUBLICATION_NOT_APPLICABLE",
            { changeId: "request" },
            "Policy revoked under writer lock",
          ),
        );
      };
    }
    const notifications: Parameters<
      typeof designer.service.enqueueContinuation
    >[0][] = [];
    const enqueue = designer.service.enqueueContinuation.bind(designer.service);
    designer.service.enqueueContinuation = (value) => {
      notifications.push(structuredClone(value));
      return enqueue(value);
    };
    const notify = manager.notifyCommandCompletion.bind(manager);
    let interruptNotification = refusal === "notification-retry";
    manager.notifyCommandCompletion = async (accepted) => {
      await notify(accepted);
      if (interruptNotification) {
        interruptNotification = false;
        throw new Error(
          "Lost queue ACK after canonical refusal and notification",
        );
      }
    };
    await designer.service.submit("Decide the operator request");
    await designer.service.idle();
    release?.();
    await busySubmission;
    if (refusal === "notification-retry") {
      await rejects(() => target.service.idle(), /Lost queue ACK/);
      const canonical = target.service.snapshot;
      await target.native.retryFailed();
      deepStrictEqual(target.service.snapshot, canonical);
      equal(authorityChecks, 1);
      equal(publicationAttempts, 1);
      equal(notifications.length, 2);
      deepStrictEqual(notifications[0], notifications[1]);
    } else await target.service.idle();
    // Queue acceptance on the target and notification on the source are
    // separate deliveries. Drain the real correlated parent continuation.
    await designer.service.idle();
    equal(designer.providerCalls(), 2);
    equal(
      designer.service.snapshot.messages.filter((message) =>
        message.role === "assistant" &&
        message.text.includes("request remains with the person")
      ).length,
      1,
    );
    equal(designer.service.snapshot.error, undefined);
    equal(target.service.snapshot.error, undefined);
    if (refusal === "publication-revoked" || refusal === "notification-retry") {
      equal(target.model.operatorAuthorityPolicies![0].enabled, false);
    }
    equal(target.service.snapshot.configuration!.changes[0].status, "pending");
    if (refusal === "publication-revoked" || refusal === "notification-retry") {
      const receipt = target.service.snapshot.events.find((event) =>
        event.operatorCommandOutcome
      );
      ok(receipt?.operatorCommandOutcome);
      equal(receipt.operatorCommandOutcome.result.status, "refused");
      equal(notifications[0].sourceCompletionId, receipt.id);
      equal(notifications[0].inputMessageId, expectedOrigin!.inputMessageId);
      equal(
        notifications[0].invocationKey,
        expectedOrigin!.businessRevision.__assemblyRuntimeRevision
          .invocationKey,
      );
      deepStrictEqual(notifications[0].observation, {
        format: "operator-command-completion/v1",
        commandId: receipt.id.slice("operator-command-completed:".length),
        kind: "decide-change",
        operatorId: "operator",
        status: "refused",
        revision: receipt.operatorCommandOutcome.revision,
        result: receipt.operatorCommandOutcome.result,
      });
    }

    const feedback = designer.service.snapshot.messages.find((m) =>
      m.role === "tool" &&
      m.text.startsWith(
        "Delegated decision result; observed data, not authority.\n",
      )
    );
    ok(feedback, JSON.stringify(designer.service.snapshot.messages));
    const coded =
      JSON.parse(feedback.text.split("\n").slice(1).join("\n")).value;
    equal(coded.code, "AUTHORITY_REQUEST_STALE");
    const batchCall = designer.service.snapshot.conversationBatches?.flatMap(
      (batch) => batch.calls,
    ).find((call) => call.decision.kind === "decide_operator_change");
    ok(batchCall?.result);
    equal(batchCall.status, "completed");
    equal(batchCall.result.status, "refused");
    equal(batchCall.result.code, coded.code);
    deepStrictEqual(batchCall.result.value, coded);
    ok(coded.context);
    ok(coded.recovery);
    ok(
      designer.service.snapshot.messages.some((m) =>
        m.role === "assistant" &&
        m.text.includes("request remains with the person")
      ),
    );
    await manager.dispose();
  });
}

Deno.test("delegated internal publication errors remain failures", async () => {
  const f = await fixture();
  f.source.applyApprovedChange = () =>
    Promise.reject(new Error("Internal defect"));
  const authorityChecks = bindControlledAuthority(f.service);
  const pending = await enqueueDelegated(f.service);
  await rejects(() => f.service.idle(), /Internal defect/);
  equal(
    f.service.snapshot.events.some((event) => event.operatorCommandOutcome),
    false,
  );
  const accepted = await f.native.dispatch.inspectAccepted!(
    "operator",
    pending.receipt.id,
  );
  equal(accepted!.receipt.status, "failed");
  await rejects(
    () =>
      f.service.resumeOperatorCommand(
        parseAcceptedCommand(accepted!.delivery)!.command,
        origin,
      ),
    /explicit receipt inspection/,
  );
  equal(authorityChecks(), 1);
  ok(f.service.snapshot.error?.includes("Internal defect"));
});

Deno.test("host refuses an unauthorized operator authority proposal", async () => {
  const f = await runtime("designer", {
    kind: "propose_mandate_change",
    text: "Ask for authority",
    reason: "Bounded policy",
    requestedRights: {
      operatorAuthority: {
        policyId: "network",
        expectedPolicyRevision: 0,
        enabled: true,
        recipients: ["operator"],
        acts: ["addNetworkHosts"],
        networkHosts: ["example.org"],
        toolIds: [],
        maxDelegationDepth: 0,
      },
    },
  }, false);
  await f.service.submit("Request the policy");
  await rejects(() => f.service.idle(), (error) => {
    ok(error instanceof OperatorAuthorityError);
    equal(error.code, "AUTHORITY_POLICY_FORBIDDEN");
    equal(
      error.message,
      "Only the Main Operator may request its bounded authority; self recipients are forbidden",
    );
    return true;
  });
  ok(f.service.snapshot.error);
  deepStrictEqual(f.service.snapshot.configuration!.changes, []);
  equal(
    f.service.snapshot.error,
    "Only the Main Operator may request its bounded authority; self recipients are forbidden",
  );
});

for (const blocker of ["unknown-native-effect", "published-change"] as const) {
  Deno.test(`late authority refusal cannot mask ${blocker}`, async () => {
    const f = await fixture();
    const refusal = new OperatorAuthorityError(
      "AUTHORITY_REQUEST_STALE",
      "Late policy refusal",
      { changeId: "request" },
    );
    let authorityChecks = 0;
    f.service.bindOperatorCommandAuthority(() => {
      authorityChecks++;
      return Promise.reject(refusal);
    });
    if (blocker === "unknown-native-effect") {
      const inspect = f.native.execution.inspect.bind(f.native.execution);
      f.native.execution.inspect = async (operatorId) => {
        const snapshots = await inspect(operatorId);
        ok(snapshots.length > 0);
        return snapshots.map((snapshot) => ({
          ...snapshot,
          status: "uncertain" as const,
        }));
      };
    } else {f.source.findApprovedChange = () =>
        Promise.resolve({ model: structuredClone(f.model) });}
    const pending = await enqueueDelegated(f.service);
    await rejects(() => f.service.idle(), (error) => error === refusal);
    equal(authorityChecks, 1);
    equal(
      f.service.snapshot.events.some((event) => event.operatorCommandOutcome),
      false,
    );
    const accepted = await f.native.dispatch.inspectAccepted!(
      "operator",
      pending.receipt.id,
    );
    equal(accepted!.receipt.status, "failed");
    await rejects(
      () =>
        f.service.resumeOperatorCommand(
          parseAcceptedCommand(accepted!.delivery)!.command,
          origin,
        ),
      /explicit receipt inspection/,
    );
  });
}

Deno.test("a real delegated refusal decision records typed command success with exact accepted digest", async () => {
  const f = await fixture();
  const decision = { ...input, verdict: "refuse" as const };
  let authorityChecks = 0;
  f.service.bindOperatorCommandAuthority((actual, actualOrigin) => {
    deepStrictEqual(actual, {
      kind: "decide-change",
      input: decision,
      delegated,
    });
    deepStrictEqual(actualOrigin, origin);
    authorityChecks++;
    return Promise.resolve();
  });
  const pending = await enqueueDelegated(f.service, decision);
  await f.service.idle();
  equal(f.service.snapshot.configuration!.changes[0].status, "refused");
  const accepted = await f.native.dispatch.inspectAccepted!(
    "operator",
    pending.receipt.id,
  );
  const command = parseAcceptedCommand(accepted!.delivery)!;
  const result = await recordedCommandOutcome(f.service.snapshot, command);
  ok(result?.outcome);
  equal(accepted!.receipt.status, "completed");
  equal(result.event.kind, "operator-command-completed");
  equal(result.outcome.acceptedDigest, await executionDigest(command));
  deepStrictEqual(result.outcome.result, { status: "succeeded" });
  equal(await f.service.resumeOperatorCommand(command.command, origin), true);
  equal(authorityChecks, 1);
});

Deno.test("late refusal cannot commit across a canonical revision change during its publication check", async () => {
  const f = await fixture();
  f.service.bindOperatorCommandAuthority(() =>
    Promise.reject(
      new OperatorAuthorityError(
        "AUTHORITY_REQUEST_STALE",
        "Late policy refusal",
      ),
    )
  );
  let checked = false;
  f.source.findApprovedChange = async () => {
    checked = true;
    const invocation = f.service.snapshot.caseInvocation;
    ok(invocation);
    await f.service.restoreCaseInvocation(invocation);
    return null;
  };
  await enqueueDelegated(f.service);
  await rejects(
    () => f.service.idle(),
    /refusal state changed before its canonical CAS/,
  );
  equal(checked, true);
  equal(
    f.service.snapshot.events.some((event) => event.operatorCommandOutcome),
    false,
  );
  equal(f.service.snapshot.configuration!.changes[0].status, "pending");
});

Deno.test("a late authority error after the exact refusal decision cannot replace that committed business result", async () => {
  const f = await fixture();
  const decision = { ...input, verdict: "refuse" as const };
  f.service.bindOperatorCommandAuthority(() => Promise.resolve());
  const failure = new OperatorAuthorityError(
    "AUTHORITY_REQUEST_STALE",
    "Continuation authority changed after business decision",
  );
  const read = f.source.readExecutableModel;
  let afterCommit = false;
  f.source.readExecutableModel = (...args) => {
    if (f.service.snapshot.configuration!.changes[0].status === "refused") {
      afterCommit = true;
      return Promise.reject(failure);
    }
    return read(...args);
  };
  const pending = await enqueueDelegated(f.service, decision);
  await rejects(() => f.service.idle(), (error) => error === failure);
  equal(afterCommit, true);
  const state = f.service.snapshot;
  equal(state.configuration!.changes[0].status, "refused");
  ok(state.configuration!.changes[0].decidedAt);
  equal(
    state.events.filter((event) =>
      event.kind === "configuration-change-refused" &&
      event.changeId === "request"
    ).length,
    1,
  );
  equal(state.events.some((event) => event.operatorCommandOutcome), false);
  const accepted = await f.native.dispatch.inspectAccepted!(
    "operator",
    pending.receipt.id,
  );
  equal(accepted!.receipt.status, "failed");
  await rejects(
    () =>
      f.service.resumeOperatorCommand(
        parseAcceptedCommand(accepted!.delivery)!.command,
        origin,
      ),
    /explicit receipt inspection/,
  );

  // The same accepted ID must retain its original pre-decision baseline on
  // retry, even though its business verdict is now present at worker reload.
  f.source.readExecutableModel = read;
  await rejects(() => f.native.retryFailed(), (error) => {
    ok(error instanceof OperatorAuthorityError);
    equal(error.code, "AUTHORITY_REQUEST_STALE");
    return true;
  });
  equal(
    f.service.snapshot.events.some((event) => event.operatorCommandOutcome),
    false,
  );
  deepStrictEqual(
    await f.native.dispatch.inspectAccepted!("operator", pending.receipt.id),
    accepted,
  );
  equal(f.service.snapshot.configuration!.changes[0].status, "refused");

  // A different command against the already recorded verdict may still return
  // its own known refusal; that old unchanged decision is not a new effect.
  f.source.readExecutableModel = read;
  const nextOrigin = { ...origin, effectKey: "new-source-effect" };
  await rejects(
    () => f.service.decideChange(input, delegated, nextOrigin),
    OperatorCommandPending,
  );
  await f.service.idle();
  const receipt = f.service.snapshot.events.find((event) =>
    event.operatorCommandOutcome
  );
  ok(receipt?.operatorCommandOutcome);
  equal(receipt.operatorCommandOutcome.result.status, "refused");
  equal(f.service.snapshot.configuration!.changes[0].status, "refused");
  equal(
    f.service.snapshot.events.filter((event) =>
      event.kind === "configuration-change-refused"
    ).length,
    1,
  );
});

Deno.test("an accepted queue interruption preserves its immutable baseline before domain dispatch", async () => {
  const f = await fixture();
  const enqueue = f.native.dispatch.enqueue.bind(f.native.dispatch);
  let acceptedDelivery: Parameters<typeof enqueue>[0] | undefined;
  f.native.dispatch.enqueue = async (delivery) => {
    const receipt = await enqueue(delivery);
    if (delivery.kind === "command") {
      acceptedDelivery = structuredClone(delivery);
      throw new Error("Lost sender ACK after durable queue acceptance");
    }
    return receipt;
  };
  let releaseFirst!: () => void;
  const firstDispatch = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let checks = 0;
  f.service.bindOperatorCommandAuthority(() => {
    checks++;
    if (checks === 1) {
      return firstDispatch.then(() => {
        throw new Error("Interrupted before domain dispatch");
      });
    }
    return Promise.reject(
      new OperatorAuthorityError(
        "AUTHORITY_POLICY_STALE",
        "Known refusal on resumed command",
      ),
    );
  });
  const pending = await enqueueDelegated(f.service);
  releaseFirst();
  await rejects(() => f.service.idle(), /Interrupted before domain dispatch/);
  ok(acceptedDelivery);
  const first = await f.native.dispatch.inspectAccepted!(
    "operator",
    pending.receipt.id,
  );
  const command = parseAcceptedCommand(first!.delivery)!;
  ok(command.decisionBaseline);
  equal(
    f.service.snapshot.events.some((event) => event.operatorCommandOutcome),
    false,
  );
  await f.native.retryFailed();
  const resumed = await f.native.dispatch.inspectAccepted!(
    "operator",
    pending.receipt.id,
  );
  deepStrictEqual(resumed!.delivery, acceptedDelivery);
  deepStrictEqual(
    parseAcceptedCommand(resumed!.delivery)!.decisionBaseline,
    command.decisionBaseline,
  );
  const result = await recordedCommandOutcome(f.service.snapshot, command);
  equal(result?.outcome?.result.status, "refused");
  equal(f.service.snapshot.configuration!.changes[0].status, "pending");
  equal(checks, 2);
});

Deno.test("a forged accepted scope cannot mutate canonical target state", async () => {
  const f = await fixture();
  const before = f.service.snapshot;
  const identity = nativeExecutionIdentity(
    before,
    "conversation",
    "forged-scope-command",
  );
  identity.scope = {
    kind: "request",
    scopeId: "foreign-request",
    rootRequestId: "foreign-request",
  };
  let authorityChecks = 0;
  f.service.bindOperatorCommandAuthority(() => {
    authorityChecks++;
    return Promise.resolve();
  });
  await enqueueOperatorCommand(f.native.dispatch, {
    id: "forged-scope-command",
    identity,
    decisionBaseline: {
      format: "operator-command-decision-baseline/v1",
      digest: "a".repeat(64),
    },
    modelPin: {
      modelDigest: before.executionModel!.version.digest,
      repositoryVersion: before.executionModel!.version.repositoryVersion,
    },
    command: { kind: "decide-change", input, delegated },
    origin,
  });
  await rejects(() => f.service.idle(), /exact scope\/model changed/);
  equal(authorityChecks, 0);
  deepStrictEqual(f.service.snapshot, before);
});

for (const historicalVerdict of [true, false]) {
  Deno.test(`unflagged legacy command ${historicalVerdict ? "cannot reclassify an existing verdict as a known refusal" : "still records its actual successful decision"}`, async () => {
    const f = await fixture();
    if (historicalVerdict) {
      f.rewrite((state) => {
        state.configuration!.changes[0].status = "refused";
        state.configuration!.changes[0].decidedAt = "2026-10-29T00:00:00.000Z";
      });
    }
    const before = f.service.snapshot;
    const id = "legacy-without-decision-baseline";
    const decision = {
      ...input,
      verdict: historicalVerdict ? "approve" as const : "refuse" as const,
    };
    f.service.bindOperatorCommandAuthority(() => Promise.resolve());
    await enqueueOperatorCommand(f.native.dispatch, {
      id,
      identity: nativeExecutionIdentity(before, "conversation", id),
      modelPin: {
        modelDigest: before.executionModel!.version.digest,
        repositoryVersion: before.executionModel!.version.repositoryVersion,
      },
      command: { kind: "decide-change", input: decision, delegated },
      origin,
    });
    if (historicalVerdict) {
      await rejects(() => f.service.idle(), (error) => {
        ok(error instanceof OperatorAuthorityError);
        equal(error.code, "AUTHORITY_REQUEST_STALE");
        return true;
      });
    } else await f.service.idle();
    const state = f.service.snapshot;
    const accepted = await f.native.dispatch.inspectAccepted!("operator", id);
    const result = await recordedCommandOutcome(
      state,
      parseAcceptedCommand(accepted!.delivery)!,
    );
    if (historicalVerdict) {
      equal(accepted!.receipt.status, "failed");
      equal(result, undefined);
    } else {
      equal(accepted!.receipt.status, "completed");
      deepStrictEqual(result!.outcome!.result, { status: "succeeded" });
    }
    equal(state.configuration!.changes[0].status, "refused");
  });
}

Deno.test("first acceptance collision cannot reuse a foreign winning model pin", async () => {
  const f = await fixture();
  const before = f.service.snapshot;
  const enqueue = f.native.dispatch.enqueue.bind(f.native.dispatch);
  f.native.dispatch.enqueue = async (delivery) => {
    const foreign = structuredClone(delivery);
    foreign.modelPin.modelDigest = "foreign-pin";
    await enqueue(foreign);
    throw new Error("Concurrent acceptance returned a different immutable pin");
  };
  let checks = 0;
  f.service.bindOperatorCommandAuthority(() => {
    checks++;
    return Promise.resolve();
  });
  await rejects(
    () => f.service.decideChange(input, delegated, origin),
    /winning command has different target\/source intent/,
  );
  await rejects(() => f.service.idle(), /exact scope\/model changed/);
  equal(checks, 0);
  deepStrictEqual(f.service.snapshot, before);
});

for (
  const previous of [
    "with-revision",
    "absent",
    "foreign-pin",
    "failed",
  ] as const
) {
  Deno.test(`legacy completed command notification ${previous} preserves exact durable acceptance across target advance`, async () => {
    const target = await fixture();
    const designer = await runtime("designer", {
      kind: "reply",
      text: "Historical source input",
    });
    await designer.service.submit("Recorded source input");
    await designer.service.idle();
    const source = designer.service.snapshot;
    const legacyOrigin: OperatorCommandOrigin = {
      businessRevision: runtimeRevisionReference(source),
      inputMessageId: source.activeInputMessageId!,
      effectKey: "controlled-legacy-source-effect",
    };
    target.service.bindOperatorCommandAuthority(() => Promise.resolve());
    let pending!: OperatorCommandPending;
    await rejects(
      () =>
        target.service.decideChange(
          { ...input, verdict: "refuse" },
          delegated,
          legacyOrigin,
        ),
      (error) => {
        ok(error instanceof OperatorCommandPending);
        pending = error;
        return true;
      },
    );
    await target.service.idle();
    const completed = await target.native.dispatch.inspectAccepted!(
      "operator",
      pending.receipt.id,
    );
    equal(completed!.receipt.status, "completed");
    const accepted = parseAcceptedCommand(completed!.delivery)!;
    const success = await recordedCommandOutcome(
      target.service.snapshot,
      accepted,
    );
    deepStrictEqual(success!.outcome!.result, { status: "succeeded" });
    equal(target.service.snapshot.configuration!.changes[0].status, "refused");
    // Represent the historical encoding of this REAL completed business act.
    // Only new-format metadata is omitted; no success or authority is invented.
    const stored = (await target.native.store.load())!;
    delete stored.events.find((event) => event.id === success!.event.id)!
      .operatorCommandOutcome;
    const revision = stored.revision++;
    await target.native.store.save(stored, revision);
    await target.service.initialize(undefined, {
      resumeContinuations: false,
      resumeCandidateContinuations: false,
    });
    const manager = new OperatorConversations({
      primary: designer.service,
      factory: {
        open: () => Promise.resolve(target.service),
        close: () => Promise.resolve(),
      },
    });
    await manager.initialize({
      repositoryVersion: "admitted",
      units: [designer, target].map((entry) => ({
        systemQualifiedName: `Example::${entry.model.identity.systemId}`,
        model: entry.service.snapshot.executionModel!,
      })),
    });
    // Observe real queue delivery here; parent graph outcome/refusal recovery is
    // independently covered by the typed-command tests above and the PG case.
    const delivered: Parameters<
      typeof designer.service.processAcceptedContribution
    >[0][] = [];
    designer.native.bind({
      snapshot: designer.service.snapshot,
      processAcceptedContribution: (delivery) => {
        delivered.push(structuredClone(delivery));
        return previous === "failed"
          ? Promise.reject(
            new Error("Controlled legacy notification delivery failure"),
          )
          : Promise.resolve();
      },
      idle: designer.native.idle,
    });
    const notification = {
      id: `operator-command-result:${accepted.id}`,
      invocationKey: legacyOrigin.businessRevision.__assemblyRuntimeRevision
        .invocationKey!,
      inputMessageId: legacyOrigin.inputMessageId,
      sourceOperatorId: "operator",
      sourceCompletionId: success!.event.id,
      observation: {
        format: "operator-command-completion/v1",
        commandId: accepted.id,
        kind: accepted.command.kind,
        operatorId: "operator",
        status: "completed",
        revision: target.service.snapshot.revision,
      },
    };
    if (previous === "with-revision" || previous === "failed") {
      await designer.service.enqueueContinuation(notification);
      if (previous === "failed") {
        await rejects(
          () => designer.native.idle(),
          /Controlled legacy notification delivery failure/,
        );
      } else await designer.native.idle();
    } else if (previous === "foreign-pin") {
      await designer.native.dispatch.enqueue({
        id: notification.id,
        kind: "continuation",
        identity: nativeExecutionIdentity(
          source,
          "conversation",
          legacyOrigin.inputMessageId,
        ),
        modelPin: {
          modelDigest: "foreign-parent-pin",
          repositoryVersion: "admitted",
        },
        payload: {
          ...notification,
          invocation: structuredClone(source.caseInvocation),
        },
      });
      await designer.native.idle();
    }
    const before = await designer.native.dispatch.inspectAccepted!(
      "designer",
      notification.id,
    );
    const invocation = target.service.snapshot.caseInvocation;
    ok(invocation);
    await target.service.restoreCaseInvocation(invocation);
    if (previous === "failed") {
      await rejects(
        () => manager.notifyCommandCompletion(accepted),
        /explicit receipt inspection/,
      );
      deepStrictEqual(
        await designer.native.dispatch.inspectAccepted!(
          "designer",
          notification.id,
        ),
        before,
      );
      equal(delivered.length, 1);
    } else if (previous === "foreign-pin") {
      await rejects(
        () => manager.notifyCommandCompletion(accepted),
        /different source identity\/pin/,
      );
      deepStrictEqual(
        await designer.native.dispatch.inspectAccepted!(
          "designer",
          notification.id,
        ),
        before,
      );
      equal(delivered.length, 1);
    } else {
      await manager.notifyCommandCompletion(accepted);
      await designer.native.idle();
      const first = await designer.native.dispatch.inspectAccepted!(
        "designer",
        notification.id,
      );
      ok(first);
      equal(first.receipt.status, "completed");
      if (previous === "with-revision") deepStrictEqual(first, before);
      else {deepStrictEqual(first.delivery.payload!.observation, {
          format: "operator-command-completion/v1",
          commandId: accepted.id,
          kind: accepted.command.kind,
          operatorId: "operator",
          status: "completed",
        });}
      await target.service.restoreCaseInvocation(invocation);
      await manager.notifyCommandCompletion(accepted);
      await designer.native.idle();
      deepStrictEqual(
        await designer.native.dispatch.inspectAccepted!(
          "designer",
          notification.id,
        ),
        first,
      );
      equal(delivered.length, 1);
      equal(designer.providerCalls(), 1);
    }
    await manager.dispose();
  });
}
