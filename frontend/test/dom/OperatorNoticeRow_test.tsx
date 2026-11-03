import { deepStrictEqual, equal, match } from "node:assert/strict";
import { render } from "preact";
import { act } from "preact/test-utils";
import type { Message } from "../../../src/domain/work/dialogue.ts";
import type { ConversationsSnapshot } from "../../../src/domain/work/records/conversations.ts";
import { OperatorNoticeRow } from "../../components/conversations/OperatorNoticeRow.tsx";
import { branchOperatorName } from "../../lib/cases/operator-names.ts";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { caseRecord } from "../support/case-fixture.ts";
import { grant, operatorRoster } from "../support/operator-fixture.ts";
import { snapshot } from "../support/workbench-fixture.ts";

const REQUEST = "ui-fixture:case:2";
const notice = {
  kind: "authority-escalation",
  changeId: "grant",
  requestedBy: "native:research",
  caseId: REQUEST,
  recipient: "native:designer",
  decisionAuthority: "human",
  reason: "Read example.org",
} as NonNullable<Message["operatorNotice"]>;

async function waitForVisible(root: HTMLElement, pattern: RegExp) {
  const deadline = Date.now() + 1000;
  while (!pattern.test(root.textContent ?? "") && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  match(root.textContent ?? "", pattern);
}

Deno.test("a notice of a Request nobody opened yet reads its conversation, then says its change was declined", async () => {
  const { withMountedDom } = await import("../support/mounted-dom.ts");
  await withMountedDom(async (document) => {
    const paths: string[] = [];
    const branch = operatorRoster([], [
      grant({
        id: "grant",
        status: "refused",
        requestedBy: "native:research",
        caseId: REQUEST,
      }),
    ]);
    const answer: ConversationsSnapshot = {
      ...branch,
      conversations: [branch.conversations[1]],
      defaultAgentId: "research",
    };
    const state = createWorkbenchState({
      initialState: snapshot(),
      fetch: (path) => {
        paths.push(path);
        return Promise.resolve(Response.json(answer));
      },
    });
    const record = caseRecord(2, { owner: "native:research" });
    state.requests.cases.accept({ systemId: "ui-fixture", cases: [record] });
    state.requests.sessionReady.value = true;
    const name = branchOperatorName(state.requests.cases.byId(REQUEST)!);
    const root = document.createElement("div");
    document.body.append(root);
    try {
      await act(() => {
        render(<OperatorNoticeRow notice={notice} state={state} />, root);
      });
      // Before the answer, the Branch Operator is named and nothing is decided.
      match(root.textContent ?? "", new RegExp(`^\\s*${name} asks`));
      await waitForVisible(root, /Declined/);
      deepStrictEqual(paths, [
        `/api/conversations?${new URLSearchParams({ caseId: REQUEST })}`,
      ]);
      equal(state.requests.snapshots.value.has(REQUEST), true);
    } finally {
      await act(() => render(null, root));
      state.dispose();
      root.remove();
    }
  });
});

Deno.test("a notice of a Request already read does not read it again, nor does one without a session", async () => {
  const { withMountedDom } = await import("../support/mounted-dom.ts");
  await withMountedDom(async (document) => {
    const paths: string[] = [];
    const state = createWorkbenchState({
      initialState: snapshot(),
      fetch: (path) => {
        paths.push(path);
        return Promise.reject(new Error("unexpected read"));
      },
    });
    state.requests.cases.accept({
      systemId: "ui-fixture",
      cases: [caseRecord(2, { owner: "native:research" })],
    });
    const root = document.createElement("div");
    document.body.append(root);
    try {
      // No Request session: nothing to read with.
      await act(() => {
        render(<OperatorNoticeRow notice={notice} state={state} />, root);
      });
      deepStrictEqual(paths, []);
      // A Request whose conversation is held asks nothing more.
      const roster = operatorRoster();
      await act(() => {
        state.requests.snapshots.value = new Map([[REQUEST, {
          ...roster,
          conversations: [roster.conversations[1]],
          defaultAgentId: "research",
        }]]);
        state.requests.sessionReady.value = true;
      });
      deepStrictEqual(paths, []);
    } finally {
      await act(() => render(null, root));
      state.dispose();
      root.remove();
    }
  });
});
