import assert from "node:assert/strict";
import { Client } from "pg";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createPostgresAdmittedRequestRuntime } from "../../src/adapters/work/runtime/postgres.ts";
import { createRequestInputAdmissionGuard } from "../../src/adapters/out/postgres/request-input-admission.ts";
import { PostgresRequestExecutionBindingReader } from "../../src/adapters/out/postgres/request-execution-binding.ts";
import { PostgresRequestSourceAdmissionStore } from "../../src/adapters/out/postgres/request-source-admission-store.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import {
  createRequestSpaceEffectStartGuard,
  createRequestSpaceResolver,
} from "../../src/adapters/out/postgres/request-space-execution.ts";
import {
  PostgresSpaceAdmissions,
  PostgresSpaceCredentials,
} from "../../src/adapters/out/postgres/request-space-control-store.ts";
import { ModeledSpaceControlAuthority } from "../../src/application/work/request-spaces/space-control-authority.ts";
import { requestSpaceSeed } from "../../src/adapters/work/request-space-runtime.ts";
import {
  type OperatorStorage,
  PostgresHostStorage,
} from "../../src/adapters/out/postgres/host-storage.ts";
import { postgresClientConfiguration } from "../../src/adapters/out/postgres/config.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import type {
  AgentPort,
  ModelPort,
  ToolRunnerPort,
} from "../../src/application/work/runtime/ports.ts";
import type { NativeExecutionPort } from "../../src/application/work/runtime/execution.ts";
import type {
  OperatorExecutionDelivery,
  OperatorExecutionDispatchPort,
} from "../../src/application/work/operators/execution.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import { AjvSchemaValidator } from "../../src/infrastructure/ajv-schema-validation.ts";
import {
  conversationPermissions,
  type OpeningRecord,
  requestSpaceDigest,
  type SpaceExecutionAdmission,
} from "../../src/domain/work/request-spaces.ts";
import {
  requestControlBinding,
  requestControlModel,
  requestOpeningBase,
  requestSpaceScope as system,
  spaceControlAuthority,
  spaceUuid,
} from "../support/request-space-fixture.ts";
import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { eventually } from "../support/eventually.ts";

const operatorId = "operator";
type NativeHost = Awaited<
  ReturnType<typeof createPostgresAdmittedRequestRuntime>
>;
type Model = ReturnType<typeof requestControlModel>;
type View = {
  execution: NativeExecutionPort;
  dispatch: OperatorExecutionDispatchPort;
};
type Subject = {
  runtime: SystemRuntime;
  stores: OperatorStorage;
  view: View;
  model: Model;
  space: string;
  caseId: string;
  number: number;
  input: string;
  reply: string;
};

function immutableModel(letter: string): Model {
  const authority = spaceControlAuthority();
  authority.modelDigest = letter.repeat(64);
  authority.sourceVersion = `commit:${letter.repeat(40)}`;
  const model = requestControlModel(authority);
  model.caseTypes = [{
    id: "request-type",
    name: "Request",
    type: "request",
    envelope: "conversational",
    behaviorId: model.flows.conversation.rootNativeId,
    ownerId: operatorId,
    sourceIds: ["request-type"],
  }];
  return model;
}

Deno.test({
  name:
    "one shared native queue executes real Main A B turns and preserves an unstarted Main job across reopen",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const schemas = {
        queueSchema: `${database.schema}_queue`,
        checkpointSchema: `${database.schema}_checkpoint`,
      };
      database.registerCleanup(async () => {
        const admin = new Client({
          connectionString: database.connectionString,
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
      const providerCalls = new Map<string, number>(),
        workerErrors: unknown[] = [],
        queueErrors: unknown[] = [];
      const requestOpenings = new Map<string, OpeningRecord>(),
        requestAdmissions = new Map<string, SpaceExecutionAdmission>();
      const openHost = async () => {
        const storage = new PostgresHostStorage(
          postgresClientConfiguration(
            database.connectionString,
            4,
            database.schema,
          ),
        );
        let native: NativeHost | undefined;
        try {
          await storage.registerSystem(system);
          const primary = storage.bindPrimarySpaceControl({
            primaryOperatorId: operatorId,
            sourceSystemNativeId: requestControlBinding.sourceSystemNativeId,
          });
          const openings = new PostgresRequestSpaceStore(
            storage.client,
            system,
          );
          const credentials = new PostgresSpaceCredentials(
            storage.client,
            primary,
          );
          const admissions = new PostgresSpaceAdmissions(
            storage.client,
            primary,
          );
          const authority = new ModeledSpaceControlAuthority(
            primary,
            requestControlBinding,
          );
          const journal = new PostgresRequestSourceAdmissionStore(
            storage.client,
          );
          const binding = new PostgresRequestExecutionBindingReader(
            storage.client,
            system,
            journal,
          );
          native = await createPostgresAdmittedRequestRuntime({
            client: storage.client,
            scope: { ...system, executionSpaceId: "main" },
            connectionString: database.connectionString,
            ...schemas,
            onError: (error) => {
              queueErrors.push(error);
            },
            resolveCaseSpace: createRequestSpaceResolver(storage),
            acceptDeliveryInTransaction: createRequestInputAdmissionGuard(
              system,
              binding,
              admissions,
            ),
            spaceEffectStart: createRequestSpaceEffectStartGuard(
              system,
              admissions,
              binding,
              journal,
            ),
          });
          return {
            storage,
            native,
            openings,
            credentials,
            admissions,
            authority,
          };
        } catch (error) {
          try {
            await native?.stop();
          } finally {
            await storage.close();
          }
          throw error;
        }
      };
      const connect = async (
        host: Awaited<ReturnType<typeof openHost>>,
        space: string,
        model: Model,
        stores: OperatorStorage,
        view: View,
        number: number,
        caseId = "",
        opening?: OpeningRecord,
      ): Promise<Subject> => {
        const input = opening?.command.text ?? `Input for ${space}`,
          reply = `Real native reply for ${space}`;
        const agents: AgentPort = {
          label: "controlled reply; real shared PostgreSQL native worker",
          decide(context) {
            const count = (providerCalls.get(space) ?? 0) + 1;
            providerCalls.set(space, count);
            assert.equal(count, 1, `Unexpected provider replay in ${space}`);
            assert.deepEqual(context.admittedModelVersion, {
              digest: model.version.digest,
              repositoryVersion: model.version.repositoryVersion,
            });
            assert.equal(
              context.messages.filter((message) =>
                message.role === "user" && message.text === input
              ).length,
              1,
            );
            assert.equal(
              context.messages.some((message) =>
                message.role === "user" && message.text !== input
              ),
              false,
            );
            return Promise.resolve({ kind: "reply", text: reply });
          },
          review() {
            throw new Error("This infrastructure witness authorizes no review");
          },
        };
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
            throw new Error("No source mutation is authorized");
          },
          activateCandidate() {
            throw new Error("No tool activation is authorized");
          },
          graph: () => Promise.resolve({}),
        };
        const runner: ToolRunnerPort = {
          test() {
            throw new Error("No tool test is authorized");
          },
          run() {
            throw new Error("No external effect is authorized");
          },
        };
        const runtime = new SystemRuntime({
          store: stores.state,
          stateHistory: stores.state,
          ...view,
          caseNumbers: host.storage.caseNumbers(),
          clock: { now: () => new Date().toISOString() },
          agents,
          model: source,
          runner,
          schemaValidator: new AjvSchemaValidator(),
          workBudget: new WorkBudgetService(stores.budget),
        });
        if (opening) {
          await runtime.initializeRequestSpace(
            requestSpaceSeed(opening),
            model,
          );
        } else {
          await runtime.initialize(model, {
            resumeContinuations: false,
            resumeCandidateContinuations: false,
          });
        }
        return {
          runtime,
          stores,
          view,
          model,
          space,
          caseId,
          number,
          input,
          reply,
        };
      };
      const accepted = async (subject: Subject) => {
        const row = await database.client.executionContribution
          .findFirstOrThrow({
            where: { ...system, executionSpaceId: subject.space, operatorId },
          });
        const item = JSON.parse(row.payloadJson) as OperatorExecutionDelivery;
        assert.equal(item.kind, "contribution");
        assert.equal(item.id, row.contributionId);
        assert.equal(item.identity.subjectId, item.id);
        assert.deepEqual(item.identity.scope, {
          kind: "request",
          scopeId: subject.caseId,
          rootRequestId: subject.caseId,
        });
        assert.deepEqual(item.payload?.invocation, {
          kind: "local",
          caseId: subject.caseId,
        });
        assert.equal(item.payload?.text, subject.input);
        assert.equal(item.payload?.origin, "human");
        const opening = requestOpenings.get(subject.space);
        if (opening) {
          const admission = requestAdmissions.get(subject.space);
          assert(admission);
          assert.equal(item.payload?.caseId, opening.caseId);
          assert.equal(item.payload?.newConversation, undefined);
          assert.equal(item.payload?.number, undefined);
          assert.equal(subject.caseId, opening.caseId);
          assert.equal(subject.number, opening.caseNumber);
          assert.equal(subject.input, opening.command.text);
          assert.equal(opening.phase, "admitted");
          assert.equal(opening.admissionId, admission.id);
          const persisted = await database.client.spaceExecutionAdmission
            .findFirstOrThrow({
              where: { ...system, id: admission.id },
            });
          assert.equal(persisted.status, "active");
          assert.equal(persisted.revision, admission.revision);
          assert.equal(persisted.openingId, opening.id);
          assert.equal(persisted.executionSpaceId, subject.space);
          assert.equal(persisted.baseDigest, opening.baseDigest);
          assert.deepEqual(
            JSON.parse(persisted.permissionsJson),
            conversationPermissions(opening.base!),
          );
        } else {
          assert.equal(subject.space, "main");
          assert.equal(item.payload?.newConversation, true);
          assert.equal(item.payload?.number, subject.number);
        }
        assert.deepEqual(item.modelPin, {
          modelDigest: subject.model.version.digest,
          repositoryVersion: subject.model.version.repositoryVersion,
        });
        assert(row.jobId);
        return { row, item, jobId: row.jobId };
      };
      let active: Awaited<ReturnType<typeof openHost>> | undefined;
      try {
        active = await openHost();
        const mainModel = immutableModel("a");
        let main = await connect(
          active,
          "main",
          mainModel,
          await active.storage.operator(operatorId),
          active.native,
          1,
        );
        main.caseId =
          (await main.runtime.submit(main.input, undefined, undefined, true))!;
        assert(main.caseId);
        const original = await accepted(main),
          originalQueue = active.native.ledger.options.queueName;
        assert.equal(original.row.status, "queued");
        assert.equal(providerCalls.size, 0);
        assert.equal(
          await database.client.executionRun.count({ where: system }),
          0,
        );
        // No worker starts in this first host. Preserve the actual accepted DTO,
        // business source/history and original pg-boss job across a full reopen.
        await active.native.stop();
        await active.storage.close();
        active = undefined;
        active = await openHost();
        assert.equal(active.native.ledger.options.queueName, originalQueue);
        main = await connect(
          active,
          "main",
          mainModel,
          await active.storage.operator(operatorId),
          active.native,
          1,
          main.caseId,
        );
        assert.deepEqual((await accepted(main)).item, original.item);
        assert.equal((await accepted(main)).jobId, original.jobId);
        const subjects = new Map<string, Subject>([["main", main]]);
        const captured = await active.authority.capture("owner");
        const capabilityId = spaceUuid(100);
        await active.credentials.insert({
          id: capabilityId,
          kind: "capability",
          ownerId: "owner",
          parentCapabilityId: null,
          authority: captured.authority,
          secretHash: "b".repeat(64),
          revision: 0,
          status: "active",
          expiresAt: "2099-01-01T00:00:00Z",
          createdAt: new Date().toISOString(),
        }, captured.adoptedState);
        const requests: Subject[] = [];
        for (
          const [label, number, letter] of [["space-a", 2, "b"], [
            "space-b",
            3,
            "c",
          ]] as const
        ) {
          // Allocate through the real opening journal and seed the canonical
          // birth before admitting ordinary human input to the existing Case.
          const command = {
            openingKey: label,
            text: `Input for ${label}`,
            source: { kind: "current-main" as const },
          };
          let record: OpeningRecord = await active.openings.begin({
            ownerId: "owner",
            command,
            commandDigest: await requestSpaceDigest({
              scope: system,
              ownerId: "owner",
              command,
            }),
          });
          assert.equal(record.caseNumber, number);
          const base = await requestOpeningBase(letter);
          record = await active.openings.selectBase({
            id: record.id,
            ownerId: record.ownerId,
            expectedRevision: record.revision,
            base,
            baseDigest: await requestSpaceDigest(base),
          });
          record = await active.openings.advance({
            id: record.id,
            ownerId: record.ownerId,
            expectedRevision: record.revision,
            from: record.phase,
            to: "branch-ready",
          });
          const space = record.executionSpaceId, caseId = record.caseId;
          const stores = await (await active.storage.caseSpace(space, caseId))
            .operator(operatorId);
          const view: View = await active.native.forCaseSpace(space, caseId);
          assert.equal(
            (await active.native.forCaseSpace(space, caseId)).execution,
            view.execution,
            "Worker and runtime must reuse the cached ledger/ALS owner",
          );
          const subject = await connect(
            active,
            space,
            immutableModel(letter),
            stores,
            view,
            number,
            caseId,
            record,
          );
          const born = await stores.state.load();
          assert(born);
          assert.deepEqual(born.messages, []);
          assert(born.cases);
          assert.equal(born.cases.length, 1);
          assert.equal(born.cases[0].id, record.caseId);
          assert.equal(born.cases[0].number, record.caseNumber);
          assert.deepEqual(born.cases[0].openedFrom, {
            conversationId: `request:${space}:${operatorId}`,
            openingId: record.id,
            messageId: record.initialContributionId,
          });
          assert.deepEqual(born.cases[0].modelPin, {
            digest: subject.model.version.digest,
            repositoryVersion: subject.model.version.repositoryVersion,
          });
          record = await active.openings.advance({
            id: record.id,
            ownerId: record.ownerId,
            expectedRevision: record.revision,
            from: record.phase,
            to: "runtime-ready",
          });
          await assert.rejects(
            subject.runtime.submit(subject.input, undefined, caseId),
            /admission|binding|unavailable/i,
          );
          assert.equal(
            await database.client.executionContribution.count({
              where: system,
            }),
            requests.length + 1,
            "An inert Request birth confers no input admission",
          );
          const admission = await active.admissions.admit({
            id: spaceUuid(100 + number),
            scope: system,
            executionSpaceId: space,
            openingId: record.id,
            ownerId: record.ownerId,
            capabilityId,
            capabilityRevision: 0,
            baseDigest: record.baseDigest!,
            authority: captured.authority,
            permissions: conversationPermissions(base),
            expiresAt: "2099-01-01T00:00:00Z",
          });
          record = await active.openings.advance({
            id: record.id,
            ownerId: record.ownerId,
            expectedRevision: record.revision,
            from: record.phase,
            to: "admitted",
            admissionId: admission.id,
          });
          requestOpenings.set(space, record);
          requestAdmissions.set(space, admission);
          assert.equal(
            await subject.runtime.submit(subject.input, undefined, caseId),
            caseId,
          );
          subjects.set(space, subject);
          requests.push(subject);
        }
        assert.equal(providerCalls.size, 0);
        const [a, b] = requests;
        const deliveries = new Map<
          string,
          Awaited<ReturnType<typeof accepted>>
        >();
        for (const subject of subjects.values()) {
          deliveries.set(subject.space, await accepted(subject));
        }
        assert.equal(
          (await database.client.caseSequence.findUniqueOrThrow({
            where: { projectId_systemId: system },
          })).lastNumber,
          3n,
        );
        await assert.rejects(
          active.native.forCaseSpace(a.space, b.caseId),
          /unavailable/,
        );
        await assert.rejects(
          active.native.forCaseSpace("foreign", a.caseId),
          /unavailable/,
        );
        const wrongRoot = structuredClone(deliveries.get(a.space)!.item);
        wrongRoot.id = "wrong-root";
        wrongRoot.identity.scope = {
          kind: "request",
          scopeId: a.caseId,
          rootRequestId: b.caseId,
        };
        const wrongScope = structuredClone(deliveries.get(a.space)!.item);
        wrongScope.id = "wrong-scope";
        wrongScope.identity.scope = {
          kind: "request",
          scopeId: b.caseId,
          rootRequestId: a.caseId,
        };
        const contributionsBefore = await database.client.executionContribution
          .count({ where: system });
        for (const invalid of [wrongRoot, wrongScope]) {
          await assert.rejects(a.view.dispatch.enqueue(invalid), /Case/);
          await assert.rejects(
            a.view.dispatch.inspect(invalid.identity, invalid.id),
            /Case/,
          );
        }
        assert.equal(
          await database.client.executionContribution.count({ where: system }),
          contributionsBefore,
        );
        const handled: string[] = [];
        await active.native.start(async (item, scope) => {
          try {
            assert(scope);
            const subject = subjects.get(scope.executionSpaceId);
            assert(subject);
            assert.deepEqual(item, deliveries.get(subject.space)!.item);
            handled.push(`${subject.space}:${item.id}`);
            await subject.runtime.processAcceptedContribution(item);
          } catch (error) {
            workerErrors.push(error);
            throw error;
          }
        });
        const jobs = [...deliveries.values()].map((entry) => entry.jobId);
        await eventually(async () => {
          if (workerErrors.length || queueErrors.length) {
            throw new AggregateError(
              [...workerErrors, ...queueErrors],
              "The actual shared worker failed",
            );
          }
          const completed = await database.client.executionContribution.count({
            where: { ...system, status: "completed" },
          });
          const rows = await database.client.$queryRawUnsafe<
            Array<{ count: bigint }>
          >(
            `SELECT count(*)::bigint AS count FROM "${schemas.queueSchema}".job WHERE name=$1 AND id::text=ANY($2::text[]) AND state::text='completed'`,
            originalQueue,
            jobs,
          );
          return completed === 3 && rows[0].count === 3n ? true : undefined;
        }, { timeoutMs: 45_000 });
        assert.equal(handled.length, 3);
        assert.equal(new Set(handled).size, 3);
        const saver = new PostgresSaver(
          active.native.ledger.options.checkpointPool,
          undefined,
          { schema: schemas.checkpointSchema },
        );
        const threadIds = new Set<string>(), runIds = new Set<string>();
        for (const subject of subjects.values()) {
          const originalAccepted = deliveries.get(subject.space)!;
          const receipt = await subject.view.dispatch.inspect(
            originalAccepted.item.identity,
            originalAccepted.item.id,
          );
          assert(receipt);
          assert.equal(receipt.status, "completed");
          assert.equal(receipt.jobId, originalAccepted.jobId);
          const state = await subject.stores.state.load();
          assert(state);
          assert.equal(state.busy, false);
          assert.equal(state.error, undefined);
          assert(state.cases);
          assert.equal(state.cases.length, 1);
          assert.equal(state.cases[0].id, subject.caseId);
          assert.equal(state.cases[0].number, subject.number);
          assert.equal(
            state.messages.filter((message) =>
              message.role === "user" && message.text === subject.input &&
              message.caseId === subject.caseId
            ).length,
            1,
          );
          assert.equal(
            state.messages.filter((message) =>
              message.role === "assistant" && message.text === subject.reply &&
              message.caseId === subject.caseId
            ).length,
            1,
          );
          assert.equal(
            state.messages.some((message) =>
              message.caseId !== undefined && message.caseId !== subject.caseId
            ),
            false,
          );
          for (const other of subjects.values()) {
            if (other !== subject) {
              assert.equal(
                state.messages.some((message) =>
                  [other.input, other.reply].includes(message.text)
                ),
                false,
              );
            }
          }
          assert.deepEqual(
            state.executionModel?.version,
            subject.model.version,
          );
          assert.equal(providerCalls.get(subject.space), 1);
          const scope = {
            ...system,
            executionSpaceId: subject.space,
            operatorId,
          };
          const contribution = await database.client.executionContribution
            .findFirstOrThrow({
              where: { ...scope, contributionId: originalAccepted.item.id },
            });
          const runs = await database.client.executionRun.findMany({
            where: scope,
          });
          assert.equal(runs.length, 1);
          const run = runs[0];
          const threads = await database.client.operatorExecution.findMany({
            where: scope,
          });
          assert.equal(threads.length, 1);
          const thread = threads[0];
          assert.equal(contribution.status, "completed");
          assert(contribution.completedAt);
          assert.equal(contribution.runId, run.runId);
          assert.equal(run.threadId, originalAccepted.row.threadId);
          assert.equal(thread.threadId, run.threadId);
          assert.equal(thread.currentRunId, run.runId);
          assert.equal(run.jobId, originalAccepted.jobId);
          assert.equal(run.retryCount, 0);
          assert.equal(run.epoch, thread.epoch);
          assert.deepEqual(JSON.parse(run.pinJson), {
            identity: subject.model.identity,
            version: subject.model.version,
            flowRootId: subject.model.flows.conversation.rootNativeId,
            flowOccurrenceId: subject.model.flows.conversation.rootOccurrenceId,
            profile: subject.model.flows.conversation.executionProfile ?? null,
            maxSteps: subject.model.flows.conversation.maxSteps,
          });
          const [snapshot] = await subject.view.execution.inspect(operatorId);
          assert(snapshot);
          assert.equal(snapshot.threadId, run.threadId);
          assert.equal(snapshot.runId, run.runId);
          assert.equal(snapshot.contributionId, contribution.contributionId);
          assert.equal(snapshot.modelDigest, subject.model.version.digest);
          assert.equal(
            snapshot.repositoryVersion,
            subject.model.version.repositoryVersion,
          );
          // A completed reply leaves this real conversational flow waiting for
          // another input; waiting is never relabelled as a fabricated completion.
          assert.equal(snapshot.status, "waiting");
          assert.equal(run.status, snapshot.status);
          assert.equal(thread.status, snapshot.status);
          assert.deepEqual(snapshot.unsettledEffects, []);
          assert.equal(snapshot.checkpointId, run.checkpointId);
          assert(run.checkpointId);
          const effects = await database.client.executionEffect.findMany({
            where: scope,
          });
          assert(effects.length > 0);
          for (const effect of effects) {
            assert.equal(effect.status, "completed");
            assert(effect.completedAt);
            assert.equal(effect.runId, run.runId);
            assert.equal(effect.jobId, originalAccepted.jobId);
            assert.equal(effect.retryCount, 0);
            assert.equal(effect.epoch, run.epoch);
            const opening = requestOpenings.get(subject.space);
            if (opening) {
              const admission = requestAdmissions.get(subject.space);
              assert(admission);
              assert(effect.authorizationJson);
              const proof = JSON.parse(effect.authorizationJson);
              assert.deepEqual(proof.scope, system);
              assert.equal(proof.openingId, opening.id);
              assert.equal(proof.executionSpaceId, subject.space);
              assert.equal(proof.baseDigest, opening.baseDigest);
              assert.equal(proof.admissionId, admission.id);
              assert.equal(proof.admissionRevision, admission.revision);
              assert.equal(proof.capabilityId, capabilityId);
              assert.equal(proof.capabilityRevision, 0);
              assert.deepEqual(proof.currentAuthority, captured.authority);
            }
          }
          const providerNodes = subject.model.flows.conversation.nodes.filter((
            node,
          ) => node.mechanism === "choose_move").map((node) => node.nativeId);
          const providerEffects = effects.filter((effect) =>
            providerNodes.includes(effect.nodeId)
          );
          assert.equal(providerEffects.length, 1);
          assert(
            providerEffects[0].resultJson?.includes(subject.reply),
            "The real provider result must be retained by its completed native effect",
          );
          const tuple = await saver.getTuple({
            configurable: {
              thread_id: run.threadId,
              checkpoint_ns: run.checkpointNamespace,
              checkpoint_id: run.checkpointId,
            },
          });
          assert(tuple);
          assert.equal(tuple.checkpoint.id, run.checkpointId);
          assert.deepEqual(tuple.checkpoint.channel_values.modelPin, {
            identity: subject.model.identity,
            version: subject.model.version,
            rootNativeId: subject.model.flows.conversation.rootNativeId,
            rootOccurrenceId: subject.model.flows.conversation.rootOccurrenceId,
            ...(subject.model.flows.conversation.executionProfile
              ? {
                executionProfile:
                  subject.model.flows.conversation.executionProfile,
              }
              : {}),
          });
          assert.deepEqual(
            tuple.checkpoint.channel_values.executionScope,
            originalAccepted.item.identity.scope,
          );
          assert(run.modelReferenceJson);
          const reference = JSON.parse(run.modelReferenceJson).businessRevision
            .__assemblyRuntimeRevision;
          const historical = await subject.stores.state.loadRevision(
            reference.revision,
          );
          assert(historical);
          assert.equal(reference.systemId, state.id);
          assert.equal(reference.operatorId, operatorId);
          assert.equal(reference.modelDigest, subject.model.version.digest);
          assert.deepEqual(
            historical.executionModel?.version,
            subject.model.version,
          );
          threadIds.add(run.threadId);
          runIds.add(run.runId);
          const replay = await subject.view.dispatch.enqueue(
            originalAccepted.item,
          );
          assert.equal(replay.status, "completed");
          assert.equal(replay.jobId, originalAccepted.jobId);
          assert.equal(providerCalls.get(subject.space), 1);
        }
        assert.equal(threadIds.size, 3);
        assert.equal(runIds.size, 3);
        assert.equal(workerErrors.length, 0);
        assert.equal(queueErrors.length, 0);
        const revisions = await Promise.all(
          [...subjects.values()].map(async (subject) =>
            (await subject.stores.state.load())!.revision
          ),
        );
        const forgedIds = await Promise.all([
          active.native.dispatch.boss.send(originalQueue, {
            runtimeScope: {
              ...system,
              projectId: "foreign",
              executionSpaceId: a.space,
            },
            threadId: "forged",
            delivery: deliveries.get(a.space)!.item,
          }, { singletonKey: "foreign-project" }),
          active.native.dispatch.boss.send(originalQueue, {
            runtimeScope: { ...system, executionSpaceId: a.space },
            threadId: "forged",
            delivery: deliveries.get(b.space)!.item,
          }, { singletonKey: "foreign-case" }),
          active.native.dispatch.boss.send(originalQueue, {
            runtimeScope: { ...system, executionSpaceId: a.space },
            threadId: "forged",
            delivery: wrongScope,
          }, { singletonKey: "contradictory-case" }),
        ]);
        assert(forgedIds.every(Boolean));
        await eventually(async () => {
          const rows = await database.client.$queryRawUnsafe<
            Array<{ count: bigint }>
          >(
            `SELECT count(*)::bigint AS count FROM "${schemas.queueSchema}".job WHERE name=$1 AND id::text=ANY($2::text[]) AND (retry_count>0 OR state::text='failed')`,
            originalQueue,
            forgedIds,
          );
          return rows[0].count === 3n ? true : undefined;
        }, { timeoutMs: 15_000 });
        assert.equal(handled.length, 3);
        assert.equal(workerErrors.length, 0);
        assert.equal(
          await database.client.executionContribution.count({ where: system }),
          3,
        );
        assert.equal(
          await database.client.executionRun.count({ where: system }),
          3,
        );
        assert.equal(
          await database.client.operatorExecution.count({ where: system }),
          3,
        );
        assert.deepEqual(
          await Promise.all(
            [...subjects.values()].map(async (subject) =>
              (await subject.stores.state.load())!.revision
            ),
          ),
          revisions,
        );
        active.native.stopAccepting();
        const stopped = structuredClone(deliveries.get(a.space)!.item);
        stopped.id = "after-stop";
        stopped.identity.subjectId = stopped.id;
        await assert.rejects(
          a.view.dispatch.enqueue(stopped),
          /stopping|closing/,
        );
        assert.equal(
          await database.client.executionContribution.count({ where: system }),
          3,
        );
      } finally {
        if (active) {
          try {
            await active.native.stop();
          } finally {
            await active.storage.close();
          }
        }
      }
    });
  },
});
