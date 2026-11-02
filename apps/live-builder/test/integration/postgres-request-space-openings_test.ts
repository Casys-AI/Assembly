import { createRequestInputAdmissionGuard } from "../../src/adapters/out/postgres/request-input-admission.ts";
import { PostgresRequestExecutionBindingReader } from "../../src/adapters/out/postgres/request-execution-binding.ts";
import { PostgresRequestSourceAdmissionStore } from "../../src/adapters/out/postgres/request-source-admission-store.ts";
import { SpaceControls } from "../../src/application/work/request-spaces/control.ts";
import { ModeledSpaceControlAuthority } from "../../src/application/work/request-spaces/space-control-authority.ts";
import { projectSpaceControlAuthority } from "../../src/domain/work/space-control-source.ts";
import {
  createPostgresAdmittedRequestRuntime,
  createPostgresNativeRuntime,
} from "../../src/adapters/work/runtime/postgres.ts";
import { PostgresHostStorage } from "../../src/adapters/out/postgres/host-storage.ts";
import { postgresClientConfiguration } from "../../src/adapters/out/postgres/config.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { requestSpaceSeed } from "../../src/adapters/work/request-space-runtime.ts";
import { AjvSchemaValidator } from "../../src/infrastructure/ajv-schema-validation.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import type {
  AgentPort,
  ModelPort,
  ToolRunnerPort,
} from "../../src/application/work/runtime/ports.ts";
import { PostgresPrimarySpaceControlSource } from "../../src/adapters/out/postgres/primary-space-control-source.ts";
import { PostgresSystemStateStore } from "../../src/adapters/out/postgres/system-state-store.ts";
import assert from "node:assert/strict";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import {
  PostgresSpaceAdmissions,
  PostgresSpaceCredentials,
  type SpaceEffectStartCheck,
} from "../../src/adapters/out/postgres/request-space-control-store.ts";
import {
  postgresQualifiedTable,
  Prisma,
  type PrismaClient,
} from "../../src/adapters/out/postgres/client.ts";
import {
  type OpeningRecord,
  requestSpaceDigest,
} from "../../src/domain/work/request-spaces.ts";
import type { SpaceControlCredential } from "../../src/application/work/request-spaces/control-ports.ts";
import {
  postgresTestEnabled,
  seedPostgresRuntime,
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
const command = {
  openingKey: "opening",
  text: "A request",
  source: { kind: "current-main" as const },
};
const input = async (key = "opening") => {
  const value = { ...command, openingKey: key };
  return {
    ownerId: "owner",
    command: value,
    commandDigest: await requestSpaceDigest({
      scope,
      ownerId: "owner",
      command: value,
    }),
  };
};
async function ready(
  client: PrismaClient,
  admissionAuthority = spaceControlAuthority(),
) {
  await seedPostgresRuntime(client, {
    ...scope,
    executionSpaceId: "main",
    operatorId: "operator",
  });
  const primary = new PostgresPrimarySpaceControlSource(client, {
    ...requestControlBinding,
    primaryOperatorId: "operator",
  });
  const primaryStore = await PostgresSystemStateStore.open(
    client,
    primary.runtimeScope,
    primary,
  );
  await primaryStore.save(requestControlState(), null);
  const store = new PostgresRequestSpaceStore(client, scope);
  const created = await store.begin(await input());
  const base = await requestOpeningBase();
  const selected = await store.selectBase({
    id: created.id,
    ownerId: "owner",
    expectedRevision: created.revision,
    base,
    baseDigest: await requestSpaceDigest(base),
  });
  const branch = await store.advance({
    id: selected.id,
    ownerId: "owner",
    expectedRevision: selected.revision,
    from: "source-selected",
    to: "branch-ready",
  });
  const record = await store.advance({
    id: branch.id,
    ownerId: "owner",
    expectedRevision: branch.revision,
    from: "branch-ready",
    to: "runtime-ready",
  });
  const credentials = new PostgresSpaceCredentials(
    client,
    primary,
  );
  const authority = spaceControlAuthority();
  const root: SpaceControlCredential & { kind: "capability" } = {
    id: spaceUuid(1),
    kind: "capability",
    ownerId: "owner",
    parentCapabilityId: null,
    authority,
    secretHash: "a".repeat(64),
    revision: 0,
    status: "active",
    expiresAt: "2099-01-01T00:00:00Z",
    createdAt: "2026-10-29T00:00:00Z",
  };
  const issuance = await primary.capture();
  await credentials.insert(root, issuance.adoptedState);
  const admissions = new PostgresSpaceAdmissions(client, primary);
  if (admissionAuthority.sourceVersion !== authority.sourceVersion) {
    await primaryStore.save(requestControlState(admissionAuthority, 1), 0);
  }
  const admitted = await admissions.admit({
    id: spaceUuid(2),
    scope,
    openingId: record.id,
    executionSpaceId: record.executionSpaceId,
    ownerId: "owner",
    capabilityId: root.id,
    capabilityRevision: 0,
    baseDigest: record.baseDigest!,
    authority: admissionAuthority,
    permissions: {
      operatorIds: ["operator"],
      acts: ["conversation"],
      resourceIds: [],
      sourceVersion: base.manifest.source!.sourceVersion,
      modelDigests: ["a".repeat(64)],
    },
    expiresAt: "2099-01-01T00:00:00Z",
  });
  const admittedRecord = await store.advance({
    id: record.id,
    ownerId: "owner",
    expectedRevision: record.revision,
    from: "runtime-ready",
    to: "admitted",
    admissionId: admitted.id,
  });
  const space = await client.executionSpace.findUniqueOrThrow({
    where: {
      projectId_systemId_executionSpaceId: {
        ...scope,
        executionSpaceId: record.executionSpaceId,
      },
    },
  });
  assert.equal(space.lifecycle, "active");
  assert.equal(
    space.lifecycleRevision,
    0n,
    "Admission must not invent a lifecycle transition",
  );
  assert.equal(space.closedAt, null);
  return {
    store,
    primary,
    primaryStore,
    issuance,
    record: admittedRecord,
    credentials,
    admissions,
    admitted,
    root,
  };
}
function start(
  record: OpeningRecord,
  admissionId: string,
): SpaceEffectStartCheck {
  return {
    admissionId,
    expectedRevision: 0,
    openingId: record.id,
    executionSpaceId: record.executionSpaceId,
    operatorId: "operator",
    modelDigest: "a".repeat(64),
    sourceVersion: record.base!.manifest.source!.sourceVersion,
    baseDigest: record.baseDigest!,
    act: "conversation",
  };
}
Deno.test({
  name:
    "Request opening SQL idempotency keeps one Case number/base across concurrent retries and adapter restart",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      await seedPostgresRuntime(client, {
        ...scope,
        executionSpaceId: "main",
        operatorId: "operator",
      });
      const a = new PostgresRequestSpaceStore(client, scope),
        b = new PostgresRequestSpaceStore(createClient(), scope);
      const command = await input();
      const [first, retry] = await Promise.all([
        a.begin(command),
        b.begin(command),
      ]);
      assert.equal(first.caseId, retry.caseId);
      assert.equal(first.caseNumber, retry.caseNumber);
      const space = await client.executionSpace.findUniqueOrThrow({
        where: {
          projectId_systemId_executionSpaceId: {
            ...scope,
            executionSpaceId: first.executionSpaceId,
          },
        },
      });
      assert.equal(space.lifecycle, "active");
      assert.equal(space.closedAt, null);
      assert.equal(first.phase, "allocated");
      assert.equal(first.admissionId, null);
      const identity = await client.caseIdentity.findUniqueOrThrow({
        where: {
          projectId_systemId_caseId: { ...scope, caseId: first.caseId },
        },
      });
      assert.equal(identity.number, BigInt(first.caseNumber));
      const before = await client.caseSequence.findUniqueOrThrow({
        where: { projectId_systemId: scope },
      });
      const changed = { ...command.command, text: "Different request" };
      await assert.rejects(
        () =>
          a.begin({ ...command, command: changed, commandDigest: "invalid" }),
        /opening identity/,
      );
      const changedDigest = await requestSpaceDigest({
        scope,
        ownerId: "owner",
        command: changed,
      });
      await assert.rejects(
        () =>
          a.begin({
            ...command,
            command: changed,
            commandDigest: changedDigest,
          }),
        /opening identity/,
      );
      assert.equal(
        (await client.caseSequence.findUniqueOrThrow({
          where: { projectId_systemId: scope },
        })).lastNumber,
        before.lastNumber,
      );
      const baseA = await requestOpeningBase("a"),
        baseB = await requestOpeningBase("b");
      const [selected, winner] = await Promise.all([
        a.selectBase({
          id: first.id,
          ownerId: "owner",
          expectedRevision: first.revision,
          base: baseA,
          baseDigest: await requestSpaceDigest(baseA),
        }),
        b.selectBase({
          id: first.id,
          ownerId: "owner",
          expectedRevision: first.revision,
          base: baseB,
          baseDigest: await requestSpaceDigest(baseB),
        }),
      ]);
      assert.deepEqual(selected.base, winner.base);
      assert.equal(selected.baseDigest, winner.baseDigest);
      const baseline = await client.spaceManifest.findUniqueOrThrow({
        where: {
          projectId_systemId_executionSpaceId_revision: {
            ...scope,
            executionSpaceId: first.executionSpaceId,
            revision: 1n,
          },
        },
      });
      assert.equal(baseline.kind, "baseline");
      assert.equal(baseline.digest, winner.base!.manifestDigest);
      assert.equal(
        await client.spaceManifest.count({
          where: { ...scope, executionSpaceId: first.executionSpaceId },
        }),
        1,
      );
      assert.deepEqual((await b.forCase(first.caseId))!.base, winner.base);
      assert.equal(
        await new PostgresRequestSpaceStore(client, {
          ...scope,
          systemId: "foreign",
        }).forCase(first.caseId),
        null,
      );
      await assert.rejects(
        () =>
          client.$executeRaw(
            Prisma.sql`UPDATE ${
              postgresQualifiedTable(client, "SpaceOpening")
            } SET "baseJson"='{}',"revision"="revision"+1 WHERE "id"=${first.id}`,
          ),
        /Immutable Request opening/,
      );
    });
  },
});
Deno.test({
  name:
    "space control SQL FK rejects foreign parent scope/owner and admission capability owner",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      const f = await ready(client);
      const table = postgresQualifiedTable(client, "SpaceControlCredential");
      // Direct SQL verifies constraints independently of the adapter's earlier refusals.
      await assert.rejects(() =>
        client.$executeRaw(
          Prisma
            .sql`INSERT INTO ${table} ("id","projectId","systemId","kind","ownerId","parentCapabilityId","parentKind","authorityJson","secretHash","expiresAt") VALUES ('bad-session',${scope.projectId},${scope.systemId},'session','foreign-owner',${f.root.id},'capability','{}',${
            "b".repeat(64)
          },'2099-01-01')`,
        ), /foreign key|constraint/i);
      await seedPostgresRuntime(client, {
        ...scope,
        systemId: "foreign-system",
        executionSpaceId: "main",
        operatorId: "operator",
      });
      await assert.rejects(() =>
        client.$executeRaw(
          Prisma
            .sql`INSERT INTO ${table} ("id","projectId","systemId","kind","ownerId","parentCapabilityId","parentKind","authorityJson","secretHash","expiresAt") VALUES ('bad-scope',${scope.projectId},'foreign-system','session','owner',${f.root.id},'capability','{}',${
            "c".repeat(64)
          },'2099-01-01')`,
        ), /foreign key|constraint/i);
      const otherInput = await input("other-owner");
      const otherCommand = {
        ...otherInput,
        ownerId: "other",
        commandDigest: await requestSpaceDigest({
          scope,
          ownerId: "other",
          command: otherInput.command,
        }),
      };
      const other = await f.store.begin(otherCommand);
      await assert.rejects(() =>
        client.$executeRaw(
          Prisma.sql`INSERT INTO ${
            postgresQualifiedTable(client, "SpaceExecutionAdmission")
          } ("id","projectId","systemId","executionSpaceId","openingId","ownerId","capabilityId","capabilityRevision","baseDigest","authorityJson","permissionsJson","expiresAt") VALUES ('bad-admission',${scope.projectId},${scope.systemId},${other.executionSpaceId},${other.id},'other',${f.root.id},0,'digest','{}','{}','2099-01-01')`,
        ), /foreign key|constraint/i);
      assert.equal((await f.admissions.get(f.admitted.id))!.status, "active");
    });
  },
});
Deno.test({
  name:
    "space admission guard and capability revocation share lock ordering in both transaction orders",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      const f = await ready(client);
      const peerClient = createClient();
      const peer = new PostgresSpaceCredentials(
        peerClient,
        new PostgresPrimarySpaceControlSource(peerClient, {
          ...requestControlBinding,
          primaryOperatorId: "operator",
        }),
      );
      await assert.rejects(
        () =>
          f.admissions.assertEffectStart(
            client,
            start(f.record, f.admitted.id),
          ),
        /caller-owned ledger transaction/,
      );
      let signalGuard!: () => void, releaseGuard!: () => void;
      let guardPid = 0;
      const guarded = new Promise<void>((resolve) => {
        signalGuard = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseGuard = resolve;
      });
      const transaction = client.$transaction(async (tx) => {
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid() AS pid`,
        );
        guardPid = backend.pid;
        await f.admissions.assertEffectStart(
          tx,
          start(f.record, f.admitted.id),
        );
        signalGuard();
        await release;
      });
      await Promise.race([
        guarded,
        transaction.then(() => {
          throw new Error(
            "Guard transaction ended before its lock was observed",
          );
        }),
      ]);
      let revoked = false;
      const revocation = peer.revokeCapability(f.root.id, "owner", 0).then(
        () => {
          revoked = true;
        },
      );
      try {
        let waitingPid = 0;
        const deadline = performance.now() + 2_000;
        while (performance.now() < deadline) {
          const waiters = await client.$queryRaw<Array<{ pid: number }>>(
            Prisma.sql`
          SELECT DISTINCT a.pid FROM pg_stat_activity a
          JOIN pg_locks l ON l.pid=a.pid
          WHERE a.datname=current_database() AND a.wait_event_type='Lock'
            AND NOT l.granted AND ${guardPid}=ANY(pg_blocking_pids(a.pid))
            AND a.query LIKE ${'%"SpaceControlCredential"%FOR UPDATE%'}
        `,
          );
          if (waiters[0]) {
            waitingPid = waiters[0].pid;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert(
          waitingPid > 0,
          "Revocation must reach an actual SQL lock wait blocked by the guard transaction",
        );
        assert.equal(revoked, false);
      } finally {
        releaseGuard();
        await Promise.allSettled([transaction, revocation]);
      }

      await transaction;
      await revocation;
      assert.equal((await f.admissions.get(f.admitted.id))!.status, "revoked");
      await assert.rejects(
        () =>
          client.$transaction((tx) =>
            f.admissions.assertEffectStart(tx, start(f.record, f.admitted.id))
          ),
        /execution admission is unavailable/,
      );
      // This qualifies the row-lock guard only. ROOT must still qualify its hookup
      // in the REAL transaction inserting ExecutionEffect.started before dispatch.
    });
  },
});

Deno.test({
  name:
    "space guard reads adopted control, preserves unchanged source moves and refuses foreign bindings",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      const current = spaceControlAuthority();
      current.sourceVersion = `commit:${"d".repeat(40)}`;
      current.modelDigest = "d".repeat(64);
      current.owner.sourceIds = ["current-proof"];
      const f = await ready(client, current);
      const check = start(f.record, f.admitted.id);
      const proof = await client.$transaction((tx) =>
        f.admissions.assertEffectStart(tx, check)
      );
      assert.deepEqual(proof.currentAuthority, {
        ...current,
        acts: [...current.acts].sort(),
      });
      assert.equal(proof.adoptedState.revision, 1);
      assert.equal(
        proof.currentAuthority.owner.systemId,
        requestControlBinding.sourceSystemNativeId,
      );
      assert.notEqual(proof.currentAuthority.owner.systemId, scope.systemId);
      const advanced = structuredClone(current);
      advanced.sourceVersion = `commit:${"e".repeat(40)}`;
      advanced.modelDigest = "e".repeat(64);
      await f.primaryStore.save(requestControlState(advanced, 2), 1);
      const next = await client.$transaction((tx) =>
        f.admissions.assertEffectStart(tx, check)
      );
      assert.equal(next.currentAuthority.sourceVersion, advanced.sourceVersion);
      assert.equal(
        next.effectiveAuthorityDigest,
        proof.effectiveAuthorityDigest,
      );
      assert.deepEqual(
        (await f.credentials.get(f.root.id))!.authority,
        spaceControlAuthority(),
      );
      assert.deepEqual(
        (await f.store.forCase(f.record.caseId))!.base,
        f.record.base,
      );
      assert.equal((await f.admissions.get(f.admitted.id))!.status, "active");
      for (
        const changed of [
          { ...advanced, scope: { ...scope, projectId: "foreign-project" } },
          { ...advanced, scope: { ...scope, systemId: "foreign-host" } },
          {
            ...advanced,
            sourceSystemNativeId: "foreign-native",
            owner: { ...advanced.owner, systemId: "foreign-native" },
          },
        ]
      ) {
        await assert.rejects(
          () =>
            f.credentials.insert({
              ...f.root,
              id: spaceUuid(3),
              secretHash: "d".repeat(64),
              authority: changed,
            }, f.issuance.adoptedState),
          /unavailable/,
        );
      }
      const noBump = requestControlState(advanced, 3);
      noBump.executionModel!.spaceControlPolicy!.enabled = false;
      await assert.rejects(
        () => f.primaryStore.save(noBump, 2),
        /strictly increased/,
      );
      assert.equal((await f.primaryStore.load())!.revision, 2);
      assert.equal((await f.admissions.get(f.admitted.id))!.status, "active");
    });
  },
});

Deno.test({
  name:
    "PRIMARY policy disable and re-enable never resurrect old capability or admission, including delayed issuance",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      const f = await ready(client);
      const disabled = requestControlState(spaceControlAuthority(), 1);
      disabled.executionModel!.spaceControlPolicy!.revision = 2;
      disabled.executionModel!.spaceControlPolicy!.enabled = false;
      await f.primaryStore.save(disabled, 0);
      assert.equal((await f.credentials.get(f.root.id))!.status, "revoked");
      assert.equal((await f.admissions.get(f.admitted.id))!.status, "revoked");
      await assert.rejects(
        () =>
          client.$transaction((tx) =>
            f.admissions.assertEffectStart(tx, start(f.record, f.admitted.id))
          ),
        /unavailable/,
      );
      const restored = structuredClone(disabled);
      restored.revision++;
      restored.executionModel!.spaceControlPolicy!.revision = 3;
      restored.executionModel!.spaceControlPolicy!.enabled = true;
      await f.primaryStore.save(restored, 1);
      await assert.rejects(
        () =>
          f.credentials.insert({
            ...f.root,
            id: spaceUuid(3),
            secretHash: "e".repeat(64),
          }, f.issuance.adoptedState),
        /unavailable/,
      );
      await assert.rejects(
        () =>
          client.$transaction((tx) =>
            f.admissions.assertEffectStart(tx, start(f.record, f.admitted.id))
          ),
        /unavailable/,
      );
      assert.equal((await f.credentials.get(f.root.id))!.revision, 1);
      assert.equal((await f.admissions.get(f.admitted.id))!.revision, 1);
    });
  },
});

/** Observe a real row-lock wait, never infer concurrency from a sleep. */
async function blockedBy(client: PrismaClient, pid: number, fragment: string) {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    const rows = await client.$queryRaw<Array<{ pid: number }>>(Prisma.sql`
      SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
      WHERE a.datname=current_database() AND a.wait_event_type='Lock' AND NOT l.granted
      AND ${pid}=ANY(pg_blocking_pids(a.pid)) AND a.query LIKE ${`%${fragment}%`}`);
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Expected a real PRIMARY SQL lock wait");
}
Deno.test({
  name:
    "PRIMARY authority fence serializes adoption versus effect start and delayed capability insertion",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      const f = await ready(client);
      const peerClient = createClient();
      const peerPrimary = new PostgresPrimarySpaceControlSource(peerClient, {
        ...requestControlBinding,
        primaryOperatorId: "operator",
      });
      const peerStore = await PostgresSystemStateStore.open(
        peerClient,
        peerPrimary.runtimeScope,
        peerPrimary,
      );
      let pid = 0, release!: () => void, entered!: () => void;
      const held = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = client.$transaction(async (tx) => {
        pid = (await tx.$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid() AS pid`,
        ))[0].pid;
        const proof = await f.admissions.assertEffectStart(
          tx,
          start(f.record, f.admitted.id),
        );
        assert.equal(proof.adoptedState.revision, 0);
        entered();
        await barrier;
      });
      await Promise.race([
        held,
        first.then(() => {
          throw new Error("Guard ended before barrier");
        }),
      ]);
      const changed = requestControlState(spaceControlAuthority(), 1);
      changed.executionModel!.spaceControlPolicy!.enabled = false;
      changed.executionModel!.spaceControlPolicy!.revision = 2;
      const adopting = peerStore.save(changed, 0);
      try {
        await blockedBy(client, pid, "OperatorRuntime");
      } finally {
        release();
        await Promise.allSettled([first, adopting]);
      }
      await first;
      await adopting;
      assert.equal((await f.admissions.get(f.admitted.id))!.status, "revoked");
      await assert.rejects(
        () =>
          client.$transaction((tx) =>
            f.admissions.assertEffectStart(tx, start(f.record, f.admitted.id))
          ),
        /unavailable/,
      );
      // Hold the adoption writer's real row lock before issuing an older captured
      // capability. INSERT must wait, reread the disabled source, then refuse.
      let unlock!: () => void, locked!: () => void;
      const acquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const writer = peerClient.$transaction(async (tx) => {
        pid = (await tx.$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid() AS pid`,
        ))[0].pid;
        await tx.operatorRuntime.updateMany({
          where: peerPrimary.runtimeScope,
          data: { operatorId: "operator" },
        });
        locked();
        await wait;
      });
      await Promise.race([
        acquired,
        writer.then(() => {
          throw new Error("Writer ended before barrier");
        }),
      ]);
      const delayed = f.credentials.insert({
        ...f.root,
        id: spaceUuid(7),
        secretHash: "7".repeat(64),
      }, f.issuance.adoptedState);
      const observed = delayed.then(
        () => ({ refused: false }),
        () => ({ refused: true }),
      );
      try {
        await blockedBy(client, pid, "OperatorRuntime");
      } finally {
        unlock();
        await Promise.allSettled([writer, observed]);
      }
      await writer;
      assert.equal((await observed).refused, true);
      assert.equal(await f.credentials.get(spaceUuid(7)), null);
    });
  },
});

async function nativeGuardWitness(scenario: "replay" | "technical" | "denied") {
  await withPostgresDatabase(async (database) => {
    const storage = new PostgresHostStorage(
      postgresClientConfiguration(
        database.connectionString,
        2,
        database.schema,
      ),
    );
    // Every operational port (including PRIMARY controls) must share this exact
    // client, not merely the same database/schema: the native ALS fence checks it.
    const client = storage.client;
    database.registerCleanup(() => storage.close());
    // Register the real host's parentless main before legacy low-level seeding.
    // seedPostgresRuntime must preserve that registered main, never create it.
    await storage.registerSystem(scope);
    const f = await ready(client);
    const schemas = {
      queueSchema: `${database.schema}_cap_queue`,
      checkpointSchema: `${database.schema}_cap_checkpoint`,
    };
    database.registerCleanup(async () => {
      for (const schema of Object.values(schemas)) {
        // DDL is outside the worker and survives the host's earlier close.
        await database.client.$executeRawUnsafe(
          `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
        );
      }
    });
    // This bounded witness uses the real native facility on one allocated Case.
    // It is not the not-yet-built Request factory/credential-issuance product path.
    const errors: unknown[] = [];
    const guard: NonNullable<
      Parameters<typeof createPostgresNativeRuntime>[0]["spaceEffectStart"]
    > = (tx, input) => {
      if (scenario === "technical") {
        throw new Error("CONTROL_READ_TECHNICAL_FAILURE");
      }
      assert.equal(input.scope.executionSpaceId, f.record.executionSpaceId);
      if (input.request.identity.scope.kind !== "request") {
        throw new Error("Expected Case execution scope");
      }
      assert.equal(input.request.identity.scope.rootRequestId, f.record.caseId);
      return f.admissions.assertEffectStart(tx, {
        ...start(f.record, f.admitted.id),
        operatorId: input.scope.operatorId,
        modelDigest: input.request.model.version.digest,
        sourceVersion: input.request.model.version.repositoryVersion!,
      });
    };
    const common = {
      client,
      connectionString: database.connectionString,
      ...schemas,
      onError: (error: Error) => {
        errors.push(error);
      },
      spaceEffectStart: guard,
      acceptDeliveryInTransaction: createRequestInputAdmissionGuard(
        scope,
        new PostgresRequestExecutionBindingReader(
          client,
          scope,
          new PostgresRequestSourceAdmissionStore(client),
        ),
        f.admissions,
      ),
    };
    const native = scenario === "replay"
      ? await createPostgresNativeRuntime({
        ...common,
        scope: { ...scope, executionSpaceId: f.record.executionSpaceId },
      })
      : await createPostgresAdmittedRequestRuntime({
        ...common,
        scope: { ...scope, executionSpaceId: "main" },
        resolveCaseSpace: (executionSpaceId) =>
          Promise.resolve(
            executionSpaceId === f.record.executionSpaceId
              ? { ...scope, executionSpaceId, caseId: f.record.caseId }
              : null,
          ),
      });
    database.registerCleanup(() => native.stop());
    const view = scenario === "replay"
      ? native
      : await native.forCaseSpace(f.record.executionSpaceId, f.record.caseId);
    let calls = 0, replayed = false;
    const completedTrace: Array<
      { key: string; nodeId: string; mechanism?: string }
    > = [];
    let authorizedBeforeRevocation: Awaited<
      ReturnType<PrismaClient["executionEffect"]["findMany"]>
    > = [];
    const workers: unknown[] = [];
    try {
      const stores = await (await storage.caseSpace(
        f.record.executionSpaceId,
        f.record.caseId,
      )).operator("operator");
      const authority = spaceControlAuthority();
      authority.sourceVersion = `commit:${"a".repeat(40)}`;
      authority.modelDigest = "a".repeat(64);
      const model = requestControlModel(authority);
      model.caseTypes = [{
        id: "request-type",
        name: "Request",
        type: "request",
        envelope: "conversational",
        behaviorId: model.flows.conversation.rootNativeId,
        ownerId: "operator",
        sourceIds: ["request-type"],
      }];
      const clock = { now: () => "2026-10-29T00:00:00.000Z" };
      const agents: AgentPort = {
        label: "Controlled reply, real native ledger",
        async decide() {
          calls++;
          const rows = await client.executionEffect.findMany({
            where: {
              ...scope,
              executionSpaceId: f.record.executionSpaceId,
              status: "started",
            },
          });
          assert.equal(
            rows.length,
            1,
            "Provider can observe only a committed started receipt",
          );
          assert.ok(rows[0].authorizationJson);
          const proof = JSON.parse(rows[0].authorizationJson);
          assert.equal(
            proof.currentAuthority.sourceVersion,
            spaceControlAuthority().sourceVersion,
          );
          assert.equal(
            proof.currentAuthority.owner.systemId,
            requestControlBinding.sourceSystemNativeId,
          );
          assert.equal(proof.adoptedState.revision, 0);
          assert.equal(proof.admissionId, f.admitted.id);
          assert.equal(proof.executionSpaceId, f.record.executionSpaceId);
          await assert.rejects(
            () =>
              client.executionEffect.updateMany({
                where: {
                  ...scope,
                  executionSpaceId: f.record.executionSpaceId,
                },
                data: { authorizationJson: "{}" },
              }),
            /identity is immutable/,
          );
          return { kind: "reply", text: "A real controlled provider result" };
        },
        review() {
          throw new Error("No candidate review");
        },
      };
      const source: ModelPort = {
        ...unexpectedModelAuthoring,
        initialize: () => Promise.resolve(structuredClone(model.identity)),
        readExecutableModel: () => Promise.resolve(structuredClone(model)),
        applyApprovedChange() {
          throw new Error("No source writes");
        },
        activateCandidate() {
          throw new Error("No activation");
        },
        graph: () => Promise.resolve({}),
      };
      const runner: ToolRunnerPort = {
        test() {
          throw new Error("No tools");
        },
        run() {
          throw new Error("No tools");
        },
      };
      if (scenario === "replay") {
        const open = native.ledger.open.bind(native.ledger);
        native.ledger.open = async (...args) => {
          const session = await open(...args);
          const effect = session.effect.bind(session);
          session.effect = async (key, node, operation, admit) => {
            const result = await effect(key, node, operation, admit);
            completedTrace.push({
              key,
              nodeId: node.nativeId,
              mechanism: node.mechanism,
            });
            if (!replayed && node.mechanism === "choose_move") {
              assert.deepEqual(completedTrace.map((item) => item.mechanism), [
                "read_case",
                "choose_move",
              ]);
              const expectedNodes = ["read_case", "choose_move"].map(
                (mechanism) => {
                  const nodes = model.flows.conversation.nodes.filter((item) =>
                    item.mechanism === mechanism
                  );
                  assert.equal(nodes.length, 1);
                  return nodes[0].nativeId;
                },
              );
              authorizedBeforeRevocation = await client.executionEffect
                .findMany({
                  where: {
                    ...scope,
                    executionSpaceId: f.record.executionSpaceId,
                  },
                  orderBy: { effectKey: "asc" },
                });
              assert.deepEqual(
                authorizedBeforeRevocation.map((item) => item.nodeId).sort(),
                expectedNodes.sort(),
              );
              assert.deepEqual(
                authorizedBeforeRevocation.map((item) => item.effectKey).sort(),
                completedTrace.map((item) => item.key).sort(),
              );
              for (const accepted of authorizedBeforeRevocation) {
                assert.equal(accepted.status, "completed");
                assert.ok(accepted.authorizationJson);
                const proof = JSON.parse(accepted.authorizationJson);
                assert.equal(proof.admissionId, f.admitted.id);
                assert.equal(proof.admissionRevision, 0);
                assert.equal(
                  proof.currentAuthority.sourceVersion,
                  spaceControlAuthority().sourceVersion,
                );
              }
              const receipt = await client.executionEffect.findFirstOrThrow({
                where: {
                  ...scope,
                  executionSpaceId: f.record.executionSpaceId,
                  effectKey: key,
                },
              });
              assert.equal(receipt.status, "completed");
              assert.ok(receipt.resultJson);
              const retainedResult = JSON.parse(receipt.resultJson);
              await f.credentials.revokeCapability(f.root.id, "owner", 0);
              const old = await effect(key, node, () => {
                throw new Error("Completed operation must not replay");
              }, () => {
                throw new Error("Completed receipt must not reauthorize");
              });
              assert.deepEqual(old, retainedResult);
              assert.deepEqual(
                await client.executionEffect.findFirstOrThrow({
                  where: {
                    ...scope,
                    executionSpaceId: f.record.executionSpaceId,
                    effectKey: key,
                  },
                }),
                receipt,
              );
              replayed = true;
            }
            return result;
          };
          return session;
        };
      }
      const runtime = new SystemRuntime({
        store: stores.state,
        stateHistory: stores.state,
        execution: view.execution,
        dispatch: view.dispatch,
        schemaValidator: new AjvSchemaValidator(),
        clock,
        caseNumbers: storage.caseNumbers(),
        agents,
        model: source,
        runner,
        workBudget: new WorkBudgetService(stores.budget),
      });
      await runtime.initializeRequestSpace(requestSpaceSeed(f.record), model);
      // Accept against the live admission before starting a worker. In the
      // denial case revocation then wins before the first effect starts.
      await runtime.submit(
        "Use the exact allocated Case",
        undefined,
        f.record.caseId,
      );
      if (scenario === "denied") {
        await f.credentials.revokeCapability(f.root.id, "owner", 0);
      }
      await native.start(async (delivery) => {
        try {
          await runtime.processAcceptedContribution(delivery);
        } catch (error) {
          workers.push(error);
          throw error;
        }
      });
      const deadline = Date.now() + 15_000;
      let settled = false;
      while (Date.now() < deadline) {
        const runs = await client.executionRun.findMany({
          where: { ...scope, executionSpaceId: f.record.executionSpaceId },
        });
        if (
          scenario === "technical"
            ? runs.some((run) =>
              run.status === "failed" &&
              run.errorJson?.includes("CONTROL_READ_TECHNICAL_FAILURE")
            )
            : runs.some((run) =>
              run.snapshotJson &&
              JSON.parse(run.snapshotJson).status === "refused"
            )
        ) {
          settled = true;
          break;
        }
        if (scenario !== "technical" && (workers.length || errors.length)) {
          throw new AggregateError(
            [...workers, ...errors],
            "Native witness failed",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(
        settled,
        "Guard outcome must follow its typed admission or technical path",
      );
      if (scenario === "technical") native.stopAccepting();
      await native.drain();
      const effects = await client.executionEffect.findMany({
        where: { ...scope, executionSpaceId: f.record.executionSpaceId },
        orderBy: { effectKey: "asc" },
      });
      if (scenario === "replay") {
        assert.equal(calls, 1);
        assert.equal(replayed, true);
        // Exact retained set and bytes: no effect may start after revocation.
        assert.deepEqual(effects, authorizedBeforeRevocation);
        assert.deepEqual(completedTrace.map((item) => item.mechanism), [
          "read_case",
          "choose_move",
        ]);
        assert.equal(
          (await f.admissions.get(f.admitted.id))!.status,
          "revoked",
        );
      } else {
        assert.equal(calls, 0);
        assert.equal(
          effects.length,
          0,
          "Neither refusal nor technical failure can create started/unknown receipts",
        );
        const runs = await client.executionRun.findMany({
          where: { ...scope, executionSpaceId: f.record.executionSpaceId },
        });
        if (scenario === "technical") {
          assert.ok(
            runs.some((run) =>
              run.errorJson?.includes("CONTROL_READ_TECHNICAL_FAILURE")
            ),
          );
          assert.ok(
            runs.every((run) =>
              !run.snapshotJson ||
              JSON.parse(run.snapshotJson).status !== "refused"
            ),
          );
        } else {
          assert.ok(
            runs.some((run) =>
              run.snapshotJson &&
              JSON.parse(run.snapshotJson).refusal?.code ===
                "NATIVE_EXECUTION_ADMISSION_REFUSED"
            ),
          );
        }
      }
      assert.equal((await f.primaryStore.load())!.revision, 0);
    } finally {
      await native.stop();
      await storage.close();
    }
  });
}
Deno.test({
  name:
    "native effect-start commits exact proof before provider, replays completed receipt after revoke and refuses next fresh effect",
  ignore: !postgresTestEnabled,
  fn: () => nativeGuardWitness("replay"),
});
Deno.test({
  name:
    "shared admitted Case assembly preserves technical control failures without a started receipt or terminal refusal",
  ignore: !postgresTestEnabled,
  fn: () => nativeGuardWitness("technical"),
});
Deno.test({
  name:
    "shared admitted Case assembly maps a real typed admission denial to pre-start native refusal",
  ignore: !postgresTestEnabled,
  fn: () => nativeGuardWitness("denied"),
});

Deno.test({
  name:
    "host PRIMARY control binding is immutable, precedes every opened store and shares the host client",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const storage = new PostgresHostStorage(
        postgresClientConfiguration(
          database.connectionString,
          2,
          database.schema,
        ),
      );
      try {
        await storage.registerSystem(scope);
        const binding = {
          primaryOperatorId: "operator",
          sourceSystemNativeId: requestControlBinding.sourceSystemNativeId,
        };
        const first = storage.bindPrimarySpaceControl(binding);
        assert.equal(storage.bindPrimarySpaceControl({ ...binding }), first);
        assert.throws(
          () =>
            storage.bindPrimarySpaceControl({
              ...binding,
              sourceSystemNativeId: "foreign-native",
            }),
          /cannot change/,
        );
        assert.throws(
          () => new PostgresSpaceCredentials(database.client, first),
          /share its host Prisma client/,
        );
        const primary = (await storage.operator("operator")).state;
        await primary.save(requestControlState(), null);
        const credentials = new PostgresSpaceCredentials(storage.client, first);
        const controls = new SpaceControls(
          credentials,
          new ModeledSpaceControlAuthority(first, requestControlBinding),
          { randomSecret: () => "a".repeat(64) },
        );
        const issued = await controls.issueCapability("owner");
        const capability = (await credentials.get(issued.credentialId))!;
        assert.equal(capability.status, "active");
        const openings = new PostgresRequestSpaceStore(storage.client, scope);
        let opening = await openings.begin(await input("host-primary"));
        const base = await requestOpeningBase();
        opening = await openings.selectBase({
          id: opening.id,
          ownerId: "owner",
          expectedRevision: opening.revision,
          base,
          baseDigest: await requestSpaceDigest(base),
        });
        opening = await openings.advance({
          id: opening.id,
          ownerId: "owner",
          expectedRevision: opening.revision,
          from: "source-selected",
          to: "branch-ready",
        });
        opening = await openings.advance({
          id: opening.id,
          ownerId: "owner",
          expectedRevision: opening.revision,
          from: "branch-ready",
          to: "runtime-ready",
        });
        const admissions = new PostgresSpaceAdmissions(storage.client, first);
        const granted = await admissions.admit({
          id: spaceUuid(10),
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
        const noBump = requestControlState(spaceControlAuthority(), 1);
        noBump.executionModel!.spaceControlPolicy!.enabled = false;
        await assert.rejects(
          () => primary.save(noBump, 0),
          /strictly increased/,
        );
        assert.equal((await primary.load())!.revision, 0);
        assert.equal((await credentials.get(capability.id))!.status, "active");
        assert.equal((await admissions.get(granted.id))!.status, "active");
        const disabled = structuredClone(noBump);
        disabled.executionModel!.spaceControlPolicy!.revision = 2;
        disabled.executionModel!.version.repositoryVersion = `commit:${
          "d".repeat(40)
        }`;
        disabled.executionModel!.version.digest = "d".repeat(64);
        await primary.save(disabled, 0);
        assert.equal((await credentials.get(capability.id))!.status, "revoked");
        assert.equal((await admissions.get(granted.id))!.status, "revoked");
        const restored = structuredClone(disabled);
        restored.revision = 2;
        restored.executionModel!.spaceControlPolicy!.enabled = true;
        restored.executionModel!.spaceControlPolicy!.revision = 3;
        restored.executionModel!.version.repositoryVersion = `commit:${
          "e".repeat(40)
        }`;
        restored.executionModel!.version.digest = "e".repeat(64);
        await primary.save(restored, 1);
        assert.equal((await primary.load())!.revision, 2);
        assert.equal((await credentials.get(capability.id))!.status, "revoked");
        assert.equal((await credentials.get(capability.id))!.revision, 1);
        assert.equal((await admissions.get(granted.id))!.status, "revoked");
        assert.equal((await admissions.get(granted.id))!.revision, 1);
        assert.throws(
          () => storage.bindPrimarySpaceControl(binding),
          /before opening stores/,
        );
        assert.equal(storage.primarySpaceControl, first);
      } finally {
        await storage.close();
      }
    });
  },
});

for (const transition of ["absent", "replacement", "source-only"] as const) {
  Deno.test({
    name:
      `captured capability issuance refuses after PRIMARY ${transition} transition, fresh capture succeeds`,
    ignore: !postgresTestEnabled,
    async fn() {
      await withPostgresDatabase(async ({ client }) => {
        const f = await ready(client);
        const captured = await f.primary.capture();
        const next = requestControlState(spaceControlAuthority(), 1);
        next.executionModel!.version.repositoryVersion = `commit:${
          "d".repeat(40)
        }`;
        next.executionModel!.version.digest = "d".repeat(64);
        if (transition === "absent") {
          delete next.executionModel!.spaceControlPolicy;
        }
        if (transition === "replacement") {
          next.executionModel!.spaceControlPolicy!.id = "replacement-policy";
        }
        if (transition === "source-only") {
          next.executionModel!.version.repositoryVersion = `commit:${
            "e".repeat(40)
          }`;
          next.executionModel!.version.digest = "e".repeat(64);
        }
        await f.primaryStore.save(next, 0);
        if (transition !== "source-only") {
          // P/r1 -> absent or Q -> the same P/r1. This does not restore old rows.
          await f.primaryStore.save(
            requestControlState(spaceControlAuthority(), 2),
            1,
          );
        }
        const pending = {
          ...f.root,
          id: spaceUuid(8),
          secretHash: "8".repeat(64),
        };
        await assert.rejects(
          () => f.credentials.insert(pending, captured.adoptedState),
          /unavailable/,
        );
        assert.equal(await f.credentials.get(pending.id), null);
        const oldStatus = transition === "source-only" ? "active" : "revoked";
        assert.equal((await f.credentials.get(f.root.id))!.status, oldStatus);
        assert.equal(
          (await f.admissions.get(f.admitted.id))!.status,
          oldStatus,
        );
        const fresh = await f.primary.capture();
        assert.ok(fresh.source);
        const authority = projectSpaceControlAuthority(
          fresh.source,
          requestControlBinding,
          "owner",
        );
        await f.credentials.insert(
          { ...pending, authority },
          fresh.adoptedState,
        );
        assert.equal((await f.credentials.get(pending.id))!.status, "active");
        assert.equal((await f.credentials.get(f.root.id))!.status, oldStatus);
        assert.equal(
          (await f.admissions.get(f.admitted.id))!.status,
          oldStatus,
        );
      });
    },
  });
}
