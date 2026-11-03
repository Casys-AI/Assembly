import { replaceGlobals } from "../../test/support/globals.ts";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
} from "node:assert/strict";
import { act } from "preact/test-utils";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { renderToString } from "preact-render-to-string";
import { CaseModelStatus, useCaseModelScope } from "./CaseModelBoundary.tsx";
import { createModelLive } from "../../lib/model/live.ts";

const version = `commit:${"a".repeat(40)}`;
const response = (caseId: string) =>
  Response.json({
    caseId,
    branchId: `branch-${caseId}`,
    executionSpaceId: `space-${caseId}`,
    branchVersion: version,
    executionVersion: version,
    version,
    release: null,
    readOnly: true,
  });
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

Deno.test("Case scope resolution and refusal never fall back to a global model", async () => {
  const root = probeRoot();
  const requests: string[] = [];
  let finishFirst!: (response: Response) => void;
  const first = new Promise<Response>((resolve) => {
    finishFirst = resolve;
  });
  const restoreFetch = replaceGlobals({
    fetch: ((input: RequestInfo | URL) => {
      const path = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      requests.push(path);
      if (path.includes("case-one")) return first;
      if (path.includes("case-two")) {
        return Promise.resolve(response("case-two"));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch,
  });
  let result!: ReturnType<typeof useCaseModelScope>;
  const status = () => result.status;
  function Probe({ caseId }: { caseId: string }) {
    result = useCaseModelScope(caseId);
    return null;
  }
  try {
    await root.show(Probe, { caseId: "case-one" });
    equal(status(), "loading");
    await root.show(Probe, { caseId: "case-two" });
    await settle();
    equal(status(), "ready");
    if (result.status === "ready") equal(result.scope.caseId, "case-two");
    finishFirst(response("case-one"));
    await settle();
    equal(status(), "ready");
    if (result.status === "ready") equal(result.scope.caseId, "case-two");
    await root.show(Probe, { caseId: "missing" });
    await settle();
    equal(status(), "unavailable");
    deepStrictEqual(requests, [
      "/api/case-model/case-one",
      "/api/case-model/case-two",
      "/api/case-model/missing",
    ]);
  } finally {
    restoreFetch();
    await root.restore();
  }
});

Deno.test("reconnected session resolves the selected exact Request version and cannot revive an older selection", async () => {
  const root = probeRoot();
  const requests: string[] = [];
  const newerVersion = `commit:${"b".repeat(40)}`;
  let callsA = 0;
  let finishLate!: (value: Response) => void;
  const late = new Promise<Response>((resolve) => {
    finishLate = resolve;
  });
  const scope = (caseId: string, pin: string) =>
    Response.json({
      caseId,
      branchId: `branch-${caseId}`,
      executionSpaceId: `space-${caseId}`,
      branchVersion: pin,
      executionVersion: pin,
      version: pin,
      release: null,
      readOnly: true,
    });
  const restoreFetch = replaceGlobals({
    fetch: ((input: RequestInfo | URL) => {
      const path = String(input);
      requests.push(path);
      if (path.includes("case-one")) {
        callsA++;
        return callsA === 1
          ? Promise.resolve(new Response(null, { status: 403 }))
          : callsA === 2
          ? Promise.resolve(scope("case-one", version))
          : late;
      }
      return Promise.resolve(scope("case-two", newerVersion));
    }) as typeof fetch,
  });
  let result!: ReturnType<typeof useCaseModelScope>;
  const status = () => result.status;
  function Probe(
    props: { caseId: string; version: string; sessionReady: boolean },
  ) {
    result = useCaseModelScope(props.caseId, props.version, props.sessionReady);
    return null;
  }
  try {
    await root.show(Probe, {
      caseId: "case-one",
      version,
      sessionReady: false,
    });
    await settle();
    equal(status(), "unavailable");
    await root.show(Probe, { caseId: "case-one", version, sessionReady: true });
    await settle();
    equal(status(), "ready");
    if (result.status === "ready") {
      deepStrictEqual([result.scope.caseId, result.scope.version], [
        "case-one",
        version,
      ]);
    }
    await root.show(Probe, {
      caseId: "case-one",
      version,
      sessionReady: false,
    });
    await root.show(Probe, {
      caseId: "case-two",
      version: newerVersion,
      sessionReady: true,
    });
    await settle();
    equal(status(), "ready");
    finishLate(scope("case-one", version));
    await settle();
    equal(status(), "ready");
    if (result.status === "ready") {
      deepStrictEqual([result.scope.caseId, result.scope.version], [
        "case-two",
        newerVersion,
      ]);
    }
    deepStrictEqual(requests, [
      `/api/case-model/case-one?version=${encodeURIComponent(version)}`,
      `/api/case-model/case-one?version=${encodeURIComponent(version)}`,
      `/api/case-model/case-one?version=${encodeURIComponent(version)}`,
      `/api/case-model/case-two?version=${encodeURIComponent(newerVersion)}`,
    ]);
  } finally {
    restoreFetch();
    await root.restore();
  }
});

Deno.test("a Case's own word on its model resolves its scope again in place, keeping the one shown until the answer", async () => {
  const root = probeRoot();
  const before = globalThis.fetch;
  const adopted = `commit:${"b".repeat(40)}`;
  const runs = { current: version };
  let release!: () => void;
  let hold: Promise<void> | undefined;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    await hold;
    return Response.json({
      caseId: "case-one",
      branchId: "branch-case-one",
      executionSpaceId: "space-case-one",
      branchVersion: runs.current,
      executionVersion: runs.current,
      version: runs.current,
      release: null,
      readOnly: true,
    });
  }) as typeof fetch;
  const live = createModelLive();
  let result!: ReturnType<typeof useCaseModelScope>;
  function Probe() {
    result = useCaseModelScope("case-one", undefined, false, 0, live);
    return null;
  }
  const running = () =>
    result.status === "ready" ? result.scope.executionVersion : result.status;
  try {
    await root.show(Probe, {});
    await settle();
    equal(running(), version);
    runs.current = adopted;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await act(() => {
      live.accept(JSON.stringify({ head: adopted, branchVersion: adopted }));
    });
    await settle();
    equal(running(), version, "the scope shown stays while it is read again");
    release();
    await settle();
    equal(running(), adopted);
    deepStrictEqual(requests, [
      "/api/case-model/case-one",
      "/api/case-model/case-one",
    ]);
  } finally {
    globalThis.fetch = before;
    await root.restore();
  }
});

Deno.test("Request status separates admitted head from current execution and explicit inspection", () => {
  const head = `commit:${"b".repeat(40)}`;
  const scope = {
    caseId: "case-one",
    branchId: "branch-one",
    executionSpaceId: "space-one",
    branchVersion: head,
    executionVersion: version,
    version,
    release: null,
    readOnly: true as const,
  };
  const current = renderToString(<CaseModelStatus scope={scope} />);
  match(current, /The admitted source differs from the running version/);
  doesNotMatch(current, /The inspected version differs/);
  const inspected = renderToString(
    <CaseModelStatus scope={{ ...scope, version: head }} />,
  );
  match(inspected, /The inspected version differs from the running version/);
  match(inspected, /The admitted source differs from the running version/);
  const aligned = renderToString(
    <CaseModelStatus scope={{ ...scope, branchVersion: version }} />,
  );
  equal(aligned, "");
});

Deno.test("Request boundary flags divergence without exposing branch IDs or full pins", () => {
  const birth = `commit:${"1".repeat(40)}`,
    adopted = `commit:${"2".repeat(40)}`,
    source = `commit:${"3".repeat(40)}`;
  const html = renderToString(
    <CaseModelStatus
      scope={{
        caseId: "request",
        branchId: "branch",
        executionSpaceId: "space",
        baseVersion: birth,
        branchVersion: source,
        executionVersion: adopted,
        version: birth,
        readOnly: true,
        release: null,
      }}
    />,
  );
  match(html, /The inspected version differs from the running version/);
  match(html, /The admitted source differs from the running version/);
  doesNotMatch(html, /branch|commit:/);
});
