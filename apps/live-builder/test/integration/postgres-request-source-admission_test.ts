/** Real isolated PostgreSQL, synthetic publication evidence; this does not prove Git effects or authority. */
import type { RequestSourceOwnerAuthorityEnvelope } from "../../src/application/model/source-admission/request-source-owner.ts";
import assert from "node:assert/strict";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { sha256 } from "../../src/domain/primitives/execution-digest.ts";
import { scopedSoftwareWriteCommandDigest } from "../../src/application/model/publication/scoped-software-write.ts";
import { parseScopedSoftwareSourceAdmission } from "../../src/application/model/source-admission/scoped-software-source-admission.ts";
import {
  scopedSoftwareSourceAdmissionRef,
  scopedSoftwareSourceCommandRef,
} from "../../src/domain/model/editing/request-source-publication.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import { PostgresRequestSourceAdmissionStore } from "../../src/adapters/out/postgres/request-source-admission-store.ts";
import {
  postgresQualifiedTable,
  Prisma,
} from "../../src/adapters/out/postgres/client.ts";
import {
  parseRequestSourceAdmission,
  requestSourceAdmissionDigest,
} from "../../src/application/model/source-admission/request-source-admission.ts";
import { requestSpaceDigest } from "../../src/domain/work/request-spaces.ts";
import {
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { admissionFixture } from "../support/request-source-admission-fixture.ts";
import {
  requestControlModel,
  requestOpeningBase,
  requestSpaceScope as scope,
  spaceUuid,
} from "../support/request-space-fixture.ts";

Deno.test({
  name:
    "Request source admissions serialize on Opening, preserve baseline and replay exact historical receipt",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, {
        ...scope,
        executionSpaceId: "main",
        operatorId: "operator",
      });
      const openings = new PostgresRequestSpaceStore(client, scope);
      const command = {
        openingKey: "source-admission",
        text: "Immutable baseline",
        source: { kind: "current-main" as const },
      };
      const allocated = await openings.begin({
        ownerId: "owner",
        command,
        commandDigest: await requestSpaceDigest({
          scope,
          ownerId: "owner",
          command,
        }),
      });
      const base = await requestOpeningBase("c");
      const opening = await openings.selectBase({
        id: allocated.id,
        ownerId: "owner",
        expectedRevision: allocated.revision,
        base,
        baseDigest: await requestSpaceDigest(base),
      });
      const store = new PostgresRequestSourceAdmissionStore(client);
      const read = () =>
        client.$transaction((tx) => store.readAdmittedSource(tx, opening), {
          isolationLevel: "RepeatableRead",
        });
      const before = await read();
      await assert.rejects(() =>
        client.$transaction((tx) =>
          store.readAdmittedSource(tx, {
            ...opening,
            ownerId: "different-owner",
          })
        )
      );
      assert.equal(before.head.revision, 1);
      assert.equal(
        before.head.sourceDigest,
        base.manifest.source!.sourceDigest,
      );
      assert.equal(before.head.manifestDigest, base.manifestDigest);
      const baseline = await client.spaceManifest.findMany({
        where: { ...scope, executionSpaceId: opening.executionSpaceId },
      });
      const left = await admissionFixture(
        opening,
        before.head,
        spaceUuid(101),
        "d",
      );
      const right = await admissionFixture(
        opening,
        before.head,
        spaceUuid(102),
        "e",
      );
      const snapshot = await parseRequestSourceAdmission(left);
      assert.notEqual(snapshot, left);
      assert.notEqual(snapshot.authority, left.authority);
      await assert.rejects(() =>
        parseRequestSourceAdmission({ ...left, surprise: true })
      );
      await assert.rejects(() =>
        parseRequestSourceAdmission({ ...left, commandDigest: "f".repeat(64) })
      );
      await assert.rejects(() =>
        parseRequestSourceAdmission({
          ...left,
          publication: { ...left.publication, commandRef: "refs/heads/main" },
        })
      );
      await assert.rejects(() =>
        parseRequestSourceAdmission({
          ...left,
          result: { ...left.result, sourceDigest: "f".repeat(64) },
        })
      );
      const append = (input: typeof left) =>
        client.$transaction((tx) => store.compareAndAppend(tx, opening, input));
      const race = await Promise.allSettled([append(left), append(right)]);
      assert.equal(
        race.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        race.filter((result) => result.status === "rejected").length,
        1,
      );
      const winner = race.find((
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof append>>
      > => result.status === "fulfilled")!.value;
      assert.equal(winner.revision, 2);
      const loser = winner.payload.command.commandId === left.command.commandId
        ? right
        : left;
      await assert.rejects(
        () => append(loser),
        "stale predecessor must conflict",
      );
      const same = await append(winner.payload);
      assert.deepEqual(
        same,
        winner,
        "historical retry must return its own database timestamp and receipt",
      );
      const changed = {
        ...winner.payload,
        publication: {
          ...winner.payload.publication,
          receiptDigest: "f".repeat(64),
        },
      };
      await assert.rejects(() => append(changed));
      const current = await read();
      const next = await admissionFixture(
        opening,
        current.head,
        spaceUuid(103),
        "f",
        winner.payload.result.model.digest,
      );
      const newest = await append(next);
      assert.equal(newest.revision, 3);
      assert.deepEqual(
        await append(winner.payload),
        winner,
        "a later head cannot replace an older command receipt",
      );
      assert.deepEqual((await read()).receipts.map((item) => item.revision), [
        2,
        3,
      ]);
      assert.deepEqual(
        (await client.spaceManifest.findMany({
          where: { ...scope, executionSpaceId: opening.executionSpaceId },
          orderBy: { revision: "asc" },
        }))[0],
        baseline[0],
      );
      await assert.rejects(() =>
        client.$executeRaw(
          Prisma.sql`UPDATE ${
            postgresQualifiedTable(client, "SpaceManifest")
          } SET "payload"='{}' WHERE "projectId"=${scope.projectId} AND "systemId"=${scope.systemId} AND "executionSpaceId"=${opening.executionSpaceId} AND "revision"=2`,
        )
      );
      await assert.rejects(() =>
        client.$executeRaw(
          Prisma.sql`DELETE FROM ${
            postgresQualifiedTable(client, "SpaceManifest")
          } WHERE "projectId"=${scope.projectId} AND "systemId"=${scope.systemId} AND "executionSpaceId"=${opening.executionSpaceId} AND "revision"=2`,
        )
      );
      assert.deepEqual((await openings.get(opening.id))!.base, opening.base);
    });
  },
});

Deno.test({
  name:
    "Unknown or unsupported adoption evidence refuses new source evolution without changing baseline",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, {
        ...scope,
        executionSpaceId: "main",
        operatorId: "operator",
      });
      const openings = new PostgresRequestSpaceStore(client, scope);
      const command = {
        openingKey: "adoption-fixture",
        text: "Preserve old evidence",
        source: { kind: "current-main" as const },
      };
      const allocated = await openings.begin({
        ownerId: "owner",
        command,
        commandDigest: await requestSpaceDigest({
          scope,
          ownerId: "owner",
          command,
        }),
      });
      const base = await requestOpeningBase("c");
      const opening = await openings.selectBase({
        id: allocated.id,
        ownerId: "owner",
        expectedRevision: allocated.revision,
        base,
        baseDigest: await requestSpaceDigest(base),
      });
      const old = await client.spaceManifest.create({
        data: {
          ...scope,
          executionSpaceId: opening.executionSpaceId,
          revision: 2n,
          kind: "adoption",
          digest: "a".repeat(64),
          payload: "{}",
        },
      });
      const store = new PostgresRequestSourceAdmissionStore(client);
      await assert.rejects(() =>
        client.$transaction((tx) => store.readAdmittedSource(tx, opening))
      );
      const persisted = await client.spaceManifest.findUniqueOrThrow({
        where: {
          projectId_systemId_executionSpaceId_revision: {
            ...scope,
            executionSpaceId: opening.executionSpaceId,
            revision: 2n,
          },
        },
      });
      assert.deepEqual(persisted, old);
      assert.deepEqual((await openings.get(opening.id))!.base, opening.base);
    });
  },
});

Deno.test({
  name:
    "First source admission preserves the baseline native system and qualified name on append and read",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, {
        ...scope,
        executionSpaceId: "main",
        operatorId: "operator",
      });
      const openings = new PostgresRequestSpaceStore(client, scope);
      const store = new PostgresRequestSourceAdmissionStore(client);
      for (
        const [index, identityPatch] of [
          { systemId: "foreign-native-system" },
          { systemQualifiedName: "Foreign::system" },
          {},
        ].entries()
      ) {
        const command = {
          openingKey: `identity-${index}`,
          text: "Retain baseline identity",
          source: { kind: "current-main" as const },
        };
        const allocated = await openings.begin({
          ownerId: "owner",
          command,
          commandDigest: await requestSpaceDigest({
            scope,
            ownerId: "owner",
            command,
          }),
        });
        const original = await requestOpeningBase("c");
        const manifest = {
          ...original.manifest,
          operators: original.manifest.operators.map((operator) => ({
            ...operator,
            nativeSystemId: requestControlModel().identity.systemId,
          })),
        };
        const base = {
          ...original,
          manifest,
          manifestDigest: await requestSpaceDigest(manifest),
        };
        const opening = await openings.selectBase({
          id: allocated.id,
          ownerId: "owner",
          expectedRevision: allocated.revision,
          base,
          baseDigest: await requestSpaceDigest(base),
        });
        const read = () =>
          client.$transaction((tx) => store.readAdmittedSource(tx, opening), {
            isolationLevel: "RepeatableRead",
          });
        const before = await read();
        const valid = await admissionFixture(
          opening,
          before.head,
          spaceUuid(120 + index),
          "d",
        );
        const append = (input: typeof valid) =>
          client.$transaction((tx) =>
            store.compareAndAppend(tx, opening, input)
          );
        if (Object.keys(identityPatch).length === 0) {
          const accepted = await append(valid);
          assert.equal(
            (accepted.payload.authority as RequestSourceOwnerAuthorityEnvelope)
              .acceptance.priorModel.identity.systemId,
            manifest.operators[0].nativeSystemId,
          );
          assert.equal(
            (accepted.payload.authority as RequestSourceOwnerAuthorityEnvelope)
              .acceptance.priorModel.identity
              .systemQualifiedName,
            manifest.operators[0].systemQualifiedName,
          );
          assert.deepEqual(
            (await read()).receipts,
            [accepted],
            "matching retained native identity remains admissible",
          );
          continue;
        }
        const contradictory = await admissionFixture(
          opening,
          before.head,
          spaceUuid(120 + index),
          "d",
          before.head.sourceDigest,
          identityPatch,
        );
        // The closed decoder accepts the internally coherent claim; only its
        // mismatch with retained B0 identity must refuse the admission.
        assert.deepEqual(
          await parseRequestSourceAdmission(contradictory),
          contradictory,
        );
        await assert.rejects(() => append(contradictory), {
          code: "OPENING_CONFLICT",
        });
        assert.deepEqual(
          await read(),
          before,
          "refused append leaves the complete baseline unchanged",
        );
        const baseline = await client.spaceManifest.findMany({
          where: { ...scope, executionSpaceId: opening.executionSpaceId },
        });
        // Bypass the append port only to exercise defensive historical decoding.
        await client.spaceManifest.create({
          data: {
            ...scope,
            executionSpaceId: opening.executionSpaceId,
            revision: 2n,
            kind: "source-admission",
            digest: await requestSourceAdmissionDigest(contradictory),
            payload: canonical(contradictory),
          },
        });
        await assert.rejects(read, { code: "UNAVAILABLE" });
        assert.deepEqual(
          (await client.spaceManifest.findMany({
            where: { ...scope, executionSpaceId: opening.executionSpaceId },
            orderBy: { revision: "asc" },
          }))[0],
          baseline[0],
        );
        assert.deepEqual((await openings.get(opening.id))!.base, opening.base);
      }
    });
  },
});

Deno.test({
  name:
    "PG software D2 journal appends once and recovers exact receipt without changing execution pin",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, {
        ...scope,
        executionSpaceId: "main",
        operatorId: "operator",
      });
      const openings = new PostgresRequestSpaceStore(client, scope);
      const command = {
        openingKey: "software-source-journal",
        text: "Exact software D2",
        source: { kind: "current-main" as const },
      };
      const allocated = await openings.begin({
        ownerId: "owner",
        command,
        commandDigest: await requestSpaceDigest({
          scope,
          ownerId: "owner",
          command,
        }),
      });
      const base = await requestOpeningBase("c");
      const opening = await openings.selectBase({
        id: allocated.id,
        ownerId: allocated.ownerId,
        expectedRevision: allocated.revision,
        base,
        baseDigest: await requestSpaceDigest(base),
      });
      const store = new PostgresRequestSourceAdmissionStore(client);
      const read = () =>
        client.$transaction((tx) => store.readAdmittedSource(tx, opening), {
          isolationLevel: "RepeatableRead",
        });
      const before = await read();
      const make = async (id: string, next: string) => {
        // A synthetic candidate supplies valid canonical build/identity facts;
        // this test makes no claim about Git or native authority.
        const human = await admissionFixture(opening, before.head, id, next);
        const core = {
          v: 2 as const,
          kind: "publish-software-evolution" as const,
          repositoryId: human.command.repositoryId,
          commandId: id,
          approvedBase: human.command.approvedBase,
          destination: human.destination,
          operationsRef: { digest: "1".repeat(64) },
          decisionRef: { id, digest: "2".repeat(64) },
          recipeDigest: human.command.recipeDigest,
          authorityRef: {
            kind: "software-evolution-scoped-authority/v2" as const,
            digest: "3".repeat(64),
          },
        };
        const softwareCommand = {
          ...core,
          intentDigest: await sha256(canonical(core)),
        };
        return await parseScopedSoftwareSourceAdmission({
          format: "request-software-source-admission/v2",
          destination: human.destination,
          openingBaseDigest: human.openingBaseDigest,
          predecessor: before.head,
          result: {
            source: human.result.source,
            sourceDigest: human.result.sourceDigest,
            build: human.result.build,
            buildDigest: human.result.buildDigest,
            targets: [{
              operatorId: opening.base!.requestOwner.operatorId,
              identity: human.result.model.identity,
              digest: human.result.model.digest,
            }],
          },
          command: softwareCommand,
          commandDigest: await scopedSoftwareWriteCommandDigest(
            softwareCommand,
          ),
          writeDossierDigest: "4".repeat(64),
          evolutionDossierId: `software-${id}`,
          evolutionIntentDigest: "5".repeat(64),
          proposalDigest: "6".repeat(64),
          decisionDigest: "2".repeat(64),
          publication: {
            repositoryId: human.command.repositoryId,
            commandId: id,
            commandRef: scopedSoftwareSourceCommandRef(id),
            publicationRef: scopedSoftwareSourceAdmissionRef(
              id,
              human.result.source.version,
            ),
            commit: human.result.source.version,
            receiptDigest: "7".repeat(64),
          },
        });
      };
      const first = await make(spaceUuid(801), "d"),
        competing = await make(spaceUuid(802), "e");
      const append = (value: typeof first) =>
        client.$transaction((tx) =>
          store.compareAndAppendSoftware(tx, opening, value)
        );
      const accepted = await append(first);
      assert.equal(accepted.revision, before.cursor.revision + 1);
      assert.deepEqual(await append(first), accepted);
      await assert.rejects(() => append(competing));
      const after = await read();
      assert.equal(after.softwareReceipts.length, 1);
      assert.equal(after.head.manifestDigest, accepted.manifestDigest);
      assert.deepEqual(after.execution.pin, before.execution.pin);
      assert.equal(after.receipts.length, before.receipts.length);
    });
  },
});
