import assert from "node:assert/strict";
import type { PrismaClient } from "../../src/adapters/out/postgres/client.ts";
import { registerPostgresClientSchema } from "../../src/adapters/out/postgres/client-schema.ts";
import { skillSourceFixture } from "../support/skill-source-fixture.ts";
import { withPostgresExecutionTransaction } from "../../src/adapters/out/postgres/execution-transaction.ts";
import {
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";
import type { PostgresRuntimeScope } from "../../src/adapters/out/postgres/scope.ts";
import {
  MAX_MEMORY_STORE_PAYLOAD_BYTES,
  PostgresGovernedMemoryStore,
} from "../../src/adapters/out/postgres/memory-store.ts";
import { PostgresContextSkillsStore } from "../../src/adapters/out/postgres/skill-store.ts";
import type { MemoryStorePort } from "../../src/application/memory/ports/store.ts";
import { GovernedMemoryPromotionService } from "../../src/application/memory/governed-memory-promotion.ts";
import { ContextSkillsService } from "../../src/application/skills/context-skills.ts";
import {
  type MemoryAuthority,
  memoryContentDigest,
  MemoryError,
} from "../../src/domain/memory/governed-memory-promotion.ts";
import {
  type SkillAuthority,
  skillContentDigest,
  SkillError,
} from "../../src/domain/skills/context-skills.ts";
import type {
  MemoryContent,
  MemoryRecord,
} from "../../src/domain/memory/entities/memory-record.ts";
import type {
  SkillCatalogRecord,
  SkillOperation,
} from "../../src/domain/skills/records/catalog.ts";

const time = "2026-10-22T00:00:00.000Z";
const modelVersion = {
  digest: "admitted-model-digest",
  repositoryVersion: "branch:admitted-model",
};

function authority(
  invocationId: string,
  callerId = "contributor",
  ownerId = "operator-one",
): MemoryAuthority {
  return {
    callerId,
    behaviorId: "native-memory-exposure",
    invocationId,
    modelVersion,
    policy: {
      id: "native-memory-policy",
      ownerId,
      modelVersion,
      allowedScopes: ["source-quality"],
      permissions: {
        capture: ["contributor"],
        revise: ["contributor"],
        recall: ["contributor", "reviewer"],
        admit: ["reviewer"],
        reject: ["reviewer"],
        withdraw: ["reviewer"],
      },
      requireSourceRefs: true,
      requireKnownOutcome: true,
      maxValidityMs: 86_400_000,
      allowSelfAdmission: false,
    },
  };
}

function content(
  text = "Confirm source dates before using their conclusions.",
): MemoryContent {
  return {
    text,
    origin: { decisionId: "decision-1", sourceRefs: ["source-1"] },
    scope: ["source-quality"],
    validUntil: "2026-10-22T12:00:00.000Z",
    outcome: {
      status: "known",
      summary: "The recorded source was stale.",
      evidenceRefs: ["result-1"],
    },
  };
}

function service(store: MemoryStorePort, now = time) {
  return new GovernedMemoryPromotionService({
    store,
    // This fixture stands for the evidence resolver, not for native provenance.
    provenance: {
      verify: (ownerId, candidate) =>
        Promise.resolve(
          ownerId.length > 0 && candidate.origin.decisionId === "decision-1" &&
            candidate.origin.sourceRefs.every((ref) => ref === "source-1") &&
            (candidate.outcome.status === "pending" ||
              candidate.outcome.evidenceRefs.every((ref) =>
                ref === "result-1"
              )),
        ),
    },
    now: () => now,
  });
}

function expected(record: MemoryRecord) {
  return { revision: record.revision, digest: record.digest };
}

const at = "2026-10-22T00:00:00.000Z";
const version = {
  digest: "native-model",
  repositoryVersion: "branch:admitted",
};
async function initial(
  ownerId = "builder",
  id = "ase",
  invocationId = "install-1",
) {
  const content =
    "# ASE modeling\nUse the admitted model and its typed operations.\n";
  const digest = await skillContentDigest(content);
  return {
    ownerId,
    revision: 1,
    skills: [{
      id,
      name: "ASE modeling",
      description: "Model-directed instruction text.",
      digest,
      byteLength: new TextEncoder().encode(content).length,
      content,
      source: {
        kind: "bundled" as const,
        location: "bundled:ase-modeling",
        acquiredAt: at,
        modelVersion: version,
      },
      installedAt: at,
      loaded: false,
    }],
    operations: [{
      kind: "install" as const,
      skillId: id,
      skillDigest: digest,
      callerId: ownerId,
      behaviorId: "install-exposure",
      invocationId,
      requestDigest: "a".repeat(64),
      policyId: "native-skill-policy",
      modelVersion: version,
      at,
      revision: 1,
    }],
  } satisfies SkillCatalogRecord;
}
function next(
  original: SkillCatalogRecord,
  kind: "load" | "unload",
  invocationId: string,
) {
  const record: SkillCatalogRecord = structuredClone(original);
  const skill = record.skills[0]!;
  record.revision++;
  const event: SkillOperation = {
    ...record.operations[0]!,
    kind,
    invocationId,
    behaviorId: `${kind}-exposure`,
    requestDigest: (kind === "load" ? "b" : "c").repeat(64),
    revision: record.revision,
  };
  record.operations.push(event);
  skill.loaded = kind === "load";
  if (skill.loaded) {
    skill.loadedAt = at;
    skill.loadedBy = version;
  } else {
    delete skill.loadedAt;
    delete skill.loadedBy;
  }
  return record;
}

const scope: PostgresRuntimeScope = {
  projectId: "project",
  systemId: "system",
  executionSpaceId: "space",
  operatorId: "operator",
};

async function initialMemory(
  id = "note",
  invocationId = "capture",
  text = "Preserve evidence dates.",
): Promise<MemoryRecord> {
  const content = {
    text,
    origin: { decisionId: "decision", sourceRefs: ["source"] },
    scope: ["source-quality"],
    validUntil: "2026-10-22T12:00:00.000Z",
    outcome: {
      status: "known" as const,
      summary: "Source dates verified.",
      evidenceRefs: ["result"],
    },
  };
  const digest = await memoryContentDigest("owner", content);
  return {
    id,
    ownerId: "owner",
    contributorId: "contributor",
    revision: 1,
    digest,
    content,
    status: "candidate",
    createdAt: at,
    updatedAt: at,
    history: [{
      operation: "capture",
      callerId: "contributor",
      behaviorId: "capture-exposure",
      invocationId,
      modelVersion: version,
      policyId: "policy",
      requestDigest: "a".repeat(64),
      at,
      revision: 1,
      digest,
      status: "candidate",
      content: structuredClone(content),
    }],
  };
}

function reviewMemory(
  record: MemoryRecord,
  decision: "admit" | "reject",
  invocationId: string,
): MemoryRecord {
  const revised = structuredClone(record);
  revised.revision++;
  revised.status = decision === "admit" ? "admitted" : "rejected";
  revised.history.push({
    ...structuredClone(revised.history[0]!),
    operation: decision,
    callerId: "reviewer",
    invocationId,
    revision: revised.revision,
    status: revised.status,
    requestDigest: (decision === "admit" ? "b" : "c").repeat(64),
  });
  return revised;
}

function oneWinner(
  results: PromiseSettledResult<void>[],
  ErrorType: typeof MemoryError | typeof SkillError,
) {
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failed = results.find((result) => result.status === "rejected");
  assert.equal(failed?.status, "rejected");
  if (failed?.status === "rejected") {
    assert.ok(failed.reason instanceof ErrorType);
    assert.equal(failed.reason.code, "conflict");
  }
}

Deno.test({
  name:
    "PG-2 memory loses an execution claim after writing and rolls back both revision and invocation",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, schema }) => {
      await seedPostgresRuntime(client, scope);
      const store = new PostgresGovernedMemoryStore(client, scope);
      const original = await initialMemory();
      await store.save(original, null);
      const admitted = reviewMemory(original, "admit", "lost-claim-admission");
      let checks = 0;
      await assert.rejects(() =>
        withPostgresExecutionTransaction({
          client,
          fence: async (query) => {
            checks++;
            if (checks !== 2) return;
            const { rows } = await query(
              `SELECT payload FROM "${schema}"."GovernedMemory"`,
            );
            assert.deepEqual(JSON.parse(rows[0]!.payload as string), admitted);
            const invocations = await query(
              `SELECT "requestDigest" FROM "${schema}"."MemoryInvocation" WHERE "invocationId" = $1`,
              ["lost-claim-admission"],
            );
            assert.equal(
              invocations.rows[0]!.requestDigest,
              admitted.history.at(-1)!.requestDigest,
            );
            throw new Error("Worker claim lost before memory commit");
          },
        }, () =>
          store.save(admitted, {
            revision: original.revision,
            digest: original.digest,
          })), /Worker claim lost before memory commit/);
      assert.equal(checks, 2);
      assert.deepEqual(
        await store.load(original.ownerId, original.id),
        original,
      );
      assert.equal(
        await client.memoryInvocation.count({
          where: { ...scope, invocationId: "lost-claim-admission" },
        }),
        0,
      );
      await store.save(admitted, {
        revision: original.revision,
        digest: original.digest,
      });
      assert.deepEqual(
        await store.load(original.ownerId, original.id),
        admitted,
      );
    });
  },
});

Deno.test({
  name:
    "PG-2 memory and skills preserve exact bytes, snapshots and namespaces across restart",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient: reopen }) => {
      const sibling = { ...scope, executionSpaceId: "sibling" };
      const other = { ...scope, projectId: "other-project" };
      for (const namespace of [scope, sibling, other]) {
        await seedPostgresRuntime(client, namespace);
      }
      const memory = await initialMemory();
      const catalog: SkillCatalogRecord = await initial();
      const savedMemory = structuredClone(memory);
      const savedCatalog = structuredClone(catalog);
      const namespaceRecords = [{
        namespace: scope,
        memory: savedMemory,
        catalog: savedCatalog,
      }];
      const mutableScope = { ...scope };
      const memories = new PostgresGovernedMemoryStore(client, mutableScope);
      const skills = new PostgresContextSkillsStore(client, mutableScope);
      const pendingMemory = memories.save(memory, null);
      const pendingSkills = skills.save(catalog, null);
      memory.content.text = "caller mutation";
      memory.history[0]!.content.text = "caller mutation";
      catalog.skills[0]!.content = "caller mutation";
      mutableScope.projectId = "caller mutation";
      await Promise.all([pendingMemory, pendingSkills]);
      for (const namespace of [sibling, other]) {
        const namespacedMemory = await initialMemory(
          "note",
          "capture",
          `${namespace.projectId}/${namespace.executionSpaceId}`,
        );
        const namespacedCatalog = structuredClone(savedCatalog);
        namespacedCatalog.skills[0]!.description =
          `${namespace.projectId}/${namespace.executionSpaceId}`;
        await new PostgresGovernedMemoryStore(client, namespace).save(
          namespacedMemory,
          null,
        );
        await new PostgresContextSkillsStore(client, namespace).save(
          namespacedCatalog,
          null,
        );
        namespaceRecords.push({
          namespace,
          memory: namespacedMemory,
          catalog: namespacedCatalog,
        });
      }
      const read = (await memories.load(savedMemory.ownerId, savedMemory.id))!;
      assert.equal(
        read.digest,
        await memoryContentDigest(read.ownerId, read.content),
      );
      read.history[0]!.behaviorId = "reader mutation";
      const skillRead = (await skills.load(savedCatalog.ownerId))!;
      skillRead.skills[0]!.source.location = "reader mutation";
      assert.deepEqual(
        await memories.load(savedMemory.ownerId, savedMemory.id),
        savedMemory,
      );
      assert.deepEqual(await skills.load(savedCatalog.ownerId), savedCatalog);
      // Closing either scoped adapter cannot close another adapter's shared pool.
      await memories.close();
      assert.deepEqual(await skills.load(savedCatalog.ownerId), savedCatalog);
      await skills.close();
      await client.$disconnect();
      const fresh = reopen();
      for (const saved of namespaceRecords) {
        assert.deepEqual(
          await new PostgresGovernedMemoryStore(fresh, saved.namespace).list(
            "owner",
          ),
          [saved.memory],
        );
        assert.deepEqual(
          await new PostgresContextSkillsStore(fresh, saved.namespace).load(
            "builder",
          ),
          saved.catalog,
        );
      }
      assert.equal(
        await new PostgresGovernedMemoryStore(fresh, scope).load(
          "different-owner",
          "note",
        ),
        null,
      );
      assert.equal(
        await new PostgresContextSkillsStore(fresh, scope).load(
          "different-owner",
        ),
        null,
      );
    });
  },
});

Deno.test({
  name:
    "PG-2 competing PostgreSQL memory create and revision CAS have one winner and atomic invocation history",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient: reopen }) => {
      await seedPostgresRuntime(client, scope);
      const writers = [
        new PostgresGovernedMemoryStore(client, scope),
        new PostgresGovernedMemoryStore(reopen(), scope),
      ];
      const original = await initialMemory();
      oneWinner(
        await Promise.allSettled(
          writers.map((store) => store.save(original, null)),
        ),
        MemoryError,
      );
      const expected = { revision: 1, digest: original.digest };
      oneWinner(
        await Promise.allSettled([
          writers[0]!.save(reviewMemory(original, "admit", "admit"), expected),
          writers[1]!.save(
            reviewMemory(original, "reject", "reject"),
            expected,
          ),
        ]),
        MemoryError,
      );
      const winner = (await writers[0]!.load("owner", "note"))!;
      assert.equal(winner.revision, 2);
      assert.equal(winner.history.length, 2);
      assert.equal(await client.memoryInvocation.count({ where: scope }), 2);
      const last = winner.history.at(-1)!;
      const reserved = await client.memoryInvocation.findFirstOrThrow({
        where: { ...scope, invocationId: last.invocationId },
      });
      assert.equal(reserved.requestDigest, last.requestDigest);
      // At the right revision, a wrong content digest still loses CAS.
      const third = reviewMemory(winner, "reject", "third");
      await assert.rejects(
        () => writers[0]!.save(third, { revision: 2, digest: "0".repeat(64) }),
        MemoryError,
      );
      assert.deepEqual(await writers[0]!.load("owner", "note"), winner);
      assert.equal(
        await client.memoryInvocation.count({
          where: { ...scope, invocationId: "third" },
        }),
        0,
      );
      const changed = await initialMemory(
        "other-note",
        "capture",
        "Different request.",
      );
      changed.history[0]!.requestDigest = "f".repeat(64);
      await assert.rejects(() => writers[1]!.save(changed, null), MemoryError);
      assert.equal(await writers[0]!.load("owner", "other-note"), null);
      assert.equal(await client.memoryInvocation.count({ where: scope }), 2);
      const rewritten = structuredClone(third);
      rewritten.history[0]!.behaviorId = "rewritten-admission-origin";
      await assert.rejects(
        () =>
          writers[0]!.save(rewritten, {
            revision: winner.revision,
            digest: winner.digest,
          }),
        /history changed/,
      );
      const changedContributor = structuredClone(third);
      changedContributor.contributorId = "different-contributor";
      await assert.rejects(
        () =>
          writers[0]!.save(changedContributor, {
            revision: winner.revision,
            digest: winner.digest,
          }),
        /representation/,
      );
      const capturedExpected = {
        revision: winner.revision,
        digest: winner.digest,
      };
      const pending = writers[0]!.save(third, capturedExpected);
      capturedExpected.revision = 999;
      capturedExpected.digest = "0".repeat(64);
      await pending;
      assert.deepEqual(await writers[0]!.load("owner", "note"), third);
    });
  },
});

Deno.test({
  name:
    "PG-2 competing PostgreSQL skill creates and CAS updates preserve immutable instruction and operation bytes",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient: reopen }) => {
      await seedPostgresRuntime(client, scope);
      const writers = [
        new PostgresContextSkillsStore(client, scope),
        new PostgresContextSkillsStore(reopen(), scope),
      ];
      const original: SkillCatalogRecord = await initial();
      oneWinner(
        await Promise.allSettled(
          writers.map((store) => store.save(original, null)),
        ),
        SkillError,
      );
      oneWinner(
        await Promise.allSettled([
          writers[0]!.save(next(original, "load", "load-one"), 1),
          writers[1]!.save(next(original, "load", "load-two"), 1),
        ]),
        SkillError,
      );
      const winner = (await writers[0]!.load("builder"))!;
      assert.equal(winner.revision, 2);
      assert.equal(winner.skills[0]!.loaded, true);
      assert.equal(await client.skillInvocation.count({ where: scope }), 2);
      const changed = next(winner, "unload", "rewrite-history");
      changed.operations[0]!.requestDigest = "f".repeat(64);
      await assert.rejects(
        () => writers[0]!.save(changed, 2),
        /history changed/,
      );
      assert.deepEqual(await writers[0]!.load("builder"), winner);
      const reuse = next(winner, "unload", winner.operations[0]!.invocationId);
      reuse.operations.at(-1)!.requestDigest = "e".repeat(64);
      await assert.rejects(
        () => writers[1]!.save(reuse, 2),
        /representation|invocation/,
      );
      assert.equal(await client.skillInvocation.count({ where: scope }), 2);
      const changedContent = next(winner, "unload", "rewrite-content");
      const skill = changedContent.skills[0]!;
      skill.content = "Changed instruction text.";
      skill.byteLength = new TextEncoder().encode(skill.content).length;
      skill.digest = await skillContentDigest(skill.content);
      for (const operation of changedContent.operations) {
        operation.skillDigest = skill.digest;
      }
      await assert.rejects(
        () => writers[0]!.save(changedContent, 2),
        /history changed|content or provenance changed/,
      );
      assert.deepEqual(await writers[0]!.load("builder"), winner);
    });
  },
});

Deno.test({
  name:
    "PG-2 services replay committed memory and skill invocations without restoring withdrawn guidance",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      await seedPostgresRuntime(client, scope);
      let memories = new PostgresGovernedMemoryStore(client, scope);
      let skills = new PostgresContextSkillsStore(client, scope);
      const captured = await service(memories).capture(authority("capture"), {
        id: "guidance",
        content: content(),
      });
      const input = {
        id: "guidance",
        expected: expected(captured.memory),
        decision: "admit" as const,
        reason: "Verified evidence.",
      };
      const admitted = await service(memories).review(
        authority("admit", "reviewer"),
        input,
      );
      await service(memories).withdraw(authority("withdraw", "reviewer"), {
        id: "guidance",
        expected: expected(admitted.memory),
        reason: "Superseded.",
      });
      const skillAuthority = (invocationId: string): SkillAuthority => ({
        callerId: "builder",
        behaviorId: "skill-exposure",
        invocationId,
        modelVersion: version,
        permissions: ["install", "list", "load", "unload"],
        policy: {
          id: "policy",
          ownerId: "builder",
          allowedHosts: [],
          maxSkillBytes: 65536,
          maxInstalledSkills: 32,
          maxLoadedSkills: 4,
          maxLoadedCharacters: 48000,
        },
      });
      const skillSources = skillSourceFixture();
      const skillService = () =>
        new ContextSkillsService({
          ...skillSources.ports,
          store: skills,
          download: {
            download: () =>
              Promise.reject(new Error("No network in qualification")),
          },
          now: () => at,
        });
      const source =
        "---\nname: local\ndescription: Source-backed instruction.\n---\n# Local\nUse native controls.\n";
      const install = {
        id: "local",
        content: source,
        expectedDigest: await skillContentDigest(source),
        source: "bundled:local",
        loaded: true,
      };
      await skillService().installBundled(skillAuthority("install"), install);
      await skillService().unload(skillAuthority("unload"), {
        id: "local",
        expectedDigest: install.expectedDigest,
      });
      await memories.close();
      await skills.close();
      await client.$disconnect();
      const fresh = createClient();
      memories = new PostgresGovernedMemoryStore(fresh, scope);
      skills = new PostgresContextSkillsStore(fresh, scope);
      const replay = await service(memories).review(
        authority("admit", "reviewer"),
        input,
      );
      assert.equal(replay.replayed, true);
      assert.equal(replay.operation.status, "admitted");
      assert.equal(replay.memory.status, "withdrawn");
      assert.equal(replay.memory.usableAsGuidance, false);
      assert.equal(
        (await memories.load("operator-one", "guidance"))!.revision,
        3,
      );
      const installReplay = await skillService().installBundled(
        skillAuthority("install"),
        install,
      );
      assert.equal(installReplay.replayed, true);
      assert.equal(installReplay.skill.loaded, false);
      assert.deepEqual(
        await skillService().guidance(skillAuthority("read")),
        [],
      );
      assert.equal((await skills.load("builder"))!.revision, 2);
      await assert.rejects(
        () =>
          skillService().installBundled(skillAuthority("install"), {
            ...install,
            loaded: false,
          }),
        SkillError,
      );
      await assert.rejects(
        () =>
          service(memories).capture(authority("capture"), {
            id: "guidance",
            content: content("Changed request."),
          }),
        MemoryError,
      );
      const bound = (await skills.load("builder"))!;
      assert.equal(bound.skills[0]!.sourceBinding!.ownerId, "builder");
      const wrongOwner = structuredClone(bound);
      wrongOwner.skills[0]!.sourceBinding!.ownerId = "different-owner";
      await fresh.skillCatalog.updateMany({
        where: { ...scope, ownerId: "builder" },
        data: { payload: JSON.stringify(wrongOwner) },
      });
      await assert.rejects(() => skills.load("builder"), /representation/);
    });
  },
});

Deno.test({
  name:
    "PG-2 skill evidence budgets precede payload materialization and preserve scope",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      const sibling = { ...scope, executionSpaceId: "sibling" };
      await seedPostgresRuntime(client, scope);
      await seedPostgresRuntime(client, sibling);
      const skills = new PostgresContextSkillsStore(client, scope);
      const other = new PostgresContextSkillsStore(client, sibling);
      const own: SkillCatalogRecord = await initial();
      const different: SkillCatalogRecord = await initial(
        "builder",
        "different",
      );
      await skills.save(own, null);
      await other.save(different, null);
      const budget = {
        ownerId: own.ownerId,
        maxSnapshots: 1,
        maxPayloadBytes: 16 * 1024 * 1024,
        maxTotalBytes: 16 * 1024 * 1024,
      };
      const evidence = await skills.readNetworkImpactEvidence(budget);
      assert.equal(evidence.complete, true);
      assert.equal(evidence.snapshotsRead, 1);
      assert.equal(
        evidence.bytesRead,
        new TextEncoder().encode(JSON.stringify(own)).length,
      );
      assert.equal(evidence.snapshots[0]!.payload, JSON.stringify(own));
      assert.deepEqual(evidence.revisionBounds, { from: 1, to: 1 });
      const payloadLimit = await skills.readNetworkImpactEvidence({
        ...budget,
        maxPayloadBytes: evidence.bytesRead - 1,
      });
      assert.equal(payloadLimit.complete, false);
      assert.equal(payloadLimit.bytesRead, 0);
      assert.deepEqual(payloadLimit.snapshots, []);
      assert.equal(payloadLimit.issues[0]!.code, "EVIDENCE_PAYLOAD_LIMIT");
      const totalLimit = await skills.readNetworkImpactEvidence({
        ...budget,
        maxTotalBytes: evidence.bytesRead - 1,
      });
      assert.equal(totalLimit.complete, false);
      assert.equal(totalLimit.bytesRead, 0);
      assert.equal(totalLimit.issues[0]!.code, "EVIDENCE_BYTE_LIMIT");
      const controller = new AbortController();
      controller.abort();
      const aborted = await skills.readNetworkImpactEvidence({
        ...budget,
        signal: controller.signal,
      });
      const secondOwner = await initial("second-owner");
      await skills.save(secondOwner, null);
      const pending = skills.readNetworkImpactEvidence(budget);
      const loaded = next(own, "load", "evidence-load");
      const write = skills.save(loaded, own.revision);
      assert.deepEqual(await pending, evidence);
      await write;
      assert.deepEqual(evidence.revisionBounds, { from: 1, to: 1 });
      assert.deepEqual(
        (await skills.readNetworkImpactEvidence(budget)).revisionBounds,
        { from: 2, to: 2 },
      );
      assert.deepEqual(await skills.load("second-owner"), secondOwner);
      const absent = await skills.readNetworkImpactEvidence({
        ...budget,
        ownerId: "absent",
      });
      assert.equal(absent.complete, false);
      assert.deepEqual(absent.revisionBounds, { from: null, to: null });
      assert.equal(absent.snapshotsRead, 0);

      assert.equal(aborted.issues[0]!.code, "EVIDENCE_ABORTED");
      assert.equal(aborted.snapshotsRead, 0);
      assert.deepEqual(await other.load("builder"), different);
    });
  },
});

Deno.test({
  name:
    "PG-2 corrupt stored memory and skill payloads fail closed without reserving failed writes",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, scope);
      const memories = new PostgresGovernedMemoryStore(client, scope);
      const skills = new PostgresContextSkillsStore(client, scope);
      const memory = await initialMemory();
      const catalog: SkillCatalogRecord = await initial();
      await memories.save(memory, null);
      await skills.save(catalog, null);
      const nextMemory = reviewMemory(memory, "admit", "failed-review");
      const nextCatalog = next(catalog, "load", "failed-load");
      for (
        const payload of [
          "{",
          JSON.stringify({ ...memory, digest: "0".repeat(64) }),
          JSON.stringify({ ...memory, ownerId: "other-owner" }),
          JSON.stringify({ ...memory, revision: 42 }),
          JSON.stringify({ ...memory, history: [] }),
          JSON.stringify({
            ...memory,
            history: memory.history.map((entry) => ({
              ...entry,
              content: { ...entry.content, text: "replaced" },
            })),
          }),
        ]
      ) {
        await client.governedMemory.updateMany({
          where: scope,
          data: { payload },
        });
        await assert.rejects(
          () => memories.load("owner", "note"),
          /stored|Corrupt/,
        );
        await assert.rejects(() => memories.list("owner"), /stored|Corrupt/);
        await assert.rejects(
          () =>
            memories.save(nextMemory, { revision: 1, digest: memory.digest }),
          /stored|Corrupt/,
        );
        assert.equal(
          await client.memoryInvocation.count({
            where: { ...scope, invocationId: "failed-review" },
          }),
          0,
        );
      }
      await client.governedMemory.updateMany({
        where: scope,
        data: { payload: JSON.stringify(memory), digest: "f".repeat(64) },
      });
      await assert.rejects(() => memories.load("owner", "note"), /digest/);
      await client.skillCatalog.updateMany({
        where: scope,
        data: { payload: "{" },
      });
      await assert.rejects(() => skills.load("builder"), /representation/);
      await assert.rejects(() => skills.save(nextCatalog, 1), /representation/);
      assert.equal(
        await client.skillInvocation.count({
          where: { ...scope, invocationId: "failed-load" },
        }),
        0,
      );
      // Repair the controlled fixture; failed writes left both aggregate revisions unchanged.
      await client.governedMemory.updateMany({
        where: scope,
        data: { payload: JSON.stringify(memory), digest: memory.digest },
      });
      await client.skillCatalog.updateMany({
        where: scope,
        data: { payload: JSON.stringify(catalog) },
      });
      assert.deepEqual(await memories.load("owner", "note"), memory);
      assert.deepEqual(await skills.load("builder"), catalog);
      await memories.save(nextMemory, { revision: 1, digest: memory.digest });
      await skills.save(nextCatalog, 1);
      assert.deepEqual(await memories.load("owner", "note"), nextMemory);
      assert.deepEqual(await skills.load("builder"), nextCatalog);
    });
  },
});

Deno.test({
  name:
    "PG-5 revising a candidate preserves its original bytes and expiry is computed without writing",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, scope);
      const store = new PostgresGovernedMemoryStore(client, scope);

      const memory = service(store);
      const first = await memory.capture(authority("capture-1"), {
        id: "revisable",
        content: content(),
      });
      const requested = await memory.review(
        authority("request-1", "reviewer"),
        {
          id: "revisable",
          expected: expected(first.memory),
          decision: "request-revision",
          reason: "Make the advice more precise.",
        },
      );
      const revised = await memory.revise(authority("revise-1"), {
        id: "revisable",
        expected: expected(requested.memory),
        content: content("Compare publication dates with the decision date."),
      });
      assert.equal(revised.memory.revision, 3);
      assert.equal(revised.memory.digest === first.memory.digest, false);
      assert.equal(
        revised.memory.history[0]!.content.text,
        first.memory.content.text,
      );
      const admitted = await memory.review(authority("admit-1", "reviewer"), {
        id: "revisable",
        expected: expected(revised.memory),
        decision: "admit",
        reason: "Revised evidence checked.",
      });
      const before = await store.load("operator-one", "revisable");
      const [expired] = await service(store, "2026-10-23T00:00:00.000Z").recall(
        authority("recall-expired"),
      );
      assert.equal(expired!.effectiveStatus, "expired");
      assert.equal(expired!.status, "admitted");
      assert.equal(expired!.usableAsGuidance, false);
      assert.equal(expired!.revision, admitted.memory.revision);
      assert.deepEqual(await store.load("operator-one", "revisable"), before);
    });
  },
});

Deno.test({
  name:
    "PG-5 SQL-looking owner and note identities stay scoped bound data and reads are isolated",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, scope);
      const store = new PostgresGovernedMemoryStore(client, scope);

      const owner = "owner'); DROP TABLE operator_memories; -- / ../";
      const id = "note'); DROP TABLE operator_memories; --";
      await service(store).capture(
        authority("capture-one", "contributor", owner),
        {
          id,
          content: content("SELECT * FROM operator_memories; -- ordinary text"),
        },
      );
      await service(store).capture(authority("capture-two"), {
        id,
        content: content(),
      });
      const first = (await store.load(owner, id))!;
      assert.equal(first.ownerId, owner);
      assert.equal((await store.list(owner)).length, 1);
      assert.equal((await store.list("operator-one")).length, 1);
      assert.equal(await store.load("absent-owner", id), null);
      first.history[0]!.content.origin.sourceRefs.push("reader mutation");
      const listed = await store.list(owner);
      listed[0]!.content.text = "reader mutation";
      assert.equal(
        (await store.load(owner, id))!.content.text.startsWith("SELECT"),
        true,
      );
      assert.deepEqual(
        (await store.load(owner, id))!.history[0]!.content.origin.sourceRefs,
        [
          "source-1",
        ],
      );
    });
  },
});

Deno.test({
  name:
    "PG-5 storage rejects oversized and malformed representations before persisting them",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, scope);
      const store = new PostgresGovernedMemoryStore(client, scope);

      await service(store).capture(authority("capture-1"), {
        id: "bounded",
        content: content(),
      });
      const original = (await store.load("operator-one", "bounded"))!;
      const oversized = structuredClone(original);
      oversized.content.text = "x".repeat(MAX_MEMORY_STORE_PAYLOAD_BYTES);
      await assert.rejects(() => store.save(oversized, null), /exceeds 4 MiB/);
      const invalid = structuredClone(original);
      invalid.history[0]!.revision = 9;
      await assert.rejects(() => store.save(invalid, null), /representation/);
      await assert.rejects(() => store.load("", "bounded"), /representation/);
      assert.deepEqual(await store.load("operator-one", "bounded"), original);
    });
  },
});

Deno.test({
  name:
    "PG-5 one native correlation cannot create two notes concurrently and remains reserved after restart",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      await seedPostgresRuntime(client, scope);
      let store = new PostgresGovernedMemoryStore(client, scope);

      let arrivals = 0;
      let release!: () => void;
      const bothReady = new Promise<void>((resolve) => {
        release = resolve;
      });
      const racing: MemoryStorePort = {
        load: (ownerId, id) => store.load(ownerId, id),
        list: (ownerId) => store.list(ownerId),
        save: async (record, version) => {
          arrivals++;
          if (arrivals === 2) release();
          await bothReady;
          await store.save(record, version);
        },
      };
      const auth = authority("one-native-invocation");
      const results = await Promise.allSettled([
        service(racing).capture(auth, { id: "note-a", content: content() }),
        service(racing).capture(auth, { id: "note-b", content: content() }),
      ]);
      assert.equal(arrivals, 2);
      assert.equal(
        results.filter((entry) => entry.status === "fulfilled").length,
        1,
      );
      const failure = results.find((entry) => entry.status === "rejected");
      assert.equal(failure?.status, "rejected");
      if (failure?.status === "rejected") {
        assert.equal(
          String(failure.reason).includes("another note or request"),
          true,
        );
      }
      const records = await store.list(auth.policy.ownerId);
      assert.equal(records.length, 1);
      const winner = records[0]!;
      assert.equal(winner.revision, 1);
      await store.close();
      await client.$disconnect();
      store = new PostgresGovernedMemoryStore(createClient(), scope);
      const replay = await service(store).capture(auth, {
        id: winner.id,
        content: content(),
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.memory.revision, 1);
      await assert.rejects(
        () =>
          service(store).capture(auth, {
            id: "third-note",
            content: content(),
          }),
        /another note|another candidate|different request|already/,
      );
      assert.equal((await store.list(auth.policy.ownerId)).length, 1);
      // Correlations belong to an owner and caller, not a global process namespace.
      await service(store).capture(
        authority("one-native-invocation", "contributor", "other-owner"),
        { id: "other-note", content: content() },
      );
      assert.equal((await store.list("other-owner")).length, 1);
    });
  },
});

Deno.test({
  name: "PG-5 skill activation metadata and altered content fail closed",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      await seedPostgresRuntime(client, scope);
      const store = new PostgresContextSkillsStore(client, scope);
      const installed = await initial();
      await store.save(installed, null);
      const inconsistent = next(installed, "load", "load-1");
      delete inconsistent.skills[0]!.loadedBy;
      await assert.rejects(() => store.save(inconsistent, 1), /Invalid stored/);
      assert.deepEqual(await store.load("builder"), installed);
      assert.equal(await client.skillInvocation.count({ where: scope }), 1);
      const corrupt = structuredClone(installed);
      corrupt.skills[0]!.content += "modified";
      await client.skillCatalog.updateMany({
        where: scope,
        data: { payload: JSON.stringify(corrupt) },
      });
      await client.$disconnect();
      await assert.rejects(
        () =>
          new PostgresContextSkillsStore(createClient(), scope).load("builder"),
        /Invalid stored/,
      );
    });
  },
});

Deno.test({
  name:
    "PG-5 in-flight skill evidence cancellation returns no payload and releases subsequent writes",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, schema }) => {
      await seedPostgresRuntime(client, scope);
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const controller = new AbortController();
      const observed = client.$extends({
        query: {
          skillCatalog: {
            async findFirst({ args, query }) {
              const result = await query(args);
              reached.resolve();
              await release.promise;
              return result;
            },
          },
        },
      }) as unknown as PrismaClient;
      registerPostgresClientSchema(observed, schema);
      const store = new PostgresContextSkillsStore(observed, scope);
      try {
        const installed = await initial();
        await store.save(installed, null);
        const reading = store.readNetworkImpactEvidence({
          ownerId: installed.ownerId,
          maxSnapshots: 1,
          maxPayloadBytes: 100_000,
          maxTotalBytes: 100_000,
          signal: controller.signal,
        });
        await reached.promise;
        const loaded = next(installed, "load", "load-after-cancel");
        const writing = store.save(loaded, installed.revision);
        controller.abort();
        release.resolve();
        const aborted = await reading;
        assert.equal(aborted.complete, false);
        assert.equal(aborted.snapshotsRead, 1);
        assert.equal(aborted.bytesRead, 0);
        assert.deepEqual(aborted.snapshots, []);
        assert.ok(aborted.issues.some((i) => i.code === "EVIDENCE_ABORTED"));
        await writing;
        const unloaded = next(loaded, "unload", "unload-after-cancel");
        await store.save(unloaded, loaded.revision);
        assert.deepEqual(await store.load(installed.ownerId), unloaded);
        assert.equal(await client.skillCatalog.count({ where: scope }), 1);
      } finally {
        release.resolve();
        await store.close();
      }
    });
  },
});

Deno.test({
  name:
    "PG-5 closing memory and skill stores drains captured writes before fresh-client reopen",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      await seedPostgresRuntime(client, scope);
      const memory = await initialMemory();
      const catalog = await initial();
      const expectedMemory = structuredClone(memory);
      const expectedCatalog = structuredClone(catalog);
      const memories = new PostgresGovernedMemoryStore(client, scope);
      const skills = new PostgresContextSkillsStore(client, scope);
      const savingMemory = memories.save(memory, null);
      const savingSkills = skills.save(catalog, null);
      memory.history[0]!.content.text = "caller mutation";
      catalog.skills[0]!.content = "caller mutation";
      await Promise.all([
        savingMemory,
        savingSkills,
        memories.close(),
        memories.close(),
        skills.close(),
        skills.close(),
      ]);
      await client.$disconnect();
      const fresh = createClient();
      assert.deepEqual(
        await new PostgresGovernedMemoryStore(fresh, scope).load(
          memory.ownerId,
          memory.id,
        ),
        expectedMemory,
      );
      assert.deepEqual(
        await new PostgresContextSkillsStore(fresh, scope).load(
          catalog.ownerId,
        ),
        expectedCatalog,
      );
    });
  },
});
