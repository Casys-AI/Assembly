import { deepStrictEqual, doesNotMatch, match, ok } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { CaseView } from "./CaseView.tsx";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import {
  caseRecord,
  jobRecord,
  watchRecord,
} from "../../test/support/case-fixture.ts";
import { press } from "../../test/support/press.ts";
import { snapshot } from "../../test/support/workbench-fixture.ts";

Deno.test("Job and Watch actions cannot post without their action port", async () => {
  for (const fixture of [jobRecord(), watchRecord()]) {
    const posts: string[] = [];
    const state = createWorkbenchState({
      initialState: snapshot(),
      fetch: (path, init) => {
        if (init?.method === "POST") posts.push(path);
        return Promise.resolve(Response.json({
          systemId: "ui-fixture",
          cases: [fixture],
        }));
      },
    });
    state.cases.accept({ systemId: "ui-fixture", cases: [fixture] });
    const record = state.cases.byId(fixture.id);
    ok(record);
    const view = press(<CaseView state={state} record={record} />);
    const buttons = [...view.html.matchAll(/<button\b[^>]*>/g)].map(([tag]) =>
      tag
    );
    ok(buttons.length > 0 && view.handlers === buttons.length);
    ok(buttons.every((button) => button.includes("disabled")));
    view.clickAll();
    await Promise.resolve();
    deepStrictEqual(posts, []);
    if (record.type === "job") {
      match(view.html, /class="case-close" disabled title="Not available yet"/);
    }
    state.cases.dispose();
  }
});

Deno.test("a Request has no page of this kind: the Requests page shows it", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.cases.accept({ systemId: "ui-fixture", cases: [caseRecord(1)] });
  const html = renderToString(
    <CaseView state={state} record={state.cases.byId("ui-fixture:case:1")} />,
  );
  // Its common facts only: no thread, no composer, no Close.
  doesNotMatch(html, /<textarea|class="case-close"/);
});

Deno.test("a missing Case shows its detail request state even after the collection loaded", async () => {
  for (const status of [404, 500]) {
    let release!: (response: Response) => void;
    const reads: string[] = [];
    const state = createWorkbenchState({
      initialState: snapshot(),
      fetch: (path) => {
        reads.push(path);
        return new Promise((resolve) => release = resolve);
      },
    });
    state.cases.accept({ systemId: "ui-fixture", cases: [] });
    const caseId = "ui-fixture:case:9";
    const render = () =>
      renderToString(<CaseView state={state} record={null} caseId={caseId} />);
    match(render(), /Loading the case…/);
    const loading = state.cases.ensure(caseId);
    match(render(), /Loading the case…/);
    release(Response.json({}, { status }));
    await loading;
    deepStrictEqual(reads, ["/api/cases/ui-fixture%3Acase%3A9"]);
    match(
      render(),
      status === 404 ? />Case not found</ : /Case unavailable \(500\)\./,
    );
    doesNotMatch(render(), /Loading the case…|This case is not available/);
    state.cases.dispose();
  }
});
