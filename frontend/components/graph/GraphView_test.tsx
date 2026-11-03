import { doesNotMatch, equal, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { GraphView } from "./GraphView.tsx";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { snapshot } from "../../test/support/workbench-fixture.ts";
Deno.test("source model version is encoded for the native graph and current action is available", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.inspectSourceVersion("branch:review/a?b&c");
  const html = renderToString(<GraphView state={state} />);
  equal(
    state.graphRequestUrl.value,
    "/api/model-graph?modelVersion=branch%3Areview%2Fa%3Fb%26c",
  );
  match(
    html,
    /data-model-source="\/api\/model-graph\?modelVersion=branch%3Areview%2Fa%3Fb%26c"/,
  );
  doesNotMatch(html, /<iframe/);
  match(html, /id="history" hidden/);
  doesNotMatch(html, /id="return-model-current"[^>]*hidden/);
  state.resetToCurrent();
  equal(state.graphRequestUrl.value, "/api/model-graph");
  match(renderToString(<GraphView state={state} />), /Current model/);
});

Deno.test("the graph keeps its inspections on the address of the page that shows it", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.selectedRevision.value = 3;
  // Without an address of its own, the graph is the Model place's Graph page.
  const model = renderToString(<GraphView state={state} />);
  match(model, /action="\/model\?page=graph&amp;revision=3"/);
  match(model, /f-partial="\/model\?page=graph"/);
  match(model, /id="return-model-current"[^>]*href="\/model\?page=graph"/);
  // A page of another place passes its own address, query included.
  const page = renderToString(
    <GraphView state={state} home="/elsewhere?page=graph" />,
  );
  match(page, /action="\/elsewhere\?page=graph&amp;revision=3"/);
  match(page, /f-partial="\/elsewhere\?page=graph"/);
  match(page, /id="return-model-current"[^>]*href="\/elsewhere\?page=graph"/);
  doesNotMatch(page, /action="\/model|f-partial="\/model|href="\/model/);
});

Deno.test("a page that titles the graph itself can leave the graph's title out", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  match(renderToString(<GraphView state={state} />), /<h2>SysML model<\/h2>/);
  const html = renderToString(<GraphView state={state} heading={false} />);
  doesNotMatch(html, /section-head|SysML model<\/h2>/);
  // Everything else of the graph's page stays.
  match(html, /id="history"/);
  match(html, /class="native-graph"/);
});
