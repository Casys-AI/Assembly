import { equal } from "node:assert/strict";
import { createPerformanceStore } from "./store.ts";
import { PerformanceReadError } from "./api.ts";
import {
  PERFORMANCE_VERSION,
  performanceReadout,
} from "../../../test/support/performance-fixture.ts";

Deno.test("performance store drops late Main/Case/version answers and immediately clears the old totals", async () => {
  const a = Promise.withResolvers<ReturnType<typeof performanceReadout>>();
  const b = Promise.withResolvers<ReturnType<typeof performanceReadout>>();
  const signals: AbortSignal[] = [];
  let calls = 0;
  const store = createPerformanceStore({
    api: {
      read(_selection, signal) {
        signals.push(signal!);
        return calls++ === 0 ? a.promise : b.promise;
      },
    },
  });
  const main = store.open({ expectedVersion: PERFORMANCE_VERSION });
  const selected = {
    expectedVersion: `commit:${"c".repeat(40)}`,
    caseId: "caseB",
  };
  const branch = store.open(selected);
  equal(signals[0].aborted, true);
  equal(store.state.peek().status, "loading");
  equal(store.state.peek().readout, undefined);
  b.resolve(performanceReadout(selected));
  await branch;
  a.resolve(performanceReadout());
  await main;
  equal(store.state.peek().readout?.execution.caseId, "caseB");
  equal(
    store.state.peek().readout?.execution.modelVersion.repositoryVersion,
    selected.expectedVersion,
  );
  store.dispose();
});

Deno.test("performance store shares a same-selection read and reconnects without a Main fallback", async () => {
  let calls = 0;
  const selected = { expectedVersion: PERFORMANCE_VERSION, caseId: "caseA" };
  const store = createPerformanceStore({
    api: {
      read(selection) {
        return new Promise<ReturnType<typeof performanceReadout>>((resolve) => {
          calls++;
          if (calls === 1) {
            throw new PerformanceReadError("connection-required");
          }
          equal(selection.caseId, "caseA");
          resolve(performanceReadout(selection));
        });
      },
    },
  });
  await store.open(selected);
  equal(store.state.peek().status, "connection-required");
  await store.open(selected);
  equal(calls, 1);
  await store.open(selected, true);
  equal(calls, 2);
  equal(store.state.peek().status, "ready");
  await store.open(selected, true);
  equal(calls, 2);
  await store.open(undefined);
  equal(store.state.peek().readout, undefined);
  store.dispose();
});

Deno.test("performance store ignores resolution after dispose and never retains totals on a version refusal", async () => {
  const gate = Promise.withResolvers<ReturnType<typeof performanceReadout>>();
  const store = createPerformanceStore({ api: { read: () => gate.promise } });
  const pending = store.open({ expectedVersion: PERFORMANCE_VERSION });
  store.dispose();
  gate.resolve(performanceReadout());
  await pending;
  equal(store.state.peek().readout, undefined);
  const failed = createPerformanceStore({
    api: {
      read() {
        return Promise.reject(new PerformanceReadError("version-unavailable"));
      },
    },
  });
  await failed.open({ expectedVersion: PERFORMANCE_VERSION });
  equal(failed.state.peek().status, "version-unavailable");
  equal(failed.state.peek().readout, undefined);
  failed.dispose();
});

Deno.test("performance invalidations during a read coalesce to one authorized follow-up", async () => {
  const first = Promise.withResolvers<ReturnType<typeof performanceReadout>>();
  const second = Promise.withResolvers<ReturnType<typeof performanceReadout>>();
  let calls = 0;
  const selection = { expectedVersion: PERFORMANCE_VERSION, caseId: "caseA" };
  const store = createPerformanceStore({
    api: {
      read(selected) {
        equal(selected.caseId, "caseA");
        return ++calls === 1 ? first.promise : second.promise;
      },
    },
  });
  const initial = store.open(selection, true, 1);
  const dirty = store.open(selection, true, 2);
  void store.open(selection, true, 3);
  void store.open(selection, true, 4);
  equal(calls, 1);
  first.resolve(performanceReadout(selection));
  await Promise.resolve();
  equal(calls, 2);
  second.resolve(performanceReadout(selection));
  await Promise.all([initial, dirty]);
  equal(calls, 2);
  await store.open(selection, true, 4);
  equal(calls, 2);
  store.dispose();
});

Deno.test("new generation retries unavailable same-key reads and reactivation rereads", async () => {
  let calls = 0;
  const selection = { expectedVersion: PERFORMANCE_VERSION, caseId: "caseA" };
  const store = createPerformanceStore({
    api: {
      read(selected) {
        calls++;
        return calls === 1
          ? Promise.reject(new PerformanceReadError("connection-required"))
          : Promise.resolve(performanceReadout(selected));
      },
    },
  });
  await store.open(selection, true, 1);
  equal(store.state.peek().status, "connection-required");
  await store.open(selection, true, 2);
  equal(store.state.peek().status, "ready");
  equal(calls, 2);
  await store.open(undefined, true, 3);
  equal(calls, 2);
  await store.open(selection, true, 3);
  equal(calls, 3);
  store.dispose();
});

Deno.test("selection and session changes retire dirty flights without replaying old scope", async () => {
  const old = Promise.withResolvers<ReturnType<typeof performanceReadout>>();
  const current = Promise.withResolvers<
    ReturnType<typeof performanceReadout>
  >();
  const seen: string[] = [];
  const signals: AbortSignal[] = [];
  const store = createPerformanceStore({
    api: {
      read(selected, signal) {
        seen.push(selected.caseId ?? "main");
        signals.push(signal!);
        return seen.length === 1 ? old.promise : current.promise;
      },
    },
  });
  const a = { expectedVersion: PERFORMANCE_VERSION, caseId: "caseA" };
  const b = { expectedVersion: PERFORMANCE_VERSION, caseId: "caseB" };
  const first = store.open(a, true, 1);
  void store.open(a, true, 2);
  const next = store.open(b, false, 2);
  equal(signals[0].aborted, true);
  current.resolve(performanceReadout(b));
  await next;
  old.resolve(performanceReadout(a));
  await first;
  equal(seen.join(","), "caseA,caseB");
  equal(store.state.peek().readout?.execution.caseId, "caseB");
  store.dispose();
});

Deno.test("session replacement retires a queued old-session refresh at the same exact source", async () => {
  const old = Promise.withResolvers<ReturnType<typeof performanceReadout>>();
  let calls = 0;
  const signals: AbortSignal[] = [];
  const selection = { expectedVersion: PERFORMANCE_VERSION, caseId: "caseA" };
  const store = createPerformanceStore({
    api: {
      read(selected, signal) {
        signals.push(signal!);
        return ++calls === 1
          ? old.promise
          : Promise.resolve(performanceReadout(selected));
      },
    },
  });
  const first = store.open(selection, false, 1);
  void store.open(selection, false, 2);
  await store.open(selection, true, 2);
  equal(signals[0].aborted, true);
  old.resolve(performanceReadout(selection));
  await first;
  equal(calls, 2);
  equal(store.state.peek().status, "ready");
  store.dispose();
});

Deno.test("true-to-true credential replacement retires the old read and its dirty follow-up", async () => {
  const old = Promise.withResolvers<ReturnType<typeof performanceReadout>>();
  const signals: AbortSignal[] = [];
  let calls = 0;
  const selected = { expectedVersion: PERFORMANCE_VERSION, caseId: "caseA" };
  const store = createPerformanceStore({
    api: {
      read(selection, signal) {
        signals.push(signal!);
        return ++calls === 1
          ? old.promise
          : Promise.resolve(performanceReadout(selection, 7));
      },
    },
  });
  const first = store.open(selected, true, 1, 10);
  void store.open(selected, true, 2, 10);
  await store.open(selected, true, 2, 11);
  equal(signals[0].aborted, true);
  old.resolve(performanceReadout(selected, 1));
  await first;
  equal(calls, 2);
  equal(store.state.peek().readout?.resources.calls, 7);
  store.dispose();
});

Deno.test("a rejected dirty follow-up releases its flight and a later generation retries", async () => {
  const first = Promise.withResolvers<ReturnType<typeof performanceReadout>>();
  let calls = 0;
  const selection = { expectedVersion: PERFORMANCE_VERSION };
  const store = createPerformanceStore({
    api: {
      read(selected) {
        calls++;
        if (calls === 1) return first.promise;
        if (calls === 2) {
          return Promise.reject(new PerformanceReadError("unavailable"));
        }
        return Promise.resolve(performanceReadout(selected, 5));
      },
    },
  });
  const pending = store.open(selection, true, 1);
  void store.open(selection, true, 2);
  first.resolve(performanceReadout(selection));
  await pending;
  equal(calls, 2);
  equal(store.state.peek().status, "unavailable");
  await store.open(selection, true, 3);
  equal(calls, 3);
  equal(store.state.peek().readout?.resources.calls, 5);
  store.dispose();
});
