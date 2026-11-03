import { publicationEvent } from "../../../domain/work/release-publication.ts";
import {
  ReleaseCreationAuthority,
  type ReleaseCreationAuthorizationPort,
} from "./creation-authorization.ts";
import { spaceControlAuthority } from "../../../../test/support/request-space-fixture.ts";
import type { SpaceController } from "../../../domain/work/request-spaces.ts";
import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { SavedSystemsService } from "./service.ts";
import type {
  ModelTagMutationPort,
  ReleaseTagsPort,
  SavedSystemAssetsPort,
  SavedSystemStorePort,
} from "./ports.ts";
import {
  savedManifest,
  type SavedSystemCapture,
  savedSystemDigest,
  SavedSystemError,
  type SavedSystemManifest,
  type SavedSystemRecord,
} from "../../../domain/work/saved-systems.ts";
const scope = { projectId: "p", systemId: "s", executionSpaceId: "main" };
function fixture(
  creation?: ReleaseCreationAuthorizationPort,
  acceptedLookup = true,
  tagMutation?: ModelTagMutationPort,
  durableProgress = false,
) {
  const capture: SavedSystemCapture = {
    origin: scope,
    source: {
      branch: { kind: "main" },
      sourceVersion: `commit:${"a".repeat(40)}`,
      repositoryId: "repository",
      branchRef: "refs/heads/admitted",
      admittedHeadVersion: `commit:${"b".repeat(40)}`,
      sourceDigest: "a".repeat(64),
    },
    admission: { operatorIds: ["a", "b"], prerequisites: [] },
    registeredOperatorIds: ["a", "b"],
    operators: ["a", "b"].map((operatorId) => ({
      operatorId,
      modelDigest: `${operatorId}-model`,
      repositoryVersion: `commit:${"a".repeat(40)}`,
      settingsDigest: "settings",
      tools: [],
    })),
    prerequisites: [],
  };
  let record: SavedSystemRecord | null = null;
  let unavailable = false;
  let visible = true, stale = false, missing = false, crash = false;
  let retainCalls = 0, inspectCalls = 0, creates = 0;
  let tagPresent = true,
    tagMissing = false,
    tagForeign = false,
    annotated = false,
    prepareCalls = 0,
    ensureCalls = 0;
  const ensureModes: string[] = [];
  const clone = <T>(value: T): T => structuredClone(value);
  const store: SavedSystemStorePort = {
    begin(input) {
      if (record && record.commandDigest !== input.commandDigest) {
        throw new SavedSystemError("SAVE_KEY_CONFLICT", "Changed command");
      }
      if (!record) {
        const { authorization: _authorization, ...selected } = input;
        creates++;
        record = {
          id: "saved-1",
          ...selected,
          capture: clone(capture),
          createdAt: "now",
          status: "pending",
          manifest: null,
          digest: null,
          issues: [],
          revision: 0,
        };
      }
      return Promise.resolve(clone(record));
    },
    rejectTag(input) {
      if (record) {
        if (record.commandDigest !== input.commandDigest) {
          throw new SavedSystemError("SAVE_KEY_CONFLICT", "Different command");
        }
        return Promise.resolve(clone(record));
      }
      const {
        tag: selection,
        reason = "TAG_UNAVAILABLE",
        authorization: _authorization,
        ...selected
      } = input;
      creates++;
      record = {
        ...selected,
        id: "saved-1",
        createdAt: "now",
        status: "conflict",
        manifest: null,
        digest: null,
        rejection: { code: reason, tag: clone(selection) },
        issues: [reason],
        revision: 0,
      };
      return Promise.resolve(clone(record));
    },
    async confirmTag(input) {
      if (record!.revision !== input.expectedRevision) return clone(record!);
      await input.ensure();
      record = {
        ...record!,
        tag: { ...record!.tag!, verified: true },
        revision: record!.revision + 1,
      };
      return clone(record);
    },
    availableTags: (_scope, _repository, names) =>
      Promise.resolve(
        record?.tag
          ? names.filter((name) => name !== record!.tag!.binding.name)
          : names,
      ),
    finalize(input) {
      if (crash) {
        crash = false;
        throw new Error("Crash after retention with /private/path");
      }
      if (record!.revision !== input.expectedRevision) {
        return Promise.resolve(clone(record!));
      }
      record = {
        ...record!,
        manifest: stale ? null : input.manifest,
        digest: stale ? null : input.digest,
        status: stale ? "conflict" : input.status,
        issues: stale ? ["CAPTURE_CHANGED"] : input.issues,
        revision: record!.revision + 1,
      };
      return Promise.resolve(clone(record));
    },
    markIncomplete(input) {
      record = {
        ...record!,
        status: "incomplete",
        issues: input.issues,
        revision: record!.revision + 1,
      };
      return Promise.resolve(clone(record));
    },
    list: () => Promise.resolve(record ? [clone(record)] : []),
    get: () => Promise.resolve(record ? clone(record) : null),
  };
  if (durableProgress) {
    store.progress = (input) => {
      if (
        record!.revision !== input.expectedRevision ||
        !input.start && record!.publication?.runId !== input.runId
      ) return Promise.resolve(clone(record!));
      record = {
        ...record!,
        revision: record!.revision + 1,
        publication: publicationEvent(
          record!.publication,
          input.event,
          input.outcome,
          new Date().toISOString(),
          input.runId,
        ),
      };
      return Promise.resolve(clone(record));
    };
    const finalize = store.finalize;
    store.finalize = async (input) => {
      if (record!.publication?.runId !== input.preparationId) {
        return clone(record!);
      }
      const final = await finalize(input);
      record!.publication = publicationEvent(
        record!.publication,
        {
          step: "manifest-finalization",
          status: final.status === "retained" ? "completed" : "incomplete",
        },
        final.status === "retained" ? "completed" : "incomplete",
        new Date().toISOString(),
      );
      return clone(record!);
    };
    const incomplete = store.markIncomplete;
    store.markIncomplete = async (input) => {
      if (
        record!.publication?.runId !== input.preparationId ||
        record!.revision !== input.expectedRevision
      ) return clone(record!);
      await incomplete(input);
      const technical = input.failure === "technical";
      record!.publication = publicationEvent(
        record!.publication,
        {
          step: input.failure === "tag"
            ? "tag-verification"
            : technical
            ? "manifest-finalization"
            : "asset-retention",
          status: technical ? "failed" : "incomplete",
          issue: technical
            ? "PUBLICATION_FAILED"
            : input.failure === "tag"
            ? "TAG_UNAVAILABLE"
            : "EXACT_ASSET_UNAVAILABLE",
        },
        technical ? "failed" : "incomplete",
        new Date().toISOString(),
      );
      return clone(record!);
    };
  }
  if (acceptedLookup) {
    store.find = (_scope, saveKey) =>
      Promise.resolve(record?.saveKey === saveKey ? clone(record) : null);
  }
  const assets: SavedSystemAssetsPort = {
    retain(operator) {
      retainCalls++;
      if (missing) throw new Error("Missing /private/path");
      return Promise.resolve({
        ...operator,
        sourceDigest: "a".repeat(64),
        build: null,
        tools: [],
      });
    },
    readTool() {
      throw new Error("No selected tool in this fixture");
    },
    inspect() {
      inspectCalls++;
      if (missing) throw new Error("corrupt private path");
      return Promise.resolve();
    },
  };
  const service = new SavedSystemsService(
    store,
    assets,
    {
      canRead: () => Promise.resolve(visible),
    },
    scope,
    {
      resolveSource(selection) {
        if (
          unavailable || selection.branch.kind !== "main" ||
          selection.sourceVersion !== capture.source!.sourceVersion
        ) {
          throw new SavedSystemError(
            "UNAVAILABLE",
            "Selected source unavailable or not admitted",
          );
        }
        return Promise.resolve(clone(capture));
      },
    },
    creation,
    {
      prepare(selection, source) {
        prepareCalls++;
        if (
          selection.mode === "create"
            ? tagPresent
            : !tagPresent || tagMissing || tagForeign
        ) {
          throw new SavedSystemError(
            "TAG_UNAVAILABLE",
            "Tag occupied or unavailable",
          );
        }
        const commitOid = source.sourceVersion.slice(7);
        return Promise.resolve({
          name: selection.name,
          refOid: annotated ? "b".repeat(40) : commitOid,
          commitOid,
        });
      },
      list(source) {
        const commitOid = source.sourceVersion.slice(7);
        return Promise.resolve([{ name: "v1", refOid: commitOid, commitOid }]);
      },
      inspect: () =>
        Promise.resolve(
          tagPresent && !tagMissing && !tagForeign ? "verified" : "unavailable",
        ),
      runExclusive: (operation) => operation(),
      ensure(selection) {
        ensureCalls++;
        ensureModes.push(selection.mode);
        if (tagMissing || tagForeign) {
          throw new SavedSystemError("TAG_UNAVAILABLE", "Tag changed");
        }
        tagPresent = true;
        return Promise.resolve();
      },
    } satisfies ReleaseTagsPort,
    tagMutation,
  );
  return {
    service,
    store,
    capture,
    assets,
    setUnavailable(value: boolean) {
      unavailable = value;
    },
    setVisible(value: boolean) {
      visible = value;
    },
    setMissing(value: boolean) {
      missing = value;
    },
    stale() {
      stale = true;
    },
    crash() {
      crash = true;
    },
    async legacy() {
      if (!record) throw new Error("No accepted record");
      delete record.tag;
      const { tag: _tag, ...original } = command;
      record.commandDigest = await savedSystemDigest({
        scope,
        saveKey: original.saveKey,
        metadata: { name: original.name, purpose: original.purpose },
        source: original.source,
      });
    },
    tagUnavailable() {
      tagMissing = true;
    },
    occupyTag() {
      tagPresent = true;
      tagForeign = true;
    },
    removeTag() {
      tagPresent = false;
    },
    restoreTag() {
      tagPresent = true;
      tagForeign = false;
      tagMissing = false;
    },
    annotateTag() {
      annotated = true;
    },
    async acceptedCreate(
      legacyCommand: Omit<typeof command, "tag"> & {
        tag: { mode: "create"; name: string };
      },
    ) {
      const oid = capture.source!.sourceVersion.slice(7);
      await store.begin({
        scope,
        saveKey: legacyCommand.saveKey,
        commandDigest: await savedSystemDigest({
          scope,
          saveKey: legacyCommand.saveKey,
          metadata: {
            name: legacyCommand.name,
            purpose: legacyCommand.purpose,
          },
          source: legacyCommand.source,
          tag: legacyCommand.tag,
        }),
        metadata: { name: legacyCommand.name, purpose: legacyCommand.purpose },
        capture,
        tag: {
          selection: legacyCommand.tag,
          binding: {
            name: legacyCommand.tag.name,
            refOid: oid,
            commitOid: oid,
          },
          verified: false,
        },
      });
    },
    stats: () => ({
      retainCalls,
      inspectCalls,
      creates,
      prepareCalls,
      ensureCalls,
      ensureModes: [...ensureModes],
    }),
  };
}
const command = {
  saveKey: "same-key",
  name: "Exact S",
  purpose: "Inspect later",
  source: {
    branch: { kind: "main" as const },
    sourceVersion: `commit:${"a".repeat(40)}`,
  },
  tag: { mode: "existing" as const, name: "v1" },
};
Deno.test("Release retains one displayed source and recovers one exact intention", async () => {
  const f = fixture();
  const first = await f.service.save(command);
  equal(first.status, "retained");
  equal("stateRevision" in first.selectedOperators[0], false);
  equal("runtime" in first.selectedOperators[0], false);
  deepStrictEqual(
    first.manifest!.operators.map((entry) => entry.repositoryVersion),
    [`commit:${"a".repeat(40)}`, `commit:${"a".repeat(40)}`],
  );
  equal((await f.service.save(command)).id, first.id);
  equal(f.stats().creates, 1);
  equal(f.stats().retainCalls, 2);
  await rejects(
    () => f.service.save({ ...command, name: "Changed" }),
    /different command/,
  );
  equal((await f.service.inspect(first.id)).digest, first.digest);
  equal(f.stats().inspectCalls, 3);
});

Deno.test("fresh Releases require a tag while legacy retained and incomplete commands preserve their original digests", async () => {
  const { tag: _tag, ...legacyCommand } = command;
  const fresh = fixture();
  await rejects(() => fresh.service.save(legacyCommand), /Select a tag/);
  equal(fresh.stats().creates, 0);
  const retained = fixture();
  const first = await retained.service.save(command);
  await retained.legacy();
  const replay = await retained.service.save(legacyCommand);
  equal(replay.digest, first.digest);
  equal(replay.tag, undefined);
  await rejects(() => retained.service.save(command), /different command/);
  const incomplete = fixture();
  incomplete.crash();
  await incomplete.service.save(command);
  await incomplete.legacy();
  equal((await incomplete.service.save(legacyCommand)).status, "retained");
});

Deno.test("interrupted native tag acknowledgment recovers the same frozen binding without preparing again", async () => {
  const f = fixture();
  const confirm = f.store.confirmTag!;
  let interrupted = true;
  f.store.confirmTag = async (input) => {
    if (interrupted) {
      interrupted = false;
      await input.ensure();
      throw new Error("Acknowledgment uncertain");
    }
    return await confirm(input);
  };
  const pending = await f.service.save(command);
  equal(pending.status, "incomplete");
  equal(pending.tag!.verified, false);
  const complete = await f.service.save(command);
  equal(complete.id, pending.id);
  equal(complete.tag!.verified, true);
  equal(f.stats().prepareCalls, 1);
  equal(f.stats().ensureCalls, 2);
  await rejects(
    () => f.service.save({ ...command, tag: { mode: "create", name: "v1" } }),
    /different command/,
  );
  await rejects(
    () => f.service.save({ ...command, tag: { mode: "create", name: "v2" } }),
    /different command/,
  );
});

Deno.test("external tag drift changes availability without changing retained manifest or recapturing source", async () => {
  const f = fixture();
  const retained = await f.service.save(command);
  f.tagUnavailable();
  f.setUnavailable(true);
  const replay = await f.service.save(command);
  equal(replay.tagAvailability, "unavailable");
  equal(replay.assetAvailability, "verified");
  equal(replay.digest, retained.digest);
  deepStrictEqual(replay.manifest, retained.manifest);
  equal(f.stats().ensureCalls, 1);
});

Deno.test("confirmed incomplete publication never recreates its externally deleted create-mode tag", async () => {
  const f = fixture();
  const legacyCommand = {
    ...command,
    tag: { mode: "create" as const, name: "v1" },
  };
  await f.acceptedCreate(legacyCommand);
  f.setMissing(true);
  const incomplete = await f.service.save(legacyCommand);
  equal(incomplete.status, "incomplete");
  equal(incomplete.tag!.verified, true);
  f.setMissing(false);
  f.tagUnavailable();
  const refused = await f.service.save(legacyCommand);
  equal(refused.status, "incomplete");
  equal(refused.tagAvailability, "unavailable");
  equal(refused.tag!.selection.mode, "create");
  deepStrictEqual(f.stats().ensureModes, ["create", "existing"]);
  equal(f.stats().retainCalls, 1);
});

Deno.test("unaccepted tag failure receives an exact terminal acknowledgement without reserving a tag", async () => {
  const f = fixture();
  f.occupyTag();
  const rejected = await f.service.save(command);
  equal(rejected.status, "conflict");
  equal(rejected.tag, undefined);
  equal(rejected.tagAvailability, undefined);
  equal(rejected.manifest, null);
  equal(rejected.digest, null);
  deepStrictEqual(rejected.rejection, {
    code: "TAG_UNAVAILABLE",
    tag: command.tag,
  });
  deepStrictEqual(rejected.source!.branch, command.source.branch);
  const frozen = await f.store.find!(scope, command.saveKey);
  equal(
    frozen!.commandDigest,
    await savedSystemDigest({
      scope,
      saveKey: command.saveKey,
      metadata: { name: command.name, purpose: command.purpose },
      source: command.source,
      tag: command.tag,
    }),
  );
  equal((await f.service.save(command)).id, rejected.id);
  equal(f.stats().prepareCalls, 1);
  equal(f.stats().ensureCalls, 0);
  await rejects(
    () =>
      f.service.save({
        ...command,
        tag: { mode: "create", name: "different" },
      }),
    /different command/,
  );
});

Deno.test("tag reservation refusal before accepted native work receives a terminal acknowledgement", async () => {
  const f = fixture();
  f.store.begin = () => {
    throw new SavedSystemError(
      "TAG_UNAVAILABLE",
      "A different scope owns the tag",
    );
  };
  const rejected = await f.service.save(command);
  equal(rejected.status, "conflict");
  deepStrictEqual(rejected.rejection?.tag, command.tag);
  equal(f.stats().ensureCalls, 0);
});

Deno.test("terminal rejection fences a late same-command acceptance before native work", async () => {
  const f = fixture();
  const begin = f.store.begin;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.store.begin = async (input) => {
    entered.resolve();
    await release.promise;
    return await begin(input);
  };
  const late = f.service.save(command);
  await entered.promise;
  f.occupyTag();
  const rejected = await f.service.save(command);
  release.resolve();
  const lateResult = await late;
  equal(lateResult.id, rejected.id);
  equal(lateResult.status, "conflict");
  deepStrictEqual(lateResult.rejection, rejected.rejection);
  equal(f.stats().creates, 1);
  equal(f.stats().ensureCalls, 0);
});

Deno.test("rejection preserves a concurrently accepted same-command winner for exact recovery", async () => {
  const f = fixture();
  const reject = f.store.rejectTag!;
  f.store.rejectTag = async (input) => {
    const oid = input.capture.source!.sourceVersion.slice(7);
    await f.store.begin({
      ...input,
      tag: {
        selection: input.tag,
        binding: { name: input.tag.name, refOid: oid, commitOid: oid },
        verified: false,
      },
    });
    return await reject(input);
  };
  f.occupyTag();
  const winner = await f.service.save(command);
  equal(winner.status, "pending");
  equal(winner.rejection, undefined);
  equal(winner.tag!.verified, false);
  equal(f.stats().ensureCalls, 0);
  // Recovery still needs the exact native ref; a different target is not repaired.
  f.restoreTag();
  equal((await f.service.save(command)).status, "retained");
  equal(f.stats().prepareCalls, 1);
  equal(f.stats().creates, 1);
});

Deno.test("tag selection reads only eligible exact source and omits claimed names", async () => {
  const f = fixture();
  equal((await f.service.listTags(command.source)).tags[0].name, "v1");
  await f.service.save(command);
  deepStrictEqual(await f.service.listTags(command.source), { tags: [] });
  f.setUnavailable(true);
  await rejects(() => f.service.listTags(command.source));
});

Deno.test("authority withdrawn after intention acceptance refuses native tag work", async () => {
  let allowed = true;
  const creation: ReleaseCreationAuthorizationPort = {
    authorize: (intent, controller) => Promise.resolve({ intent, controller }),
    revalidate() {
      if (!allowed) {
        throw new SavedSystemError("FORBIDDEN", "retention revoked");
      }
      return Promise.resolve();
    },
  };
  const f = fixture(creation);
  const begin = f.store.begin;
  f.store.begin = async (input) => {
    const row = await begin(input);
    allowed = false;
    return row;
  };
  await rejects(
    () => f.service.save(command, { ownerId: "owner" } as SpaceController),
    /revoked/,
  );
  equal(f.stats().creates, 1);
  equal(f.stats().ensureCalls, 0);
  equal((await f.service.list())[0].status, "pending");
});
Deno.test("retention failure and crash leave recoverable incomplete intention without private diagnostics", async () => {
  const f = fixture();
  f.setMissing(true);
  const failed = await f.service.save(command);
  equal(failed.status, "incomplete");
  equal(JSON.stringify(failed).includes("private/path"), false);
  f.setMissing(false);
  f.crash();
  const interrupted = await f.service.save(command);
  equal(interrupted.id, failed.id);
  equal(interrupted.status, "incomplete");
  const recovered = await f.service.save(command);
  equal(recovered.id, failed.id);
  equal(recovered.status, "retained");
  equal(f.stats().creates, 1);
  f.setMissing(true);
  equal(
    (await f.service.inspect(recovered.id)).assetAvailability,
    "unavailable",
  );
});
Deno.test("durable finalization refuses changed selected capture; missing dependencies never appear retained", async () => {
  const f = fixture();
  f.stale();
  equal((await f.service.save(command)).status, "conflict");
  const dependent = fixture();
  dependent.capture.prerequisites.push({
    kind: "skill",
    operatorId: "a",
    code: "SKILL_DEPENDENCY",
  });
  equal((await dependent.service.save(command)).status, "incomplete");
});
Deno.test("current source visibility is checked before and after asynchronous retention and inspection", async () => {
  const f = fixture();
  const original = f.assets.retain;
  f.assets.retain = async (selection) => {
    const result = await original(selection);
    f.setVisible(false);
    return result;
  };
  await rejects(
    () => f.service.save(command),
    (error: unknown) =>
      error instanceof SavedSystemError && error.code === "FORBIDDEN",
  );
  await rejects(
    () => f.service.list(),
    /unavailable in the current source scope/,
  );
  await rejects(
    () => f.service.inspect("saved-1"),
    /unavailable in the current source scope/,
  );
});

Deno.test("unavailable Case scopes and unadmitted or stale sources create no intention", async () => {
  const f = fixture();
  for (
    const source of [
      {
        branch: { kind: "case" as const, caseId: "case-a" },
        sourceVersion: command.source.sourceVersion,
      },
      {
        branch: { kind: "main" as const },
        sourceVersion: `commit:${"c".repeat(40)}`,
      },
    ]
  ) {
    await rejects(
      () => f.service.save({ ...command, source }),
      /unavailable or not admitted/,
    );
  }
  f.setUnavailable(true);
  await rejects(() => f.service.save(command), /unavailable or not admitted/);
  equal(f.stats().creates, 0);
  equal(f.stats().retainCalls, 0);
});
Deno.test("changing the selected source with the same key refuses instead of selecting main", async () => {
  const f = fixture();
  await f.service.save(command);
  const next = `commit:${"c".repeat(40)}`;
  f.capture.source!.sourceVersion = next;
  for (const operator of f.capture.operators) operator.repositoryVersion = next;
  await rejects(
    () =>
      f.service.save({
        ...command,
        source: { ...command.source, sourceVersion: next },
      }),
    /different command/,
  );
  equal(f.stats().creates, 1);
});
Deno.test("catalogue availability is unchecked without asset reads; exact retry reveals corruption", async () => {
  const f = fixture();
  const saved = await f.service.save(command);
  f.setMissing(true);
  const count = f.stats().inspectCalls;
  const listed = await f.service.list();
  equal(listed[0].status, "retained");
  equal(listed[0].assetAvailability, "unchecked");
  equal(f.stats().inspectCalls, count);
  const retry = await f.service.save(command);
  equal(retry.id, saved.id);
  equal(retry.digest, saved.digest);
  equal(retry.status, "retained");
  equal(retry.assetAvailability, "unavailable");
  equal(f.stats().inspectCalls, count + 1);
});

Deno.test("Release finalization CAS loss inspects the actual repaired winner before claiming availability", async () => {
  for (const winnerAvailable of [false, true]) {
    const f = fixture();
    f.capture.prerequisites.push({
      kind: "missing-asset",
      operatorId: "a",
      code: "SOURCE_TOOL_UNAVAILABLE",
    });
    let winner: SavedSystemManifest | undefined;
    f.store.finalize = async (input) => {
      const held = (await f.store.get(scope, input.id))!;
      const repaired = { ...held.capture, prerequisites: [] };
      winner = savedManifest({
        ...repaired,
        operators: input.manifest.operators.map((operator) => ({
          ...operator,
          sourceDigest: "concurrent-repaired-source",
        })),
      });
      return {
        ...held,
        capture: repaired,
        manifest: winner,
        digest: await savedSystemDigest(winner),
        revision: held.revision + 2,
        status: "retained",
        issues: [],
      };
    };
    let inspected = 0;
    f.assets.inspect = (manifest) => {
      inspected++;
      deepStrictEqual(manifest, winner);
      if (!winnerAvailable) throw new Error("Concurrent winner assets missing");
      return Promise.resolve();
    };
    const result = await f.service.save(command);
    equal(inspected, 1);
    equal(
      result.manifest!.operators[0].sourceDigest,
      "concurrent-repaired-source",
    );
    equal(
      result.assetAvailability,
      winnerAvailable ? "verified" : "unavailable",
    );
  }
});
Deno.test("Release incomplete CAS loss inspects a concurrent retained winner instead of labelling it unavailable", async () => {
  const f = fixture();
  let winner: SavedSystemManifest | undefined;
  f.assets.retain = () =>
    Promise.reject(new Error("This attempt lost its asset read"));
  f.store.markIncomplete = async (input) => {
    const held = (await f.store.get(scope, input.id))!;
    winner = savedManifest({
      ...held.capture,
      operators: held.capture.operators.map((
        { tools: _tools, ...operator },
      ) => ({
        ...operator,
        sourceDigest: "concurrent-retained-source",
        build: null,
        tools: [],
      })),
    });
    return {
      ...held,
      manifest: winner,
      digest: await savedSystemDigest(winner),
      revision: held.revision + 1,
      status: "retained",
      issues: [],
    };
  };
  let inspected = 0;
  f.assets.inspect = (manifest) => {
    inspected++;
    deepStrictEqual(manifest, winner);
    return Promise.resolve();
  };
  const result = await f.service.save(command);
  equal(inspected, 1);
  equal(result.status, "retained");
  equal(result.assetAvailability, "verified");
  equal(
    result.manifest!.operators[0].sourceDigest,
    "concurrent-retained-source",
  );
});

Deno.test("production creation seam requires a controller while retained replay is read-only", async () => {
  let allowed = true, authorized = 0;
  const controller = { ownerId: "owner" } as SpaceController;
  const creation: ReleaseCreationAuthorizationPort = {
    authorize(intent, actor) {
      authorized++;
      if (!allowed) {
        throw new SavedSystemError("FORBIDDEN", "retain-release removed");
      }
      equal(actor, controller);
      equal(intent.scope.executionSpaceId, "main");
      return Promise.resolve(structuredClone({ intent, controller: actor }));
    },
    revalidate() {
      if (!allowed) {
        throw new SavedSystemError("FORBIDDEN", "retain-release removed");
      }
      return Promise.resolve();
    },
  };
  const f = fixture(creation, true);
  await rejects(() => f.service.save(command), /controller/);
  equal(f.stats().creates, 0);
  const retained = await f.service.save(command, controller);
  equal(retained.status, "retained");
  const before = f.stats();
  allowed = false;
  f.setUnavailable(true);
  const replay = await f.service.save(command, controller);
  equal(replay.id, retained.id);
  equal(authorized, 1);
  equal(f.stats().creates, before.creates);
  equal(f.stats().retainCalls, before.retainCalls);
  f.setUnavailable(false);
  await rejects(
    () => f.service.save({ ...command, saveKey: "new-intent" }, controller),
    /removed/,
  );
});
Deno.test("revocation during external retention leaves a truthful pending intent without finalization", async () => {
  let allowed = true;
  const creation: ReleaseCreationAuthorizationPort = {
    authorize: (intent, controller) =>
      Promise.resolve(structuredClone({ intent, controller })),
    revalidate() {
      if (!allowed) {
        throw new SavedSystemError("FORBIDDEN", "retain-release revoked");
      }
      return Promise.resolve();
    },
  };
  const f = fixture(creation, true);
  const retain = f.assets.retain;
  f.assets.retain = async (selected) => {
    const result = await retain(selected);
    allowed = false;
    return result;
  };
  await rejects(
    () => f.service.save(command, { ownerId: "owner" } as SpaceController),
    /revoked/,
  );
  const accepted = await f.store.find!(scope, command.saveKey);
  equal(accepted!.status, "pending");
  equal(accepted!.manifest, null);
  equal(f.stats().retainCalls, 1);
});

Deno.test("stale admitted source before first acceptance receives a truthful terminal acknowledgement for the original command", async () => {
  const f = fixture();
  f.store.begin = () => {
    throw new SavedSystemError(
      "SOURCE_STALE",
      "The admitted source advanced before acceptance",
    );
  };
  const rejected = await f.service.save(command);
  equal(rejected.status, "conflict");
  equal(rejected.tag, undefined);
  equal(rejected.manifest, null);
  equal(rejected.digest, null);
  deepStrictEqual(rejected.rejection, {
    code: "SOURCE_STALE",
    tag: command.tag,
  });
  equal(rejected.source!.sourceVersion, command.source.sourceVersion);
  equal((await f.service.save(command)).id, rejected.id);
  equal(f.stats().creates, 1);
  equal(f.stats().prepareCalls, 1);
  equal(f.stats().ensureCalls, 0);
  await rejects(
    () => f.service.save({ ...command, name: "Changed original title" }),
    /different command/,
  );
});

Deno.test("revoked permission or an unavailable source never becomes a terminal stale-source acknowledgement", async () => {
  for (const code of ["FORBIDDEN", "UNAVAILABLE"] as const) {
    const f = fixture();
    f.store.begin = () => {
      throw new SavedSystemError(
        code,
        "Current permission or evidence unavailable",
      );
    };
    await rejects(
      () => f.service.save(command),
      (error: unknown) =>
        error instanceof SavedSystemError && error.code === code,
    );
    equal(await f.store.find!(scope, command.saveKey), null);
    equal(f.stats().creates, 0);
    equal(f.stats().ensureCalls, 0);
  }
});

Deno.test("a concurrent accepted winner survives a stale-source terminal acknowledgement unchanged", async () => {
  const f = fixture();
  const reject = f.store.rejectTag!;
  const begin = f.store.begin;
  f.store.begin = () => {
    throw new SavedSystemError("SOURCE_STALE", "Head advanced");
  };
  f.store.rejectTag = async (input) => {
    const { reason: _reason, tag: selection, ...selected } = input;
    const oid = input.capture.source!.sourceVersion.slice(7);
    await begin({
      ...selected,
      tag: {
        selection,
        binding: { name: selection.name, refOid: oid, commitOid: oid },
        verified: false,
      },
    });
    return await reject(input);
  };
  const winner = await f.service.save(command);
  equal(winner.status, "pending");
  equal(winner.rejection, undefined);
  equal(winner.tag!.verified, false);
  equal(f.stats().creates, 1);
  equal(f.stats().ensureCalls, 0);
});

Deno.test("an atomic stale-source result from begin stops before tag confirmation or asset retention", async () => {
  const f = fixture();
  const terminal = f.store.rejectTag!;
  f.store.begin = (input) =>
    terminal({
      ...input,
      tag: input.tag!.selection,
      reason: "SOURCE_STALE",
    });
  f.store.rejectTag = () => {
    throw new Error("A second terminal transaction must not be needed");
  };
  const rejected = await f.service.save(command);
  equal(rejected.status, "conflict");
  deepStrictEqual(rejected.rejection, {
    code: "SOURCE_STALE",
    tag: command.tag,
  });
  equal(f.stats().creates, 1);
  equal(f.stats().ensureCalls, 0);
  equal(f.stats().retainCalls, 0);
  equal((await f.service.save(command)).id, rejected.id);
  equal(f.stats().prepareCalls, 1);
});

function tagController(): SpaceController {
  return {
    ownerId: "owner",
    capabilityId: "cap",
    capabilityRevision: 1,
    sessionId: "session",
    authority: { ...spaceControlAuthority(), acts: ["retain-release"] },
  };
}
Deno.test("standalone tag creates no Release and retries exact native evidence after lost acknowledgement", async () => {
  const controller = tagController();
  const authority = new ReleaseCreationAuthority({
    revalidate: () => Promise.resolve(),
  });
  let lostReply = true, fences = 0;
  const f = fixture(authority, true, {
    async run(authorization, operation) {
      equal(authorization.controller.ownerId, controller.ownerId);
      equal(
        authorization.intent.source.sourceVersion,
        command.source.sourceVersion,
      );
      fences++;
      await operation(new AbortController().signal);
      if (lostReply) {
        lostReply = false;
        throw new Error("Acknowledgement lost");
      }
    },
  });
  f.removeTag();
  const selected = { source: command.source, name: "v1" };
  await rejects(
    () => f.service.createTag(selected, controller),
    /Acknowledgement lost/,
  );
  equal((await f.service.list()).length, 0);
  const created = await f.service.createTag(selected, controller);
  equal(created.tag.name, "v1");
  equal(created.tag.refOid, command.source.sourceVersion.slice(7));
  equal(created.tag.commitOid, created.tag.refOid);
  deepStrictEqual(created.source, f.capture.source);
  equal(fences, 2);
  equal(f.stats().creates, 0);
  equal(f.stats().retainCalls, 0);
  equal(f.stats().ensureCalls, 2);
  equal((await f.service.save(command, controller)).status, "retained");
});
Deno.test("standalone tag refuses same-commit annotation, wrong target, stale source and revoked authority before native work", async () => {
  const controller = tagController();
  let allowed = true;
  const authority = new ReleaseCreationAuthority({
    revalidate: () => {
      if (!allowed) throw new SavedSystemError("FORBIDDEN", "Control revoked");
      return Promise.resolve();
    },
  });
  const mutation: ModelTagMutationPort = {
    run: (_authorization, operation) => operation(new AbortController().signal),
  };
  for (
    const change of [
      "annotation",
      "target",
      "source",
      "authority",
      "fence",
    ] as const
  ) {
    allowed = true;
    const f = fixture(
      authority,
      true,
      change === "fence"
        ? {
          run: () => {
            throw new SavedSystemError("FORBIDDEN", "Fence revoked");
          },
        }
        : mutation,
    );
    if (change === "annotation") f.annotateTag();
    if (change === "target") f.occupyTag();
    if (change === "source") f.setUnavailable(true);
    if (change === "authority") allowed = false;
    await rejects(() =>
      f.service.createTag({ source: command.source, name: "v1" }, controller)
    );
    equal(f.stats().ensureCalls, 0);
    equal(f.stats().creates, 0);
    equal(f.stats().retainCalls, 0);
  }
});
Deno.test("fresh create-tag Release receives terminal rejection while an accepted old create command still recovers", async () => {
  const legacyCommand = {
    ...command,
    tag: { mode: "create" as const, name: "v1" },
  };
  const fresh = fixture();
  const rejected = await fresh.service.save(legacyCommand);
  equal(rejected.status, "conflict");
  deepStrictEqual(rejected.rejection, {
    code: "TAG_UNAVAILABLE",
    tag: legacyCommand.tag,
  });
  equal(fresh.stats().prepareCalls, 0);
  equal(fresh.stats().ensureCalls, 0);
  equal((await fresh.service.save(legacyCommand)).id, rejected.id);
  const accepted = fixture();
  await accepted.acceptedCreate(legacyCommand);
  equal((await accepted.service.save(legacyCommand)).status, "retained");
  equal(accepted.stats().prepareCalls, 0);
  deepStrictEqual(accepted.stats().ensureModes, ["create"]);
});

Deno.test("durable publication progress survives failed finalization and same-key recovery without exposing run ownership", async () => {
  const f = fixture(undefined, true, undefined, true);
  f.crash();
  const failed = await f.service.save(command);
  equal(failed.publication?.outcome, "failed");
  equal(failed.publication?.events.at(-1)?.issue, "PUBLICATION_FAILED");
  equal("runId" in failed.publication!, false);
  equal(JSON.stringify(failed).includes("private/path"), false);
  const readsBefore = f.stats().retainCalls;
  equal((await f.service.list())[0].publication?.outcome, "failed");
  equal((await f.service.inspect(failed.id)).publication?.outcome, "failed");
  equal(f.stats().retainCalls, readsBefore);
  const recovered = await f.service.save(command);
  equal(recovered.id, failed.id);
  equal(recovered.publication?.outcome, "completed");
  equal(recovered.publication?.attempt, 2);
  equal(recovered.source!.sourceVersion, failed.source!.sourceVersion);
  equal(recovered.tag!.binding.refOid, failed.tag!.binding.refOid);
  equal(f.stats().creates, 1);
  const history = recovered.publication!.events;
  equal(history.some((event) => event.status === "failed"), true);
  equal(
    history.filter((event) =>
      event.step === "asset-retention" && event.status === "completed"
    ).length,
    4,
  );
  const completedRetry = await f.service.save(command);
  deepStrictEqual(completedRetry.publication, recovered.publication);
});
Deno.test("missing exact assets record recoverable incomplete observations and never completed publication", async () => {
  const f = fixture(undefined, true, undefined, true);
  f.setMissing(true);
  const incomplete = await f.service.save(command);
  equal(incomplete.publication?.outcome, "incomplete");
  equal(
    incomplete.publication?.events.at(-1)?.issue,
    "EXACT_ASSET_UNAVAILABLE",
  );
  equal(incomplete.manifest, null);
  equal(incomplete.assetAvailability, "unavailable");
  f.setMissing(false);
  equal((await f.service.save(command)).publication?.outcome, "completed");
});
Deno.test("a resumed run fences a previously retaining run before its completion can be recorded", async () => {
  const f = fixture(undefined, true, undefined, true);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = f.assets.retain;
  let first = true;
  f.assets.retain = async (operator) => {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return await original(operator);
  };
  const stale = f.service.save(command);
  await entered.promise;
  const resumed = await f.service.save(command);
  equal(resumed.publication?.outcome, "completed");
  release.resolve();
  const late = await stale;
  equal(late.digest, resumed.digest);
  deepStrictEqual(late.publication, resumed.publication);
  equal(f.stats().creates, 1);
});
