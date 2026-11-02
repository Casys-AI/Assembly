import { deepStrictEqual, equal, notEqual, rejects } from "node:assert/strict";
import {
  type PostgresTestDatabase,
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";
import {
  queueTestCompiler,
  unusedPublication,
} from "../support/postgres-write-queue.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { repositoryWriterLock } from "../../src/adapters/out/git/writer-lock.ts";
import { PostgresModelWriteQueue } from "../../src/adapters/model/repository/writing/postgres-write-queue.ts";
import { QueuedModelWriter } from "../../src/application/model/publication/queued-writer.ts";
import { DurableQueuedArtifactSourcePublisher } from "../../src/application/model/write-queue/queued-artifact-source-publisher.ts";
import { ModelWriteWorker } from "../../src/application/model/publication/write-queue.ts";
import { ModelRepositoryError } from "../../src/application/model/repository.ts";
import {
  type ArtifactSourceBindingsPort,
  type ArtifactSourceSelection,
  ArtifactSourceService,
  type BoundArtifactSource,
} from "../../src/application/work/artifacts/publication.ts";
import { PostgresArtifactBindings } from "../../src/adapters/work/artifacts/postgres-bindings.ts";
import { ArtifactSourceError } from "../../src/domain/work/artifacts/source-reference.ts";
import { skillContentDigest } from "../../src/domain/skills/context-skills.ts";
import {
  requireSkillAuthority,
  type SkillAuthority,
  SkillError,
} from "../../src/domain/skills/context-skills.ts";
import { ContextSkillsService } from "../../src/application/skills/context-skills.ts";
import { PostgresContextSkillsStore } from "../../src/adapters/out/postgres/skill-store.ts";
import { toolDraftDigest } from "../../src/application/work/artifacts/catalog.ts";
import type { QueuedArtifactSourcePublication } from "../../src/domain/work/artifacts/source-publication.ts";

function postgresTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: !postgresTestEnabled, fn });
}
const repositoryId = "55555555-5555-4555-8555-555555555555";
const sourceScopeId = "fixture-common-source-scope";
const scope = {
  projectId: `git:${repositoryId}`,
  systemId: "source-fixture",
  executionSpaceId: "main",
  operatorId: "Owner",
};

/** Real SQL, common Git and shared W4 pump. Business authority is a controlled
 * host fixture; this does not qualify the native runtime's admission rules. */
async function fixture(database: PostgresTestDatabase) {
  await seedPostgresRuntime(database.client, scope);
  await database.client.sourceRepository.create({
    data: {
      projectId: scope.projectId,
      systemId: scope.systemId,
      repositoryId,
      sourceScopeId,
    },
  });
  const projectDir = await Deno.makeTempDir({
    prefix: "assembly-git-pg-binding-",
  });
  const queue = new PostgresModelWriteQueue({
    client: database.client,
    scope,
    writerLock: () => repositoryWriterLock(repository.stateDir),
  });
  const options = {
    projectDir,
    repositoryId,
    compiler: queueTestCompiler,
    writeFence: {
      assertCurrent: (fence: Parameters<typeof queue.heartbeat>[0]) =>
        queue.heartbeat(fence, 30_000),
      guard: <T>(
        fence: Parameters<typeof queue.heartbeat>[0],
        operation: () => Promise<T>,
      ) => queue.guardPublication(fence, 30_000, operation),
    },
  };
  const repository = await GitModelRepository.open(options);
  const base = await repository.initialize({
    "fixture.sysml": "package SourceFixture;\n",
  });
  const sourceRepository = repository.artifactSources(sourceScopeId);
  let permitted = true;
  const sourceWrites = {
    scopeId: sourceScopeId,
    repository: sourceRepository,
    assertCurrent(publication: QueuedArtifactSourcePublication) {
      if (
        !permitted || publication.target.operatorId !== scope.operatorId ||
        publication.target.ownerId !== "Owner" ||
        publication.baseVersion !== base.version
      ) {
        throw new ModelRepositoryError(
          "EDIT_SCOPE_DENIED",
          "Source fixture authority is not current",
        );
      }
      return Promise.resolve();
    },
  };
  const worker = new ModelWriteWorker({
    queue,
    repository,
    publication: unusedPublication,
    owner: "source-fixture-writer",
    artifactSourceWrites: sourceWrites,
  });
  const writer = new QueuedModelWriter(
    repositoryId,
    queue,
    worker,
    queueTestCompiler,
    repository,
  );
  const publisher = new DurableQueuedArtifactSourcePublisher({
    repositoryId,
    queue,
    artifactSourceWrites: sourceWrites,
    pump: () => writer.pump(),
    waitMs: 10_000,
  });
  const bindings = new PostgresArtifactBindings({
    client: database.client,
    scope,
    repositoryId,
    sourceScopeId,
  });
  const service = (
    bindingStore: ArtifactSourceBindingsPort = bindings,
    reader = sourceRepository,
  ) =>
    new ArtifactSourceService({
      scope,
      repositoryId,
      sourceScopeId,
      repository: reader,
      queuedPublisher: publisher,
      bindings: bindingStore,
      sourceHeader: (version) => repository.header(version),
    });
  const request = (id: string, invocationId: string, digest: string) => ({
    artifactId: id,
    ownerId: "Owner",
    localArtifactId: id,
    invocationId,
    baseVersion: base.version,
    expectedDigest: digest,
    proof: {
      kind: "admitted-model-seed" as const,
      ownerId: "Owner",
      sourceElementId: `fixture-seed-${id}`,
      modelVersion: {
        digest: base.semanticDigest,
        repositoryVersion: base.version,
      },
    },
  });
  return {
    repository,
    sourceRepository,
    base,
    queue,
    bindings,
    service,
    request,
    options,
    setPermitted(value: boolean) {
      permitted = value;
    },
    async close() {
      await writer.close();
      await Deno.remove(projectDir, { recursive: true });
    },
  };
}
function selection(binding: BoundArtifactSource): ArtifactSourceSelection {
  return {
    expectedBinding: binding,
    bindingId: binding.bindingId,
    ownerId: binding.ownerId,
    localArtifactId: binding.localArtifactId,
    expectedDigest: binding.reference.contentDigest,
    reference: binding.reference,
  };
}

postgresTest(
  "source publication uses common Git/W4 and immutable scoped SQL bindings without activating content",
  async () => {
    await withPostgresDatabase(async (database) => {
      const f = await fixture(database);
      try {
        const service = f.service();
        const draft = {
          name: "Source Tool",
          description: "Exact retained tool",
          kind: "read_web_page" as const,
          code: "export default () => ({title:'first',text:'retained'});",
        };
        const toolRequest = {
          ...f.request("tool", "tool-invocation", await toolDraftDigest(draft)),
          draft,
        };
        const tool = await service.publishTool(toolRequest);
        const firstContent = "# Skill\nUse the first exact version.\n";
        const secondContent = "# Skill\nUse the second exact version.\n";
        const first = await service.publishSkill({
          ...f.request(
            "skill-first",
            "skill-first-invocation",
            await skillContentDigest(firstContent),
          ),
          content: firstContent,
        });
        const second = await service.publishSkill({
          ...f.request(
            "skill-second",
            "skill-second-invocation",
            await skillContentDigest(secondContent),
          ),
          content: secondContent,
        });
        notEqual(first.reference.commitOid, second.reference.commitOid);
        deepStrictEqual(await service.resolveTool(selection(tool)), draft);
        for (
          const tampered of [
            { ...tool, versionId: "different-source-version" },
            { ...tool, revision: tool.revision + 1 },
            { ...tool, invocationId: "different-install-invocation" },
          ]
        ) {
          await rejects(
            () =>
              service.resolveTool({
                ...selection(tool),
                expectedBinding: tampered,
              }),
            ArtifactSourceError,
          );
        }
        equal(await service.resolveSkill(selection(first)), firstContent);
        equal(await service.resolveSkill(selection(second)), secondContent);
        deepStrictEqual(await service.publishTool(toolRequest), tool);
        equal(await database.client.artifactVersion.count(), 3);
        equal(await database.client.artifactBinding.count(), 3);
        equal(await database.client.runtimeState.count(), 0);
        equal((await f.repository.current()).version, f.base.version);
        for (const entry of await f.queue.list(repositoryId)) {
          equal(entry.state, "published");
        }
        const reopened = await GitModelRepository.open(f.options);
        const restartedBindings = new PostgresArtifactBindings({
          client: database.createClient(),
          scope,
          repositoryId,
          sourceScopeId,
        });
        equal(
          await f.service(
            restartedBindings,
            reopened.artifactSources(sourceScopeId),
          ).resolveSkill(selection(first)),
          firstContent,
        );
        await rejects(
          () =>
            service.resolveSkill({
              ...selection(first),
              reference: second.reference,
            }),
          ArtifactSourceError,
        );
        await rejects(
          () =>
            service.resolveTool({
              ...selection(tool),
              localArtifactId: "another-local-tool",
            }),
          ArtifactSourceError,
        );
        const peerScope = { ...scope, operatorId: "Peer" };
        await seedPostgresRuntime(database.client, peerScope);
        const peer = new PostgresArtifactBindings({
          client: database.client,
          scope: peerScope,
          repositoryId,
          sourceScopeId,
        });
        equal(await peer.read(tool.bindingId), null);
        await rejects(() =>
          database.client.artifactVersion.update({
            where: {
              projectId_systemId_versionId: {
                projectId: scope.projectId,
                systemId: scope.systemId,
                versionId: tool.versionId,
              },
            },
            data: { contentDigest: "f".repeat(64) },
          })
        );
        deepStrictEqual(await service.resolveTool(selection(tool)), draft);
      } finally {
        await f.close();
      }
    });
  },
);

postgresTest(
  "source publication recovers retained Git receipt before SQL binding and rechecks current authority",
  async () => {
    await withPostgresDatabase(async (database) => {
      const f = await fixture(database);
      try {
        let interrupted = false;
        const failBeforeSql: ArtifactSourceBindingsPort = {
          bind() {
            interrupted = true;
            return Promise.reject(
              new Error("Synthetic stop before canonical source binding"),
            );
          },
          read: (id) => f.bindings.read(id),
        };
        const content = "# Recover\nKeep these original bytes.\n";
        const request = {
          ...f.request(
            "recover-skill",
            "recover-invocation",
            await skillContentDigest(content),
          ),
          content,
        };
        await rejects(() => f.service(failBeforeSql).publishSkill(request));
        equal(interrupted, true);
        equal(await database.client.artifactVersion.count(), 0);
        equal(await database.client.artifactBinding.count(), 0);
        const entries = await f.queue.list(repositoryId);
        equal(entries.length, 1);
        equal(entries[0].state, "published");
        const command = {
          commandId: entries[0].command.commandId,
          commandDigest: entries[0].commandDigest,
        };
        const retained = await f.sourceRepository.findByCommand(command);
        equal(retained?.reference.contentDigest, request.expectedDigest);
        f.setPermitted(false);
        await rejects(
          () => f.service().publishSkill(request),
          (error: unknown) =>
            error instanceof ModelRepositoryError &&
            error.code === "EDIT_SCOPE_DENIED",
        );
        equal(await database.client.artifactBinding.count(), 0);
        f.setPermitted(true);
        const reopened = await GitModelRepository.open(f.options);
        const bindingStore = new PostgresArtifactBindings({
          client: database.createClient(),
          scope,
          repositoryId,
          sourceScopeId,
        });
        const service = f.service(
          bindingStore,
          reopened.artifactSources(sourceScopeId),
        );
        const binding = await service.publishSkill(request);
        deepStrictEqual(binding.reference, retained!.reference);
        deepStrictEqual(await service.publishSkill(request), binding);
        equal(await service.resolveSkill(selection(binding)), content);
        equal(await database.client.artifactVersion.count(), 1);
        equal(await database.client.artifactBinding.count(), 1);
        const differentDigest = await skillContentDigest("# Different\n");
        await rejects(() =>
          service.publishSkill({
            ...request,
            content: "# Different\n",
            expectedDigest: differentDigest,
          })
        );
        equal(await database.client.artifactBinding.count(), 1);
        equal((await f.repository.current()).version, f.base.version);
      } finally {
        await f.close();
      }
    });
  },
);

postgresTest(
  "actual skill installation/load/guidance uses exact Git/SQL sources and refuses missing retained bytes",
  async () => {
    await withPostgresDatabase(async (database) => {
      const f = await fixture(database);
      const store = new PostgresContextSkillsStore(database.client, scope);
      let allowed = true;
      try {
        const content =
          "---\nname: exact-skill\ndescription: Preserve the selected source.\n---\n# Instructions\nUse the retained exact version.\n";
        const service = f.service();
        const authority = (invocationId: string): SkillAuthority => ({
          callerId: "Owner",
          behaviorId: "fixture-skill-behavior",
          invocationId,
          modelVersion: {
            digest: f.base.semanticDigest,
            repositoryVersion: f.base.version,
          },
          permissions: ["install", "list", "load", "unload"],
          policy: {
            id: "fixture-skill-policy",
            ownerId: "Owner",
            allowedHosts: ["example.org"],
            maxSkillBytes: 65536,
            maxInstalledSkills: 32,
            maxLoadedSkills: 4,
            maxLoadedCharacters: 48000,
          },
        });
        const skills = new ContextSkillsService({
          store,
          download: {
            download(url) {
              return Promise.resolve({
                content,
                requestedUrl: url,
                finalUrl: url,
                byteLength: new TextEncoder().encode(content).length,
              });
            },
          },
          artifactSources(ownerId) {
            equal(ownerId, "Owner");
            return Promise.resolve(service);
          },
          assertCurrentAuthority(auth, permission) {
            requireSkillAuthority(auth, permission);
            if (
              !allowed || auth.callerId !== "Owner" ||
              auth.modelVersion.repositoryVersion !== f.base.version
            ) {
              throw new SkillError(
                "forbidden",
                "Fixture current skill authority changed",
              );
            }
            return Promise.resolve();
          },
          now: () => "2026-10-28T01:00:00.000Z",
        });
        const digest = await skillContentDigest(content);
        const install = await skills.install(authority("skill-install"), {
          id: "exact-skill",
          url: "https://example.org/SKILL.md",
          expectedDigest: digest,
        });
        equal(install.skill.digest, digest);
        const installed = (await store.load("Owner"))!.skills[0];
        equal(installed.sourceBinding?.reference.contentDigest, digest);
        await skills.load(authority("skill-load"), {
          id: "exact-skill",
          expectedDigest: digest,
        });
        equal(
          (await skills.guidance(authority("skill-guidance")))[0].content,
          content,
        );
        allowed = false;
        await rejects(
          () => skills.guidance(authority("skill-revoked")),
          SkillError,
        );
        allowed = true;
        const command = new Deno.Command("git", {
          args: [
            "--no-replace-objects",
            `--git-dir=${f.options.projectDir}/.git`,
            "update-ref",
            "-d",
            `refs/assembly/sources/v2/${
              installed.sourceBinding!.reference.manifestDigest
            }`,
          ],
          clearEnv: true,
          env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
          stdout: "piped",
          stderr: "null",
        });
        equal((await command.output()).success, true);
        equal((await store.load("Owner"))!.skills[0].content, content);
        await rejects(() => skills.guidance(authority("skill-missing-source")));
        equal((await f.repository.current()).version, f.base.version);
      } finally {
        await store.close();
        await f.close();
      }
    });
  },
);
