/** Bounded real-PG recovery witness: production Main inspect/decision, target
 * workers, canonical CAS/history, pg-boss, official saver and native ledger.
 * A one-shot business receipt failure parks an already returned native A. The
 * failed SETUP decision job is explicitly cancelled so this case isolates the
 * separate recovery delivery. Its original Main source remains waiting: this
 * case does not qualify retry/notification of the initial decision command.
 * Recovery faults persist the actual selected/entered journal CAS then throw;
 * stop/reopen must complete that SAME pg-boss job and restore actual B.
 * Controlled model/provider/publication and retained-source ports; no OS kill,
 * Git source-retention or Toolkit claim. */
import assert from "node:assert/strict";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { caseExecutionContext } from "../../src/application/work/cases/runtime.ts";
import {
  invocationInput,
  invocationKey,
  recordedOperatorWork,
} from "../../src/application/work/operators/journal.ts";
import {
  type AcceptedOperatorCommand,
  parseAcceptedCommand,
} from "../../src/application/work/operators/command-delivery.ts";
import type { OperatorWorkContribution } from "../../src/application/work/operators/conversations.ts";
import type { OperatorExecutionDelivery } from "../../src/application/work/operators/execution.ts";
import type { ChatDecision } from "../../src/application/work/conversation/chat-decision.ts";
import type { SystemRuntimeState } from "../../src/application/work/runtime/state.ts";
import type { ToolDraft } from "../../src/domain/work/records/candidates.ts";
import type { CandidateDelegatedActor } from "../../src/domain/governance/policies/tool-admission-policy.ts";
import { legacyOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import { valueDigest } from "../../src/application/work/runtime/values.ts";
import { caseTypesForModel } from "../../src/domain/work/records/case-types.ts";
import {
  enableCommandFixtureProfile,
  executableFixture,
} from "../support/execution-fixture.ts";
import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import { createMemoryArtifactSources } from "../support/memory-artifact-sources.ts";
import { openPostgresDurableRecoveryHost } from "../support/postgres-runtime-fixture.ts";
import {
  mainBootstrapReply,
  openPostgresToolAdmissionMain,
} from "../support/postgres-tool-admission-main-fixture.ts";
import { postgresTestEnabled } from "../support/postgres.ts";

const actor: CandidateDelegatedActor = {
  actorId: "main",
  policyId: "tested-tools",
  policyRevision: 1,
};
const draft: ToolDraft = {
  name: "Exact tested reader",
  kind: "read_web_page",
  description: "Read the requested page",
  code: "export default ({html}) => ({title:'Page',text:html})",
};
const aReply = "A native reply retained once";
const bReply = "B private reply";
const receiptFault = "Injected before A business completion CAS";

function models() {
  const worker = executableFixture({
    projectId: "git:parked-candidate",
    editingContextId: "parked-context",
    rootId: "root",
    systemId: "worker-system",
    catalogId: "worker-catalog",
    builderId: "worker",
  });
  worker.version.digest = "b".repeat(64);
  worker.version.repositoryVersion = "c".repeat(40);
  worker.ownerAuthority = {
    ...legacyOwnerAuthority(worker.identity.systemId),
    ownerSource: "modeled",
  };
  worker.toolAdmissionPolicies = [{
    id: actor.policyId,
    revision: 1,
    enabled: true,
    recipients: ["worker"],
    toolKinds: [draft.kind],
    maxDelegationDepth: 0,
    elementId: "native-tool-admission-policy",
    holderNativeId: "main",
    mandateNativeId: "main-mandate",
    systemId: "main-system",
    rootAuthority: {
      ...legacyOwnerAuthority("main-system"),
      ownerSource: "modeled",
    },
    sourceIds: ["native-tool-admission-policy"],
  }];
  const main = executableFixture({
    ...worker.identity,
    systemId: "main-system",
    catalogId: "main-catalog",
    builderId: "main",
  });
  main.version.digest = "a".repeat(64);
  main.version.repositoryVersion = worker.version.repositoryVersion;
  main.ownerAuthority = {
    ...legacyOwnerAuthority("main-system"),
    ownerSource: "modeled",
  };
  main.operator = {
    name: "Main",
    primary: true,
    humanInput: true,
    instruction: "Inspect exact candidates before deciding",
  };
  main.toolAdmissionPolicies = structuredClone(worker.toolAdmissionPolicies);
  main.policy.mayProposeSysmlRevision = true;
  enableCommandFixtureProfile(main);
  return { worker, main };
}

async function until(
  description: string,
  observe: () => boolean | Promise<boolean>,
  diagnostic?: () => unknown | Promise<unknown>,
) {
  const deadline = Date.now() + 10000;
  while (!await observe()) {
    if (Date.now() >= deadline) {
      assert.fail(
        `${description} was not observed within 10s${
          diagnostic ? `: ${JSON.stringify(await diagnostic())}` : ""
        }`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const faultPhase of ["selected", "entered"] as const) {
  Deno.test({
    name:
      `PG parked candidate ${faultPhase}-journal crash resumes the same recovery job and restores B once`,
    ignore: !postgresTestEnabled,
    async fn() {
      const selectionFault = `Injected after ${faultPhase} journal CAS`;
      const admitted = models();
      const recovery = await openPostgresDurableRecoveryHost({
        scope: {
          projectId: admitted.worker.identity.projectId,
          systemId: "parked-recovery-host",
        },
      });
      let targetCalls = 0, tests = 0, publicationCalls = 0, publications = 0;
      let failCompletion = false, failSelection = false;
      const retainedSources = createMemoryArtifactSources();
      let sourcePublications = 0;
      // The same controlled external source service retains real proposed bytes
      // across runtime-session restarts, as in the initial-transfer PG witness.
      // PostgreSQL stores its exact reference; Git retention is not qualified.
      const artifactSources = {
        ...retainedSources,
        publishTool: async (
          input: Parameters<typeof retainedSources.publishTool>[0],
        ) => {
          sourcePublications++;
          return await retainedSources.publishTool(input);
        },
      };
      const choice: {
        input?: {
          candidateId: string;
          candidateDigest: string;
          caseId: string;
          verdict: "approve";
          reason: string;
        };
        calls: number;
        decisions: number;
        setupCalls: number;
      } = { calls: 0, decisions: 0, setupCalls: 0 };
      const accepted = new Map<string, AcceptedOperatorCommand>();
      const deliveries = new Map<string, OperatorExecutionDelivery>();
      const observedDeliveries = () => ({
        failures,
        deliveries: [...deliveries.values()].map((value) => ({
          id: value.id,
          kind: value.kind,
          identity: value.identity,
          inputMessageId: value.payload?.inputMessageId,
          work: value.payload?.work,
        })),
      });
      const failures: Array<{
        id: string;
        message: string;
        name?: string;
        stack?: string;
        cause?: string;
      }> = [];
      let selectedState: SystemRuntimeState | undefined;
      const targetSteps: ChatDecision[] = [
        { kind: "propose_tool", text: "Prepare the exact reader", tool: draft },
        { kind: "reply", text: aReply },
        { kind: "reply", text: bReply },
      ];
      const open = async () => {
        const session = await recovery.openSession();
        const targetPorts = await session.runtimePortsFor("worker");
        const raw = targetPorts.store;
        const target = new SystemRuntime({
          ...targetPorts,
          artifactSources,
          store: {
            load: () => raw.load(),
            close: () => raw.close(),
            async save(state, expected) {
              if (
                failCompletion && state.events.some((event) =>
                  event.kind === "operator-work-completed"
                ) && state.messages.some((message) =>
                  message.text === aReply
                )
              ) {
                failCompletion = false;
                throw new Error(receiptFault);
              }
              await raw.save(state, expected);
              if (
                failSelection &&
                state.candidateRecoverySelection?.phase === faultPhase
              ) {
                failSelection = false;
                selectedState = structuredClone(state);
                throw new Error(selectionFault);
              }
            },
          },
          model: {
            ...unexpectedModelAuthoring,
            initialize: () =>
              Promise.resolve(structuredClone(admitted.worker.identity)),
            readExecutableModel: () =>
              Promise.resolve(structuredClone(admitted.worker)),
            findApprovedChange: () => Promise.resolve(null),
            applyApprovedChange() {
              throw new Error("No model authoring");
            },
            activateCandidate(_identity, candidate, admittedDigest) {
              publicationCalls++;
              assert.equal(admittedDigest, admitted.worker.version.digest);
              assert.equal(candidate.admission?.authority, "delegate");
              assert.deepEqual({
                name: candidate.name,
                kind: candidate.kind,
                description: candidate.description,
                code: candidate.code,
              }, draft);
              assert(
                !admitted.worker.catalog.some((entry) =>
                  entry.candidateId === candidate.id
                ),
                "Publication cannot repeat",
              );
              publications++;
              const binding = {
                elementId: `controlled:${candidate.id}`,
                graphPath: `controlled/${candidate.id}`,
              };
              admitted.worker.catalog.push({
                nativeId: binding.elementId,
                candidateId: candidate.id,
                contractId: `contract-${candidate.kind}`,
                name: candidate.name,
                kind: candidate.kind,
                digest: candidate.digest,
                status: "active",
              });
              return Promise.resolve(binding);
            },
            findCandidate(_identity, candidate) {
              const entry = admitted.worker.catalog.find((value) =>
                value.candidateId === candidate.id &&
                value.digest === candidate.digest
              );
              return Promise.resolve(
                entry
                  ? {
                    elementId: entry.nativeId,
                    graphPath: `controlled/${candidate.id}`,
                  }
                  : null,
              );
            },
            graph: () => Promise.resolve({}),
          },
          agents: {
            label: "Controlled target choices; real PostgreSQL native turns",
            decide() {
              targetCalls++;
              const next = targetSteps.shift();
              assert(
                next,
                "Native recovery cannot request another provider choice",
              );
              return Promise.resolve(structuredClone(next));
            },
            review() {
              throw new Error("No target review");
            },
          },
          runner: {
            test(candidate) {
              tests++;
              assert.equal(candidate.code, draft.code);
              return Promise.resolve({
                passed: true,
                checks: [{
                  name: "contract",
                  passed: true,
                  detail: "Exact output",
                }],
              });
            },
            run() {
              throw new Error("No tool invocation");
            },
          },
        });
        await target.initialize(undefined, {
          resumeContinuations: false,
          resumeCandidateContinuations: false,
        });
        const central = await openPostgresToolAdmissionMain({
          session,
          target,
          model: admitted.main,
          actor,
          choice,
        });
        await session.start(async (delivery) => {
          const previousDelivery = deliveries.get(delivery.id);
          if (previousDelivery) assert.deepEqual(delivery, previousDelivery);
          else deliveries.set(delivery.id, structuredClone(delivery));
          const command = parseAcceptedCommand(delivery);
          if (command) {
            const previous = accepted.get(command.id);
            if (previous) assert.deepEqual(command, previous);
            else accepted.set(command.id, structuredClone(command));
          }
          try {
            await (delivery.identity.operatorId === "main"
              ? central.main
              : target).processAcceptedContribution(delivery);
          } catch (error) {
            failures.push({
              id: delivery.id,
              message: error instanceof Error ? error.message : String(error),
              ...(error instanceof Error
                ? {
                  name: error.name,
                  stack: error.stack?.slice(0, 2400),
                  ...(error.cause !== undefined
                    ? {
                      cause: error.cause instanceof Error
                        ? `${error.cause.name}: ${error.cause.message}`
                        : String(error.cause),
                    }
                    : {}),
                }
                : {}),
            });
            throw error;
          }
        });
        return { session, target, targetPorts, ...central };
      };
      let current: Awaited<ReturnType<typeof open>> | undefined;
      try {
        current = await open();
        const centralCase = await current.main.openOperatorRequest({
          changeId: "reader-one",
          caseTypeId: caseTypesForModel(admitted.main).find((entry) =>
            entry.type === "request"
          )!.id,
          objective: "Coordinate exact worker contributions",
          openedBy: "main",
          openedFrom: { conversationId: current.main.snapshot.id },
        });
        const bootstrapInputId = `${centralCase}:objective`;
        const bootstrapInput = current.main.snapshot.messages.find((message) =>
          message.id === bootstrapInputId
        );
        assert(
          bootstrapInput?.role === "tool" &&
            bootstrapInput.caseId === centralCase,
        );
        assert.equal(
          bootstrapInput.text,
          "Coordinate exact worker contributions",
        );
        await until("the actual Main bootstrap job and reply", async () => {
          assert.equal(failures.length, 0, JSON.stringify(failures));
          const delivery = [...deliveries.values()].find((value) =>
            value.identity.operatorId === "main" &&
            value.kind === "notification" &&
            value.identity.scope.kind === "request" &&
            value.identity.scope.scopeId === centralCase &&
            value.identity.purpose === "conversation" &&
            value.identity.invocationKey ===
              invocationKey({ kind: "local", caseId: centralCase }) &&
            value.identity.subjectId === bootstrapInputId &&
            value.payload?.inputMessageId === bootstrapInputId
          );
          if (!delivery) return false;
          assert.deepEqual(delivery.payload?.invocation, {
            kind: "local",
            caseId: centralCase,
          });
          const receipt = await current!.session.native.dispatch
            .inspectAccepted("main", delivery.id);
          assert(receipt);
          assert.deepEqual(receipt.delivery, delivery);
          const job = await current!.session.native.dispatch.boss.getJobById(
            current!.session.native.ledger.options.queueName,
            receipt.receipt.jobId,
          );
          assert(
            job?.state !== "retry" && job?.state !== "failed",
            JSON.stringify({ jobState: job?.state, output: job?.output }),
          );
          const state = await current!.ports.store.load();
          return job?.state === "completed" &&
            state?.messages.some((message) =>
                message.role === "assistant" &&
                message.text === mainBootstrapReply
              ) === true;
        }, observedDeliveries);
        await current.session.idle(undefined, 10000);
        assert.equal(choice.setupCalls, 1);
        assert.equal(choice.calls, 1);
        const context = caseExecutionContext({
          ...current.main.snapshot,
          caseInvocation: { kind: "local", caseId: centralCase },
        });
        assert(context?.record && context.record.owner === "main");
        const mainRepositoryVersion = admitted.main.version.repositoryVersion;
        assert(
          mainRepositoryVersion,
          "The contribution must retain Main's exact immutable repository pin",
        );
        const contribution = (
          id: string,
          text: string,
        ): OperatorWorkContribution => ({
          text,
          correlationId: id,
          proof: {
            caseId: centralCase,
            caseContext: context,
            callerId: "main",
            invocationId: `invocation:${id}`,
            modelVersion: {
              digest: admitted.main.version.digest,
              repositoryVersion: mainRepositoryVersion,
            },
            behavior: {
              id: "access-worker",
              name: "Dispatch",
              description: "Admitted inbox",
              targetNativeId: "inbox-worker",
              targetTypeId: "inbox-type",
              inputTypeId: "work-input",
              callerNativeId: "main",
              sourceIds: ["access-native"],
              inputSchema: { type: "object" },
            },
          },
        });
        const waitTargetContribution = async (
          correlationId: string,
          expectedStatus: "waiting" | "completed",
          failureStart: number,
        ) => {
          await until(
            `actual target job and ${correlationId} work receipt`,
            async () => {
              const state = await current!.targetPorts.store.load();
              const observedFailures = failures.slice(failureStart);
              assert.equal(
                observedFailures.length,
                0,
                JSON.stringify({
                  correlationId,
                  failures: observedFailures,
                  runtimeError: state?.error,
                  providerCalls: targetCalls,
                  candidateStages: state?.candidates.map((candidate) =>
                    candidate.stage
                  ),
                }),
              );
              const delivery = [...deliveries.values()].find((value) => {
                const work = value.payload?.work;
                return value.identity.operatorId === "worker" &&
                  value.kind === "contribution" && typeof work === "object" &&
                  work !== null && "correlationId" in work &&
                  work.correlationId === correlationId;
              });
              if (!delivery) return false;
              assert.equal(delivery.payload?.origin, "delegation");
              assert.equal(delivery.identity.purpose, "conversation");
              assert.equal(delivery.identity.subjectId, delivery.id);
              assert.equal(delivery.identity.scope.kind, "request");
              assert.equal(delivery.identity.scope.scopeId, centralCase);
              const actualWork = delivery.payload?.work;
              assert(
                actualWork && typeof actualWork === "object" &&
                  "callerId" in actualWork && "invocationId" in actualWork,
              );
              assert.equal(actualWork.callerId, "main");
              assert.equal(
                actualWork.invocationId,
                `invocation:${correlationId}`,
              );
              const receipt = await current!.session.native.dispatch
                .inspectAccepted("worker", delivery.id);
              assert(
                receipt,
                "The observed worker input must have its actual accepted receipt",
              );
              assert.deepEqual(receipt.delivery, delivery);
              const job = await current!.session.native.dispatch.boss
                .getJobById(
                  current!.session.native.ledger.options.queueName,
                  receipt.receipt.jobId,
                );
              const result = state &&
                recordedOperatorWork(state, "worker", "main", correlationId);
              const diagnostic = JSON.stringify({
                correlationId,
                commandId: delivery.id,
                jobId: receipt.receipt.jobId,
                jobState: job?.state,
                jobOutput: job?.output,
                receiptStatus: receipt.receipt.status,
                workStatus: result?.result.status,
                runtimeError: state?.error,
                providerCalls: targetCalls,
                candidateStages: state?.candidates.map((candidate) =>
                  candidate.stage
                ),
              });
              assert(
                job?.state !== "retry" && job?.state !== "failed",
                diagnostic,
              );
              if (job?.state !== "completed") return false;
              assert.equal(result?.result.status, expectedStatus, diagnostic);
              return true;
            },
            observedDeliveries,
          );
        };
        const aFailureStart = failures.length;
        await current.target.submitWork(
          contribution("A", "Prepare the reader for contribution A"),
        );
        await waitTargetContribution("A", "waiting", aFailureStart);
        await current.session.idle(current.target, 10000);
        const candidate = current.target.snapshot.candidates[0];
        assert(
          candidate,
          `The completed A preparation job must produce its real candidate: ${
            JSON.stringify({
              failures,
              error: current.target.snapshot.error,
              targetCalls,
              tests,
              sourcePublications,
            })
          }`,
        );
        assert.equal(sourcePublications, 1);
        assert.equal(candidate.stage, "awaiting-admission");
        assert.equal(tests, 1);
        assert.equal(targetCalls, 1);
        choice.input = {
          candidateId: candidate.id,
          candidateDigest: candidate.digest,
          caseId: centralCase,
          verdict: "approve",
          reason: "Exact code, contract and tests inspected",
        };
        failCompletion = true;
        await current.main.submit("Inspect and approve this exact candidate");
        await until(
          "A's business receipt fault",
          () => failures.some((failure) => failure.message === receiptFault),
        );
        await current.session.idle(undefined, 10000);
        const decision = [...accepted.values()].find((value) =>
          value.command.kind === "decide-candidate"
        );
        assert(decision?.origin);
        assert.equal(current.origins.length, 1);
        await current.session.native.assertCommandOrigin(decision.origin);
        const decisionReceipt = await current.session.native.dispatch
          .inspectAccepted("worker", decision.id);
        assert(decisionReceipt);
        const boss = current.session.native.dispatch.boss;
        const queue = current.session.native.ledger.options.queueName;
        await until(
          "initial decision job retry",
          async () =>
            (await boss.getJobById(queue, decisionReceipt.receipt.jobId))
              ?.state === "retry",
        );
        // This setup failure deliberately leaves the original Main awaiting its
        // result. Cancel its transport retry, not its source/native receipts, so
        // key_strict_fifo permits the separate target recovery witness to run.
        await boss.cancel(queue, decisionReceipt.receipt.jobId);
        assert.equal(
          (await boss.getJobById(queue, decisionReceipt.receipt.jobId))?.state,
          "cancelled",
        );
        const parked = (await current.targetPorts.store.load())!;
        const parkedCandidate = parked.candidates[0];
        assert.equal(parkedCandidate.stage, "active");
        assert(parkedCandidate.admissionContinuation);
        assert.equal(
          parked.messages.filter((message) => message.text === aReply).length,
          1,
        );
        assert.equal(
          parked.events.filter((event) =>
            event.kind === "operator-work-completed"
          ).length,
          0,
        );
        const admission = structuredClone(parkedCandidate.admission);
        const aInvocation = structuredClone(parked.caseInvocation!);
        const aInput = invocationInput(parked)!;
        const nativeA =
          (await current.session.native.execution.inspect("worker"))
            .find((value) =>
              value.identity.purpose === "conversation" &&
              value.identity.invocationKey === invocationKey(aInvocation) &&
              value.identity.subjectId === aInput.id
            );
        assert(nativeA?.runId && nativeA.checkpointId);
        assert.deepEqual(nativeA.unsettledEffects, []);
        assert(
          nativeA.status === "completed" ||
            nativeA.status === "waiting" &&
              nativeA.waits.every((wait) => wait.kind === "input"),
        );
        assert.equal(
          nativeA.contributionId,
          `candidate-decision:${candidate.id}:${await valueDigest(
            parkedCandidate.admissionDecision,
          )}`,
        );
        const authorityChecks = current.authorityChecks();
        let setupPendingSettled = false;
        const setupIdle = current.target.idle().then(() => {
          setupPendingSettled = true;
        });
        await until(
          "the failed setup target handler releasing its pending operation",
          () => setupPendingSettled,
          async () => ({
            pending: { idleSettled: setupPendingSettled },
            busy: current!.target.snapshot.busy,
            accepted: (await current!.session.native.dispatch.inspectAccepted(
              "worker",
              decision.id,
            ))?.receipt,
            nativeA,
          }),
        );
        await setupIdle;
        // The receipt failure can leave the original facade's control status
        // busy. Reopen real pools, worker ports and runtime instances before B;
        // do not edit that state or finish A during fixture preparation.
        await current.manager.dispose();
        await current.session.stop();
        current = undefined;
        current = await open();
        const recoveryBoss = current.session.native.dispatch.boss;
        let reopenedPendingSettled = false;
        const reopenedIdle = current.target.idle().then(() => {
          reopenedPendingSettled = true;
        });
        const targetAdmissionDiagnostic = async () => {
          const stored = await current!.targetPorts.store.load();
          const setupReceipt = await current!.session.native.dispatch
            .inspectAccepted("worker", decision.id);
          const setupJob = await current!.session.native.dispatch.boss
            .getJobById(
              current!.session.native.ledger.options.queueName,
              decisionReceipt.receipt.jobId,
            );
          return {
            pending: { idleSettled: reopenedPendingSettled },
            runtime: {
              revision: current!.target.snapshot.revision,
              busy: current!.target.snapshot.busy,
              phase: current!.target.snapshot.phase,
              error: current!.target.snapshot.error,
            },
            persisted: {
              revision: stored?.revision,
              busy: stored?.busy,
              phase: stored?.phase,
              error: stored?.error,
            },
            initialDecision: {
              receipt: setupReceipt?.receipt,
              jobState: setupJob?.state,
            },
            native: (await current!.session.native.execution.inspect("worker"))
              .map((value) => ({
                identity: value.identity,
                contributionId: value.contributionId,
                status: value.status,
                threadId: value.threadId,
                runId: value.runId,
                checkpointId: value.checkpointId,
                waits: value.waits,
                unsettledEffects: value.unsettledEffects,
              })),
          };
        };
        await until(
          "the fresh target runtime having no pending operation",
          () => reopenedPendingSettled,
          targetAdmissionDiagnostic,
        );
        await reopenedIdle;
        assert.equal(
          current.target.snapshot.busy,
          false,
          JSON.stringify(await targetAdmissionDiagnostic()),
        );
        assert.equal(current.authorityChecks(), 0);
        assert.equal(
          current.target.snapshot.candidates[0].admissionContinuation
            ?.inputMessageId,
          aInput.id,
        );
        assert.equal(
          current.target.snapshot.events.filter((event) =>
            event.kind === "operator-work-completed"
          ).length,
          0,
        );
        const bFailureStart = failures.length;
        try {
          await current.target.submitWork(
            contribution("B", "B private contribution"),
          );
        } catch (error) {
          throw new Error(
            `The fresh target refused B before queue acceptance: ${
              JSON.stringify(await targetAdmissionDiagnostic())
            }`,
            { cause: error },
          );
        }
        await waitTargetContribution("B", "completed", bFailureStart);
        await current.session.idle(current.target, 10000);
        const before = current.target.snapshot;
        assert.notEqual(
          invocationKey(before.caseInvocation!),
          invocationKey(aInvocation),
        );
        assert.equal(before.caseInvocation?.kind, "delegated");
        if (before.caseInvocation?.kind !== "delegated") {
          throw new Error("B must be an actual delegated contribution");
        }
        assert.equal(
          before.caseInvocation.work.caseContext.caseId,
          centralCase,
        );
        const bInput = invocationInput(before)!;
        const nativeB =
          (await current.session.native.execution.inspect("worker"))
            .find((value) =>
              value.identity.purpose === "conversation" &&
              value.identity.invocationKey ===
                invocationKey(before.caseInvocation!) &&
              value.identity.subjectId === bInput.id
            );
        assert(nativeB?.runId && nativeB.checkpointId);
        const historyB = await current.targetPorts.stateHistory.loadRevision(
          before.revision,
        );
        assert.deepEqual(historyB?.caseInvocation, before.caseInvocation);
        let injectedRecoveryFailure:
          | { id: string; message: string }
          | undefined;
        failSelection = true;
        await current.manager.resumeCandidateContinuations();
        await until(
          `persisted ${faultPhase}-journal failure`,
          async () => {
            // A post-commit throw can be replaced by a secondary cleanup CAS
            // conflict. Require the actual injected commit and the exact
            // accepted recovery handler failure, rather than an error string.
            const injected = selectedState;
            const journal = injected?.candidateRecoverySelection;
            if (failSelection || !injected || !journal) return false;
            const command = accepted.get(journal.commandId);
            if (!command) return false;
            assert.equal(journal.phase, faultPhase);
            assert.equal(command.command.kind, "resume-candidate-continuation");
            if (command.command.kind !== "resume-candidate-continuation") {
              throw new Error(
                "The injected journal must belong to the exact recovery command",
              );
            }
            assert.equal(command.command.candidateId, candidate.id);
            assert.equal(command.command.inputMessageId, aInput.id);
            assert.equal(
              command.command.invocationKey,
              invocationKey(aInvocation),
            );
            assert.equal(
              command.command.continuationDigest,
              await executionDigest(before.candidates[0].admissionContinuation),
            );
            assert.equal(
              journal.acceptedDigest,
              await executionDigest(command),
            );
            const failure = failures.find((value) => value.id === command.id);
            if (!failure) return false;
            const history = await current!.targetPorts.stateHistory
              .loadRevision(injected.revision);
            assert.equal(history?.revision, injected.revision);
            assert.equal(
              history?.candidateRecoverySelection?.phase,
              faultPhase,
            );
            assert.equal(
              history?.candidateRecoverySelection?.commandId,
              command.id,
            );
            assert.equal(
              history?.candidateRecoverySelection?.acceptedDigest,
              journal.acceptedDigest,
            );
            assert.deepEqual(history?.candidateRecoverySelection, journal);
            injectedRecoveryFailure = failure;
            return true;
          },
          async () => {
            const stored = await current!.targetPorts.store.load();
            const injectedHistory = selectedState &&
              await current!.targetPorts.stateHistory.loadRevision(
                selectedState.revision,
              );
            const commands = [...accepted.values()].filter((value) =>
              value.command.kind === "resume-candidate-continuation"
            );
            const transports = await Promise.all(
              commands.map(async (command) => {
                const receipt = await current!.session.native.dispatch
                  .inspectAccepted("worker", command.id);
                const job = receipt &&
                  await current!.session.native.dispatch.boss.getJobById(
                    current!.session.native.ledger.options.queueName,
                    receipt.receipt.jobId,
                  );
                return {
                  commandId: command.id,
                  receipt: receipt?.receipt,
                  job: job
                    ? {
                      id: job.id,
                      state: job.state,
                      retryCount: job.retryCount,
                      output: job.output,
                    }
                    : null,
                };
              }),
            );
            const snapshot = current!.target.snapshot;
            return {
              faultPhase,
              expectedInjectedError: selectionFault,
              injection: {
                armed: failSelection,
                reached: !!selectedState,
                revision: selectedState?.revision,
                journal: selectedState?.candidateRecoverySelection,
                committedHistoryJournal: injectedHistory
                  ?.candidateRecoverySelection,
              },
              handlerFailures: failures,
              transports,
              runtime: {
                revision: snapshot.revision,
                busy: snapshot.busy,
                phase: snapshot.phase,
                error: snapshot.error,
                journal: snapshot.candidateRecoverySelection,
                invocation: snapshot.caseInvocation,
              },
              persisted: {
                revision: stored?.revision,
                busy: stored?.busy,
                phase: stored?.phase,
                error: stored?.error,
                journal: stored?.candidateRecoverySelection,
                dispositions: stored?.candidateRecoveryDispositions,
                invocation: stored?.caseInvocation,
              },
              observedDeliveries: observedDeliveries(),
            };
          },
        );
        await current.session.idle(undefined, 10000);
        assert(selectedState?.candidateRecoverySelection);
        const recoveryCommand = accepted.get(
          selectedState.candidateRecoverySelection.commandId,
        );
        assert(
          recoveryCommand?.command.kind === "resume-candidate-continuation",
        );
        const journal = selectedState.candidateRecoverySelection;
        assert.equal(journal.phase, faultPhase);
        assert.equal(
          journal.acceptedDigest,
          await executionDigest(recoveryCommand),
        );
        assert.deepEqual(journal.previous, before.caseInvocation);
        assert.deepEqual(journal.target, aInvocation);
        const persistedSelected = await current.targetPorts.stateHistory
          .loadRevision(selectedState.revision);
        assert.deepEqual(
          persistedSelected?.candidateRecoverySelection,
          journal,
          "The fault must follow a real committed canonical CAS/history revision",
        );
        const queuedRecovery = await current.session.native.dispatch
          .inspectAccepted("worker", recoveryCommand.id);
        assert(queuedRecovery);
        await until(
          "same recovery job retry",
          async () =>
            (await recoveryBoss.getJobById(queue, queuedRecovery.receipt.jobId))
              ?.state === "retry",
        );
        const failedJob = await recoveryBoss.getJobById(
          queue,
          queuedRecovery.receipt.jobId,
        );
        assert(failedJob && "message" in failedJob.output);
        assert(injectedRecoveryFailure?.id === recoveryCommand.id);
        assert.equal(
          failedJob.output.message,
          injectedRecoveryFailure.message,
          "The failed queue output must match this exact injected recovery handler outcome",
        );
        assert.equal(targetCalls, 3);
        assert.equal(sourcePublications, 1);
        assert.equal(publicationCalls, 1);
        assert.equal(publications, 1);
        assert.equal(choice.decisions, 1);
        assert.equal(choice.setupCalls, 1);
        assert.equal(
          choice.calls,
          3,
          "Only bootstrap, exact inspection and exact decision call Main's provider",
        );
        assert.equal(current.authorityChecks(), 0);
        await current.manager.dispose();
        await current.session.stop();
        current = undefined;
        current = await open();
        const failedCount = failures.length;
        await until(
          "the same recovery job completion and restored B",
          async () => {
            assert.equal(
              failures.length,
              failedCount,
              JSON.stringify(failures.slice(failedCount)),
            );
            const job = await current!.session.native.dispatch.boss.getJobById(
              current!.session.native.ledger.options.queueName,
              queuedRecovery.receipt.jobId,
            );
            const state = await current!.targetPorts.store.load();
            return job?.state === "completed" &&
              !state?.candidateRecoverySelection &&
              state?.candidateRecoveryDispositions?.[recoveryCommand.id]
                  ?.kind ===
                "resumed" &&
              recordedOperatorWork(state, "worker", "main", "A")?.result
                  .status === "completed";
          },
        );
        await current.session.idle(undefined, 10000);
        const after = current.target.snapshot;
        assert.deepEqual(after.caseInvocation, before.caseInvocation);
        assert.deepEqual(invocationInput(after), bInput);
        assert.equal(after.candidateRecoverySelection, undefined);
        assert.equal(after.candidates[0].admissionContinuation, undefined);
        assert.deepEqual(after.candidates[0].admission, admission);
        assert.equal(after.candidates[0].id, candidate.id);
        const actualB =
          (await current.session.native.execution.inspect("worker"))
            .find((value) => value.threadId === nativeB.threadId);
        assert.deepEqual(
          actualB,
          nativeB,
          "A recovery must preserve B's real saver/ledger snapshot",
        );
        const actualA =
          (await current.session.native.execution.inspect("worker"))
            .find((value) => value.threadId === nativeA.threadId);
        assert.deepEqual(
          actualA,
          nativeA,
          "A's terminal native receipt must be reused without replay",
        );
        const completedA =
          recordedOperatorWork(after, "worker", "main", "A")!.result;
        assert.equal(completedA.status, "completed");
        assert.equal(
          completedA.messages.filter((message) => message.text === aReply)
            .length,
          1,
        );
        assert(
          !completedA.messages.some((message) =>
            message.text === "B private contribution" || message.text === bReply
          ),
        );
        assert.equal(
          after.events.filter((event) =>
            event.kind === "operator-work-completed" && "work" in event &&
            (event.work as { correlationId?: string }).correlationId === "A"
          ).length,
          1,
        );
        const restoredReceipt = await current.session.native.dispatch
          .inspectAccepted("worker", recoveryCommand.id);
        assert.equal(
          restoredReceipt?.receipt.jobId,
          queuedRecovery.receipt.jobId,
        );
        assert.deepEqual(
          parseAcceptedCommand(restoredReceipt!.delivery),
          recoveryCommand,
        );
        assert.equal(restoredReceipt?.receipt.status, "completed");
        assert.equal(authorityChecks, 1);
        assert.equal(current.authorityChecks(), 0);
        assert.equal(choice.decisions, 1);
        assert.equal(choice.setupCalls, 1);
        assert.equal(
          choice.calls,
          3,
          "Only bootstrap, exact inspection and exact decision call Main's provider",
        );
        assert.equal(targetCalls, 3);
        assert.equal(tests, 1);
        assert.equal(sourcePublications, 1);
        assert.equal(publicationCalls, 1);
        assert.equal(publications, 1);
        await current.manager.resumeCandidateContinuations();
        await current.session.idle(undefined, 10000);
        assert.equal(targetCalls, 3);
        assert.equal(
          accepted.size,
          2,
          "Duplicate recovery discovery must not accept another command",
        );
        console.log(JSON.stringify({
          kind: "actual-postgres-parked-candidate-recovery",
          faultPhase,
          faultHandlerError: injectedRecoveryFailure.message,
          recoveryCommandId: recoveryCommand.id,
          jobId: queuedRecovery.receipt.jobId,
          selectionRevision: selectedState.revision,
          originalInputId: aInput.id,
          restoredInputId: bInput.id,
          nativeContributionId: nativeA.contributionId,
          setupDecisionTransport: "cancelled-after-injected-receipt-failure",
          limits:
            "Application-session restart; controlled choices/publication; original Main completion not qualified",
        }));
      } finally {
        await current?.manager.dispose();
        await recovery.close();
      }
    },
  });
}
