import { deepStrictEqual, doesNotMatch, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import {
  synchronizeCaseLocation,
  Workspace,
} from "../../islands/Workbench.tsx";
import { deskLocation } from "../../lib/workbench/desk.ts";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { caseRecord } from "../support/case-fixture.ts";
import { snapshot } from "../support/workbench-fixture.ts";

Deno.test("opening a direct Case link reads a closed Case absent from the collection", async () => {
  const paths: string[] = [];
  const state = createWorkbenchState({
    initialState: snapshot(),
    fetch: (path) => {
      paths.push(path);
      return Promise.resolve(
        Response.json({
          systemId: "ui-fixture",
          case: caseRecord(1, {
            status: "closed-done",
            closedAt: "2026-10-24T12:00:00Z",
          }),
        }),
      );
    },
  });
  state.cases.accept({ systemId: "ui-fixture", cases: [] });
  state.requests.context.value = {
    projectId: "fixture-project",
    systemId: "ui-fixture",
  };
  state.requests.sessionReady.value = true;
  state.requests.cases.accept({ systemId: "ui-fixture", cases: [] });
  const url = new URL("https://atelier.test/chat?case=ui-fixture%3Acase%3A1");
  const item = deskLocation(url, null).item;
  if (item?.kind !== "case") throw new Error("Expected a Case location");
  // This is the same synchronization the opened Workspace runs on navigation.
  await synchronizeCaseLocation(state, item.caseId);
  const html = renderToString(
    <Workspace state={state} started initialUrl={url.href} />,
  );
  deepStrictEqual(paths, ["/api/cases/ui-fixture%3Acase%3A1?space=requests"]);
  // A Request is read on the Requests page beside the global Main conversation.
  match(html, /id="cases-panel"(?![^>]*hidden)/);
  match(html, /id="case-panel"[^>]*hidden/);
  doesNotMatch(html, /id="chat-panel"[^>]*hidden/);
  const page = html.slice(
    html.indexOf('id="cases-panel"'),
    html.indexOf('id="case-panel"'),
  );
  match(page, /<h2>Objective 1<\/h2>/);
  // Its agents as a tree on the left, a way back to the list above.
  match(page, /<a class="cases-back" href="\/cases">/);
  match(page, /<nav class="case-tree" aria-label="Conversations">/);
  doesNotMatch(page, /class="cases-list"/);
  doesNotMatch(page, /class="feed-group"/);
  // Closed, it belongs to Done: no Close, nothing to write in.
  match(page, /<span class="chip">Done<\/span>/);
  doesNotMatch(page, /<button[^>]*>Close<\/button>/);
  doesNotMatch(page, /id="cases-input"/);
  await synchronizeCaseLocation(state, item.caseId);
  deepStrictEqual(paths, ["/api/cases/ui-fixture%3Acase%3A1?space=requests"]);
});

Deno.test("a refused missing Request link keeps the scoped error and never opens a Main conversation", async () => {
  const state = createWorkbenchState({
    initialState: snapshot(),
    fetch: () =>
      Promise.resolve(
        Response.json({ error: "Request is unavailable." }, { status: 403 }),
      ),
  });
  await synchronizeCaseLocation(state, "missing");
  const html = renderToString(
    <Workspace
      state={state}
      started
      initialUrl="https://atelier.test/cases?case=missing"
    />,
  );
  const page = html.slice(
    html.indexOf('id="cases-panel"'),
    html.indexOf('id="case-panel"'),
  );
  match(html, /id="cases-panel"(?![^>]*hidden)/);
  match(page, /class="cases-note" role="status">Request is unavailable\.</);
  // The way back stays: a missing Case is no dead end.
  match(page, /<a class="cases-back" href="\/cases">/);
  // Nothing to write in: a message would open a Case nobody asked for.
  doesNotMatch(page, /id="cases-input"/);
});
