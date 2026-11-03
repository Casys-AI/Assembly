import { deepStrictEqual, equal, match, rejects } from "node:assert/strict";
import { mainOpenerAuthority, RequestSpaceOpenings } from "./opening.ts";
import type { OpeningStorePort, RequestSpaceHostOptions } from "./ports.ts";
import {
  type MainOpener,
  mainOpeningKey,
  OPENING_PHASES,
  type OpeningCommand,
  type OpeningRecord,
  requestSpaceDigest,
  RequestSpaceError,
  type SpaceExecutionAdmission,
} from "../../../domain/work/request-spaces.ts";
import {
  requestControlState,
  requestOpeningBase,
  requestSpaceScope,
  spaceControlAuthority,
  spaceUuid,
} from "../../../../test/support/request-space-fixture.ts";
const clone = <T>(value: T): T => structuredClone(value);
async function fixture() {
  const records = new Map<string, OpeningRecord>();
  let ids = 0,
    resolutions = 0,
    provisioningFails = false,
    preparationFails = false,
    revoked = false,
    authenticated = true,
    sessions = 0,
    hostControllers = 0,
    mayOpen = true,
    openerAdmitted = true;
  let current = await requestOpeningBase("a");
  const release = await requestOpeningBase("b", true);
  const preparationOrder: string[] = [];
  const seenBases: string[] = [],
    deliveries = new Set<string>(),
    refs = new Map<string, string>();
  const store: OpeningStorePort = {
    begin(input) {
      const key = `${input.ownerId}:${input.command.openingKey}`;
      const old = records.get(key);
      if (old) {
        if (old.commandDigest !== input.commandDigest) {
          throw new RequestSpaceError("OPENING_CONFLICT", "Different command");
        }
        return Promise.resolve(clone(old));
      }
      const record: OpeningRecord = {
        id: spaceUuid(++ids),
        caseId: spaceUuid(++ids),
        executionSpaceId: spaceUuid(++ids),
        branchId: spaceUuid(++ids),
        initialContributionId: spaceUuid(++ids),
        caseNumber: ids,
        scope: requestSpaceScope,
        ownerId: input.ownerId,
        command: clone(input.command),
        commandDigest: input.commandDigest,
        base: null,
        baseDigest: null,
        phase: "allocated",
        admissionId: null,
        revision: 0,
        issues: [],
        createdAt: "now",
      };
      records.set(key, record);
      return Promise.resolve(clone(record));
    },
    selectBase(input) {
      const record = [...records.values()].find((entry) =>
        entry.id === input.id
      )!;
      if (record.revision === input.expectedRevision && !record.base) {
        record.base = clone(input.base);
        record.baseDigest = input.baseDigest;
        record.phase = "source-selected";
        record.revision++;
      }
      return Promise.resolve(clone(record));
    },
    advance(input) {
      const record = [...records.values()].find((entry) =>
        entry.id === input.id
      )!;
      if (
        record.revision === input.expectedRevision &&
        record.phase === input.from
      ) {
        equal(
          OPENING_PHASES.indexOf(input.to),
          OPENING_PHASES.indexOf(input.from) + 1,
        );
        record.phase = input.to;
        record.admissionId = input.admissionId ?? record.admissionId;
        record.issues = [];
        record.revision++;
      }
      return Promise.resolve(clone(record));
    },
    issue(input) {
      const record = [...records.values()].find((entry) =>
        entry.id === input.id
      )!;
      if (record.revision === input.expectedRevision) {
        record.issues = [input.code];
        record.revision++;
      }
      return Promise.resolve(clone(record));
    },
    get: (id) =>
      Promise.resolve(
        clone([...records.values()].find((entry) => entry.id === id) ?? null),
      ),
    forCase: (caseId) =>
      Promise.resolve(
        clone(
          [...records.values()].find((entry) => entry.caseId === caseId) ??
            null,
        ),
      ),
  };
  const admissions = new Map<string, SpaceExecutionAdmission>();
  const host: RequestSpaceHostOptions = {
    scope: requestSpaceScope,
    store,
    control: {
      hostController(ownerId, opener) {
        if (!openerAdmitted) {
          throw new RequestSpaceError(
            "FORBIDDEN",
            "The operator is not admitted by the space control policy.",
          );
        }
        hostControllers++;
        return Promise.resolve({
          kind: "host" as const,
          ownerId,
          capabilityId: `host-cap-${hostControllers}`,
          capabilityRevision: 0,
          authority: spaceControlAuthority(),
          opener: clone(opener),
        });
      },
      authenticateSession() {
        sessions++;
        if (!authenticated) {
          throw new RequestSpaceError(
            "FORBIDDEN",
            "Expired session",
          );
        }
        return Promise.resolve({
          ownerId: "owner",
          capabilityId: "cap",
          capabilityRevision: 0,
          sessionId: "session",
          authority: spaceControlAuthority(),
        });
      },
      revalidate() {
        if (!authenticated) {
          throw new RequestSpaceError(
            "FORBIDDEN",
            "Expired session",
          );
        }
        return Promise.resolve();
      },
    },
    mainOpener: {
      current(operator) {
        if (!mayOpen || operator.operatorId !== "operator") {
          throw new RequestSpaceError(
            "FORBIDDEN",
            "The Main Operator's mandate does not cover open-request.",
          );
        }
        return Promise.resolve("owner");
      },
    },
    source: {
      resolve(choice) {
        resolutions++;
        return Promise.resolve(
          clone(choice.kind === "release" ? release : current),
        );
      },
      verify: () => Promise.resolve(),
      readModels: () => Promise.resolve([]),
      readModelsForInspection() {
        throw new Error("Opening execution must not use historical inspection");
      },
    },
    branches: {
      ensure(record) {
        const version = record.base!.manifest.source!.sourceVersion;
        const old = refs.get(record.branchId);
        if (old) equal(old, version);
        refs.set(record.branchId, version);
        return Promise.resolve();
      },
      sourceVersion: (record) => Promise.resolve(refs.get(record.branchId)!),
      assertRetainedExecutionVersion: () => Promise.resolve(),
      assertVersion: () => Promise.resolve(),
    },
    runtime: {
      provision(record) {
        preparationOrder.push("provision");
        seenBases.push(record.base!.manifest.source!.sourceVersion);
        if (provisioningFails) throw new Error("private host path");
        return Promise.resolve();
      },
      prepareInitialSkills() {
        preparationOrder.push("prepare");
        if (preparationFails) throw new Error("private preparation path");
        return Promise.resolve();
      },
      enqueue(record) {
        deliveries.add(record.initialContributionId);
        return Promise.resolve();
      },
    },
    admissions: {
      ensure(record, controller) {
        if (revoked) {
          throw new RequestSpaceError(
            "ADMISSION_REFUSED",
            "Revoked admission",
          );
        }
        let admission = admissions.get(record.id);
        if (!admission) {
          admission = {
            id: `admission-${record.id}`,
            scope: record.scope,
            openingId: record.id,
            executionSpaceId: record.executionSpaceId,
            ownerId: record.ownerId,
            capabilityId: controller.capabilityId,
            capabilityRevision: 0,
            baseDigest: record.baseDigest!,
            authority: controller.authority,
            permissions: {
              operatorIds: ["operator"],
              acts: ["conversation"],
              resourceIds: [],
              modelDigests: [record.base!.manifest.operators[0].modelDigest],
              sourceVersion: record.base!.manifest.source!.sourceVersion,
            },
            revision: 0,
            status: "active",
            expiresAt: "2099-01-01T00:00:00Z",
            createdAt: "now",
          };
          admissions.set(record.id, admission);
        }
        return Promise.resolve(clone(admission));
      },
      assertDispatch() {
        if (revoked) {
          throw new RequestSpaceError(
            "ADMISSION_REFUSED",
            "Revoked admission",
          );
        }
        return Promise.resolve();
      },
      revoke() {
        throw new Error("Not invoked by opening");
      },
    },
  };
  return {
    service: new RequestSpaceOpenings(host),
    store,
    records,
    deliveries,
    seenBases,
    preparationOrder,
    refs,
    resolutions: () => resolutions,
    setCurrent: async () => {
      current = await requestOpeningBase("c");
    },
    failPreparation: (value: boolean) => {
      preparationFails = value;
    },
    failProvision: (value: boolean) => {
      provisioningFails = value;
    },
    revoke: () => {
      revoked = true;
    },
    expireSession: () => {
      authenticated = false;
    },
    removeOpenRequestAct: () => {
      mayOpen = false;
    },
    refuseOpener: () => {
      openerAdmitted = false;
    },
    sessions: () => sessions,
    hostControllers: () => hostControllers,
    admissions,
    release,
  };
}
const command: OpeningCommand = {
  openingKey: "main-a",
  text: "A request",
  source: { kind: "current-main" },
};
Deno.test("opening retries preserve one base/Case/branch after main moves and dispatch only one logical input", async () => {
  const f = await fixture();
  f.failProvision(true);
  const pending = await f.service.open(command, "owned-session");
  equal(pending.phase, "branch-ready");
  equal(JSON.stringify(pending).includes("private host path"), false);
  equal(f.deliveries.size, 0);
  await f.setCurrent();
  f.failProvision(false);
  const ready = await f.service.open(command, "owned-session");
  equal(ready.phase, "dispatched");
  equal(ready.caseId, pending.caseId);
  equal(ready.sourceVersion, `commit:${"a".repeat(40)}`);
  equal(f.resolutions(), 1);
  equal((await f.service.open(command, "owned-session")).caseId, ready.caseId);
  equal(f.deliveries.size, 1);
  deepStrictEqual(f.seenBases, [
    `commit:${"a".repeat(40)}`,
    `commit:${"a".repeat(40)}`,
  ]);
});
Deno.test("main and exact Release openings retain different bases and isolated identities with the same native operator", async () => {
  const f = await fixture();
  const a = await f.service.open(command, "session");
  const b = await f.service.open({
    openingKey: "release-b",
    text: "B request",
    source: {
      kind: "release",
      releaseId: f.release.release!.id,
      digest: f.release.manifestDigest,
    },
  }, "session");
  equal(a.phase, "dispatched");
  equal(b.phase, "dispatched");
  equal(a.caseId === b.caseId, false);
  equal(a.executionSpaceId === b.executionSpaceId, false);
  equal(a.branchId === b.branchId, false);
  equal(a.sourceVersion === b.sourceVersion, false);
  equal(f.refs.size, 2);
  equal(f.deliveries.size, 2);
});
Deno.test("changed payload, expired session and revoked admission do not reselect or dispatch", async () => {
  const f = await fixture();
  await f.service.open(command, "session");
  await rejects(
    () => f.service.open({ ...command, text: "Changed" }, "session"),
    /Different command/,
  );
  equal(f.resolutions(), 1);
  equal(f.deliveries.size, 1);
  f.revoke();
  await rejects(() => f.service.open(command, "session"), /Revoked admission/);
  equal(f.deliveries.size, 1);
  f.expireSession();
  await rejects(
    () => f.service.open({ ...command, openingKey: "other" }, "session"),
    /Expired session/,
  );
  equal(f.records.size, 1);
});
Deno.test("concurrent exact retries keep the durable CAS winner and one contribution identity", async () => {
  const f = await fixture();
  const results = await Promise.all([
    f.service.open(command, "session"),
    f.service.open(command, "session"),
  ]);
  equal(results[0].caseId, results[1].caseId);
  equal(f.records.size, 1);
  equal(f.refs.size, 1);
  equal(f.deliveries.size, 1);
  const stored = (await f.store.forCase(results[0].caseId))!;
  equal(await requestSpaceDigest(stored.base), stored.baseDigest);
});

Deno.test("Initial skill preparation retries inside branch-ready without admission or changed opening identity", async () => {
  const f = await fixture();
  f.failPreparation(true);
  const pending = await f.service.open(command, "session");
  equal(pending.phase, "branch-ready");
  equal(pending.admissionId, null);
  equal(f.deliveries.size, 0);
  deepStrictEqual(f.preparationOrder, ["provision", "prepare"]);
  equal(JSON.stringify(pending).includes("private preparation path"), false);
  f.failPreparation(false);
  const ready = await f.service.open(command, "session");
  equal(ready.phase, "dispatched");
  equal(ready.caseId, pending.caseId);
  equal(ready.sourceVersion, pending.sourceVersion);
  deepStrictEqual(f.preparationOrder, [
    "provision",
    "prepare",
    "provision",
    "prepare",
  ]);
  equal(f.deliveries.size, 1);
  equal(f.resolutions(), 1);
});

const opener: MainOpener = {
  operator: {
    projectId: "project",
    systemId: "system",
    executionSpaceId: "main",
    operatorId: "operator",
  },
  origin: {
    conversationId: "main-runtime",
    designerScopeId: "main:designer",
    messageId: "message",
    openingId: "mo-opening-1",
  },
};
const objective = {
  text: "Summarize the supplied page",
  source: { kind: "current-main" as const },
};

Deno.test("4.8d D3: the Main Operator opens a branch under a host controller, with no session", async () => {
  const f = await fixture();
  const view = await f.service.openForMain(objective, opener);
  equal(view.phase, "dispatched");
  equal(f.sessions(), 0, "no person session is authenticated or created");
  equal(f.hostControllers(), 1);
  equal(f.deliveries.size, 1);
  const record = (await f.store.forCase(view.caseId))!;
  equal(record.ownerId, "owner", "the space stays the person's");
  deepStrictEqual(record.command.opener, opener);
  equal(record.command.openingKey, await mainOpeningKey(opener));
  match(record.command.openingKey, /^main-[a-f0-9]{64}$/);
  equal(f.admissions.get(record.id)?.capabilityId, "host-cap-1");
});

Deno.test("4.8d D3: the same openingId is the same opening; another objective conflicts", async () => {
  const f = await fixture();
  const first = await f.service.openForMain(objective, opener);
  const again = await f.service.openForMain(objective, opener);
  equal(again.caseId, first.caseId);
  equal(f.deliveries.size, 1);
  await rejects(
    () =>
      f.service.openForMain(
        { ...objective, text: "Another objective" },
        opener,
      ),
    { code: "OPENING_CONFLICT" },
  );
  equal(f.records.size, 1);
  // A new openingId is a new Request.
  const other = await f.service.openForMain(objective, {
    ...opener,
    origin: { ...opener.origin, openingId: "mo-opening-2" },
  });
  equal(other.caseId === first.caseId, false);
});

Deno.test("4.8d D3: without the open-request act or the person's admission of the operator, nothing is created", async () => {
  const f = await fixture();
  f.removeOpenRequestAct();
  await rejects(() => f.service.openForMain(objective, opener), {
    code: "FORBIDDEN",
  });
  await rejects(
    () =>
      f.service.openForMain(objective, {
        ...opener,
        operator: { ...opener.operator, operatorId: "someone-else" },
      }),
    { code: "FORBIDDEN" },
  );
  const g = await fixture();
  g.refuseOpener();
  await rejects(() => g.service.openForMain(objective, opener), {
    code: "FORBIDDEN",
  });
  equal(f.records.size + g.records.size, 0);
  equal(f.hostControllers() + g.hostControllers(), 0);
});

Deno.test("4.8d D3: a revoked act stops an opening at its next step", async () => {
  const f = await fixture();
  f.failProvision(true);
  const pending = await f.service.openForMain(objective, opener);
  equal(pending.phase, "branch-ready");
  f.failProvision(false);
  f.removeOpenRequestAct();
  await rejects(() => f.service.openForMain(objective, opener), {
    code: "FORBIDDEN",
  });
  equal(f.deliveries.size, 0);
});

Deno.test("4.8d D3: the Main Operator opens from an exact Release", async () => {
  const f = await fixture();
  const view = await f.service.openForMain({
    text: "From the Release",
    source: {
      kind: "release",
      releaseId: f.release.release!.id,
      digest: f.release.manifestDigest,
    },
  }, opener);
  equal(view.phase, "dispatched");
  deepStrictEqual(view.release, f.release.release);
});

Deno.test("4.8d D3: only the registered Main with the open-request act of its own mandate opens", async () => {
  const state = requestControlState();
  const model = state.executionModel!;
  const main = {
    projectId: model.identity.projectId,
    systemId: model.identity.systemId,
    executionSpaceId: "main",
    operatorId: model.identity.builderId,
  };
  let registered: { snapshot: typeof state } | undefined = { snapshot: state };
  const authority = mainOpenerAuthority(() => registered);
  await rejects(() => authority.current(main), { code: "FORBIDDEN" });
  model.mandate.mayOpenRequests = true;
  equal(await authority.current(main), "owner");
  for (
    const other of [
      { ...main, executionSpaceId: "branch" },
      { ...main, operatorId: "someone-else" },
      { ...main, systemId: "another-system" },
    ]
  ) {
    await rejects(() => authority.current(other), { code: "FORBIDDEN" });
  }
  registered = undefined;
  await rejects(() => authority.current(main), { code: "FORBIDDEN" });
});

Deno.test("4.8d: a refused Main Operator opening says why and how to recover", async () => {
  const state = requestControlState();
  const model = state.executionModel!;
  const main = {
    projectId: model.identity.projectId,
    systemId: model.identity.systemId,
    executionSpaceId: "main",
    operatorId: model.identity.builderId,
  };
  const refusal = await mainOpenerAuthority(() => ({ snapshot: state }))
    .current(main).then(() => undefined, (error: unknown) => error);
  if (!(refusal instanceof RequestSpaceError)) throw refusal;
  equal(refusal.code, "FORBIDDEN");
  deepStrictEqual(refusal.context, { operatorId: main.operatorId });
  match(refusal.recovery ?? "", /open-request/);
});

Deno.test("4.8d Q3: the Main Operator writes only to a dispatched Request of its system's owner", async () => {
  const f = await fixture();
  const view = await f.service.openForMain(objective, opener);
  const written: Array<
    { caseId: string; instruction: string; operatorId?: string }
  > = [];
  const host = (f.service as unknown as { host: RequestSpaceHostOptions })
    .host;
  host.runtime.submitFromMain = (record, input) => {
    written.push({
      caseId: record.caseId,
      instruction: input.instruction,
      ...(input.operatorId ? { operatorId: input.operatorId } : {}),
    });
    return Promise.resolve();
  };
  host.admissions.recorded = (record) =>
    Promise.resolve(f.admissions.get(record.id)!);
  const message = { resumeId: "r1", instruction: "Also page two", at: "now" };
  await f.service.writeForMain(view.caseId, message, opener);
  deepStrictEqual(written, [{
    caseId: view.caseId,
    instruction: "Also page two",
  }]);
  await f.service.writeForMain(view.caseId, {
    ...message,
    operatorId: "member",
  }, opener);
  deepStrictEqual(written[1], {
    caseId: view.caseId,
    instruction: "Also page two",
    operatorId: "member",
  });
  await rejects(() => f.service.writeForMain("unknown", message, opener), {
    code: "FORBIDDEN",
  });
  f.removeOpenRequestAct();
  await rejects(() => f.service.writeForMain(view.caseId, message, opener), {
    code: "FORBIDDEN",
  });
  equal(written.length, 2);
});

Deno.test("4.8d Q3: a Main Operator the owner no longer admits cannot write to the BO", async () => {
  const f = await fixture();
  const view = await f.service.openForMain(objective, opener);
  const written: string[] = [];
  const host = (f.service as unknown as { host: RequestSpaceHostOptions })
    .host;
  host.runtime.submitFromMain = (_record, input) => {
    written.push(input.instruction);
    return Promise.resolve();
  };
  let changeDuringRead = false;
  host.admissions.recorded = (record) => {
    if (changeDuringRead) f.expireSession();
    return Promise.resolve(f.admissions.get(record.id)!);
  };
  const message = { resumeId: "r1", instruction: "Also page two", at: "now" };
  const before = f.hostControllers();
  await f.service.writeForMain(view.caseId, message, opener);
  // Same controller as an opening: the owner's current policy admits the MO.
  equal(f.hostControllers(), before + 1);
  // Its control changes between the read and the write: nothing is sent.
  changeDuringRead = true;
  await rejects(() => f.service.writeForMain(view.caseId, message, opener), {
    code: "FORBIDDEN",
  });
  // The owner's policy no longer admits the MO.
  const g = await fixture();
  const other = await g.service.openForMain(objective, opener);
  const gHost = (g.service as unknown as { host: RequestSpaceHostOptions })
    .host;
  gHost.runtime.submitFromMain = (_record, input) => {
    written.push(input.instruction);
    return Promise.resolve();
  };
  gHost.admissions.recorded = (record) =>
    Promise.resolve(g.admissions.get(record.id)!);
  g.refuseOpener();
  await rejects(() => g.service.writeForMain(other.caseId, message, opener), {
    code: "FORBIDDEN",
  });
  deepStrictEqual(written, ["Also page two"]);
});
