/** Owned PostgreSQL store qualification only. Models, grants and admitted A1
 * bytes are synthetic fixture facts; no execution permission/native effect is
 * inferred and no worker, Toolkit or source publication is constructed. */
import assert from "node:assert/strict";
import { Client } from "pg";
import { PostgresEvolutionStore } from "../../src/adapters/out/postgres/evolution-store.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import type {
  Prisma,
  PrismaClient,
} from "../../src/adapters/out/postgres/client.ts";
import type { EvolutionDossier } from "../../src/application/model/evolution/ports.ts";
import type { RequestOwnerAdoptionDossier } from "../../src/application/model/evolution/request-adoption-ports.ts";
import { parseRequestOwnerAdoptionDossier } from "../../src/application/model/evolution/request-adoption-invariants.ts";
import { createScopedSoftwareDossier } from "../../src/application/model/evolution/scoped-software-dossier.ts";
import { parseScopedSoftwareContext } from "../../src/application/model/evolution/scoped-software-context.ts";
import {
  parseScopedSoftwareProposal,
  scopedSoftwareProposalDigest,
} from "../../src/application/model/evolution/scoped-software-proposal.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { sha256 } from "../../src/domain/primitives/execution-digest.ts";
import { savedManifest } from "../../src/domain/work/records/saved-systems.ts";
import { type OpeningRecord } from "../../src/domain/work/request-spaces/opening.ts";
import { requestSpaceDigest } from "../../src/domain/work/request-spaces/scope.ts";
import { requestAdoptionFixture } from "../support/request-adoption-fixture.ts";
import {
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";

const pending = [
  "prepared",
  "accepted",
  "armed",
  "publishing",
  "published-awaiting-adoption",
];
const at = "2026-10-30T00:00:00.000Z";
function software(
  id: string,
  repositoryId: string,
  operatorId: string,
  updatedAt = at,
): EvolutionDossier {
  const proposal = {
    id: `proposal-${id}`,
    version: "candidate",
    baseVersion: "base",
    sourceDigest: "sources",
    recipeDigest: "recipe",
    digest: `exact-${id}`,
    targets: [{ operatorId, previousDigest: "old", candidateDigest: "new" }],
    categories: ["instructions" as const],
  };
  return {
    v: 1,
    id,
    repositoryId,
    revision: 0,
    status: "prepared",
    origin: { operatorId: "author", requestId: "historical-source" },
    finalizerActorId: "finalizer",
    accounting: { id: `evolution:${repositoryId}:${id}`, agentInvocations: 0 },
    createdAt: at,
    updatedAt,
    proposal,
    preparation: {
      act: "prepare",
      operatorNativeId: "author",
      systemQualifiedName: "System",
      authorityDigest: "prior",
      policyId: "policy",
      policyRevision: 1,
      mandateNativeId: "mandate-native",
      mandateId: "mandate",
      mandateRevision: 1,
      targets: [operatorId],
      categories: ["instructions"],
      proposalDigest: proposal.digest,
    },
    adoptions: [],
    blockers: [],
  };
}
async function armMain(store: PostgresEvolutionStore, d: EvolutionDossier) {
  await store.create(d);
  const accepted = await store.compareAndSwap(d.id, 0, {
    ...d,
    revision: 1,
    status: "accepted",
    acceptance: {
      ...d.preparation,
      act: "accept",
      operatorNativeId: "decider",
    },
  });
  return await store.compareAndSwap(d.id, 1, {
    ...accepted,
    revision: 2,
    status: "armed",
    adoptionAuthorization: {
      ...d.preparation,
      act: "adopt",
      operatorNativeId: "finalizer",
    },
  });
}
async function setup(client: PrismaClient) {
  const f = await requestAdoptionFixture(),
    scope = f.target.host,
    operatorId = f.target.operatorId,
    repositoryId = f.target.repositoryId;
  await seedPostgresRuntime(client, {
    ...scope,
    executionSpaceId: "main",
    operatorId,
  });
  await client.sourceRepository.create({
    data: { ...scope, repositoryId, sourceScopeId: "store-fixture-source" },
  });
  const authority = f.decision.controller.authority;
  await client.spaceControlCredential.createMany({
    data: [
      {
        ...scope,
        id: f.decision.controller.capabilityId,
        kind: "capability",
        ownerId: f.decision.controller.ownerId,
        parentCapabilityId: null,
        parentKind: null,
        authorityJson: canonical(authority),
        secretHash: "a".repeat(64),
        revision: f.decision.controller.capabilityRevision,
        status: "active",
        expiresAt: new Date(f.intent.previous.admission.expiresAt),
        createdAt: new Date(at),
      },
      {
        ...scope,
        id: f.decision.controller.sessionId,
        kind: "session",
        ownerId: f.decision.controller.ownerId,
        parentCapabilityId: f.decision.controller.capabilityId,
        parentKind: "capability",
        authorityJson: canonical(authority),
        secretHash: "b".repeat(64),
        revision: f.decision.sessionRevision,
        status: "active",
        expiresAt: new Date(f.intent.previous.admission.expiresAt),
        createdAt: new Date(at),
      },
    ],
  });
  const manifest = savedManifest({
    origin: { ...scope, executionSpaceId: "main" },
    source: {
      branch: { kind: "main" },
      sourceVersion: f.previous.version.repositoryVersion!,
      repositoryId,
      branchRef: "refs/heads/admitted",
      admittedHeadVersion: f.previous.version.repositoryVersion!,
      sourceDigest: "1".repeat(64),
    },
    registeredOperatorIds: [operatorId],
    operators: [{
      operatorId,
      repositoryVersion: f.previous.version.repositoryVersion!,
      modelDigest: f.previous.version.digest,
      nativeSystemId: f.previous.identity.systemId,
      settingsDigest: "fixture-settings",
      sourceDigest: "1".repeat(64),
      build: null,
      tools: [],
    }],
    prerequisites: [],
  });
  const base = {
    sourceKind: "current-main" as const,
    manifest,
    manifestDigest: await requestSpaceDigest(manifest),
    requestOwner: { operatorId, caseTypeId: "request-type" },
  };
  const baseDigest = await requestSpaceDigest(base),
    openings = new PostgresRequestSpaceStore(client, scope);
  const allocated: OpeningRecord[] = [];
  for (const name of ["A", "B"]) {
    const command = {
      openingKey: `store-${name}`,
      text: `Store-only Request ${name}`,
      source: { kind: "current-main" as const },
    };
    const fresh = await openings.begin({
      ownerId: f.decision.controller.ownerId,
      command,
      commandDigest: await requestSpaceDigest({
        scope,
        ownerId: f.decision.controller.ownerId,
        command,
      }),
    });
    let opening = await openings.selectBase({
      id: fresh.id,
      ownerId: fresh.ownerId,
      expectedRevision: fresh.revision,
      base,
      baseDigest,
    });
    // Real operational/native-owner row; no RuntimeState/graph is fabricated.
    await client.operatorRuntime.create({
      data: {
        ...scope,
        executionSpaceId: opening.executionSpaceId,
        operatorId,
      },
    });
    const admission = {
      ...f.intent.previous.admission,
      id: `store-admission-${opening.id}`,
      openingId: opening.id,
      executionSpaceId: opening.executionSpaceId,
      baseDigest,
    };
    await client.spaceExecutionAdmission.create({
      data: {
        ...scope,
        id: admission.id,
        openingId: opening.id,
        executionSpaceId: opening.executionSpaceId,
        ownerId: admission.ownerId,
        capabilityId: admission.capabilityId,
        capabilityRevision: admission.capabilityRevision,
        baseDigest,
        authorityJson: canonical(admission.authority),
        permissionsJson: canonical(admission.permissions),
        revision: admission.revision,
        status: admission.status,
        expiresAt: new Date(admission.expiresAt),
        createdAt: new Date(admission.createdAt),
      },
    });
    await client.spaceOpening.update({
      where: { id: opening.id },
      data: { admissionId: admission.id, revision: opening.revision + 1 },
    });
    opening = (await openings.get(opening.id))!;
    allocated.push(opening);
  }
  async function request(
    opening: OpeningRecord,
    key: string,
    updatedAt = at,
  ): Promise<RequestOwnerAdoptionDossier> {
    const target = {
      ...f.target,
      openingId: opening.id,
      executionSpaceId: opening.executionSpaceId,
      caseId: opening.caseId,
      branchId: opening.branchId,
      ref: `refs/heads/requests/${opening.branchId}`,
    };
    const immutable = {
      target,
      openingBaseDigest: baseDigest,
      adoptionKey: key,
      previous: {
        ...f.intent.previous,
        pin: {
          ...f.intent.previous.pin,
          sourceAdmission: { revision: 1, manifestDigest: base.manifestDigest },
        },
        admission: {
          ...f.intent.previous.admission,
          id: opening.admissionId!,
          openingId: opening.id,
          executionSpaceId: opening.executionSpaceId,
          baseDigest,
        },
      },
      candidate: f.intent.candidate,
      decision: f.decision,
    };
    const id = `request-adoption:${await sha256(
      canonical({
        host: scope,
        ownerId: opening.ownerId,
        openingId: opening.id,
        adoptionKey: key,
      }),
    )}`;
    return await parseRequestOwnerAdoptionDossier({
      v: 2,
      kind: "request-owner-adoption",
      id,
      repositoryId,
      revision: 0,
      status: "prepared",
      createdAt: at,
      updatedAt,
      intent: {
        ...immutable,
        commandDigest: await sha256(canonical(immutable)),
        accountingDigest: await sha256(
          canonical({
            id: `evolution:${repositoryId}:${id}`,
            agentInvocations: 0,
          }),
        ),
      },
      blockers: [],
    });
  }
  return {
    scope,
    repositoryId,
    operatorId,
    A: allocated[0],
    B: allocated[1],
    request,
  };
}
function requestRow(
  scope: { projectId: string; systemId: string },
  d: RequestOwnerAdoptionDossier,
): Prisma.EvolutionDossierCreateManyInput {
  return {
    ...scope,
    id: d.id,
    repositoryId: d.repositoryId,
    revision: BigInt(d.revision),
    status: d.status,
    updatedAt: d.updatedAt,
    payload: canonical(d),
    kind: "request-owner-adoption-v2",
    targetScopeKey: `request:${d.intent.target.executionSpaceId}`,
    executionSpaceId: d.intent.target.executionSpaceId,
  };
}
function mainRow(
  scope: { projectId: string; systemId: string },
  d: EvolutionDossier,
): Prisma.EvolutionDossierCreateManyInput {
  return {
    ...scope,
    id: d.id,
    repositoryId: d.repositoryId,
    revision: BigInt(d.revision),
    status: d.status,
    updatedAt: d.updatedAt,
    payload: canonical(d),
    kind: "software-evolution-v1",
    targetScopeKey: "main",
    executionSpaceId: null,
  };
}

Deno.test({
  name:
    "PG Request adoption store isolates Main and two Request barriers sharing one native operator",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      const f = await setup(client),
        store = new PostgresEvolutionStore(client, f.scope);
      const main = await armMain(
        store,
        software("main-barrier", f.repositoryId, f.operatorId),
      );
      const preparedA = await f.request(f.A, "barrier-A"),
        preparedB = await f.request(f.B, "barrier-B");
      await store.requestAdoptions.create(preparedA.intent.target, preparedA);
      await store.requestAdoptions.create(preparedB.intent.target, preparedB);
      const arm = async (d: RequestOwnerAdoptionDossier) =>
        await store.requestAdoptions.compareAndSwap(d.intent.target, d.id, 0, {
          ...d,
          revision: 1,
          status: "armed",
          completion: d.intent.decision,
        });
      const A = await arm(preparedA), B = await arm(preparedB);
      const reopened = new PostgresEvolutionStore(createClient(), f.scope);
      const owners = async () => [
        await reopened.targetOwner(f.repositoryId, f.operatorId),
        await reopened.requestAdoptions.targetOwner(A.intent.target),
        await reopened.requestAdoptions.targetOwner(B.intent.target),
      ];
      assert.deepEqual(await owners(), [main.id, A.id, B.id]);
      const rows = await client.evolutionTargetBarrier.findMany({
        where: {
          ...f.scope,
          repositoryId: f.repositoryId,
          operatorId: f.operatorId,
        },
        orderBy: { targetScopeKey: "asc" },
      });
      assert.equal(rows.length, 3);
      assert.deepEqual(
        new Set(rows.map((row) => row.targetScopeKey)),
        new Set([
          "main",
          `request:${f.A.executionSpaceId}`,
          `request:${f.B.executionSpaceId}`,
        ]),
      );
      await store.requestAdoptions.compareAndSwap(
        A.intent.target,
        A.id,
        A.revision,
        { ...A, revision: A.revision + 1, status: "cancelled" },
      );
      assert.deepEqual(await owners(), [main.id, null, B.id]);
      await store.compareAndSwap(main.id, main.revision, {
        ...main,
        revision: main.revision + 1,
        status: "cancelled",
        cancellation: main.acceptance,
      });
      assert.deepEqual(await owners(), [null, null, B.id]);
      await store.requestAdoptions.compareAndSwap(
        B.intent.target,
        B.id,
        B.revision,
        { ...B, revision: B.revision + 1, status: "cancelled" },
      );
      assert.deepEqual(await owners(), [null, null, null]);
      assert.equal(await reopened.get(A.id), null);
      assert.equal(
        await reopened.requestAdoptions.get(A.intent.target, main.id),
        null,
      );
      assert.equal(
        await reopened.requestAdoptions.get(B.intent.target, A.id),
        null,
      );
      // DB metadata consistency refuses a cross-Request rewrite; valid row survives.
      await assert.rejects(() =>
        client.evolutionDossier.updateMany({
          where: { ...f.scope, id: A.id },
          data: {
            executionSpaceId: f.B.executionSpaceId,
            targetScopeKey: `request:${f.B.executionSpaceId}`,
          },
        })
      );
      assert.equal(
        (await reopened.requestAdoptions.get(A.intent.target, A.id))?.status,
        "cancelled",
      );
    });
  },
});

Deno.test({
  name:
    "PG mixed Main and Request pending255 final slot races across independent clients under one repository cap",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const { client, createClient, schema } = database,
        f = await setup(client),
        data: Prisma.EvolutionDossierCreateManyInput[] = [];
      for (let i = 0; i < 128; i++) {
        data.push(
          mainRow(
            f.scope,
            software(`seed-main-${i}`, f.repositoryId, f.operatorId),
          ),
        );
      }
      for (let i = 0; i < 127; i++) {
        data.push(
          requestRow(
            f.scope,
            await f.request(i % 2 ? f.A : f.B, `seed-request-${i}`),
          ),
        );
      }
      await client.evolutionDossier.createMany({ data });
      assert.equal(
        await client.evolutionDossier.count({
          where: {
            ...f.scope,
            repositoryId: f.repositoryId,
            status: { in: pending },
          },
        }),
        255,
      );
      const left = new PostgresEvolutionStore(createClient(), f.scope),
        right = new PostgresEvolutionStore(createClient(), f.scope);
      const main = software("final-main", f.repositoryId, f.operatorId),
        request = await f.request(f.A, "final-request");
      const blocker = new Client({
        connectionString: database.connectionString,
        connectionTimeoutMillis: 5000,
      });
      await blocker.connect();
      database.registerCleanup(async () => {
        try {
          await blocker.query("ROLLBACK");
        } finally {
          await blocker.end();
        }
      });
      const observer = new Client({
        connectionString: database.connectionString,
        connectionTimeoutMillis: 5000,
      });
      database.registerCleanup(() => observer.end());
      await observer.connect();
      await blocker.query("BEGIN");
      const held = await blocker.query(
        `SELECT "repositoryId" FROM "${schema}"."SourceRepository" WHERE "projectId"=$1 AND "systemId"=$2 AND "repositoryId"=$3 FOR UPDATE`,
        [f.scope.projectId, f.scope.systemId, f.repositoryId],
      );
      assert.equal(held.rowCount, 1);
      type EarlyResult = { index: number; status: "fulfilled" } | {
        index: number;
        status: "rejected";
        reason: unknown;
      };
      const early: EarlyResult[] = [];
      const attempts = [
        left.create(main),
        right.requestAdoptions.create(request.intent.target, request),
      ].map((attempt, index) =>
        attempt.then((value) => {
          early.push({ index, status: "fulfilled" });
          return value;
        }, (reason: unknown) => {
          early.push({ index, status: "rejected", reason });
          throw reason;
        })
      );
      const settled = Promise.allSettled(attempts);
      const assertContendersStillWaiting = () => {
        const completed = early[0];
        if (completed?.status === "rejected") {
          throw new Error(
            `${
              completed.index === 0 ? "Main" : "Request"
            } final-slot contender rejected before both reached repository exclusion`,
            { cause: completed.reason },
          );
        }
        assert.equal(
          early.length,
          0,
          "A final-slot create completed while the exact repository row was held",
        );
      };
      const end = Date.now() + 10000;
      let blocked = 0, observationError: unknown;
      try {
        while (Date.now() < end) {
          assertContendersStillWaiting();
          // PostgreSQL caches current-query information within a transaction.
          // This separate observer never BEGINs: each poll gets a fresh view.
          // https://www.postgresql.org/docs/17/monitoring-stats.html
          const observed = await observer.query<{ count: string }>(
            `SELECT count(DISTINCT pid)::text AS count FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock' AND query LIKE $1`,
            [`%"${schema}"."SourceRepository"%`],
          );
          blocked = Number(observed.rows[0].count);
          assertContendersStillWaiting();
          if (blocked === 2) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        // The owned schema contains one repository row and the holder above
        // owns it. The second waiter may queue behind the first tuple waiter;
        // requiring both to name the holder directly would reject that ordering.
        assert.equal(
          blocked,
          2,
          "Both independent client transactions must contend on the same repository row",
        );
      } catch (error) {
        observationError = error;
      } finally {
        await blocker.query("COMMIT");
      }
      const results = await settled;
      if (observationError !== undefined) throw observationError;
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const failure = results.find((result) => result.status === "rejected");
      assert(failure?.status === "rejected");
      assert.equal(failure.reason.code, "EVOLUTION_STORE_FULL");
      assert.equal(
        await client.evolutionDossier.count({
          where: {
            ...f.scope,
            repositoryId: f.repositoryId,
            status: { in: pending },
          },
        }),
        256,
      );
      assert.equal(
        await client.evolutionDossier.count({
          where: { ...f.scope, id: { in: [main.id, request.id] } },
        }),
        1,
      );
      const counts = await client.evolutionDossier.groupBy({
        by: ["kind"],
        where: {
          ...f.scope,
          repositoryId: f.repositoryId,
          status: { in: pending },
        },
        _count: { _all: true },
      });
      assert.equal(counts.length, 2);
      assert.equal(counts.reduce((sum, row) => sum + row._count._all, 0), 256);
    });
  },
});

Deno.test({
  name:
    "PG typed recent pagination filters nonempty Main and each Request before take and lexical ties",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      const f = await setup(client),
        store = new PostgresEvolutionStore(client, f.scope);
      const main = [
        software(
          "main-a",
          f.repositoryId,
          f.operatorId,
          "2026-10-30T00:20:00.000Z",
        ),
        software(
          "main-b",
          f.repositoryId,
          f.operatorId,
          "2026-10-30T00:20:00.000Z",
        ),
      ];
      const A = await Promise.all([
        f.request(f.A, "A-tie-a", "2026-10-30T00:10:00.000Z"),
        f.request(f.A, "A-tie-b", "2026-10-30T00:10:00.000Z"),
      ]);
      const B = await Promise.all([
        f.request(f.B, "B-tie-a", "2026-10-30T00:30:00.000Z"),
        f.request(f.B, "B-tie-b", "2026-10-30T00:30:00.000Z"),
      ]);
      for (const d of main) await store.create(d);
      for (const d of [...A, ...B]) {
        await store.requestAdoptions.create(d.intent.target, d);
      }
      const reopened = new PostgresEvolutionStore(createClient(), f.scope);
      assert.deepEqual(
        (await reopened.listRecent(f.repositoryId, 1)).map((d) => d.id),
        [main[0].id],
      );
      const aIds = A.map((d) => d.id).sort();
      assert.deepEqual(
        (await reopened.requestAdoptions.listRecent(A[0].intent.target, 1)).map(
          (d) => d.id,
        ),
        aIds.slice(0, 1),
      );
      assert.deepEqual(
        (await reopened.requestAdoptions.listRecent(A[0].intent.target, 2)).map(
          (d) => d.id,
        ),
        aIds,
      );
      const pressureMain = software(
        "main-newer-pressure",
        f.repositoryId,
        f.operatorId,
        "2026-10-30T00:40:00.000Z",
      );
      const pressureA = await f.request(
        f.A,
        "A-newer-pressure",
        "2026-10-30T00:50:00.000Z",
      );
      await store.create(pressureMain);
      await store.requestAdoptions.create(pressureA.intent.target, pressureA);
      const bIds = B.map((d) => d.id).sort();
      assert.deepEqual(
        (await reopened.requestAdoptions.listRecent(B[0].intent.target, 1)).map(
          (d) => d.id,
        ),
        bIds.slice(0, 1),
      );
      assert.deepEqual(
        (await reopened.requestAdoptions.listRecent(B[0].intent.target, 2)).map(
          (d) => d.id,
        ),
        bIds,
      );
      assert.equal((await reopened.listPending(f.repositoryId)).length, 3);
      assert.equal(
        (await reopened.requestAdoptions.listPending(A[0].intent.target))
          .length,
        3,
      );
      assert.equal(
        (await reopened.requestAdoptions.listPending(B[0].intent.target))
          .length,
        2,
      );
    });
  },
});

Deno.test({
  name:
    "PG admission guard refuses naked pin, scope, rights and lifetime mutations while preserving revoke",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      const f = await setup(client);
      const id = f.A.admissionId!;
      const original = await client.spaceExecutionAdmission.findUniqueOrThrow({
        where: { id },
      });
      const permissions = JSON.parse(original.permissionsJson) as Record<
        string,
        unknown
      >;
      const advancedPin = {
        ...permissions,
        sourceVersion: `commit:${"9".repeat(40)}`,
        modelDigests: ["8".repeat(64)],
      };
      // A second valid capability for the same owner ensures the FK cannot be
      // the reason a capability substitution is refused.
      const capability = await client.spaceControlCredential.findUniqueOrThrow({
        where: { id: original.capabilityId },
      });
      await client.spaceControlCredential.create({
        data: {
          ...f.scope,
          id: "other-capability",
          kind: "capability",
          ownerId: capability.ownerId,
          parentCapabilityId: null,
          parentKind: null,
          authorityJson: capability.authorityJson,
          secretHash: "d".repeat(64),
          revision: capability.revision,
          status: "active",
          expiresAt: capability.expiresAt,
          createdAt: capability.createdAt,
        },
      });
      const attempts: Array<
        { label: string; data: Prisma.SpaceExecutionAdmissionUpdateInput }
      > = [
        {
          label: "naked pin advance without journal proof",
          data: {
            permissionsJson: canonical(advancedPin),
            revision: original.revision + 1,
          },
        },
        {
          label: "revision-only active update",
          data: { revision: original.revision + 1 },
        },
        {
          label: "rights widened on revoke",
          data: {
            status: "revoked",
            revision: original.revision + 1,
            permissionsJson: canonical({
              ...permissions,
              acts: ["conversation", "other"],
            }),
          },
        },
        {
          label: "resources widened on revoke",
          data: {
            status: "revoked",
            revision: original.revision + 1,
            permissionsJson: canonical({
              ...permissions,
              resourceIds: ["resource"],
            }),
          },
        },
        {
          label: "operator widened on revoke",
          data: {
            status: "revoked",
            revision: original.revision + 1,
            permissionsJson: canonical({
              ...permissions,
              operatorIds: [f.operatorId, "other"],
            }),
          },
        },
        {
          label: "expiry extended on revoke",
          data: {
            status: "revoked",
            revision: original.revision + 1,
            expiresAt: new Date(original.expiresAt.getTime() + 1000),
          },
        },
        {
          label: "authority changed on revoke",
          data: {
            status: "revoked",
            revision: original.revision + 1,
            authorityJson: canonical({ altered: true }),
          },
        },
        {
          label: "capability revision changed on revoke",
          data: {
            status: "revoked",
            revision: original.revision + 1,
            capabilityRevision: original.capabilityRevision + 1,
          },
        },
        {
          label: "base changed on revoke",
          data: {
            status: "revoked",
            revision: original.revision + 1,
            baseDigest: "7".repeat(64),
          },
        },
      ];
      for (const attempt of attempts) {
        await assert.rejects(
          () =>
            client.spaceExecutionAdmission.update({
              where: { id },
              data: attempt.data,
            }),
          (error: unknown) =>
            error instanceof Error &&
            (attempt.label === "naked pin advance without journal proof"
              ? error.message.includes(
                "Admission pin advance requires its exact current-transaction runtime adoption proof",
              )
              : error.message.includes("Immutable space execution admission")),
          attempt.label,
        );
        assert.deepEqual(
          await client.spaceExecutionAdmission.findUniqueOrThrow({
            where: { id },
          }),
          original,
          attempt.label,
        );
      }
      // A raw update changes the scalar FK while preserving a valid referenced
      // capability; the trigger must reject it independently of FK integrity.
      await assert.rejects(() =>
        client
          .$executeRaw`UPDATE "SpaceExecutionAdmission" SET "capabilityId"=${"other-capability"}, "status"=${"revoked"}, "revision"=${
          original.revision + 1
        } WHERE "id"=${id}`
      );
      assert.deepEqual(
        await client.spaceExecutionAdmission.findUniqueOrThrow({
          where: { id },
        }),
        original,
      );
      const revoked = await client.spaceExecutionAdmission.update({
        where: { id },
        data: { status: "revoked", revision: original.revision + 1 },
      });
      assert.deepEqual(revoked, {
        ...original,
        status: "revoked",
        revision: original.revision + 1,
      });
      await assert.rejects(() =>
        client.spaceExecutionAdmission.update({
          where: { id },
          data: {
            status: "active",
            revision: revoked.revision + 1,
            permissionsJson: canonical(advancedPin),
          },
        })
      );
      assert.deepEqual(
        await client.spaceExecutionAdmission.findUniqueOrThrow({
          where: { id },
        }),
        revoked,
      );
    });
  },
});

Deno.test({
  name:
    "PG software and human Request dossiers share barriers while exact spaces remain isolated",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      const f = await setup(client),
        store = new PostgresEvolutionStore(client, f.scope);
      const humanA = await f.request(f.A, "human-A"),
        humanB = await f.request(f.B, "human-B");
      const make = async (
        human: RequestOwnerAdoptionDossier,
        commandId: string,
      ) => {
        const { operatorId, ...locator } = human.intent.target;
        const actor = {
          ...f.scope,
          executionSpaceId: locator.executionSpaceId,
          operatorId,
        };
        const context = parseScopedSoftwareContext({
          format: "software-evolution-scope/v2",
          destination: {
            ...locator,
            expectedAdmittedSource: {
              revision: 1,
              source: human.intent.previous.pin.source,
              sourceDigest: "1".repeat(64),
            },
          },
          openingBaseDigest: human.intent.openingBaseDigest,
          predecessorManifestDigest:
            human.intent.previous.pin.sourceAdmission.manifestDigest,
          actor,
          targets: [{ target: actor, previousPin: human.intent.previous.pin }],
        });
        const scoped = parseScopedSoftwareProposal({
          format: "software-evolution-scoped/v2",
          context,
          sourceAssessmentDigest: "a".repeat(64),
          targets: [{
            target: actor,
            candidateDigest: human.intent.candidate.model.version.digest,
          }],
          categories: ["instructions"],
        });
        const digest = await scopedSoftwareProposalDigest(scoped);
        const id = `software-evolution-scoped:${await sha256(
          canonical({
            format: "software-evolution-id/v2",
            host: f.scope,
            repositoryId: f.repositoryId,
            preparer: actor,
            callerCommandId: commandId,
          }),
        )}`;
        const draft = software(id, f.repositoryId, operatorId);
        draft.origin = { operatorId };
        draft.finalizerActorId = operatorId;
        draft.proposal = {
          ...draft.proposal,
          baseVersion: human.intent.previous.pin.source.version,
          version: human.intent.candidate.source.version,
          sourceDigest: human.intent.candidate.sourceDigest,
          recipeDigest: human.intent.candidate.build.recipe.digest,
          digest,
          scoped,
          targets: [{
            operatorId,
            previousDigest: human.intent.previous.pin.modelDigest,
            candidateDigest: human.intent.candidate.model.version.digest,
          }],
        };
        draft.preparation = {
          ...draft.preparation,
          operatorNativeId: operatorId,
          proposalDigest: digest,
        };
        return await createScopedSoftwareDossier(draft, scoped, {
          callerCommandId: commandId,
          callerCommandDigest: "b".repeat(64),
        });
      };
      const softwareA = await make(humanA, "native-effect-A"),
        softwareB = await make(humanB, "native-effect-B");
      const facadeA = store.scopedSoftware(softwareA.scope),
        facadeB = store.scopedSoftware(softwareB.scope);
      await store.requestAdoptions.create(humanA.intent.target, humanA);
      await store.requestAdoptions.create(humanB.intent.target, humanB);
      await facadeA.create(softwareA);
      await facadeB.create(softwareB);
      await store.requestAdoptions.compareAndSwap(
        humanA.intent.target,
        humanA.id,
        0,
        {
          ...humanA,
          revision: 1,
          status: "armed",
          completion: humanA.intent.decision,
        },
      );
      const accept = async (facade: typeof facadeA, d: typeof softwareA) =>
        await facade.compareAndSwap(d.id, 0, {
          ...d,
          revision: 1,
          status: "accepted",
          acceptance: { ...d.preparation, act: "accept" },
        });
      const acceptedA = await accept(facadeA, softwareA),
        acceptedB = await accept(facadeB, softwareB);
      assert.equal(acceptedA.status, "accepted");
      assert.equal(
        await facadeA.targetOwner(f.repositoryId, f.operatorId),
        humanA.id,
        "An unarmed software dossier must not claim or release the human barrier",
      );
      const arm = (d: typeof softwareA) => ({
        ...d,
        revision: 2,
        status: "armed" as const,
        adoptionAuthorization: { ...d.preparation, act: "adopt" as const },
      });
      await assert.rejects(
        () => facadeA.compareAndSwap(acceptedA.id, 1, arm(acceptedA)),
        /reserved|pending/i,
      );
      const armedB = await facadeB.compareAndSwap(
        acceptedB.id,
        1,
        arm(acceptedB),
      );
      await assert.rejects(
        () =>
          store.requestAdoptions.compareAndSwap(
            humanB.intent.target,
            humanB.id,
            0,
            {
              ...humanB,
              revision: 1,
              status: "armed",
              completion: humanB.intent.decision,
            },
          ),
        /reserved|pending/i,
      );
      const reopened = new PostgresEvolutionStore(createClient(), f.scope);
      assert.equal(
        await reopened.scopedSoftware(softwareA.scope).targetOwner(
          f.repositoryId,
          f.operatorId,
        ),
        humanA.id,
      );
      assert.equal(
        await reopened.requestAdoptions.targetOwner(humanB.intent.target),
        armedB.id,
      );
      assert.equal(
        await reopened.scopedSoftware(softwareB.scope).get(softwareA.id),
        null,
      );
      assert.equal(
        (await reopened.scopedSoftware(softwareB.scope).get(softwareB.id))
          ?.status,
        "armed",
      );
      const barriers = await client.evolutionTargetBarrier.findMany({
        where: {
          ...f.scope,
          repositoryId: f.repositoryId,
          operatorId: f.operatorId,
        },
      });
      assert.equal(barriers.length, 2);
      assert.deepEqual(
        new Set(barriers.map((row) => row.dossierId)),
        new Set([humanA.id, softwareB.id]),
      );
    });
  },
});

Deno.test({
  name:
    "PG admission trigger rolls back forged scoped software proof and pin update together",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      const f = await setup(client), admissionId = f.A.admissionId!;
      const admission = await client.spaceExecutionAdmission.findUniqueOrThrow({
        where: { id: admissionId },
      });
      const before = JSON.parse(admission.permissionsJson);
      const changed = {
        ...before,
        sourceVersion: `commit:${"e".repeat(40)}`,
        modelDigests: ["e".repeat(64)],
      };
      const prior = await client.spaceManifest.findFirst({
        where: { ...f.scope, executionSpaceId: f.A.executionSpaceId },
        orderBy: { revision: "desc" },
      });
      const revision = (prior?.revision ?? 0n) + 1n;
      const payload = canonical({
        format: "request-software-runtime-adoption/v2",
        dossierId: "missing-dossier",
        authorizationRuntimeRevision: 2,
        committedRuntimeRevision: 3,
      });
      const digest = await sha256(payload);
      await assert.rejects(
        () =>
          client.$transaction(async (tx) => {
            await tx.spaceManifest.create({
              data: {
                ...f.scope,
                executionSpaceId: f.A.executionSpaceId,
                revision,
                kind: "runtime-adoption",
                payload,
                digest,
              },
            });
            await tx.spaceExecutionAdmission.update({
              where: { id: admissionId },
              data: {
                revision: admission.revision + 1,
                permissionsJson: canonical(changed),
              },
            });
          }),
        /Admission pin advance requires its exact current-transaction runtime adoption proof/,
      );
      assert.equal(
        await client.spaceManifest.findUnique({
          where: {
            projectId_systemId_executionSpaceId_revision: {
              ...f.scope,
              executionSpaceId: f.A.executionSpaceId,
              revision,
            },
          },
        }),
        null,
      );
      const after = await client.spaceExecutionAdmission.findUniqueOrThrow({
        where: { id: admissionId },
      });
      assert.equal(after.revision, admission.revision);
      assert.equal(after.permissionsJson, admission.permissionsJson);
    });
  },
});
