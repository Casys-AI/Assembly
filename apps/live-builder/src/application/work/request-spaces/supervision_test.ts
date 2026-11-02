import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { RequestSupervision, supervisionQuery } from "./supervision.ts";
import type {
  OpeningRecord,
  SpaceController,
} from "../../../domain/work/request-spaces.ts";
import { RequestSpaceError } from "../../../domain/work/request-spaces.ts";
import type { RequestExecutionBinding } from "../../model/evolution/request-adoption-ports.ts";
import {
  requestControlState,
  requestSpaceScope as scope,
} from "../../../../test/support/request-space-fixture.ts";

const at = "2026-10-31T03:00:00.000Z";
function fixture() {
  const main = requestControlState();
  main.executionModel!.operator = {
    name: "Global coordinator",
    instruction: "Main",
    primary: true,
    humanInput: true,
  };
  const records = [3, 2, 1].map((number) =>
    ({
      id: `opening-${number}`,
      caseId: `case-${number}`,
      caseNumber: number,
      scope,
      ownerId: number === 1 ? "foreign-owner" : "owner",
      executionSpaceId: `space-${number}`,
      branchId: `branch-${number}`,
      phase: "dispatched",
      admissionId: `admission-${number}`,
      baseDigest: "base",
      base: { requestOwner: { operatorId: "operator" } },
    }) as OpeningRecord
  );
  const states = new Map(records.map((record) => {
    const state = requestControlState();
    const letter = record.caseNumber === 2 ? "a" : "b";
    state.executionModel!.version.digest = letter.repeat(64);
    state.executionModel!.version.repositoryVersion = `commit:${
      letter.repeat(40)
    }`;
    state.executionModel!.operator = {
      name: record.caseNumber === 2 ? "Case researcher" : "Main Operator",
      instruction: "Scoped",
      primary: true,
      humanInput: true,
    };
    state.cases = [{
      id: record.caseId,
      number: record.caseNumber,
      objective: `Objective ${record.caseNumber}`,
      owner: "operator",
      openedBy: "owner",
      openedFrom: { conversationId: `actual-origin-${record.caseNumber}` },
    }] as typeof state.cases;
    return [record.caseId, state];
  }));
  const controller = { ownerId: "owner" } as SpaceController;
  let valid = true, mainMissing = false, observationMissing = false;
  let refusal: "refused" | "unknown" | undefined;
  let delayed: (() => Promise<void>) | undefined;
  let currentTime = at;
  let admissionHook: (() => void) | undefined;
  let revalidateHook: (() => Promise<void>) | undefined;
  const teamStates = new Map<string, typeof main[]>();
  const teamAdmitted = new Map<string, string[]>();
  let teamFails = false;
  const calls: string[] = [],
    clockReads: string[][] = [],
    pageReads: Array<{ owner: string; limit: number; before?: number }> = [];
  const service = new RequestSupervision({
    scope,
    control: {
      authenticateSession(secret) {
        calls.push("authenticate");
        if (!valid || secret !== "session") {
          throw new RequestSpaceError("FORBIDDEN", "Unavailable session");
        }
        return Promise.resolve(controller);
      },
      async revalidate() {
        calls.push("revalidate");
        if (!valid) {
          throw new RequestSpaceError("FORBIDDEN", "Unavailable session");
        }
        await revalidateHook?.();
      },
    },
    store: {
      pageForOwner(owner, query) {
        calls.push("discover");
        pageReads.push({
          owner,
          limit: query.limit,
          before: query.beforeCaseNumber,
        });
        return Promise.resolve(
          records.filter((record) =>
            record.ownerId === owner &&
            (query.beforeCaseNumber === undefined ||
              record.caseNumber < query.beforeCaseNumber)
          ).slice(0, query.limit),
        );
      },
      forCase: (caseId) => {
        calls.push("owned-read");
        return Promise.resolve(
          records.find((record) => record.caseId === caseId) ?? null,
        );
      },
    },
    observations: {
      mainActor: { ...scope, executionSpaceId: "main", operatorId: "operator" },
      main: () => {
        calls.push("main");
        return Promise.resolve(mainMissing ? null : structuredClone(main));
      },
      async request(record) {
        calls.push(`observation:${record.caseId}`);
        await delayed?.();
        if (observationMissing) {
          throw new Error("Missing or incoherent retained observation");
        }
        const state = structuredClone(states.get(record.caseId)!);
        return {
          binding: {
            state,
            pin: {
              source: {
                version: state.executionModel!.version.repositoryVersion,
              },
              modelDigest: state.executionModel!.version.digest,
            },
            admission: {
              id: record.admissionId,
              openingId: record.id,
              executionSpaceId: record.executionSpaceId,
              ownerId: record.ownerId,
              scope,
              baseDigest: record.baseDigest,
              permissions: {
                operatorIds: [
                  "operator",
                  ...(teamAdmitted.get(record.caseId) ?? []),
                ],
              },
            },
          } as RequestExecutionBinding,
          parentExecutionSpaceId: "main",
        };
      },
      team(record) {
        calls.push(`team:${record.caseId}`);
        if (teamFails) {
          return Promise.reject(new Error("Team observation unavailable"));
        }
        return Promise.resolve(
          structuredClone(teamStates.get(record.caseId) ?? []),
        );
      },
    },
    admissions: {
      assertConversation(record, actor, source) {
        equal(actor.ownerId, "owner");
        equal(
          source?.sourceVersion,
          states.get(record.caseId)!.executionModel!.version.repositoryVersion,
        );
        calls.push(`admission:${record.caseId}`);
        if (refusal === "refused") {
          throw new RequestSpaceError(
            "ADMISSION_REFUSED",
            "Revoked or expired",
          );
        }
        if (refusal === "unknown") throw new Error("Admission unavailable");
        admissionHook?.();
        return Promise.resolve();
      },
    },
    now: () => {
      clockReads.push([...calls]);
      return currentTime;
    },
  });
  return {
    service,
    records,
    states,
    teamStates,
    teamAdmitted,
    main,
    calls,
    clockReads,
    pageReads,
    revoke: () => {
      valid = false;
    },
    noMain: () => {
      mainMissing = true;
    },
    noObservation: () => {
      observationMissing = true;
    },
    failTeam: () => {
      teamFails = true;
    },
    refuse: (value: typeof refusal) => {
      refusal = value;
    },
    delay: (value: () => Promise<void>) => {
      delayed = value;
    },
    time: (value: string) => {
      currentTime = value;
    },
    afterAdmission: (value: () => void) => {
      admissionHook = value;
    },
    beforeDelivery: (value: () => Promise<void>) => {
      revalidateHook = value;
    },
  };
}

Deno.test("supervision keeps Main and BO actors distinct, preserves source names and pins, and never promotes opening ancestry to verified supervision", async () => {
  const f = fixture();
  const before = structuredClone([...f.states]);
  const result = await f.service.read("session");
  equal(result.schema, "assembly-system-supervision/v1");
  deepStrictEqual(result.scope, scope);
  equal(result.observedAt, at);
  equal(result.completedAt, at);
  equal(result.main.name, "Global coordinator");
  equal(result.main.actor.executionSpaceId, "main");
  deepStrictEqual(
    result.instances.map((
      entry,
    ) => [
      entry.actor.operatorId,
      entry.actor.executionSpaceId,
      entry.name,
      entry.source?.sourceVersion,
    ]),
    [
      ["operator", "space-3", "Main Operator", `commit:${"b".repeat(40)}`],
      ["operator", "space-2", "Case researcher", `commit:${"a".repeat(40)}`],
    ],
  );
  equal(result.instances[0].role, "BO");
  equal(result.instances[0].supervision.status, "unresolved");
  if (result.instances[0].supervision.status === "unresolved") {
    deepStrictEqual(
      result.instances[0].supervision.hostMain,
      result.main.actor,
    );
    deepStrictEqual(result.instances[0].supervision.openingProvenance, {
      openingId: "opening-3",
      admissionId: "admission-3",
      parentExecutionSpaceId: "main",
      openedBy: "owner",
      originConversationId: "actual-origin-3",
    });
  }
  const action = result.instances[0].evaluatedActions[0];
  equal(action.result, "allowed");
  equal(action.evaluatedAt, at);
  deepStrictEqual(action.actor, { kind: "controller", ownerId: "owner" });
  deepStrictEqual(action.target, result.instances[0].actor);
  deepStrictEqual(action.source, result.instances[0].source);
  equal(
    result.instances[0].evaluatedActions.slice(1).every((entry) =>
      entry.result === "unevaluated" && entry.evaluatedAt === null
    ),
    true,
  );
  deepStrictEqual([...f.states], before);
  equal(f.calls[0], "authenticate");
  equal(f.calls.at(-1), "revalidate");
  deepStrictEqual(f.clockReads[0], ["authenticate", "discover"]);
  equal(f.clockReads.at(-1)?.at(-1), "revalidate");
});

Deno.test("adoption after a dated evaluation keeps the earlier independent observation inside its collection interval", async () => {
  const f = fixture();
  const evaluatedAt = "2026-10-31T03:00:01.000Z";
  const completedAt = "2026-10-31T03:00:02.000Z";
  f.afterAdmission(() => f.time(evaluatedAt));
  let resume!: () => void, began!: () => void;
  const reachedFinalRevalidation = new Promise<void>((resolve) => {
    began = resolve;
  });
  f.beforeDelivery(() => {
    began();
    return new Promise<void>((resolve) => {
      resume = resolve;
    });
  });
  const pending = f.service.read("session", { caseId: "case-3" });
  await reachedFinalRevalidation;
  // A real source adoption can commit after this row's admission evaluation
  // while another awaited read/revalidation is still in progress. Reading does
  // not freeze the execution pin or extend the earlier admission evaluation.
  const adopted = f.states.get("case-3")!;
  adopted.executionModel!.version.repositoryVersion = `commit:${
    "d".repeat(40)
  }`;
  adopted.executionModel!.version.digest = "d".repeat(64);
  adopted.revision++;
  f.time(completedAt);
  resume();
  const result = await pending;
  equal(result.observedAt, at);
  equal(result.completedAt, completedAt);
  const row = result.instances[0];
  equal(row.source?.sourceVersion, `commit:${"b".repeat(40)}`);
  equal(row.source?.modelDigest, "b".repeat(64));
  equal(row.evaluatedActions[0].evaluatedAt, evaluatedAt);
  equal(row.evaluatedActions[0].result, "allowed");
  deepStrictEqual(row.evaluatedActions[0].source, row.source);
  equal(
    row.evaluatedActions.slice(1).every((action) =>
      action.result === "unevaluated"
    ),
    true,
  );
  equal(f.calls.filter((call) => call === "observation:case-3").length, 1);
  equal(f.calls.filter((call) => call === "admission:case-3").length, 1);
  equal(f.clockReads.at(-1)?.at(-1), "revalidate");
});

Deno.test("supervision uses bounded owner keyset discovery with honest continuation and selected Case scope", async () => {
  const f = fixture();
  const first = await f.service.read("session", { limit: 1 });
  equal(first.instances.length, 1);
  equal(first.coverage.completeness, "has-more");
  equal(first.nextCursor, "case-number:3");
  const next = await f.service.read("session", {
    limit: 1,
    cursor: first.nextCursor!,
  });
  equal(next.instances[0].case?.id, "case-2");
  equal(next.coverage.completeness, "complete");
  equal(next.nextCursor, null);
  deepStrictEqual(f.pageReads, [
    { owner: "owner", limit: 2, before: undefined },
    { owner: "owner", limit: 2, before: 3 },
  ]);
  const scoped = await f.service.read("session", { caseId: "case-2" });
  equal(scoped.coverage.selection, "selected-case");
  equal(scoped.instances.length, 1);
  equal(scoped.main.actor.executionSpaceId, "main");
  equal(f.pageReads.length, 2);
});

Deno.test("supervision authenticates before discovery and refuses foreign, missing, wrong-host and revoked readers", async () => {
  const f = fixture();
  await rejects(() => f.service.read("wrong-session"), /session/);
  deepStrictEqual(f.calls, ["authenticate"]);
  await rejects(
    () => f.service.read("session", { caseId: "case-1" }),
    /unavailable/,
  );
  await rejects(
    () => f.service.read("session", { caseId: "missing" }),
    /unavailable/,
  );
  f.records[0].scope = { ...scope, systemId: "another-host" };
  await rejects(() => f.service.read("session"), /unavailable/);
  equal(f.calls.includes("main"), false);
  f.revoke();
  await rejects(() => f.service.read("session"), /session/);
});

Deno.test("revocation or opening substitution during delayed supervision prevents protected delivery", async () => {
  for (const revoke of [true, false]) {
    const f = fixture();
    let resume!: () => void, began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    f.delay(() => {
      began();
      return new Promise<void>((resolve) => {
        resume = resolve;
      });
    });
    const pending = f.service.read("session", { caseId: "case-3" });
    await started;
    if (revoke) f.revoke();
    else f.records[0].ownerId = "another-owner";
    resume();
    await rejects(() => pending, RequestSpaceError);
  }
});

Deno.test("supervision retains owned references but no invented source, title, health or grants on a missing observation", async () => {
  const f = fixture();
  f.noObservation();
  const result = await f.service.read("session");
  equal(result.coverage.unavailable, 2);
  for (const entry of result.instances) {
    equal(entry.availability, "unavailable");
    equal(entry.source, null);
    equal(entry.case?.title, null);
    equal(entry.supervision.status, "unresolved");
    equal(
      entry.evaluatedActions.every((action) => action.result === "unevaluated"),
      true,
    );
  }
  equal(f.calls.some((call) => call.startsWith("admission:")), false);
});

Deno.test("conversation refusal stays distinct from unavailable evaluation and Main failure never borrows a BO", async () => {
  const f = fixture();
  f.refuse("refused");
  equal(
    (await f.service.read("session")).instances[0].evaluatedActions[0].result,
    "refused",
  );
  f.refuse("unknown");
  const unknown =
    (await f.service.read("session")).instances[0].evaluatedActions[0];
  equal(unknown.result, "unevaluated");
  equal(unknown.evaluatedAt, null);
  f.noMain();
  const missingMain = await f.service.read("session");
  equal(missingMain.main.availability, "unavailable");
  equal(missingMain.main.source, null);
  equal(missingMain.instances[0].availability, "available");
  equal(missingMain.instances[0].supervision.status, "unresolved");
});

Deno.test("supervision rejects malformed, unbounded and conflicting selection inputs", () => {
  for (
    const query of [
      { limit: 0 },
      { limit: 51 },
      { limit: 1.2 },
      { caseId: "../x" },
      { cursor: "case-number:9007199254740992" },
      { cursor: "0" },
      { caseId: "case", cursor: "case-number:1" },
      { version: "historical" },
    ]
  ) {
    let threw = false;
    try {
      supervisionQuery(query);
    } catch (error) {
      threw = error instanceof RequestSpaceError &&
        error.code === "INVALID_COMMAND";
    }
    equal(threw, true, JSON.stringify(query));
  }
});

Deno.test("supervision lists branch team instances with their parent, after their BO", async () => {
  const f = fixture();
  const member = structuredClone(f.states.get("case-2")!);
  member.executionModel!.identity = {
    ...member.executionModel!.identity,
    builderId: "member",
    systemId: "member-system",
  };
  member.executionModel!.operatorTeam = {
    parentOperatorId: "operator",
    requestOwnerId: "operator",
    requestId: "case-2",
  };
  member.executionModel!.operator = {
    name: "Case helper",
    instruction: "Scoped",
    primary: false,
    humanInput: false,
  };
  f.teamStates.set("case-2", [member]);
  f.teamAdmitted.set("case-2", ["member"]);
  const snapshot = await f.service.read("session", { caseId: "case-2" });
  equal(snapshot.instances.length, 2);
  const [bo, team] = snapshot.instances;
  equal(bo!.role, "BO");
  equal(team!.role, "team");
  equal(team!.actor.operatorId, "member");
  equal(team!.actor.executionSpaceId, "space-2");
  equal(team!.parent?.operatorId, "operator");
  equal(team!.parent?.executionSpaceId, "space-2");
  equal(team!.case?.id, "case-2");
  equal(team!.name, "Case helper");
});

Deno.test("a failed team observation lists each admitted member unavailable; the BO stays readable", async () => {
  const f = fixture();
  f.teamAdmitted.set("case-2", ["member"]);
  f.failTeam();
  const snapshot = await f.service.read("session", { caseId: "case-2" });
  equal(snapshot.instances.length, 2);
  const [bo, team] = snapshot.instances;
  equal(bo!.role, "BO");
  equal(bo!.availability, "available");
  equal(team!.role, "team");
  equal(team!.actor.operatorId, "member");
  equal(team!.actor.executionSpaceId, "space-2");
  equal(team!.availability, "unavailable");
  equal(
    team!.unavailableReason,
    "The exact persisted team observation is unavailable.",
  );
  equal(team!.source, null);
  equal(team!.parent, undefined);
  equal(snapshot.coverage.unavailable, 1);
});

Deno.test("an admitted member without a verified state is listed unavailable beside its available peer", async () => {
  const f = fixture();
  const member = structuredClone(f.states.get("case-2")!);
  member.executionModel!.identity = {
    ...member.executionModel!.identity,
    builderId: "present",
    systemId: "present-system",
  };
  member.executionModel!.operatorTeam = {
    parentOperatorId: "operator",
    requestOwnerId: "operator",
    requestId: "case-2",
  };
  f.teamStates.set("case-2", [member]);
  f.teamAdmitted.set("case-2", ["missing", "present"]);
  const snapshot = await f.service.read("session", { caseId: "case-2" });
  deepStrictEqual(
    snapshot.instances.map((entry) => [
      entry.role,
      entry.actor.operatorId,
      entry.availability,
    ]),
    [
      ["BO", "operator", "available"],
      ["team", "missing", "unavailable"],
      ["team", "present", "available"],
    ],
  );
  equal(snapshot.instances[2]!.parent?.operatorId, "operator");
  equal(snapshot.coverage.unavailable, 1);
});
