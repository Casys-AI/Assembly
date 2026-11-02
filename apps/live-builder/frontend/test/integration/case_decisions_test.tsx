import { doesNotMatch, equal, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import type { ConversationsSnapshot } from "../../../src/domain/work/records/conversations.ts";
import { Workspace } from "../../islands/Workbench.tsx";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { caseRecord } from "../support/case-fixture.ts";
import { snapshot } from "../support/workbench-fixture.ts";

function renderCases(
  count: number,
  caseId?: string,
  origin: Record<string, string> = {},
  path = "/",
) {
  const current = snapshot();
  current.candidates = [];
  const state = createWorkbenchState({ initialState: current });
  const roster: ConversationsSnapshot = {
    systemId: current.id,
    version: "threads",
    defaultAgentId: "coordinator",
    conversations: [{
      agentId: "coordinator",
      nativeId: "native:coordinator",
      name: "Coordinator",
      responsibility: "Handle requests",
      primary: true,
      canSend: true,
      busy: false,
      revision: 1,
      phase: "Ready",
      messages: [],
      modelDigest: "model",
      proposalContext: {
        configurationRevision: 1,
        before: {
          network: { allowedHosts: [] },
          builder: { admissionAuthority: "human" },
        },
        changes: [Object.assign(
          {
            id: "change",
            kind: "mandate-change" as const,
            status: "pending" as const,
            baseRevision: 1,
            reason: "Allow a host",
            requestedAt: "2026-10-24T11:00:00Z",
          },
          caseId ? { caseId } : {},
          origin,
        )],
      },
    }],
  };
  state.agentConversations.accept(roster);
  state.cases.accept({
    systemId: current.id,
    cases: Array.from(
      { length: count },
      (_, index) => caseRecord(index + 1, { type: "job" }),
    ),
  });
  for (let index = 1; index <= count; index++) {
    state.pins.toggle(`ui-fixture:case:${index}`);
  }
  return renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl={`https://atelier.test${path}`}
    />,
  );
}

/** What the To decide place lists: the decisions are read on its page. */
const decisions = (...args: [number, string?, Record<string, string>?]) =>
  renderCases(args[0], args[1], args[2], "/decide");

function tile(html: string, id: number): string {
  const anchor = html.match(
    new RegExp(
      `<a[^>]*data-case-id="ui-fixture:case:${id}"[^>]*>[\\s\\S]*?</a>`,
    ),
  );
  return anchor?.[0] ?? "";
}

Deno.test("two Main Job Cases of one owner show a decision badge only on its recorded Case", () => {
  const html = renderCases(2, "ui-fixture:case:2");
  doesNotMatch(tile(html, 1), /dock-badge|decision waiting/);
  match(tile(html, 2), /dock-badge/);
  match(tile(html, 2), /decision waiting/);
  match(html, /aria-label="To decide, 1 pending"/);
  match(
    decisions(2, "ui-fixture:case:2"),
    /<span class="decide-text">Authorize mandate change<\/span>/,
  );
});

Deno.test("an unscoped decision marks only the owner's sole open Case and stays in To decide", () => {
  for (const count of [1, 2]) {
    const html = renderCases(count);
    for (let id = 1; id <= count; id++) {
      equal(tile(html, id).includes('class="dock-badge"'), count === 1);
    }
    match(html, /aria-label="To decide, 1 pending"/);
    match(
      decisions(count),
      /<span class="decide-text">Authorize mandate change<\/span>/,
    );
  }
});

Deno.test("a decision recorded in an open Case lights that Case, not its agent's circle", () => {
  const scoped = renderCases(2, "ui-fixture:case:2");
  match(tile(scoped, 2), /dock-badge/);
  doesNotMatch(scoped, /dock-circle-badge/);
  // The decision stays in To decide and leads to the Case.
  match(
    decisions(2, "ui-fixture:case:2"),
    /href="\/cases\?case=ui-fixture%3Acase%3A2"[^>]*>\s*<span[^>]*><\/span><span class="decide-text">Authorize/,
  );
  // A Case the page does not know cannot hold it: the circle keeps it.
  match(renderCases(1, "ui-fixture:case:9"), /dock-circle-badge/);
  // Without a Case the agent's own conversation holds it.
  match(renderCases(2), /dock-circle-badge/);
});

Deno.test("a decision made in the designer's own conversation lights the circle and no Case", () => {
  const html = renderCases(1, undefined, { designerScopeId: "scope:1" });
  match(html, /dock-circle-badge/);
  doesNotMatch(tile(html, 1), /dock-badge/);
  match(html, /aria-label="To decide, 1 pending"/);
  match(
    decisions(1, undefined, { designerScopeId: "scope:1" }),
    /href="\/chat\?agent=coordinator"[^>]*>\s*<span[^>]*><\/span><span class="decide-text">Authorize/,
  );
});
