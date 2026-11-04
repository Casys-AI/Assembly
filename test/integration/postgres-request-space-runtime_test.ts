import { createRequestRuntimeReaders } from "../../src/adapters/out/postgres/request-runtime-readers.ts";
import { createRequestInputAdmissionGuard } from "../../src/adapters/out/postgres/request-input-admission.ts";
import { PostgresRequestExecutionBindingReader } from "../../src/adapters/out/postgres/request-execution-binding.ts";
import { PostgresRequestSourceAdmissionStore } from "../../src/adapters/out/postgres/request-source-admission-store.ts";
/** Real storage/queue/checkpoint/effect witness with controlled exact source ports.
 * Git retention, compilation/source qualification and connected UI are separate.
 */
import assert from "node:assert/strict";
import { RequestSpaceRuntime } from "../../src/application/work/request-spaces/runtime.ts";
import { createPostgresAdmittedRequestRuntime } from "../../src/adapters/out/native-execution/postgres.ts";
import { PostgresHostStorage } from "../../src/adapters/out/postgres/host-storage.ts";
import { postgresClientConfiguration } from "../../src/adapters/out/postgres/config.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import {
  PostgresSpaceAdmissions,
  PostgresSpaceCredentials,
} from "../../src/adapters/out/postgres/request-space-control-store.ts";
import { ModeledSpaceControlAuthority } from "../../src/application/work/request-spaces/space-control-authority.ts";
import { SpaceAdmissions } from "../../src/application/work/request-spaces/control.ts";
import type { OpeningRecord } from "../../src/domain/work/request-spaces/opening.ts";
import type { SpaceExecutionAdmission } from "../../src/domain/work/request-spaces/space-control.ts";
import { conversationPermissions } from "../../src/domain/work/request-spaces/branch-team.ts";
import { requestSpaceDigest } from "../../src/domain/work/request-spaces/scope.ts";
import type { OperatorExecutionDelivery } from "../../src/application/work/operators/execution.ts";
import {
  NativeExecutionAdmissionRefused,
  nativeExecutionIdentity,
} from "../../src/application/work/native-execution/contract.ts";
import { AjvSchemaValidator } from "../../src/infrastructure/ajv-schema-validation.ts";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";
import {
  requestControlBinding,
  requestControlModel,
  requestControlState,
  requestOpeningBase,
  requestSpaceScope as scope,
  spaceControlAuthority,
  spaceUuid,
} from "../support/request-space-fixture.ts";
import { eventually } from "../support/eventually.ts";

Deno.test({
  name:
    "Request factory provisions inert exact A/B births, executes through CAP-3 and replays across handle restoration",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const storage = new PostgresHostStorage(
        postgresClientConfiguration(
          database.connectionString,
          4,
          database.schema,
        ),
      );
      database.registerCleanup(() => storage.close());
      await storage.registerSystem(scope);
      const primary = storage.bindPrimarySpaceControl({
        primaryOperatorId: "operator",
        sourceSystemNativeId: requestControlBinding.sourceSystemNativeId,
      });
      const main = await storage.operator("operator");
      await main.state.save(requestControlState(), null);
      const mainBefore = await main.state.load();
      const openings = new PostgresRequestSpaceStore(storage.client, scope);
      const credentials = new PostgresSpaceCredentials(storage.client, primary);
      const sqlAdmissions = new PostgresSpaceAdmissions(
        storage.client,
        primary,
      );
      const authority = new ModeledSpaceControlAuthority(
        primary,
        requestControlBinding,
      );
      const captured = await authority.capture("owner");
      const capabilityId = spaceUuid(100);
      await credentials.insert({
        id: capabilityId,
        kind: "capability",
        ownerId: "owner",
        parentCapabilityId: null,
        authority: captured.authority,
        secretHash: "b".repeat(64),
        revision: 0,
        status: "active",
        expiresAt: "2099-01-01T00:00:00Z",
        createdAt: "2026-10-29T00:00:00Z",
      }, captured.adoptedState);
      const control = {
        authenticateSession: () => {
          throw new Error("No browser session in factory witness");
        },
        revalidate: () => {
          throw new Error("No control command in factory witness");
        },
      };
      const admissions = new SpaceAdmissions(
        sqlAdmissions,
        credentials,
        authority,
        control,
      );
      const records = new Map<string, OpeningRecord>();
      const admitted = new Map<string, SpaceExecutionAdmission>();
      const models = new Map<string, ReturnType<typeof requestControlModel>>();
      const calls = new Map<string, number>();
      const schemas = {
        queueSchema: `${database.schema}_request_queue`,
        checkpointSchema: `${database.schema}_request_checkpoint`,
      };
      database.registerCleanup(async () => {
        for (const schema of Object.values(schemas)) {
          await database.client.$executeRawUnsafe(
            `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
          );
        }
      });
      const queueErrors: unknown[] = [], workerErrors: unknown[] = [];
      const native = await createPostgresAdmittedRequestRuntime({
        client: storage.client,
        acceptDeliveryInTransaction: createRequestInputAdmissionGuard(
          scope,
          new PostgresRequestExecutionBindingReader(
            storage.client,
            scope,
            new PostgresRequestSourceAdmissionStore(storage.client),
          ),
          sqlAdmissions,
        ),
        scope: { ...scope, executionSpaceId: "main" },
        connectionString: database.connectionString,
        ...schemas,
        onError: (error) => {
          queueErrors.push(error);
        },
        resolveCaseSpace: async (executionSpaceId) => {
          const row = await storage.client.executionSpace.findFirst({
            where: { ...scope, executionSpaceId },
          });
          return row?.lifecycle === "active" && row.caseId &&
              row.parentExecutionSpaceId === "main"
            ? { ...scope, executionSpaceId, caseId: row.caseId }
            : null;
        },
        spaceEffectStart: (tx, input) => {
          const record = records.get(input.scope.executionSpaceId)!;
          const admission = admitted.get(record.id)!;
          return sqlAdmissions.assertEffectStart(tx, {
            executionSpaceId: record.executionSpaceId,
            openingId: record.id,
            admissionId: admission.id,
            expectedRevision: admission.revision,
            act: "conversation",
            operatorId: input.scope.operatorId,
            baseDigest: record.baseDigest!,
            sourceVersion: input.request.model.version.repositoryVersion!,
            modelDigest: input.request.model.version.digest,
          });
        },
      });
      database.registerCleanup(() => native.stop());
      const source = {
        resolve: () => {
          throw new Error("Factory must never resolve main again");
        },
        verify: () => Promise.resolve(),
        readModels: (base: NonNullable<OpeningRecord["base"]>) =>
          Promise.resolve([
            structuredClone(models.get(base.manifest.source!.sourceVersion)!),
          ]),
        readModelsForInspection: (base: NonNullable<OpeningRecord["base"]>) =>
          Promise.resolve([
            structuredClone(models.get(base.manifest.source!.sourceVersion)!),
          ]),
      };
      const branches = {
        ensure: () => {
          throw new Error("Branch creation belongs to durable opening");
        },
        sourceVersion: (record: OpeningRecord) =>
          Promise.resolve(record.base!.manifest.source!.sourceVersion),
        assertRetainedExecutionVersion: () => Promise.resolve(),
        assertVersion: () => Promise.resolve(),
      };
      const makeFactory = () =>
        new RequestSpaceRuntime({
          ...createRequestRuntimeReaders(storage.client),
          onNoticeError: () => {},
          storage,
          native: {
            scope: native.ledger.options.scope,
            forCaseSpace: native.forCaseSpace,
          },
          openings,
          source,
          branches,
          admissions,
          dependencies: (stores, exactModel) => ({
            schemaValidator: new AjvSchemaValidator(),
            clock: { now: () => new Date().toISOString() },
            agents: {
              label: "Controlled provider; real admitted native Request",
              async decide(context) {
                const record = records.get(stores.scope.executionSpaceId)!;
                calls.set(record.id, (calls.get(record.id) ?? 0) + 1);
                const rows = await storage.client.executionEffect.findMany({
                  where: { ...stores.scope, status: "started" },
                });
                assert.equal(
                  rows.length,
                  1,
                  "Provider sees its committed started effect",
                );
                assert.ok(rows[0].authorizationJson);
                const proof = JSON.parse(rows[0].authorizationJson!);
                assert.equal(proof.openingId, record.id);
                assert.equal(proof.admissionId, admitted.get(record.id)!.id);
                assert.deepEqual(context.admittedModelVersion, {
                  digest: exactModel.version.digest,
                  repositoryVersion: exactModel.version.repositoryVersion,
                });
                return {
                  kind: "reply" as const,
                  text: `Exact reply for ${record.caseId}`,
                };
              },
              review() {
                throw new Error("No review");
              },
            },
            runner: {
              test() {
                throw new Error("No tools");
              },
              run() {
                throw new Error("No tools");
              },
            },
          }),
        });
      let factory = makeFactory();
      for (const [index, letter] of ["a", "b"].entries()) {
        const command = {
          openingKey: `runtime-${letter}`,
          text: `Full exact request ${letter}\n${"detail ".repeat(400)}`,
          source: { kind: "current-main" as const },
        };
        let record = await openings.begin({
          ownerId: "owner",
          command,
          commandDigest: await requestSpaceDigest({
            scope,
            ownerId: "owner",
            command,
          }),
        });
        const base = await requestOpeningBase(letter);
        const modelAuthority = spaceControlAuthority();
        modelAuthority.sourceVersion = base.manifest.source!.sourceVersion;
        modelAuthority.modelDigest = letter.repeat(64);
        const model = requestControlModel(modelAuthority);
        model.caseTypes = [{
          id: "request-type",
          name: "Request",
          type: "request",
          envelope: "conversational",
          behaviorId: model.flows.conversation.rootNativeId,
          ownerId: "operator",
          sourceIds: ["request-type"],
        }];
        models.set(model.version.repositoryVersion!, model);
        record = await openings.selectBase({
          id: record.id,
          ownerId: "owner",
          expectedRevision: record.revision,
          base,
          baseDigest: await requestSpaceDigest(base),
        });
        record = await openings.advance({
          id: record.id,
          ownerId: "owner",
          expectedRevision: record.revision,
          from: record.phase,
          to: "branch-ready",
        });
        records.set(record.executionSpaceId, record);
        const jobsBefore = await storage.client.$queryRawUnsafe(
          `SELECT count(*)::int AS count FROM "${schemas.queueSchema}".job`,
        );
        const casesBefore = await storage.client.caseIdentity.count({
          where: scope,
        });
        await Promise.all([
          factory.provision(record),
          factory.provision(record),
          makeFactory().provision(record),
        ]);
        assert.deepEqual(
          await storage.client.$queryRawUnsafe(
            `SELECT count(*)::int AS count FROM "${schemas.queueSchema}".job`,
          ),
          jobsBefore,
        );
        assert.equal(
          await storage.client.caseIdentity.count({ where: scope }),
          casesBefore,
        );
        assert.deepEqual(
          await storage.client.$queryRawUnsafe(
            `SELECT count(*)::int AS count FROM "${schemas.checkpointSchema}".checkpoints`,
          ),
          [{ count: 0 }],
        );
        const stores = await (await storage.caseSpace(
          record.executionSpaceId,
          record.caseId,
        )).operator("operator");
        const born = await stores.state.load();
        assert.equal(born!.revision, 0);
        assert.equal(born!.cases!.length, 1);
        assert.equal(born!.cases![0].number, record.caseNumber);
        assert.equal(born!.cases![0].createdAt, record.createdAt);
        assert.equal(
          born!.cases![0].openedFrom.messageId,
          record.initialContributionId,
        );
        assert.equal(born!.cases![0].openedFrom.openingId, record.id);
        assert.deepEqual(born!.messages, []);
        // Exercise the concrete lifecycle reader against this persisted active
        // space before admission/native execution, without changing the birth.
        assert.equal(born!.cases![0].status, "open");
        assert.equal(
          born!.executionModel!.identity.builderId,
          record.base!.requestOwner.operatorId,
        );
        assert.equal(
          await factory.initialExecutionOutcome(record, {
            ...born!,
            busy: false,
            activeInputMessageId: record.initialContributionId,
            messages: [{
              id: record.initialContributionId,
              role: "user",
              caseId: record.caseId,
              text: record.command.text,
              at: record.createdAt,
            }],
          }),
          undefined,
        );
        assert.equal(
          await storage.client.operatorExecution.count({ where: stores.scope }),
          0,
        );
        assert.equal(
          await storage.client.executionEffect.count({ where: stores.scope }),
          0,
        );
        assert.equal(calls.size, 0);
        await assert.rejects(
          () =>
            factory.provision({ ...record, caseNumber: record.caseNumber + 1 }),
          /differs/,
        );
        record = await openings.advance({
          id: record.id,
          ownerId: "owner",
          expectedRevision: record.revision,
          from: record.phase,
          to: "runtime-ready",
        });
        const admission = await sqlAdmissions.admit({
          id: spaceUuid(101 + index),
          scope,
          executionSpaceId: record.executionSpaceId,
          openingId: record.id,
          ownerId: "owner",
          capabilityId,
          capabilityRevision: 0,
          baseDigest: record.baseDigest!,
          authority: captured.authority,
          permissions: conversationPermissions(base),
          expiresAt: "2099-01-01T00:00:00Z",
        });
        admitted.set(record.id, admission);
        record = await openings.advance({
          id: record.id,
          ownerId: "owner",
          expectedRevision: record.revision,
          from: record.phase,
          to: "admitted",
          admissionId: admission.id,
        });
        records.set(record.executionSpaceId, record);
        await factory.enqueue(record, admission);
        await factory.enqueue(record, admission);
      }
      assert.equal(
        await storage.client.caseIdentity.count({ where: scope }),
        2,
      );
      assert.equal(
        await storage.client.executionRun.count({ where: scope }),
        0,
        "Enqueue alone starts no native execution",
      );
      await native.start(async (delivery, runtimeScope) => {
        try {
          assert.ok(runtimeScope?.caseId);
          await factory.processAcceptedContribution(delivery, runtimeScope!);
        } catch (error) {
          workerErrors.push(error);
          throw error;
        }
      });
      for (const record of records.values()) {
        const view = await native.forCaseSpace(
          record.executionSpaceId,
          record.caseId,
        );
        await eventually(async () => {
          const accepted = await view.dispatch.inspectAccepted(
            "operator",
            record.initialContributionId,
          );
          return accepted?.receipt.status === "completed"
            ? accepted
            : undefined;
        });
        const stores = await (await storage.caseSpace(
          record.executionSpaceId,
          record.caseId,
        )).operator("operator");
        const state = await stores.state.load();
        assert.equal(calls.get(record.id), 1);
        assert.equal(
          state!.messages.filter((message) =>
            message.id === record.initialContributionId
          ).length,
          1,
        );
        const input = state!.messages.find((message) =>
          message.id === record.initialContributionId
        )!;
        assert.equal(input.text, record.command.text);
        assert.equal(input.at, record.createdAt);
        const receipts = await storage.client.executionEffect.findMany({
          where: stores.scope,
          orderBy: { effectKey: "asc" },
        });
        assert.ok(receipts.length > 0);
        assert.ok(receipts.every((row) => row.authorizationJson));
        factory = makeFactory();
        await factory.provision(record);
        assert.deepEqual(await stores.state.load(), state);
        await factory.enqueue(record, admitted.get(record.id)!);
        assert.deepEqual(
          await storage.client.executionEffect.findMany({
            where: stores.scope,
            orderBy: { effectKey: "asc" },
          }),
          receipts,
        );
        assert.equal(calls.get(record.id), 1);
        const accepted = await view.dispatch.inspectAccepted(
          "operator",
          record.initialContributionId,
        );
        const foreign = structuredClone(accepted!.delivery);
        foreign.identity.operatorId = "another-operator";
        await assert.rejects(
          () =>
            factory.processAcceptedContribution(foreign, {
              ...scope,
              executionSpaceId: record.executionSpaceId,
              caseId: record.caseId,
            }),
          /routing is unavailable/,
        );
      }
      assert.deepEqual(await main.state.load(), mainBefore);
      assert.deepEqual(queueErrors, []);
      assert.equal(workerErrors.length, 0);
      const effectsBeforeRevocation = await storage.client.executionEffect
        .findMany({
          where: scope,
          orderBy: [
            { executionSpaceId: "asc" },
            { operatorId: "asc" },
            { threadId: "asc" },
            { effectKey: "asc" },
          ],
        });
      await credentials.revokeCapability(capabilityId, "owner", 0);
      const record = [...records.values()][0];
      await assert.rejects(
        () => factory.enqueue(record, admitted.get(record.id)!),
        /unavailable/,
      );
      const stores =
        await (await storage.caseSpace(record.executionSpaceId, record.caseId))
          .operator("operator");
      const state = (await stores.state.load())!;
      const id = "fresh-after-revocation";
      const denied: OperatorExecutionDelivery = {
        id,
        kind: "contribution",
        identity: nativeExecutionIdentity(state, "conversation", id),
        modelPin: {
          modelDigest: state.executionModel!.version.digest,
          repositoryVersion: state.executionModel!.version.repositoryVersion,
        },
        payload: {
          text: "Must not invoke provider",
          origin: "human",
          invocation: state.caseInvocation,
          receivedAt: new Date().toISOString(),
        },
      };
      const view = await native.forCaseSpace(
        record.executionSpaceId,
        record.caseId,
      );
      await view.dispatch.enqueue(denied);
      const refusedReceipt = await eventually(async () => {
        const receipt = await view.dispatch.inspect(denied.identity, id);
        return receipt?.status === "completed" || receipt?.status === "failed"
          ? receipt
          : undefined;
      });
      native.stopAccepting();
      await native.drain();
      // The existing typed refusal settles transport, while the native snapshot
      // records the refusal rather than a successful execution result.
      assert.equal(refusedReceipt.status, "completed");
      assert.equal(workerErrors.length, 1);
      const refusal = workerErrors[0];
      assert.ok(refusal instanceof NativeExecutionAdmissionRefused);
      assert.equal(refusal.code, "NATIVE_EXECUTION_ADMISSION_REFUSED");
      const refusedRuns = await storage.client.executionRun.findMany({
        where: { ...stores.scope, contributionId: id },
      });
      assert.equal(refusedRuns.length, 1);
      assert.equal(refusedRuns[0].status, "completed");
      assert.equal(refusedRuns[0].threadId, refusedReceipt.threadId);
      const refusedSnapshot = JSON.parse(refusedRuns[0].snapshotJson!);
      assert.equal(refusedSnapshot.status, "refused");
      assert.equal(refusedSnapshot.contributionId, id);
      assert.equal(refusedSnapshot.refusal.code, refusal.code);
      assert.equal(refusedSnapshot.refusal.nodeId, refusal.nodeId);
      const acceptedRefusal = await view.dispatch.inspectAccepted(
        "operator",
        id,
      );
      assert.deepEqual(acceptedRefusal!.delivery, denied);
      assert.deepEqual(acceptedRefusal!.receipt, refusedReceipt);
      assert.equal(
        calls.get(record.id),
        1,
        "Revoked fresh effect cannot reach provider",
      );
      assert.deepEqual(
        await storage.client.executionEffect.findMany({
          where: scope,
          orderBy: [
            { executionSpaceId: "asc" },
            { operatorId: "asc" },
            { threadId: "asc" },
            { effectKey: "asc" },
          ],
        }),
        effectsBeforeRevocation,
        "Revocation refusal creates no receipt and preserves all retained effects",
      );
      assert.deepEqual(await main.state.load(), mainBefore);
      assert.deepEqual(queueErrors, []);
    });
  },
});
