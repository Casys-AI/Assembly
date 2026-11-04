import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
} from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import type { AgentConversation } from "../../../src/application/work/operators/conversation-types.ts";
import { caseTree } from "../../lib/cases/tree.ts";
import { press } from "../../test/support/press.ts";
import { CaseTree } from "./CaseTree.tsx";

const CASE = "s:case:1";

function agent(
  id: string,
  patch: Partial<AgentConversation> = {},
  messages: unknown[] = [],
): AgentConversation {
  return {
    agentId: id,
    nativeId: `native:${id}`,
    name: id,
    responsibility: "",
    primary: false,
    canSend: true,
    revision: 1,
    busy: false,
    phase: "Ready",
    modelDigest: "digest",
    messages: messages as never,
    ...patch,
  };
}
const said = (id: string, at: string, callerId?: string) => ({
  id,
  role: "assistant",
  text: id,
  at,
  caseId: CASE,
  ...(callerId && { work: { callerId } }),
});

/** An owner with a collector, which asked a ranker, plus a lone reader. */
function roster() {
  const owner = agent("owner", { primary: true }, [
    said("o1", "2026-10-24T10:00:00Z"),
  ]);
  return {
    owner,
    all: [
      owner,
      agent("collector", {}, [
        said("c1", "2026-10-24T10:01:00Z", "native:owner"),
      ]),
      agent("ranker", { busy: true }, [
        said("r1", "2026-10-24T10:02:00Z", "native:collector"),
      ]),
      agent("reader", {}, [said("d1", "2026-10-24T10:03:00Z")]),
    ],
  };
}

function tree(defaultFolded?: ReadonlySet<string>) {
  const { owner, all } = roster();
  const root = caseTree(all, { id: CASE }, owner);
  return (
    <CaseTree
      root={root}
      caseId={CASE}
      selected={root.children[0]}
      defaultFolded={defaultFolded}
    />
  );
}

function render(defaultFolded?: ReadonlySet<string>) {
  return renderToString(tree(defaultFolded));
}

Deno.test("every branch starts open: a chevron button on nodes with children only", () => {
  const html = render();
  const items = [...html.matchAll(/<li\s+role="treeitem"([^>]*)>/g)].map((
    [, attributes],
  ) => ({
    level: attributes.match(/aria-level="(\d+)"/)?.[1],
    expanded: attributes.match(/aria-expanded="(\w+)"/)?.[1],
    label: attributes.match(/aria-label="([^"]*)"/)?.[1],
  }));
  deepStrictEqual(items, [
    { level: "1", expanded: "true", label: "owner" },
    { level: "2", expanded: "true", label: "collector" },
    { level: "3", expanded: undefined, label: "ranker" },
    { level: "2", expanded: undefined, label: "reader" },
  ]);
  // A plain button to fold, only on the two branches; a spacer elsewhere.
  deepStrictEqual(
    [...html.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]),
    ["Collapse owner", "Collapse collector"],
  );
  equal(
    html.match(/<span class="tree-toggle" aria-hidden="true">/g)?.length,
    2,
  );
  equal(html.match(/role="group"/g)?.length, 2);
});

Deno.test("a folded branch hides its children and offers to open again", () => {
  const html = render(new Set(["collector"]));
  doesNotMatch(html, /aria-label="ranker"/);
  match(
    html,
    /aria-label="collector"[^>]*>[\s\S]*?aria-label="Expand collector"/,
  );
  match(html, /<li\s+role="treeitem" aria-level="2" aria-expanded="false"/);
  // Its siblings stay, and the folded agent stays a link.
  match(html, /aria-label="reader"/);
  match(html, /href="\/cases\?case=s%3Acase%3A1&amp;agent=collector"/);
  const rootFolded = render(new Set(["owner"]));
  doesNotMatch(rootFolded, /aria-label="collector"|role="group"/);
});

Deno.test("folding is a click on the button of a branch; the rows themselves are plain links", () => {
  // One handler per branch; the rows themselves are plain links.
  equal(press(tree()).handlers, 2);
});

Deno.test("a silent admitted teammate has a selectable Request thread and its actual waiting phase", () => {
  const owner = agent("owner");
  const teammate = agent("analyst", {
    phase: "Waiting for work",
    operatorTeam: {
      parentOperatorId: owner.nativeId,
      requestOwnerId: owner.nativeId,
      requestId: CASE,
    },
  });
  const root = caseTree([owner, teammate], { id: CASE }, owner);
  const html = renderToString(
    <CaseTree root={root} caseId={CASE} selected={root} />,
  );
  match(html, /analyst/);
  match(html, /href="\/cases\?case=s%3Acase%3A1&amp;agent=analyst"/);
  match(html, /class="tree-phase" title="Waiting for work">Waiting for work/);
  doesNotMatch(html, /aria-label="Working"/);
});
