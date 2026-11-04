import assert from "node:assert/strict";
import { Client } from "pg";
import { PostgresProviderCallStore } from "../../src/adapters/out/postgres/provider-call-store.ts";
import { decodePostgresRuntimeState } from "../../src/adapters/out/postgres/runtime-state-snapshot.ts";
import { postgresClientConfiguration } from "../../src/adapters/out/postgres/config.ts";
import {
  type OperatorStorage,
  PostgresHostStorage,
} from "../../src/adapters/out/postgres/host-storage.ts";
import { LangChainAgents } from "../../src/adapters/out/llm-providers/langchain-agents.ts";
import { providerCallContext } from "../../src/adapters/out/llm-providers/provider-call-context.ts";
import { createPostgresNativeRuntime } from "../../src/adapters/out/native-execution/postgres.ts";
import { normalizeProviderCallObservation } from "../../src/application/telemetry/provider-call.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import type { ModelPort } from "../../src/application/work/runtime/ports.ts";
import type { NativeExecutionPort } from "../../src/application/work/native-execution/contract.ts";
import type { OperatorExecutionDispatchPort } from "../../src/application/work/operators/execution.ts";
import { budgetState } from "../../src/domain/work/policies/budget.ts";
import { AjvSchemaValidator } from "../../src/infrastructure/ajv-schema-validation.ts";
import { createClaudeToolsFake } from "../support/claude-tools-fake.ts";
import { executableFixture } from "../support/execution-fixture.ts";
import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import { spaceControlAuthority } from "../support/request-space-fixture.ts";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";

const system = {
  projectId: "git:provider-correlation-fixture",
  systemId: "provider-correlation-host",
};
const operatorId = "same-operator";
type Model = ReturnType<typeof executableFixture>;
type NativeView = {
  execution: NativeExecutionPort;
  dispatch: OperatorExecutionDispatchPort;
};
type Subject = {
  runtime: SystemRuntime;
  stores: OperatorStorage;
  model: Model;
  space: string;
  caseId: string;
  agent: LangChainAgents;
  requests: ReturnType<typeof createClaudeToolsFake>["requests"];
};

function modelFor(letter: string): Model {
  const model = executableFixture({
    projectId: system.projectId,
    editingContextId: "context",
    rootId: "root",
    systemId: "native-system",
    catalogId: "native-catalog",
    builderId: operatorId,
  });
  model.version.digest = letter.repeat(64);
  model.version.repositoryVersion = `commit:${letter.repeat(40)}`;
  model.caseTypes = [{
    id: "fixture-request",
    name: "Request",
    type: "request",
    envelope: "conversational",
    behaviorId: model.flows.conversation.rootNativeId,
    ownerId: operatorId,
    sourceIds: ["fixture-request"],
    maxInvocations: 5,
  }];
  return model;
}

/** This is a controlled infrastructure witness, like shared-native-runtime:
 * compiled model and durable Case metadata are fixtures. Real SystemRuntime,
 * native scalar effects, pg-boss, SDK encoding, budget reservations and provider
 * storage execute unchanged. The effect-start hook supplies controlled authority
 * proof after checking the real Case/model binding; it is not production admission.
 * No native IDs are injected into provider context.
 * It does not qualify production Request admission; the stage witness owns that.
 */
Deno.test({
  name:
    "physical provider calls join actual PostgreSQL native effects and budgets across Main, Case and repeated turns",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const storage = new PostgresHostStorage(postgresClientConfiguration(
        database.connectionString,
        4,
        database.schema,
      ));
      const schemas = {
        queueSchema: `${database.schema}_queue`,
        checkpointSchema: `${database.schema}_checkpoint`,
      };
      database.registerCleanup(async () => {
        const admin = new Client({
          connectionString: database.connectionString,
          connectionTimeoutMillis: 5_000,
        });
        await admin.connect();
        try {
          for (const schema of Object.values(schemas)) {
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          }
        } finally {
          await admin.end();
        }
      });
      let native:
        | Awaited<ReturnType<typeof createPostgresNativeRuntime>>
        | undefined;
      const errors: unknown[] = [];
      const subjects: Subject[] = [];
      // Match production composition: same host client, independent append transaction.
      const sink = new PostgresProviderCallStore(storage.client);
      const caseTransports = new Set<string>();
      const concurrentCases = Promise.withResolvers<void>();
      let activeCaseTransports = 0, maximumCaseTransports = 0;
      const workerFailures: Array<
        { space: string; name: string; code: string | null }
      > = [];
      const errorKind = (error: unknown) => ({
        name: error instanceof Error &&
            /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
          ? error.name
          : "UnknownError",
        code: error !== null && typeof error === "object" && "code" in error &&
            typeof error.code === "string" &&
            /^[A-Z_0-9-]{1,64}$/.test(error.code)
          ? error.code
          : null,
      });
      try {
        await storage.registerSystem(system);
        native = await createPostgresNativeRuntime({
          client: storage.client,
          scope: { ...system, executionSpaceId: "main" },
          connectionString: database.connectionString,
          ...schemas,
          onError: (error) => void errors.push(error),
          spaceEffectStart: async (tx, input) => {
            const subject = subjects.find((item) =>
              item.space === input.scope.executionSpaceId
            );
            assert(subject);
            assert.equal(input.scope.operatorId, operatorId);
            assert.deepEqual(
              input.request.model.version,
              subject.model.version,
            );
            assert.equal(input.request.identity.scope.kind, "request");
            assert.equal(input.request.identity.scope.scopeId, subject.caseId);
            const binding = await tx.executionSpace.findFirstOrThrow({
              where: {
                ...system,
                executionSpaceId: subject.space,
                caseId: subject.caseId,
                lifecycle: "active",
              },
            });
            assert.equal(binding.parentExecutionSpaceId, "main");
            const primary = decodePostgresRuntimeState(
              await tx.runtimeState.findFirstOrThrow({
                where: { ...system, executionSpaceId: "main", operatorId },
              }),
            );
            const authority = spaceControlAuthority();
            authority.scope = { ...system };
            authority.operatorIds = [operatorId];
            authority.sourceVersion = primary.executionModel!.version
              .repositoryVersion!;
            authority.modelDigest = primary.executionModel!.version.digest;
            return {
              scope: { ...system },
              openingId: `controlled-opening:${subject.space}`,
              executionSpaceId: subject.space,
              baseDigest: subject.model.version.digest,
              capabilityId: "controlled-fixture-capability",
              capabilityRevision: 1,
              admissionId: `controlled-admission:${subject.space}`,
              admissionRevision: 1,
              currentAuthority: authority,
              adoptedState: {
                ...system,
                executionSpaceId: "main",
                operatorId,
                stateId: primary.id,
                revision: primary.revision,
              },
              effectiveAuthorityDigest: "controlled-fixture-authority",
            };
          },
          resolveCaseSpace: async (executionSpaceId) => {
            const row = await storage.client.executionSpace.findUnique({
              where: {
                projectId_systemId_executionSpaceId: {
                  ...system,
                  executionSpaceId,
                },
              },
            });
            return row?.lifecycle === "active" && row.caseId &&
                row.parentExecutionSpaceId === "main"
              ? { ...system, executionSpaceId, caseId: row.caseId }
              : null;
          },
        });
        const connect = async (
          space: string,
          model: Model,
          stores: OperatorStorage,
          view: NativeView,
          caseId = "",
        ): Promise<Subject> => {
          const fake = createClaudeToolsFake(async (request) => {
            if (space !== "main" && request.callIndex === 0) {
              caseTransports.add(space);
              activeCaseTransports++;
              maximumCaseTransports = Math.max(
                maximumCaseTransports,
                activeCaseTransports,
              );
              if (caseTransports.size === 2) concurrentCases.resolve();
              let abort: (() => void) | undefined;
              try {
                await Promise.race([
                  concurrentCases.promise,
                  new Promise<never>((_, reject) => {
                    abort = () =>
                      reject(
                        new Error("Controlled concurrency barrier aborted"),
                      );
                    if (request.signal?.aborted) abort();
                    else {request.signal?.addEventListener("abort", abort, {
                        once: true,
                      });}
                  }),
                ]);
              } finally {
                if (abort) request.signal?.removeEventListener("abort", abort);
                activeCaseTransports--;
              }
            }
            if (space === "main" && request.callIndex === 0) {
              return {
                toolUse: {
                  name: "reply",
                  input: {
                    text: "private invalid reply",
                    caseClosure: "invented",
                  },
                },
              };
            }
            // The second Case turn times out through the actual SDK wrapper.
            // Abort-aware transport leaves no pending fake request behind.
            if (space === "case-space-a" && request.callIndex === 1) {
              return new Promise<Response>((_, reject) => {
                const abort = () =>
                  reject(new Error("private transport failure"));
                if (request.signal?.aborted) abort();
                else {request.signal?.addEventListener("abort", abort, {
                    once: true,
                  });}
              });
            }
            return {
              decision: { kind: "reply", text: `Private reply for ${space}` },
              usage: { input_tokens: 12, output_tokens: 3 },
            };
          });
          const agent = new LangChainAgents({
            apiKey: "fixture-key-never-a-real-provider-key",
            model: "sonnet",
            timeoutMs: 5_000,
            fetch: fake.fetch,
            onCompletion: async (observation) => {
              await sink.append(
                system,
                normalizeProviderCallObservation(observation),
              );
            },
          });
          const source: ModelPort = {
            ...unexpectedModelAuthoring,
            initialize: () => Promise.resolve(structuredClone(model.identity)),
            readExecutableModel(identity, version) {
              assert.deepEqual(identity, model.identity);
              if (version !== undefined) {
                assert.equal(version, model.version.repositoryVersion);
              }
              return Promise.resolve(structuredClone(model));
            },
            applyApprovedChange() {
              throw new Error("No source mutation in this witness");
            },
            activateCandidate() {
              throw new Error("No tool activation in this witness");
            },
            graph: () => Promise.resolve({}),
          };
          const runtime = new SystemRuntime({
            store: stores.state,
            stateHistory: stores.state,
            ...view,
            caseNumbers: storage.caseNumbers(),
            clock: { now: () => new Date().toISOString() },
            agents: agent,
            model: source,
            runner: {
              test() {
                throw new Error("No tool test in this witness");
              },
              run() {
                throw new Error("No external effect in this witness");
              },
            },
            schemaValidator: new AjvSchemaValidator(),
            workBudget: new WorkBudgetService(stores.budget),
            // SystemRuntime and ledger enter their own genuine context.
            providerCallContext,
          });
          await runtime.initialize(model, {
            resumeContinuations: false,
            resumeCandidateContinuations: false,
          });
          const subject = {
            runtime,
            stores,
            model,
            space,
            caseId,
            agent,
            requests: fake.requests,
          };
          subjects.push(subject);
          return subject;
        };
        const main = await connect(
          "main",
          modelFor("a"),
          await storage.operator(operatorId),
          native,
        );
        main.caseId = (await main.runtime.submit(
          "Private Main input",
          undefined,
          undefined,
          true,
        ))!;
        assert(main.caseId);
        for (
          const [space, number, letter] of [
            ["case-space-a", 2, "b"],
            ["case-space-b", 3, "c"],
          ] as const
        ) {
          const stateId = `${space}-runtime`,
            caseId = `${stateId}:case:${number}`;
          await storage.client.caseIdentity.create({
            data: { ...system, caseId, number: BigInt(number) },
          });
          await storage.client.executionSpace.create({
            data: {
              ...system,
              executionSpaceId: space,
              caseId,
              parentExecutionSpaceId: "main",
            },
          });
          const caseStores = await (await storage.caseSpace(space, caseId))
            .operator(operatorId);
          await caseStores.state.save({
            id: stateId,
            revision: 0,
            catalogRevision: 0,
            messages: [],
            candidates: [],
            events: [],
            busy: false,
            phase: "Fresh controlled fixture",
            provider: "controlled fixture",
          }, null);
          const subject = await connect(
            space,
            modelFor(letter),
            caseStores,
            await native.forCaseSpace(space, caseId),
            caseId,
          );
          assert.equal(
            await subject.runtime.submit(
              "Private Case input",
              undefined,
              undefined,
              true,
            ),
            caseId,
          );
        }
        const branch = subjects.find((subject) =>
          subject.space === "case-space-a"
        )!;
        await native.start(async (delivery, resolved) => {
          const subject = subjects.find((item) =>
            item.space === resolved?.executionSpaceId
          );
          assert(subject);
          try {
            await subject.runtime.processAcceptedContribution(delivery);
          } catch (error) {
            workerFailures.push({ space: subject.space, ...errorKind(error) });
            throw error;
          }
        });
        const diagnostic = async () => ({
          contributions: await storage.client.executionContribution.findMany({
            where: system,
            select: { executionSpaceId: true, status: true },
          }),
          runs: await storage.client.executionRun.findMany({
            where: system,
            select: { executionSpaceId: true, status: true },
          }),
          effects: await storage.client.executionEffect.groupBy({
            by: ["executionSpaceId", "status"],
            where: system,
            _count: true,
          }),
          errors: errors.map(errorKind),
          workerFailures,
          sdkCalls: subjects.map((subject) => ({
            space: subject.space,
            count: subject.requests.length,
          })),
        });
        const settle = async (completed: number, expectedTimeout = false) => {
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            if (errors.length) {
              throw new Error(
                `Native queue failed: ${JSON.stringify(await diagnostic())}`,
              );
            }
            const rows = await storage.client.executionContribution.findMany({
              where: system,
              select: { executionSpaceId: true, status: true },
            });
            const unexpected = rows.some((row) =>
              ["failed", "uncertain", "refused"].includes(row.status) &&
              !(expectedTimeout && row.executionSpaceId === branch.space &&
                row.status === "uncertain")
            );
            if (
              unexpected ||
              workerFailures.some((failure) =>
                !expectedTimeout || failure.space !== branch.space
              )
            ) {
              throw new Error(
                `Unexpected native terminal failure: ${
                  JSON.stringify(await diagnostic())
                }`,
              );
            }
            const successes = rows.filter((row) =>
              row.status === "completed"
            ).length;
            const uncertain = rows.filter((row) =>
              row.status === "uncertain"
            ).length;
            if (
              successes === completed &&
              uncertain === (expectedTimeout ? 1 : 0) &&
              rows.length === completed + uncertain
            ) return;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error(
            `Native provider witness did not settle: ${
              JSON.stringify(await diagnostic())
            }`,
          );
        };
        await settle(3);
        assert.equal(caseTransports.size, 2);
        assert.equal(
          maximumCaseTransports,
          2,
          "Both same-owner Cases must overlap inside the SDK transport",
        );
        assert.equal(
          main.requests.length,
          2,
          "Schema repair invokes the physical provider twice",
        );
        assert.equal(branch.requests.length, 1);
        await Promise.all([
          main.runtime.submit(
            "Private Main continuation",
            undefined,
            main.caseId,
          ),
          branch.runtime.submit(
            "Private Case timeout",
            undefined,
            branch.caseId,
          ),
        ]);
        // A timed-out scalar callback has an unknown effect and an uncertain
        // contribution; the native ledger intentionally refuses replay.
        await settle(4, true);
        for (const subject of subjects) {
          const flushed = await subject.agent.completionObservation.close();
          assert.equal(flushed.timedOut, false);
          assert.equal(flushed.unconfirmedPending, 0);
          assert.equal(flushed.status.written, subject.requests.length);
          assert(
            Object.values(flushed.status.dropped).every((count) => count === 0),
          );
        }
        const allIds = new Set<string>();
        const allNativeJoins = new Set<string>();
        const allThreads = new Set<string>();
        const allAttempts = new Set<string>();
        for (const subject of subjects) {
          const scope = {
            ...system,
            executionSpaceId: subject.space,
            operatorId,
          };
          const observations = await sink.list({
            ...system,
            executionSpaceId: subject.space,
          });
          const expectedAttempts = subject.space === "case-space-b" ? 1 : 2;
          assert.equal(
            observations.length,
            subject.space === "main" ? 3 : expectedAttempts,
          );
          const threads = await storage.client.operatorExecution.findMany({
            where: scope,
          });
          assert.equal(
            threads.length,
            expectedAttempts,
            "Each accepted input owns its native thread identity",
          );
          for (const thread of threads) {
            assert(!allThreads.has(thread.threadId));
            allThreads.add(thread.threadId);
          }
          const budget = await subject.stores.budget.load(subject.caseId);
          assert(budget);
          assert.equal(budgetState(budget).view.consumed, expectedAttempts);
          assert.equal(budgetState(budget).view.reserved, 0);
          const reservations = budget.events.filter((event) =>
            event.kind === "reserve"
          );
          assert.equal(reservations.length, expectedAttempts);
          for (const reservation of reservations) {
            assert(!allAttempts.has(reservation.attemptId));
            allAttempts.add(reservation.attemptId);
          }
          const localJoins = new Set<string>();
          const attempts = new Set<string>();
          for (const observation of observations) {
            assert(!allIds.has(observation.observationId));
            allIds.add(observation.observationId);
            const correlation = observation.correlation;
            const thread = threads.find((entry) =>
              entry.threadId === correlation.threadId
            );
            assert(
              thread,
              "Provider must join an actual native thread in this execution space",
            );
            assert.deepEqual(correlation.executionScope, {
              ...system,
              executionSpaceId: subject.space,
            });
            assert.equal(correlation.scopeKind, thread.scopeKind);
            assert.equal(correlation.scopeId, thread.scopeId);
            assert.equal(correlation.caseId, thread.rootRequestId);
            assert.equal(correlation.caseId, subject.caseId);
            assert.equal(correlation.operatorId, thread.operatorId);
            assert.equal(correlation.threadId, thread.threadId);
            const effects = await storage.client.executionEffect.findMany({
              where: {
                ...scope,
                threadId: thread.threadId,
                effectKey: correlation.effectId!,
              },
            });
            assert.equal(effects.length, 1);
            const effect = effects[0];
            assert.equal(correlation.runId, effect.runId);
            assert.equal(correlation.nodeId, effect.nodeId);
            assert(
              subject.model.flows.conversation.nodes.some((node) =>
                node.nativeId === effect.nodeId &&
                node.mechanism === "choose_move"
              ),
            );
            const run = await storage.client.executionRun.findFirstOrThrow({
              where: { ...scope, runId: effect.runId },
            });
            const contribution = await storage.client.executionContribution
              .findFirstOrThrow({
                where: { ...scope, contributionId: effect.contributionId! },
              });
            assert.equal(contribution.runId, run.runId);
            assert.equal(run.threadId, thread.threadId);
            if (observation.outcome === "timed-out") {
              assert.equal(effect.status, "unknown");
              assert.equal(effect.completedAt, null);
              assert.equal(run.status, "uncertain");
              assert.equal(contribution.status, "uncertain");
            } else {
              assert.equal(effect.status, "completed");
              assert(effect.completedAt);
              assert.equal(contribution.status, "completed");
            }
            if (subject.space !== "main") {
              assert(effect.authorizationJson);
              const proof = JSON.parse(effect.authorizationJson);
              assert.equal(
                proof.admissionId,
                `controlled-admission:${subject.space}`,
              );
              assert.equal(proof.executionSpaceId, subject.space);
              assert.equal(proof.baseDigest, subject.model.version.digest);
              assert.deepEqual(proof.scope, system);
            }
            const pin = JSON.parse(run.pinJson);
            assert.equal(correlation.modelDigest, pin.version.digest);
            assert.equal(
              correlation.repositoryVersion,
              pin.version.repositoryVersion,
            );
            assert.equal(correlation.modelDigest, subject.model.version.digest);
            const reservation = reservations.find((event) =>
              event.attemptId === correlation.budgetAttemptId
            );
            assert(
              reservation,
              "Provider attempt must join a real persisted reservation",
            );
            assert.equal(correlation.budgetOperation, reservation.operation);
            assert.equal(
              correlation.modelDigest,
              reservation.modelVersion.digest,
            );
            attempts.add(reservation.attemptId);
            const key = `${thread.threadId}:${effect.effectKey}`;
            assert(
              !allNativeJoins.has(key),
              "Other execution space must never reuse this native join",
            );
            localJoins.add(key);
            assert(observation.elapsedMs >= 0);
            const serialized = JSON.stringify(observation);
            for (
              const privateText of ["Private", "private", "fixture-key-never"]
            ) {
              assert(!serialized.includes(privateText));
            }
          }
          assert.equal(
            localJoins.size,
            expectedAttempts,
            "Repeated turn must use a new real native effect",
          );
          assert.equal(
            attempts.size,
            expectedAttempts,
            "Repeated turn must reserve a new budget attempt",
          );
          for (const key of localJoins) allNativeJoins.add(key);
          if (subject.space === "main") {
            assert(
              observations.every((observation) =>
                observation.outcome === "returned"
              ),
            );
            const repaired = observations.filter((observation) =>
              observations.filter((other) =>
                other.correlation.effectId === observation.correlation.effectId
              ).length === 2
            );
            assert.equal(repaired.length, 2);
            assert.notEqual(
              repaired[0].observationId,
              repaired[1].observationId,
            );
            assert.equal(
              repaired[0].correlation.budgetAttemptId,
              repaired[1].correlation.budgetAttemptId,
            );
          } else if (subject.space === branch.space) {
            const timedOut = observations.filter((observation) =>
              observation.outcome === "timed-out"
            );
            assert.equal(timedOut.length, 1);
            assert.equal(timedOut[0].usage, undefined);
            assert(budget.events.some((event) =>
              event.kind === "settle" &&
              event.attemptId === timedOut[0].correlation.budgetAttemptId &&
              event.outcome === "failed"
            ));
          } else {
            assert(observations.every((observation) =>
              observation.outcome === "returned"
            ));
          }
        }
        assert.equal(allIds.size, 6);
        assert.equal(allNativeJoins.size, 5);
        assert.equal(allThreads.size, 5);
        assert.equal(allAttempts.size, 5);
        assert.deepEqual(
          await sink.list({ ...system, executionSpaceId: null }),
          [],
        );
      } finally {
        concurrentCases.resolve();
        for (const subject of subjects) {
          await subject.agent.completionObservation.close();
        }
        try {
          await native?.stop();
        } finally {
          await storage.close();
        }
      }
    });
  },
});
