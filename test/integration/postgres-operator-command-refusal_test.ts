/** Controlled model/authority ports; real SystemRuntime parent/target,
 * canonical CAS/history, pg-boss, official saver and native execution ledger.
 * The injected fault is a returned failure after the refusal CAS and before
 * notification, followed by stop/reopen of the same database/job. No Toolkit,
 * autonomous provider, writer-lock revocation or OS-process kill is claimed. */
import assert from "node:assert/strict";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { OperatorConversations } from "../../src/application/work/operators/conversations.ts";
import {
  type AcceptedOperatorCommand,
  type OperatorCommandOrigin,
  parseAcceptedCommand,
  recordedCommandOutcome,
} from "../../src/application/work/operators/command-delivery.ts";
import { exactDelegatedCommandDecision } from "../../src/application/governance/operator-command-origin.ts";
import { legacyOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { OperatorAuthorityError } from "../../src/domain/governance/operator-authority.ts";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";
import type { ModelPort } from "../../src/application/work/runtime/ports.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import {
  enableCommandFixtureProfile,
  executableFixture,
} from "../support/execution-fixture.ts";
import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import { openPostgresDurableRecoveryHost } from "../support/postgres-runtime-fixture.ts";
import { postgresTestEnabled } from "../support/postgres.ts";

function modelFor(operatorId: string): ExecutableModel {
  const model = executableFixture({
    projectId: "git:command-refusal",
    editingContextId: "command-refusal-context",
    rootId: "root",
    systemId: `${operatorId}-system`,
    catalogId: `${operatorId}-catalog`,
    builderId: operatorId,
  });
  model.version.digest = (operatorId === "designer" ? "a" : "b").repeat(64);
  model.version.repositoryVersion = "c".repeat(40);
  model.ownerAuthority = {
    ...legacyOwnerAuthority(model.identity.systemId),
    ownerSource: "modeled",
  };
  model.operatorAuthorityPolicies = [{
    id: "network",
    revision: 1,
    elementId: "network-policy",
    sourceIds: ["network-policy"],
    rootAuthority: structuredClone(model.ownerAuthority),
    holderNativeId: "designer",
    mandateNativeId: "designer-mandate",
    systemId: model.identity.systemId,
    enabled: true,
    recipients: ["operator"],
    acts: ["addNetworkHosts"],
    networkHosts: ["example.org"],
    toolIds: [],
    maxDelegationDepth: 0,
  }];
  if (operatorId === "designer") {
    model.policy.mayProposeSysmlRevision = true;
    enableCommandFixtureProfile(model);
  }
  return model;
}

Deno.test({
  name:
    "PG typed operator command refusal survives receipt-notification gap and wakes its exact parent once",
  ignore: !postgresTestEnabled,
  async fn() {
    const recovery = await openPostgresDurableRecoveryHost({
      scope: {
        projectId: "git:command-refusal",
        systemId: "command-refusal-host",
      },
    });
    const models = {
      designer: modelFor("designer"),
      operator: modelFor("operator"),
    };
    const delegated = {
      actorId: "designer",
      policyId: "network",
      policyRevision: 1,
    };
    let providerCalls = 0, authorityChecks = 0, publications = 0;
    let accepted: AcceptedOperatorCommand | undefined;
    const handlerFailures: { commandId: string; error: unknown }[] = [];
    const notices: Parameters<SystemRuntime["enqueueContinuation"]>[0][] = [];
    let faultReached!: () => void;
    const fault = new Promise<void>((resolve) => {
      faultReached = resolve;
    });
    const sourceFor = (model: ExecutableModel): ModelPort => ({
      ...unexpectedModelAuthoring,
      initialize: () => Promise.resolve(structuredClone(model.identity)),
      readExecutableModel: (_identity, version) => {
        assert(!version || version === model.version.repositoryVersion);
        return Promise.resolve(structuredClone(model));
      },
      findApprovedChange: () => Promise.resolve(null),
      findCandidate: () => Promise.resolve(null),
      applyApprovedChange: () => {
        publications++;
        throw new Error("Refused command must not publish");
      },
      activateCandidate: () => {
        throw new Error("No candidate activation");
      },
      graph: () => Promise.resolve({}),
    });
    const open = async (interrupt: boolean) => {
      const session = await recovery.openSession();
      const targetPorts = await session.runtimePortsFor("operator");
      const designerPorts = await session.runtimePortsFor("designer");
      const target = new SystemRuntime({
        ...targetPorts,
        model: sourceFor(models.operator),
        agents: {
          label: "Controlled target reply",
          decide: () =>
            Promise.resolve({ kind: "reply", text: "Target ready" }),
          review: () => {
            throw new Error("No target review");
          },
        },
        runner: {
          run: () => {
            throw new Error("No tool effect");
          },
          test: () => {
            throw new Error("No candidate tests");
          },
        },
      });
      const designer = new SystemRuntime({
        ...designerPorts,
        model: sourceFor(models.designer),
        agents: {
          label: "Controlled delegated choice and final reply",
          decide: (context) => {
            providerCalls++;
            const result = context.messages.findLast((message) =>
              message.role === "tool" &&
              message.text.startsWith(
                "Delegated decision result; observed data, not authority.\n",
              )
            );
            if (result) {
              const parsed = JSON.parse(
                result.text.split("\n").slice(1).join("\n"),
              );
              assert.equal(parsed.status, "refused");
              assert.equal(parsed.code, "AUTHORITY_POLICY_STALE");
              return Promise.resolve({
                kind: "reply" as const,
                text: "The exact delegated command was refused.",
              });
            }
            assert.equal(
              providerCalls,
              1,
              "Restart must not choose the command again",
            );
            return Promise.resolve({
              kind: "decide_operator_change" as const,
              text: "Decide the recorded request",
              operatorId: "operator",
              changeId: "change-1",
              expectedRevision: 0,
              verdict: "approve" as const,
              policyId: "network",
              policyRevision: 1,
            });
          },
          review: () => {
            throw new Error("No designer review");
          },
        },
        information: {
          read: () => Promise.resolve({ memoryGuidance: [] }),
          consultAdmittedModelSource: (model, input) => {
            assert.equal(input.version, model.version.repositoryVersion);
            return Promise.resolve({
              modelVersion: {
                digest: model.version.digest,
                repositoryVersion: model.version.repositoryVersion,
              },
              result: { path: input.path },
            });
          },
        },
        runner: {
          run: () => {
            throw new Error("No tool effect");
          },
          test: () => {
            throw new Error("No candidate tests");
          },
        },
      });
      await target.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      await designer.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      const manager = new OperatorConversations({
        primary: designer,
        factory: {
          open: () => Promise.resolve(target),
          close: () => Promise.resolve(),
        },
      });
      target.bindOperatorRegistry(manager);
      designer.bindOperatorRegistry(manager);
      await manager.initialize({
        repositoryVersion: models.designer.version.repositoryVersion!,
        units: [models.designer, models.operator].map((model) => ({
          systemQualifiedName: `Example::${model.identity.systemId}`,
          model,
        })),
      });
      target.bindOperatorCommandAuthority(async (command, origin) => {
        // Reuse the production native-origin and exact canonical choice
        // validators. The controlled authority port then refuses this act;
        // it never grants permission or performs a domain publication.
        await session.native.assertCommandOrigin(origin);
        const ref = origin.businessRevision.__assemblyRuntimeRevision;
        assert.equal(ref.operatorId, "designer");
        const history = await designerPorts.stateHistory.loadRevision(
          ref.revision,
        );
        assert(history);
        assert.equal(history.id, ref.systemId);
        assert.equal(history.executionModel!.version.digest, ref.modelDigest);
        assert(
          exactDelegatedCommandDecision(history, "operator", command, origin),
        );
        authorityChecks++;
        throw new OperatorAuthorityError(
          "AUTHORITY_POLICY_STALE",
          "Controlled current policy refuses the accepted act",
          {
            changeId: "change-1",
            policyId: "network",
          },
        );
      });
      designer.bindOperatorAuthorityLifecycle({
        decide: (chosen, origin) => {
          assert(origin);
          return manager.decideChange(
            {
              agentId: chosen.operatorId,
              changeId: chosen.changeId,
              expectedRevision: target.snapshot.revision,
              configurationRevision: chosen.expectedRevision,
              verdict: chosen.verdict,
            },
            delegated,
            origin,
          );
        },
        proposed: () => Promise.resolve(),
        approved: () => Promise.resolve(),
        closed: () => Promise.resolve(),
      });
      const enqueue = designer.enqueueContinuation.bind(designer);
      designer.enqueueContinuation = (input) => {
        notices.push(structuredClone(input));
        return enqueue(input);
      };
      const notify = manager.notifyCommandCompletion.bind(manager);
      manager.notifyCommandCompletion = async (input) => {
        accepted = structuredClone(input);
        const receipt = await recordedCommandOutcome(target.snapshot, input);
        assert.equal(receipt?.outcome?.result.status, "refused");
        if (interrupt) {
          faultReached();
          throw new Error("Injected after refusal CAS before notification");
        }
        await notify(input);
      };
      await session.start(async (delivery) => {
        const runtime = delivery.identity.operatorId === "designer"
          ? designer
          : target;
        assert.equal(
          runtime.snapshot.executionModel!.identity.builderId,
          delivery.identity.operatorId,
        );
        try {
          await runtime.processAcceptedContribution(delivery);
        } catch (error) {
          // Observe and rethrow the actual handler failure. Normal pg-boss job
          // failure is persisted by fail(), not emitted as a service error.
          handlerFailures.push({ commandId: delivery.id, error });
          throw error;
        }
      });
      return { session, target, designer, manager, targetPorts, designerPorts };
    };
    let current: Awaited<ReturnType<typeof open>> | undefined;
    try {
      current = await open(true);
      await current.target.submit(
        "Open the target Request",
        undefined,
        undefined,
        true,
      );
      await current.session.idle(current.target, 10000);
      // Controlled pending business input, persisted through the canonical CAS.
      // Neither a command result nor native source evidence is fabricated.
      const stored = await current.targetPorts.store.load();
      assert(stored?.configuration && stored.cases?.[0]);
      const next = structuredClone(stored);
      next.configuration!.changes.push({
        id: "change-1",
        kind: "mandate-change",
        status: "pending",
        requestedBy: "operator",
        caseId: stored.cases[0].id,
        baseModelDigest: models.operator.version.digest,
        baseRevision: 0,
        requestedAt: "2026-10-29T00:00:00.000Z",
        reason: "Read one host",
        requestedRights: { addNetworkHosts: ["example.org"] },
      });
      next.revision++;
      await current.targetPorts.store.save(next, stored.revision);
      await current.target.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      await current.designer.submit("Decide the exact target request");
      // Observe queue failure concurrently so a provider/origin failure before
      // the injection is reported, rather than hidden by a port promise.
      const settled = current.session.idle(undefined, 10000).then(
        () => undefined,
        (error: unknown) => error,
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          fault,
          settled.then((error) => {
            if (error) throw error;
            if (handlerFailures.length) throw handlerFailures[0].error;
            throw new Error(
              "Queue settled without entering the refusal notification boundary",
            );
          }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    "Refusal notification boundary was not reached within 10s",
                  ),
                ),
              10000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      const queueFailure = await settled;
      if (queueFailure !== undefined) throw queueFailure;
      assert(accepted?.origin);
      const command = structuredClone(accepted);
      assert(handlerFailures.length > 0);
      assert(
        handlerFailures.every((failure) =>
          failure.commandId === command.id &&
          failure.error instanceof Error &&
          failure.error.message ===
            "Injected after refusal CAS before notification"
        ),
      );
      assert.equal(
        command.decisionBaseline?.format,
        "operator-command-decision-baseline/v1",
      );
      const receipt = await recordedCommandOutcome(
        current.target.snapshot,
        command,
      );
      assert(receipt?.outcome);
      assert.equal(
        receipt.outcome.acceptedDigest,
        await executionDigest(command),
      );
      assert.equal(notices.length, 0);
      assert.equal(providerCalls, 1);
      assert.equal(authorityChecks, 1);
      assert.equal(publications, 0);
      const queueBefore = await current.session.native.dispatch.inspectAccepted(
        "operator",
        command.id,
      );
      assert(queueBefore);
      assert.equal(queueBefore.receipt.status, "failed");
      // Application receipt settlement precedes pg-boss settling its own job.
      // Wait for the real retry record/output before stopping the first host.
      const boss = current.session.native.dispatch.boss;
      const queueName = current.session.native.ledger.options.queueName;
      const deadline = Date.now() + 10000;
      let failedJob = await boss.getJobById(
        queueName,
        queueBefore.receipt.jobId,
      );
      while (failedJob?.state !== "retry") {
        assert(
          Date.now() < deadline,
          `Expected failed job to enter retry; actual ${failedJob?.state}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        failedJob = await boss.getJobById(queueName, queueBefore.receipt.jobId);
      }
      assert("message" in failedJob.output);
      assert.equal(
        failedJob.output.message,
        "Injected after refusal CAS before notification",
      );
      const sourceWait =
        (await current.session.native.execution.inspect("designer")).find(
          (snapshot) =>
            snapshot.status === "waiting" &&
            snapshot.waits.some((wait) => wait.kind === "contribution"),
        );
      assert(
        sourceWait,
        "The actual parent graph must be parked on the accepted command",
      );
      console.log(JSON.stringify({
        kind: "actual-command-refusal-before-notification",
        commandId: command.id,
        acceptedDigest: receipt.outcome.acceptedDigest,
        receiptRevision: receipt.outcome.revision,
        source: {
          threadId: sourceWait.threadId,
          runId: sourceWait.runId,
          checkpointId: sourceWait.checkpointId,
          inputMessageId: command.origin!.inputMessageId,
        },
        target: {
          threadId: queueBefore.receipt.threadId,
          jobId: queueBefore.receipt.jobId,
          status: queueBefore.receipt.status,
        },
      }));
      // The real handler error and durable failed/retry receipts are observed
      // above. Registry disposal drains application runtimes before reopen.
      await current.manager.dispose();
      await current.session.stop();
      current = undefined;

      const observedFailures = handlerFailures.length;
      current = await open(false);
      // A pg-boss job in delayed retry is not yet queued/running in the native
      // contribution projection. Wait for this SAME job and the real durable
      // parent result; do not interpret an early idle() as recovery completion.
      const resumeDeadline = Date.now() + 10000;
      for (;;) {
        if (handlerFailures.length > observedFailures) {
          throw handlerFailures[observedFailures].error;
        }
        const resumedJob = await current.session.native.dispatch.boss
          .getJobById(
            current.session.native.ledger.options.queueName,
            queueBefore.receipt.jobId,
          );
        const parent = await current.designerPorts.store.load();
        const parentCall = parent?.conversationBatches?.flatMap((batch) =>
          batch.calls
        ).find((call) => call.decision.kind === "decide_operator_change");
        if (
          resumedJob?.state === "completed" &&
          parentCall?.status === "completed" &&
          parentCall.result?.status === "refused" &&
          parent?.messages.some((message) =>
            message.role === "assistant" &&
            message.text === "The exact delegated command was refused."
          )
        ) break;
        assert(
          Date.now() < resumeDeadline,
          `The accepted job/parent did not complete after restart; job=${resumedJob?.state}, parentCall=${parentCall?.status}, providerCalls=${providerCalls}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await current.session.idle(undefined, 10000);
      assert.equal(
        authorityChecks,
        1,
        "Receipt retry must not invoke authority/domain work again",
      );
      assert.equal(
        providerCalls,
        2,
        "Only the original decision and final reply call the controlled provider",
      );
      assert.equal(publications, 0);
      const queueAfter = await current.session.native.dispatch.inspectAccepted(
        "operator",
        command.id,
      );
      assert(queueAfter);
      assert.equal(queueAfter.receipt.jobId, queueBefore.receipt.jobId);
      assert.equal(queueAfter.receipt.threadId, queueBefore.receipt.threadId);
      assert.equal(queueAfter.receipt.status, "completed");
      assert.deepEqual(parseAcceptedCommand(queueAfter.delivery), command);
      const replayed = await recordedCommandOutcome(
        current.target.snapshot,
        command,
      );
      assert.deepEqual(replayed, receipt);
      assert.equal(
        current.target.snapshot.configuration!.changes[0].status,
        "pending",
      );
      assert.equal(
        current.designer.snapshot.messages.filter((message) =>
          message.role === "assistant" &&
          message.text === "The exact delegated command was refused."
        ).length,
        1,
      );
      const batchCall = current.designer.snapshot.conversationBatches?.flatMap(
        (batch) => batch.calls,
      ).find((call) => call.decision.kind === "decide_operator_change");
      assert.equal(batchCall?.status, "completed");
      assert.equal(batchCall?.result?.status, "refused");
      assert.equal(batchCall?.result?.code, "AUTHORITY_POLICY_STALE");
      // The origin effect suspended before completion, and the resume mints
      // a new effect key, so the refused outputs never land on the origin
      // effect that assertCommandOrigin reads. The completed-refusal
      // decision is witnessed on its owner in origins_test.ts instead.
      assert.equal(notices.length, 1);
      assert.equal(notices[0].sourceCompletionId, receipt.event.id);
      assert.equal(notices[0].inputMessageId, command.origin!.inputMessageId);
      // Even a later notification attempt uses the same canonical receipt
      // revision/payload. Queue idempotency prevents another graph/provider run.
      await current.manager.notifyCommandCompletion(command);
      await current.session.idle(undefined, 10000);
      assert.equal(notices.length, 2);
      assert.deepEqual(notices[0], notices[1]);
      assert.equal(providerCalls, 2);
      for (
        const mutate of [
          (value: OperatorCommandOrigin) => {
            value.inputMessageId = "foreign-input";
          },
          (value: OperatorCommandOrigin) => {
            value.businessRevision.__assemblyRuntimeRevision.revision++;
          },
        ]
      ) {
        const foreign = structuredClone(command.origin!);
        mutate(foreign);
        await assert.rejects(
          () => current!.target.resumeOperatorCommand(command.command, foreign),
          /different source intent/,
        );
      }
      const forged = structuredClone(command.origin!);
      forged.effectKey = "foreign-native-effect";
      await assert.rejects(() =>
        current!.session.native.assertCommandOrigin(forged)
      );
      assert.equal(authorityChecks, 1);
      assert.equal(publications, 0);
    } finally {
      await current?.manager.dispose();
      await recovery.close();
    }
  },
});
