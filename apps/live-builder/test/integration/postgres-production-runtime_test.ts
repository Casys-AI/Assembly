import assert from "node:assert/strict";
import { fromPrisma } from "pg-boss";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import type { PostgresNativeExecutionLedger } from "../../src/adapters/work/runtime/postgres-ledger.ts";
import { postgresExecutionTransaction } from "../../src/adapters/out/postgres/execution-transaction.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import type {
  AgentPort,
  ModelPort,
  ToolRunnerPort,
} from "../../src/application/work/runtime/ports.ts";
import type { OperatorExecutionDelivery } from "../../src/application/work/operators/execution.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import { budgetState } from "../../src/domain/work/policies/budget.ts";
import {
  enableCommandFixtureProfile,
  executableFixture,
} from "../support/execution-fixture.ts";
import { emptyNativeEvolutionAwait } from "../../src/application/work/runtime/evolution.ts";
import type { NativeDeclaredConsultationRefusal } from "../../src/application/work/runtime/execution.ts";
import { createMemoryArtifactSources } from "../support/memory-artifact-sources.ts";
import { nativeCandidateConversationAdvanceEvidence } from "../../src/application/work/runtime/model-advance.ts";
import type { NativeExecutionRequest } from "../../src/application/work/runtime/execution.ts";
import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import { openPostgresDurableRecoveryHost } from "../support/postgres-runtime-fixture.ts";
import {
  nativeExecutionIdentity,
  runtimeRevisionReference,
} from "../../src/application/work/runtime/execution.ts";
import { eventually } from "../support/eventually.ts";
import { postgresTestEnabled } from "../support/postgres.ts";

Deno.test({
  name:
    "PG catalog publication returns to its exact original conversation without a fabricated source effect",
  ignore: !postgresTestEnabled,
  async fn() {
    const scope = {
      projectId: "git:catalog-return",
      systemId: "catalog-return-host",
    };
    const host = await openPostgresDurableRecoveryHost({ scope });
    let decisions = 0, publications = 0, verifiedReturn = false;
    const executionTrace: Array<
      { purpose: string; contributionId: string; subjectId?: string }
    > = [];
    let returnPhase = "not-entered";
    const model = executableFixture({
      projectId: scope.projectId,
      editingContextId: "context",
      rootId: "root",
      systemId: "native-owner",
      catalogId: "catalog-owner",
      builderId: "owner",
    });
    model.version.digest = "7".repeat(64);
    model.version.repositoryVersion = "a".repeat(40);
    model.caseTypes = [{
      id: "request-owner",
      name: "Request",
      type: "request",
      envelope: "conversational",
      ownerId: "owner",
      behaviorId: model.flows.conversation.rootNativeId,
      sourceIds: ["request-owner"],
    }];
    const waitNode = model.flows.conversation.nodes.find((node) =>
      node.mechanism === "await_input"
    )!;
    waitNode.nativeId = "fixture-native-await-action";
    assert.notEqual(
      waitNode.id,
      waitNode.nativeId,
      "Occurrence and native action are deliberately distinct in this compiled fixture",
    );
    const original = structuredClone(model);
    try {
      const session = await host.openSession();
      const ports = await session.runtimePortsFor("owner");
      const runtime: SystemRuntime = new SystemRuntime({
        ...ports,
        artifactSources: createMemoryArtifactSources(),
        execution: {
          inspect: (id) => ports.execution.inspect(id),
          closeScope: (snapshot, closure) =>
            ports.execution.closeScope(snapshot, closure),
          retireAndAdvance: (snapshot, authorization, target) =>
            ports.execution.retireAndAdvance(snapshot, authorization, target),
          async run(request, handlers) {
            executionTrace.push({
              purpose: request.identity.purpose,
              contributionId: request.contribution.id,
              subjectId: request.identity.subjectId,
            });
            if (
              request.identity.purpose === "conversation" &&
              request.contribution.id.startsWith("candidate-decision:")
            ) {
              returnPhase = "entered";
              const state = runtime.snapshot;
              const input = request.identity.subjectId!;
              const evidence = await nativeCandidateConversationAdvanceEvidence(
                original,
                state,
                request.identity,
                request.contribution,
                input,
              );
              assert.equal(evidence.candidateId, state.candidates[0].id);
              returnPhase = "canonical-evidence-verified";
              // These altered IDs are rejected at the claimed delivery pin
              // boundary before the candidate-specific verifier is reached.
              for (
                const id of [
                  "candidate-decision:foreign:" + "0".repeat(64),
                  `candidate-decision:${evidence.candidateId}:${
                    "0".repeat(64)
                  }`,
                  "unrelated-resume",
                ]
              ) {
                await assert.rejects(
                  () =>
                    ports.execution.run({
                      ...request,
                      contribution: { ...request.contribution, id },
                    }, handlers),
                  /EXECUTION_DELIVERY_MODEL_PIN_MISMATCH/,
                );
                await assert.rejects(
                  () =>
                    nativeCandidateConversationAdvanceEvidence(
                      original,
                      state,
                      request.identity,
                      { ...request.contribution, id },
                      input,
                    ),
                  /exact published candidate and original input/,
                );
              }
              returnPhase = "foreign-contributions-rejected";
              const foreignPin: NativeExecutionRequest = structuredClone(
                request,
              );
              foreignPin.model.version.repositoryVersion = "f".repeat(40);
              await assert.rejects(
                () => ports.execution.run(foreignPin, handlers),
                /EXECUTION_DELIVERY_MODEL_PIN_MISMATCH/,
              );
              returnPhase = "foreign-pin-rejected";
              // These canonical-origin mutations use the same production verifier;
              // they never write replacement business history into the database.
              for (
                const mutate of [
                  (copy: typeof state) => {
                    copy.candidates[0].caseId = "foreign-case";
                  },
                  (copy: typeof state) => {
                    copy.candidates[0].promotionExecution!.inputMessageId =
                      "foreign-input";
                  },
                  (copy: typeof state) => {
                    copy.candidates[0].admissionDecision!.verdict = "refuse";
                  },
                  (copy: typeof state) => {
                    copy.events = copy.events.filter((event) =>
                      event.kind !== "tool-active"
                    );
                  },
                ]
              ) {
                const copied = structuredClone(state);
                mutate(copied);
                await assert.rejects(() =>
                  nativeCandidateConversationAdvanceEvidence(
                    original,
                    copied,
                    request.identity,
                    request.contribution,
                    input,
                  )
                );
              }
              returnPhase = "canonical-mutations-rejected";
              assert.equal(decisions, 1);
              assert.equal(publications, 1);
              verifiedReturn = true;
              returnPhase = "verified";
            }
            return await ports.execution.run(request, handlers);
          },
        },
        agents: {
          label:
            "Fixture provider/source publication; production PG promotion and conversation",
          decide: () => {
            decisions++;
            if (decisions === 1) {
              return Promise.resolve({
                kind: "propose_tool" as const,
                text: "Prepare exact reader",
                tool: {
                  kind: "read_web_page" as const,
                  name: "retained-reader",
                  description: "Read supplied HTML",
                  code:
                    "export default ({html})=>({title:'retained',text:html})",
                },
              });
            }
            if (decisions === 2) {
              return Promise.resolve({
                kind: "reply" as const,
                text: "The exact admitted reader is available",
              });
            }
            throw new Error("Unexpected provider replay");
          },
          review: () => {
            throw new Error("No provider review authorized");
          },
        },
        runner: {
          test: () =>
            Promise.resolve({
              passed: true,
              checks: [{
                name: "fixture",
                passed: true,
                detail: "No external tool run",
              }],
            }),
          run: () => {
            throw new Error("No tool execution authorized");
          },
        },
        model: {
          ...unexpectedModelAuthoring,
          initialize: () => Promise.resolve(structuredClone(model.identity)),
          readExecutableModel: () => Promise.resolve(structuredClone(model)),
          graph: () => Promise.resolve({}),
          applyApprovedChange: () => {
            throw new Error("No source model change authorized");
          },
          activateCandidate(_identity, candidate, admittedDigest) {
            assert.equal(admittedDigest, candidate.activationModelDigest);
            assert.equal(candidate.tests?.passed, true);
            assert.equal(
              candidate.admission?.candidateDigest,
              candidate.digest,
            );
            const binding = {
              elementId: `native-${candidate.id}`,
              graphPath: `catalog.${candidate.name}`,
            };
            model.catalog.push({
              nativeId: binding.elementId,
              candidateId: candidate.id,
              contractId: model.contracts.find((contract) =>
                contract.kind === candidate.kind
              )!.nativeId,
              kind: candidate.kind,
              name: candidate.name,
              digest: candidate.digest,
              status: "active",
            });
            model.version.repositoryVersion = "b".repeat(40);
            publications++;
            return Promise.resolve(binding);
          },
          findCandidate(_identity, candidate) {
            const entry = model.catalog.find((entry) =>
              entry.candidateId === candidate.id
            );
            return Promise.resolve(
              entry
                ? {
                  elementId: entry.nativeId,
                  graphPath: `catalog.${candidate.name}`,
                }
                : null,
            );
          },
        },
      });
      await runtime.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      await session.start((delivery) =>
        runtime.processAcceptedContribution(delivery)
      );
      const caseId = await runtime.submit(
        "Prepare an exact tool for this Request",
        undefined,
        undefined,
        true,
      );
      await session.idle(runtime, 30000);
      assert.equal(runtime.snapshot.candidates[0].stage, "awaiting-admission");
      assert.equal(publications, 0);
      const candidate = runtime.snapshot.candidates[0];
      await runtime.decideCandidate({
        candidateId: candidate.id,
        candidateDigest: candidate.digest,
        caseId,
        verdict: "approve",
        reason: "Separately admit the exact prepared candidate",
      });
      await session.idle(runtime, 30000);
      if (!verifiedReturn) {
        const snapshot = runtime.snapshot;
        const executions = await ports.execution.inspect(
          model.identity.builderId,
        );
        console.error(
          "Catalog-return qualification diagnostic",
          JSON.stringify({
            returnPhase,
            decisions,
            publications,
            runtimeError: snapshot.error,
            invocation: snapshot.caseInvocation,
            activeInputMessageId: snapshot.activeInputMessageId,
            candidate: snapshot.candidates[0] && {
              id: snapshot.candidates[0].id,
              stage: snapshot.candidates[0].stage,
              admissionDecision: snapshot.candidates[0].admissionDecision,
              promotionExecution: snapshot.candidates[0].promotionExecution,
              admissionContinuation:
                snapshot.candidates[0].admissionContinuation,
            },
            executionTrace,
            executions: executions.map((entry) => ({
              identity: entry.identity,
              contributionId: entry.contributionId,
              status: entry.status,
              refusal: entry.refusal,
              waits: entry.waits,
              unsettledEffects: entry.unsettledEffects,
            })),
          }),
        );
      }
      assert.equal(verifiedReturn, true);
      assert.equal(runtime.snapshot.error, undefined);
      assert.equal(runtime.snapshot.candidates[0].stage, "active");
      assert.equal(runtime.snapshot.candidates[0].caseId, caseId);
      assert.equal(decisions, 2);
      assert.equal(publications, 1);
      assert.equal(
        runtime.snapshot.messages.filter((message) =>
          message.text === "The exact admitted reader is available"
        ).length,
        1,
      );
      const table = `"${host.database.schema}"."NativeContinuationReceipt"`;
      const receipts = await host.database.client.$queryRawUnsafe<
        Array<
          {
            id: string;
            sourceOccurrenceId: string;
            sourceNativeActionId: string;
            sourceCheckpointId: string;
          }
        >
      >(
        `SELECT * FROM ${table} WHERE "sourceKind"='unconsumed-input-wait' AND "evidenceKind"='verified-catalog-advance'`,
      );
      assert.equal(receipts.length, 1);
      const receipt = receipts[0];
      assert.equal(receipt.sourceOccurrenceId, waitNode.id);
      assert.equal(receipt.sourceNativeActionId, waitNode.nativeId);
      // BEFORE INSERT source-shape validation must reject these mutations rather
      // than accepting them as a second, apparently valid continuation.
      const clone = (change: string, values: unknown[] = []) =>
        host.database.client.$executeRawUnsafe(
          `INSERT INTO ${table} ("projectId","systemId","executionSpaceId","operatorId","threadId","id","predecessorRunId","sourceCheckpointNamespace","sourceCheckpointId","preparedNodeId","settledEffectKey","sourceNativeActionId","evidenceKind","evidenceDigest","evidenceJson","successorRunId","targetPinJson","status","createdAt","sourceKind","sourceOccurrenceId") SELECT "projectId","systemId","executionSpaceId","operatorId","threadId",'negative-'||"id","predecessorRunId","sourceCheckpointNamespace",${
            change === "checkpoint"
              ? "'foreign-checkpoint'"
              : '"sourceCheckpointId"'
          },"preparedNodeId",${
            change === "consumed" ? "$2" : '"settledEffectKey"'
          },"sourceNativeActionId","evidenceKind","evidenceDigest","evidenceJson","successorRunId","targetPinJson",'intent',"createdAt",${
            change === "settled"
              ? "'settled-effect'"
              : change === "missing"
              ? "NULL"
              : '"sourceKind"'
          },${
            change === "occurrence"
              ? "'foreign-occurrence'"
              : '"sourceOccurrenceId"'
          } FROM ${table} WHERE "id"=$1`,
          receipt.id,
          ...values,
        );
      await assert.rejects(
        () => clone("settled"),
        /exact settled source effect/,
      );
      await assert.rejects(() => clone("missing"), /explicit source shape/);
      await assert.rejects(
        () => clone("checkpoint"),
        /exact scoped predecessor checkpoint/,
      );
      await assert.rejects(
        () => clone("occurrence"),
        /exact unconsumed conversation input wait/,
      );
      const effects = await host.database.client.$queryRawUnsafe<
        Array<{ effectKey: string }>
      >(
        `SELECT e."effectKey" FROM "${host.database.schema}"."ExecutionEffect" e JOIN ${table} n ON e."projectId"=n."projectId" AND e."systemId"=n."systemId" AND e."executionSpaceId"=n."executionSpaceId" AND e."operatorId"=n."operatorId" AND e."threadId"=n."threadId" AND e."runId"=n."predecessorRunId" WHERE n."id"=$1 LIMIT 1`,
        receipt.id,
      );
      assert.equal(effects.length, 1);
      await assert.rejects(
        () => clone("consumed", [effects[0].effectKey]),
        /exact unconsumed conversation input wait/,
      );
      await assert.rejects(
        () =>
          host.database.client.$executeRawUnsafe(
            `UPDATE ${table} SET "sourceKind"='settled-effect' WHERE "id"=$1`,
            receipt.id,
          ),
        /selected or rejected native continuation cannot change/,
      );
      // This structural-only row exercises UPDATE protection before selection.
      // It reuses the actual scoped predecessor and successor, but its distinct
      // digest is deliberately synthetic and is never passed to the runtime.
      const intentId = `structural-intent-${receipt.id}`;
      const inserted = await host.database.client.$executeRawUnsafe(
        `INSERT INTO ${table} ("projectId","systemId","executionSpaceId","operatorId","threadId","id","predecessorRunId","sourceCheckpointNamespace","sourceCheckpointId","preparedNodeId","settledEffectKey","sourceNativeActionId","evidenceKind","evidenceDigest","evidenceJson","successorRunId","targetPinJson","status","createdAt","sourceKind","sourceOccurrenceId") SELECT "projectId","systemId","executionSpaceId","operatorId","threadId",$2,"predecessorRunId","sourceCheckpointNamespace","sourceCheckpointId","preparedNodeId","settledEffectKey","sourceNativeActionId","evidenceKind",CASE WHEN "evidenceDigest" = repeat('e', 64) THEN repeat('f', 64) ELSE repeat('e', 64) END,"evidenceJson","successorRunId","targetPinJson",'intent',"createdAt","sourceKind","sourceOccurrenceId" FROM ${table} WHERE "id"=$1`,
        receipt.id,
        intentId,
      );
      assert.equal(inserted, 1);
      const intentBefore = await host.database.client.$queryRawUnsafe<
        unknown[]
      >(
        `SELECT * FROM ${table} WHERE "id"=$1`,
        intentId,
      );
      assert.equal(intentBefore.length, 1);
      for (
        const mutation of [
          `"sourceKind"='settled-effect'`,
          `"sourceOccurrenceId"='foreign-occurrence'`,
        ]
      ) {
        await assert.rejects(
          () =>
            host.database.client.$executeRawUnsafe(
              `UPDATE ${table} SET ${mutation} WHERE "id"=$1`,
              intentId,
            ),
          /source shape is immutable/,
        );
      }
      assert.deepEqual(
        await host.database.client.$queryRawUnsafe<unknown[]>(
          `SELECT * FROM ${table} WHERE "id"=$1`,
          intentId,
        ),
        intentBefore,
      );
      assert.deepEqual(
        await host.database.client.$queryRawUnsafe<typeof receipts>(
          `SELECT * FROM ${table} WHERE "id"=$1`,
          receipt.id,
        ),
        receipts,
        "Every refused mutation leaves the selected source receipt exactly unchanged",
      );
    } finally {
      await host.close();
    }
  },
});

Deno.test({
  name:
    "PG-5.9 child Request opening and resume use their own claim after Main durable acknowledgement",
  ignore: !postgresTestEnabled,
  async fn() {
    const scope = {
      projectId: "git:child-dispatch-fixture",
      systemId: "child-dispatch-host",
    };
    const recovery = await openPostgresDurableRecoveryHost({
      scope,
    });
    const errors: unknown[] = [];
    const counts = { main: 0, child: 0 };
    try {
      const session = await recovery.openSession();
      const models = Object.fromEntries(
        (["main", "child"] as const).map((operatorId, index) => {
          const model = executableFixture({
            projectId: scope.projectId,
            editingContextId: "context",
            rootId: "root",
            systemId: `native-${operatorId}`,
            catalogId: `catalog-${operatorId}`,
            builderId: operatorId,
          });
          model.version.digest = String(index + 1).repeat(64);
          model.version.repositoryVersion = "a".repeat(40);
          model.caseTypes = [{
            id: `request-${operatorId}`,
            name: "Request",
            type: "request",
            envelope: "conversational",
            ownerId: operatorId,
            behaviorId: model.flows.conversation.rootNativeId,
            sourceIds: [`request-${operatorId}`],
          }];
          return [operatorId, model];
        }),
      ) as Record<"main" | "child", ReturnType<typeof executableFixture>>;
      const open = async (operatorId: "main" | "child") => {
        const model = models[operatorId]!;
        const runtime = new SystemRuntime({
          ...await session.runtimePortsFor(operatorId),
          agents: {
            label:
              "Precompiled fixture; actual production worker and PostgreSQL claims",
            decide: () =>
              Promise.resolve({
                kind: "reply",
                text: `${operatorId} reply ${++counts[operatorId]}`,
              }),
            review: () => {
              throw new Error("No review authorized");
            },
          },
          model: {
            ...unexpectedModelAuthoring,
            initialize: () => Promise.resolve(structuredClone(model.identity)),
            readExecutableModel: () => Promise.resolve(structuredClone(model)),
            graph: () => Promise.resolve({}),
            applyApprovedChange: () => {
              throw new Error(
                "No source publication in this claim-boundary fixture",
              );
            },
            activateCandidate: () => {
              throw new Error("No activation authorized");
            },
          },
          runner: {
            test: () => {
              throw new Error("No Toolkit or tool tests authorized");
            },
            run: () => {
              throw new Error("No external effects authorized");
            },
          },
        });
        await runtime.initialize(undefined, {
          resumeContinuations: false,
          resumeCandidateContinuations: false,
        });
        return runtime;
      };
      const main = await open("main"), child = await open("child");
      let caseId: string | undefined;
      let opening: Parameters<typeof child.openOperatorRequest>[0] | undefined;
      let resumption: Parameters<typeof child.resumeRequest>[0] | undefined;
      let acknowledgements = 0;
      await session.start(async (delivery) => {
        try {
          if (delivery.identity.operatorId === "child") {
            await child.processAcceptedContribution(delivery);
            return;
          }
          await main.processAcceptedContribution(delivery);
          assert.equal(delivery.identity.scope.kind, "designer");
          if (!opening) {
            opening = {
              changeId: "approved-fixture-creation",
              caseTypeId: "request-child",
              objective: "Read then reply",
              openedBy: "main",
              openedFrom: {
                conversationId: main.snapshot.id,
                designerScopeId: delivery.identity.scope.scopeId,
              },
            };
            caseId = await child.openOperatorRequest(opening);
            assert.equal(await child.openOperatorRequest(opening), caseId);
            assert.equal(
              counts.child,
              0,
              "The one worker must ACK Main before any child execution",
            );
          } else {
            resumption = {
              caseId: caseId!,
              resumeId: "resume-once",
              instruction: "Observe the next result",
              openedBy: "main",
              conversationId: opening.openedFrom.conversationId,
              designerScopeId: opening.openedFrom.designerScopeId!,
            };
            const accepted = await child.resumeRequest(resumption);
            assert.equal(
              accepted.reply,
              undefined,
              "Acceptance is not a fabricated child reply",
            );
            assert.equal(
              (await child.resumeRequest(resumption)).caseId,
              caseId,
            );
            assert.equal(
              counts.child,
              1,
              "Main does not wait for or execute the child continuation",
            );
          }
          // The unchanged production ledger still rejects direct child execution
          // under Main's claim, even though opening acceptance is permitted.
          const planned = child.snapshot;
          const inputMessageId = resumption
            ? `${caseId}:resume:${resumption.resumeId}`
            : `${caseId}:objective`;
          planned.activeInputMessageId = inputMessageId;
          await assert.rejects(
            () =>
              session.native.ledger.open({
                businessRevision: runtimeRevisionReference(planned),
                identity: nativeExecutionIdentity(
                  planned,
                  "conversation",
                  inputMessageId,
                ),
                contribution: {
                  id: "forbidden-direct-child",
                  kind: "input",
                  inputMessageId,
                },
                model: models.child!,
                flow: models.child!.flows.conversation,
                maxSteps: models.child!.policy.maxFlowSteps,
              }),
            /Execution claim scope mismatch/,
          );
          acknowledgements++;
        } catch (error) {
          errors.push(error);
          throw error;
        }
      });
      await main.submit("Provision the already-approved fixture operator");
      await eventually(() => {
        if (errors.length) {
          throw new AggregateError(errors, "Real child dispatch failed");
        }
        return counts.child === 1 &&
            child.snapshot.cases?.[0]?.firstRequestDispatched
          ? Promise.resolve(true)
          : Promise.resolve(undefined);
      });
      await session.idle(child, 30000);
      assert.equal(acknowledgements, 1);
      assert.equal(child.snapshot.error, undefined);
      await main.submit("Resume the same opened child Request");
      await eventually(() => {
        if (errors.length) {
          throw new AggregateError(errors, "Real child resume failed");
        }
        return child.snapshot.requestResumptions?.[0]?.status === "completed"
          ? Promise.resolve(true)
          : Promise.resolve(undefined);
      });
      await session.idle(child, 30000);
      assert.equal(acknowledgements, 2);
      assert.equal(child.snapshot.error, undefined);
      assert.equal(
        (await child.resumeRequest(resumption!)).reply,
        "child reply 2",
      );
      assert.equal(await child.openOperatorRequest(opening!), caseId);
      await session.idle(child, 30000);
      assert.deepEqual(counts, { main: 2, child: 2 });
      assert.equal(child.snapshot.cases!.length, 1);
      assert.equal(
        child.snapshot.messages.filter((message) =>
          message.id === `${caseId}:objective`
        ).length,
        1,
      );
      assert.equal(
        child.snapshot.messages.filter((message) =>
          message.id === `${caseId}:resume:resume-once`
        ).length,
        1,
      );
      const receipts = await recovery.database.client.executionContribution
        .findMany({ where: { ...scope, operatorId: "child" } });
      assert.equal(receipts.length, 2);
      assert.equal(new Set(receipts.map((receipt) => receipt.jobId)).size, 2);
      assert(
        receipts.every((receipt) =>
          ["completed", "waiting"].includes(receipt.status)
        ),
      );
    } finally {
      await recovery.close();
    }
  },
});

Deno.test({
  name:
    "PG-5.9 child Request recovers the resume receipt after durable closure without repeating the provider",
  ignore: !postgresTestEnabled,
  async fn() {
    const scope = {
      projectId: "git:child-close-recovery",
      systemId: "child-close-host",
    };
    const recovery = await openPostgresDurableRecoveryHost({
      scope,
    });
    const model = executableFixture({
      projectId: scope.projectId,
      editingContextId: "context",
      rootId: "root",
      systemId: "native-child",
      catalogId: "catalog-child",
      builderId: "child",
    });
    model.version.digest = "3".repeat(64);
    model.version.repositoryVersion = "b".repeat(40);
    model.caseTypes = [{
      id: "request-child",
      name: "Request",
      type: "request",
      envelope: "conversational",
      ownerId: "child",
      behaviorId: model.flows.conversation.rootNativeId,
      sourceIds: ["request-child"],
    }];
    const boundary = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const orphanDone = Promise.withResolvers<void>();
    let calls = 0, interrupted = false;
    const open = async (
      session: Awaited<ReturnType<typeof recovery.openSession>>,
      interrupt: boolean,
    ) => {
      const ports = await session.runtimePortsFor("child");
      const runtime = new SystemRuntime({
        ...ports,
        store: {
          load: () => ports.store.load(),
          close: () => ports.store.close(),
          async save(state, expected) {
            if (
              interrupt && !interrupted && state.cases?.some((record) =>
                record.status === "closed-done"
              ) &&
              state.requestResumptions?.some((receipt) =>
                receipt.status === "completed"
              )
            ) {
              // Real graph effects and canonical closure have already committed.
              // Hold the first receipt write, then fail it after its worker is killed.
              interrupted = true;
              boundary.resolve();
              await release.promise;
              throw new Error(
                "Injected interruption before terminal resume receipt save",
              );
            }
            await ports.store.save(state, expected);
          },
        },
        agents: {
          label: "Real PG recovery; scripted decision only",
          decide: () => {
            calls++;
            if (calls > 2) {
              throw new Error("The closed Request called its provider again");
            }
            return Promise.resolve({
              kind: "reply" as const,
              text: calls === 1 ? "Opened" : "Durable terminal reply",
              ...(calls === 2 ? { caseClosure: "done" as const } : {}),
            });
          },
          review: () => {
            throw new Error("No review authorized");
          },
        },
        model: {
          ...unexpectedModelAuthoring,
          initialize: () => Promise.resolve(structuredClone(model.identity)),
          readExecutableModel: () => Promise.resolve(structuredClone(model)),
          graph: () => Promise.resolve({}),
          applyApprovedChange() {
            throw new Error(
              "No source mutation is authorized by this recovery fixture",
            );
          },
          activateCandidate() {
            throw new Error(
              "No tool activation is authorized by this recovery fixture",
            );
          },
        },
        runner: {
          test: () => {
            throw new Error("No tool test authorized");
          },
          run: () => {
            throw new Error("No tool effect authorized");
          },
        },
      });
      await runtime.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      return runtime;
    };
    try {
      const first = await recovery.openSession();
      const child = await open(first, true);
      await first.start(async (delivery) => {
        try {
          await child.processAcceptedContribution(delivery);
        } finally {
          if (interrupted) orphanDone.resolve();
        }
      });
      const opening = {
        changeId: "approved-close-fixture",
        caseTypeId: "request-child",
        objective: "Open then close",
        openedBy: "main",
        openedFrom: {
          conversationId: "main-conversation",
          designerScopeId: "main-designer",
        },
      };
      const caseId = await child.openOperatorRequest(opening);
      await eventually(() =>
        child.snapshot.cases?.[0]?.firstRequestDispatched ? true : undefined
      );
      await first.idle(child, 30000);
      const resume = {
        caseId,
        resumeId: "close-once",
        instruction: "Close the Request with its exact result",
        openedBy: opening.openedBy,
        conversationId: opening.openedFrom.conversationId,
        designerScopeId: opening.openedFrom.designerScopeId,
      };
      await child.resumeRequest(resume);
      await eventually(() => interrupted ? true : undefined);
      await boundary.promise;
      const storage = await first.storage.operator("child");
      const before = (await storage.state.load())!;
      assert.equal(before.cases![0]!.status, "closed-done");
      assert.equal(before.requestResumptions![0]!.status, "started");
      assert.equal(before.requestResumptions![0]!.outcome, undefined);
      const inputMessageId = `${caseId}:resume:${resume.resumeId}`;
      const accepted = await recovery.database.client.executionContribution
        .findMany({ where: { ...scope, operatorId: "child" } });
      const resumptive = accepted.find((receipt) =>
        (JSON.parse(receipt.payloadJson) as OperatorExecutionDelivery).payload
          ?.inputMessageId === inputMessageId
      )!;
      const snapshots = await first.native.ledger.inspect("child");
      const native = snapshots.find((snapshot) =>
        snapshot.contributionId === resumptive.contributionId
      )!;
      assert.equal(
        (native.localState!.reply as { text: string }).text,
        "Durable terminal reply",
      );
      assert.equal(native.unsettledEffects.length, 0);
      await first.kill();
      const successor = await recovery.openSession();
      const reopened = await open(successor, false);
      await successor.start((delivery) =>
        reopened.processAcceptedContribution(delivery)
      );
      await eventually(() =>
        reopened.snapshot.requestResumptions?.[0]?.status === "completed"
          ? true
          : undefined
      );
      await successor.idle(reopened, 30000);
      const outcome = await reopened.resumeRequest(resume);
      assert.equal(outcome.status, "closed-done");
      assert.equal(outcome.reply, "Durable terminal reply");
      assert.equal(outcome.modelVersion, model.version.repositoryVersion);
      assert.deepEqual(await reopened.resumeRequest(resume), outcome);
      assert.equal(
        calls,
        2,
        "Opening and closing each decided once; recovery invokes no provider",
      );
      const after =
        (await (await successor.storage.operator("child")).state.load())!;
      assert.deepEqual(
        after.messages,
        before.messages,
        "Recovery adds no input or assistant message",
      );
      const receipts = await recovery.database.client.executionContribution
        .findMany({ where: { ...scope, operatorId: "child" } });
      assert.equal(receipts.length, 2);
      const resumed = receipts.find((receipt) =>
        receipt.contributionId === resumptive.contributionId
      )!;
      assert.equal(resumed.jobId, resumptive.jobId);
      assert.equal(resumed.status, "completed");
      const recoveredNative = (await successor.native.ledger.inspect("child"))
        .find((snapshot) =>
          snapshot.contributionId === resumptive.contributionId
        )!;
      assert.equal(recoveredNative.threadId, native.threadId);
      assert.equal(recoveredNative.checkpointId, native.checkpointId);
      release.resolve();
      await orphanDone.promise;
    } finally {
      release.resolve();
      await recovery.close();
    }
  },
});

Deno.test({
  name:
    "PG-5.9 grouped child opening resumes between settled members on the same job without replay or budget duplication",
  ignore: !postgresTestEnabled,
  async fn() {
    const scope = {
      projectId: "git:grouped-child-recovery",
      systemId: "grouped-child-host",
    };
    const recovery = await openPostgresDurableRecoveryHost({
      scope,
    });
    const model = executableFixture({
      projectId: scope.projectId,
      editingContextId: "context",
      rootId: "root",
      systemId: "native-child",
      catalogId: "catalog-child",
      builderId: "child",
    });
    model.version.digest = "4".repeat(64);
    model.version.repositoryVersion = "c".repeat(40);
    model.caseTypes = [{
      id: "request-child",
      name: "Request",
      type: "request",
      envelope: "conversational",
      ownerId: "child",
      behaviorId: model.flows.conversation.rootNativeId,
      maxInvocations: 10,
      sourceIds: ["request-child"],
    }];
    const behavior = {
      id: "record-member",
      name: "Record member",
      description: "Bounded observable fixture operation",
      callerNativeId: "child",
      targetNativeId: "record-member-target",
      targetTypeId: "Fixture::Record",
      inputTypeId: "Fixture::Input",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      sourceIds: ["record-member"],
    };
    model.behaviors = [behavior];
    model.flows.conversation.edges.find((edge) =>
      edge.guard?.includes('"invoke_tool"')
    )!.guard =
      '(chooseNextMove.choice.kind == "invoke_tool") or (chooseNextMove.choice.kind == "invoke_behavior")';
    const invokeNode = model.flows.conversation.nodes.find((node) =>
      node.mechanism === "invoke_tool"
    )!;
    const effects: string[] = [];
    let providerCalls = 0, parked = false;
    const boundary = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      orphanDone = Promise.withResolvers<void>();
    const where = { ...scope, executionSpaceId: "main", operatorId: "child" };
    const open = async (interrupt: boolean) => {
      const session = await recovery.openSession();
      const ports = await session.runtimePortsFor("child");
      const storage = await session.storage.operator("child");
      const runtime: SystemRuntime = new SystemRuntime({
        ...ports,
        execution: {
          inspect: (operatorId) => ports.execution.inspect(operatorId),
          closeScope: (snapshot, closure) =>
            ports.execution.closeScope(snapshot, closure),
          retireAndAdvance: (snapshot, authorization, target) =>
            ports.execution.retireAndAdvance(snapshot, authorization, target),
          run: (request, handlers) =>
            ports.execution.run(request, {
              ...handlers,
              assertBoundary: async (node) => {
                await handlers.assertBoundary(node);
                const calls = runtime.snapshot.conversationBatches?.[0]?.calls;
                if (
                  interrupt && !parked && node.mechanism === "choose_move" &&
                  calls?.[0]?.status === "completed" &&
                  calls[1]?.status !== "completed" && !calls[1]?.effectStarted
                ) {
                  // This is the real ledger admission callback, before its next
                  // effect INSERT. Sync saver durability has committed the prior node.
                  parked = true;
                  boundary.resolve();
                  await release.promise;
                  throw new Error(
                    "Killed between durable members before the next effect admission",
                  );
                }
              },
            }),
        },
        workBudget: new WorkBudgetService(storage.budget),
        agents: {
          label: "Grouped fixture decisions; real worker/ledger/saver/budget",
          decide: () => {
            throw new Error("Use grouped decisions");
          },
          decideBatch: () => {
            providerCalls++;
            if (providerCalls === 1) {
              return Promise.resolve({
                calls: ["first", "second"].map((value) => ({
                  id: `call-${value}`,
                  decision: {
                    kind: "invoke_behavior" as const,
                    text: `Record ${value}`,
                    behaviorId: behavior.id,
                    inputJson: JSON.stringify({ value }),
                  },
                })),
              });
            }
            if (providerCalls === 2) {
              return Promise.resolve({
                calls: [{
                  id: "call-reply",
                  decision: {
                    kind: "reply" as const,
                    text: "Both members completed",
                  },
                }],
              });
            }
            throw new Error("Recovery repeated a provider decision");
          },
          review: () => {
            throw new Error("No review authorized");
          },
        },
        behaviors: {
          supports: () => Promise.resolve(true),
          invoke: (request) => {
            effects.push(String(request.input.value));
            return Promise.resolve({
              caseId: request.caseId,
              behaviorId: request.behavior.id,
              invocationId: request.invocationId,
              targetNativeId: request.behavior.targetNativeId,
              modelVersion: request.modelVersion,
              result: { recorded: request.input.value },
            });
          },
        },
        model: {
          ...unexpectedModelAuthoring,
          initialize: () => Promise.resolve(structuredClone(model.identity)),
          readExecutableModel: () => Promise.resolve(structuredClone(model)),
          graph: () => Promise.resolve({}),
          applyApprovedChange: () => {
            throw new Error("No source mutation authorized");
          },
          activateCandidate: () => {
            throw new Error("No activation authorized");
          },
        },
        runner: {
          test: () => {
            throw new Error("No tool test authorized");
          },
          run: () => {
            throw new Error("No tool effect authorized");
          },
        },
      });
      await runtime.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      await session.start(async (delivery) => {
        try {
          await runtime.processAcceptedContribution(delivery);
        } finally {
          if (interrupt && parked) orphanDone.resolve();
        }
      });
      return { session, runtime, storage };
    };
    try {
      const first = await open(true);
      const opening = {
        changeId: "approved-grouped-opening",
        caseTypeId: "request-child",
        objective: "Record both members then reply",
        openedBy: "main",
        openedFrom: {
          conversationId: "main-conversation",
          designerScopeId: "main-designer",
        },
      };
      const caseId = await first.runtime.openOperatorRequest(opening);
      await eventually(() => parked ? true : undefined);
      await boundary.promise;
      assert.deepEqual(effects, ["first"]);
      assert.equal(providerCalls, 1);
      const accepted = await recovery.database.client.executionContribution
        .findFirstOrThrow({ where });
      const execution = await recovery.database.client.operatorExecution
        .findFirstOrThrow({ where: { ...where, threadId: accepted.threadId } });
      const run = await recovery.database.client.executionRun.findFirstOrThrow({
        where: { ...where, runId: execution.currentRunId! },
      });
      assert.ok(
        run.checkpointId,
        "The official saver committed a selected checkpoint before the parked admission",
      );
      const completed = await recovery.database.client.executionEffect.findMany(
        {
          where: {
            ...where,
            threadId: accepted.threadId,
            nodeId: invokeNode.nativeId,
          },
        },
      );
      assert.equal(completed.length, 1);
      assert.equal(completed[0].status, "completed");
      assert.equal(
        await recovery.database.client.executionEffect.count({
          where: {
            ...where,
            threadId: accepted.threadId,
            status: { not: "completed" },
          },
        }),
        0,
      );
      const budget = (await first.storage.budget.load(caseId))!;
      assert.equal(budgetState(budget).view.consumed, 1);
      await first.session.kill();
      const successor = await open(false);
      await eventually(() =>
        successor.runtime.snapshot.messages.some((message) =>
            message.text === "Both members completed"
          )
          ? true
          : undefined
      );
      await successor.session.idle(successor.runtime, 30000);
      assert.equal(
        await successor.runtime.openOperatorRequest(opening),
        caseId,
      );
      assert.deepEqual(effects, ["first", "second"]);
      assert.equal(providerCalls, 2);
      assert.equal(successor.runtime.snapshot.cases!.length, 1);
      assert.equal(
        successor.runtime.snapshot.cases![0].firstRequestDispatched,
        true,
      );
      const settled = await recovery.database.client.executionContribution
        .findMany({ where });
      assert.equal(settled.length, 1);
      assert.equal(settled[0].contributionId, accepted.contributionId);
      assert.equal(settled[0].jobId, accepted.jobId);
      assert.equal(settled[0].runId, run.runId);
      assert.equal(settled[0].status, "completed");
      const retainedFirst = await recovery.database.client.executionEffect
        .findFirstOrThrow({
          where: { ...where, effectKey: completed[0].effectKey },
        });
      assert.deepEqual(
        retainedFirst,
        completed[0],
        "The completed first receipt is immutable on recovery",
      );
      const memberReceipts = await recovery.database.client.executionEffect
        .findMany({
          where: {
            ...where,
            threadId: accepted.threadId,
            nodeId: invokeNode.nativeId,
          },
        });
      assert.equal(memberReceipts.length, 2);
      assert(memberReceipts.every((receipt) => receipt.status === "completed"));
      const afterBudget = (await successor.storage.budget.load(caseId))!;
      assert.deepEqual(
        afterBudget.events.slice(0, budget.events.length),
        budget.events,
      );
      assert.equal(budgetState(afterBudget).view.consumed, 2);
      assert.equal(budgetState(afterBudget).view.reserved, 0);
      assert.equal(
        afterBudget.events.filter((event) => event.kind === "reserve").length,
        2,
      );
      release.resolve();
      await orphanDone.promise;
    } finally {
      release.resolve();
      await recovery.close();
    }
  },
});

Deno.test({
  name:
    "PG-5.9 declared consultation refusal retires only its exact input checkpoint before separately authorized adoption",
  ignore: !postgresTestEnabled,
  async fn() {
    const scope = {
      projectId: "git:declared-refusal",
      systemId: "declared-refusal-host",
    };
    const recovery = await openPostgresDurableRecoveryHost({
      scope,
    });
    const original = executableFixture({
      projectId: scope.projectId,
      editingContextId: "context",
      rootId: "root",
      systemId: "native-child",
      catalogId: "catalog-child",
      builderId: "child",
    });
    enableCommandFixtureProfile(original);
    original.version.digest = "5".repeat(64);
    original.version.repositoryVersion = `commit:${"d".repeat(40)}`;
    original.policy.mayProposeSysmlRevision = false;
    original.caseTypes = [{
      id: "request-child",
      name: "Request",
      type: "request",
      envelope: "conversational",
      ownerId: "child",
      behaviorId: original.flows.conversation.rootNativeId,
      maxInvocations: 10,
      sourceIds: ["request-child"],
    }];
    const granted = structuredClone(original);
    granted.version.digest = "6".repeat(64);
    granted.version.repositoryVersion = `commit:${"e".repeat(40)}`;
    granted.policy.mayProposeSysmlRevision = true;
    let available = original;
    let providerCalls = 0, sourceReads = 0;
    const source: ModelPort = {
      ...unexpectedModelAuthoring,
      initialize: () => Promise.resolve(structuredClone(original.identity)),
      readExecutableModel: (_identity, version) => {
        if (
          version &&
          ![
            original.version.repositoryVersion,
            granted.version.repositoryVersion,
          ].includes(version)
        ) {
          throw new Error("Unknown exact model pin");
        }
        return Promise.resolve(
          structuredClone(
            version === original.version.repositoryVersion
              ? original
              : version === granted.version.repositoryVersion
              ? granted
              : available,
          ),
        );
      },
      graph: () => Promise.resolve({}),
      applyApprovedChange: () => {
        throw new Error("No source publication through the child fixture");
      },
      activateCandidate: () => {
        throw new Error("No activation authorized");
      },
    };
    const open = async () => {
      const session = await recovery.openSession();
      const storage = await session.storage.operator("child");
      const runtime = new SystemRuntime({
        ...await session.runtimePortsFor("child"),
        model: source,
        workBudget: new WorkBudgetService(storage.budget),
        agents: {
          label:
            "Controlled model/provider; real PG/native refusal and owner adoption",
          decide: () => {
            providerCalls++;
            assert.equal(available.policy.mayProposeSysmlRevision, true);
            return Promise.resolve({
              kind: "reply" as const,
              text: "Source permission separately adopted",
            });
          },
          review: () => {
            throw new Error("No review authorized");
          },
        },
        information: {
          read: (model) =>
            Promise.resolve({
              memoryGuidance: [],
              modelContext: {
                version: model.version.repositoryVersion!,
                sourceDigest: "a".repeat(64),
                files: [],
                roots: { items: [], total: 0, truncated: false },
                limits: {
                  maxPageSize: 50,
                  maxSourceBytes: 131072,
                  maxInspectSourceBytes: 24576,
                },
                coverage: "bounded-discovery-not-exhaustive-impact" as const,
                loadedSources: [],
                maxLoadedCharacters: 120000,
              },
              modelSources: {
                version: model.version.repositoryVersion!,
                sources: {},
              },
            }),
          consultAdmittedModelSource: (model, input) => {
            // The declared read needs no revision right. Here the original
            // pin's declared source is unreadable; only the separately
            // adopted version can be read.
            if (
              model.version.repositoryVersion !==
                granted.version.repositoryVersion
            ) {
              return Promise.reject(
                new Error("The declared source is unreadable at this pin"),
              );
            }
            sourceReads++;
            assert.equal(input.version, model.version.repositoryVersion);
            return Promise.resolve({
              modelVersion: {
                digest: model.version.digest,
                repositoryVersion: model.version.repositoryVersion,
              },
              result: {
                operation: "read_source",
                version: model.version.repositoryVersion,
                sourceDigest: "a".repeat(64),
                path: "conversation.sysml",
                sha256: "a".repeat(64),
                characters: 0,
                content: "",
              },
            });
          },
          consultModel: (model, input) => {
            sourceReads++;
            assert.equal(model.policy.mayProposeSysmlRevision, true);
            assert.equal(input.version, model.version.repositoryVersion);
            return Promise.resolve({
              modelVersion: {
                digest: model.version.digest,
                repositoryVersion: model.version.repositoryVersion,
              },
              result: {
                operation: "read_source",
                version: model.version.repositoryVersion,
                path: "conversation.sysml",
                sha256: "a".repeat(64),
                characters: 0,
                loaded: true,
              },
            });
          },
        },
        runner: {
          test: () => {
            throw new Error("No tool test authorized");
          },
          run: () => {
            throw new Error("No tool effect authorized");
          },
        },
      });
      await runtime.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      await session.start((delivery) =>
        runtime.processAcceptedContribution(delivery)
      );
      return { session, storage, runtime };
    };
    try {
      const first = await open();
      const caseId = await first.runtime.openOperatorRequest({
        changeId: "approved-refusal-child",
        caseTypeId: "request-child",
        objective: "Read the declared source before deciding",
        openedBy: "main",
        openedFrom: {
          conversationId: "main-conversation",
          designerScopeId: "main-designer",
        },
      });
      await eventually(() =>
        first.runtime.snapshot.cases?.[0]?.firstRequestDispatched
          ? true
          : undefined
      );
      await first.session.idle(first.runtime, 30000);
      assert.equal(providerCalls, 0);
      assert.equal(sourceReads, 0);
      assert.equal(first.runtime.snapshot.cases![0].status, "waiting");
      assert.equal(
        first.runtime.snapshot.messages.some((message) =>
          message.role === "assistant"
        ),
        false,
      );
      const [snapshot] = await first.session.native.ledger.inspect("child");
      const refusal = snapshot.localState!
        .declaredConsultationRefusal as NativeDeclaredConsultationRefusal;
      console.log(
        JSON.stringify({
          kind: "actual-child-declared-consultation-refusal",
          snapshot,
        }),
      );
      assert.equal(refusal.code, "MODEL_CONSULTATION_REFUSED");
      assert.equal(refusal.inputMessageId, `${caseId}:objective`);
      assert.equal(
        emptyNativeEvolutionAwait(first.runtime.snapshot, snapshot),
        true,
      );
      const where = { ...scope, executionSpaceId: "main", operatorId: "child" };
      const effect = await recovery.database.client.executionEffect
        .findFirstOrThrow({
          where: { ...where, effectKey: refusal.effectKey },
        });
      assert.equal(effect.status, "completed");
      assert.equal(effect.nodeId, refusal.actionId);
      assert.equal(effect.contributionId, snapshot.contributionId);
      assert.equal(
        JSON.parse(effect.resultJson!).outputs.consultation.succeeded,
        false,
      );
      const beforeBudget = await first.storage.budget.load(caseId);
      assert.equal(
        beforeBudget ? budgetState(beforeBudget).view.consumed : 0,
        0,
      );
      assert.equal(
        beforeBudget ? budgetState(beforeBudget).view.reserved : 0,
        0,
      );
      const forged = structuredClone(snapshot);
      (forged.localState!
        .declaredConsultationRefusal as NativeDeclaredConsultationRefusal)
        .effectKey = `native-effect:${"b".repeat(64)}`;
      await assert.rejects(
        () =>
          first.session.native.execution.retireAndAdvance(forged, {
            kind: "owner-adoption",
            businessRevision: runtimeRevisionReference(first.runtime.snapshot),
            authorizationEventId: "not-authorized",
          }, granted),
        /does not match its accepted native snapshot/,
      );
      await assert.rejects(
        () =>
          first.session.native.execution.retireAndAdvance(snapshot, {
            kind: "owner-adoption",
            businessRevision: runtimeRevisionReference(first.runtime.snapshot),
            authorizationEventId: "not-authorized",
          }, granted),
        /lacks its exact canonical target authorization/,
      );
      await first.session.stop();
      const reopened = await open();
      assert.deepEqual(await reopened.session.native.ledger.inspect("child"), [
        snapshot,
      ]);
      assert.equal(
        emptyNativeEvolutionAwait(reopened.runtime.snapshot, snapshot),
        true,
      );
      available = granted; // Controlled source publication; it grants no authority to the old runtime by itself.
      await reopened.runtime.adoptModelVersion({
        expectedDigest: granted.version.digest,
        expectedVersion: granted.version.repositoryVersion,
      });
      assert.equal(
        reopened.runtime.snapshot.executionModel!.version.digest,
        granted.version.digest,
      );
      assert.equal(providerCalls, 0);
      const retired = await recovery.database.client.operatorExecution
        .findFirstOrThrow({ where: { ...where, threadId: snapshot.threadId } });
      assert.ok(retired.retiredAt);
      const successor = await recovery.database.client.operatorExecution
        .findFirstOrThrow({
          where: { ...where, predecessorThreadId: snapshot.threadId },
        });
      assert.equal(
        successor.authorizedPinJson,
        JSON.stringify({
          modelDigest: granted.version.digest,
          repositoryVersion: granted.version.repositoryVersion,
        }),
      );
      await reopened.runtime.resumeRequest({
        caseId,
        resumeId: "after-read-adoption",
        instruction: "Read then reply",
        openedBy: "main",
        conversationId: "main-conversation",
        designerScopeId: "main-designer",
      });
      await eventually(() =>
        reopened.runtime.snapshot.requestResumptions?.[0]?.status ===
            "completed"
          ? true
          : undefined
      );
      await reopened.session.idle(reopened.runtime, 30000);
      assert.equal(providerCalls, 1);
      assert.equal(sourceReads, 1);
      assert.equal(
        reopened.runtime.snapshot.requestResumptions![0].outcome!.reply,
        "Source permission separately adopted",
      );
      assert.equal(
        emptyNativeEvolutionAwait(reopened.runtime.snapshot, snapshot),
        false,
        "New input cannot reuse the old refusal receipt",
      );
      const resumed = (await reopened.session.native.ledger.inspect("child"))
        .find((execution) =>
          execution.identity.subjectId ===
            `${caseId}:resume:after-read-adoption`
        )!;
      assert.equal(resumed.modelDigest, granted.version.digest);
      assert.equal(
        resumed.localState?.declaredConsultationRefusal,
        undefined,
        "New actions clear the old refusal projection",
      );
      assert.deepEqual(
        await recovery.database.client.executionEffect.findFirstOrThrow({
          where: { ...where, effectKey: refusal.effectKey },
        }),
        effect,
      );
      const afterBudget = (await reopened.storage.budget.load(caseId))!;
      if (beforeBudget) {
        assert.deepEqual(
          afterBudget.events.slice(0, beforeBudget.events.length),
          beforeBudget.events,
        );
      }
      assert.equal(budgetState(afterBudget).view.consumed, 1);
      assert.equal(budgetState(afterBudget).view.reserved, 0);
      assert.equal(reopened.runtime.snapshot.cases!.length, 1);
      assert.equal(
        reopened.runtime.snapshot.events.filter((event) =>
          event.effectiveModelUpdate
        ).length,
        1,
      );
    } finally {
      await recovery.close();
    }
  },
});

Deno.test({
  name:
    "PG-4 real operator worker preserves business history and official checkpoints across reopen",
  ignore: !postgresTestEnabled,
  async fn() {
    const scope = {
      projectId: "git:runtime-fixture",
      systemId: "host-runtime-system",
    };
    const model = executableFixture({
      projectId: scope.projectId,
      editingContextId: "context",
      rootId: "root",
      systemId: "native-system",
      catalogId: "native-catalog",
      builderId: "operator",
    });
    model.version.digest = "a".repeat(64);
    model.version.repositoryVersion = "b".repeat(40);
    model.caseTypes = [{
      id: "fixture-request",
      name: "Request",
      type: "request",
      envelope: "conversational",
      behaviorId: model.flows.conversation.rootNativeId,
      ownerId: model.identity.builderId,
      sourceIds: ["fixture-request"],
    }];
    let decisions = 0;
    const workerErrors: unknown[] = [];
    const agents: AgentPort = {
      label: "bounded fixture decisions; real PostgreSQL production worker",
      decide() {
        decisions++;
        if (decisions > 2) throw new Error("Unexpected provider replay");
        return Promise.resolve({
          kind: "reply",
          text: `Durable reply ${decisions}`,
        });
      },
      review() {
        throw new Error("No candidate review is authorized by this fixture");
      },
    };
    const source: ModelPort = {
      ...unexpectedModelAuthoring,
      initialize: () => Promise.resolve(structuredClone(model.identity)),
      readExecutableModel: () => Promise.resolve(structuredClone(model)),
      applyApprovedChange() {
        throw new Error("No source mutation is authorized by this fixture");
      },
      activateCandidate() {
        throw new Error("No tool activation is authorized by this fixture");
      },
      graph: () => Promise.resolve({}),
    };
    const runner: ToolRunnerPort = {
      test() {
        throw new Error("No tool test is authorized by this fixture");
      },
      run() {
        throw new Error("No external effect is authorized by this fixture");
      },
    };
    // Production composition through the shared durable-recovery fixture
    // host: each session is a fresh runtime over the same saver, store and
    // ledger schemas, separated by an explicit stop boundary.
    const recovery = await openPostgresDurableRecoveryHost({ scope });
    const { database, schemas } = recovery;
    const open = async () => {
      const session = await recovery.openSession();
      const storage = await session.storage.operator(
        model.identity.builderId,
      );
      const runtime = new SystemRuntime({
        ...await session.runtimePortsFor(model.identity.builderId),
        clock: { now: () => "2026-10-27T00:00:00.000Z" },
        agents,
        model: source,
        runner,
        workBudget: new WorkBudgetService(storage.budget),
      });
      await runtime.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      await session.start(async (delivery) => {
        try {
          await runtime.processAcceptedContribution(delivery);
        } catch (error) {
          workerErrors.push(error);
          throw error;
        }
      });
      return { session, runtime, storage };
    };
    try {
      let active = await open();
      const caseId = await active.runtime.submit(
        "First durable input",
        undefined,
        undefined,
        true,
      );
      assert.ok(caseId);
      const diagnose = async () => {
        const current = await active.storage.state.load();
        return {
          decisions,
          state: current
            ? {
              revision: current.revision,
              busy: current.busy,
              error: current.error,
              phase: current.phase,
              messages: current.messages.map((message) => ({
                id: message.id,
                role: message.role,
              })),
            }
            : null,
          contributions: await database.client.executionContribution.findMany({
            select: { status: true, jobId: true },
          }),
          jobs: await database.client.$queryRawUnsafe(
            `SELECT state::text, retry_count, output FROM "${schemas.queueSchema}".job`,
          ),
        };
      };
      const awaitReply = (text: string) =>
        eventually(
          async () => {
            if (workerErrors.length) {
              throw new AggregateError(
                workerErrors,
                "The actual production worker failed",
              );
            }
            const current = await active.storage.state.load();
            if (current?.error) {
              throw new Error(
                `The actual business turn failed: ${current.error}`,
              );
            }
            return current && !current.busy &&
                current.messages.some((message) =>
                  message.role === "assistant" && message.text === text
                )
              ? current
              : undefined;
          },
          { diagnose },
        );
      let state = await awaitReply("Durable reply 1");
      assert.equal(decisions, 1);
      assert.equal(state.error, undefined);
      const firstAccepted = await database.client.executionContribution
        .findFirstOrThrow({
          where: {
            ...scope,
            executionSpaceId: "main",
            operatorId: model.identity.builderId,
          },
        });
      const firstDelivery = JSON.parse(
        firstAccepted.payloadJson,
      ) as OperatorExecutionDelivery;
      await eventually(async () => {
        const receipt = await active.session.native.dispatch.inspect(
          firstDelivery.identity,
          firstDelivery.id,
        );
        return receipt?.status === "completed" ? receipt : undefined;
      });
      assert.equal(
        state.cases?.find((record) => record.id === caseId)?.number,
        1,
      );
      assert.equal(
        state.messages.filter((message) =>
          message.role === "user" && message.text === "First durable input"
        ).length,
        1,
      );
      const revisionBeforeClose = state.revision;
      const checkpointRows = await database.client.$queryRawUnsafe<
        Array<{ count: bigint }>
      >(
        `SELECT count(*) AS count FROM "${schemas.checkpointSchema}"."checkpoints"`,
      );
      assert.ok(checkpointRows[0].count > 0n);
      const stopped = active.session;
      await stopped.stop();
      // The stopped session is fenced off: it cannot accept new work, and a
      // successor session must be opened explicitly on the same database.
      await assert.rejects(
        () => stopped.start(async () => {}),
        /closed/,
      );
      active = await open();
      const retainedCheckpoints = await database.client.$queryRawUnsafe<
        Array<{ count: bigint }>
      >(
        `SELECT count(*) AS count FROM "${schemas.checkpointSchema}"."checkpoints"`,
      );
      assert.ok(retainedCheckpoints[0].count >= checkpointRows[0].count);
      assert.equal(
        (await active.session.native.dispatch.inspect(
          firstDelivery.identity,
          firstDelivery.id,
        ))?.status,
        "completed",
      );
      assert.ok(active.runtime.snapshot.revision >= revisionBeforeClose);
      assert.equal(
        active.runtime.snapshot.cases?.find((record) => record.id === caseId)
          ?.number,
        1,
      );
      await active.runtime.submit("Second durable input", undefined, caseId);
      state = await awaitReply("Durable reply 2");
      assert.equal(decisions, 2);
      assert.equal(state.error, undefined);
      assert.ok((await active.storage.state.listRevisions()).length > 2);
      const accepted = await database.client.executionContribution
        .findFirstOrThrow({
          where: {
            ...scope,
            executionSpaceId: "main",
            operatorId: model.identity.builderId,
          },
          orderBy: { acceptedAt: "desc" },
        });
      const delivery = JSON.parse(
        accepted.payloadJson,
      ) as OperatorExecutionDelivery;
      await eventually(async () => {
        const receipt = await active.session.native.dispatch.inspect(
          delivery.identity,
          delivery.id,
        );
        return receipt?.status === "completed" ? receipt : undefined;
      });
      // REPLAY: exact redelivery returns the prior receipt and consumes no
      // second input or decision; the same ID with different content is a
      // conflict refusal.
      const replay = await active.session.native.dispatch.enqueue(delivery);
      assert.equal(replay.status, "completed");
      assert.equal(decisions, 2);
      assert.equal(
        (await active.storage.state.load())?.messages.filter((message) =>
          message.text === "Durable reply 2"
        ).length,
        1,
      );
      const conflict = structuredClone(delivery);
      conflict.payload = { ...conflict.payload, text: "Different input" };
      await assert.rejects(
        () => active.session.native.dispatch.enqueue(conflict),
        /different accepted content/,
      );
      assert.equal(decisions, 2);
    } finally {
      await recovery.close();
    }
  },
});

Deno.test({
  name:
    "PG-4 kill-mid-execution is fenced on the successor without duplicate effect",
  ignore: !postgresTestEnabled,
  async fn() {
    const scope = {
      projectId: "git:runtime-fixture",
      systemId: "host-runtime-system",
    };
    const model = executableFixture({
      projectId: scope.projectId,
      editingContextId: "context",
      rootId: "root",
      systemId: "native-system",
      catalogId: "native-catalog",
      builderId: "operator",
    });
    model.version.digest = "a".repeat(64);
    model.version.repositoryVersion = "b".repeat(40);
    model.caseTypes = [{
      id: "fixture-request",
      name: "Request",
      type: "request",
      envelope: "conversational",
      behaviorId: model.flows.conversation.rootNativeId,
      ownerId: model.identity.builderId,
      sourceIds: ["fixture-request"],
    }];
    // The only decide parks mid-execution, so the kill lands while work is
    // genuinely in flight; it is never released, modelling the dead worker.
    // Retried attempts must never reach a second decision.
    let decisions = 0;
    let decideEntered = 0;
    const workerErrors: unknown[] = [];
    const agents: AgentPort = {
      label: "parked fixture decision; kill lands mid-execution",
      decide() {
        decisions++;
        decideEntered++;
        return new Promise<never>(() => {});
      },
      review() {
        throw new Error("No candidate review is authorized by this fixture");
      },
    };
    const source: ModelPort = {
      ...unexpectedModelAuthoring,
      initialize: () => Promise.resolve(structuredClone(model.identity)),
      readExecutableModel: () => Promise.resolve(structuredClone(model)),
      applyApprovedChange() {
        throw new Error("No source mutation is authorized by this fixture");
      },
      activateCandidate() {
        throw new Error("No tool activation is authorized by this fixture");
      },
      graph: () => Promise.resolve({}),
    };
    const runner: ToolRunnerPort = {
      test() {
        throw new Error("No tool test is authorized by this fixture");
      },
      run() {
        throw new Error("No external effect is authorized by this fixture");
      },
    };
    const recovery = await openPostgresDurableRecoveryHost({ scope });
    const { database, schemas } = recovery;
    const contributionWhere = {
      ...scope,
      executionSpaceId: "main",
      operatorId: model.identity.builderId,
    };
    const open = async () => {
      const session = await recovery.openSession();
      const storage = await session.storage.operator(
        model.identity.builderId,
      );
      const runtime = new SystemRuntime({
        ...await session.runtimePortsFor(model.identity.builderId),
        clock: { now: () => "2026-10-27T00:00:00.000Z" },
        agents,
        model: source,
        runner,
        workBudget: new WorkBudgetService(storage.budget),
      });
      await runtime.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      await session.start(async (delivery) => {
        try {
          await runtime.processAcceptedContribution(delivery);
        } catch (error) {
          workerErrors.push(error);
          throw error;
        }
      });
      return { session, runtime, storage };
    };
    type FenceSession = Parameters<
      PostgresNativeExecutionLedger["fence"]
    >[1];
    const probeFence = (
      ledger: PostgresNativeExecutionLedger,
      record: {
        threadId: string;
        identityDigest: string;
        epoch: bigint;
        runId: string;
        jobId: string;
        retryCount: number;
      },
    ) =>
      postgresExecutionTransaction(ledger.client, async (tx) => {
        const query = fromPrisma(tx).executeSql;
        await ledger.fence(
          query,
          {
            scope: {
              projectId: scope.projectId,
              systemId: scope.systemId,
              executionSpaceId: "main",
              operatorId: model.identity.builderId,
            },
            ...record,
            signal: new AbortController().signal,
          } as unknown as FenceSession,
        );
      });
    const readJobs = () =>
      database.client.$queryRawUnsafe<
        Array<{ id: string; state: string; retry_count: number }>
      >(
        `SELECT id, state::text AS state, retry_count FROM "${schemas.queueSchema}".job ORDER BY created_on`,
      );
    try {
      const first = await open();
      const caseId = await first.runtime.submit(
        "Kill recovery input",
        undefined,
        undefined,
        true,
      );
      assert.ok(caseId);
      // Mid-execution: the provider decision is in flight AND the queue
      // claim has marked the contribution running.
      const accepted = await eventually(
        async () => {
          if (decideEntered < 1) return undefined;
          const row = await database.client.executionContribution.findFirst({
            where: contributionWhere,
          });
          return row?.status === "running" ? row : undefined;
        },
      );
      const firstDelivery = JSON.parse(
        accepted.payloadJson,
      ) as OperatorExecutionDelivery;
      const threadId = accepted.threadId;
      const preKill = await database.client.operatorExecution.findFirstOrThrow(
        {
          where: { ...contributionWhere, threadId },
        },
      );
      const firstEpoch = preKill.epoch;
      assert.ok(preKill.currentRunId);
      assert.ok(preKill.currentJobId);
      assert.equal(preKill.currentRetry, 0);
      const firstRun = await database.client.executionRun.findFirstOrThrow({
        where: {
          ...contributionWhere,
          threadId,
          runId: preKill.currentRunId!,
        },
      });
      assert.equal(firstRun.retryCount, 0);
      const identityDigest = await executionDigest(firstDelivery.identity);
      // The official fence refuses a non-current session while the first
      // claim is live: same live claim, superseded run identity.
      await assert.rejects(
        () =>
          probeFence(first.session.native.ledger, {
            threadId,
            identityDigest,
            epoch: firstEpoch,
            runId: `${firstRun.runId}-superseded`,
            jobId: preKill.currentJobId!,
            retryCount: 0,
          }),
        /STALE_EXECUTION_EPOCH/,
      );
      // The kill aborts the worker path without graceful drain: it must
      // resolve while the decision is still parked, settling nothing.
      const killStarted = Date.now();
      await first.session.kill();
      const killMs = Date.now() - killStarted;
      assert.ok(
        killMs < 10_000,
        `Kill awaited in-flight work instead of aborting it (${killMs}ms)`,
      );
      assert.equal(decideEntered, 1);
      assert.equal(
        (await database.client.executionContribution.findFirstOrThrow({
          where: {
            ...contributionWhere,
            contributionId: accepted.contributionId,
          },
        })).status,
        "running",
      );
      // Fenced successor: the killed session released the single-active
      // slot. The queue redelivers the same job, the ledger reclaims it
      // into a new epoch of the same run on the retained checkpoint
      // namespace, and refuses the unsettled effect instead of replaying
      // it: the turn ends explicitly uncertain, never duplicated.
      await open();
      await eventually(async () => {
        const row = await database.client.executionContribution.findFirst({
          where: {
            ...contributionWhere,
            contributionId: accepted.contributionId,
          },
        });
        return row?.status === "uncertain" ? row : undefined;
      }, { timeoutMs: 60_000 });
      await eventually(async () => {
        const jobs = await readJobs();
        return jobs.length === 1 && jobs[0].state === "failed"
          ? true
          : undefined;
      }, { timeoutMs: 60_000 });
      const fenced = await database.client.operatorExecution.findFirstOrThrow({
        where: { ...contributionWhere, threadId },
      });
      assert.ok(fenced.epoch > firstEpoch);
      assert.equal(fenced.currentRunId, firstRun.runId);
      assert.equal(fenced.currentJobId, firstRun.jobId);
      const fencedRun = await database.client.executionRun.findFirstOrThrow({
        where: {
          ...contributionWhere,
          threadId,
          runId: firstRun.runId,
        },
      });
      assert.equal(fencedRun.status, "uncertain");
      assert.equal(fencedRun.checkpointNamespace, firstRun.checkpointNamespace);
      // The dead attempt's own fenced write is refused: its superseded
      // epoch and claim no longer hold the thread.
      await assert.rejects(
        () =>
          probeFence(first.session.native.ledger, {
            threadId,
            identityDigest,
            epoch: firstEpoch,
            runId: firstRun.runId,
            jobId: firstRun.jobId,
            retryCount: 0,
          }),
        /STALE_EXECUTION_/,
      );
      // No duplicate business effect: the killed turn produced no reply,
      // the refused retries re-ran no decision, and the official
      // checkpoints written before the kill are retained.
      assert.equal(decisions, 1);
      const stored = await first.storage.state.load();
      assert.equal(
        stored?.messages.filter((message) => message.role === "assistant")
          .length,
        0,
      );
      assert.equal(
        stored?.messages.filter((message) =>
          message.role === "user" && message.text === "Kill recovery input"
        ).length,
        1,
      );
      const checkpointRows = await database.client.$queryRawUnsafe<
        Array<{ count: bigint }>
      >(
        `SELECT count(*) AS count FROM "${schemas.checkpointSchema}"."checkpoints"`,
      );
      assert.ok(checkpointRows[0].count > 0n);
      // Aftermath, and nothing else: the orphan's aborted signal, plus the
      // first retry's refused unsettled-effect replay. Later retries never
      // reach the handler: dispatch admits no contribution already marked
      // uncertain (OPERATOR_CONTRIBUTION_UNKNOWN).
      assert.equal(workerErrors.length, 2);
      assert.equal(
        workerErrors.filter((error) =>
          /abort/i.test(error instanceof Error ? error.message : String(error))
        ).length,
        1,
      );
      assert.equal(
        workerErrors.filter((error) =>
          /EXECUTION_EFFECT_UNKNOWN/.test(
            error instanceof Error ? error.message : String(error),
          )
        ).length,
        1,
      );
    } finally {
      await recovery.close();
    }
  },
});
