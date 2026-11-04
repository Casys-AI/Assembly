import assert from "node:assert/strict";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import { budgetState } from "../../src/domain/work/policies/budget.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import {
  enableCommandFixtureProfile,
  executableFixture,
} from "../support/execution-fixture.ts";
import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import { openPostgresDurableRecoveryHost } from "../support/postgres-runtime-fixture.ts";
import { postgresTestEnabled } from "../support/postgres.ts";

for (const legacySnapshot of [false, true]) {
  Deno.test({
    name:
      `PG budget ceiling resumes the exact direct native wait after restart (legacy snapshot: ${legacySnapshot})`,
    ignore: !postgresTestEnabled,
    async fn() {
      const scope = {
        projectId: "git:budget-ceiling",
        systemId: "budget-ceiling-host",
      };
      const recovery = await openPostgresDurableRecoveryHost({
        scope,
      });
      const original = executableFixture({
        projectId: scope.projectId,
        editingContextId: "context",
        rootId: "root",
        systemId: "budget-system",
        catalogId: "budget-catalog",
        builderId: "owner",
      });
      enableCommandFixtureProfile(original, {
        legacyDeclaredConsultation: true,
      });
      original.policy.mayProposeSysmlRevision = true;
      original.version.digest = "1".repeat(64);
      original.version.repositoryVersion = `commit:${"a".repeat(40)}`;
      original.workBudgetPolicy = {
        id: "budget-ceiling",
        revision: 1,
        unit: "agent-invocation",
        limit: 1,
        onExhausted: "wait",
        exhaustionRecipient: "local-control",
        elementId: "budget-native",
        sourceIds: ["budget-native"],
      };
      original.caseTypes = [{
        id: "budget-request",
        name: "Request",
        type: "request",
        envelope: "conversational",
        ownerId: "owner",
        behaviorId: original.flows.conversation.rootNativeId,
        sourceIds: ["budget-request"],
      }];
      const target = structuredClone(original);
      target.version.digest = "2".repeat(64);
      target.version.repositoryVersion = `commit:${"b".repeat(40)}`;
      target.workBudgetPolicy!.limit = 2;
      target.workBudgetPolicy!.revision = 2;
      let available = original,
        providerCalls = 0,
        verifiedNegative = false,
        parked = false;
      let legacyBytes: string | undefined, legacyRunId: string | undefined;
      const reached = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>(),
        orphanDone = Promise.withResolvers<void>();
      const consultationPins: string[] = [];
      const source = {
        ...unexpectedModelAuthoring,
        initialize: () => Promise.resolve(structuredClone(original.identity)),
        readExecutableModel: (
          _identity: typeof original.identity,
          version?: string,
        ) => {
          const found = !version
            ? available
            : version === original.version.repositoryVersion
            ? original
            : version === target.version.repositoryVersion
            ? target
            : undefined;
          if (!found) throw new Error("Unknown exact source version");
          return Promise.resolve(structuredClone(found));
        },
        graph: () => Promise.resolve({}),
        applyApprovedChange: () => {
          throw new Error("Unexpected model mutation");
        },
        activateCandidate: () => {
          throw new Error("Unexpected activation");
        },
      };
      const open = async () => {
        const session = await recovery.openSession();
        if (legacySnapshot) {
          const originalOpen = session.native.ledger.open.bind(
            session.native.ledger,
          );
          session.native.ledger.open = async (request) => {
            const native = await originalOpen(request);
            return {
              ...native,
              complete: async (snapshot) => {
                if (
                  legacyBytes !== undefined || snapshot.status !== "waiting" ||
                  !snapshot.waits.some((wait) => wait.kind === "budget")
                ) {
                  return await native.complete(snapshot);
                }
                // Fixture writer emulates the old snapshot format at its original
                // completion. The official saver tuple and resulting bytes are not rewritten.
                const {
                  runId: _runId,
                  checkpointNamespace: _namespace,
                  budgetContinuationSource: _source,
                  ...oldSnapshot
                } = snapshot;
                const bytes = canonical(oldSnapshot);
                await native.assertCurrent();
                await recovery.database.client.$transaction(async (tx) => {
                  const where = {
                    ...scope,
                    executionSpaceId: "main",
                    operatorId: "owner",
                    threadId: native.threadId,
                  };
                  const row = await tx.operatorExecution.findFirstOrThrow({
                    where,
                  });
                  if (
                    row.currentRunId !== native.runId ||
                    row.currentCheckpointId !== snapshot.checkpointId ||
                    row.retiredAt
                  ) {
                    throw new Error(
                      "Legacy fixture lost its selected checkpoint",
                    );
                  }
                  const run = await tx.executionRun.updateMany({
                    where: {
                      ...where,
                      runId: native.runId,
                      checkpointId: snapshot.checkpointId,
                    },
                    data: { status: snapshot.status, snapshotJson: bytes },
                  });
                  assert.equal(run.count, 1);
                  const owner = await tx.operatorExecution.updateMany({
                    where: {
                      ...where,
                      currentRunId: native.runId,
                      epoch: row.epoch,
                    },
                    data: {
                      status: snapshot.status,
                      revision: { increment: 1 },
                    },
                  });
                  assert.equal(owner.count, 1);
                });
                await native.assertCurrent();
                legacyBytes = bytes;
                legacyRunId = native.runId;
              },
            };
          };
        }
        const storage = await session.storage.operator("owner");
        const ports = await session.runtimePortsFor("owner");
        const runtime = new SystemRuntime({
          ...ports,
          model: source,
          workBudget: new WorkBudgetService(storage.budget),
          execution: {
            inspect: (id) => ports.execution.inspect(id),
            closeScope: (snapshot, closure) =>
              ports.execution.closeScope(snapshot, closure),
            retireAndAdvance: (snapshot, authorization, targetModel) =>
              ports.execution.retireAndAdvance(
                snapshot,
                authorization,
                targetModel,
              ),
            run: async (request, handlers) => {
              if (
                !verifiedNegative &&
                request.identity.purpose === "conversation" &&
                request.contribution.kind === "resume" &&
                request.model.version.digest === target.version.digest
              ) {
                await assert.rejects(() =>
                  ports.execution.run({
                    ...request,
                    contribution: {
                      ...request.contribution,
                      inputMessageId: "foreign-input",
                    },
                  }, handlers)
                );
                const foreign = structuredClone(request);
                foreign.model.version.digest = "f".repeat(64);
                await assert.rejects(() =>
                  ports.execution.run(foreign, handlers)
                );
                verifiedNegative = true;
              }
              const result = await ports.execution.run(request, handlers);
              if (
                !parked && request.identity.purpose === "conversation" &&
                request.contribution.kind === "resume" &&
                request.model.version.digest === target.version.digest &&
                result.status === "waiting"
              ) {
                parked = true;
                reached.resolve();
                try {
                  await release.promise;
                  throw new Error(
                    "Interrupted after native completion before delivery ACK",
                  );
                } finally {
                  orphanDone.resolve();
                }
              }
              return result;
            },
          },
          agents: {
            label: "bounded fixture provider; real PG worker and native saver",
            decide: () => {
              providerCalls++;
              return Promise.resolve({
                kind: "reply" as const,
                text: `Reply ${providerCalls}`,
              });
            },
            review: () => {
              throw new Error("Unexpected review");
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
            consultModel: (model, input) => {
              assert.equal(input.version, model.version.repositoryVersion);
              consultationPins.push(model.version.digest);
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
            consultAdmittedModelSource: (model, input) => {
              assert.equal(input.version, model.version.repositoryVersion);
              consultationPins.push(model.version.digest);
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
              throw new Error("Unexpected test");
            },
            run: () => {
              throw new Error("Unexpected tool");
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
        let active = await open();
        const caseId = await active.runtime.submit(
          "First input",
          undefined,
          undefined,
          true,
        );
        assert.ok(caseId, "A new Request must have an exact Case id");
        await active.session.idle(active.runtime, 30000);
        assert.equal(active.runtime.snapshot.error, undefined);
        assert.equal(
          providerCalls,
          1,
          JSON.stringify({
            consultationPins,
            messages: active.runtime.snapshot.messages,
            error: active.runtime.snapshot.error,
          }),
        );
        assert.deepEqual(
          consultationPins,
          [original.version.digest],
          "the declared consultation must complete under the admitted source pin",
        );
        await active.runtime.submit(
          "Second input exhausts budget",
          undefined,
          caseId,
        );
        await active.session.idle(active.runtime, 30000);
        assert.equal(active.runtime.snapshot.error, undefined);
        assert.equal(
          active.runtime.snapshot.budgetSuspension?.reason,
          "exhausted",
        );
        assert.equal(providerCalls, 1);
        const before = (await active.storage.budget.load(caseId))!;
        assert.equal(budgetState(before).view.consumed, 1);
        const nativeBefore = await active.session.native.execution.inspect(
          "owner",
        );
        const waiting = nativeBefore.find((item) =>
          item.waits.some((wait) => wait.kind === "budget")
        );
        assert.ok(
          waiting?.checkpointId && waiting.runId &&
            waiting.budgetContinuationSource,
        );
        if (legacySnapshot) {
          assert.ok(legacyBytes && legacyRunId);
          assert.equal(waiting.runId, legacyRunId);
          assert.equal(
            waiting.budgetContinuationSource!.sourceKind,
            "settled-budget-wait",
          );
        }
        const effectsBefore = await recovery.database.client.executionEffect
          .findMany({ orderBy: { startedAt: "asc" } });
        if (legacySnapshot) {
          await active.session.stop();
          active = await open();
          const restored =
            (await active.session.native.execution.inspect("owner")).find(
              (item) => item.runId === legacyRunId,
            );
          assert.equal(restored?.checkpointId, waiting.checkpointId);
          assert.deepEqual(
            restored?.budgetContinuationSource,
            waiting.budgetContinuationSource,
          );
        }
        available = target;
        await active.runtime.adoptModelVersion({
          expectedDigest: target.version.digest,
        });
        assert.equal(providerCalls, 1, "adoption alone cannot dispatch");
        await active.session.stop();
        active = await open();
        await active.runtime.submit(
          "Resume exact waiting work",
          undefined,
          caseId,
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            reached.promise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Terminal replay boundary timeout")),
                30000,
              );
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        const terminalReceipts = await recovery.database.client
          .nativeContinuationReceipt.findMany({
            where: {
              evidenceKind: "verified-budget-ceiling-advance",
              status: "selected",
            },
          });
        assert.equal(terminalReceipts.length, 1);
        assert.equal(providerCalls, 2);
        await active.session.kill();
        active = await open();
        await active.session.idle(active.runtime, 30000);
        assert.equal(active.runtime.snapshot.error, undefined);
        assert.equal(active.runtime.snapshot.budgetSuspension, undefined);
        assert.equal(providerCalls, 2);
        assert.equal(
          verifiedNegative,
          true,
          "foreign retained input and target pin are refused at the native boundary",
        );
        assert.equal(
          consultationPins.at(-1),
          target.version.digest,
          "the resumed choose_move re-enters its declared source consultation under the target pin",
        );
        const after = (await active.storage.budget.load(caseId))!;
        assert.deepEqual(
          after.events.slice(0, before.events.length),
          before.events,
        );
        assert.equal(budgetState(after).view.consumed, 2);
        assert.equal(budgetState(after).view.reserved, 0);
        const effectsAfter = await recovery.database.client.executionEffect
          .findMany();
        for (const prior of effectsBefore) {
          assert.deepEqual(
            effectsAfter.find((effect) => effect.effectKey === prior.effectKey),
            prior,
          );
        }
        const receipts = await recovery.database.client
          .nativeContinuationReceipt
          .findMany({
            where: { evidenceKind: "verified-budget-ceiling-advance" },
          });
        assert.equal(receipts.length, 1);
        assert.deepEqual(receipts[0], terminalReceipts[0]);
        assert.equal(receipts[0].status, "selected");
        assert.equal(receipts[0].predecessorRunId, waiting.runId);
        assert.equal(receipts[0].sourceCheckpointId, waiting.checkpointId);
        assert.equal(receipts[0].sourceKind, "settled-budget-wait");
        if (legacySnapshot) {
          const historical = await recovery.database.client.executionRun
            .findFirstOrThrow({
              where: {
                ...scope,
                executionSpaceId: "main",
                operatorId: "owner",
                threadId: waiting.threadId,
                runId: legacyRunId,
              },
            });
          assert.equal(
            historical.snapshotJson,
            legacyBytes,
            "historical bytes remain unchanged after reconstruction and continuation",
          );
        }
      } finally {
        release.resolve();
        if (parked) await orphanDone.promise;
        await recovery.close();
      }
    },
  });
}

for (
  const interruption of [
    "authorized-intent",
    "policy-cas",
    "canonical-adoption",
    "unselected-fork",
    "first-selected",
    "catalog-receipt",
    "preselected-reply",
  ] as const
) {
  Deno.test({
    name: `PG two-draft ceiling continuation recovers after ${interruption}`,
    ignore: !postgresTestEnabled,
    async fn() {
      const scope = {
        projectId: "git:budget-two-drafts",
        systemId: "budget-two-drafts-host",
      };
      const recovery = await openPostgresDurableRecoveryHost({
        scope,
      });
      const model = executableFixture({
        projectId: scope.projectId,
        editingContextId: "context",
        rootId: "root",
        systemId: "budget-two-drafts",
        catalogId: "budget-catalog",
        builderId: "owner",
      });
      enableCommandFixtureProfile(model, { legacyDeclaredConsultation: true });
      model.policy.mayProposeSysmlRevision = true;
      model.flows.conversation.executionProfile =
        "operator-command-immutable-group-v1";
      model.version.digest = "3".repeat(64);
      model.version.repositoryVersion = `commit:${"c".repeat(40)}`;
      model.configuration.builder.admissionAuthority = "builder";
      model.mandate.mayAdmitOwnCandidates = true;
      model.workBudgetPolicy = {
        id: "budget-two",
        revision: 1,
        unit: "agent-invocation",
        limit: 2,
        onExhausted: "wait",
        exhaustionRecipient: "local-control",
        elementId: "budget-native",
        sourceIds: ["budget-native"],
      };
      model.caseTypes = [{
        id: "budget-request",
        name: "Request",
        type: "request",
        envelope: "conversational",
        ownerId: "owner",
        behaviorId: model.flows.conversation.rootNativeId,
        sourceIds: ["budget-request"],
      }];
      let available = structuredClone(model),
        providerCalls = 0,
        publications = 0;
      const versions = new Map([[
        available.version.repositoryVersion!,
        structuredClone(available),
      ]]);
      const tested: string[] = [];
      const reached = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>(),
        orphanDone = Promise.withResolvers<void>();
      let parked = false, injected = false, staleRejected = false;
      let durableCatalogEffectKey: string | undefined;
      let diagnosticRuntime: SystemRuntime | undefined;
      const observedFailures: Array<Record<string, unknown>> = [];
      const observeFailure = (
        phase: string,
        error: unknown,
        detail: Record<string, unknown> = {},
      ) => {
        if (observedFailures.length >= 16) return;
        observedFailures.push({
          phase,
          ...detail,
          name: error instanceof Error ? error.name : "UnknownError",
          message: String(error instanceof Error ? error.message : error).slice(
            0,
            2048,
          ),
          stack: error instanceof Error
            ? error.stack?.slice(0, 4096)
            : undefined,
        });
      };
      // One retained technical double survives these simulated runtime sessions.
      // This fixture proves neither Git retention nor an OS-process restart.
      const artifactSources =
        (await import("../support/memory-artifact-sources.ts"))
          .createMemoryArtifactSources();
      const source = {
        ...unexpectedModelAuthoring,
        initialize: () => Promise.resolve(structuredClone(model.identity)),
        readExecutableModel: (
          _identity: typeof model.identity,
          version?: string,
        ) => {
          const found = version ? versions.get(version) : available;
          if (!found) throw new Error("Unknown exact source version");
          return Promise.resolve(structuredClone(found));
        },
        graph: () => Promise.resolve({}),
        applyApprovedChange: () => {
          throw new Error("Unexpected model edit");
        },
        activateCandidate(
          _identity: typeof model.identity,
          candidate: import("../../src/domain/work/candidates.ts").Candidate,
          admittedDigest: string,
        ) {
          assert.equal(admittedDigest, candidate.activationModelDigest);
          assert.equal(candidate.tests?.passed, true);
          assert.equal(candidate.admission?.candidateDigest, candidate.digest);
          const binding = {
            elementId: `native-${candidate.id}`,
            graphPath: `catalog.${candidate.name}`,
          };
          available.catalog.push({
            nativeId: binding.elementId,
            candidateId: candidate.id,
            contractId: available.contracts.find((item) =>
              item.kind === candidate.kind
            )!.nativeId,
            kind: candidate.kind,
            name: candidate.name,
            digest: candidate.digest,
            status: "active",
          });
          publications++;
          available.version.repositoryVersion = `commit:${
            publications === 1 ? "d".repeat(40) : "f".repeat(40)
          }`;
          versions.set(
            available.version.repositoryVersion,
            structuredClone(available),
          );
          return Promise.resolve(binding);
        },
        findCandidate(
          _identity: typeof model.identity,
          candidate: import("../../src/domain/work/candidates.ts").Candidate,
        ) {
          const entry = available.catalog.find((item) =>
            item.candidateId === candidate.id
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
      };
      const open = async (interrupt: boolean) => {
        const session = await recovery.openSession();
        if (interrupt && interruption === "catalog-receipt") {
          const originalOpen = session.native.ledger.open.bind(
            session.native.ledger,
          );
          const wrap = (
            native:
              import("../../src/adapters/out/native-execution/conversation.ts").NativeExecutionSession,
            purpose: string,
          ): import("../../src/adapters/out/native-execution/conversation.ts").NativeExecutionSession => ({
            ...native,
            effect: async (key, node, operation, admit) => {
              const result = await native.effect(key, node, operation, admit);
              if (
                !parked && purpose === "conversation" &&
                node.mechanism === "submit_proposal" &&
                result.modelAdvance?.kind === "verified-catalog-advance" &&
                publications === 2
              ) {
                durableCatalogEffectKey = key;
                parked = true;
                reached.resolve();
                try {
                  await release.promise;
                  throw new Error(
                    "Interrupted after durable catalog effect receipt",
                  );
                } finally {
                  orphanDone.resolve();
                }
              }
              return result;
            },
            advance: async (advance, fork) => {
              const selected = await native.advance(advance, fork);
              return { ...selected, session: wrap(selected.session, purpose) };
            },
          });
          session.native.ledger.open = async (request) =>
            wrap(await originalOpen(request), request.identity.purpose);
        }
        if (interrupt && interruption === "unselected-fork") {
          const originalOpen = session.native.ledger.open.bind(
            session.native.ledger,
          );
          session.native.ledger.open = async (request) => {
            const native = await originalOpen(request);
            return {
              ...native,
              advance: (advance, fork) =>
                native.advance(advance, async (saver, config) => {
                  const result = await fork(saver, config);
                  if (
                    !parked &&
                    advance.evidence.kind === "verified-budget-ceiling-advance"
                  ) {
                    parked = true;
                    reached.resolve();
                    try {
                      await release.promise;
                      throw new Error(
                        "Interrupted after official unselected fork",
                      );
                    } finally {
                      orphanDone.resolve();
                    }
                  }
                  return result;
                }),
            };
          };
        }
        const diagnosticOpen = session.native.ledger.open.bind(
          session.native.ledger,
        );
        session.native.ledger.open = async (request) => {
          const wrap = (
            native:
              import("../../src/adapters/out/native-execution/conversation.ts").NativeExecutionSession,
          ): import("../../src/adapters/out/native-execution/conversation.ts").NativeExecutionSession => ({
            ...native,
            async effect(key, node, operation, admit) {
              try {
                return await native.effect(key, node, operation, admit);
              } catch (error) {
                observeFailure("native-effect", error, {
                  key,
                  nodeId: node.id,
                  nativeId: node.nativeId,
                  mechanism: node.mechanism,
                  threadId: native.threadId,
                  runId: native.runId,
                  purpose: request.identity.purpose,
                  contribution: request.contribution,
                });
                throw error;
              }
            },
            async advance(advance, fork) {
              try {
                const result = await native.advance(advance, fork);
                return { ...result, session: wrap(result.session) };
              } catch (error) {
                observeFailure("native-advance", error, {
                  threadId: native.threadId,
                  runId: native.runId,
                  kind: advance.evidence.kind,
                });
                throw error;
              }
            },
          });
          try {
            return wrap(await diagnosticOpen(request));
          } catch (error) {
            observeFailure("native-open", error, {
              identity: request.identity,
              contribution: request.contribution,
            });
            throw error;
          }
        };
        const ports = await session.runtimePortsFor("owner");
        const storage = await session.storage.operator("owner");
        const budget = new WorkBudgetService(storage.budget);
        if (interrupt && interruption === "policy-cas") {
          const advance = budget.advanceCeiling.bind(budget);
          budget.advanceCeiling = async (input) => {
            const record = await advance(input);
            if (!injected) {
              injected = true;
              throw new Error("Interrupted after budget policy CAS");
            }
            return record;
          };
        }
        const store = {
          ...ports.store,
          load: () => ports.store.load(),
          close: () => ports.store.close(),
          save: async (
            state: Parameters<typeof ports.store.save>[0],
            expected: Parameters<typeof ports.store.save>[1],
          ) => {
            await ports.store.save(state, expected);
            if (
              interrupt && !injected &&
              ((interruption === "authorized-intent" &&
                state.budgetCeilingTransition?.phase === "authorized-intent") ||
                (interruption === "canonical-adoption" &&
                  state.budgetCeilingTransition?.phase ===
                    "adopted-continuations-pending"))
            ) {
              injected = true;
              throw new Error(`Interrupted after ${interruption} commit`);
            }
          },
        };
        const runtime = new SystemRuntime({
          ...ports,
          store,
          execution: {
            inspect: (id) => ports.execution.inspect(id),
            closeScope: (snapshot, closure) =>
              ports.execution.closeScope(snapshot, closure),
            retireAndAdvance: (snapshot, authorization, target) =>
              ports.execution.retireAndAdvance(snapshot, authorization, target),
            run: async (request, handlers) => {
              const result = await ports.execution.run(request, {
                ...handlers,
                continuationSelected: async (receipt) => {
                  if (!handlers.continuationSelected) {
                    throw new Error("Missing production selection handler");
                  }
                  await handlers.continuationSelected(receipt);
                  if (
                    interrupt && interruption === "first-selected" && !parked &&
                    receipt.evidence.kind === "verified-budget-ceiling-advance"
                  ) {
                    parked = true;
                    reached.resolve();
                    try {
                      await release.promise;
                      try {
                        await handlers.continuationSelected(receipt);
                      } catch {
                        staleRejected = true;
                      }
                      throw new Error(
                        "Interrupted after first durable selection",
                      );
                    } finally {
                      orphanDone.resolve();
                    }
                  }
                },
              });
              return result;
            },
          },
          model: source,
          workBudget: budget,
          artifactSources,
          agents: {
            label:
              "bounded two-draft provider; real PG worker, ledger and saver",
            decide: () => {
              throw new Error("Expected correlated batch decision");
            },
            decideBatch: () => {
              providerCalls++;
              const decisions = providerCalls === 1
                ? [
                  ...["first", "second"].map((name) => ({
                    kind: "propose_tool" as const,
                    text: `Prepare ${name}`,
                    tool: {
                      name: `reader-${name}`,
                      kind: "read_web_page" as const,
                      description: `Read ${name}`,
                      code:
                        `export default ({html}) => ({title:'${name}',text:html})`,
                    },
                  })),
                  ...(interruption === "preselected-reply"
                    ? [{
                      kind: "reply" as const,
                      text: "Both readers admitted",
                    }]
                    : []),
                ]
                : providerCalls === 4
                ? [{ kind: "reply" as const, text: "Both readers admitted" }]
                : [];
              if (!decisions.length) {
                throw new Error("Unexpected repeated batch provider request");
              }
              const calls = decisions.map((decision, index) => ({
                id: `call-${providerCalls}-${index}`,
                decision,
              }));
              return Promise.resolve({
                calls,
                assistantBlocks: calls.map((call) => ({
                  type: "tool_use" as const,
                  id: call.id,
                  name: call.decision.kind,
                  input: structuredClone(call.decision),
                })),
              });
            },
            admit: (candidate) => {
              providerCalls++;
              return Promise.resolve({
                candidateDigest: candidate.digest,
                verdict: "approve" as const,
                reason: "Admit exact prepared draft",
              });
            },
            review: () => {
              throw new Error("Unexpected review");
            },
          },
          information: {
            read: (current) =>
              Promise.resolve({
                memoryGuidance: [],
                modelContext: {
                  version: current.version.repositoryVersion!,
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
                  version: current.version.repositoryVersion!,
                  sources: {},
                },
              }),
            consultModel: (current, input) =>
              Promise.resolve({
                modelVersion: {
                  digest: current.version.digest,
                  repositoryVersion: current.version.repositoryVersion,
                },
                result: { path: input.path },
              }),
            consultAdmittedModelSource: (current, input) =>
              Promise.resolve({
                modelVersion: {
                  digest: current.version.digest,
                  repositoryVersion: current.version.repositoryVersion,
                },
                result: { path: input.path },
              }),
          },
          runner: {
            test: (draft) => {
              tested.push(draft.name);
              return Promise.resolve({
                passed: true,
                checks: [{
                  name: "exact draft",
                  passed: true,
                  detail: draft.name,
                }],
              });
            },
            run: () => {
              throw new Error("Unexpected external tool");
            },
          },
        });
        await runtime.initialize(undefined, {
          resumeContinuations: false,
          resumeCandidateContinuations: false,
        });
        diagnosticRuntime = runtime;
        await session.start(async (delivery) => {
          try {
            await runtime.processAcceptedContribution(delivery);
          } catch (error) {
            observeFailure("worker", error, {
              deliveryId: delivery.id,
              identity: delivery.identity,
            });
            throw error;
          }
        });
        return { session, storage, runtime };
      };
      try {
        let active = await open(true);
        const caseId = await active.runtime.submit(
          "Prepare two readers",
          undefined,
          undefined,
          true,
        );
        assert.ok(caseId, "A new Request must have an exact Case id");
        await active.session.idle(active.runtime, 30000);
        assert.equal(active.runtime.snapshot.error, undefined);
        assert.equal(
          active.runtime.snapshot.budgetSuspension?.reason,
          "exhausted",
        );
        assert.equal(providerCalls, 2);
        assert.equal(publications, 1);
        assert.deepEqual(tested, ["reader-first", "reader-second"]);
        const exhausted = structuredClone(
          active.runtime.snapshot.budgetSuspension!,
        );
        const originalCandidates = active.runtime.snapshot.candidates.map(
          (item) => item.id,
        );
        const suspendedCandidate = active.runtime.snapshot.candidates.find(
          (candidate) => candidate.id === exhausted.candidateId,
        );
        assert.ok(suspendedCandidate?.promotionExecution?.subjectId);
        assert.ok(exhausted.attemptId);
        const originalBatch = structuredClone(
          active.runtime.snapshot.conversationBatches![0],
        );
        const birthPin = structuredClone(
          active.runtime.snapshot.cases!.find((item) => item.id === caseId)!
            .modelPin,
        );
        const originalProofs = active.runtime.snapshot.candidates.map(
          (candidate) => ({
            id: candidate.id,
            digest: candidate.digest,
            tests: structuredClone(candidate.tests),
            preparationEvidence: structuredClone(candidate.preparationEvidence),
          }),
        );
        const priorBudget = (await active.storage.budget.load(caseId))!;
        const priorEffects = await recovery.database.client.executionEffect
          .findMany();
        available = structuredClone(available);
        available.workBudgetPolicy!.limit = 4;
        available.workBudgetPolicy!.revision = 2;
        available.version.digest = "4".repeat(64);
        available.version.repositoryVersion = `commit:${"e".repeat(40)}`;
        versions.set(
          available.version.repositoryVersion,
          structuredClone(available),
        );
        const adoptionInterrupted = interruption === "authorized-intent" ||
          interruption === "policy-cas" ||
          interruption === "canonical-adoption";
        let interruptedTransitionId: string | undefined;
        if (adoptionInterrupted) {
          await assert.rejects(() =>
            active.runtime.adoptModelVersion({
              expectedDigest: available.version.digest,
            }), /Interrupted after/);
          assert.equal(injected, true);
          assert.equal(providerCalls, 2);
          const committed = (await active.storage.state.load())!
            .budgetCeilingTransition!;
          interruptedTransitionId = committed.manifest.id;
          assert.equal(
            committed.phase,
            interruption === "canonical-adoption"
              ? "adopted-continuations-pending"
              : "authorized-intent",
          );
          const atBoundary = (await active.storage.budget.load(caseId))!;
          assert.equal(
            atBoundary.events.filter((event) =>
              event.kind === "policy" &&
              event.ceilingTransitionId === interruptedTransitionId
            ).length,
            interruption === "authorized-intent" ? 0 : 1,
          );
          await active.session.stop();
          active = await open(false);
        }
        await active.runtime.adoptModelVersion({
          expectedDigest: available.version.digest,
        });
        if (interruptedTransitionId) {
          assert.equal(
            active.runtime.snapshot.budgetCeilingTransition?.manifest.id,
            interruptedTransitionId,
          );
        }
        assert.equal(providerCalls, 2);
        await active.runtime.submit(
          "Resume the retained batch",
          undefined,
          caseId,
        );
        let verifyInterruptedReceipt: (() => Promise<void>) | undefined;
        if (!adoptionInterrupted && interruption !== "preselected-reply") {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              reached.promise,
              new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () => reject(new Error("Selection boundary timeout")),
                  30000,
                );
              }),
            ]);
          } finally {
            if (timeout !== undefined) {
              clearTimeout(timeout);
            }
          }
          const transition = (await active.storage.state.load())!
            .budgetCeilingTransition!;
          assert.equal(
            transition.phase,
            interruption === "catalog-receipt"
              ? "complete"
              : "adopted-continuations-pending",
          );
          assert.equal(
            transition.selected.length,
            interruption === "catalog-receipt"
              ? 2
              : interruption === "first-selected"
              ? 1
              : 0,
          );
          assert.equal(transition.manifest.members.length, 2);
          if (interruption !== "catalog-receipt") {
            const messagesBefore = structuredClone(
              active.runtime.snapshot.messages,
            );
            await assert.rejects(
              () =>
                active.runtime.submit(
                  "Unrelated concurrent input",
                  undefined,
                  caseId,
                ),
              // The worker is deliberately parked inside the exact resume;
              // ordinary concurrent-input admission refuses before lineage routing.
              { name: "CaseError", code: "AGENT_BUSY" },
            );
            assert.deepEqual(active.runtime.snapshot.messages, messagesBefore);
          }
          assert.equal(
            providerCalls,
            interruption === "catalog-receipt" ? 3 : 2,
          );
          const durableCatalogEffect = durableCatalogEffectKey
            ? await recovery.database.client.executionEffect.findFirstOrThrow({
              where: { effectKey: durableCatalogEffectKey },
            })
            : undefined;
          if (interruption === "catalog-receipt") {
            assert.equal(durableCatalogEffect?.status, "completed");
            assert.equal(
              JSON.parse(durableCatalogEffect!.resultJson!).modelAdvance.kind,
              "verified-catalog-advance",
            );
          }
          const selectedBefore = await recovery.database.client
            .nativeContinuationReceipt.findMany({
              where: {
                evidenceKind: "verified-budget-ceiling-advance",
                status: "selected",
              },
            });
          assert.equal(
            selectedBefore.length,
            interruption === "catalog-receipt"
              ? 2
              : interruption === "first-selected"
              ? 1
              : 0,
          );
          const intentsBefore = await recovery.database.client
            .nativeContinuationReceipt.findMany({
              where: {
                evidenceKind: "verified-budget-ceiling-advance",
                status: "intent",
              },
            });
          assert.equal(
            intentsBefore.length,
            interruption === "unselected-fork" ? 1 : 0,
          );
          if (intentsBefore.length) {
            await assert.rejects(() =>
              recovery.database.client.nativeContinuationReceipt.update({
                where: {
                  projectId_systemId_executionSpaceId_operatorId_threadId_id: {
                    projectId: intentsBefore[0].projectId,
                    systemId: intentsBefore[0].systemId,
                    executionSpaceId: intentsBefore[0].executionSpaceId,
                    operatorId: intentsBefore[0].operatorId,
                    threadId: intentsBefore[0].threadId,
                    id: intentsBefore[0].id,
                  },
                },
                data: { sourceOccurrenceId: "foreign-occurrence" },
              })
            );
          }
          verifyInterruptedReceipt = async () => {
            if (durableCatalogEffect) {
              assert.deepEqual(
                await recovery.database.client.executionEffect.findFirstOrThrow(
                  { where: { effectKey: durableCatalogEffect.effectKey } },
                ),
                durableCatalogEffect,
              );
            }
            const rows = await recovery.database.client
              .nativeContinuationReceipt.findMany({
                where: {
                  evidenceKind: "verified-budget-ceiling-advance",
                  status: "selected",
                },
              });
            for (const selected of selectedBefore) {
              assert.deepEqual(
                rows.find((item) => item.id === selected.id),
                selected,
              );
            }
            if (intentsBefore.length) {
              assert.ok(rows.some((item) => item.id === intentsBefore[0].id));
            }
          };
          await active.session.kill();
          active = await open(false);
        }
        const deadline = Date.now() + 30000;
        while (
          !active.runtime.snapshot.messages.some((item) =>
            item.text === "Both readers admitted"
          )
        ) {
          if (Date.now() >= deadline) {
            throw new Error(
              `Resumption timeout: ${
                active.runtime.snapshot.error ?? "no reply"
              }`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await active.session.idle(active.runtime, 30000);
        assert.equal(active.runtime.snapshot.error, undefined);
        assert.equal(
          providerCalls,
          interruption === "preselected-reply" ? 3 : 4,
        );
        assert.equal(publications, 2);
        assert.deepEqual(tested, ["reader-first", "reader-second"]);
        assert.deepEqual(
          active.runtime.snapshot.candidates.map((item) => item.id),
          originalCandidates,
        );
        const finalBatch = active.runtime.snapshot.conversationBatches!.find(
          (item) => item.id === originalBatch.id,
        )!;
        assert.equal(finalBatch.modelDigest, originalBatch.modelDigest);
        assert.deepEqual(
          finalBatch.calls.map((call) => call.id),
          originalBatch.calls.map((call) => call.id),
        );
        if (interruption === "preselected-reply") {
          assert.equal(originalBatch.calls.length, 3);
          assert.equal(originalBatch.calls[2].decision.kind, "reply");
          assert.equal(finalBatch.calls[2].status, "completed");
        }
        assert.deepEqual(finalBatch.calls[0], originalBatch.calls[0]);
        assert.deepEqual(
          active.runtime.snapshot.cases!.find((item) => item.id === caseId)!
            .modelPin,
          birthPin,
        );
        assert.deepEqual(
          active.runtime.snapshot.candidates.map((candidate) => ({
            id: candidate.id,
            digest: candidate.digest,
            tests: candidate.tests,
            preparationEvidence: candidate.preparationEvidence,
          })),
          originalProofs,
        );
        assert.equal(
          active.runtime.snapshot.events.filter((event) =>
            event.kind === "effective-model-updated" &&
            event.effectiveModelUpdate?.to.digest === "4".repeat(64)
          ).length,
          1,
        );
        assert.equal(
          active.runtime.snapshot.budgetCeilingTransition?.phase,
          "complete",
        );
        assert.equal(
          active.runtime.snapshot.budgetCeilingTransition?.selected.length,
          2,
        );
        const selectedAfter = await recovery.database.client
          .nativeContinuationReceipt.findMany({
            where: {
              evidenceKind: "verified-budget-ceiling-advance",
              status: "selected",
            },
          });
        assert.equal(selectedAfter.length, 2);
        await verifyInterruptedReceipt?.();
        const transition = active.runtime.snapshot.budgetCeilingTransition!;
        assert.equal(
          model.flows.conversation.executionProfile,
          "operator-command-immutable-group-v1",
        );
        const parent = transition.manifest.members.find((member) =>
          member.identity.purpose === "conversation"
        );
        const child = transition.manifest.members.find((member) =>
          member.identity.purpose === "promotion"
        );
        assert.ok(parent && child);
        assert.notEqual(parent.id, child.id);
        assert.notEqual(parent.threadId, child.threadId);
        assert.equal(parent.identity.subjectId, originalBatch.inputMessageId);
        assert.equal(
          child.identity.subjectId,
          suspendedCandidate.promotionExecution.subjectId,
        );
        assert.equal(child.occurrenceId, exhausted.nodeId);
        assert.equal(
          transition.manifest.budget.refusedAttemptId,
          exhausted.attemptId,
        );
        const nodes = [
          {
            member: parent,
            node: model.flows.conversation.nodes.find((node) =>
              node.id === parent.occurrenceId
            ),
            mechanism: "submit_proposal",
          },
          {
            member: child,
            node: model.flows.promotion.nodes.find((node) =>
              node.id === child.occurrenceId
            ),
            mechanism: "decide_admission",
          },
        ];
        for (const { member, node, mechanism } of nodes) {
          assert.ok(node);
          assert.equal(node.mechanism, mechanism);
          assert.equal(member.sourceKind, "settled-budget-wait");
          const receipts = selectedAfter.filter((receipt) =>
            receipt.threadId === member.threadId
          );
          assert.equal(receipts.length, 1);
          const receipt = receipts[0];
          assert.equal(receipt.sourceKind, member.sourceKind);
          assert.equal(receipt.predecessorRunId, member.runId);
          assert.equal(
            receipt.sourceCheckpointNamespace,
            member.checkpointNamespace,
          );
          assert.equal(receipt.sourceCheckpointId, member.checkpointId);
          assert.equal(receipt.preparedNodeId, member.preparedNodeId);
          assert.equal(receipt.settledEffectKey, member.settledEffectKey);
          assert.equal(receipt.sourceOccurrenceId, member.occurrenceId);
          assert.equal(receipt.sourceNativeActionId, node.nativeId);
          const evidence = JSON.parse(receipt.evidenceJson);
          assert.equal(evidence.memberId, member.id);
          assert.deepEqual(evidence.from, transition.manifest.from);
          assert.deepEqual(evidence.to, transition.manifest.to);
          assert.equal(evidence.budget.refusedAttemptId, exhausted.attemptId);
          const effect = await recovery.database.client.executionEffect
            .findFirstOrThrow({
              where: {
                threadId: member.threadId,
                effectKey: member.settledEffectKey,
              },
            });
          assert.equal(effect.runId, member.runId);
          assert.equal(effect.nodeId, node.nativeId);
          assert.equal(effect.status, "completed");
          const result = JSON.parse(effect.resultJson!);
          assert.equal(result.suspend, true);
          assert.equal(result.suspensionKind, "budget");
        }
        const afterEffects = await recovery.database.client.executionEffect
          .findMany();
        for (const prior of priorEffects) {
          assert.deepEqual(
            afterEffects.find((item) => item.effectKey === prior.effectKey),
            prior,
          );
        }
        const afterBudget = (await active.storage.budget.load(caseId))!;
        assert.deepEqual(
          afterBudget.events.slice(0, priorBudget.events.length),
          priorBudget.events,
        );
        assert.equal(
          budgetState(afterBudget).view.consumed,
          interruption === "preselected-reply" ? 3 : 4,
        );
        assert.equal(budgetState(afterBudget).view.reserved, 0);
        assert.equal(
          afterBudget.events.filter((event) =>
            event.kind === "policy" &&
            event.ceilingTransitionId ===
              active.runtime.snapshot.budgetCeilingTransition!.manifest.id
          ).length,
          1,
        );
        release.resolve();
        if (parked) await orphanDone.promise;
        if (interruption === "first-selected") {
          assert.equal(
            staleRejected,
            true,
            "retired claim cannot write a later canonical callback",
          );
        }
      } catch (error) {
        // Capture before recovery.close() removes the isolated business/framework
        // schemas. Diagnostics never reconcile or relabel an uncertain effect.
        const bounded = (value: unknown, maximum = 24000): unknown => {
          const json = JSON.stringify(value, (_key, entry) =>
            typeof entry === "bigint" ? entry.toString() : entry) ?? "null";
          return json.length <= maximum ? JSON.parse(json) : {
            truncated: true,
            characters: json.length,
            prefix: json.slice(0, maximum),
          };
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const tables = await Promise.race([
            Promise.all([
              recovery.database.client.executionEffect.findMany({
                where: scope,
                take: 100,
                orderBy: { startedAt: "asc" },
              }),
              recovery.database.client.executionRun.findMany({
                where: scope,
                take: 16,
              }),
              recovery.database.client.operatorExecution.findMany({
                where: scope,
                take: 8,
              }),
              recovery.database.client.nativeContinuationReceipt.findMany({
                where: scope,
                take: 16,
              }),
              recovery.database.client.executionContribution.findMany({
                where: scope,
                take: 16,
              }),
              recovery.database.client.runtimeState.findMany({
                where: scope,
                take: 4,
              }),
              recovery.database.client.workBudget.findMany({
                where: scope,
                take: 4,
              }),
            ]),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() =>
                reject(new Error("Diagnostic read deadline")), 5000);
            }),
          ]);
          const effects = tables[0].map((effect) => ({
            ...effect,
            resultJson: effect.resultJson?.slice(0, 4096),
            mechanism: [
              ...model.flows.conversation.nodes,
              ...model.flows.promotion.nodes,
            ]
              .find((node) =>
                node.nativeId === effect.nodeId
              )?.mechanism,
          }));
          const current = diagnosticRuntime?.snapshot;
          const evidence = {
            kind: "budget-two-draft-failure",
            interruption,
            providerCalls,
            publications,
            tested,
            failure: String(error),
            observedFailures,
            runtime: bounded(current),
            frozenWork: bounded({
              activeInputMessageId: current?.activeInputMessageId,
              suspension: current?.budgetSuspension,
              activeBatchCall: current?.activeBatchCall,
              batches: current?.conversationBatches,
              candidates: current?.candidates,
            }, 48000),
            ceilingTransition: bounded(current?.budgetCeilingTransition),
            effects: bounded(effects, 48000),
            runs: bounded(tables[1]),
            executions: bounded(tables[2]),
            continuations: bounded(tables[3]),
            contributions: bounded(tables[4]),
            canonical: bounded(tables[5]),
            budgets: bounded(tables[6]),
          };
          const path = await Deno.makeTempFile({
            prefix: "budget-two-draft-failure-",
            suffix: ".json",
          });
          await Deno.writeTextFile(path, JSON.stringify(evidence, null, 2));
          console.error(
            JSON.stringify({
              kind: evidence.kind,
              interruption,
              path,
              observedFailures,
              effects: effects.filter((effect) =>
                effect.status !== "completed"
              )
                .map((effect) => ({
                  effectKey: effect.effectKey,
                  mechanism: effect.mechanism,
                  nodeId: effect.nodeId,
                  threadId: effect.threadId,
                  runId: effect.runId,
                  contributionId: effect.contributionId,
                  status: effect.status,
                })),
            }),
          );
        } catch (diagnosticError) {
          console.error(
            JSON.stringify({
              kind: "budget-two-draft-diagnostic-failed",
              interruption,
              failure: String(error),
              diagnosticError: String(diagnosticError),
              observedFailures,
            }),
          );
        } finally {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
        }
        throw error;
      } finally {
        release.resolve();
        if (parked) await orphanDone.promise;
        await recovery.close();
      }
    },
  });
}

Deno.test({
  name:
    "PG scalar proposal resumes its exact budget-blocked promotion after session reopen",
  ignore: !postgresTestEnabled,
  async fn() {
    const scope = {
      projectId: "git:scalar-budget",
      systemId: "scalar-budget-host",
    };
    const recovery = await openPostgresDurableRecoveryHost({
      scope,
    });
    const original = executableFixture({
      projectId: scope.projectId,
      editingContextId: "context",
      rootId: "root",
      systemId: "scalar-budget-system",
      catalogId: "catalog",
      builderId: "owner",
    });
    original.version.digest = "5".repeat(64);
    original.version.repositoryVersion = `commit:${"5".repeat(40)}`;
    original.configuration.builder.admissionAuthority = "builder";
    original.mandate.mayAdmitOwnCandidates = true;
    original.workBudgetPolicy = {
      id: "scalar-budget",
      revision: 1,
      unit: "agent-invocation",
      limit: 1,
      onExhausted: "wait",
      exhaustionRecipient: "local-control",
      elementId: "budget-native",
      sourceIds: ["budget-native"],
    };
    const target = structuredClone(original);
    target.version.digest = "6".repeat(64);
    target.version.repositoryVersion = `commit:${"6".repeat(40)}`;
    target.workBudgetPolicy!.limit = 3;
    target.workBudgetPolicy!.revision = 2;
    let available = structuredClone(original),
      decisions = 0,
      admissions = 0,
      publications = 0;
    const versions = new Map([[
      original.version.repositoryVersion!,
      structuredClone(original),
    ], [target.version.repositoryVersion!, structuredClone(target)]]);
    const tested: string[] = [];
    // The retained source double survives session reopen; this witnesses PG native
    // checkpoints and transport, not source persistence across an OS restart.
    const artifactSources =
      (await import("../support/memory-artifact-sources.ts"))
        .createMemoryArtifactSources();
    const source = {
      ...unexpectedModelAuthoring,
      initialize: () => Promise.resolve(structuredClone(original.identity)),
      readExecutableModel: (
        _identity: typeof original.identity,
        version?: string,
      ) => {
        const found = version ? versions.get(version) : available;
        if (!found) throw new Error("Unknown exact source version");
        return Promise.resolve(structuredClone(found));
      },
      graph: () => Promise.resolve({}),
      applyApprovedChange: () => {
        throw new Error("Unexpected model edit");
      },
      activateCandidate: (
        _identity: typeof original.identity,
        candidate: import("../../src/domain/work/candidates.ts").Candidate,
        admittedDigest: string,
      ) => {
        assert.equal(admittedDigest, candidate.activationModelDigest);
        assert.equal(candidate.admission?.candidateDigest, candidate.digest);
        assert.equal(candidate.tests?.passed, true);
        const binding = {
          elementId: `native-${candidate.id}`,
          graphPath: `catalog.${candidate.name}`,
        };
        available.catalog.push({
          nativeId: binding.elementId,
          candidateId: candidate.id,
          contractId: available.contracts.find((item) =>
            item.kind === candidate.kind
          )!.nativeId,
          kind: candidate.kind,
          name: candidate.name,
          digest: candidate.digest,
          status: "active",
        });
        publications++;
        available.version.repositoryVersion = `commit:${"7".repeat(40)}`;
        versions.set(
          available.version.repositoryVersion,
          structuredClone(available),
        );
        return Promise.resolve(binding);
      },
      findCandidate: (
        _identity: typeof original.identity,
        candidate: import("../../src/domain/work/candidates.ts").Candidate,
      ) => {
        const found = available.catalog.find((item) =>
          item.candidateId === candidate.id
        );
        return Promise.resolve(
          found
            ? {
              elementId: found.nativeId,
              graphPath: `catalog.${candidate.name}`,
            }
            : null,
        );
      },
    };
    const open = async () => {
      const session = await recovery.openSession();
      const storage = await session.storage.operator("owner");
      const ports = await session.runtimePortsFor("owner");
      const runtime = new SystemRuntime({
        ...ports,
        model: source,
        workBudget: new WorkBudgetService(storage.budget),
        artifactSources,
        agents: {
          label: "scalar budget PG fixture",
          decide: () => {
            decisions++;
            if (decisions === 1) {
              return Promise.resolve({
                kind: "propose_tool" as const,
                text: "Prepare the reader",
                tool: {
                  name: "reader",
                  kind: "read_web_page" as const,
                  description: "Read a page",
                  code: "export default ({html}) => ({title:'Page',text:html})",
                },
              });
            }
            if (decisions === 2) {
              return Promise.resolve({
                kind: "reply" as const,
                text: "Reader admitted",
              });
            }
            throw new Error("Unexpected repeated scalar decision");
          },
          admit: (candidate) => {
            admissions++;
            return Promise.resolve({
              candidateDigest: candidate.digest,
              verdict: "approve" as const,
              reason: "Admit exact reader",
            });
          },
          review: () => {
            throw new Error("Unexpected review");
          },
        },
        runner: {
          test: (draft) => {
            tested.push(draft.name);
            return Promise.resolve({ passed: true, checks: [] });
          },
          run: () => {
            throw new Error("Unexpected tool execution");
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
      let active = await open();
      await active.runtime.submit("Prepare one reader");
      await active.session.idle(active.runtime, 30000);
      const first = active.runtime.snapshot;
      assert.equal(first.error, undefined);
      assert.equal(first.budgetSuspension?.reason, "exhausted");
      assert.equal(first.budgetSuspension?.operation, "admit");
      assert.equal(first.candidates.length, 1);
      const candidate = structuredClone(first.candidates[0]);
      assert.equal(candidate.id, first.budgetSuspension?.candidateId);
      assert.equal(candidate.batchCall, undefined);
      assert.equal(first.activeBatchCall, undefined);
      assert.deepEqual(tested, ["reader"]);
      assert.equal(decisions, 1);
      assert.equal(admissions, 0);
      const budgetScope = first.workBudgetBinding!.scopeId;
      const before = (await active.storage.budget.load(budgetScope))!;
      assert.equal(budgetState(before).view.consumed, 1);
      const snapshots = await active.session.native.execution.inspect("owner");
      const parent = snapshots.find((item) =>
        item.identity.purpose === "conversation" &&
        item.waits.some((wait) => wait.kind === "budget")
      );
      const child = snapshots.find((item) =>
        item.identity.purpose === "promotion" &&
        item.waits.some((wait) => wait.kind === "budget")
      );
      assert.ok(
        parent?.checkpointId && child?.checkpointId &&
          parent.scalarBudgetProposal,
      );
      assert.equal(parent.waits[0].mechanism, "submit_proposal");
      assert.equal(child.waits[0].mechanism, "decide_admission");
      assert.equal(
        child.identity.subjectId,
        candidate.promotionExecution?.subjectId,
      );
      assert.equal(child.localState?.promotionId, candidate.id);
      await active.session.stop();
      active = await open();
      const reopened = await active.session.native.execution.inspect("owner");
      assert.deepEqual(
        reopened.find((item) => item.threadId === parent.threadId)
          ?.scalarBudgetProposal,
        parent.scalarBudgetProposal,
      );
      available = structuredClone(target);
      await active.runtime.adoptModelVersion({
        expectedDigest: target.version.digest,
      });
      const manifest =
        active.runtime.snapshot.budgetCeilingTransition!.manifest;
      assert.equal(manifest.family.scalarProposal?.candidateId, candidate.id);
      assert.equal(decisions, 1);
      assert.equal(admissions, 0);
      await active.runtime.submit("Resume the retained reader");
      await active.session.idle(active.runtime, 30000);
      assert.equal(active.runtime.snapshot.error, undefined);
      assert.equal(active.runtime.snapshot.budgetSuspension, undefined);
      assert.equal(active.runtime.snapshot.candidates.length, 1);
      assert.equal(active.runtime.snapshot.candidates[0].id, candidate.id);
      assert.equal(active.runtime.snapshot.candidates[0].stage, "active");
      assert.deepEqual(
        active.runtime.snapshot.candidates[0].tests,
        candidate.tests,
      );
      assert.deepEqual(tested, ["reader"]);
      assert.equal(admissions, 1);
      assert.equal(decisions, 2);
      assert.equal(publications, 1);
      const after = (await active.storage.budget.load(budgetScope))!;
      assert.deepEqual(
        after.events.slice(0, before.events.length),
        before.events,
      );
      assert.equal(budgetState(after).view.consumed, 3);
      assert.equal(budgetState(after).view.reserved, 0);
      const receipts = await recovery.database.client.nativeContinuationReceipt
        .findMany({
          where: {
            evidenceKind: "verified-budget-ceiling-advance",
            status: "selected",
          },
        });
      assert.equal(receipts.length, 2);
      for (const snapshot of [parent, child]) {
        const receipt = receipts.find((entry) =>
          entry.threadId === snapshot.threadId
        );
        assert.ok(receipt);
        assert.equal(receipt.predecessorRunId, snapshot.runId);
        assert.equal(receipt.sourceCheckpointId, snapshot.checkpointId);
      }
    } finally {
      await recovery.close();
    }
  },
});
