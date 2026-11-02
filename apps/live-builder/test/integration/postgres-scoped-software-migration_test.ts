/** Upgrade the actual pre-lot schema with retained legacy bytes. No runtime
 * adoption, source publication or authority qualification is inferred. */
import assert from "node:assert/strict";
import {
  postgresQualifiedTable,
  Prisma,
} from "../../src/adapters/out/postgres/client.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import {
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";

Deno.test({
  name: "scoped software migrations preserve m400 guard and preexisting bytes",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, schema, migrateToLatest }) => {
      const host = { projectId: "upgrade-project", systemId: "upgrade-system" };
      const repositoryId = "upgrade-repository", operatorId = "old-operator";
      await seedPostgresRuntime(client, {
        ...host,
        executionSpaceId: "main",
        operatorId,
      });
      await client.sourceRepository.create({
        data: { ...host, repositoryId, sourceScopeId: "legacy-source" },
      });
      const dossiers = postgresQualifiedTable(client, "EvolutionDossier");
      const barriers = postgresQualifiedTable(client, "EvolutionTargetBarrier");
      const saves = postgresQualifiedTable(client, "SavedSystem");
      // A v1 payload may be corrupt and must not be cast/repainted by upgrade.
      const opaque = "legacy bytes not valid JSON";
      await client.$executeRaw(
        Prisma
          .sql`INSERT INTO ${dossiers} ("projectId","systemId","id","repositoryId","kind","targetScopeKey","executionSpaceId","revision","status","payload","updatedAt") VALUES (${host.projectId},${host.systemId},'legacy',${repositoryId},'software-evolution-v1','main',NULL,2,'armed',${opaque},'2026-10-30T00:00:00Z')`,
      );
      await client.$executeRaw(
        Prisma
          .sql`INSERT INTO ${barriers} ("projectId","systemId","repositoryId","targetScopeKey","executionSpaceId","operatorId","dossierId") VALUES (${host.projectId},${host.systemId},${repositoryId},'main',NULL,${operatorId},'legacy')`,
      );
      await client.$executeRaw(
        Prisma
          .sql`INSERT INTO ${saves} ("id","projectId","systemId","executionSpaceId","saveKey","commandDigest","metadata","capture","status","manifest","digest","issues") VALUES ('old-save',${host.projectId},${host.systemId},'main','save-key','command-digest','metadata bytes','capture bytes','retained','manifest bytes','digest bytes','[]')`,
      );
      const beforeDossier = await client.$queryRaw(
        Prisma.sql`SELECT * FROM ${dossiers} WHERE "id"='legacy'`,
      );
      const beforeBarrier = await client.$queryRaw(
        Prisma.sql`SELECT * FROM ${barriers} WHERE "dossierId"='legacy'`,
      );
      const beforeSave = await client.$queryRaw(
        Prisma
          .sql`SELECT "commandDigest","metadata","capture","manifest","digest","revision" FROM ${saves} WHERE "id"='old-save'`,
      );
      // Inspect the function attached to the actual admission trigger in this
      // fixture's schema, independent of the Prisma connection's search_path.
      const triggerDefinition = async () => {
        const rows = await client.$queryRaw<Array<{ definition: string }>>(
          Prisma.sql`
          SELECT pg_get_functiondef(t.tgfoid) AS definition
          FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname=${schema} AND c.relname='SpaceExecutionAdmission'
            AND t.tgname='SpaceExecutionAdmission_immutable' AND NOT t.tgisinternal`,
        );
        assert.equal(rows.length, 1);
        assert.equal(typeof rows[0].definition, "string");
        return rows[0].definition;
      };
      const beforeFunction = await triggerDefinition();
      await migrateToLatest();
      assert.deepEqual(
        await client.$queryRaw(
          Prisma.sql`SELECT * FROM ${dossiers} WHERE "id"='legacy'`,
        ),
        beforeDossier,
      );
      assert.deepEqual(
        await client.$queryRaw(
          Prisma.sql`SELECT * FROM ${barriers} WHERE "dossierId"='legacy'`,
        ),
        beforeBarrier,
      );
      assert.deepEqual(
        await client.$queryRaw(
          Prisma
            .sql`SELECT "commandDigest","metadata","capture","manifest","digest","revision" FROM ${saves} WHERE "id"='old-save'`,
        ),
        beforeSave,
      );
      const [save] = await client.$queryRaw<
        Array<{ publication: string | null }>
      >(Prisma.sql`SELECT "publication" FROM ${saves} WHERE "id"='old-save'`);
      assert.equal(save.publication, null);
      const afterFunction = await triggerDefinition();
      assert.ok(beforeFunction.includes("  IF proof_count <> 1 THEN"));
      assert.ok(afterFunction.includes("  -- A separate software proof"));
      const oldPrefix = beforeFunction.split("  IF proof_count <> 1 THEN")[0];
      const newPrefix =
        afterFunction.split("  -- A separate software proof")[0];
      assert.equal(newPrefix, oldPrefix);
      assert.match(afterFunction, /request-software-runtime-adoption\/v2/);
      const payload = canonical({
        v: 2,
        kind: "software-evolution-scoped",
        scope: {
          destination: { host, repositoryId, executionSpaceId: "space-one" },
        },
      });
      await client.$executeRaw(
        Prisma
          .sql`INSERT INTO ${dossiers} ("projectId","systemId","id","repositoryId","kind","targetScopeKey","executionSpaceId","revision","status","payload","updatedAt") VALUES (${host.projectId},${host.systemId},'scoped',${repositoryId},'software-evolution-scoped-v2','request:space-one','space-one',0,'prepared',${payload},'2026-10-31T00:00:00Z')`,
      );
      await assert.rejects(() =>
        client.$executeRaw(
          Prisma
            .sql`INSERT INTO ${dossiers} ("projectId","systemId","id","repositoryId","kind","targetScopeKey","executionSpaceId","revision","status","payload","updatedAt") VALUES (${host.projectId},${host.systemId},'foreign',${repositoryId},'software-evolution-scoped-v2','request:space-two','space-two',0,'prepared',${payload},'2026-10-31T00:00:00Z')`,
        )
      );
    }, { throughMigration: "20261030040000_retained_tool_adoption" });
  },
});
