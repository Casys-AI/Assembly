import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { RequestCaseConversations } from "./conversations.ts";
import { projectOperatorConversation } from "../operators/conversations.ts";
import type { OpeningRecord } from "../../../domain/work/request-spaces/opening.ts";
import type { SpaceController } from "../../../domain/work/request-spaces/space-control.ts";
import { RequestSpaceError } from "../../../domain/work/request-spaces/scope.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import type { AgentMessageCommand } from "../operators/conversation-types.ts";
import { requestControlModel } from "../../../../test/support/request-space-fixture.ts";

function fixture() {
  const scope = { projectId: "host-project", systemId: "host-system" };
  const owner = "control-owner", native = "operator";
  const controller = { ownerId: owner } as SpaceController;
  const records = ["caseA", "caseB", "caseForeign"].map((caseId, index) =>
    ({
      caseId,
      executionSpaceId: `space-${caseId}`,
      scope,
      phase: "dispatched",
      ownerId: index === 2 ? "other-owner" : owner,
      base: { requestOwner: { operatorId: native } },
    }) as OpeningRecord
  );
  const model = requestControlModel();
  model.version.digest = "a".repeat(64);
  model.version.repositoryVersion = `commit:${"b".repeat(40)}`;
  const states = new Map(records.map((record, index) => [record.caseId, {
    id: `request:${record.executionSpaceId}:${native}`,
    executionModel: model,
    revision: index + 3,
    busy: false,
    phase: "idle",
    events: [],
    messages: [{
      id: record.caseId,
      text: record.caseId,
      caseId: record.caseId,
      role: "user",
      at: "2026-11-03T00:00:00.000Z",
    }],
    cases: [{
      id: record.caseId,
      number: index + 1,
      owner: native,
      status: "open",
      createdAt: "2026-11-03T00:00:00.000Z",
      openedFrom: {
        conversationId: `request:${record.executionSpaceId}:${native}`,
        messageId: record.caseId,
      },
    }],
  } as unknown as SystemRuntimeState]));
  let valid = true, admitted = true, revalidations = 0;
  const teamStates = new Map<string, SystemRuntimeState[]>();
  let outcome: "refused" | undefined;
  let outcomeReader:
    | ((
      record: OpeningRecord,
      state: SystemRuntimeState,
    ) => Promise<"refused" | undefined>)
    | undefined;
  const closures: unknown[] = [];
  const reads: string[] = [],
    submitted: Array<{ caseId: string; command: AgentMessageCommand }> = [];
  const bridge = new RequestCaseConversations({
    scope,
    control: {
      authenticateSession(secret) {
        if (!valid || secret !== "session") {
          throw new RequestSpaceError("FORBIDDEN", "session unavailable");
        }
        return Promise.resolve(controller);
      },
      revalidate() {
        revalidations++;
        if (!valid) {
          throw new RequestSpaceError("FORBIDDEN", "session unavailable");
        }
        return Promise.resolve();
      },
    },
    store: {
      forOwner: (id) =>
        Promise.resolve(records.filter((record) => record.ownerId === id)),
      forCase: (id) =>
        Promise.resolve(records.find((record) => record.caseId === id) ?? null),
    },
    admissions: {
      assertConversation(record, actor) {
        equal(actor.ownerId, owner);
        equal(record.ownerId, owner);
        if (!admitted) {
          throw new RequestSpaceError(
            "ADMISSION_REFUSED",
            "admission unavailable",
          );
        }
        return Promise.resolve();
      },
    },
    runtime: {
      closeCase(record, outcome, evidence) {
        closures.push({ caseId: record.caseId, outcome, evidence });
        return Promise.resolve();
      },
      initialExecutionOutcome: (record, state) =>
        outcomeReader ? outcomeReader(record, state) : Promise.resolve(outcome),
      read(record) {
        reads.push(record.executionSpaceId);
        return Promise.resolve(structuredClone(states.get(record.caseId)!));
      },
      readTeam(record) {
        return Promise.resolve(
          structuredClone(teamStates.get(record.caseId) ?? []),
        );
      },
      submitHuman(record, command) {
        const state = states.get(record.caseId)!;
        if (state.revision !== command.expectedRevision) {
          throw new Error("stale revision");
        }
        submitted.push({
          caseId: record.caseId,
          command: structuredClone(command),
        });
        return Promise.resolve(record.caseId);
      },
    },
  });
  return {
    bridge,
    outcome: (value: "refused" | undefined) => {
      outcome = value;
    },
    outcomeReader: (reader: NonNullable<typeof outcomeReader>) => {
      outcomeReader = reader;
    },
    records,
    states,
    teamStates,
    reads,
    submitted,
    closures,
    revoke: () => {
      valid = false;
    },
    revokeAdmission: () => {
      admitted = false;
    },
    revalidations: () => revalidations,
  };
}
Deno.test("durable Request reads retain Case space and executed pin for a shared native owner", async () => {
  const f = fixture();
  const before = structuredClone([...f.states]);
  deepStrictEqual(
    (await f.bridge.cases("session")).cases.map((record) => record.id),
    ["caseA", "caseB"],
  );
  for (const id of ["caseA", "caseB"]) {
    const result = await f.bridge.conversations("session", id);
    equal(result.conversations.length, 1);
    equal(result.conversations[0].nativeId, "operator");
    equal(result.conversations[0].messages[0].id, id);
    equal(result.conversations[0].modelDigest, "a".repeat(64));
    equal(
      result.conversations[0].repositoryVersion,
      `commit:${"b".repeat(40)}`,
    );
  }
  deepStrictEqual([...f.states], before);
  deepStrictEqual(f.submitted, []);
  equal(f.revalidations(), 3);
});
Deno.test("missing, foreign and revoked Request reads fail without another scope read", async () => {
  const f = fixture();
  await rejects(() => f.bridge.conversations("session", "missing"));
  await rejects(() => f.bridge.conversations("session", "caseForeign"));
  f.records[0].scope = { ...f.records[0].scope, systemId: "foreign-host" };
  await rejects(() => f.bridge.conversations("session", "caseA"));
  f.revoke();
  await rejects(() => f.bridge.cases("session"));
  deepStrictEqual(f.reads, []);
});
Deno.test("continued Request contributions keep the explicit operator, Case and revision", async () => {
  const f = fixture();
  const command = {
    agentId: "operator",
    caseId: "caseB",
    text: "Continue B",
    expectedRevision: 4,
  };
  equal(await f.bridge.submitHuman("session", command), "caseB");
  deepStrictEqual(f.submitted, [{ caseId: "caseB", command }]);
  await rejects(() =>
    f.bridge.submitHuman("session", { ...command, agentId: "peer" })
  );
  await rejects(
    () => f.bridge.submitHuman("session", { ...command, expectedRevision: 3 }),
    /stale/,
  );
  await rejects(() =>
    f.bridge.submitHuman("session", { ...command, newConversation: true })
  );
  f.revokeAdmission();
  await rejects(() => f.bridge.submitHuman("session", command), /admission/);
  equal(f.submitted.length, 1);
});

Deno.test("Request owner without modeled operator metadata gains no primary role or send entry", async () => {
  const f = fixture();
  Reflect.deleteProperty(f.states.get("caseA")!.executionModel!, "operator");
  const snapshot = await f.bridge.conversations("session", "caseA");
  equal(
    snapshot.defaultAgentId,
    "operator",
    "default selection remains an identity only",
  );
  const selected = snapshot.conversations[0];
  equal(selected.nativeId, "operator");
  equal(selected.primary, false);
  equal(selected.canSend, false);
  equal(typeof selected.readOnlyReason, "string");
  deepStrictEqual(f.submitted, []);
});

Deno.test("Request projection preserves explicit primary metadata and humanInput false independently", async () => {
  const f = fixture();
  Object.assign(f.states.get("caseA")!.executionModel!, {
    operator: {
      name: "Explicit owner",
      instruction: "Only the admitted entry",
      primary: true,
      humanInput: false,
    },
  });
  const selected =
    (await f.bridge.conversations("session", "caseA")).conversations[0];
  equal(selected.name, "Explicit owner");
  equal(
    selected.primary,
    true,
    "the source explicitly supplies this display role",
  );
  equal(
    selected.canSend,
    false,
    "primary status cannot override a false human-input entry",
  );
  equal(typeof selected.readOnlyReason, "string");
  deepStrictEqual(f.submitted, []);
});

Deno.test("only the exact Request owner's generic Main name becomes Branch Operator without changing its model or authority", async () => {
  for (
    const name of [
      "Main Operator",
      "Research coordinator",
      "Main Operator assistant",
    ]
  ) {
    const f = fixture();
    const state = f.states.get("caseA")!;
    const model = state.executionModel!;
    model.operator = {
      name,
      instruction: "Keep the admitted configuration",
      primary: false,
      humanInput: false,
    };
    const before = structuredClone(state);
    const projected = projectOperatorConversation(
      state,
      model.identity.systemQualifiedName ?? model.identity.builderId,
      undefined,
      model.operatorTeam,
    );
    const selected =
      (await f.bridge.conversations("session", "caseA")).conversations[0];
    deepStrictEqual(selected, {
      ...projected,
      name: name === "Main Operator" ? "Branch Operator" : name,
    });
    equal(
      projectOperatorConversation(
        state,
        model.identity.builderId,
        model.identity.builderId,
        model.operatorTeam,
      ).name,
      name,
      "the shared global projection retains its exact name",
    );
    deepStrictEqual(state, before);
    deepStrictEqual(f.submitted, []);
  }
});

Deno.test("Request execution selection uses host opening scope and actual runtime model, never native state id", async () => {
  const f = fixture();
  const state = f.states.get("caseA")!;
  state.id = "unrelated-native-state-id";
  const selected = await f.bridge.execution("session", "caseA");
  deepStrictEqual(selected.scope, {
    projectId: "host-project",
    systemId: "host-system",
  });
  equal(selected.executionSpaceId, "space-caseA");
  equal(selected.caseId, "caseA");
  equal(selected.operatorId, "operator");
  equal(selected.runtimeRevision, 3);
  equal(selected.modelVersion.digest, "a".repeat(64));
  equal(selected.modelVersion.repositoryVersion, `commit:${"b".repeat(40)}`);
  state.executionModel!.version.digest = "c".repeat(64);
  equal(selected.modelVersion.digest, "a".repeat(64));
  deepStrictEqual(f.submitted, []);
});

Deno.test("Request execution selection refuses foreign or revoked owner without a Main/runtime fallback", async () => {
  const f = fixture();
  await rejects(() => f.bridge.execution("session", "caseForeign"));
  await rejects(() => f.bridge.execution("session", "missing"));
  f.revoke();
  await rejects(() => f.bridge.execution("session", "caseA"));
  deepStrictEqual(f.reads, []);
});

Deno.test("Request initial refusal projects static phase/list observation without closing Case, adding messages or granting send rights", async () => {
  const f = fixture();
  const before = structuredClone([...f.states]);
  const prior = await f.bridge.conversations("session", "caseA");
  f.outcome("refused");
  const conversations = await f.bridge.conversations("session", "caseA");
  equal(conversations.conversations[0].initialExecutionOutcome, "refused");
  equal(conversations.conversations[0].phase, "Initial execution refused");
  equal(conversations.conversations[0].canSend, prior.conversations[0].canSend);
  equal(conversations.conversations[0].busy, false);
  equal(conversations.version === prior.version, false);
  deepStrictEqual(
    conversations.conversations[0].messages,
    prior.conversations[0].messages,
  );
  const cases = await f.bridge.cases("session", "caseA");
  equal(cases.cases[0].status, "open");
  equal(cases.cases[0].initialExecutionOutcome, "refused");
  deepStrictEqual([...f.states], before);
  deepStrictEqual(f.submitted, []);
  f.outcome(undefined);
  equal(
    (await f.bridge.conversations("session", "caseA")).conversations[0]
      .initialExecutionOutcome,
    undefined,
  );
});

Deno.test("delayed native refusal is discarded after a later revision/input or busy transition and latest state is projected", async () => {
  for (const method of ["conversations", "cases"] as const) {
    for (const change of ["revision", "input", "busy"] as const) {
      const f = fixture();
      let began!: () => void, finish!: (value: "refused") => void;
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      f.outcomeReader(() => {
        began();
        return new Promise<"refused" | undefined>((resolve) => {
          finish = resolve;
        });
      });
      const pending = f.bridge[method]("session", "caseA");
      await started;
      const current = f.states.get("caseA")!;
      if (change === "revision") current.revision++;
      if (change === "input") current.activeInputMessageId = "later-input";
      if (change === "busy") current.busy = true;
      current.phase = "Later state";
      finish("refused");
      const result = await pending;
      if ("conversations" in result) {
        equal(result.conversations[0].initialExecutionOutcome, undefined);
        equal(result.conversations[0].revision, current.revision);
        equal(result.conversations[0].busy, current.busy);
        equal(result.conversations[0].phase, "Later state");
      } else equal(result.cases[0].initialExecutionOutcome, undefined);
      deepStrictEqual(f.reads, ["space-caseA", "space-caseA"]);
    }
  }
});
Deno.test("mixed historically readable Request list retains closed-space Case while projecting active sibling outcome", async () => {
  const f = fixture();
  f.outcomeReader((record) =>
    Promise.resolve(
      record.executionSpaceId === "space-caseA" ? undefined : "refused",
    )
  );
  const list = await f.bridge.cases("session");
  deepStrictEqual(
    list.cases.map((
      entry,
    ) => [entry.id, entry.status, entry.initialExecutionOutcome]),
    [
      ["caseA", "open", undefined],
      ["caseB", "open", "refused"],
    ],
  );
  deepStrictEqual(f.submitted, []);
});

Deno.test("Request snapshot lists retained team members in their operational Case without rewriting lineage", async () => {
  const f = fixture();
  const bo = structuredClone(f.states.get("caseA")!);
  const member = structuredClone(bo);
  member.id = "request:space-caseA:member";
  member.executionModel = structuredClone(bo.executionModel!);
  member.executionModel.identity = {
    ...member.executionModel.identity,
    builderId: "member",
    systemId: "member-system",
  };
  member.executionModel.operatorTeam = {
    parentOperatorId: "operator",
    requestOwnerId: "operator",
    requestId: "original-case",
  };
  member.executionModel.operator = {
    name: "Helper",
    instruction: "Help on this Case",
    primary: false,
    humanInput: false,
  };
  f.teamStates.set("caseA", [member]);
  const snapshot = await f.bridge.conversations("session", "caseA");
  equal(snapshot.conversations.length, 2);
  equal(snapshot.conversations[0]!.agentId, "operator");
  equal(snapshot.conversations[1]!.agentId, "member");
  deepStrictEqual(snapshot.conversations[1]!.operatorTeam, {
    parentOperatorId: "operator",
    requestOwnerId: "operator",
    requestId: "caseA",
  });
  equal(snapshot.defaultAgentId, "operator");
  equal(member.executionModel.operatorTeam.requestId, "original-case");
  // Without team states the snapshot is the historical single conversation.
  const alone = await f.bridge.conversations("session", "caseB");
  equal(alone.conversations.length, 1);
});

Deno.test("Request KPI reading includes team journals and checks the authenticated selection", async () => {
  const f = fixture();
  const member = structuredClone(f.states.get("caseA")!);
  member.id = "member";
  f.teamStates.set("caseA", [member]);
  deepStrictEqual(await f.bridge.requestKpis("session", "caseA"), {
    durationMs: null,
    humanInterventions: { messages: 1, decisions: 0 },
  });
  await rejects(() => f.bridge.requestKpis("session", "caseForeign"));
  f.revoke();
  await rejects(() => f.bridge.requestKpis("session", "caseA"));
});

Deno.test("Request closure takes the authenticated owner and refuses foreign or revoked selection", async () => {
  const f = fixture();
  await f.bridge.closeCase("session", "caseA", "done", "accepted");
  deepStrictEqual(f.closures, [{
    caseId: "caseA",
    outcome: "done",
    evidence: { closedBy: "control-owner", verdict: "accepted" },
  }]);
  await rejects(() =>
    f.bridge.closeCase("session", "caseForeign", "done", "accepted")
  );
  f.revokeAdmission();
  await rejects(() =>
    f.bridge.closeCase("session", "caseA", "done", "rejected")
  );
  f.revoke();
  await rejects(() => f.bridge.closeCase("session", "caseA", "abandoned"));
  equal(f.closures.length, 1);
});
