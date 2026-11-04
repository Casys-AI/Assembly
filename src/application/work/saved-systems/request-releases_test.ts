import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  RequestReleases,
  type ScopedReleaseService,
} from "./request-releases.ts";
import { requestReleaseFixture } from "../../../../test/support/request-release-fixture.ts";
import { RequestSpaceError } from "../../../domain/work/request-spaces/scope.ts";
import { type SpaceController } from "../../../domain/work/request-spaces/space-control.ts";
import {
  type SavedSystemCapture,
  savedSystemDigest,
  SavedSystemError,
  type SavedSystemRecord,
} from "../../../domain/work/records/saved-systems.ts";
import { savedSystemView } from "./release-view.ts";
import { spaceControlAuthority } from "../../../../test/support/request-space-fixture.ts";

async function fixture() {
  const f = await requestReleaseFixture();
  const capture: SavedSystemCapture = {
    origin: f.scope,
    source: f.source,
    registeredOperatorIds: ["operator"],
    operators: [{
      operatorId: "operator",
      repositoryVersion: f.source.sourceVersion,
      modelDigest: f.model.version.digest,
      settingsDigest: "settings",
      tools: [],
    }],
    admission: { operatorIds: ["operator"], prerequisites: [] },
    prerequisites: [],
  };
  const record: SavedSystemRecord = {
    id: "release-a",
    saveKey: "save-a",
    commandDigest: "d".repeat(64),
    metadata: { name: "A", purpose: "Exact source" },
    capture,
    createdAt: f.record.createdAt,
    status: "retained",
    manifest: f.manifest,
    digest: await savedSystemDigest(f.manifest),
    issues: [],
    revision: 1,
  };
  const controller: SpaceController = {
    ownerId: "owner",
    capabilityId: "cap",
    capabilityRevision: 0,
    sessionId: "session",
    authority: {
      ...spaceControlAuthority(),
      acts: [...spaceControlAuthority().acts, "retain-release"],
    },
  };
  const calls: unknown[] = [];
  let revoked = false, visible = true, missing = false;
  const service = (scope: typeof f.scope): ScopedReleaseService => ({
    createTag(command, actor) {
      calls.push({ kind: "create-tag", scope, command, actor });
      const oid = command.source.sourceVersion.slice(7);
      return Promise.resolve({
        source: { ...f.source, ...command.source },
        tag: { name: command.name, refOid: oid, commitOid: oid },
      });
    },
    listTags(source) {
      calls.push({ kind: "tags", scope, source });
      if (!visible) throw new SavedSystemError("FORBIDDEN", "source withdrawn");
      return Promise.resolve({ tags: [] });
    },
    save(command, actor) {
      calls.push({ kind: "save", scope, command, actor });
      return Promise.resolve(savedSystemView(record));
    },
    list() {
      calls.push({ kind: "list", scope });
      if (!visible) throw new SavedSystemError("FORBIDDEN", "source withdrawn");
      return Promise.resolve([savedSystemView(record)]);
    },
    inspect(id) {
      calls.push({ kind: "inspect", scope, id });
      if (!visible) throw new SavedSystemError("FORBIDDEN", "source withdrawn");
      return Promise.resolve(savedSystemView(record));
    },
    readTool() {
      return Promise.resolve({ sources: [] });
    },
  });
  const releases = new RequestReleases({
    scope: f.record.scope,
    control: {
      authenticateSession(secret) {
        equal(secret, "server-session");
        if (revoked) throw new RequestSpaceError("FORBIDDEN", "revoked");
        return Promise.resolve(controller);
      },
      revalidate(actor) {
        equal(actor, controller);
        if (revoked) throw new RequestSpaceError("FORBIDDEN", "revoked");
        return Promise.resolve();
      },
    },
    openings: {
      forCase: (id) =>
        Promise.resolve(id === f.record.caseId ? f.record : null),
    },
    catalogue: {
      listOwned(owner, caseId) {
        calls.push({ kind: "owned-list", owner, caseId });
        return Promise.resolve([{ scope: f.scope, record }]);
      },
      selected(owner, id) {
        calls.push({ kind: "selected", owner, id });
        return Promise.resolve(
          !missing && id === record.id ? { scope: f.scope, record } : null,
        );
      },
    },
    service,
  });
  return {
    ...f,
    record,
    controller,
    calls,
    releases,
    revoke() {
      revoked = true;
    },
    withdraw() {
      visible = false;
    },
    remove() {
      missing = true;
    },
  };
}

Deno.test("Request save forwards the exact command/current controller to retention in its actual scope, never Main", async () => {
  const f = await fixture();
  const command = {
    saveKey: "save-a",
    tag: { mode: "create" as const, name: "save-a" },
    name: "A",
    purpose: "Exact source",
    source: {
      branch: { kind: "case" as const, caseId: f.source.branch.caseId },
      sourceVersion: f.source.sourceVersion,
    },
  };
  await f.releases.save("server-session", command);
  deepStrictEqual(f.calls, [{
    kind: "save",
    scope: f.scope,
    command,
    actor: f.controller,
  }]);
  const before = f.calls.length;
  await rejects(() =>
    f.releases.save("server-session", {
      ...command,
      source: {
        ...command.source,
        branch: { kind: "case", caseId: "foreign" },
      },
    })
  );
  equal(f.calls.length, before);
});

Deno.test("tag reads authenticate and route the exact Request source without borrowing Main", async () => {
  const f = await fixture();
  const source = {
    branch: f.source.branch,
    sourceVersion: f.source.sourceVersion,
  };
  deepStrictEqual(await f.releases.listTags("server-session", source), {
    tags: [],
  });
  deepStrictEqual(f.calls, [{ kind: "tags", scope: f.scope, source }]);
  await rejects(() =>
    f.releases.listTags("server-session", {
      ...source,
      branch: { kind: "case", caseId: "foreign" },
    })
  );
  equal(f.calls.length, 1);
  f.revoke();
  await rejects(() => f.releases.listTags("server-session", source));
});

Deno.test("owned catalogue/selected lookup preserve true Request origin and closed source access", async () => {
  const f = await fixture();
  f.state.cases![0].status = "closed-done";
  const selected = await f.releases.list(
    "server-session",
    f.source.branch.caseId,
  );
  equal(selected[0].origin.executionSpaceId, f.scope.executionSpaceId);
  const all = await f.releases.list("server-session");
  equal(all[0].id, f.record.id);
  const read = await f.releases.inspectForOpening(f.record.id, f.controller);
  equal(read.origin.executionSpaceId, f.scope.executionSpaceId);
  equal(read.digest, f.record.digest);
  await rejects(() => f.releases.inspectForOpening(f.record.id));
  f.remove();
  await rejects(() => f.releases.inspectForOpening(f.record.id, f.controller));
});

Deno.test("withdrawn source visibility and revoked control refuse reads/reuse rather than inspecting Main", async () => {
  const f = await fixture();
  f.withdraw();
  deepStrictEqual(await f.releases.list("server-session"), []);
  await rejects(() => f.releases.inspectForOpening(f.record.id, f.controller));
  f.revoke();
  await rejects(() => f.releases.list("server-session"));
  await rejects(() => f.releases.inspectForOpening(f.record.id, f.controller));
});

Deno.test("standalone tag authenticates and resolves actual Main/owned Request scope without saving a Release", async () => {
  const f = await fixture();
  for (
    const source of [f.source, {
      branch: { kind: "main" as const },
      sourceVersion: f.source.sourceVersion,
    }]
  ) {
    const command = {
      source: { branch: source.branch, sourceVersion: source.sourceVersion },
      name: "standalone",
    };
    const result = await f.releases.createTag("server-session", command);
    equal(result.tag.name, command.name);
    const call = f.calls.at(-1);
    deepStrictEqual(call, {
      kind: "create-tag",
      scope: {
        ...f.scope,
        executionSpaceId: source.branch.kind === "main"
          ? "main"
          : f.scope.executionSpaceId,
      },
      command,
      actor: f.controller,
    });
  }
  equal(
    f.calls.some((call) =>
      typeof call === "object" && call !== null && "kind" in call &&
      call.kind === "save"
    ),
    false,
  );
  f.revoke();
  await rejects(() =>
    f.releases.createTag("server-session", {
      source: {
        branch: f.source.branch,
        sourceVersion: f.source.sourceVersion,
      },
      name: "another",
    })
  );
  equal(f.calls.length, 2);
});
