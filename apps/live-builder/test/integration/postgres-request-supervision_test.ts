/** Bounded real PostgreSQL inventory/admission witness. No native engine,
 * Toolkit, runtime factory, queue, provider or server is constructed. */
import assert from "node:assert/strict";
import { RequestSupervision } from "../../src/application/work/request-spaces/supervision.ts";
import {
  SpaceAdmissions,
  SpaceControls,
} from "../../src/application/work/request-spaces/control.ts";
import { PostgresHostStorage } from "../../src/adapters/out/postgres/host-storage.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import { PostgresRequestSupervisionObservations } from "../../src/adapters/out/postgres/request-supervision.ts";
import { PostgresRequestExecutionBindingReader } from "../../src/adapters/out/postgres/request-execution-binding.ts";
import { PostgresRequestSourceAdmissionStore } from "../../src/adapters/out/postgres/request-source-admission-store.ts";
import {
  PostgresSpaceAdmissions,
  PostgresSpaceCredentials,
} from "../../src/adapters/out/postgres/request-space-control-store.ts";
import { ModeledSpaceControlAuthority } from "../../src/application/work/request-spaces/space-control-authority.ts";
import { postgresClientConfiguration } from "../../src/adapters/out/postgres/config.ts";
import {
  postgresQualifiedTable,
  Prisma,
} from "../../src/adapters/out/postgres/client.ts";
import { openCase } from "../../src/domain/work/entities/cases.ts";
import { requestSpaceDigest } from "../../src/domain/work/request-spaces.ts";
import type { OpeningRecord } from "../../src/domain/work/request-spaces.ts";
import {
  type PostgresTestDatabase,
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";
import {
  requestControlBinding,
  requestControlState,
  requestOpeningBase,
  requestSpaceScope as scope,
} from "../support/request-space-fixture.ts";

const watched = [
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
  "SpaceManifest",
  "SpaceControlCredential",
  "SpaceExecutionAdmission",
  "OperatorExecution",
  "ExecutionContribution",
  "ExecutionRun",
  "ExecutionEffect",
  "ExecutionThreadBinding",
];

async function snapshot(database: PostgresTestDatabase) {
  const result: Record<string, unknown> = {};
  for (const name of watched) {
    result[name] = await database.client.$queryRaw(
      Prisma
        .sql`SELECT to_jsonb(t)::text AS body, t.xmin::text AS xmin, t.ctid::text AS ctid FROM ${
        postgresQualifiedTable(database.client, name)
      } AS t ORDER BY body`,
    );
  }
  return result;
}
async function writeGuard(database: PostgresTestDatabase) {
  const guard = postgresQualifiedTable(database.client, "SupervisionReadGuard");
  const reject = postgresQualifiedTable(
    database.client,
    "reject_supervision_writes",
  );
  await database.client.$executeRaw(
    Prisma.sql`CREATE TABLE ${guard} (enabled BOOLEAN NOT NULL)`,
  );
  await database.client.$executeRaw(
    Prisma.sql`INSERT INTO ${guard} VALUES (false)`,
  );
  await database.client.$executeRaw(
    Prisma
      .sql`CREATE FUNCTION ${reject}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT enabled FROM ${guard}) THEN RAISE EXCEPTION 'Supervision attempted DML on %', TG_TABLE_NAME USING ERRCODE='25006'; END IF; RETURN NULL; END $$`,
  );
  for (const name of watched) {
    await database.client.$executeRaw(
      Prisma
        .sql`CREATE TRIGGER "SupervisionNoWrites" BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${
        postgresQualifiedTable(database.client, name)
      } FOR EACH STATEMENT EXECUTE FUNCTION ${reject}()`,
    );
  }
  return async <T>(read: () => Promise<T>) => {
    await database.client.$executeRaw(
      Prisma.sql`UPDATE ${guard} SET enabled=true`,
    );
    try {
      const before = await snapshot(database);
      const value = await read();
      assert.deepEqual(
        await snapshot(database),
        before,
        "Operational reading changes no rows or tuple versions, including no-op writes",
      );
      return value;
    } finally {
      await database.client.$executeRaw(
        Prisma.sql`UPDATE ${guard} SET enabled=false`,
      );
    }
  };
}

Deno.test({
  name:
    "PG supervision discovers owned distinct pins with current admission and no runtime work or writes",
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
      database.registerCleanup(() => storage.close());
      await storage.registerSystem(scope);
      const primary = storage.bindPrimarySpaceControl({
        primaryOperatorId: "operator",
        sourceSystemNativeId: requestControlBinding.sourceSystemNativeId,
      });
      const mainStore = await storage.operator("operator");
      await mainStore.state.save(requestControlState(), null);
      const openings = new PostgresRequestSpaceStore(storage.client, scope);
      const credentials = new PostgresSpaceCredentials(storage.client, primary);
      const authority = new ModeledSpaceControlAuthority(
        primary,
        requestControlBinding,
      );
      const controls = new SpaceControls(credentials, authority, {
        randomSecret: () =>
          crypto.randomUUID().replaceAll("-", "") +
          crypto.randomUUID().replaceAll("-", ""),
      });
      const sqlAdmissions = new PostgresSpaceAdmissions(
        storage.client,
        primary,
      );
      const bindings = new PostgresRequestExecutionBindingReader(
        storage.client,
        scope,
        new PostgresRequestSourceAdmissionStore(storage.client),
      );
      const admissions = new SpaceAdmissions(
        sqlAdmissions,
        credentials,
        authority,
        controls,
        () => Date.now(),
        () => crypto.randomUUID(),
        bindings,
      );
      const capability = await controls.issueCapability("owner");
      const session = await controls.exchange(capability.secret);
      const controller = await controls.authenticateSession(session.secret);

      async function seed(
        letter: string,
        owner = "owner",
      ): Promise<OpeningRecord> {
        const command = {
          openingKey: `supervision-${owner}-${letter}`,
          text: `Inspect exact ${letter}`,
          source: { kind: "current-main" as const },
        };
        let record = await openings.begin({
          ownerId: owner,
          command,
          commandDigest: await requestSpaceDigest({
            scope,
            ownerId: owner,
            command,
          }),
        });
        const base = await requestOpeningBase(letter);
        record = await openings.selectBase({
          id: record.id,
          ownerId: owner,
          expectedRevision: record.revision,
          base,
          baseDigest: await requestSpaceDigest(base),
        });
        for (
          const [from, to] of [["source-selected", "branch-ready"], [
            "branch-ready",
            "runtime-ready",
          ]] as const
        ) {
          record = await openings.advance({
            id: record.id,
            ownerId: owner,
            expectedRevision: record.revision,
            from,
            to,
          });
        }
        if (owner !== "owner") return record;
        const stores = await (await storage.caseSpace(
          record.executionSpaceId,
          record.caseId,
        )).operator("operator");
        const state = requestControlState();
        state.id = `request:${record.executionSpaceId}:operator`;
        state.executionModel!.version.digest = letter.repeat(64);
        state.executionModel!.version.repositoryVersion = `commit:${
          letter.repeat(40)
        }`;
        state.executionModel!.operator = {
          name: letter === "a" ? "Main Operator" : "Case specialist",
          instruction: "Retain custom names",
          primary: true,
          humanInput: true,
        };
        state.cases = [openCase({
          id: record.caseId,
          number: record.caseNumber,
          type: "request",
          caseTypeId: base.requestOwner.caseTypeId,
          objective: command.text,
          owner: "operator",
          openedBy: record.ownerId,
          openedFrom: {
            conversationId: state.id,
            openingId: record.id,
            messageId: record.initialContributionId,
          },
          modelPin: {
            digest: state.executionModel!.version.digest,
            repositoryVersion: state.executionModel!.version.repositoryVersion,
          },
          createdAt: record.createdAt,
        })];
        state.caseInvocation = { kind: "local", caseId: record.caseId };
        await stores.state.save(state, null);
        const admission = await admissions.ensure(record, controller);
        record = await openings.advance({
          id: record.id,
          ownerId: owner,
          expectedRevision: record.revision,
          from: "runtime-ready",
          to: "admitted",
          admissionId: admission.id,
        });
        return record;
      }
      const a = await seed("a"),
        b = await seed("b"),
        foreign = await seed("d", "another-owner");
      const observations = new PostgresRequestSupervisionObservations(
        storage.client,
        primary.runtimeScope,
        bindings,
      );
      const service = new RequestSupervision({
        now: () => new Date().toISOString(),
        scope,
        store: openings,
        control: controls,
        admissions,
        observations,
      });
      const withoutWrites = await writeGuard(database);
      await withoutWrites(async () => {
        // Negative control proves triggers reject even no-op state registration.
        await assert.rejects(
          () =>
            storage.client.operatorRuntime.updateMany({
              where: primary.runtimeScope,
              data: { operatorId: "operator" },
            }),
          /Supervision attempted DML/,
        );
        const result = await service.read(session.secret);
        assert.equal(result.main.actor.executionSpaceId, "main");
        assert.equal(result.main.availability, "available");
        assert.equal(result.instances.length, 2);
        assert.deepEqual(
          result.instances.map((
            entry,
          ) => [
            entry.actor.operatorId,
            entry.actor.executionSpaceId,
            entry.source?.sourceVersion,
          ]),
          [["operator", b.executionSpaceId, `commit:${"b".repeat(40)}`], [
            "operator",
            a.executionSpaceId,
            `commit:${"a".repeat(40)}`,
          ]],
        );
        assert.deepEqual(result.instances.map((entry) => entry.name), [
          "Case specialist",
          "Main Operator",
        ]);
        assert.equal(
          result.instances.every((entry) =>
            entry.role === "BO" && entry.supervision.status === "unresolved" &&
            entry.evaluatedActions[0].result === "allowed"
          ),
          true,
        );
        for (const entry of result.instances) {
          if (entry.supervision.status !== "unresolved") {
            throw new Error("Opening ancestry cannot prove actor supervision");
          }
          assert.deepEqual(entry.supervision.hostMain, result.main.actor);
          assert.equal(entry.supervision.openingProvenance?.openedBy, "owner");
          assert.equal(
            entry.supervision.openingProvenance?.parentExecutionSpaceId,
            "main",
          );
          assert.equal(
            entry.supervision.openingProvenance?.originConversationId,
            `request:${entry.actor.executionSpaceId}:${entry.actor.operatorId}`,
            "Preserve the actual BO origin without inventing Main participation",
          );
        }
        assert.equal(JSON.stringify(result).includes(foreign.caseId), false);
        const page = await service.read(session.secret, { limit: 1 });
        assert.equal(page.coverage.completeness, "has-more");
        assert.ok(page.nextCursor);
        const next = await service.read(session.secret, {
          limit: 1,
          cursor: page.nextCursor!,
        });
        assert.equal(next.instances[0].case?.id, a.caseId);
        assert.equal(next.nextCursor, null);
        const scoped = await service.read(session.secret, { caseId: a.caseId });
        assert.deepEqual(scoped.main.actor, result.main.actor);
        assert.equal(scoped.instances[0].case?.id, a.caseId);
        await assert.rejects(
          () => service.read(session.secret, { caseId: foreign.caseId }),
          /unavailable/,
        );
        await assert.rejects(() => service.read("f".repeat(64)), /unavailable/);
        assert.deepEqual(
          await new PostgresRequestSpaceStore(storage.client, {
            ...scope,
            systemId: "foreign-system",
          }).pageForOwner("owner", { limit: 2 }),
          [],
        );
        assert.equal(await storage.client.operatorExecution.count(), 0);
        assert.equal(await storage.client.executionEffect.count(), 0);
      });
      await admissions.revoke(a.admissionId!, controller);
      await withoutWrites(async () => {
        const result = await service.read(session.secret, { caseId: a.caseId });
        assert.equal(result.instances[0].availability, "available");
        assert.equal(result.instances[0].evaluatedActions[0].result, "refused");
      });
      await controls.revokeCapability(controller);
      await withoutWrites(async () => {
        await assert.rejects(() => service.read(session.secret), /unavailable/);
      });
    });
  },
});
