import assert from "node:assert/strict";
import {
  PostgresMigrationsPendingError,
  requirePostgresMigrations,
} from "../../src/adapters/out/postgres/migration-readiness.ts";
import { PostgresEvolutionStore } from "../../src/adapters/out/postgres/evolution-store.ts";
import type { EvolutionDossier } from "../../src/application/model/evolution/ports.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import {
  postgresQualifiedTable,
  Prisma,
} from "../../src/adapters/out/postgres/client.ts";
import {
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";

Deno.test({
  name: "backend migration preflight checks its own schema before startup",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      // The fixture applies SQL directly, so its isolated schema has no Prisma
      // deployment registry, regardless of any registry in the public schema.
      let pending: string[] = [];
      await assert.rejects(() => requirePostgresMigrations(client), (error) => {
        assert(error instanceof PostgresMigrationsPendingError);
        assert.equal(error.recovery, "deno task db:migrate");
        pending = error.context.pending;
        assert(pending.includes("20261102010000_request_member_adoption"));
        return true;
      });
      const registry = postgresQualifiedTable(client, "_prisma_migrations");
      await client.$executeRaw(Prisma.sql`
        CREATE TABLE ${registry} (
          migration_name TEXT NOT NULL,
          finished_at TIMESTAMPTZ,
          rolled_back_at TIMESTAMPTZ
        )
      `);
      const missing = pending.at(-1)!;
      await client.$executeRaw(Prisma.sql`
        INSERT INTO ${registry} (migration_name, finished_at)
        SELECT name, now() FROM unnest(${pending}::text[]) AS name
        WHERE name <> ${missing}
      `);
      await assert.rejects(() => requirePostgresMigrations(client), (error) => {
        assert(error instanceof PostgresMigrationsPendingError);
        assert.deepEqual(error.context, { pending: [missing], unresolved: [] });
        return true;
      });
      await client.$executeRaw(Prisma.sql`
        INSERT INTO ${registry} (migration_name, finished_at)
        VALUES (${missing}, now())
      `);
      await requirePostgresMigrations(client);
    });
  },
});

Deno.test({
  name:
    "Request adoption migration preserves populated Main v1 dossier and armed barrier",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, migrateToLatest }) => {
      const scope = {
        projectId: "migration-project",
        systemId: "migration-system",
      };
      const repositoryId = "migration-repository", operatorId = "target";
      await seedPostgresRuntime(client, {
        ...scope,
        executionSpaceId: "main",
        operatorId,
      });
      await client.sourceRepository.create({
        data: { ...scope, repositoryId, sourceScopeId: "source" },
      });
      const preparation = {
        act: "prepare" as const,
        operatorNativeId: "author",
        systemQualifiedName: "System",
        authorityDigest: "prior",
        policyId: "policy",
        policyRevision: 1,
        mandateNativeId: "mandate-native",
        mandateId: "mandate",
        mandateRevision: 1,
        targets: [operatorId],
        categories: ["flow" as const],
        proposalDigest: "proposal-digest",
      };
      const dossier: EvolutionDossier = {
        v: 1,
        id: "legacy-dossier",
        repositoryId,
        revision: 2,
        status: "armed",
        origin: { operatorId: "author", requestId: "closed" },
        finalizerActorId: "finalizer",
        accounting: {
          id: `evolution:${repositoryId}:legacy-dossier`,
          agentInvocations: 0,
        },
        createdAt: "2026-10-27T00:00:00Z",
        updatedAt: "2026-10-27T00:00:01Z",
        proposal: {
          id: "legacy-proposal",
          version: "candidate",
          baseVersion: "base",
          sourceDigest: "sources",
          recipeDigest: "recipe",
          digest: "proposal-digest",
          targets: [{
            operatorId,
            previousDigest: "old",
            candidateDigest: "new",
          }],
          categories: ["flow"],
        },
        preparation,
        acceptance: {
          ...preparation,
          act: "accept",
          operatorNativeId: "decider",
        },
        adoptionAuthorization: {
          ...preparation,
          act: "adopt",
          operatorNativeId: "finalizer",
        },
        adoptions: [],
        blockers: [],
      };
      const payload = canonical(dossier);
      const dossierTable = postgresQualifiedTable(client, "EvolutionDossier");
      const barrierTable = postgresQualifiedTable(
        client,
        "EvolutionTargetBarrier",
      );
      // Use the old physical schema, before the new columns and key exist.
      await client.$executeRaw(Prisma.sql`
        INSERT INTO ${dossierTable} ("projectId","systemId","id","repositoryId","revision","status","payload","updatedAt")
        VALUES (${scope.projectId},${scope.systemId},${dossier.id},${repositoryId},${
        BigInt(dossier.revision)
      },${dossier.status},${payload},${dossier.updatedAt})`);
      await client.$executeRaw(Prisma.sql`
        INSERT INTO ${barrierTable} ("projectId","systemId","repositoryId","operatorId","dossierId")
        VALUES (${scope.projectId},${scope.systemId},${repositoryId},${operatorId},${dossier.id})`);
      const beforeDossier = await client.$queryRaw(Prisma.sql`
        SELECT "projectId","systemId","id","repositoryId","revision","status","payload","updatedAt" FROM ${dossierTable}`);
      const beforeBarrier = await client.$queryRaw(Prisma.sql`
        SELECT "projectId","systemId","repositoryId","operatorId","dossierId" FROM ${barrierTable}`);
      await migrateToLatest();
      const afterDossier = await client.$queryRaw(Prisma.sql`
        SELECT "projectId","systemId","id","repositoryId","revision","status","payload","updatedAt" FROM ${dossierTable}`);
      const afterBarrier = await client.$queryRaw(Prisma.sql`
        SELECT "projectId","systemId","repositoryId","operatorId","dossierId" FROM ${barrierTable}`);
      assert.deepEqual(afterDossier, beforeDossier);
      assert.deepEqual(afterBarrier, beforeBarrier);
      const stored = await client.evolutionDossier.findFirstOrThrow({
        where: { ...scope, id: dossier.id },
      });
      assert.equal(stored.payload, payload);
      assert.equal(stored.updatedAt, dossier.updatedAt);
      assert.equal(stored.kind, "software-evolution-v1");
      assert.equal(stored.targetScopeKey, "main");
      assert.equal(stored.executionSpaceId, null);
      const barrier = await client.evolutionTargetBarrier.findUniqueOrThrow({
        where: {
          projectId_systemId_repositoryId_targetScopeKey_operatorId: {
            ...scope,
            repositoryId,
            targetScopeKey: "main",
            operatorId,
          },
        },
      });
      assert.equal(barrier.dossierId, dossier.id);
      assert.equal(barrier.executionSpaceId, null);
      const store = new PostgresEvolutionStore(client, scope);
      assert.deepEqual(await store.get(dossier.id), dossier);
      assert.deepEqual(await store.listPending(repositoryId), [dossier]);
      assert.equal(
        await store.targetOwner(repositoryId, operatorId),
        dossier.id,
      );
      assert.equal(await store.targetOwner(repositoryId, "other"), null);
    }, { throughMigration: "20261030010000_request_source_admission" });
  },
});

Deno.test({
  name:
    "PG-1 additive migrations retain immutable v1 bytes and admit explicit common-repository v2 pins",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, migrateToLatest }) => {
      const scope = {
        projectId: "project",
        systemId: "system",
        executionSpaceId: "space",
        operatorId: "operator",
      };
      await seedPostgresRuntime(client, scope);
      await client.sourceRepository.create({
        data: {
          projectId: "project",
          systemId: "system",
          repositoryId: "common",
          sourceScopeId: "source",
        },
      });
      const table = postgresQualifiedTable(client, "ArtifactVersion");
      const legacyContent = "b".repeat(64);
      const legacyManifest = "c".repeat(64);
      await client.$executeRaw(Prisma.sql`
        INSERT INTO ${table} ("projectId", "systemId", "versionId", "artifactId", "kind", "sourceReferenceVersion", "sourceScopeId", "repositoryId", "commitOid", "manifestPath", "entryPath", "contentDigest", "contentEncoding", "manifestDigestVersion", "manifestDigest", "publishedAt")
        VALUES ('project', 'system', 'retained-v1', 'tool', 'tool-draft', 1, 'source', 'common', ${
        "a".repeat(40)
      }, 'manifest.json', 'source.json', ${legacyContent}, 'tool-draft-json-v1', 'sha256-canonical-json-v1', ${legacyManifest}, '2026-10-27T00:00:00.000Z')
      `);
      const before = await client.$queryRaw(
        Prisma
          .sql`SELECT "versionId", "commitOid", "entryPath", "manifestPath", "contentEncoding", "contentDigest", "manifestDigest", "sourceReferenceVersion", "publishedAt" FROM ${table}`,
      );
      await migrateToLatest();
      const after = await client.$queryRaw(
        Prisma
          .sql`SELECT "versionId", "commitOid", "entryPath", "manifestPath", "contentEncoding", "contentDigest", "manifestDigest", "sourceReferenceVersion", "publishedAt" FROM ${table} WHERE "versionId" = 'retained-v1'`,
      );
      assert.deepEqual(after, before);
      assert.equal(
        (await client.artifactVersion.findFirstOrThrow()).manifestFormat,
        null,
      );
      const base = {
        projectId: "project",
        systemId: "system",
        sourceScopeId: "source",
        repositoryId: "common",
        sourceReferenceVersion: 2n,
        commitOid: "d".repeat(40),
        contentDigest: "e".repeat(64),
        manifestFormat: "assembly-artifact-package-v2",
        manifestDigestVersion: "sha256-canonical-json-v1",
        publishedAt: new Date(),
      };
      for (const kind of ["tool-draft", "skill-document"] as const) {
        const manifestDigest = (kind === "tool-draft" ? "1" : "2").repeat(64);
        await client.artifactVersion.create({
          data: {
            ...base,
            versionId: kind,
            artifactId: kind,
            kind,
            contentEncoding: kind === "tool-draft"
              ? "tool-draft-json-v1"
              : "utf8-v1",
            manifestDigest,
            manifestPath: `artifacts/${manifestDigest}/manifest.json`,
            entryPath: `artifacts/${manifestDigest}/${
              kind === "tool-draft" ? "source.json" : "SKILL.md"
            }`,
          },
        });
      }
      const tool = await client.artifactVersion.findUniqueOrThrow({
        where: {
          projectId_systemId_versionId: {
            projectId: "project",
            systemId: "system",
            versionId: "tool-draft",
          },
        },
      });
      const invalid = { ...tool, versionId: "invalid", artifactId: "invalid" };
      for (
        const changes of [
          { manifestFormat: null },
          { manifestFormat: "other-format" },
          { sourceReferenceVersion: 1n },
          { sourceScopeId: "foreign" },
          { manifestPath: "manifest.json" },
          { entryPath: "source.json" },
        ]
      ) {
        await assert.rejects(() =>
          client.artifactVersion.create({ data: { ...invalid, ...changes } })
        );
      }
      await assert.rejects(() =>
        client.artifactVersion.updateMany({
          where: { versionId: "retained-v1" },
          data: {
            sourceReferenceVersion: 2n,
            manifestFormat: "assembly-artifact-package-v2",
          },
        })
      );
      await assert.rejects(() =>
        client.artifactVersion.updateMany({
          where: { versionId: "tool-draft" },
          data: { contentDigest: "f".repeat(64) },
        })
      );
      assert.equal(await client.artifactVersion.count(), 3);
    }, { throughMigration: "20261027000000_pg1_foundation" });
  },
});

Deno.test({
  name:
    "PG-3 schema isolates equal repository and command IDs with composite foreign keys",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      const scopes = [
        { projectId: "a", systemId: "same", repositoryId: "repository" },
        { projectId: "b", systemId: "same", repositoryId: "repository" },
        { projectId: "a", systemId: "other", repositoryId: "repository" },
      ];
      for (const scope of scopes) {
        await seedPostgresRuntime(client, {
          projectId: scope.projectId,
          systemId: scope.systemId,
          executionSpaceId: "space",
          operatorId: "operator",
        });
        await client.sourceRepository.create({
          data: { ...scope, sourceScopeId: "source" },
        });
        await client.modelWriteRepositoryHead.create({ data: scope });
        await client.modelWriteCommand.create({
          data: {
            ...scope,
            commandId: "command",
            seq: 1n,
            commandDigest: "a".repeat(64),
            dossierDigest: "b".repeat(64),
            commandJson: "immutable command bytes",
            dossierJson: "immutable dossier bytes",
            state: "queued",
            enqueuedAt: new Date(),
            updatedAt: new Date(),
          },
        });
      }
      assert.equal(await client.modelWriteRepositoryHead.count(), 3);
      assert.equal(await client.modelWriteCommand.count(), 3);
      await assert.rejects(() =>
        client.modelWriteRepositoryHead.create({
          data: {
            projectId: "b",
            systemId: "other",
            repositoryId: "repository",
          },
        })
      );
      await assert.rejects(() =>
        client.modelWriteCommand.updateMany({
          where: scopes[0],
          data: { commandJson: "changed" },
        })
      );
      await assert.rejects(() =>
        client.modelWriteRepositoryHead.updateMany({
          where: scopes[0],
          data: { nextSeq: 9007199254740992n },
        })
      );
      await client.modelWriteCommand.updateMany({
        where: scopes[0],
        data: { state: "retryable", fence: 1n, attempts: 1n },
      });
      assert.equal(
        (await client.modelWriteCommand.findFirstOrThrow({ where: scopes[0] }))
          .state,
        "retryable",
      );
    });
  },
});
