import { deepStrictEqual, equal } from "node:assert/strict";
import {
  type Case,
  type CasesSnapshot,
  openCase,
} from "../../../domain/work/entities/cases.ts";
import { OperatorCases } from "./operators.ts";

function request(id: string, number: number, owner: string): Case {
  return openCase({
    id,
    number,
    type: "request",
    objective: `Objective ${id}`,
    owner,
    openedBy: owner,
    openedFrom: { conversationId: `${owner}-conversation` },
    modelPin: { digest: "pin" },
    createdAt: "2026-10-28T00:00:00.000Z",
  });
}

function scheduled(id: string, number: number, owner: string): Case {
  return {
    ...request(id, number, owner),
    scheduling: {
      schedule: { kind: "every", count: 1, unit: "hour" },
      behaviorId: "root",
      nextAt: "2026-10-28T01:00:00.000Z",
    },
  };
}

function runtimeFixture(records: Case[]) {
  const calls: Array<{ method: string; id: string; outcome?: string }> = [];
  const runtime = {
    cases: { systemId: "system", cases: records } as CasesSnapshot,
    closeCase(id: string, outcome: "done" | "abandoned") {
      calls.push({ method: "closeCase", id, outcome });
      return Promise.resolve();
    },
    runCase(id: string) {
      calls.push({ method: "runCase", id });
      return Promise.resolve();
    },
    pauseCase(id: string) {
      calls.push({ method: "pauseCase", id });
      return Promise.resolve();
    },
    resumeCase(id: string) {
      calls.push({ method: "resumeCase", id });
      return Promise.resolve();
    },
    stopCase(id: string) {
      calls.push({ method: "stopCase", id });
      return Promise.resolve();
    },
  };
  return { runtime, calls };
}

function sourceFixture(runtimes: ReturnType<typeof runtimeFixture>[]) {
  const listeners: Array<() => void> = [];
  const source = {
    systemId: () => "system",
    runtimes: () => runtimes.map((entry) => entry.runtime),
    onChange(listener: () => void) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
  };
  return { source, listeners };
}

Deno.test("OperatorCases aggregates every runtime and strips scheduling without mutating the source", () => {
  const a = runtimeFixture([
    request("a-request", 1, "alice"),
    scheduled("a-job", 2, "alice"),
  ]);
  const b = runtimeFixture([request("b-request", 1, "bob")]);
  const { source } = sourceFixture([a, b]);
  const cases = new OperatorCases(source);
  const snapshot = cases.cases;
  equal(snapshot.systemId, "system");
  deepStrictEqual(
    snapshot.cases.map((record) => record.id),
    ["a-request", "a-job", "b-request"],
  );
  for (const record of snapshot.cases) {
    equal(
      "scheduling" in record,
      false,
      `${record.id} must not expose its scheduling declaration`,
    );
  }
  deepStrictEqual(snapshot.cases[0], a.runtime.cases.cases[0]);
  const { scheduling: _stripped, ...expected } = a.runtime.cases.cases[1];
  deepStrictEqual(snapshot.cases[1], expected);
  equal(
    a.runtime.cases.cases[1].scheduling?.nextAt,
    "2026-10-28T01:00:00.000Z",
    "the source record keeps its scheduling declaration",
  );
});

Deno.test("OperatorCases routes each command to its owning runtime only", async () => {
  const a = runtimeFixture([request("a-request", 1, "alice")]);
  const b = runtimeFixture([request("b-request", 1, "bob")]);
  const { source } = sourceFixture([a, b]);
  const cases = new OperatorCases(source);
  await cases.closeCase("b-request", "done");
  await cases.runCase("a-request");
  await cases.pauseCase("a-request");
  await cases.resumeCase("b-request");
  await cases.stopCase("b-request");
  deepStrictEqual(a.calls, [
    { method: "runCase", id: "a-request" },
    { method: "pauseCase", id: "a-request" },
  ]);
  deepStrictEqual(b.calls, [
    { method: "closeCase", id: "b-request", outcome: "done" },
    { method: "resumeCase", id: "b-request" },
    { method: "stopCase", id: "b-request" },
  ]);
});

Deno.test("OperatorCases rejects unknown Cases with context and recovery before any runtime call", async () => {
  const a = runtimeFixture([request("a-request", 1, "alice")]);
  const { source } = sourceFixture([a]);
  const cases = new OperatorCases(source);
  for (
    const command of [
      () => cases.closeCase("missing", "abandoned"),
      () => cases.runCase("missing"),
      () => cases.pauseCase("missing"),
      () => cases.resumeCase("missing"),
      () => cases.stopCase("missing"),
    ]
  ) {
    let error: unknown;
    try {
      await command();
    } catch (cause) {
      error = cause;
    }
    equal((error as { code?: string }).code, "NOT_FOUND");
    deepStrictEqual((error as { context?: unknown }).context, {
      caseId: "missing",
    });
    equal(typeof (error as { recovery?: unknown }).recovery, "string");
  }
  deepStrictEqual(a.calls, []);
});

Deno.test("OperatorCases delivers the current snapshot on change until unsubscribed", () => {
  const a = runtimeFixture([request("a-request", 1, "alice")]);
  const { source } = sourceFixture([a]);
  const cases = new OperatorCases(source);
  const received: CasesSnapshot[] = [];
  const unsubscribe = cases.onChange((snapshot) => received.push(snapshot));
  source.emit();
  a.runtime.cases.cases.push(scheduled("a-job", 2, "alice"));
  source.emit();
  unsubscribe();
  source.emit();
  equal(received.length, 2);
  deepStrictEqual(
    received[0].cases.map((record) => record.id),
    ["a-request"],
  );
  deepStrictEqual(
    received[1].cases.map((record) => record.id),
    ["a-request", "a-job"],
  );
  equal("scheduling" in received[1].cases[1], false);
});
