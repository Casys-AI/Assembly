/** Real operational fixture: one isolated schema, official PostgreSQL graph and
 * pg-boss workers. Never starts a database, builds native code or calls a provider. */
import { Client } from "pg";
import { openPostgresDatabase, type PostgresTestDatabase } from "./postgres.ts";
import { postgresClientConfiguration } from "../../src/adapters/out/postgres/config.ts";
import { PostgresHostStorage } from "../../src/adapters/out/postgres/host-storage.ts";
import { createPostgresNativeRuntime } from "../../src/adapters/work/runtime/postgres.ts";
import { openModelBackend } from "../../src/composition/model-backend.ts";
import { AjvSchemaValidator } from "../../src/infrastructure/ajv-schema-validation.ts";
import { SystemClock } from "../../src/infrastructure/clock.ts";
import { createModelProject } from "../../src/adapters/out/filesystem/model-project.ts";
import { validateSourceExecutable } from "../../src/adapters/model/sources/source-model.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import type { PostgresSystemScope } from "../../src/adapters/out/postgres/scope.ts";
import type { OperatorExecutionDeliveryHandler } from "../../src/application/work/operators/execution.ts";
import type { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import type { openOperatorWorkspace } from "../../src/adapters/work/operator-workspace.ts";

type Workspace = Awaited<ReturnType<typeof openOperatorWorkspace>>;

/** Storage-only cases use the same host scope without constructing a native model. */
export async function openPostgresFixtureHost(
  existingDatabase?: PostgresTestDatabase,
) {
  const database = existingDatabase ?? await openPostgresDatabase();
  const storage = new PostgresHostStorage(postgresClientConfiguration(
    database.connectionString,
    4,
    database.schema,
  ));
  let closed = false;
  return {
    database,
    storage,
    async close(options: { retainDatabase?: true } = {}) {
      if (closed) return;
      closed = true;
      try {
        await storage.close();
      } finally {
        if (!options.retainDatabase) await database.close();
      }
    },
  };
}

/** Pure-model integrations still use real PostgreSQL state, official graph
 * persistence and pg-boss. They supply their original model/authority ports. */
export async function openPostgresExecutionFixtureHost(options: {
  scope: PostgresSystemScope;
  database?: PostgresTestDatabase;
  primaryOperatorId?: string;
  initialAdmissionFault?: (
    phase:
      | "before-fork"
      | "after-fork"
      | "before-selection"
      | "after-selection",
  ) => void | Promise<void>;
}) {
  const host = await openPostgresFixtureHost(options.database);
  const { database, storage } = host;
  let native:
    | Awaited<ReturnType<typeof createPostgresNativeRuntime>>
    | undefined;
  let closed = false;
  const errors: unknown[] = [];
  try {
    await storage.registerSystem(options.scope);
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
          if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
            throw new Error("Invalid fixture schema");
          }
          await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        }
      } finally {
        await admin.end();
      }
    });
    native = await createPostgresNativeRuntime({
      client: storage.client,
      scope: { ...storage.scope, executionSpaceId: storage.executionSpaceId },
      connectionString: database.connectionString,
      ...schemas,
      ...(options.primaryOperatorId === undefined
        ? {}
        : { primaryOperatorId: options.primaryOperatorId }),
      ...(options.initialAdmissionFault
        ? { initialAdmissionFault: options.initialAdmissionFault }
        : {}),
      onError: (error) => {
        errors.push(error);
      },
    });
    const framework = native;
    return {
      database,
      storage,
      native: framework,
      async runtimePortsFor(operatorId: string) {
        const stores = await storage.operator(operatorId);
        return {
          store: stores.state,
          stateHistory: stores.state,
          execution: framework.execution,
          dispatch: framework.dispatch,
          schemaValidator: new AjvSchemaValidator(),
          clock: new SystemClock(),
          caseNumbers: storage.caseNumbers(),
        };
      },
      start: (handler: OperatorExecutionDeliveryHandler) =>
        framework.start(handler),
      /** Ungraceful kill: stop accepting new deliveries and terminate the
       * pg-boss worker path without draining in-flight handlers. In-flight
       * queue claims are failed (pg-boss aborts their signals and schedules
       * their retry) while orphaned attempts keep their pools, so their next
       * ledger write is refused by its fence. Database and schemas stay. */
      async kill() {
        framework.stopAccepting();
        await framework.dispatch.boss.stop({ graceful: false });
      },
      async idle(runtime?: SystemRuntime, timeoutMs = 600_000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          await runtime?.idle();
          const pending = await storage.client.executionContribution.count({
            where: {
              ...storage.scope,
              executionSpaceId: storage.executionSpaceId,
              status: { in: ["queued", "running"] },
            },
          });
          if (!pending) {
            if (errors.length) {
              // Drain-once like the memory fixture: a settled failure is
              // reported by the first idle() that observes it and must not
              // poison every later drain.
              const observed = errors.splice(0, errors.length);
              throw new AggregateError(
                observed,
                "PostgreSQL fixture worker failed",
              );
            }
            return;
          }
          if (Date.now() >= deadline) {
            throw new Error("PostgreSQL fixture deliveries did not settle");
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      },
      async close(shutdown: { retainDatabase?: true } = {}) {
        if (closed) return;
        closed = true;
        try {
          await framework.stop();
        } finally {
          await host.close(shutdown);
        }
      },
    };
  } catch (error) {
    try {
      await native?.stop();
    } finally {
      await host.close();
    }
    throw error;
  }
}

/** Durable-recovery host: one isolated database whose saver, store and
 * ledger schemas are reopened by fresh runtime instances across an explicit
 * stop boundary. Only one session may be active at a time, mirroring a
 * fenced successor; stopping a session closes its pools and workers while
 * retaining the database and every framework schema for the next session. */
export async function openPostgresDurableRecoveryHost(options: {
  scope: PostgresSystemScope;
  database?: PostgresTestDatabase;
  primaryOperatorId?: string;
  initialAdmissionFault?: (
    phase:
      | "before-fork"
      | "after-fork"
      | "before-selection"
      | "after-selection",
  ) => void | Promise<void>;
}) {
  const database = options.database ?? await openPostgresDatabase();
  const schemas = {
    queueSchema: `${database.schema}_queue`,
    checkpointSchema: `${database.schema}_checkpoint`,
  };
  let active: { stop(): Promise<void> } | undefined;
  const killed: Array<
    { close(shutdown?: { retainDatabase?: true }): Promise<void> }
  > = [];
  let closed = false;
  return {
    database,
    scope: options.scope,
    schemas,
    async openSession() {
      if (closed) throw new Error("Durable recovery host is closed");
      if (active) {
        throw new Error(
          "A durable recovery session is already active; stop it before reopening",
        );
      }
      const session = await openPostgresExecutionFixtureHost({
        ...(options.initialAdmissionFault
          ? { initialAdmissionFault: options.initialAdmissionFault }
          : {}),
        scope: options.scope,
        database,
        ...(options.primaryOperatorId === undefined
          ? {}
          : { primaryOperatorId: options.primaryOperatorId }),
      });
      let stopped = false;
      const wrapped = {
        ...session,
        /** Explicit stop boundary: workers and pools close, data stays. */
        async stop() {
          if (stopped) return;
          stopped = true;
          try {
            await session.close({ retainDatabase: true });
          } finally {
            if (active === wrapped) active = undefined;
          }
        },
        /** Kill boundary: abort the worker path without graceful drain and
         * release the single-active slot so a fenced successor can open.
         * Pools close at host close, after orphaned attempts have settled. */
        async kill() {
          if (stopped) return;
          stopped = true;
          try {
            await session.kill();
          } finally {
            if (active === wrapped) active = undefined;
            killed.push(session);
          }
        },
      };
      active = wrapped;
      return wrapped;
    },
    async close(shutdown: { retainDatabase?: true } = {}) {
      if (closed) return;
      closed = true;
      try {
        await active?.stop();
      } finally {
        for (const session of killed.splice(0)) {
          try {
            await session.close({ retainDatabase: true });
          } catch {
            // Orphaned pools are best-effort cleanup; the test already ended.
          }
        }
        if (!shutdown.retainDatabase) await database.close();
      }
    },
  };
}

/** The model project must already exist under dataDir/model-project. Source
 * authority and source bindings come from the production backend composition. */
export async function openPostgresRuntimeFixture(options: {
  dataDir: string;
  systemId?: string;
  sources?: Sources;
  /** Reopen the exact database/schema after closing a prior runtime session. */
  database?: PostgresTestDatabase;
  initialAdmissionFault?: (
    phase:
      | "before-fork"
      | "after-fork"
      | "before-selection"
      | "after-selection",
  ) => void | Promise<void>;
}) {
  if (
    Deno.env.get("ASSEMBLY_MODEL_PROJECT_DIR") ||
    Deno.env.get("ASE_MODEL_PROJECT_DIR")
  ) {
    throw new Error(
      "Clear project overrides for an isolated PostgreSQL fixture",
    );
  }
  if (options.sources) {
    await createModelProject({
      root: options.dataDir,
      name: "model-project",
      sources: options.sources,
    });
  }
  const host = await openPostgresFixtureHost(options.database);
  const { database, storage } = host;
  let backend: Awaited<ReturnType<typeof openModelBackend>> | undefined;
  let native:
    | Awaited<ReturnType<typeof createPostgresNativeRuntime>>
    | undefined;
  let closed = false;
  let activeWorkspace: Workspace | undefined;
  let activeRuntime: SystemRuntime | undefined;
  let workersStarted = false;
  const workerErrors: unknown[] = [];
  let workspaceStopped = false;
  const stopWorkspace = async () => {
    if (workspaceStopped) return;
    workspaceStopped = true;
    activeWorkspace?.stopAcceptingRuntimeDeliveries();
    native?.stopAccepting();
    const failures: unknown[] = [];
    for (
      const stop of [
        () => native?.stop(),
        () => activeRuntime?.idle(),
        () => activeWorkspace?.drainRuntimeDeliveries(),
        () => backend?.stopSourceWriter(),
        () => activeWorkspace?.close(),
      ]
    ) {
      try {
        await stop();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        "PostgreSQL workspace shutdown failed",
      );
    }
  };
  const close = async (shutdown: { retainDatabase?: true } = {}) => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    for (
      const stop of [
        stopWorkspace,
        () => backend?.close(),
        () => host.close(shutdown),
      ]
    ) {
      try {
        await stop();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "PostgreSQL fixture shutdown failed");
    }
  };
  try {
    backend = await openModelBackend(options.dataDir, {
      storage,
      systemId: options.systemId ?? "native-qualification",
    });
    const identity = await backend.model.initialize();
    const primary = await storage.operator(identity.builderId);
    const prefix = database.schema;
    const schemas = {
      queueSchema: `${prefix}_queue`,
      checkpointSchema: `${prefix}_checkpoint`,
    };
    database.registerCleanup(async () => {
      const admin = new Client({
        connectionString: database.connectionString,
        connectionTimeoutMillis: 5_000,
      });
      await admin.connect();
      try {
        for (const schema of Object.values(schemas)) {
          if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
            throw new Error("Invalid fixture schema");
          }
          await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        }
      } finally {
        await admin.end();
      }
    });
    native = await createPostgresNativeRuntime({
      client: storage.client,
      scope: { ...storage.scope, executionSpaceId: storage.executionSpaceId },
      connectionString: database.connectionString,
      ...schemas,
      ...(options.initialAdmissionFault
        ? { initialAdmissionFault: options.initialAdmissionFault }
        : {}),
      onError: (error) => {
        workerErrors.push(error);
      },
    });
    const framework = native;
    const modelBackend = backend;
    /** Fixture setup is explicit local-owner admission through the real queue. */
    const publishSystemSources = async (
      sources: Sources,
      expectedVersion: string,
      reason: string,
    ) => {
      const before = await modelBackend.repository.current();
      if (before.version !== expectedVersion) {
        throw new Error("Fixture source base changed");
      }
      const authority = exerciseOwnerAuthority(
        await validateSourceExecutable(before, modelBackend.projectId),
        "model-revision",
      );
      const proposal = await modelBackend.repository.propose({
        baseVersion: before.version,
        sources,
        author: "local-owner",
        reason,
        authorization: { kind: "local-owner", authorityExercise: authority },
      });
      return await modelBackend.repository.accept({
        id: proposal.id,
        expectedVersion: before.version,
        author: "local-owner",
        decisionAuthorityExercise: authority,
      });
    };
    const repository = { ...modelBackend.repository, publishSystemSources };
    const workspacePorts = {
      storage,
      execution: framework.execution,
      dispatch: framework.dispatch,
      caseNumbers: storage.caseNumbers(),
      artifactSources: modelBackend.artifactSources,
      assertCommandOrigin: framework.assertCommandOrigin,
      assertArtifactSourceOrigin: framework.assertArtifactSourceOrigin,
      bindArtifactSourceAuthority: modelBackend.bindArtifactSourceAuthority,
    };
    const runtimePorts = {
      schemaValidator: new AjvSchemaValidator(),
      clock: new SystemClock(),
      store: primary.state,
      stateHistory: primary.state,
      execution: framework.execution,
      dispatch: framework.dispatch,
      caseNumbers: workspacePorts.caseNumbers,
      artifactSources: await modelBackend.artifactSources(identity.builderId),
    };
    const idle = async (runtime?: SystemRuntime, timeoutMs = 600_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (runtime) {
          await runtime.idle();
        }
        const unsettled = await storage.client.executionContribution.count({
          where: {
            ...storage.scope,
            executionSpaceId: storage.executionSpaceId,
            status: { in: ["queued", "running"] },
          },
        });
        if (!unsettled) {
          if (workerErrors.length) {
            // Drain-once like the memory fixture: a settled failure is
            // reported by the first idle() that observes it and must not
            // poison every later drain.
            const observed = workerErrors.splice(0, workerErrors.length);
            throw new AggregateError(
              observed,
              "PostgreSQL fixture worker failed",
            );
          }
          return;
        }
        if (Date.now() >= deadline) {
          throw new Error("PostgreSQL fixture deliveries did not settle");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    return {
      backend: modelBackend,
      repository,
      database,
      storage,
      native: framework,
      primary,
      identity,
      workspacePorts,
      runtimePorts,
      idle,
      async start(workspace: Workspace) {
        activeWorkspace = workspace;
        if (!workersStarted) {
          await framework.start(async (delivery) => {
            const target = activeWorkspace?.runtimeFor(
              delivery.identity.operatorId,
            );
            if (!target) {
              throw new Error(
                "Accepted contribution has no admitted fixture runtime",
              );
            }
            await target.runtime.processAcceptedContribution(delivery);
          });
          workersStarted = true;
        }
        await workspace.activateRuntimeDeliveries();
      },
      async startRuntime(runtime: SystemRuntime) {
        if (activeWorkspace) {
          throw new Error("Fixture workers already belong to a workspace");
        }
        if (workersStarted) await idle();
        activeRuntime = runtime;
        if (!workersStarted) {
          await framework.start(async (delivery) => {
            const target = activeRuntime;
            if (
              !target ||
              delivery.identity.operatorId !==
                target.snapshot.executionModel?.identity.builderId
            ) {
              throw new Error(
                "Accepted contribution belongs to another fixture runtime",
              );
            }
            await target.processAcceptedContribution(delivery);
          });
          workersStarted = true;
        }
      },
      /** Typed, host-only diagnostics; no connection material reaches evidence. */
      diagnostics: {
        scope: { ...storage.scope, executionSpaceId: storage.executionSpaceId },
        state: (operatorId: string) =>
          storage.operator(operatorId).then((owner) => owner.state.load()),
        memory: (operatorId: string) =>
          storage.operator(operatorId).then((owner) =>
            owner.memory.list(operatorId)
          ),
        revision: (operatorId: string, revision: number) =>
          storage.operator(operatorId).then((owner) =>
            owner.state.loadRevision(revision)
          ),
        deliveries: () =>
          storage.client.executionContribution.findMany({
            where: {
              ...storage.scope,
              executionSpaceId: storage.executionSpaceId,
            },
            select: {
              operatorId: true,
              threadId: true,
              contributionId: true,
              status: true,
            },
          }),
      },
      stopWorkspace,
      /** Abort the real worker claim while preserving this fixture's database. */
      async kill() {
        framework.stopAccepting();
        await framework.dispatch.boss.stop({ graceful: false });
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
