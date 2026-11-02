import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { ContextSkillsService } from "../../src/application/skills/context-skills.ts";
import { PostgresContextSkillsStore } from "../../src/adapters/out/postgres/skill-store.ts";
import type { PostgresRuntimeScope } from "../../src/adapters/out/postgres/scope.ts";
import {
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { skillSourceFixture } from "../support/skill-source-fixture.ts";
import {
  type SkillAuthority,
  skillContentDigest,
  SkillError,
} from "../../src/domain/skills/context-skills.ts";

const scope: PostgresRuntimeScope = {
  projectId: "project",
  systemId: "system",
  executionSpaceId: "space",
  operatorId: "builder",
};

const content =
  "---\nname: ase\ndescription: Preserve native authority.\n---\n# ASE\nUse exact admitted source versions.\n";
function authority(invocationId: string): SkillAuthority {
  return {
    callerId: "builder",
    policy: {
      id: "skill-policy",
      ownerId: "builder",
      allowedHosts: [],
      maxSkillBytes: 65536,
      maxInstalledSkills: 32,
      maxLoadedSkills: 4,
      maxLoadedCharacters: 48000,
    },
    modelVersion: {
      digest: "a".repeat(64),
      repositoryVersion: "branch:admitted",
    },
    behaviorId: "native-operation",
    invocationId,
    permissions: ["install", "list", "load", "unload"],
  };
}
function service(
  store: PostgresContextSkillsStore,
  sources: ReturnType<typeof skillSourceFixture>,
) {
  return new ContextSkillsService({
    ...sources.ports,
    store,
    now: () => "2026-10-22T10:00:00.000Z",
    download: {
      download() {
        throw new Error("Bundled skill installation cannot call the network");
      },
    },
  });
}

Deno.test({
  name:
    "PostgreSQL skills service preserves atomic seeds, unload and exact versions across restart",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient: reopen }) => {
      await seedPostgresRuntime(client, scope);
      let store = new PostgresContextSkillsStore(client, scope);
      const sources = skillSourceFixture();
      let skills = service(store, sources);
      const seed = {
        id: "ase",
        content,
        source: "bundled:ase",
        expectedDigest: await skillContentDigest(content),
        loaded: true,
      };
      const first = await skills.installBundled(authority("bootstrap"), seed);
      equal(first.skill.loaded, true);
      equal(first.catalogRevision, 1);
      equal(first.operation.initiallyLoaded, true);
      equal((await store.load("builder"))!.operations.length, 1);
      const expected = { id: seed.id, expectedDigest: seed.expectedDigest };
      await skills.unload(authority("unload"), expected);
      deepStrictEqual(await skills.guidance(authority("prepare")), []);
      const installedBinding = (await store.load("builder"))!.skills[0]!
        .sourceBinding;
      equal(installedBinding?.invocationId, "bootstrap");
      equal(installedBinding?.reference.contentDigest, seed.expectedDigest);
      await store.close();
      await client.$disconnect();
      store = new PostgresContextSkillsStore(reopen(), scope);
      deepStrictEqual(
        (await store.load("builder"))!.skills[0]!.sourceBinding,
        installedBinding,
      );
      skills = service(store, sources);
      deepStrictEqual(await skills.guidance(authority("prepare")), []);
      const next = authority("bootstrap-new-model");
      next.modelVersion = {
        digest: "b".repeat(64),
        repositoryVersion: "branch:new",
      };
      const preserved = await skills.installBundled(next, seed);
      equal(preserved.skill.loaded, false);
      const loaded = await skills.load(authority("load"), expected);
      equal(loaded.skill.loaded, true);
      equal((await skills.guidance(authority("prepare")))[0]!.content, content);
      await skills.unload(authority("unload-again"), expected);
      const replay = await skills.load(authority("load"), expected);
      equal(replay.replayed, true);
      equal(replay.skill.loaded, false);
      equal(replay.operation.revision, 4);
      equal(replay.catalogRevision, 5);
      const record = (await store.load("builder"))!;
      equal(record.operations.length, 5);
      equal(record.skills[0]!.content, content);
      equal(record.skills[0]!.source.modelVersion.digest, "a".repeat(64));
      equal(
        JSON.stringify(await skills.list(authority("list"))).includes("# ASE"),
        false,
      );
      await store.close();
    });
  },
});

Deno.test({
  name:
    "PostgreSQL skills service owner CAS prevents concurrent loads exceeding current limits",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient: reopen }) => {
      await seedPostgresRuntime(client, scope);
      const store = new PostgresContextSkillsStore(client, scope);
      const sources = skillSourceFixture();
      const skills = service(store, sources);
      const digest = await skillContentDigest(content);
      for (const id of ["one", "two"]) {
        await skills.installBundled(authority(`install-${id}`), {
          id,
          content,
          source: `bundled:${id}`,
          expectedDigest: digest,
        });
      }
      const competingStore = new PostgresContextSkillsStore(reopen(), scope);
      const competingSkills = service(competingStore, sources);
      const one = authority("load-one"), two = authority("load-two");
      one.policy.maxLoadedSkills = two.policy.maxLoadedSkills = 1;
      const results = await Promise.allSettled([
        skills.load(one, { id: "one", expectedDigest: digest }),
        competingSkills.load(two, { id: "two", expectedDigest: digest }),
      ]);
      equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const failed = results.find((result) => result.status === "rejected");
      ok(failed?.status === "rejected");
      ok(failed.reason instanceof SkillError);
      ok(failed.reason.code === "conflict" || failed.reason.code === "limit");
      equal((await skills.guidance(authority("prepare"))).length, 1);
      equal((await store.load("builder"))!.revision, 3);
      equal((await store.load("builder"))!.operations.length, 3);
      equal(await client.skillInvocation.count({ where: scope }), 3);
      await competingStore.close();
      await store.close();
    });
  },
});

Deno.test({
  name:
    "PostgreSQL skills production service never reactivates an unloaded source seed on restart or replay",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient: reopen }) => {
      await seedPostgresRuntime(client, scope);
      let store = new PostgresContextSkillsStore(client, scope);
      const authority = (invocationId: string): SkillAuthority => ({
        callerId: "builder",
        behaviorId: "native-skill-operation",
        invocationId,
        modelVersion: {
          digest: "native-model",
          repositoryVersion: "branch:admitted",
        },
        permissions: ["install", "list", "load", "unload"],
        policy: {
          id: "skill-policy",
          ownerId: "builder",
          allowedHosts: [],
          maxSkillBytes: 65536,
          maxInstalledSkills: 32,
          maxLoadedSkills: 4,
          maxLoadedCharacters: 48000,
        },
      });
      const sources = skillSourceFixture();
      const service = () =>
        new ContextSkillsService({
          ...sources.ports,
          store,
          download: {
            download: () =>
              Promise.reject(new Error("No network for source seed")),
          },
          now: () => "2026-10-22T00:00:00.000Z",
        });
      const content =
        "---\nname: ase\ndescription: Local model construction.\n---\n# ASE\nUse native controls.\n";
      const input = {
        id: "ase",
        content,
        expectedDigest: await skillContentDigest(content),
        source: "bundled:ase",
        loaded: true,
      };
      const installed = await service().installBundled(
        authority("source-seed"),
        input,
      );
      equal(installed.skill.loaded, true);
      equal(Object.hasOwn(installed.skill, "content"), false);
      equal((await service().guidance(authority("read")))[0]!.content, content);
      await service().unload(authority("unload-source"), {
        id: input.id,
        expectedDigest: input.expectedDigest,
      });
      await store.close();
      await client.$disconnect();
      store = new PostgresContextSkillsStore(reopen(), scope);
      deepStrictEqual(
        await service().guidance(authority("read-after-restart")),
        [],
      );
      const replay = await service().installBundled(
        authority("source-seed"),
        input,
      );
      equal(replay.replayed, true);
      equal(replay.skill.loaded, false);
      const reaffirmed = await service().installBundled(
        authority("reaffirm-source-seed"),
        input,
      );
      equal(reaffirmed.skill.loaded, false);
      deepStrictEqual(
        await service().guidance(authority("read-after-reaffirmation")),
        [],
      );
      equal((await service().list(authority("list")))[0]!.loaded, false);
      equal(
        Object.hasOwn((await service().list(authority("list")))[0]!, "content"),
        false,
      );
      await store.close();
    });
  },
});
