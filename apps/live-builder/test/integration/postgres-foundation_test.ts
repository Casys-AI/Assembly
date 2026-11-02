import assert from "node:assert/strict";
import {
  postgresClientSchema,
  postgresQualifiedTable,
  Prisma,
} from "../../src/adapters/out/postgres/client.ts";
import {
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";

Deno.test({
  name:
    "PG-1 real PostgreSQL round-trips all envelopes and isolates equal local identities",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(
      async ({ client, schema, createClient: reopen }) => {
        assert.equal(postgresClientSchema(client), schema);
        const scopes = [
          {
            projectId: "project-a",
            systemId: "system",
            executionSpaceId: "space",
            operatorId: "operator",
          },
          {
            projectId: "project-b",
            systemId: "system",
            executionSpaceId: "space",
            operatorId: "operator",
          },
          {
            projectId: "project-a",
            systemId: "system",
            executionSpaceId: "sibling",
            operatorId: "operator",
          },
        ];
        const payload = '{"preserve":"bytes and order","revision":1}';
        for (const scope of scopes) {
          await seedPostgresRuntime(client, scope);
          const { projectId, systemId, executionSpaceId } = scope;
          await client.runtimeState.create({
            data: { ...scope, revision: 1n, payload },
          });
          await client.runtimeRevision.create({
            data: {
              ...scope,
              revision: 1n,
              recordedAt: new Date("2026-10-27T00:00:00.000Z"),
              runtimeStateId: "local-runtime-id",
              catalogRevision: 1n,
              modelPayload: null,
              eventCount: 0n,
              origin: "commit",
              payload,
              label: "accepted",
              agentCount: 1n,
              activeToolCount: 0n,
            },
          });
          await client.runtimeProjection.create({
            data: {
              ...scope,
              revision: 1n,
              digest: "d".repeat(64),
              recordedAt: new Date(),
              payload,
            },
          });
          await client.workBudget.create({
            data: { ...scope, scopeId: "case", revision: 1n, payload },
          });
          await client.workPlan.create({
            data: { ...scope, id: "plan", revision: 1n, payload },
          });
          await client.governedMemory.create({
            data: {
              ...scope,
              ownerId: "owner",
              id: "memory",
              revision: 1n,
              digest: "a".repeat(64),
              payload,
            },
          });
          await client.memoryInvocation.create({
            data: {
              ...scope,
              ownerId: "owner",
              callerId: "caller",
              invocationId: "invocation",
              noteId: "memory",
              requestDigest: "b".repeat(64),
            },
          });
          await client.skillCatalog.create({
            data: { ...scope, ownerId: "owner", revision: 1n, payload },
          });
          await client.skillInvocation.create({
            data: {
              ...scope,
              ownerId: "owner",
              callerId: "caller",
              invocationId: "invocation",
              skillId: "skill",
              requestDigest: "b".repeat(64),
              kind: "install",
            },
          });
          await client.spaceManifest.create({
            data: {
              projectId,
              systemId,
              executionSpaceId,
              revision: 1n,
              kind: "baseline",
              digest: "c".repeat(64),
              payload,
            },
          });
          await client.protectedBindingReference.create({
            data: {
              ...scope,
              referenceId: "opaque-reference",
              revision: 1n,
              resourceType: "network",
              status: "active",
            },
          });
          await client.contextSelection.create({
            data: {
              ...scope,
              selectionId: "selection",
              caseId: null,
              stateRevision: 1n,
              sourceRangePayload: payload,
              selectedVersionsPayload: payload,
              derivedProjectionPayload: null,
            },
          });
        }
        // Read each serialized envelope back; row counts alone do not prove bytes.
        for (const scope of scopes) {
          const space = {
            projectId: scope.projectId,
            systemId: scope.systemId,
            executionSpaceId: scope.executionSpaceId,
          };
          const rows = await Promise.all([
            client.runtimeState.findFirstOrThrow({ where: scope }),
            client.runtimeRevision.findFirstOrThrow({ where: scope }),
            client.runtimeProjection.findFirstOrThrow({ where: scope }),
            client.workBudget.findFirstOrThrow({ where: scope }),
            client.workPlan.findFirstOrThrow({ where: scope }),
            client.governedMemory.findFirstOrThrow({ where: scope }),
            client.skillCatalog.findFirstOrThrow({ where: scope }),
            client.spaceManifest.findFirstOrThrow({ where: space }),
          ]);
          for (const row of rows) assert.equal(row.payload, payload);
          assert.equal(
            (await client.memoryInvocation.findFirstOrThrow({ where: scope }))
              .requestDigest,
            "b".repeat(64),
          );
          assert.equal(
            (await client.skillInvocation.findFirstOrThrow({ where: scope }))
              .kind,
            "install",
          );
          assert.equal(
            (await client.protectedBindingReference.findFirstOrThrow({
              where: scope,
            })).referenceId,
            "opaque-reference",
          );
          assert.equal(
            (await client.contextSelection.findFirstOrThrow({ where: scope }))
              .selectedVersionsPayload,
            payload,
          );
        }
        const payloadLengths = await client.$queryRaw<{ bytes: number }[]>(
          Prisma.sql`
        SELECT octet_length(payload) AS bytes FROM ${
            postgresQualifiedTable(client, "RuntimeState")
          }
      `,
        );
        assert.deepEqual(
          payloadLengths.map((row) => row.bytes),
          Array(3).fill(new TextEncoder().encode(payload).length),
        );
        assert.equal(await client.runtimeState.count(), 3);
        assert.equal(await client.runtimeRevision.count(), 3);
        assert.equal(await client.runtimeProjection.count(), 3);
        assert.equal(await client.workBudget.count(), 3);
        assert.equal(await client.workPlan.count(), 3);
        assert.equal(await client.governedMemory.count(), 3);
        assert.equal(await client.memoryInvocation.count(), 3);
        assert.equal(await client.skillCatalog.count(), 3);
        assert.equal(await client.skillInvocation.count(), 3);
        assert.equal(await client.spaceManifest.count(), 3);
        assert.equal(await client.protectedBindingReference.count(), 3);
        assert.equal(await client.contextSelection.count(), 3);
        await client.caseIdentity.createMany({
          data: ["project-a", "project-b"].map((projectId) => ({
            projectId,
            systemId: "system",
            caseId: "case",
            number: 1n,
          })),
        });
        await client.caseSequence.createMany({
          data: ["project-a", "project-b"].map((projectId) => ({
            projectId,
            systemId: "system",
            lastNumber: 1n,
          })),
        });
        await client.sourceRepository.create({
          data: {
            projectId: "project-a",
            systemId: "system",
            repositoryId: "common-model-tools-skills",
            sourceScopeId: "old-source-scope",
          },
        });
        await client.artifactVersion.create({
          data: {
            projectId: "project-a",
            systemId: "system",
            versionId: "version",
            artifactId: "tool",
            kind: "tool-draft",
            sourceReferenceVersion: 1n,
            sourceScopeId: "old-source-scope",
            repositoryId: "common-model-tools-skills",
            commitOid: "a".repeat(40),
            manifestPath: "tools/tool/manifest.json",
            entryPath: "tools/tool/source.json",
            contentDigest: "b".repeat(64),
            contentEncoding: "tool-draft-json-v1",
            manifestDigestVersion: "sha256-canonical-json-v1",
            manifestDigest: "c".repeat(64),
            publishedAt: new Date(),
          },
        });
        for (const scope of [scopes[0], scopes[2]]) {
          await client.artifactBinding.create({
            data: {
              ...scope,
              bindingId: "binding",
              ownerId: "owner",
              localArtifactId: "candidate",
              versionId: "version",
              revision: 1n,
              invocationId: "admission",
              provenancePayload: payload,
            },
          });
        }
        await assert.rejects(() =>
          client.artifactBinding.create({
            data: {
              ...scopes[1],
              bindingId: "binding",
              ownerId: "owner",
              localArtifactId: "candidate",
              versionId: "version",
              revision: 1n,
              invocationId: "admission",
              provenancePayload: payload,
            },
          })
        );
        await assert.rejects(() =>
          client.artifactVersion.updateMany({
            data: { commitOid: "f".repeat(40) },
          })
        );
        await assert.rejects(() =>
          client.spaceManifest.updateMany({ data: { payload: "changed" } })
        );
        await client.$disconnect();
        const reopened = reopen();
        const state = await reopened.runtimeState.findUniqueOrThrow({
          where: { projectId_systemId_executionSpaceId_operatorId: scopes[0] },
        });
        assert.equal(state.payload, payload);
        assert.equal(state.revision, 1n);
        assert.equal(await reopened.artifactBinding.count(), 2);
        const source = await reopened.artifactVersion.findFirstOrThrow();
        assert.equal(source.commitOid, "a".repeat(40));
        assert.equal(source.contentDigest, "b".repeat(64));
        assert.equal(source.manifestDigest, "c".repeat(64));
        assert.equal(source.sourceScopeId, "old-source-scope");
        assert.equal(await reopened.caseIdentity.count(), 2);
        assert.equal(await reopened.caseSequence.count(), 2);
      },
    );
  },
});

Deno.test({
  name:
    "PG-1 real PostgreSQL rejects immutable evidence changes and invalid counters",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(
      async ({ client, schema, createClient: reopen }) => {
        assert.equal(postgresClientSchema(client), schema);
        const scope = {
          projectId: "project",
          systemId: "system",
          executionSpaceId: "space",
          operatorId: "operator",
        };
        await seedPostgresRuntime(client, scope);
        await client.runtimeRevision.create({
          data: {
            ...scope,
            revision: 1n,
            recordedAt: new Date(),
            runtimeStateId: "runtime",
            catalogRevision: 0n,
            modelPayload: null,
            eventCount: 0n,
            origin: "commit",
            payload: "{}",
            label: "accepted",
            agentCount: 1n,
            activeToolCount: 0n,
          },
        });
        await client.runtimeProjection.create({
          data: {
            ...scope,
            revision: 1n,
            digest: "a".repeat(64),
            recordedAt: new Date(),
            payload: "{}",
          },
        });
        await assert.rejects(() =>
          client.runtimeRevision.updateMany({
            where: scope,
            data: { payload: "changed" },
          })
        );
        await assert.rejects(() =>
          client.runtimeProjection.deleteMany({ where: scope })
        );
        await assert.rejects(() =>
          client.runtimeState.create({
            data: { ...scope, revision: -1n, payload: "{}" },
          })
        );
        await assert.rejects(() =>
          client.runtimeState.create({
            data: { ...scope, revision: 9007199254740992n, payload: "{}" },
          })
        );
        await client.runtimeState.create({
          data: { ...scope, revision: 2147483648n, payload: "{}" },
        });
        assert.equal(
          (await client.runtimeState.findMany())[0].revision,
          2147483648n,
        );
        const { projectId, systemId } = scope;
        await client.caseSequence.create({ data: { projectId, systemId } });
        const numbers = await Promise.all(
          Array.from({ length: 12 }, () =>
            client.caseSequence.update({
              where: { projectId_systemId: { projectId, systemId } },
              data: { lastNumber: { increment: 1n } },
            })),
        );
        assert.deepEqual(
          numbers.map((row) => Number(row.lastNumber)).sort((a, b) => a - b),
          Array.from({ length: 12 }, (_, i) => i + 1),
        );
        await client.$disconnect();
        const reopened = reopen();
        assert.equal(
          (await reopened.caseSequence.update({
            where: { projectId_systemId: { projectId, systemId } },
            data: { lastNumber: { increment: 1n } },
          })).lastNumber,
          13n,
        );
      },
    );
  },
});
