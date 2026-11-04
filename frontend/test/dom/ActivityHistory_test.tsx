import { equal, match } from "node:assert/strict";
import { render } from "preact";
import { act } from "preact/test-utils";
import { withMountedDom } from "../support/mounted-dom.ts";
import { settle } from "../support/settle.ts";
import { snapshot } from "../support/workbench-fixture.ts";
import { grant } from "../support/operator-fixture.ts";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { ActivityHistory } from "../../components/decide/ActivityHistory.tsx";
import type { ActivityEvent } from "../../lib/decide/activity.ts";

Deno.test("Activity shows 30 events at a time; Read again alone retries a mounted decision's failed status", async () => {
  await withMountedDom(async (document) => {
    const root = document.createElement("div");
    document.body.append(root);
    let reads = 0, available = false, refreshes = 0;
    const change = grant({
      status: "approved",
      decidedAt: "2026-11-04T00:00:00Z",
    });
    const state = createWorkbenchState({
      initialState: snapshot(),
      fetch: () => {
        reads++;
        return Promise.resolve(
          available
            ? Response.json({
              caseId: "request",
              changeId: change.id,
              status: "adopted",
              canResume: false,
            })
            : Response.json({ error: "Unavailable" }, { status: 503 }),
        );
      },
    });
    state.requests.sessionReady.value = true;
    const events: ActivityEvent[] = Array.from(
      { length: 31 },
      (_, i) => ({
        id: String(i),
        kind: "request-opened",
        at: change.decidedAt!,
        title: `Event ${i}`,
        href: "/cases",
        facts: [],
      }),
    );
    events[0].decision = {
      change,
      record: { caseId: "request", agentId: "designer" },
    };
    const draw = () =>
      render(
        <ActivityHistory
          state={state}
          history={{
            events,
            loading: false,
            notices: [],
            truncated: false,
            refresh() {
              refreshes++;
            },
          }}
        />,
        root,
      );
    const button = (name: string) =>
      [...root.querySelectorAll("button")].find((el) =>
        el.textContent === name
      )!;
    try {
      await act(draw);
      await act(() => settle());
      match(root.textContent ?? "", /Status unavailable/);
      equal(root.querySelectorAll("li").length, 30);
      equal(reads, 1);
      await act(draw);
      equal(reads, 1);
      await act(() => button("Show more").click());
      equal(root.querySelectorAll("li").length, 31);
      equal(reads, 1);
      available = true;
      await act(() => button("Read again").click());
      await act(() => settle());
      equal(refreshes, 1);
      equal(reads, 2);
      match(root.textContent ?? "", /Applied/);
    } finally {
      await act(() => render(null, root));
      state.dispose();
    }
  });
});
