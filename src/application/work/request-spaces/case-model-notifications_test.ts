import { deepStrictEqual, equal } from "node:assert/strict";
import {
  type CaseModelVersion,
  CaseModelVersionEvents,
  type CaseModelVersionRead,
  isCaseModelVersion,
} from "./case-model-notifications.ts";

const a = `commit:${"a".repeat(40)}`;
const b = `commit:${"b".repeat(40)}`;
const c = `commit:${"c".repeat(40)}`;

Deno.test("a Case model event carries only its schema, Case and exact versions", () => {
  equal(
    isCaseModelVersion({
      schemaVersion: 1,
      caseId: "case-1",
      branchVersion: a,
      executionVersion: b,
    }),
    true,
  );
  for (
    const value of [
      null,
      [],
      {},
      { schemaVersion: 1, caseId: "case-1", branchVersion: a },
      {
        schemaVersion: 2,
        caseId: "case-1",
        branchVersion: a,
        executionVersion: a,
      },
      {
        schemaVersion: 1,
        caseId: "../x",
        branchVersion: a,
        executionVersion: a,
      },
      {
        schemaVersion: 1,
        caseId: "case-1",
        branchVersion: "main",
        executionVersion: a,
      },
      {
        schemaVersion: 1,
        caseId: "case-1",
        branchVersion: a,
        executionVersion: a,
        ownerId: "owner",
      },
      {
        schemaVersion: 1,
        caseId: "case-1",
        branchVersion: a,
        executionVersion: a,
        secret: "f".repeat(64),
      },
    ]
  ) equal(isCaseModelVersion(value), false, JSON.stringify(value));
});

function harness(initial: Record<string, CaseModelVersionRead | null>) {
  const state = { ...initial };
  const sent: Array<{ ownerId: string; event: CaseModelVersion }> = [];
  const errors: string[] = [];
  let reads = 0;
  const events = new CaseModelVersionEvents({
    read(caseId) {
      reads++;
      return Promise.resolve(state[caseId] ?? null);
    },
    deliver(ownerId, event) {
      sent.push({ ownerId, event });
    },
    onError(_error, caseId) {
      errors.push(caseId);
    },
  });
  return { state, sent, errors, events, reads: () => reads };
}

Deno.test("a Case's versions are announced once per change, to its owner only", async () => {
  const { state, sent, events } = harness({
    "case-1": { ownerId: "owner", branchVersion: a, executionVersion: a },
  });
  await events.observe("case-1");
  await events.observe("case-1");
  deepStrictEqual(sent, [{
    ownerId: "owner",
    event: {
      schemaVersion: 1,
      caseId: "case-1",
      branchVersion: a,
      executionVersion: a,
    },
  }]);
  // Admitted, then adopted: two real changes, two announcements.
  state["case-1"] = { ownerId: "owner", branchVersion: b, executionVersion: a };
  await events.observe("case-1");
  state["case-1"] = { ownerId: "owner", branchVersion: b, executionVersion: b };
  await events.observe("case-1");
  await events.observe("case-1");
  deepStrictEqual(
    sent.map(({ event }) => [event.branchVersion, event.executionVersion]),
    [[a, a], [b, a], [b, b]],
  );
  deepStrictEqual(
    new Set(sent.map(({ ownerId }) => ownerId)),
    new Set(["owner"]),
  );
});

Deno.test("an unknown or unreadable Case announces nothing and a failed read is reported", async () => {
  const { state, sent, errors, events } = harness({
    "case-1": {
      ownerId: "owner",
      branchVersion: "branch:main",
      executionVersion: a,
    },
  });
  await events.observe("missing");
  await events.observe("not a case");
  await events.observe("case-1");
  deepStrictEqual(sent, []);
  deepStrictEqual(errors, ["case-1"]);
  state["case-1"] = { ownerId: "owner", branchVersion: c, executionVersion: a };
  await events.observe("case-1");
  equal(sent.length, 1);
});

Deno.test("observations of a Case asked while one waits join it; a failed delivery stays inside", async () => {
  const gate = Promise.withResolvers<void>();
  const sent: string[] = [];
  let reads = 0;
  const errors: unknown[] = [];
  const events = new CaseModelVersionEvents({
    async read(caseId) {
      reads++;
      if (caseId === "slow") await gate.promise;
      return { ownerId: "owner", branchVersion: a, executionVersion: a };
    },
    deliver(_ownerId, event) {
      sent.push(event.caseId);
      if (event.caseId === "broken") throw new Error("stream closed");
    },
    onError: (error) => errors.push(error),
  });
  const first = events.observe("slow");
  const waiting = events.observe("other");
  const joined = events.observe("other");
  equal(waiting, joined);
  gate.resolve();
  await Promise.all([first, waiting, events.observe("broken")]);
  equal(reads, 3);
  deepStrictEqual(sent, ["slow", "other", "broken"]);
  equal(errors.length, 1);
});

Deno.test("closing waits for an in-flight model read and ignores later observations", async () => {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let reads = 0, deliveries = 0, closed = false;
  const events = new CaseModelVersionEvents({
    async read() {
      reads++;
      entered.resolve();
      await gate.promise;
      return { ownerId: "owner", branchVersion: a, executionVersion: a };
    },
    deliver() {
      deliveries++;
    },
  });
  const first = events.observe("case-1");
  await entered.promise;
  const closing = events.close().then(() => {
    closed = true;
  });
  await events.observe("case-2");
  equal(closed, false);
  gate.resolve();
  await Promise.all([first, closing]);
  equal(reads, 1);
  equal(deliveries, 0);
  equal(closed, true);
});
