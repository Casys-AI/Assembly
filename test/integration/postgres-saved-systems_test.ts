import { SavedSystemsService } from "../../src/application/work/saved-systems/service.ts";
import type {
  ReleaseTagsPort,
  SavedSystemAssetsPort,
} from "../../src/application/work/saved-systems/ports.ts";
import assert from "node:assert/strict";
import {
  decodeSavedSystemRow,
  PostgresSavedSystemStore,
  type SavedSystemRow,
} from "../../src/adapters/out/postgres/saved-system-store.ts";
import type { SavedSystemTag } from "../../src/domain/work/release-tags.ts";
import {
  postgresQualifiedTable,
  Prisma,
} from "../../src/adapters/out/postgres/client.ts";
import {
  savedManifest,
  type SavedSystemCapture,
  savedSystemDigest,
  SavedSystemError,
} from "../../src/domain/work/saved-systems.ts";
import {
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { spaceControlAuthority } from "../support/request-space-fixture.ts";

const scope = {
  projectId: "saved-project",
  systemId: "saved-system",
  executionSpaceId: "main",
};
function capture(): SavedSystemCapture {
  const sourceVersion = `commit:${"a".repeat(40)}`;
  return {
    origin: scope,
    source: {
      branch: { kind: "main" },
      sourceVersion,
      repositoryId: "repository",
      branchRef: "refs/heads/admitted",
      admittedHeadVersion: sourceVersion,
      sourceDigest: "source",
    },
    registeredOperatorIds: ["source-member"],
    operators: [{
      operatorId: "source-member",
      modelDigest: "model",
      repositoryVersion: sourceVersion,
      settingsDigest: "settings",
      tools: [],
    }],
    admission: { operatorIds: ["source-member"], prerequisites: [] },
    prerequisites: [],
  };
}
function manifest(selected: SavedSystemCapture) {
  return savedManifest({
    ...selected,
    operators: selected.operators.map(({ tools, ...operator }) => ({
      ...operator,
      sourceDigest: "source",
      build: null,
      tools: tools.map(({ draft: _draft, ...tool }) => tool),
    })),
  });
}
const input = () => ({
  scope,
  saveKey: "save-1",
  commandDigest: "command",
  metadata: { name: "Example", purpose: "" },
  capture: capture(),
});

Deno.test({
  name:
    "Release intention persists exact source, converges on retry and preserves timestamp/scope",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, {
        ...scope,
        operatorId: "runtime-only",
      });
      const store = new PostgresSavedSystemStore(client);
      const command = input();
      const [first, retry] = await Promise.all([
        store.begin(command),
        store.begin(command),
      ]);
      assert.equal(first.id, retry.id);
      assert.deepEqual(first.capture, command.capture);
      assert.deepEqual(first.capture.registeredOperatorIds, ["source-member"]);
      const table = postgresQualifiedTable(client, "SavedSystem");
      const [timestamp] = await client.$queryRaw<Array<{ epoch: number }>>(
        Prisma.sql`
        SELECT extract(epoch from "createdAt")::double precision AS epoch FROM ${table} WHERE id = ${first.id}`,
      );
      assert.equal(
        Date.parse(first.createdAt),
        Math.round(timestamp.epoch * 1000),
      );
      assert.equal(
        (await store.get(scope, first.id))!.createdAt,
        first.createdAt,
      );
      assert.equal((await store.list(scope))[0].createdAt, first.createdAt);
      await assert.rejects(
        () =>
          store.begin({ ...command, commandDigest: "changed-source-command" }),
        /save key/i,
      );
      assert.equal(
        await store.get({ ...scope, executionSpaceId: "other" }, first.id),
        null,
      );
      assert.equal((await store.list(scope)).length, 1);
    });
  },
});
Deno.test({
  name:
    "runtime registrations do not change the source capture or conflict with Release finalization",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, { ...scope, operatorId: "runtime-a" });
      const store = new PostgresSavedSystemStore(client);
      const first = await store.begin(input());
      await seedPostgresRuntime(client, { ...scope, operatorId: "runtime-b" });
      const selected = manifest(first.capture);
      const final = await store.finalize({
        id: first.id,
        scope,
        expectedRevision: first.revision,
        capture: first.capture,
        manifest: selected,
        digest: await savedSystemDigest(selected),
        status: "retained",
        issues: [],
      });
      assert.equal(final.status, "retained");
      assert.deepEqual(
        final.manifest!.operators.map((operator) => operator.repositoryVersion),
        [capture().source!.sourceVersion],
      );
      assert.deepEqual(final.manifest!.registeredOperatorIds, [
        "source-member",
      ]);
      assert.equal(await client.operatorRuntime.count({ where: scope }), 2);
      const stale = await store.markIncomplete({
        id: first.id,
        scope,
        expectedRevision: first.revision,
        issues: ["STALE"],
      });
      assert.equal(stale.status, "retained");
      assert.equal(stale.digest, final.digest);
    });
  },
});
Deno.test({
  name:
    "Release CAS refuses changed selected source and supports incomplete retry without replacing capture",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, { ...scope, operatorId: "runtime" });
      const store = new PostgresSavedSystemStore(client);
      const command = input();
      const first = await store.begin(command);
      const incomplete = await store.markIncomplete({
        id: first.id,
        scope,
        expectedRevision: first.revision,
        issues: ["EXACT_ASSET_UNAVAILABLE"],
      });
      const retry = await store.begin(command);
      assert.equal(retry.id, first.id);
      assert.equal(retry.revision, incomplete.revision);
      assert.deepEqual(retry.capture, first.capture);
      const changed = structuredClone(retry.capture);
      changed.source!.sourceVersion = `commit:${"b".repeat(40)}`;
      changed.operators[0].repositoryVersion = changed.source!.sourceVersion;
      const selected = manifest(changed);
      const refused = await store.finalize({
        id: first.id,
        scope,
        expectedRevision: retry.revision,
        capture: changed,
        manifest: selected,
        digest: await savedSystemDigest(selected),
        status: "retained",
        issues: [],
      });
      assert.equal(refused.status, "conflict");
      assert.equal(refused.manifest, null);
      assert.deepEqual(refused.issues, ["CAPTURE_CHANGED"]);
      await assert.rejects(() =>
        store.begin({
          ...input(),
          saveKey: "foreign",
          capture: { ...capture(), origin: { ...scope, systemId: "foreign" } },
        }), /selection changed/i);
    });
  },
});

Deno.test({
  name:
    "Release retry repairs missing source closure under CAS without moving accepted source evidence",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, { ...scope, operatorId: "runtime" });
      const store = new PostgresSavedSystemStore(client);
      const command = input();
      command.capture.prerequisites.push({
        kind: "missing-asset",
        operatorId: "source-member",
        code: "SOURCE_TOOL_UNAVAILABLE",
      });
      const first = await store.begin(command);
      const incomplete = await store.markIncomplete({
        id: first.id,
        scope,
        expectedRevision: first.revision,
        issues: ["PREREQUISITES_REQUIRED"],
      });
      assert.equal(
        incomplete.publication?.events.at(-1)?.issue,
        "PREREQUISITES_REQUIRED",
      );
      assert.equal(
        incomplete.publication?.events.at(-1)?.step,
        "preparation",
        "an omitted stage cannot fabricate an asset-retention failure",
      );
      const repaired = input();
      repaired.capture.source!.admittedHeadVersion = `commit:${"b".repeat(40)}`;
      const retried = await store.begin(repaired);
      assert.equal(retried.id, first.id);
      assert.equal(retried.revision, incomplete.revision + 1);
      assert.deepEqual(retried.capture.source, first.capture.source);
      assert.deepEqual(retried.capture.prerequisites, []);
      const oldManifest = manifest(first.capture);
      const stale = await store.finalize({
        id: first.id,
        scope,
        expectedRevision: incomplete.revision,
        capture: first.capture,
        manifest: oldManifest,
        digest: await savedSystemDigest(oldManifest),
        status: "incomplete",
        issues: [],
      });
      assert.equal(stale.status, "pending");
      assert.equal(stale.manifest, null);
      const exact = manifest(retried.capture);
      const final = await store.finalize({
        id: first.id,
        scope,
        expectedRevision: retried.revision,
        capture: retried.capture,
        manifest: exact,
        digest: await savedSystemDigest(exact),
        status: "retained",
        issues: [],
      });
      assert.equal(final.status, "retained");
      assert.equal(
        final.manifest!.source!.sourceVersion,
        first.capture.source!.sourceVersion,
      );
    });
  },
});

function publicationTag(name = "release/v1"): SavedSystemTag {
  return {
    selection: { mode: "create", name },
    binding: { name, refOid: "a".repeat(40), commitOid: "a".repeat(40) },
    verified: false,
  };
}
const tagUnavailable = (error: unknown) =>
  error instanceof SavedSystemError && error.code === "TAG_UNAVAILABLE";

Deno.test({
  name:
    "Release tag reservation is unique across concurrent execution spaces and survives incomplete work",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      const other = { ...scope, executionSpaceId: "request-other" };
      await seedPostgresRuntime(client, { ...scope, operatorId: "runtime" });
      await seedPostgresRuntime(client, { ...other, operatorId: "runtime" });
      const stores = [
        new PostgresSavedSystemStore(client),
        new PostgresSavedSystemStore(createClient()),
      ];
      const commands = [scope, other].map((origin, index) => ({
        ...input(),
        scope: origin,
        saveKey: `tag-save-${index}`,
        capture: { ...capture(), origin },
        tag: publicationTag(),
      }));
      const results = await Promise.allSettled(
        commands.map((command, index) => stores[index].begin(command)),
      );
      const winners = results.flatMap((result, index) =>
        result.status === "fulfilled" ? [{ record: result.value, index }] : []
      );
      assert.equal(winners.length, 1);
      const loser = results.find((result) => result.status === "rejected");
      assert.ok(loser && loser.status === "rejected");
      assert.ok(tagUnavailable(loser.reason));
      assert.equal(loser.reason.message.includes(winners[0].record.id), false);
      const { record, index } = winners[0];
      const command = commands[index];
      await stores[index].markIncomplete({
        scope: command.scope,
        id: record.id,
        expectedRevision: record.revision,
        issues: ["TAG_UNAVAILABLE"],
      });
      for (const origin of [scope, other]) {
        assert.deepEqual(
          await stores[0].availableTags(origin, "repository", [
            "release/v1",
            "release/v2",
          ]),
          ["release/v2"],
        );
      }
      assert.equal((await stores[index].begin(command)).id, record.id);
      await assert.rejects(() =>
        stores[index].begin({
          ...command,
          tag: publicationTag("release/v2"),
        }), tagUnavailable);
      assert.deepEqual(
        await stores[0].availableTags(scope, "another-repository", [
          "release/v1",
        ]),
        ["release/v1"],
      );
      const table = postgresQualifiedTable(client, "SavedSystem");
      await assert.rejects(() =>
        client.$executeRaw(
          Prisma
            .sql`UPDATE ${table} SET "tagName"='release/rebound' WHERE "id"=${record.id}`,
        ), /immutable/i);
    });
  },
});

Deno.test({
  name:
    "Release tag confirmation survives interrupted Git work and restart, fences stale CAS and precedes finalization",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      await seedPostgresRuntime(client, { ...scope, operatorId: "runtime" });
      const store = new PostgresSavedSystemStore(client);
      const command = { ...input(), tag: publicationTag() };
      const first = await store.begin(command);
      const selected = manifest(first.capture);
      const finalInput = {
        scope,
        id: first.id,
        expectedRevision: first.revision,
        capture: first.capture,
        manifest: selected,
        digest: await savedSystemDigest(selected),
        status: "retained" as const,
        issues: [],
      };
      await assert.rejects(() => store.finalize(finalInput), tagUnavailable);
      let gitCreated = false;
      await assert.rejects(() =>
        store.confirmTag({
          scope,
          id: first.id,
          expectedRevision: first.revision,
          ensure() {
            gitCreated = true;
            return Promise.reject(new Error("acknowledgement interrupted"));
          },
        }), /interrupted/);
      assert.equal(gitCreated, true);
      assert.equal((await store.get(scope, first.id))!.tag!.verified, false);
      const incomplete = await store.markIncomplete({
        scope,
        id: first.id,
        expectedRevision: first.revision,
        issues: ["TAG_UNAVAILABLE"],
      });
      const restarted = new PostgresSavedSystemStore(createClient());
      const retry = await restarted.begin(command);
      assert.equal(retry.id, first.id);
      assert.equal(retry.revision, incomplete.revision);
      assert.deepEqual(retry.tag, first.tag);
      const confirmed = await restarted.confirmTag({
        scope,
        id: retry.id,
        expectedRevision: retry.revision,
        ensure() {
          assert.equal(gitCreated, true);
          return Promise.resolve();
        },
      });
      assert.equal(confirmed.tag!.verified, true);
      assert.equal(confirmed.revision, retry.revision + 1);
      let staleRuns = 0;
      const stale = await store.confirmTag({
        scope,
        id: first.id,
        expectedRevision: first.revision,
        ensure() {
          staleRuns++;
          return Promise.resolve();
        },
      });
      assert.equal(staleRuns, 0);
      assert.equal(stale.revision, confirmed.revision);
      await assert.rejects(() =>
        store.confirmTag({
          scope,
          id: first.id,
          expectedRevision: confirmed.revision,
          ensure() {
            return Promise.reject(new Error("external tag drift"));
          },
        }), /external tag drift/);
      const retained = await restarted.finalize({
        ...finalInput,
        expectedRevision: confirmed.revision,
      });
      assert.equal(retained.status, "retained");
      assert.equal(retained.tag!.verified, true);
      assert.deepEqual(retained.manifest, selected);
      assert.equal(retained.digest, finalInput.digest);
      const table = postgresQualifiedTable(client, "SavedSystem");
      await assert.rejects(() =>
        client.$executeRaw(
          Prisma
            .sql`UPDATE ${table} SET "tagVerified"=false WHERE "id"=${first.id}`,
        ), /immutable/i);
    });
  },
});

Deno.test({
  name:
    "Release tag confirmation refuses current authority before calling native mutation",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, { ...scope, operatorId: "runtime" });
      const command = { ...input(), tag: publicationTag() };
      command.capture.source!.sourceDigest = "c".repeat(64);
      command.commandDigest = await savedSystemDigest({
        scope,
        saveKey: command.saveKey,
        metadata: command.metadata,
        source: {
          branch: command.capture.source!.branch,
          sourceVersion: command.capture.source!.sourceVersion,
        },
        tag: command.tag.selection,
      });
      const row = await new PostgresSavedSystemStore(client).begin(command);
      let nativeCalls = 0;
      let authorityCalls = 0;
      const guarded = new PostgresSavedSystemStore(client, {
        assertNativeLocked() {
          return Promise.reject(new SavedSystemError("FORBIDDEN", "Revoked"));
        },
        assertLocked() {
          authorityCalls++;
          return Promise.reject(new SavedSystemError("FORBIDDEN", "Revoked"));
        },
      });
      await assert.rejects(
        () =>
          guarded.confirmTag({
            scope,
            id: row.id,
            expectedRevision: row.revision,
            authorization: {
              intent: {
                scope,
                saveKey: row.saveKey,
                commandDigest: row.commandDigest,
                source: row.capture.source!,
              },
              controller: {
                ownerId: "owner",
                capabilityId: "capability",
                capabilityRevision: 0,
                sessionId: "session",
                authority: spaceControlAuthority(),
              },
            },
            ensure() {
              nativeCalls++;
              return Promise.resolve();
            },
          }),
        (error: unknown) =>
          error instanceof SavedSystemError && error.code === "FORBIDDEN",
      );
      assert.equal(authorityCalls, 1);
      assert.equal(nativeCalls, 0);
      assert.equal((await guarded.get(scope, row.id))!.tag!.verified, false);
    });
  },
});

Deno.test({
  name:
    "Release tag migration leaves historical command, capture, manifest and digest bytes unchanged",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, migrateToLatest }) => {
      await seedPostgresRuntime(client, { ...scope, operatorId: "runtime" });
      const command = input();
      const selected = manifest(command.capture);
      const digest = await savedSystemDigest(selected);
      const table = postgresQualifiedTable(client, "SavedSystem");
      const id = crypto.randomUUID();
      const [before] = await client.$queryRaw<SavedSystemRow[]>(
        Prisma
          .sql`INSERT INTO ${table} ("id", "projectId", "systemId", "executionSpaceId", "saveKey", "commandDigest", "metadata", "capture", "status", "issues", "manifest", "digest") VALUES (${id}, ${scope.projectId}, ${scope.systemId}, ${scope.executionSpaceId}, ${command.saveKey}, ${command.commandDigest}, ${
          JSON.stringify(command.metadata)
        }, ${JSON.stringify(command.capture)}, 'retained', '[]', ${
          JSON.stringify(selected)
        }, ${digest}) RETURNING *`,
      );
      const legacyDecoded = decodeSavedSystemRow(before);
      assert.equal("tag" in legacyDecoded, false);
      await migrateToLatest();
      const [after] = await client.$queryRaw<SavedSystemRow[]>(
        Prisma.sql`SELECT * FROM ${table} WHERE "id"=${id}`,
      );
      for (
        const key of ["commandDigest", "capture", "manifest", "digest"] as const
      ) {
        assert.equal(after[key], before[key]);
      }
      const store = new PostgresSavedSystemStore(client);
      const recovered = await store.begin(command);
      assert.equal(recovered.id, id);
      assert.equal("tag" in recovered, false);
      assert.deepEqual(recovered.capture, legacyDecoded.capture);
      assert.deepEqual(recovered.manifest, legacyDecoded.manifest);
      assert.equal(recovered.digest, legacyDecoded.digest);
      assert.deepEqual(
        await store.availableTags(scope, "repository", ["release/v1"]),
        ["release/v1"],
      );
    }, { throughMigration: "20261030020000_request_runtime_adoption" });
  },
});

Deno.test({
  name:
    "Release tag confirmation counts elapsed SQL guards before starting bounded native work",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, { ...scope, operatorId: "runtime" });
      const row = await new PostgresSavedSystemStore(client).begin({
        ...input(),
        tag: publicationTag(),
      });
      let reads = 0;
      const elapsed = new PostgresSavedSystemStore(
        client,
        undefined,
        () => reads++ === 0 ? 0 : 10_001,
      );
      let nativeCalls = 0;
      await assert.rejects(() =>
        elapsed.confirmTag({
          scope,
          id: row.id,
          expectedRevision: row.revision,
          ensure() {
            nativeCalls++;
            return Promise.resolve();
          },
        }), tagUnavailable);
      assert.equal(nativeCalls, 0);
      assert.equal((await elapsed.get(scope, row.id))!.tag!.verified, false);
      const store = new PostgresSavedSystemStore(client);
      let childSettled = false;
      await assert.rejects(() =>
        store.confirmTag({
          scope,
          id: row.id,
          expectedRevision: row.revision,
          ensure(signal) {
            assert.ok(signal);
            assert.equal(signal.aborted, false);
            return new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => {
                // Model the native adapter's kill/reap completion. The SQL
                // callback must await this settlement before rolling back.
                queueMicrotask(() => {
                  childSettled = true;
                  resolve();
                });
              }, { once: true });
            });
          },
        }), tagUnavailable);
      assert.equal(childSettled, true);
      assert.equal((await store.get(scope, row.id))!.tag!.verified, false);
      assert.equal((await store.get(scope, row.id))!.revision, row.revision);
    });
  },
});

async function taggedCommand(saveKey: string, name: string, origin = scope) {
  const command = {
    ...input(),
    scope: origin,
    saveKey,
    capture: { ...capture(), origin },
    tag: publicationTag(name),
  };
  command.commandDigest = await savedSystemDigest({
    scope: command.scope,
    saveKey: command.saveKey,
    metadata: command.metadata,
    source: {
      branch: command.capture.source!.branch,
      sourceVersion: command.capture.source!.sourceVersion,
    },
    tag: command.tag.selection,
  });
  return command;
}

Deno.test({
  name:
    "Release terminal tag rejection and reservation converge under both concurrent launch orders",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      await seedPostgresRuntime(client, { ...scope, operatorId: "runtime" });
      const store = new PostgresSavedSystemStore(client);
      const peer = new PostgresSavedSystemStore(createClient());
      for (const rejectFirst of [true, false]) {
        const command = await taggedCommand(
          `race-${rejectFirst}`,
          `race/${rejectFirst}`,
        );
        const reject = () =>
          peer.rejectTag({ ...command, tag: command.tag.selection });
        const begin = () => store.begin(command);
        const [first, second] = await Promise.all(
          rejectFirst ? [reject(), begin()] : [begin(), reject()],
        );
        assert.equal(first.id, second.id);
        assert.equal(first.status, second.status);
        assert.deepEqual(first.tag, second.tag);
        assert.deepEqual(first.rejection, second.rejection);
        assert.equal((await reject()).id, first.id);
        assert.equal((await begin()).id, first.id);
        assert.equal(
          (await store.list(scope)).filter((row) =>
            row.saveKey === command.saveKey
          ).length,
          1,
        );
      }
      const rejectedCommand = await taggedCommand(
        "rejected-first",
        "release/rejected",
      );
      const rejected = await peer.rejectTag({
        ...rejectedCommand,
        tag: rejectedCommand.tag.selection,
      });
      assert.equal(rejected.status, "conflict");
      assert.deepEqual(rejected.rejection, {
        code: "TAG_UNAVAILABLE",
        tag: rejectedCommand.tag.selection,
      });
      assert.equal(rejected.tag, undefined);
      assert.equal(rejected.manifest, null);
      assert.equal(rejected.digest, null);
      assert.deepEqual(await store.begin(rejectedCommand), rejected);
      assert.deepEqual(
        await peer.rejectTag({
          ...rejectedCommand,
          tag: rejectedCommand.tag.selection,
        }),
        rejected,
      );
      assert.deepEqual(
        await store.availableTags(scope, "repository", ["release/rejected"]),
        ["release/rejected"],
      );
      const acceptedCommand = await taggedCommand(
        "accepted-first",
        "release/accepted",
      );
      const accepted = await store.begin(acceptedCommand);
      assert.deepEqual(
        await peer.rejectTag({
          ...acceptedCommand,
          tag: acceptedCommand.tag.selection,
        }),
        accepted,
      );
      assert.equal(accepted.rejection, undefined);
      assert.equal(accepted.status, "pending");
      const changed = await taggedCommand("rejected-first", "release/changed");
      await assert.rejects(
        () => peer.rejectTag({ ...changed, tag: changed.tag.selection }),
        /save key/i,
      );
      await assert.rejects(() => store.begin(changed), /save key/i);
      const table = postgresQualifiedTable(client, "SavedSystem");
      await assert.rejects(() =>
        client.$executeRaw(
          Prisma
            .sql`UPDATE ${table} SET "tagRejection"=NULL WHERE "id"=${rejected.id}`,
        ), /immutable/i);
      await assert.rejects(() =>
        client.$executeRaw(
          Prisma
            .sql`UPDATE ${table} SET "metadata"='{}' WHERE "id"=${rejected.id}`,
        ), /immutable/i);
      const [raw] = await client.$queryRaw<SavedSystemRow[]>(
        Prisma.sql`SELECT * FROM ${table} WHERE "id"=${rejected.id}`,
      );
      assert.throws(
        () => decodeSavedSystemRow({ ...raw, status: "pending" }),
        /selection changed/i,
      );
    });
  },
});

Deno.test({
  name:
    "Release tag conflict records only the requesting scope without disclosing foreign reservation",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      const other = { ...scope, executionSpaceId: "foreign-request" };
      await seedPostgresRuntime(client, { ...scope, operatorId: "runtime" });
      await seedPostgresRuntime(client, { ...other, operatorId: "runtime" });
      const store = new PostgresSavedSystemStore(client);
      const accepted = await store.begin(
        await taggedCommand("foreign-accepted", "release/occupied", other),
      );
      const command = await taggedCommand("own-rejected", "release/occupied");
      await assert.rejects(() => store.begin(command), tagUnavailable);
      const rejected = await store.rejectTag({
        ...command,
        tag: command.tag.selection,
      });
      assert.notEqual(rejected.id, accepted.id);
      assert.equal(rejected.status, "conflict");
      assert.equal(rejected.tag, undefined);
      assert.deepEqual(rejected.capture.origin, scope);
      assert.equal(JSON.stringify(rejected).includes(accepted.id), false);
      assert.equal(
        JSON.stringify(rejected).includes(other.executionSpaceId),
        false,
      );
      assert.equal(await store.get(scope, accepted.id), null);
      assert.equal(await store.get(other, rejected.id), null);
      assert.equal((await store.list(scope)).length, 1);
      assert.equal((await store.list(other)).length, 1);
      assert.deepEqual(
        await store.availableTags(scope, "repository", ["release/occupied"]),
        [],
      );
    });
  },
});

Deno.test({
  name:
    "Release publication history survives adapter restart and exact same-key recovery fences the superseded run",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, { ...scope, operatorId: "runtime" });
      let store = new PostgresSavedSystemStore(client);
      const accepted = await store.begin(input());
      assert.equal(accepted.publication?.outcome, "pending");
      assert.equal(accepted.publication?.events[0].step, "acceptance");
      const started = await store.progress({
        scope,
        id: accepted.id,
        expectedRevision: accepted.revision,
        runId: "first",
        start: true,
        event: { step: "recovery", status: "started" },
        outcome: "preparing",
      });
      const failed = await store.markIncomplete({
        scope,
        id: accepted.id,
        expectedRevision: started.revision,
        preparationId: "first",
        failure: "technical",
        issues: ["PUBLICATION_FAILED"],
      });
      assert.equal(failed.publication?.outcome, "failed");
      assert.equal(
        failed.publication?.events.at(-1)?.issue,
        "PUBLICATION_FAILED",
      );
      store = new PostgresSavedSystemStore(client);
      assert.deepEqual(
        (await store.get(scope, accepted.id))?.publication,
        failed.publication,
      );
      assert.equal((await store.list(scope))[0].publication?.outcome, "failed");
      const same = await store.begin(input());
      assert.equal(same.id, accepted.id);
      const resumed = await store.progress({
        scope,
        id: accepted.id,
        expectedRevision: same.revision,
        runId: "second",
        start: true,
        event: { step: "recovery", status: "started" },
        outcome: "preparing",
      });
      assert.equal(resumed.publication?.attempt, 2);
      const exact = manifest(accepted.capture);
      const finalize = {
        scope,
        id: accepted.id,
        expectedRevision: resumed.revision,
        capture: accepted.capture,
        manifest: exact,
        digest: await savedSystemDigest(exact),
        status: "retained" as const,
        issues: [],
      };
      // Even a caller holding the newest revision cannot finalize an older run.
      const stale = await store.finalize({
        ...finalize,
        preparationId: "first",
      });
      assert.equal(stale.publication?.outcome, "preparing");
      assert.equal(stale.manifest, null);
      const completed = await store.finalize({
        ...finalize,
        preparationId: "second",
      });
      assert.equal(completed.publication?.outcome, "completed");
      assert.equal(
        completed.publication?.events.at(-1)?.step,
        "manifest-finalization",
      );
      assert.deepEqual(completed.capture.source, accepted.capture.source);
      const lateFailure = await store.markIncomplete({
        scope,
        id: accepted.id,
        expectedRevision: completed.revision,
        preparationId: "first",
        failure: "technical",
        issues: ["PUBLICATION_FAILED"],
      });
      assert.deepEqual(lateFailure.publication, completed.publication);
      assert.equal(
        await store.get({ ...scope, executionSpaceId: "sibling" }, accepted.id),
        null,
      );
    });
  },
});

Deno.test({
  name:
    "Release service persists visible preparation, technical failure and exact recovery through real PostgreSQL",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      await seedPostgresRuntime(client, { ...scope, operatorId: "runtime" });
      const selected = capture();
      const entered = Promise.withResolvers<void>();
      const finishRetention = Promise.withResolvers<void>();
      let holdRetention = true, failFinalization = true, assetsMissing = false;
      let retains = 0, resolutions = 0, tagPreparations = 0;
      const assets: SavedSystemAssetsPort = {
        async retain(operator) {
          retains++;
          if (holdRetention) {
            entered.resolve();
            await finishRetention.promise;
          }
          return manifest({ ...selected, operators: [operator] }).operators[0];
        },
        readTool() {
          throw new Error("No tool in this bounded SQL witness");
        },
        inspect() {
          if (assetsMissing) {
            throw new Error("Missing retained /private/release/source");
          }
          return Promise.resolve();
        },
      };
      const tags: ReleaseTagsPort = {
        prepare(selection) {
          tagPreparations++;
          return Promise.resolve({
            name: selection.name,
            refOid: "a".repeat(40),
            commitOid: "a".repeat(40),
          });
        },
        list: () => Promise.resolve([]),
        inspect: () => Promise.resolve("verified"),
        runExclusive: (work) => work(),
        ensure: () => Promise.resolve(),
      };
      const registry = {
        resolveSource() {
          resolutions++;
          return Promise.resolve(structuredClone(selected));
        },
      };
      const store = new PostgresSavedSystemStore(client);
      const finalize = store.finalize.bind(store);
      store.finalize = (input) => {
        if (failFinalization) {
          failFinalization = false;
          throw new Error("SQL transport lost /private/release/finalization");
        }
        return finalize(input);
      };
      const service = (selectedStore: PostgresSavedSystemStore) =>
        new SavedSystemsService(
          selectedStore,
          assets,
          { canRead: () => Promise.resolve(true) },
          scope,
          registry,
          undefined,
          tags,
        );
      const command = {
        saveKey: "durable-service",
        name: "Durable Release",
        purpose: "SQL checkpoint witness",
        source: {
          branch: { kind: "main" as const },
          sourceVersion: selected.source!.sourceVersion,
        },
        tag: { mode: "existing" as const, name: "durable/service" },
      };
      const original = service(store);
      const pending = original.save(command);
      await entered.promise;
      const peerStore = new PostgresSavedSystemStore(createClient());
      const restarted = service(peerStore);
      const visible = (await restarted.list())[0];
      assert.equal(visible.status, "pending");
      assert.equal(visible.publication?.outcome, "preparing");
      assert.equal(visible.publication?.events.at(-1)?.step, "asset-retention");
      assert.equal(visible.publication?.events.at(-1)?.status, "started");
      assert.equal("runId" in visible.publication!, false);
      assert.equal(retains, 1, "catalogue reads never resume a preparation");
      const observed = await restarted.inspect(visible.id);
      assert.equal(observed.manifest, null);
      assert.equal(retains, 1, "selected reads never resume a preparation");
      holdRetention = false;
      finishRetention.resolve();
      const failed = await pending;
      assert.equal(failed.id, visible.id);
      assert.equal(failed.status, "incomplete");
      assert.equal(failed.publication?.outcome, "failed");
      assert.equal(
        failed.publication?.events.at(-1)?.issue,
        "PUBLICATION_FAILED",
      );
      assert.equal(JSON.stringify(failed).includes("/private/"), false);
      assert.deepEqual(
        (await restarted.inspect(failed.id)).publication,
        failed.publication,
      );
      const completed = await restarted.save(command);
      assert.equal(completed.id, failed.id);
      assert.equal(completed.status, "retained");
      assert.equal(completed.publication?.outcome, "completed");
      assert.equal(completed.publication?.attempt, 2);
      assert.equal(completed.assetAvailability, "verified");
      assert.deepEqual(completed.source, failed.source);
      assert.deepEqual(completed.tag, failed.tag);
      assert.equal(resolutions, 1, "recovery uses the accepted source capture");
      assert.equal(
        tagPreparations,
        1,
        "recovery preserves the accepted raw tag binding",
      );
      assert.equal(retains, 2);
      const history = completed.publication!.events;
      assert(history.some((event) => event.status === "failed"));
      assert(
        history.every((event, index) =>
          index === 0 || event.sequence === history[index - 1].sequence + 1
        ),
      );
      assert(history.every((event) => Number.isFinite(Date.parse(event.at))));
      const completedAgain = await restarted.save(command);
      assert.deepEqual(completedAgain.publication, completed.publication);
      assert.equal(
        retains,
        2,
        "a completed same-key retry cannot reprepare assets",
      );
      assetsMissing = true;
      const unavailable = await restarted.inspect(completed.id);
      assert.equal(unavailable.assetAvailability, "unavailable");
      assert.deepEqual(
        unavailable.publication,
        completed.publication,
        "current availability does not rewrite publication history",
      );
      assert.equal(JSON.stringify(unavailable).includes("/private/"), false);
      const stored = await peerStore.get(scope, completed.id);
      assert.equal(stored?.publication?.outcome, "completed");
      assert.equal((await peerStore.list(scope)).length, 1);
    });
  },
});
