import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { act } from "preact/test-utils";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { createModelLive } from "../../lib/model/live.ts";
import {
  loadingDiagnostics,
  type SystemDiagnosticsRead,
} from "../../lib/system/diagnostics.ts";
import {
  type DiagnosticsApi,
  useSystemDiagnostics,
} from "./useSystemDiagnostics.ts";

const A = `commit:${"a".repeat(40)}`;
const B = `commit:${"b".repeat(40)}`;
const result = (message: string): SystemDiagnosticsRead => ({
  doctor: { status: "unavailable", message },
  shapes: { status: "unsupported", message: "unsupported" },
  attention: { status: "error", message: "unreadable" },
});
Deno.test("diagnostic hook keeps same-selection findings during refresh and retires late scope/session results", async () => {
  const root = probeRoot();
  const requests: Array<
    {
      version: string;
      signal?: AbortSignal;
      update?: (read: SystemDiagnosticsRead) => void;
      pending: ReturnType<typeof Promise.withResolvers<SystemDiagnosticsRead>>;
    }
  > = [];
  const api: DiagnosticsApi = {
    read: (version, signal, update) => {
      const pending = Promise.withResolvers<SystemDiagnosticsRead>();
      requests.push({ version, signal, update, pending });
      return pending.promise;
    },
  };
  let state!: ReturnType<typeof useSystemDiagnostics>;
  function Probe(
    props: {
      version: string;
      caseId?: string;
      session: number;
      refresh: number;
    },
  ) {
    state = useSystemDiagnostics({
      active: true,
      version: props.version,
      caseId: props.caseId,
      sessionReady: true,
      sessionGeneration: props.session,
      refreshGeneration: props.refresh,
      api,
    });
    return null;
  }
  try {
    await root.show(Probe, {
      version: A,
      caseId: "caseA",
      session: 1,
      refresh: 0,
    });
    equal(requests[0].version, A);
    deepStrictEqual(state.read, loadingDiagnostics());
    const partial = { ...loadingDiagnostics(), doctor: result("A").doctor };
    await act(() => requests[0].update!(partial));
    equal(state.read.doctor.status, "unavailable");
    equal(state.read.shapes.status, "loading");
    await act(async () => {
      requests[0].pending.resolve(result("A"));
      await requests[0].pending.promise;
    });
    deepStrictEqual(state.read, result("A"));
    await root.show(Probe, {
      version: A,
      caseId: "caseA",
      session: 1,
      refresh: 1,
    });
    equal(state.refreshing, true);
    deepStrictEqual(state.read, result("A"));
    await act(() =>
      requests[1].update!({
        ...loadingDiagnostics(),
        doctor: result("A updated").doctor,
      })
    );
    equal(state.read.doctor.status, "unavailable");
    equal(state.read.shapes.status, "unsupported");
    await root.show(Probe, {
      version: B,
      caseId: "caseB",
      session: 1,
      refresh: 1,
    });
    ok(requests[1].signal?.aborted);
    deepStrictEqual(state.read, loadingDiagnostics());
    await act(async () => {
      requests[1].update!(result("stale"));
      requests[1].pending.resolve(result("stale"));
      await requests[1].pending.promise;
    });
    deepStrictEqual(state.read, loadingDiagnostics());
    await act(async () => {
      requests[2].pending.resolve(result("B"));
      await requests[2].pending.promise;
    });
    deepStrictEqual(state.read, result("B"));
    await root.show(Probe, {
      version: B,
      caseId: "caseB",
      session: 2,
      refresh: 1,
    });
    deepStrictEqual(state.read, loadingDiagnostics());
    equal(requests.length, 4);
  } finally {
    await root.restore();
  }
});

Deno.test("same-selection refresh rejects mixed Doctor and SHACL source identities until the new pair agrees", async () => {
  const root = probeRoot();
  const pending: Array<
    {
      update: (read: SystemDiagnosticsRead) => void;
      result: ReturnType<typeof Promise.withResolvers<SystemDiagnosticsRead>>;
    }
  > = [];
  const api: DiagnosticsApi = {
    read: (_version, _signal, update) => {
      const result = Promise.withResolvers<SystemDiagnosticsRead>();
      pending.push({ update: update!, result });
      return result.promise;
    },
  };
  const reports = (digest: string): SystemDiagnosticsRead => ({
    doctor: {
      status: "ready",
      value: { version: A, sourceDigest: digest, diagnostics: [] },
    },
    shapes: {
      status: "ready",
      value: {
        version: A,
        report: {
          build: {
            repositoryId: "repo",
            sourceDigest: digest,
            recipeDigest: "c".repeat(64),
            buildKey: "d".repeat(64),
            artifactDigest: "e".repeat(64),
          },
          identity: {
            artifactDigest: "e".repeat(64),
            shapesDigest: "f".repeat(64),
            optionsDigest: "1".repeat(64),
            factsProjectorVersion: "1",
            engineId: "engine",
            engineVersion: "1",
          },
          conforms: true,
          diagnostics: [],
          unmappedResults: 0,
        },
      },
    },
    attention: { status: "unavailable", message: "unavailable" },
  });
  let state!: ReturnType<typeof useSystemDiagnostics>;
  function Probe(props: { refresh: number }) {
    state = useSystemDiagnostics({
      active: true,
      version: A,
      sessionReady: true,
      refreshGeneration: props.refresh,
      api,
    });
    return null;
  }
  const current = () => state.read;
  try {
    await root.show(Probe, { refresh: 0 });
    const old = reports("a".repeat(64));
    await act(async () => {
      pending[0].result.resolve(old);
      await pending[0].result.promise;
    });
    equal(current().shapes.status, "ready");
    await root.show(Probe, { refresh: 1 });
    const next = reports("b".repeat(64));
    await act(() =>
      pending[1].update({ ...loadingDiagnostics(), shapes: next.shapes })
    );
    equal(current().doctor.status, "ready");
    equal(current().shapes.status, "error");
    const mismatch = current().shapes;
    if (mismatch.status === "error") {
      equal(mismatch.code, "DIAGNOSTICS_SOURCE_MISMATCH");
    }
    await act(() => pending[1].update(next));
    equal(current().shapes.status, "ready");
  } finally {
    await root.restore();
  }
});

Deno.test("diagnostics are read again in place when the model's head is announced again, and not for another head", async () => {
  const root = probeRoot();
  const reads: string[] = [];
  const api: DiagnosticsApi = {
    read: (version) => {
      reads.push(version);
      return Promise.resolve(result(`${version} #${reads.length}`));
    },
  };
  const live = createModelLive();
  let state!: ReturnType<typeof useSystemDiagnostics>;
  function Probe() {
    state = useSystemDiagnostics({
      active: true,
      version: A,
      sessionReady: true,
      api,
      live,
    });
    return null;
  }
  try {
    await root.show(Probe, {});
    await act(async () => {
      await Promise.resolve();
    });
    deepStrictEqual(reads, [A]);
    // A mask changed elsewhere: the host announces the same head again.
    await act(async () => {
      live.accept(JSON.stringify({ head: A, attention: { count: 2 } }));
      await Promise.resolve();
    });
    deepStrictEqual(reads, [A, A]);
    equal(state.read.doctor.status, "unavailable");
    // Another head moves the board first; the version read follows it.
    await act(async () => {
      live.accept(JSON.stringify({ head: B }));
      await Promise.resolve();
    });
    deepStrictEqual(reads, [A, A]);
  } finally {
    await root.restore();
  }
});
