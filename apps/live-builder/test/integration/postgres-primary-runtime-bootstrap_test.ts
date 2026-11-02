/** Real host bootstrap/storage witnesses; source compilation is controlled here. */
import assert from "node:assert/strict";
import { bootstrapPrimaryRuntime } from "../../src/composition/primary-runtime-bootstrap.ts";
import { PostgresHostStorage } from "../../src/adapters/out/postgres/host-storage.ts";
import { Prisma } from "../../src/adapters/out/postgres/client.ts";
import { postgresClientConfiguration } from "../../src/adapters/out/postgres/config.ts";
import { encodeRuntimeSnapshotPayload } from "../../src/adapters/out/postgres/runtime-snapshot-codec.ts";
import {
  PostgresSpaceAdmissions,
  PostgresSpaceCredentials,
} from "../../src/adapters/out/postgres/request-space-control-store.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import { ModeledSpaceControlAuthority } from "../../src/application/work/request-spaces/space-control-authority.ts";
import { SpaceControls } from "../../src/application/work/request-spaces/control.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import type {
  ModelPort,
  StorePort,
} from "../../src/application/work/runtime/ports.ts";
import { AjvSchemaValidator } from "../../src/infrastructure/ajv-schema-validation.ts";
import { requestSpaceDigest } from "../../src/domain/work/request-spaces.ts";
import {
  type PostgresTestDatabase,
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import {
  requestControlModel,
  requestControlState,
  requestOpeningBase,
  spaceUuid,
} from "../support/request-space-fixture.ts";

const scope = { projectId: "space-project", systemId: spaceUuid(500) };
const fail = () => {
  throw new Error("Unexpected source initialization or execution");
};

async function host(database: PostgresTestDatabase) {
  const storage = new PostgresHostStorage(
    postgresClientConfiguration(database.connectionString, 2, database.schema),
  );
  database.registerCleanup(() => storage.close());
  await storage.registerSystem(scope);
  await storage.registerRepository(
    "registered-source-project",
    storage.sourceScopeId,
  );
  // Production composition must bind before every store, including policy-free Main.
  const openOperator = storage.operator.bind(storage);
  storage.operator = (owner) => {
    assert.equal(storage.primarySpaceControl.runtimeScope.operatorId, owner);
    return openOperator(owner);
  };
  return storage;
}

async function directory(database: PostgresTestDatabase) {
  const value = await Deno.makeTempDir({ prefix: "primary-bootstrap-" });
  database.registerCleanup(() => Deno.remove(value, { recursive: true }));
  return value;
}

function options(
  storage: PostgresHostStorage,
  directory: string,
  model: Pick<ModelPort, "initialize" | "readExecutableModel">,
) {
  return {
    directory,
    storage,
    model,
    hasPersistedRuntimes: async () =>
      (await storage.client.operatorRuntime.count({
        where: { ...scope, executionSpaceId: "main" },
      })) > 0,
  };
}

Deno.test({
  name:
    "PRIMARY fresh SQL bootstrap retains the exact policy-free model for ordinary initialization when HEAD advances",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const storage = await host(database);
      const initial = requestControlModel();
      delete initial.spaceControlPolicy;
      const head = structuredClone(initial);
      head.version.digest = "e".repeat(64);
      head.version.repositoryVersion = `commit:${"e".repeat(40)}`;
      let initializations = 0, reads = 0;
      const source: ModelPort = {
        ...unexpectedModelAuthoring,
        initialize: () => {
          initializations++;
          return Promise.resolve(initial.identity);
        },
        readExecutableModel: () =>
          Promise.resolve(++reads === 1 ? initial : head),
        activateCandidate: fail,
        applyApprovedChange: fail,
        graph: fail,
      };
      const bootstrap = await bootstrapPrimaryRuntime(
        options(storage, await directory(database), source),
      );
      assert.equal(bootstrap.admittedInitialModel, initial);
      assert.equal(await bootstrap.primaryStorage.state.load(), null);
      const runtime = new SystemRuntime({
        model: source,
        store: bootstrap.primaryStorage.state,
        stateHistory: bootstrap.primaryStorage.state,
        clock: { now: () => "2026-10-29T00:00:00Z" },
        caseNumbers: storage.caseNumbers(),
        agents: { label: "controlled", decide: fail, review: fail },
        runner: { test: fail, run: fail },
        schemaValidator: new AjvSchemaValidator(),
      });
      await runtime.initialize(bootstrap.admittedInitialModel, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      assert.equal(initializations, 1);
      assert.deepEqual(runtime.snapshot.executionModel, initial);
      assert.deepEqual(runtime.snapshot.availableExecutionModel, head);
      assert.equal(await storage.primarySpaceControl.read(), null);
      assert.equal(
        await storage.client.spaceControlCredential.count({ where: scope }),
        0,
      );
      assert.equal(
        await storage.client.spaceExecutionAdmission.count({ where: scope }),
        0,
      );
      assert.equal(
        await storage.client.operatorRuntime.count({ where: scope }),
        1,
      );
    });
  },
});

Deno.test({
  name:
    "PRIMARY SQL reopen uses saved native identity, preserves current/history and retains canonical invalidation",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const dataDir = await directory(database);
      const first = await host(database);
      const initial = requestControlModel();
      const fresh = await bootstrapPrimaryRuntime(options(first, dataDir, {
        initialize: () => Promise.resolve(initial.identity),
        readExecutableModel: () => Promise.resolve(initial),
      }));
      const state = requestControlState();
      await fresh.primaryStorage.state.save(state, null);
      const loadedBaseline = await fresh.primaryStorage.state.load();
      assert.ok(loadedBaseline);
      const where = {
        ...scope,
        executionSpaceId: "main",
        operatorId: "operator",
      };
      const before = await first.client.runtimeState.findFirstOrThrow({
        where,
      });
      const history = await first.client.runtimeRevision.findMany({
        where,
        orderBy: { revision: "asc" },
      });
      await first.close();

      const reopened = await host(database);
      const bootstrap = await bootstrapPrimaryRuntime(
        options(reopened, dataDir, {
          initialize: fail,
          readExecutableModel: fail,
        }),
      );
      assert.equal(bootstrap.admittedInitialModel, undefined);
      const primary = reopened.primarySpaceControl;
      assert.equal(
        primary.binding.sourceSystemNativeId,
        state.executionModel!.identity.systemId,
      );
      assert.notEqual(primary.binding.sourceSystemNativeId, scope.systemId);
      assert.deepEqual(
        await bootstrap.primaryStorage.state.load(),
        loadedBaseline,
      );
      assert.deepEqual(
        await reopened.client.runtimeState.findFirstOrThrow({ where }),
        before,
      );
      assert.deepEqual(
        await reopened.client.runtimeRevision.findMany({
          where,
          orderBy: { revision: "asc" },
        }),
        history,
      );
      const credentials = new PostgresSpaceCredentials(
        reopened.client,
        primary,
      );
      const controls = new SpaceControls(
        credentials,
        new ModeledSpaceControlAuthority(primary, primary.binding),
        { randomSecret: () => "a".repeat(64) },
      );
      const issued = await controls.issueCapability("owner");
      const capability = (await credentials.get(issued.credentialId))!;
      const openings = new PostgresRequestSpaceStore(reopened.client, scope);
      const command = {
        openingKey: "bootstrap-opening",
        text: "Request",
        source: { kind: "current-main" as const },
      };
      let opening = await openings.begin({
        ownerId: "owner",
        command,
        commandDigest: await requestSpaceDigest({
          scope,
          ownerId: "owner",
          command,
        }),
      });
      const base = await requestOpeningBase();
      base.manifest.origin = { ...scope, executionSpaceId: "main" };
      base.manifestDigest = await requestSpaceDigest(base.manifest);
      opening = await openings.selectBase({
        id: opening.id,
        ownerId: "owner",
        expectedRevision: opening.revision,
        base,
        baseDigest: await requestSpaceDigest(base),
      });
      for (
        const [from, to] of [["source-selected", "branch-ready"], [
          "branch-ready",
          "runtime-ready",
        ]] as const
      ) {
        opening = await openings.advance({
          id: opening.id,
          ownerId: "owner",
          expectedRevision: opening.revision,
          from,
          to,
        });
      }
      const admissions = new PostgresSpaceAdmissions(reopened.client, primary);
      const admitted = await admissions.admit({
        id: spaceUuid(501),
        scope,
        openingId: opening.id,
        executionSpaceId: opening.executionSpaceId,
        ownerId: "owner",
        capabilityId: capability.id,
        capabilityRevision: capability.revision,
        baseDigest: opening.baseDigest!,
        authority: capability.authority,
        permissions: {
          operatorIds: ["operator"],
          acts: ["conversation"],
          resourceIds: [],
          sourceVersion: base.manifest.source!.sourceVersion,
          modelDigests: ["a".repeat(64)],
        },
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const disabled = structuredClone(state);
      disabled.revision++;
      disabled.executionModel!.spaceControlPolicy!.enabled = false;
      disabled.executionModel!.spaceControlPolicy!.revision++;
      disabled.executionModel!.version.digest = "d".repeat(64);
      disabled.executionModel!.version.repositoryVersion = `commit:${
        "d".repeat(40)
      }`;
      await bootstrap.primaryStorage.state.save(disabled, state.revision);
      assert.equal((await credentials.get(capability.id))!.status, "revoked");
      assert.equal((await admissions.get(admitted.id))!.status, "revoked");
      assert.equal(
        await reopened.client.runtimeRevision.count({ where }),
        history.length + 1,
      );
      assert.deepEqual(
        await reopened.client.runtimeRevision.findMany({
          where: { ...where, revision: 0n },
        }),
        history,
      );
    });
  },
});

Deno.test({
  name:
    "PRIMARY pre-store SQL read validates scope, canonical envelope/revision and closing without creating state",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const storage = await host(database);
      assert.equal(await storage.readPrimaryRuntimeState("operator"), null);
      assert.equal(
        await storage.client.operatorRuntime.count({ where: scope }),
        0,
      );
      await assert.rejects(
        () => storage.readPrimaryRuntimeState("\0"),
        /scope/,
      );
      assert.equal(
        await storage.client.operatorRuntime.count({ where: scope }),
        0,
      );
      const dataDir = await directory(database);
      const initial = requestControlModel();
      const fresh = await bootstrapPrimaryRuntime(options(storage, dataDir, {
        initialize: () => Promise.resolve(initial.identity),
        readExecutableModel: () => Promise.resolve(initial),
      }));
      const saved = requestControlState();
      // Force canonical compressed framing, then test revision and envelope refusal
      // on reopening before any store can backfill or otherwise touch history.
      saved.events.push({
        id: "large",
        at: "now",
        kind: "runtime-started",
        label: "x".repeat(20_000),
      });
      await fresh.primaryStorage.state.save(saved, null);
      const loadedBaseline = await fresh.primaryStorage.state.load();
      assert.ok(loadedBaseline);
      await storage.close();
      const reopened = await host(database);
      const where = {
        ...scope,
        executionSpaceId: "main",
        operatorId: "operator",
      };
      const row = await reopened.client.runtimeState.findFirstOrThrow({
        where,
      });
      assert.ok(row.payload.startsWith("assembly-runtime-snapshot:"));
      assert.deepEqual(
        await reopened.readPrimaryRuntimeState("operator"),
        loadedBaseline,
      );
      for (
        const payload of [
          encodeRuntimeSnapshotPayload(
            JSON.stringify({ ...saved, revision: 9 }),
          ),
          JSON.stringify({ ...saved, messages: null }),
          JSON.stringify({ ...saved, executionModel: undefined }),
          JSON.stringify({
            ...saved,
            model: { ...saved.model, projectId: "foreign-project" },
          }),
          "{broken-json",
        ]
      ) {
        await reopened.client.runtimeState.update({
          where: { projectId_systemId_executionSpaceId_operatorId: where },
          data: { payload },
        });
        const attempt = await host(database);
        await assert.rejects(() =>
          bootstrapPrimaryRuntime(
            options(attempt, dataDir, {
              initialize: fail,
              readExecutableModel: fail,
            }),
          )
        );
        assert.throws(() => attempt.primarySpaceControl, /not configured/);
        assert.equal(await attempt.client.runtimeRevision.count({ where }), 1);
        assert.equal(
          (await attempt.client.runtimeState.findFirstOrThrow({ where }))
            .payload,
          payload,
        );
        await attempt.close();
      }
      await reopened.client.runtimeState.delete({
        where: { projectId_systemId_executionSpaceId_operatorId: where },
      });
      const missingCurrent = await host(database);
      await assert.rejects(
        () =>
          bootstrapPrimaryRuntime(
            options(missingCurrent, dataDir, {
              initialize: fail,
              readExecutableModel: fail,
            }),
          ),
        /history has no current PRIMARY/,
      );
      assert.throws(() => missingCurrent.primarySpaceControl, /not configured/);
      assert.equal(
        await missingCurrent.client.runtimeState.count({ where }),
        0,
      );
      assert.equal(
        await missingCurrent.client.runtimeRevision.count({ where }),
        1,
      );
      await missingCurrent.close();
      await reopened.close();
      await assert.rejects(
        () => reopened.readPrimaryRuntimeState("operator"),
        /closing/,
      );
    });
  },
});

Deno.test({
  name:
    "PRIMARY missing locator over existing SQL runtime refuses source fallback and preserves rows",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const storage = await host(database);
      const dataDir = await directory(database);
      const initial = requestControlModel();
      const fresh = await bootstrapPrimaryRuntime(
        options(storage, dataDir, {
          initialize: () => Promise.resolve(initial.identity),
          readExecutableModel: () => Promise.resolve(initial),
        }),
      );
      await fresh.primaryStorage.state.save(requestControlState(), null);
      await storage.close();
      await Deno.remove(`${dataDir}/main-runtime-owner.json`);
      const reopened = await host(database);
      await assert.rejects(
        () =>
          bootstrapPrimaryRuntime(
            options(reopened, dataDir, {
              initialize: fail,
              readExecutableModel: fail,
            }),
          ),
        /locator is missing/,
      );
      assert.throws(() => reopened.primarySpaceControl, /not configured/);
      assert.equal(
        await reopened.client.operatorRuntime.count({ where: scope }),
        1,
      );
      assert.equal(
        await reopened.client.runtimeRevision.count({ where: scope }),
        1,
      );
    });
  },
});

Deno.test({
  name:
    "PRIMARY reopens the exact first initialization commit after interruption and HEAD advance",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const dataDir = await directory(database);
      const first = await host(database);
      const initial = requestControlModel();
      let head = initial;
      let initializations = 0, reads = 0;
      const source: ModelPort = {
        ...unexpectedModelAuthoring,
        initialize() {
          initializations++;
          return Promise.resolve(initial.identity);
        },
        readExecutableModel() {
          reads++;
          return Promise.resolve(head);
        },
        activateCandidate: fail,
        applyApprovedChange: fail,
        graph: fail,
      };
      const fresh = await bootstrapPrimaryRuntime(
        options(first, dataDir, source),
      );
      const crash = new Error(
        "Interrupted after first durable PRIMARY state commit",
      );
      const interruptedStore: StorePort = {
        load: () => fresh.primaryStorage.state.load(),
        async save(next, expected) {
          await fresh.primaryStorage.state.save(next, expected);
          throw crash;
        },
        close: () => Promise.resolve(),
      };
      const runtime = new SystemRuntime({
        model: source,
        store: interruptedStore,
        stateHistory: fresh.primaryStorage.state,
        clock: { now: () => "2026-10-29T00:00:00Z" },
        caseNumbers: first.caseNumbers(),
        agents: { label: "controlled", decide: fail, review: fail },
        runner: { test: fail, run: fail },
        schemaValidator: new AjvSchemaValidator(),
      });
      await assert.rejects(
        () =>
          runtime.initialize(fresh.admittedInitialModel, {
            resumeContinuations: false,
            resumeCandidateContinuations: false,
          }),
        (error) => error === crash,
      );
      const firstState = await fresh.primaryStorage.state.load();
      assert.ok(firstState?.executionModel);
      assert.equal(firstState.revision, 0);
      assert.deepEqual(firstState.model, firstState.executionModel.identity);
      assert.equal(
        firstState.executionModel.version.digest,
        initial.version.digest,
      );
      assert.equal(
        firstState.executionModel.version.repositoryVersion,
        initial.version.repositoryVersion,
      );
      assert.deepEqual(firstState.messages, []);
      assert.deepEqual(firstState.events, []);
      const where = {
        ...scope,
        executionSpaceId: "main",
        operatorId: "operator",
      };
      const firstCurrent = await first.client.runtimeState.findFirstOrThrow({
        where,
      });
      const firstHistory = await first.client.runtimeRevision.findMany({
        where,
        orderBy: { revision: "asc" },
      });
      assert.equal(firstHistory.length, 1);
      await first.close();

      head = structuredClone(initial);
      head.version.digest = "e".repeat(64);
      head.version.repositoryVersion = `commit:${"e".repeat(40)}`;
      const reopened = await host(database);
      const beforeBootstrapReads = reads;
      const reopenedSource = { ...source, initialize: fail };
      const bootstrap = await bootstrapPrimaryRuntime(
        options(reopened, dataDir, reopenedSource),
      );
      assert.equal(reads, beforeBootstrapReads);
      assert.equal(initializations, 1);
      assert.equal(bootstrap.admittedInitialModel, undefined);
      assert.deepEqual(await bootstrap.primaryStorage.state.load(), firstState);
      assert.deepEqual(
        await reopened.client.runtimeState.findFirstOrThrow({ where }),
        firstCurrent,
      );
      assert.deepEqual(
        await reopened.client.runtimeRevision.findMany({
          where,
          orderBy: { revision: "asc" },
        }),
        firstHistory,
      );
      const restored = new SystemRuntime({
        model: reopenedSource,
        store: bootstrap.primaryStorage.state,
        stateHistory: bootstrap.primaryStorage.state,
        clock: { now: () => "2026-10-29T00:00:00Z" },
        caseNumbers: reopened.caseNumbers(),
        agents: { label: "controlled", decide: fail, review: fail },
        runner: { test: fail, run: fail },
        schemaValidator: new AjvSchemaValidator(),
      });
      await restored.initialize(bootstrap.admittedInitialModel, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      assert.equal(initializations, 1);
      assert.equal(restored.snapshot.id, firstState.id);
      assert.equal(restored.snapshot.revision, 1);
      assert.deepEqual(
        restored.snapshot.executionModel,
        firstState.executionModel,
      );
      assert.equal(
        restored.snapshot.availableExecutionModel?.version.digest,
        head.version.digest,
      );
      assert.deepEqual(
        await reopened.client.runtimeRevision.findMany({
          where: { ...where, revision: 0n },
        }),
        firstHistory,
      );
      assert.equal(await reopened.client.runtimeRevision.count({ where }), 2);
      assert.equal(
        await reopened.client.spaceControlCredential.count({ where: scope }),
        0,
      );
      assert.equal(
        await reopened.client.spaceExecutionAdmission.count({ where: scope }),
        0,
      );
    });
  },
});

Deno.test({
  name:
    "PRIMARY refuses malformed canonical control before legacy history backfill",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const dataDir = await directory(database);
      const first = await host(database);
      const model = requestControlModel();
      await bootstrapPrimaryRuntime(options(first, dataDir, {
        initialize: () => Promise.resolve(model.identity),
        readExecutableModel: () => Promise.resolve(model),
      }));
      const where = {
        ...scope,
        executionSpaceId: "main",
        operatorId: "operator",
      };
      const malformed = requestControlState();
      malformed.executionModel!.spaceControlPolicy!.holderNativeId =
        "foreign-holder";
      await first.client.runtimeState.create({
        data: {
          ...where,
          revision: 0n,
          payload: encodeRuntimeSnapshotPayload(JSON.stringify(malformed)),
        },
      });
      const before = await first.client.runtimeState.findFirstOrThrow({
        where,
      });
      assert.equal(await first.client.runtimeRevision.count({ where }), 0);
      await first.close();
      const reopened = await host(database);
      await assert.rejects(
        () =>
          bootstrapPrimaryRuntime(options(reopened, dataDir, {
            initialize: fail,
            readExecutableModel: fail,
          })),
        /space-control/,
      );
      assert.throws(() => reopened.primarySpaceControl, /not configured/);
      assert.deepEqual(
        await reopened.client.runtimeState.findFirstOrThrow({ where }),
        before,
      );
      assert.equal(await reopened.client.runtimeRevision.count({ where }), 0);
      assert.equal(
        await reopened.client.spaceControlCredential.count({ where: scope }),
        0,
      );
      assert.equal(
        await reopened.client.spaceExecutionAdmission.count({ where: scope }),
        0,
      );
    });
  },
});

Deno.test({
  name:
    "PRIMARY pre-store current/history reads retain one read-only snapshot across a canonical first save",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const writer = await host(database);
      const initial = requestControlModel();
      const fresh = await bootstrapPrimaryRuntime(
        options(writer, await directory(database), {
          initialize: () => Promise.resolve(initial.identity),
          readExecutableModel: () => Promise.resolve(initial),
        }),
      );
      const reader = await host(database);
      const transaction = reader.client.$transaction.bind(reader.client);
      let reached!: () => void, release!: () => void;
      const currentRead = new Promise<void>((resolve) => reached = resolve);
      const resume = new Promise<void>((resolve) => release = resolve);
      // Observe the real first SQL read; only its return to the production
      // callback is paused. The canonical writer commits through another host.
      Object.defineProperty(reader.client, "$transaction", {
        configurable: true,
        value: (
          work: (tx: Prisma.TransactionClient) => Promise<unknown>,
          transactionOptions?: Parameters<typeof transaction>[1],
        ) =>
          transaction(async (tx) => {
            const read = tx.runtimeState.findFirst.bind(tx.runtimeState);
            const observed = new Proxy(tx, {
              get(target, key) {
                if (key !== "runtimeState") {
                  const value = Reflect.get(target, key);
                  return typeof value === "function"
                    ? value.bind(target)
                    : value;
                }
                return new Proxy(target.runtimeState, {
                  get(delegate, method) {
                    if (method !== "findFirst") {
                      return Reflect.get(delegate, method);
                    }
                    return async (input: Parameters<typeof read>[0]) => {
                      const result = await read(input);
                      assert.equal(result, null);
                      const [settings] = await tx.$queryRaw<
                        Array<{ isolation: string; readOnly: string }>
                      >(
                        Prisma
                          .sql`SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS "readOnly"`,
                      );
                      assert.equal(settings.isolation, "repeatable read");
                      assert.equal(settings.readOnly, "on");
                      reached();
                      await resume;
                      return result;
                    };
                  },
                });
              },
            });
            return await work(observed);
          }, transactionOptions),
      });
      const pending = reader.readPrimaryRuntimeState("operator");
      try {
        await Promise.race([
          currentRead,
          pending.then(() => {
            throw new Error(
              "PRIMARY read ended before the interleaving barrier",
            );
          }),
        ]);
        await fresh.primaryStorage.state.save(requestControlState(), null);
        assert.equal(
          await writer.client.runtimeRevision.count({ where: scope }),
          1,
        );
      } finally {
        release();
        await Promise.allSettled([pending]);
        Object.defineProperty(reader.client, "$transaction", {
          configurable: true,
          value: transaction,
        });
      }
      assert.equal(await pending, null);
      const saved = await fresh.primaryStorage.state.load();
      assert.deepEqual(await reader.readPrimaryRuntimeState("operator"), saved);
      assert.equal(
        await reader.client.runtimeRevision.count({ where: scope }),
        1,
      );
    });
  },
});
