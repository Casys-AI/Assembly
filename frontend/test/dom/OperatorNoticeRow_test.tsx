import realDecisions from "../support/relayed-decisions.json" with {
  type: "json",
};
import { parseConversationsSnapshot } from "../../lib/conversations/state.ts";
import { parseCasesSnapshot } from "../../lib/cases/cases.ts";
import { withMountedDom } from "../support/mounted-dom.ts";
import { settle } from "../support/settle.ts";
import { textOf, within } from "../support/dom.ts";
import {
  chatEntries,
  ChatTimeline,
} from "../../components/conversations/ChatTimeline.tsx";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import { render } from "preact";
import { act } from "preact/test-utils";
import type { Message } from "../../../src/application/work/runtime/state.ts";
import type { ConversationsSnapshot } from "../../../src/application/work/operators/conversation-types.ts";
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

Deno.test("an unrelayed branch notice reads the application record even when its change has a published commit", async () => {
  const { withMountedDom } = await import("../support/mounted-dom.ts");
  for (
    const [verdict, application, label] of [
      ["refused", "refused", /Declined/],
      ["approved", "published-awaiting-adoption", /Applying/],
    ] as const
  ) {
    await withMountedDom(async (document) => {
      const paths: string[] = [];
      const branch = operatorRoster([], [
        grant({
          id: "grant",
          status: verdict,
          ...(verdict === "approved"
            ? { publishedCommit: `commit:${"f".repeat(40)}` }
            : {}),
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
          return Promise.resolve(
            Response.json(
              path.includes("/changes/")
                ? {
                  caseId: REQUEST,
                  changeId: "grant",
                  status: application,
                  canResume: false,
                }
                : answer,
            ),
          );
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
        await waitForVisible(root, label);
        doesNotMatch(textOf(root), /Applied|Human decision requested/);
        deepStrictEqual(paths, [
          `/api/conversations?${new URLSearchParams({ caseId: REQUEST })}`,
          `/api/conversations/research/changes/grant/decision?space=requests&caseId=${
            encodeURIComponent(REQUEST)
          }`,
        ]);
        equal(state.requests.snapshots.value.has(REQUEST), true);
      } finally {
        await act(() => render(null, root));
        state.dispose();
        root.remove();
      }
    });
  }
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

// Captured from backend 4433, demo-rehearsal-5, 3 November 2026. The JSON
// keeps both notifications and their bound receipts; unrelated messages and
// source metadata are omitted, and source patches stop after twelve lines.
Deno.test("real relayed decisions read their Request again after a session change and fold on Applied in Main", async () => {
  await withMountedDom(async (document) => {
    const current = snapshot();
    current.id = realDecisions.main.systemId;
    current.candidates = [];
    const first = Promise.withResolvers<Response>();
    const requestId = realDecisions.cases.cases[0].id;
    const owner = realDecisions.request.defaultAgentId;
    const requestPath = `/api/conversations?caseId=${requestId}`;
    const reads: string[] = [];
    const state = createWorkbenchState({
      initialState: current,
      fetch: (path) => {
        reads.push(path);
        if (path === requestPath) {
          return reads.filter((p) => p === path).length === 1
            ? first.promise
            : Promise.resolve(Response.json(realDecisions.request));
        }
        const decision = realDecisions.decisions.find((item) =>
          path ===
            `/api/conversations/${owner}/changes/${item.changeId}/decision?space=requests&caseId=${requestId}`
        );
        ok(decision, `Unexpected read: ${path}`);
        return Promise.resolve(Response.json(decision));
      },
    });
    state.agentConversations.accept(
      parseConversationsSnapshot(realDecisions.main),
    );
    state.cases.accept(parseCasesSnapshot(realDecisions.cases));
    state.requests.cases.accept(parseCasesSnapshot(realDecisions.cases));
    state.requests.sessionReady.value = true;
    const root = document.createElement("div");
    document.body.append(root);
    const main = state.conversationSnapshot.value!.conversations[0];
    try {
      await act(() =>
        render(
          <ChatTimeline
            state={state}
            entries={chatEntries(state, main)}
            conversation={main}
          />,
          root,
        )
      );
      const lines = within(root).allByRole("link");
      equal(lines.length, 2);
      for (const line of lines) {
        equal(line.getAttribute("href"), `/cases?case=${requestId}`);
      }
      doesNotMatch(
        textOf(root),
        /Human decision requested|Human …|Route recorded/,
      );
      // The first read arrives after the session moved on. No manual Request
      // seeding or decision load: mounted cards must start both decision GETs.
      await act(async () => {
        state.requests.sessionGeneration.value++;
        first.resolve(Response.json(realDecisions.request));
        await settle();
      });
      await act(() => settle());
      equal(reads.filter((path) => path === requestPath).length, 2);
      equal(reads.filter((path) => path.includes("/decision?")).length, 2);
      equal(root.querySelectorAll(".notice-line").length, 0);
      for (
        const title of ["Grant team creation rights", "Relecteur d'accroches"]
      ) {
        const card = within(root).byRole("article", { name: title });
        const receipt = card.querySelector("details")!;
        equal(receipt.open, false);
        match(textOf(receipt.querySelector("summary")!), /Applied$/);
        match(textOf(card), /Decided by you · rule owner · rev\. 1/);
        equal(within(card).queryByRole("button", { name: "Accept" }), null);
      }
    } finally {
      await act(() => render(null, root));
      state.dispose();
    }
  });
});
