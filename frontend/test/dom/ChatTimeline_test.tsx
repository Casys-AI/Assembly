import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { render } from "preact";
import { act } from "preact/test-utils";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { snapshot } from "../support/workbench-fixture.ts";
import { grant } from "../support/operator-fixture.ts";
import type { AgentConversation } from "../../../src/domain/work/records/conversations.ts";
import { ChatTimeline } from "../../components/conversations/ChatTimeline.tsx";

const conversation = (id: string): AgentConversation => ({
  agentId: id,
  nativeId: id,
  name: id,
  primary: id === "alpha",
  canSend: true,
  busy: false,
  revision: 7,
  modelDigest: "digest",
  responsibility: "",
  phase: "Ready",
  messages: [],
});

async function waitForVisible(
  root: HTMLElement,
  pattern: RegExp,
  diagnostic: () => unknown,
) {
  const deadline = Date.now() + 1000;
  while (!pattern.test(root.textContent ?? "") && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  match(
    root.textContent ?? "",
    pattern,
    `DOM did not reach ${pattern}; state: ${JSON.stringify(diagnostic())}`,
  );
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not occur`)),
          1000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

Deno.test("mounted Case timeline loads durable blocked status and retries the exact change", async () => {
  const { withMountedDom } = await import("../support/mounted-dom.ts");
  await withMountedDom(async (document) => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    let status = "blocked";
    const change = grant({
      id: "network/1",
      caseId: "case/C",
      requestedBy: "alpha",
      status: "approved",
      baseModelDigest: "a".repeat(64),
      requestedRights: { addNetworkHosts: ["example.org"] },
    });
    const owner = conversation("alpha");
    owner.proposalContext = {
      configurationRevision: 1,
      before: {
        network: { allowedHosts: [] },
        builder: { admissionAuthority: "human" },
      },
      changes: [change],
    };
    const state = createWorkbenchState({
      initialState: snapshot(),
      fetch: (path, init) => {
        const method = init?.method ?? "GET";
        calls.push({
          path,
          method,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (method === "POST") status = "adopted";
        if (path.includes("/changes/")) {
          return Promise.resolve(
            Response.json({
              caseId: "case/C",
              changeId: "network/1",
              status,
              canResume: status === "blocked",
            }),
          );
        }
        if (path.startsWith("/api/case-model/")) {
          const version = `commit:${"b".repeat(40)}`;
          return Promise.resolve(
            Response.json({
              caseId: "case/C",
              branchId: "branch",
              executionSpaceId: "space",
              version,
              branchVersion: version,
              executionVersion: version,
              release: null,
              readOnly: true,
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            systemId: "ui-fixture",
            defaultAgentId: "alpha",
            version: "v",
            conversations: [owner],
          }),
        );
      },
    });
    state.requests.sessionReady.value = true;
    const root = document.createElement("div");
    document.body.append(root);
    try {
      await act(async () => {
        render(
          <ChatTimeline
            state={state}
            entries={[{
              kind: "change",
              id: "change",
              at: change.requestedAt,
              change,
            }]}
            conversation={owner}
            independentRequest
            caseId="case/C"
          />,
          root,
        );
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      await waitForVisible(
        root,
        /Applying blocked/,
        () => state.caseChangeStatus("case/C", "alpha", "network/1"),
      );
      const button = [...root.querySelectorAll("button")].find((item) =>
        item.textContent?.trim() === "Retry applying"
      );
      ok(button, "The durable blocked result must expose a retry action");
      await act(async () => {
        button.click();
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });
      const writes = calls.filter((call) => call.method === "POST");
      deepStrictEqual(writes, [{
        path:
          "/api/conversations/alpha/changes/network%2F1/decision/resume?space=requests",
        method: "POST",
        body: { caseId: "case/C" },
      }]);
      await waitForVisible(
        root,
        /Adopted/,
        () => state.caseChangeStatus("case/C", "alpha", "network/1"),
      );
      equal(
        state.requests.scopes.value.get("case/C")?.executionVersion,
        `commit:${"b".repeat(40)}`,
      );
    } finally {
      await act(() => render(null, root));
      state.dispose();
      root.remove();
    }
  });
});

Deno.test("mounted refused Case reload offers continuation retry without approving", async () => {
  const { withMountedDom } = await import("../support/mounted-dom.ts");
  await withMountedDom(async (document) => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    let status = "refused-awaiting-continuation";
    const change = grant({
      id: "refused/1",
      caseId: "case/C",
      requestedBy: "alpha",
      status: "refused",
      baseModelDigest: "a".repeat(64),
      requestedRights: { addNetworkHosts: ["example.org"] },
    });
    const owner = conversation("alpha");
    owner.proposalContext = {
      configurationRevision: 1,
      before: {
        network: { allowedHosts: [] },
        builder: { admissionAuthority: "human" },
      },
      changes: [change],
    };
    const state = createWorkbenchState({
      initialState: snapshot(),
      fetch: (path, init) => {
        const method = init?.method ?? "GET";
        calls.push({
          path,
          method,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (method === "POST") status = "refused";
        if (path.includes("/changes/")) {
          return Promise.resolve(
            Response.json({
              caseId: "case/C",
              changeId: "refused/1",
              status,
              canResume: status !== "refused",
            }),
          );
        }
        if (path.startsWith("/api/case-model/")) {
          const version = `commit:${"a".repeat(40)}`;
          return Promise.resolve(
            Response.json({
              caseId: "case/C",
              branchId: "branch",
              executionSpaceId: "space",
              version,
              branchVersion: version,
              executionVersion: version,
              release: null,
              readOnly: true,
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            systemId: "ui-fixture",
            defaultAgentId: "alpha",
            version: "v",
            conversations: [owner],
          }),
        );
      },
    });
    state.requests.sessionReady.value = true;
    const root = document.createElement("div");
    document.body.append(root);
    try {
      await act(async () => {
        render(
          <ChatTimeline
            state={state}
            entries={[{
              kind: "change",
              id: "change",
              at: change.requestedAt,
              change,
            }]}
            conversation={owner}
            independentRequest
            caseId="case/C"
          />,
          root,
        );
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      await waitForVisible(
        root,
        /Refused; continuation pending/,
        () => state.caseChangeStatus("case/C", "alpha", "refused/1"),
      );
      const button = [...root.querySelectorAll("button")].find((item) =>
        item.textContent?.trim() === "Retry continuation"
      );
      ok(button);
      await act(async () => {
        button.click();
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });
      deepStrictEqual(calls.filter((call) => call.method === "POST"), [{
        path:
          "/api/conversations/alpha/changes/refused%2F1/decision/resume?space=requests",
        method: "POST",
        body: { caseId: "case/C" },
      }]);
      await waitForVisible(
        root,
        /Refused; continuation accepted/,
        () => state.caseChangeStatus("case/C", "alpha", "refused/1"),
      );
      equal(
        [...root.querySelectorAll("button")].some((item) =>
          item.textContent?.trim() === "Retry continuation"
        ),
        false,
      );
    } finally {
      await act(() => render(null, root));
      state.dispose();
      root.remove();
    }
  });
});

Deno.test("mounted Case status reloads when the initial system identity arrives", async () => {
  const { withMountedDom } = await import("../support/mounted-dom.ts");
  await withMountedDom(async (document) => {
    let resolveFirst!: (response: Response) => void;
    let notifyFirst!: () => void;
    let notifySecond!: () => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirst = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      notifySecond = resolve;
    });
    let reads = 0;
    const change = grant({
      id: "network",
      caseId: "case/C",
      requestedBy: "alpha",
      status: "approved",
      baseModelDigest: "a".repeat(64),
      requestedRights: { addNetworkHosts: ["example.org"] },
    });
    const owner = conversation("alpha");
    owner.proposalContext = {
      configurationRevision: 1,
      before: {
        network: { allowedHosts: [] },
        builder: { admissionAuthority: "human" },
      },
      changes: [change],
    };
    const state = createWorkbenchState({
      initialState: null,
      fetch: () => {
        reads++;
        if (reads === 1) {
          notifyFirst();
          return first;
        }
        notifySecond();
        return Promise.resolve(
          Response.json({
            caseId: "case/C",
            changeId: "network",
            status: "adopted",
            canResume: false,
          }),
        );
      },
    });
    state.requests.sessionReady.value = true;
    const root = document.createElement("div");
    document.body.append(root);
    try {
      await act(() => {
        render(
          <ChatTimeline
            state={state}
            entries={[{
              kind: "change",
              id: "change",
              at: change.requestedAt,
              change,
            }]}
            conversation={owner}
            independentRequest
            caseId="case/C"
          />,
          root,
        );
      });
      await within(firstStarted, "Initial status read");
      await act(() => {
        state.current.value = snapshot();
      });
      await within(secondStarted, "Status reread after system identity");
      await act(async () => {
        resolveFirst(
          Response.json({
            caseId: "case/C",
            changeId: "network",
            status: "blocked",
            canResume: true,
          }),
        );
        await first;
      });
      await waitForVisible(
        root,
        /Adopted/,
        () => state.caseChangeStatus("case/C", "alpha", "network"),
      );
      equal(reads, 2);
      equal(
        state.caseChangeStatus("case/C", "alpha", "network")?.status,
        "adopted",
      );
    } finally {
      await act(() => render(null, root));
      state.dispose();
      root.remove();
    }
  });
});
