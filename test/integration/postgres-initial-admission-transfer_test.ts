import type { NativeExecutionSession } from "../../src/adapters/out/native-execution/conversation.ts";
/** Short PostgreSQL protocol witness. Prisma state/history, pg-boss claims,
 * ledger, official saver, fork, selection and stop/reopen are real. Model
 * compilation, retained source bytes and catalog publication are explicit
 * controlled ports. This does not qualify Toolkit, Git/source retention or the
 * assembled 4.11a path; that qualification belongs to the separate heavy suite. */
import assert from "node:assert/strict";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import type { ModelPort } from "../../src/application/work/runtime/ports.ts";
import type { ModelBinding } from "../../src/domain/work/candidates.ts";
import { isOpenCase } from "../../src/domain/work/entities/cases.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import { budgetState } from "../../src/domain/work/policies/budget.ts";
import { draftDigest } from "../../src/application/work/runtime/values.ts";
import {
  enableCommandFixtureProfile,
  executableFixture,
} from "../support/execution-fixture.ts";
import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import { createMemoryArtifactSources } from "../support/memory-artifact-sources.ts";
import { openPostgresDurableRecoveryHost } from "../support/postgres-runtime-fixture.ts";
import { postgresTestEnabled } from "../support/postgres.ts";

type Phase =
  | "before-fork"
  | "after-fork"
  | "before-selection"
  | "after-selection";
type StopBoundary = Phase | "after-publication-receipt";
const draft = {
  name: "transfer-reader",
  description: "Exact selected bytes supplied by the controlled model port",
  kind: "read_web_page" as const,
  code: "export default ({html}) => ({title:'Page',text:html})",
};

async function scenario(verdict: "approve" | "refuse", phase?: StopBoundary) {
  const scope = {
    projectId: "git:initial-admission-protocol",
    systemId: "initial-admission-protocol-host",
  };
  const original = executableFixture({
    projectId: scope.projectId,
    editingContextId: "context",
    rootId: "root",
    systemId: "initial-admission-system",
    catalogId: "catalog",
    builderId: "owner",
  });
  enableCommandFixtureProfile(original);
  original.version.digest = "1".repeat(64);
  original.version.repositoryVersion = `commit:${"a".repeat(40)}`;
  original.initialTools = [{
    id: "transfer-reader",
    nativeId: "selected-transfer-reader",
    sourceIds: ["controlled-selection"],
    draft: structuredClone(draft),
  }];
  original.workBudgetPolicy = {
    id: "initial-admission-budget",
    revision: 1,
    unit: "agent-invocation",
    limit: 4,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
    elementId: "controlled-budget",
    sourceIds: ["controlled-budget"],
  };
  let available = structuredClone(original);
  const versions = new Map([[
    original.version.repositoryVersion,
    structuredClone(original),
  ]]);
  const bindings = new Map<string, ModelBinding>();
  let tests = 0,
    providerCalls = 0,
    publicationCalls = 0,
    sourcePublications = 0;
  let provenanceChecked = false, fired = false;
  let conflictingTargetChecked = false;
  const conflictingTargetVerified = Promise.withResolvers<void>();
  let staleAttempt: {
    session: NativeExecutionSession;
    threadId: string;
    epoch: bigint;
    retryCount: number;
    signal: AbortSignal;
  } | undefined;
  const parked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const postPublicationFault = new Error(
    "after-controlled-publication-real-effect-receipt",
  );
  const retained = createMemoryArtifactSources();
  // Retained bytes are a controlled external port across native-runtime
  // restarts. Only their immutable references are persisted in PostgreSQL here.
  const artifactSources = {
    ...retained,
    publishTool: async (input: Parameters<typeof retained.publishTool>[0]) => {
      sourcePublications++;
      return await retained.publishTool(input);
    },
  };
  const model: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize: () => Promise.resolve(structuredClone(original.identity)),
    readExecutableModel: (_identity, version) => {
      const found = version ? versions.get(version) : available;
      if (!found) throw new Error("Unknown controlled immutable model pin");
      return Promise.resolve(structuredClone(found));
    },
    graph: () => Promise.resolve({}),
    applyApprovedChange() {
      throw new Error(
        "Unexpected model authoring in the initial admission protocol witness",
      );
    },
    activateCandidate(_identity, candidate, expectedDigest) {
      publicationCalls++;
      assert.equal(expectedDigest, available.version.digest);
      assert.equal(candidate.digest, candidate.admission?.candidateDigest);
      assert.equal(candidate.admissionDecision?.verdict, "approve");
      const previous = bindings.get(candidate.id);
      if (previous) return Promise.resolve(structuredClone(previous));
      const binding = {
        elementId: `controlled-tool:${candidate.id}`,
        graphPath: `controlled-catalog/${candidate.id}`,
      };
      const next = structuredClone(available);
      next.catalog.push({
        nativeId: binding.elementId,
        candidateId: candidate.id,
        contractId: `contract-${candidate.kind}`,
        name: candidate.name,
        kind: candidate.kind,
        digest: candidate.digest,
        status: "active",
      });
      // A catalog-only publication retains the executable contract digest and
      // advances its immutable source version, as required by catalog advance.
      next.version.repositoryVersion = `commit:${"b".repeat(40)}`;
      versions.set(next.version.repositoryVersion, structuredClone(next));
      available = next;
      bindings.set(candidate.id, binding);
      return Promise.resolve(structuredClone(binding));
    },
    findCandidate(_identity, candidate) {
      const entry = available.catalog.find((item) =>
        item.candidateId === candidate.id && item.digest === candidate.digest
      );
      return Promise.resolve(
        entry ? structuredClone(bindings.get(candidate.id) ?? null) : null,
      );
    },
  };
  const fault = async (actual: Phase) => {
    if (actual === phase && !fired) {
      fired = true;
      parked.resolve();
      await release.promise;
    }
  };
  const recovery = await openPostgresDurableRecoveryHost({
    scope,
    initialAdmissionFault: fault,
  });
  const nativeScope = {
    ...scope,
    executionSpaceId: "main",
    operatorId: original.identity.builderId,
  };
  async function open() {
    const session = await recovery.openSession();
    if (phase === "after-publication-receipt" || phase === "after-selection") {
      const createSession = session.native.ledger.createSession.bind(
        session.native.ledger,
      );
      session.native.ledger.createSession = (record) => {
        const native = createSession(record);
        if (
          phase === "after-selection" && !staleAttempt &&
          record.request.initialAdmissionTransfer
        ) {
          staleAttempt = {
            session: native,
            threadId: record.threadId,
            epoch: record.epoch,
            retryCount: record.retryCount,
            signal: record.signal,
          };
        }
        const effect = native.effect.bind(native);
        // The actual fenced SQL effect receipt has committed when this seam
        // throws; the official graph has not saved its next checkpoint yet.
        // Keep the same object so the ledger's WeakMap identity stays exact.
        native.effect = async (key, node, operation, admit) => {
          const result = await effect(key, node, operation, admit);
          if (
            phase === "after-publication-receipt" && !fired &&
            record.request.initialAdmissionTransfer &&
            node.mechanism === "activate_candidate"
          ) {
            fired = true;
            throw postPublicationFault;
          }
          return result;
        };
        return native;
      };
    }
    const storage = await session.storage.operator(original.identity.builderId);
    const ports = await session.runtimePortsFor(original.identity.builderId);
    const runtime = new SystemRuntime({
      ...ports,
      model,
      artifactSources,
      workBudget: new WorkBudgetService(storage.budget),
      execution: {
        inspect: (id) => ports.execution.inspect(id),
        closeScope: (snapshot, closure) =>
          ports.execution.closeScope(snapshot, closure),
        retireAndAdvance: (snapshot, authorization, target) =>
          ports.execution.retireAndAdvance(snapshot, authorization, target),
        async run(request, handlers) {
          if (request.initialAdmissionTransfer && !provenanceChecked) {
            provenanceChecked = true;
            const variants = [
              (copy: typeof request) => {
                copy.initialAdmissionTransfer!.candidateId =
                  "foreign-candidate";
              },
              (copy: typeof request) => {
                copy.initialAdmissionTransfer!.source.checkpointId =
                  "foreign-checkpoint";
              },
              (copy: typeof request) => {
                copy.initialAdmissionTransfer!.target.caseId = "foreign-case";
              },
            ];
            const before = await recovery.database.client.executionEffect.count(
              { where: nativeScope },
            );
            for (const alter of variants) {
              const forged = structuredClone(request);
              alter(forged);
              await assert.rejects(
                () => ports.execution.run(forged, handlers),
                (error: unknown) =>
                  error instanceof Error &&
                  (error as Error & { code?: string }).code ===
                    "INITIAL_ADMISSION_TRANSFER_REFUSED",
              );
              assert.equal(
                await recovery.database.client.executionEffect.count({
                  where: nativeScope,
                }),
                before,
              );
            }
          }
          if (
            phase === "before-fork" && request.initialAdmissionTransfer &&
            !conflictingTargetChecked
          ) {
            conflictingTargetChecked = true;
            // The genuine request reaches its durable intent and remains parked
            // under the live real claim while a second request attempts another
            // target for the SAME decision/key/source. The alternate target was
            // never selected canonically and must not enroll another native run.
            const genuine = ports.execution.run(request, handlers);
            try {
              await parked.promise;
              const before = {
                effects: await recovery.database.client.executionEffect.count({
                  where: nativeScope,
                }),
                runs: await recovery.database.client.executionRun.count({
                  where: nativeScope,
                }),
                threads: await recovery.database.client.operatorExecution.count(
                  { where: nativeScope },
                ),
              };
              const conflicting = structuredClone(request);
              const intent = conflicting.initialAdmissionTransfer!;
              const alternateCaseId = crypto.randomUUID();
              intent.target.caseId = alternateCaseId;
              intent.target.identity.scope = {
                kind: "request",
                scopeId: alternateCaseId,
                rootRequestId: alternateCaseId,
              };
              intent.target.identity.invocationKey = JSON.stringify([
                "local",
                alternateCaseId,
              ]);
              conflicting.identity = structuredClone(intent.target.identity);
              assert.equal(intent.key, request.initialAdmissionTransfer.key);
              assert.deepEqual(
                intent.decision,
                request.initialAdmissionTransfer.decision,
              );
              assert.deepEqual(
                intent.source,
                request.initialAdmissionTransfer.source,
              );
              await assert.rejects(
                () => ports.execution.run(conflicting, handlers),
                (error: unknown) =>
                  error instanceof Error &&
                  (error as Error & { code?: string }).code ===
                    "INITIAL_ADMISSION_TRANSFER_REFUSED",
              );
              assert.equal(
                await recovery.database.client.executionEffect.count({
                  where: nativeScope,
                }),
                before.effects,
              );
              assert.equal(
                await recovery.database.client.executionRun.count({
                  where: nativeScope,
                }),
                before.runs,
              );
              assert.equal(
                await recovery.database.client.operatorExecution.count({
                  where: nativeScope,
                }),
                before.threads,
              );
              assert.equal(
                await recovery.database.client.operatorExecution.count({
                  where: { ...nativeScope, scopeId: alternateCaseId },
                }),
                0,
              );
              assert.equal(publicationCalls, 0);
              conflictingTargetVerified.resolve();
              return await genuine;
            } catch (error) {
              conflictingTargetVerified.reject(error);
              release.resolve();
              await genuine.catch(() => {});
              throw error;
            }
          }
          return await ports.execution.run(request, handlers);
        },
      },
      agents: {
        label: "Controlled no-provider ports; real PostgreSQL native execution",
        decide() {
          providerCalls++;
          throw new Error("Unexpected provider decision");
        },
        review() {
          providerCalls++;
          throw new Error("Unexpected provider review");
        },
        admit() {
          providerCalls++;
          throw new Error("Unexpected provider admission");
        },
      },
      runner: {
        test(actual) {
          tests++;
          // The runner receives the Candidate, including lifecycle metadata.
          // Compare the complete selected draft rather than rejecting that
          // legitimate metadata at this controlled test-port boundary.
          assert.deepEqual({
            name: actual.name,
            description: actual.description,
            kind: actual.kind,
            code: actual.code,
          }, draft);
          return Promise.resolve({
            passed: true,
            checks: [{
              name: "selected bytes",
              passed: true,
              detail: "controlled test port",
            }],
          });
        },
        run() {
          throw new Error("No selected tool execution is authorized");
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
      } catch (error) {
        if (error === postPublicationFault) {
          // The use case's real finally has finished. Park the outer worker
          // callback to inspect B before pg-boss schedules a subsequent attempt.
          parked.resolve();
          await release.promise;
        }
        throw error;
      }
    });
    return { session, storage, runtime };
  }
  let active: Awaited<ReturnType<typeof open>> | undefined;
  try {
    active = await open();
    await active.runtime.prepareInitialTools();
    try {
      await active.session.idle(active.runtime, 30000);
    } catch (error) {
      // Use the independent test client so a blocked worker/store tail cannot
      // block this bounded diagnostic. Never print payloads or saver snapshots.
      const [contributions, runs, effects, threads] = await Promise.all([
        recovery.database.client.executionContribution.findMany({
          where: nativeScope,
          take: 12,
          select: {
            threadId: true,
            contributionId: true,
            kind: true,
            status: true,
          },
        }),
        recovery.database.client.executionRun.findMany({
          where: nativeScope,
          take: 12,
          select: {
            threadId: true,
            runId: true,
            status: true,
            checkpointId: true,
            checkpointNamespace: true,
            predecessorRunId: true,
          },
        }),
        recovery.database.client.executionEffect.findMany({
          where: nativeScope,
          take: 16,
          select: { threadId: true, runId: true, nodeId: true, status: true },
        }),
        recovery.database.client.operatorExecution.findMany({
          where: nativeScope,
          take: 12,
          select: {
            threadId: true,
            scopeKind: true,
            scopeId: true,
            purpose: true,
            status: true,
            currentRunId: true,
            retiredAt: true,
          },
        }),
      ]);
      const state = active.runtime.snapshot;
      throw new Error(
        JSON.stringify({
          stage: "initial-preparation-idle",
          phase: state.phase,
          error: state.error?.slice(0, 400),
          tests,
          sourcePublications,
          providerCalls,
          cases: state.cases?.slice(-6).map((record) => ({
            id: record.id,
            status: record.status,
            origin: record.openedFrom.origin,
          })),
          intentions: Object.values(state.initialToolsPreparations ?? {}).slice(
            -6,
          ).map((intent) => ({
            key: intent.key,
            revision: intent.revision,
            caseId: intent.caseId,
            phase: intent.phase,
            terminalOutcome: intent.terminal?.outcome,
          })),
          recentEvents: state.events.slice(-6).map((event) => ({
            kind: event.kind,
            label: event.label.slice(0, 160),
          })),
          contributions,
          runs,
          effects,
          threads,
        }),
        { cause: error },
      );
    }
    const candidate = active.runtime.snapshot.candidates.find((item) =>
      item.initialToolSeed?.id === "transfer-reader"
    );
    if (!candidate) {
      const state = active.runtime.snapshot;
      const deliveries = await recovery.database.client.executionContribution
        .findMany({
          where: nativeScope,
          select: { status: true, kind: true },
        });
      assert.fail(JSON.stringify({
        stage: "initial-preparation",
        phase: state.phase,
        error: state.error,
        selectedSeedCount: state.executionModel?.initialTools?.length ?? 0,
        tests,
        sourcePublications,
        recentEvents: state.events.slice(-6).map((event) => ({
          kind: event.kind,
          label: event.label,
        })),
        deliveries,
      }));
    }
    assert.equal(active.runtime.snapshot.candidates.length, 1);
    assert.equal(candidate.stage, "awaiting-admission");
    assert.equal(candidate.digest, await draftDigest(draft));
    assert.equal(candidate.tests?.passed, true);
    const oldCase = structuredClone(
      active.runtime.snapshot.cases?.find((item) =>
        item.id === candidate.caseId
      ),
    );
    assert.equal(oldCase?.status, "closed-done");
    const source = (await active.session.native.execution.inspect(
      original.identity.builderId,
    ))
      .find((item) => item.threadId === candidate.promotionExecution?.threadId);
    assert(source?.runId);
    assert.equal(source.status, "waiting");
    assert.equal(source.waits.length, 1);
    assert.equal(source.waits[0].mechanism, "decide_admission");
    assert(source.initialAdmissionSource);
    const originalRun = await recovery.database.client.executionRun
      .findFirstOrThrow({
        where: {
          ...nativeScope,
          threadId: source.threadId,
          runId: source.runId,
        },
        select: {
          snapshotJson: true,
          checkpointId: true,
          checkpointNamespace: true,
          status: true,
        },
      });
    const decision = {
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      verdict,
      reason: "Owner decision on exact selected and tested bytes",
    };
    await active.runtime.decideCandidate(decision);
    if (phase) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          parked.promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Did not reach ${phase}`)),
              30000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (phase === "before-fork") await conflictingTargetVerified.promise;
      await Promise.all([
        active.runtime.decideCandidate(decision),
        active.runtime.decideCandidate(decision),
      ]);
      await assert.rejects(() =>
        active!.runtime.decideCandidate({
          ...decision,
          verdict: verdict === "approve" ? "refuse" : "approve",
        }), /conflicting-decision-command/);
      const mid = await active.storage.state.load();
      const intent = mid?.candidates.find((item) => item.id === candidate.id)
        ?.initialAdmissionTransfer;
      assert(intent);
      const target = mid?.cases?.find((item) =>
        item.id === intent.target.caseId
      );
      assert(target && isOpenCase(target));
      assert.notEqual(intent.source.caseId, intent.target.caseId);
      if (phase === "after-publication-receipt") {
        assert.equal(
          mid!.candidates.find((item) => item.id === candidate.id)!.stage,
          "active",
        );
        assert.notEqual(
          mid!.executionModel!.version.repositoryVersion,
          intent.pin.repositoryVersion,
        );
        const selected = (await active.session.native.execution.inspect(
          original.identity.builderId,
        ))
          .find((snapshot) =>
            snapshot.identity.scope.scopeId === intent.target.caseId
          );
        assert(selected);
        assert.equal(selected.status, "failed");
        assert.equal(selected.unsettledEffects.length, 0);
        const effects = await recovery.database.client.executionEffect.findMany(
          {
            where: { ...nativeScope, threadId: selected.threadId },
            select: { status: true, resultJson: true },
          },
        );
        assert(effects.length > 0);
        assert(effects.every((effect) => effect.status === "completed"));
        assert(
          effects.some((effect) =>
            JSON.parse(effect.resultJson!).modelAdvance?.candidateId ===
              candidate.id
          ),
        );
        assert.equal(publicationCalls, 1);
      }
      assert.equal(
        await recovery.database.client.executionContribution.count({
          where: { ...nativeScope, contributionId: intent.key },
        }),
        1,
      );
      const receipt = await recovery.database.client.$queryRawUnsafe<
        Array<{
          status: string;
          targetCheckpointId: string | null;
        }>
      >(
        `SELECT "status","targetCheckpointId" FROM "${recovery.database.schema}"."InitialAdmissionTransferReceipt" WHERE "id"=$1`,
        intent.key,
      );
      assert.equal(receipt.length, 1);
      assert.equal(
        receipt[0].status,
        phase === "before-fork"
          ? "intent"
          : phase === "after-selection" || phase === "after-publication-receipt"
          ? "selected"
          : "forked",
      );
      assert.equal(!!receipt[0].targetCheckpointId, phase !== "before-fork");
      await active.session.kill();
      release.resolve();
      // Let the orphaned old callback meet the revoked real queue claim before
      // reopening. Its pools remain owned by the recovery host until final close.
      await active.session.native.dispatch.drain(10000);
      active = await open();
    }
    await active.session.idle(active.runtime, 60000);
    const final = active.runtime.snapshot.candidates.find((item) =>
      item.id === candidate.id
    );
    assert(final);
    assert.equal(final.stage, verdict === "approve" ? "active" : "refused");
    assert.equal(final.admissionDecision?.verdict, verdict);
    assert.deepEqual(
      active.runtime.snapshot.cases?.find((item) =>
        item.id === candidate.caseId
      ),
      oldCase,
    );
    assert.equal(active.runtime.snapshot.candidates.length, 1);
    assert.equal(tests, 1);
    assert.equal(sourcePublications, 1);
    assert.equal(providerCalls, 0);
    assert(provenanceChecked);
    assert.equal(publicationCalls, verdict === "approve" ? 1 : 0);
    const intent = final.initialAdmissionTransfer;
    assert(intent);
    const receipts = await recovery.database.client.$queryRawUnsafe<
      Array<{
        status: string;
        sourceThreadId: string;
        targetThreadId: string;
        targetRunId: string;
      }>
    >(
      `SELECT "status","sourceThreadId","targetThreadId","targetRunId" FROM "${recovery.database.schema}"."InitialAdmissionTransferReceipt" WHERE "id"=$1`,
      intent.key,
    );
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, "selected");
    assert.equal(receipts[0].sourceThreadId, source.threadId);
    assert.notEqual(receipts[0].targetThreadId, source.threadId);
    assert.equal(
      active.runtime.snapshot.cases?.filter((item) =>
        item.id === intent.target.caseId
      ).length,
      1,
    );
    assert.equal(
      active.runtime.snapshot.cases?.find((item) =>
        item.id === intent.target.caseId
      )?.status,
      "closed-done",
    );
    assert.equal(active.runtime.snapshot.caseInvocation?.kind, "designer");
    const completed = (await active.session.native.execution.inspect(
      original.identity.builderId,
    ))
      .find((snapshot) =>
        snapshot.identity.scope.scopeId === intent.target.caseId
      );
    assert(completed);
    assert.equal(completed.status, "completed");
    assert.equal(completed.contributionId, intent.contribution.id);
    assert.equal(
      active.runtime.snapshot.events.filter((event) =>
        event.kind === "admission-decided" && event.candidateId === candidate.id
      ).length,
      1,
    );
    assert.equal(
      active.runtime.snapshot.events.filter((event) =>
        event.kind === "tool-admitted" && event.candidateId === candidate.id
      ).length,
      verdict === "approve" ? 1 : 0,
    );
    const unchangedRun = await recovery.database.client.executionRun
      .findFirstOrThrow({
        where: {
          ...nativeScope,
          threadId: source.threadId,
          runId: source.runId,
        },
        select: {
          snapshotJson: true,
          checkpointId: true,
          checkpointNamespace: true,
          status: true,
        },
      });
    assert.deepEqual(unchangedRun, originalRun);
    const budget = await active.storage.budget.load(intent.target.caseId);
    const targetCase = active.runtime.snapshot.cases?.find((record) =>
      record.id === intent.target.caseId
    );
    assert.equal(targetCase?.budget?.scopeId, intent.target.caseId);
    assert.notEqual(targetCase?.budget?.scopeId, oldCase?.budget?.scopeId);
    // No provider operation is dispatched in this scenario. The ledger may be
    // created lazily (for example during restart with B selected); its binding
    // must still name B, and any materialized ledger must remain unconsumed.
    if (budget) {
      const view = budgetState(budget).view;
      assert.equal(view.scopeId, intent.target.caseId);
      assert.equal(view.consumed, 0);
      assert.equal(view.reserved, 0);
    }
    if (phase === "before-fork") assert(conflictingTargetChecked);
    if (phase === "after-selection") {
      assert(staleAttempt);
      const newerOwner = await recovery.database.client.operatorExecution
        .findFirstOrThrow({
          where: { ...nativeScope, threadId: staleAttempt.threadId },
          select: { epoch: true, currentRetry: true, currentRunId: true },
        });
      assert(newerOwner.epoch > staleAttempt.epoch);
      assert(
        newerOwner.currentRetry !== null &&
          newerOwner.currentRetry > staleAttempt.retryCount,
      );
      assert(newerOwner.currentRunId);
      assert(staleAttempt.signal.aborted);
      const beforeStale = await recovery.database.client.executionEffect.count({
        where: nativeScope,
      });
      const publicationsBeforeStale = publicationCalls;
      let staleCallbackCalls = 0;
      const activation = original.flows.promotion.nodes.find((node) =>
        node.mechanism === "activate_candidate"
      );
      assert(activation);
      const old = staleAttempt;
      await assert.rejects(() =>
        old.session.effect(
          `stale-target-callback:${candidate.id}`,
          activation,
          () => {
            staleCallbackCalls++;
            return Promise.resolve({});
          },
        ), (error: unknown) =>
        error === old.signal.reason ||
        error instanceof Error &&
          /STALE_EXECUTION_(CLAIM|EPOCH|CHECKPOINT_POINTER)/.test(
            error.message,
          ));
      assert.equal(staleCallbackCalls, 0);
      assert.equal(
        await recovery.database.client.executionEffect.count({
          where: nativeScope,
        }),
        beforeStale,
      );
      assert.equal(publicationCalls, publicationsBeforeStale);
    }
    const effectsBeforeReplay = await recovery.database.client.executionEffect
      .count({ where: nativeScope });
    const jobsBeforeReplay = await recovery.database.client
      .executionContribution.count({ where: nativeScope });
    await active.runtime.decideCandidate(decision);
    await active.session.idle(active.runtime, 30000);
    assert.equal(
      await recovery.database.client.executionEffect.count({
        where: nativeScope,
      }),
      effectsBeforeReplay,
    );
    assert.equal(
      await recovery.database.client.executionContribution.count({
        where: nativeScope,
      }),
      jobsBeforeReplay,
    );
    assert.equal(tests, 1);
    assert.equal(sourcePublications, 1);
    assert.equal(providerCalls, 0);
    assert.equal(publicationCalls, verdict === "approve" ? 1 : 0);
  } finally {
    release.resolve();
    await recovery.close();
  }
}

for (
  const phase of [
    "before-fork",
    "after-fork",
    "before-selection",
    "after-selection",
  ] as const
) {
  Deno.test({
    name:
      `PG exact initial admission recovers ${phase} with controlled model/source/publication ports` +
      (phase === "before-fork"
        ? " and refuses a concurrent conflicting target"
        : phase === "after-selection"
        ? " and refuses the old callback after claim takeover"
        : ""),
    ignore: !postgresTestEnabled,
    fn: () => scenario("approve", phase),
  });
}
Deno.test({
  name:
    "PG owner refusal consumes the original initial admission wait with controlled source ports",
  ignore: !postgresTestEnabled,
  fn: () => scenario("refuse"),
});
Deno.test({
  name:
    "PG initial admission keeps B open after completed publication effect and drains the native run after restart",
  ignore: !postgresTestEnabled,
  fn: () => scenario("approve", "after-publication-receipt"),
});
