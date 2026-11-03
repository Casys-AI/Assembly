import { PostgresNativeExecutionLedger } from "../../src/adapters/work/runtime/postgres-ledger.ts";
import { PostgresOperatorDispatch } from "../../src/adapters/work/runtime/operator-dispatch.ts";
import { readRequestInitialExecutionOutcome } from "../../src/application/work/request-spaces/initial-execution-outcome.ts";
import { invocationKey } from "../../src/application/work/operators/journal.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { runtimeRevisionReference } from "../../src/application/work/runtime/execution.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import type { NativeExecutionSnapshot } from "../../src/application/work/runtime/execution.ts";
import type { OperatorExecutionDelivery } from "../../src/application/work/operators/execution.ts";
import type { OpeningRecord } from "../../src/domain/work/request-spaces.ts";
/** Actual Prisma/PG readers and persisted codecs; no Toolkit, native engine or provider. */
import assert from "node:assert/strict";
import {
  postgresQualifiedTable,
  Prisma,
  type PrismaClient,
} from "../../src/adapters/out/postgres/client.ts";
import { PostgresHostStorage } from "../../src/adapters/out/postgres/host-storage.ts";
import { postgresClientConfiguration } from "../../src/adapters/out/postgres/config.ts";
import { PostgresSystemStateStore } from "../../src/adapters/out/postgres/system-state-store.ts";
import { readCaseRuntimeState } from "../../src/adapters/out/postgres/case-runtime-state.ts";
import { existingPrimaryControl } from "../../src/adapters/out/postgres/existing-primary-control.ts";
import {
  decodeRuntimeSnapshotPayload,
  encodeRuntimeSnapshotPayload,
  RUNTIME_SNAPSHOT_PREFIX,
} from "../../src/adapters/out/postgres/runtime-snapshot-codec.ts";
import { ModeledSpaceControlAuthority } from "../../src/application/work/request-spaces/space-control-authority.ts";
import { closeCase, openCase } from "../../src/domain/work/entities/cases.ts";
import type { SystemRuntimeState } from "../../src/domain/work/dialogue.ts";
import { RequestSpaceError } from "../../src/domain/work/request-spaces.ts";
import type { PostgresSystemScope } from "../../src/adapters/out/postgres/scope.ts";
import {
  type PostgresTestDatabase,
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";
import {
  requestControlBinding,
  requestControlState,
  requestSpaceScope as scope,
  spaceControlAuthority,
} from "../support/request-space-fixture.ts";

const nativeOwner = "operator";
const at = "2026-10-30T00:00:00.000Z";
const forbidden = (error: unknown) =>
  error instanceof RequestSpaceError && error.code === "FORBIDDEN";

function caseState(caseId: string, executionSpaceId: string, number: number) {
  const seed = requestControlState();
  seed.id = `request:${executionSpaceId}:${nativeOwner}`;
  seed.messages = [{
    id: `input-${caseId}`,
    caseId,
    role: "user",
    at,
    text: `Exact retained history for ${caseId}: 漢字 😀 `.repeat(2_000),
  }];
  seed.cases = [openCase({
    id: caseId,
    number,
    type: "request",
    objective: `Inspect ${caseId}`,
    owner: nativeOwner,
    openedBy: "owner",
    openedFrom: { conversationId: seed.id, messageId: seed.messages[0].id },
    modelPin: {
      digest: seed.executionModel!.version.digest,
      repositoryVersion: seed.executionModel!.version.repositoryVersion,
    },
    createdAt: at,
  })];
  seed.caseInvocation = { kind: "local", caseId };
  // Expected bytes use precisely the representation stored by the JSON codec.
  return JSON.parse(JSON.stringify(seed)) as SystemRuntimeState;
}

async function createCaseScope(
  client: PrismaClient,
  hostScope: PostgresSystemScope,
  caseId: string,
  executionSpaceId: string,
  number: number,
) {
  await client.caseIdentity.create({
    data: { ...hostScope, caseId, number: BigInt(number) },
  });
  await client.executionSpace.create({
    data: {
      ...hostScope,
      executionSpaceId,
      caseId,
      parentExecutionSpaceId: "main",
    },
  });
  const runtimeScope = {
    ...hostScope,
    executionSpaceId,
    operatorId: nativeOwner,
  };
  await client.operatorRuntime.create({ data: runtimeScope });
  return runtimeScope;
}

/** Real statement triggers reject even no-op DML/upserts while a read is observed. */
async function installWriteGuard(database: PostgresTestDatabase) {
  const guard = postgresQualifiedTable(
    database.client,
    "ReaderQualificationGuard",
  );
  const reject = postgresQualifiedTable(
    database.client,
    "reject_request_reader_writes",
  );
  await database.client.$executeRaw(
    Prisma
      .sql`CREATE TABLE ${guard} (id BOOLEAN PRIMARY KEY CHECK (id), enabled BOOLEAN NOT NULL)`,
  );
  await database.client.$executeRaw(
    Prisma.sql`INSERT INTO ${guard} (id, enabled) VALUES (true, false)`,
  );
  // Both identifiers come only from the owned, registered test schema.
  await database.client.$executeRaw(
    Prisma
      .sql`CREATE FUNCTION ${reject}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (SELECT enabled FROM ${guard} WHERE id=true) THEN
        RAISE EXCEPTION 'Request reader attempted DML on %', TG_TABLE_NAME USING ERRCODE='25006';
      END IF;
      RETURN NULL;
    END $$`,
  );
  for (
    const table of [
      "Project",
      "AssemblySystem",
      "ExecutionSpace",
      "OperatorRuntime",
      "CaseIdentity",
      "CaseSequence",
      "RuntimeState",
      "RuntimeRevision",
      "RuntimeProjection",
      "SpaceOpening",
      "SpaceControlCredential",
      "SpaceExecutionAdmission",
      "OperatorExecution",
      "ExecutionContribution",
      "ExecutionRun",
      "ExecutionEffect",
      "ExecutionThreadBinding",
      "ImmutableConsultationGroup",
    ]
  ) {
    await database.client.$executeRaw(
      Prisma
        .sql`CREATE TRIGGER "RequestReadersNoWrites" BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${
        postgresQualifiedTable(database.client, table)
      } FOR EACH STATEMENT EXECUTE FUNCTION ${reject}()`,
    );
  }
}

/** Include tuple identities: an otherwise invisible no-op UPDATE/upsert changes xmin/ctid. */
async function databaseSnapshot(database: PostgresTestDatabase) {
  const rows: Record<string, unknown> = {};
  for (
    const table of [
      "Project",
      "AssemblySystem",
      "ExecutionSpace",
      "OperatorRuntime",
      "CaseIdentity",
      "CaseSequence",
      "RuntimeState",
      "RuntimeRevision",
      "RuntimeProjection",
      "SpaceOpening",
      "SpaceControlCredential",
      "SpaceExecutionAdmission",
      "OperatorExecution",
      "ExecutionContribution",
      "ExecutionRun",
      "ExecutionEffect",
      "ExecutionThreadBinding",
      "ImmutableConsultationGroup",
    ]
  ) {
    rows[table] = await database.client.$queryRaw<
      Array<{ body: string; xmin: string; ctid: string }>
    >(
      Prisma
        .sql`SELECT to_jsonb(t)::text AS body, t.xmin::text AS xmin, t.ctid::text AS ctid FROM ${
        postgresQualifiedTable(database.client, table)
      } AS t ORDER BY body`,
    );
  }
  const relations = await database.client.$queryRaw<
    Array<
      {
        oid: string;
        name: string;
        kind: string;
        storage: string;
        columns: number;
      }
    >
  >(
    Prisma
      .sql`SELECT c.oid::text AS oid, c.relname AS name, c.relkind::text AS kind, c.relfilenode::text AS storage, c.relnatts::int AS columns FROM pg_class AS c JOIN pg_namespace AS n ON n.oid=c.relnamespace WHERE n.nspname=${database.schema} ORDER BY c.relname, c.relkind`,
  );
  return { rows, relations };
}

async function withoutWrites<T>(
  database: PostgresTestDatabase,
  label: string,
  read: () => Promise<T>,
): Promise<T> {
  const guard = postgresQualifiedTable(
    database.client,
    "ReaderQualificationGuard",
  );
  await database.client.$executeRaw(
    Prisma.sql`UPDATE ${guard} SET enabled=true WHERE id=true`,
  );
  try {
    const before = await databaseSnapshot(database);
    const result = await read();
    assert.deepEqual(await databaseSnapshot(database), before, label);
    return result;
  } finally {
    await database.client.$executeRaw(
      Prisma.sql`UPDATE ${guard} SET enabled=false WHERE id=true`,
    );
  }
}

/** Exact native receipt fixture only: no queue, worker, saver or native graph starts. */
async function seedInitialRefusal(
  database: PostgresTestDatabase,
  state: SystemRuntimeState,
  runtimeScope: PostgresSystemScope & {
    executionSpaceId: string;
    operatorId: string;
  },
  caseId: string,
) {
  const { client } = database;
  const input = state.activeInputMessageId!;
  const model = state.executionModel!;
  const flow = model.flows.conversation;
  const identity: OperatorExecutionDelivery["identity"] = {
    operatorId: nativeOwner,
    invocationKey: invocationKey({ kind: "local", caseId }),
    scope: { kind: "request", scopeId: caseId, rootRequestId: caseId },
    purpose: "conversation",
    subjectId: input,
  };
  for (
    const [threadId, contributionId] of [["reader-exact-thread", input], [
      "reader-unrelated-thread",
      "unrelated-input",
    ]]
  ) {
    const delivery: OperatorExecutionDelivery = {
      id: contributionId,
      kind: "contribution",
      identity: { ...identity, subjectId: contributionId },
      modelPin: {
        modelDigest: state.executionModel!.version.digest,
        repositoryVersion: state.executionModel!.version.repositoryVersion,
      },
    };
    const runId = `run-${threadId}`;
    const jobId = crypto.randomUUID();
    const namespace = `run:${runId}`;
    const contribution = {
      id: contributionId,
      kind: "input" as const,
      inputMessageId: contributionId,
    };
    // Match the ledger's immutablePin/native run-source wire formats. Only the
    // unrelated row intentionally has an invalid pin, proving exact selection.
    const pin = threadId === "reader-exact-thread"
      ? canonical({
        identity: model.identity,
        version: model.version,
        flowRootId: flow.rootNativeId,
        flowOccurrenceId: flow.rootOccurrenceId,
        profile: flow.executionProfile ?? null,
        maxSteps: 32,
      })
      : "CORRUPT_UNRELATED_PIN_MUST_NOT_BE_READ";
    const requestDigest = await executionDigest({
      identity: delivery.identity,
      contribution,
      pin,
    });
    const snapshot: NativeExecutionSnapshot = {
      identity: delivery.identity,
      threadId,
      contributionId,
      repositoryVersion: state.executionModel!.version.repositoryVersion,
      modelDigest: state.executionModel!.version.digest,
      flowRootId: flow.rootNativeId,
      status: "refused",
      refusal: {
        code: "NATIVE_EXECUTION_ADMISSION_REFUSED",
        nodeId: "PRIVATE_NODE",
        message: "PRIVATE_DIAGNOSTIC",
      },
      waits: [],
      unsettledEffects: [],
      pendingContributions: [],
    };
    await client.operatorExecution.create({
      data: {
        ...runtimeScope,
        threadId,
        identityJson: canonical(delivery.identity),
        scopeKind: "request",
        scopeId: caseId,
        rootRequestId: caseId,
        purpose: "conversation",
        subjectId: contributionId,
        // First claimed run advances epoch 0 -> 1; start and refusal each
        // advance the thread revision. A refused run is durably completed.
        status: "completed",
        revision: 2n,
        epoch: 1n,
        currentJobId: jobId,
        currentRetry: 0,
        checkpointNamespace: namespace,
        createdAt: new Date(at),
        updatedAt: new Date(at),
      },
    });
    await client.executionThreadBinding.create({
      data: {
        ...runtimeScope,
        identityDigest: await executionDigest(delivery.identity),
        identityJson: canonical(delivery.identity),
        activeThreadId: threadId,
        revision: 0n,
        createdAt: new Date(at),
        updatedAt: new Date(at),
      },
    });
    await client.executionContribution.create({
      data: {
        ...runtimeScope,
        threadId,
        contributionId,
        digest: await executionDigest(delivery),
        kind: "contribution",
        originJson: canonical({ delivery }),
        payloadJson: canonical(delivery),
        jobId,
        status: "completed",
        acceptedAt: new Date(at),
        completedAt: new Date(at),
      },
    });
    await client.executionRun.create({
      data: {
        ...runtimeScope,
        threadId,
        runId,
        contributionId,
        // SQL ExecutionRun_counter_check and the first-claim writer both start
        // run generation/epoch at 1, independently of zero-based retries.
        generation: 1n,
        pinJson: pin,
        modelReferenceJson: canonical({
          businessRevision: runtimeRevisionReference(state),
          contribution,
        }),
        status: "completed",
        checkpointNamespace: namespace,
        epoch: 1n,
        jobId,
        retryCount: 0,
        snapshotJson: canonical(snapshot),
        errorJson: canonical(snapshot.refusal),
        createdAt: new Date(at),
        updatedAt: new Date(at),
      },
    });
    await client.operatorExecution.update({
      where: {
        projectId_systemId_executionSpaceId_operatorId_threadId: {
          ...runtimeScope,
          threadId,
        },
      },
      data: { currentRunId: runId },
    });
    // Complete the same run/request binding persisted by the native writer;
    // both nullable fields must be filled together (receipt CHECK/FK).
    await client.executionContribution.update({
      where: {
        projectId_systemId_executionSpaceId_operatorId_threadId_contributionId:
          {
            ...runtimeScope,
            threadId,
            contributionId,
          },
      },
      data: { runId, requestDigest },
    });
  }
  const ledger = new PostgresNativeExecutionLedger({
    client,
    scope: runtimeScope,
    queueName: "reader-only",
    queueSchema: database.schema,
    checkpointSchema: database.schema,
    checkpointPool: undefined as never,
  });
  const dispatch = new PostgresOperatorDispatch(ledger, undefined as never);
  const record = {
    scope: {
      projectId: runtimeScope.projectId,
      systemId: runtimeScope.systemId,
    },
    caseId,
    executionSpaceId: runtimeScope.executionSpaceId,
    initialContributionId: input,
    base: { requestOwner: { operatorId: nativeOwner } },
  } as unknown as OpeningRecord;
  const native = {
    forCaseSpace: (executionSpaceId: string, selectedCaseId: string) => {
      assert.equal(executionSpaceId, runtimeScope.executionSpaceId);
      assert.equal(selectedCaseId, caseId);
      return Promise.resolve({
        scope: { ...runtimeScope, caseId },
        execution: ledger,
        dispatch,
      });
    },
  };
  return { native, record, ledger };
}

Deno.test({
  name:
    "PG Request readers preserve exact active/closed history and bind current PRIMARY without writes",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const { client } = database;
      const storage = new PostgresHostStorage(
        postgresClientConfiguration(
          database.connectionString,
          2,
          database.schema,
        ),
      );
      database.registerCleanup(() => storage.close());
      await storage.registerSystem(scope);
      storage.bindPrimarySpaceControl({
        primaryOperatorId: nativeOwner,
        sourceSystemNativeId: requestControlBinding.sourceSystemNativeId,
      });
      const main = await storage.operator(nativeOwner);
      await main.state.save(requestControlState(), null);
      const mainScope = {
        ...scope,
        executionSpaceId: "main",
        operatorId: nativeOwner,
      };

      const caseId = "case-reader", executionSpaceId = "space-reader";
      const caseScope = await createCaseScope(
        client,
        scope,
        caseId,
        executionSpaceId,
        1,
      );
      const store = await PostgresSystemStateStore.open(client, caseScope);
      database.registerCleanup(() => store.close());
      const active = caseState(caseId, executionSpaceId, 1);
      active.activeInputMessageId = active.messages[0].id;
      await store.save(active, null);
      const initialRefusal = await seedInitialRefusal(
        database,
        active,
        caseScope,
        caseId,
      );
      // Historical space closure and Case lifecycle are independent facts.
      const closedScope = await createCaseScope(
        client,
        scope,
        "closed-space-open-case",
        "closed-historical-space",
        99,
      );
      const closedSpaceStore = await PostgresSystemStateStore.open(
        client,
        closedScope,
      );
      database.registerCleanup(() => closedSpaceStore.close());
      const closedSpaceState = caseState(
        "closed-space-open-case",
        "closed-historical-space",
        99,
      );
      closedSpaceState.activeInputMessageId = closedSpaceState.messages[0].id;
      await closedSpaceStore.save(closedSpaceState, null);
      await client.executionSpace.update({
        where: {
          projectId_systemId_executionSpaceId: {
            ...scope,
            executionSpaceId: closedScope.executionSpaceId,
          },
        },
        data: { lifecycle: "closed", closedAt: new Date(at) },
      });
      const current = await client.runtimeState.findFirstOrThrow({
        where: caseScope,
      });
      assert.ok(current.payload.startsWith(RUNTIME_SNAPSHOT_PREFIX));
      assert.equal(
        decodeRuntimeSnapshotPayload(current.payload),
        JSON.stringify(active),
      );
      await installWriteGuard(database);
      await withoutWrites(
        database,
        "active history read must not allocate or update any state",
        async () => {
          // Negative control: the actual database guard rejects even a no-op write.
          await assert.rejects(() =>
            client.operatorRuntime.updateMany({
              where: mainScope,
              data: { operatorId: nativeOwner },
            }), /Request reader attempted DML/);
          const read = await readCaseRuntimeState(
            client,
            scope,
            executionSpaceId,
            caseId,
            nativeOwner,
          );
          assert.ok(read, "The retained Case state exists");
          assert.deepEqual(read, active);
          read.messages[0].text = "caller mutation";
          assert.deepEqual(
            await storage.readCaseRuntimeState(
              executionSpaceId,
              caseId,
              nativeOwner,
            ),
            active,
          );
        },
      );

      await withoutWrites(
        database,
        "exact native initial refusal projection is bounded and read-only",
        async () => {
          const retained = await storage.readCaseRuntimeState(
            executionSpaceId,
            caseId,
            nativeOwner,
          );
          assert.ok(retained);
          assert.equal(
            await readRequestInitialExecutionOutcome(
              initialRefusal.native,
              initialRefusal.record,
              retained,
            ),
            "refused",
          );
          assert.equal(retained.cases![0].status, "open");
          assert.equal(retained.messages.length, 1);
          const historical = await storage.readCaseRuntimeState(
            closedScope.executionSpaceId,
            "closed-space-open-case",
            nativeOwner,
          );
          assert.ok(historical);
          assert.equal(historical.cases![0].status, "open");
          let forbiddenNativeReads = 0;
          const historicalRecord = {
            ...initialRefusal.record,
            caseId: "closed-space-open-case",
            executionSpaceId: closedScope.executionSpaceId,
            initialContributionId: historical.activeInputMessageId!,
          };
          assert.equal(
            await readRequestInitialExecutionOutcome(
              {
                forCaseSpace: () => {
                  forbiddenNativeReads++;
                  throw new Error("Case execution space is unavailable");
                },
              },
              historicalRecord,
              historical,
              async () => {
                const space = await client.executionSpace.findUniqueOrThrow({
                  where: {
                    projectId_systemId_executionSpaceId: {
                      ...scope,
                      executionSpaceId: closedScope.executionSpaceId,
                    },
                  },
                });
                assert.equal(space.caseId, historicalRecord.caseId);
                return space.lifecycle as "active" | "closed";
              },
            ),
            undefined,
          );
          assert.equal(
            forbiddenNativeReads,
            0,
            "closed historical space must not enter an execution view",
          );
          assert.deepEqual(
            await initialRefusal.ledger.inspect(nativeOwner, {
              threadId: "reader-exact-thread",
              contributionId: "other",
            }),
            [],
          );
          // Unrelated malformed retained pins cannot contaminate an exact read.
          await assert.rejects(
            () => initialRefusal.ledger.inspect(nativeOwner),
            /JSON|Unexpected|invalid/i,
          );
        },
      );

      const closed = structuredClone(active);
      closed.revision++;
      closed.cases![0] = closeCase(
        closed.cases![0],
        "done",
        "2026-10-30T01:00:00.000Z",
      );
      delete closed.caseInvocation;
      await store.save(closed, active.revision);
      await client.executionSpace.update({
        where: {
          projectId_systemId_executionSpaceId: { ...scope, executionSpaceId },
        },
        data: {
          lifecycle: "closed",
          closedAt: new Date(closed.cases![0].closedAt!),
        },
      });
      await assert.rejects(
        () => storage.caseSpace(executionSpaceId, caseId),
        /unavailable/,
      );
      await withoutWrites(
        database,
        "closed history and refusals never open/backfill an active runtime",
        async () => {
          assert.deepEqual(
            await readCaseRuntimeState(
              client,
              scope,
              executionSpaceId,
              caseId,
              nativeOwner,
            ),
            closed,
          );
          await assert.rejects(() =>
            readCaseRuntimeState(
              client,
              scope,
              executionSpaceId,
              "wrong-case",
              nativeOwner,
            ), /unavailable/);
          await assert.rejects(() =>
            readCaseRuntimeState(
              client,
              scope,
              "missing-space",
              caseId,
              nativeOwner,
            ), /unavailable/);
          await assert.rejects(
            () =>
              readCaseRuntimeState(client, scope, "main", caseId, nativeOwner),
            /unavailable/,
          );
          assert.equal(
            await readCaseRuntimeState(
              client,
              scope,
              executionSpaceId,
              caseId,
              "missing-native-owner",
            ),
            null,
          );
        },
      );

      const foreignScope = { ...scope, systemId: "foreign-host" };
      await client.assemblySystem.create({ data: foreignScope });
      await client.executionSpace.create({
        data: { ...foreignScope, executionSpaceId: "main" },
      });
      const foreignRuntime = await createCaseScope(
        client,
        foreignScope,
        "foreign-case",
        "foreign-space",
        1,
      );
      const foreignStore = await PostgresSystemStateStore.open(
        client,
        foreignRuntime,
      );
      database.registerCleanup(() => foreignStore.close());
      await foreignStore.save(
        caseState("foreign-case", "foreign-space", 1),
        null,
      );
      const legacyScope = await createCaseScope(
        client,
        scope,
        "legacy-case",
        "legacy-space",
        2,
      );
      const legacy = caseState("legacy-case", "legacy-space", 2);
      legacy.revision = 7;
      await client.runtimeState.create({
        data: {
          ...legacyScope,
          revision: 7n,
          payload: encodeRuntimeSnapshotPayload(JSON.stringify(legacy)),
        },
      });
      await withoutWrites(
        database,
        "foreign lookup and missing retained history must not create a baseline",
        async () => {
          await assert.rejects(() =>
            readCaseRuntimeState(
              client,
              scope,
              "foreign-space",
              "foreign-case",
              nativeOwner,
            ), /unavailable/);
          await assert.rejects(() =>
            readCaseRuntimeState(
              client,
              scope,
              "legacy-space",
              "legacy-case",
              nativeOwner,
            ), /history disagree/);
          assert.equal(
            await client.runtimeRevision.count({ where: legacyScope }),
            0,
          );
        },
      );

      const primary = await withoutWrites(
        database,
        "PRIMARY binding must not upsert system/runtime or migrate",
        async () => {
          const source = await existingPrimaryControl(
            client,
            scope,
            nativeOwner,
          );
          assert.equal(
            source.binding.sourceSystemNativeId,
            requestControlBinding.sourceSystemNativeId,
          );
          assert.notEqual(source.binding.sourceSystemNativeId, scope.systemId);
          const authority = new ModeledSpaceControlAuthority(
            source,
            source.binding,
          );
          assert.equal(
            (await authority.current("owner")).owner.operatorId,
            "owner",
          );
          await assert.rejects(() => authority.current(nativeOwner), forbidden);
          await assert.rejects(
            () => existingPrimaryControl(client, scope, "missing-native-owner"),
            forbidden,
          );
          await assert.rejects(() =>
            existingPrimaryControl(client, {
              ...scope,
              systemId: "missing-host",
            }, nativeOwner), forbidden);
          return source;
        },
      );
      const nextAuthority = spaceControlAuthority();
      nextAuthority.policyRevision++;
      nextAuthority.sourceVersion = `commit:${"d".repeat(40)}`;
      nextAuthority.modelDigest = "d".repeat(64);
      await main.state.save(requestControlState(nextAuthority, 1), 0);
      await withoutWrites(
        database,
        "a retained PRIMARY handle must reread current canonical control",
        async () => {
          const authority = new ModeledSpaceControlAuthority(
            primary,
            primary.binding,
          );
          const current = await authority.current("owner");
          assert.equal(current.policyRevision, nextAuthority.policyRevision);
          assert.equal(current.sourceVersion, nextAuthority.sourceVersion);
          assert.equal(current.modelDigest, nextAuthority.modelDigest);
        },
      );

      // Deliberately corrupt only the owned fixture's current row; readers must refuse,
      // not repair it or derive an owner from a locator/role/history fallback.
      const originalMain = await client.runtimeState.findFirstOrThrow({
        where: mainScope,
      });
      const contradictory = requestControlState(nextAuthority, 1);
      contradictory.executionModel!.identity.builderId =
        "contradictory-native-owner";
      contradictory.model!.builderId = "contradictory-native-owner";
      await client.runtimeState.update({
        where: { projectId_systemId_executionSpaceId_operatorId: mainScope },
        data: {
          payload: encodeRuntimeSnapshotPayload(JSON.stringify(contradictory)),
        },
      });
      await withoutWrites(
        database,
        "a contradictory persisted native owner must fail without mutation",
        async () => {
          await assert.rejects(
            () => existingPrimaryControl(client, scope, nativeOwner),
            forbidden,
          );
        },
      );
      await client.runtimeState.update({
        where: { projectId_systemId_executionSpaceId_operatorId: mainScope },
        data: { payload: originalMain.payload },
      });
      await client.executionSpace.update({
        where: {
          projectId_systemId_executionSpaceId: {
            ...scope,
            executionSpaceId: "main",
          },
        },
        data: {
          lifecycle: "closed",
          closedAt: new Date("2026-10-30T02:00:00.000Z"),
        },
      });
      await withoutWrites(
        database,
        "closed Main must not be reopened by the local PRIMARY binder",
        async () => {
          await assert.rejects(
            () => existingPrimaryControl(client, scope, nativeOwner),
            forbidden,
          );
        },
      );
    });
  },
});
