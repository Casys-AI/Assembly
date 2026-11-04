import { settle } from "../../../test/support/settle.ts";
import { parse, textOf, within } from "../../../test/support/dom.ts";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import { h, render, type VNode } from "preact";
import { act } from "preact/test-utils";
import { renderToString } from "preact-render-to-string";
import {
  changeOutcome,
  type ChangeWithDiff,
  diffStats,
  shortCommit,
} from "../../../lib/model/revisions/change.ts";
import { decisionState } from "../../../lib/conversations/decision-state.ts";
import {
  BASE,
  creation,
  diff,
  grant,
  PATCH,
} from "../../../test/support/operator-fixture.ts";
import {
  changeScope,
  changeTitle,
} from "../../../lib/conversations/proposal-differences.ts";
import { press } from "../../../test/support/press.ts";
import {
  ChangeLayout,
  LineCounts,
  ModelChangeCard,
  type ModelChangeCardProps,
  ModelChangeView,
  type ModelChangeViewProps,
  StatsLine,
} from "./ModelChangeCard.tsx";
import { ProposalCodeDiff } from "./ProposalCodeDiff.tsx";

const noop = () => Promise.resolve(true);
const ask = (text: string) => text;
function card(
  change: ChangeWithDiff,
  proposedBy: string | null = "Designer",
) {
  return renderToString(
    <ModelChangeCard
      id={`change-${change.id}`}
      change={change}
      decision={decisionState(change)}
      proposedBy={proposedBy ?? undefined}
      onDecide={noop}
      adjustmentMessage={ask}
      onAdjustment={noop}
    />,
  );
}

Deno.test("each kind of change names what it does, with the file and root of a grant", () => {
  equal(changeTitle(grant()), "Allow model editing");
  deepStrictEqual(changeScope(grant()), [
    "configuration.sysml",
    "ASELiveBuilder",
    "Add an element",
  ]);
  equal(changeTitle(creation()), "Create operator Research");
  deepStrictEqual(changeScope(creation()), [
    "Research request",
    "up to 4 invocations",
    "no network",
  ]);
  equal(
    changeTitle(
      grant({ requestedRights: { addNetworkHosts: ["example.org"] } }),
    ),
    "Extend web access",
  );
  equal(
    changeTitle(grant({ kind: "reviewer-creation", name: "Reviewer" })),
    "Add Reviewer",
  );
  const html = card(grant());
  match(
    textOf(html),
    /^Allow model editing configuration\.sysml ASELiveBuilder Add an element/,
  );
  match(
    textOf(card(creation())),
    /^Create operator Research Research request up to 4 invocations no network/,
  );
  // A name the operator chose is text, whatever it contains.
  const named = card(creation({ name: "<script>x()</script>" }));
  match(named, /Create operator &lt;script/);
  doesNotMatch(named, /<script/);
});

Deno.test("the card says who proposed the change and folds its diff under its size; the commit waits in the inspector", () => {
  const html = card(grant());
  const inspector = parse(html).querySelector(".inspector")!;
  equal(textOf(inspector.querySelector("summary")!), "proposed by Designer");
  equal(
    within(inspector).byRole("link").getAttribute("href"),
    "/cases?case=ui-fixture%3Acase%3A1",
  );
  match(
    html,
    /<summary title="1 file">SysML <span class="change-stats"><span class="plus">\+2<\/span> <span class="minus">−0<\/span><\/span><\/summary>/,
  );
  // No hash on the card: the base commit, exact, is in the inspector.
  doesNotMatch(html, /<code title=|>0123456</);
  match(
    textOf(html),
    /Change grant Request ui-fixture:case:1 Base commit commit:0123456789abcdef0123456789abcdef01234567/,
  );
  equal(shortCommit(BASE), "0123456");
  equal(shortCommit("branch:main"), "main");
  deepStrictEqual(diffStats(diff()), { additions: 2, deletions: 0, files: 1 });
  const many = diff();
  many.files.push(many.files[0], many.files[0]);
  many.additions = 12;
  many.deletions = 3;
  match(
    card(grant({ diff: many })),
    /<summary title="3 files">SysML .*\+12.*−3/,
  );
  // An unknown proposer is left out rather than shown as an identity.
  const anonymous = card(grant({ requestedBy: "native:ghost" }), null);
  doesNotMatch(anonymous, /proposed by|native:ghost/);
  match(anonymous, /<summary\s*>Details<\/summary>/);
  // The proposer's name is text.
  const hostile = card(grant(), "<b>Mallory</b>");
  match(hostile, /proposed by &lt;b(?:>|&gt;)Mallory/);
  doesNotMatch(hostile, /<b>Mallory/);
});

Deno.test("the lines gained and lost are drawn by one piece: the totals line is made of it, and so are a file's own counts", () => {
  const counts = renderToString(<LineCounts additions={3} deletions={1} />);
  equal(
    counts,
    '<span class="change-stats"><span class="plus">+3</span> <span class="minus">−1</span></span>',
  );
  equal(
    renderToString(<StatsLine additions={3} deletions={1} files={2} />),
    '<span class="change-stats"><span class="plus">+3</span> <span class="minus">−1</span> <span class="faint">· 2 files</span></span>',
  );
  // Totals any diff the host computed carries: a source diff's are read too.
  deepStrictEqual(
    diffStats({
      files: [
        { path: "a.sysml", kind: "added", additions: 3, deletions: 0 },
        { path: "b.sysml", kind: "changed", additions: 0, deletions: 1 },
      ],
      additions: 3,
      deletions: 1,
    }),
    { additions: 3, deletions: 1, files: 2 },
  );
});

Deno.test("Accept, Decline and Adjust sit on the card only while it is pending", () => {
  const pending = card(grant());
  match(pending, /<article class="chat-proposal model-change is-pending"/);
  match(
    pending,
    /<button type="button" class="proposal-accept"[^>]*>Accept<\/button>/,
  );
  match(pending, />Decline<\/button>/);
  match(pending, />Adjust<\/button>/);
  // The diff waits in a closed fold, with its layout toggle.
  match(pending, /<details class="change-diff"><summary title="1 file">SysML /);
  match(pending, /class="revision-diff-host proposal-code-diff"/);
  doesNotMatch(pending, /<details class="proposal-receipt"/);
  // The header says it waits, in the words every decision uses.
  match(pending, /<span class="change-chip is-to-decide"\s*>To decide<\/span>/);
  for (const status of ["approved", "refused"] as const) {
    const settled = card(
      grant({ status, publishedCommit: "commit:" + "f".repeat(40) }),
    );
    doesNotMatch(settled, />Accept<|>Decline<|>Adjust<|proposal-actions/);
    // Folded to one line: the diff is inside a closed details.
    match(settled, /<details class="proposal-receipt"><summary>/);
    doesNotMatch(settled, /<details[^>]* open/);
  }
});

Deno.test("a decided change shows its outcome as a chip", () => {
  const published = "commit:" + "f".repeat(40);
  const chip = (change: ChangeWithDiff) =>
    card(change).match(/<span class="change-chip is-([\w-]+)"[^>]*>([^<]*)/)
      ?.slice(1);
  deepStrictEqual(chip(grant({ status: "refused" })), ["declined", "Declined"]);
  deepStrictEqual(chip(grant({ status: "approved" })), [
    "applying",
    "Applying",
  ]);
  deepStrictEqual(
    chip(grant({ status: "approved", publishedCommit: published })),
    ["applied", "Applied"],
  );
  // Applying names its steps and decider together on hover.
  const applying = parse(renderToString(
    <ModelChangeCard
      id="applying"
      change={grant({ status: "approved" })}
      decision={decisionState(grant({ status: "approved" }))}
      decidedBy="Decided by you · rule owner · rev. 1"
      onDecide={noop}
      adjustmentMessage={ask}
      onAdjustment={noop}
    />,
  )).querySelector(".change-chip")!;
  equal(
    applying.getAttribute("title"),
    "Decided ✓ · Saved · In service · Decided by you · rule owner · rev. 1",
  );
  equal(applying.querySelectorAll(".chip-steps span").length, 3);
  equal(applying.querySelectorAll(".chip-steps .is-done").length, 1);
  const superseded = parse(card(grant({ status: "superseded" })));
  ok(superseded.querySelector("article.is-superseded"));
  equal(textOf(superseded.querySelector(".change-chip")!), "Superseded");
  equal(changeOutcome(grant()), "pending");
  // Once published, the inspector names the commit that published it.
  const html = card(grant({ status: "approved", publishedCommit: published }));
  match(textOf(html), /Published commit commit:f{40}/);
  doesNotMatch(html, /0123456/);
  // A change without a diff has nothing more to wait for after approval.
  equal(
    changeOutcome({ ...grant(), diff: undefined, status: "approved" }),
    "applied",
  );
});

Deno.test("the diff is Diff2Html output with every source line and file name escaped", () => {
  const html = card(grant());
  match(html, /d2h-ins/);
  match(html, /&lt;img src=x onerror=attack\(\)&gt;/);
  doesNotMatch(html, /<img|<script/);
  const hostile = PATCH.replaceAll(
    "configuration.sysml",
    "<script>name()</script>.sysml",
  );
  const named = card(grant({ diff: diff(hostile) }));
  match(named, /&lt;script&gt;name\(\)&lt;\/script&gt;\.sysml/);
  doesNotMatch(named, /<script/);
  // No patch, no empty frame and no layout control.
  const bare = card(grant({ diff: diff("") }));
  doesNotMatch(bare, /proposal-code-diff|change-layout/);
});

Deno.test("Unified and Split render the same diff in two layouts, Unified first", () => {
  const unified = renderToString(<ProposalCodeDiff patch={PATCH} />);
  const split = renderToString(
    <ProposalCodeDiff patch={PATCH} mode="side-by-side" />,
  );
  match(unified, /d2h-file-diff/);
  doesNotMatch(unified, /d2h-file-side-diff|is-split/);
  match(split, /d2h-file-side-diff/);
  match(split, /proposal-code-diff is-split/);
  for (const html of [unified, split]) {
    match(html, /&lt;img src=x/);
    doesNotMatch(html, /<img/);
  }
  // The card starts Unified, with the choice pressed.
  const html = card(grant());
  match(html, /aria-pressed="true"[^>]*>Unified</);
  match(html, /aria-pressed="false"[^>]*>Split</);
  doesNotMatch(html, /d2h-file-side-diff/);
  // Each button asks for its own layout.
  const asked: string[] = [];
  const toggle = press(
    <ChangeLayout mode="side-by-side" onChange={(mode) => asked.push(mode)} />,
  );
  deepStrictEqual(toggle.labels, ["Unified", "Split"]);
  match(toggle.html, /aria-pressed="false"[^>]*>Unified</);
  match(toggle.html, /aria-pressed="true"[^>]*>Split</);
  toggle.click("Unified");
  toggle.click("Split");
  deepStrictEqual(asked, ["line-by-line", "side-by-side"]);
});

Deno.test("Accept and Decline reach the owner of the decision with the verdict", async () => {
  const verdicts: Array<[string, string | undefined]> = [];
  const view = press(
    <ModelChangeCard
      id="change-grant"
      change={grant()}
      decision={decisionState(grant())}
      onDecide={(verdict, reason) => {
        verdicts.push([verdict, reason]);
        return Promise.resolve(true);
      }}
      adjustmentMessage={ask}
      onAdjustment={noop}
    />,
  );
  view.click("Accept");
  view.click("Decline");
  // A second decision in the same turn is blocked while the first is in flight.
  deepStrictEqual(verdicts, [["approve", undefined]]);
  await Promise.resolve();
  view.click("Decline");
  await Promise.resolve();
  deepStrictEqual(verdicts, [["approve", undefined], ["refuse", undefined]]);
  // A blocked card decides nothing.
  verdicts.length = 0;
  const blocked = press(
    <ModelChangeCard
      id="change-grant"
      change={grant()}
      decision={decisionState(grant())}
      acceptDisabled
      onDecide={(verdict) => {
        verdicts.push([verdict, undefined]);
        return Promise.resolve(true);
      }}
      adjustmentMessage={ask}
      onAdjustment={noop}
    />,
  );
  match(blocked.html, /<button[^>]*disabled[^>]*>Accept<\/button>/);
  doesNotMatch(blocked.html, /<button[^>]*disabled[^>]*>Decline<\/button>/);
  blocked.click("Accept");
  await Promise.resolve();
  deepStrictEqual(verdicts, []);
});

const FULL = "commit:" + "a".repeat(40);
const STATS = { additions: 5, deletions: 2, files: 2 };
/** ModelChangeView with plain props only: no change, no decision, no workbench. */
function view(props: Partial<ModelChangeViewProps> = {}) {
  return (
    <ModelChangeView
      title="Rename the engine"
      author="Designer"
      commit={FULL}
      stats={STATS}
      patch={PATCH}
      state="pending"
      {...props}
    />
  );
}

Deno.test("ModelChangeView alone shows a pending change with its actions slot", () => {
  const html = renderToString(
    view({ actions: <button type="button">Approve</button> }),
  );
  match(html, /<article class="chat-proposal model-change is-pending"/);
  match(html, /aria-label="Rename the engine"/);
  match(
    textOf(html),
    /^Rename the engine proposed by Designer aaaaaaa \+5 −2 · 2 files/,
  );
  // The full commit is the tooltip; only seven characters are read.
  match(html, /<code title="Commit commit:a{40}">aaaaaaa<\/code>/);
  doesNotMatch(html, />aaaaaaaa/);
  match(
    html,
    /<div class="proposal-actions"><button type="button">Approve<\/button><\/div>/,
  );
  match(html, /class="revision-diff-host proposal-code-diff"/);
  match(html, /aria-pressed="true"[^>]*>Unified</);
  doesNotMatch(html, /<details|change-chip/);
  // The caller says what the commit is, and what stands under the title.
  const described = renderToString(
    view({
      commitLabel: "Base commit",
      children: (
        <p class="change-scope">
          <span>configuration.sysml</span>
        </p>
      ),
      notice: "Waiting for review",
    }),
  );
  match(described, /<code title="Base commit commit:a{40}">/);
  match(
    textOf(described),
    /^Rename the engine configuration\.sysml proposed by Designer/,
  );
  match(described, /<p class="proposal-notice" role="status">Waiting/);
  // No author: nobody is named.
  doesNotMatch(renderToString(view({ author: undefined })), /proposed by/);
});

Deno.test("ModelChangeView hands out no actions once the change is decided", () => {
  for (const state of ["accepted", "declined", "applied"] as const) {
    const html = renderToString(
      view({ state, actions: <button type="button">Approve</button> }),
    );
    doesNotMatch(html, />Approve<|proposal-actions/);
    match(html, new RegExp(`class="change-chip is-${state}"`));
  }
});

Deno.test("ModelChangeView folds a decided change with its chip, and opens when told to", () => {
  const folded = renderToString(view({ state: "declined" }));
  match(
    folded,
    /<article class="chat-proposal model-change is-settled is-declined"/,
  );
  match(folded, /<details class="proposal-receipt"><summary>/);
  doesNotMatch(folded, /<details[^>]* open/);
  match(
    folded,
    /<span>Rename the engine<\/span><span class="change-chip is-declined">Declined<\/span>/,
  );
  // The facts and the diff are still there, behind the fold.
  match(textOf(folded), /proposed by Designer aaaaaaa \+5 −2 · 2 files/);
  match(folded, /d2h-ins/);
  // A caller can draw the status itself, on the receipt and on the header.
  const status = <span class="change-chip is-superseded">Superseded</span>;
  match(
    renderToString(view({ state: "declined", status })),
    /<span>Rename the engine<\/span><span class="change-chip is-superseded">Superseded<\/span><\/summary>/,
  );
  match(
    renderToString(view({ status, layout: "header" })),
    /<\/div><span class="change-chip is-superseded">Superseded<\/span><\/header>/,
  );
  // Open on request, still with its outcome.
  const open = renderToString(view({ state: "applied", open: true }));
  match(open, /<details class="proposal-receipt" open>/);
  match(open, /is-applied">Applied</);
  // Folded on request, still pending.
  const shut = renderToString(view({ open: false }));
  match(shut, /<details class="proposal-receipt"><summary>/);
  match(shut, /is-pending">Pending</);
});

Deno.test("ModelChangeView escapes the patch, the title and the author", () => {
  const hostile = PATCH.replaceAll(
    "configuration.sysml",
    "<script>name()</script>.sysml",
  );
  const html = renderToString(
    view({
      patch: hostile,
      title: "<script>t()</script>",
      author: "<b>Mallory</b>",
    }),
  );
  match(html, /&lt;img src=x onerror=attack\(\)&gt;/);
  match(html, /&lt;script&gt;name\(\)&lt;\/script&gt;\.sysml/);
  match(html, /<h3>&lt;script(?:>|&gt;)t\(\)&lt;\/script(?:>|&gt;)<\/h3>/);
  match(html, /proposed by &lt;b(?:>|&gt;)Mallory/);
  doesNotMatch(html, /<script|<img|<b>Mallory/);
  // No patch, no empty frame and no layout control.
  doesNotMatch(
    renderToString(view({ patch: "" })),
    /proposal-code-diff|change-layout/,
  );
});

Deno.test("ModelChangeView keeps its own layout, or follows the one it is given", () => {
  // Uncontrolled: it starts Unified and its toggle changes nothing outside.
  const own = press(view());
  match(own.html, /aria-pressed="true"[^>]*>Unified</);
  doesNotMatch(own.html, /d2h-file-side-diff/);
  deepStrictEqual(own.labels, ["Unified", "Split"]);
  // Controlled: the layout is the caller's, and the toggle only asks.
  const asked: string[] = [];
  const split = press(
    view({ mode: "side-by-side", onModeChange: (mode) => asked.push(mode) }),
  );
  match(split.html, /aria-pressed="true"[^>]*>Split</);
  match(split.html, /aria-pressed="false"[^>]*>Unified</);
  match(split.html, /proposal-code-diff is-split/);
  match(split.html, /d2h-file-side-diff/);
  split.click("Unified");
  split.click("Split");
  deepStrictEqual(asked, ["line-by-line", "side-by-side"]);
  // Given a layout but no listener, the toggle is inert rather than failing.
  const fixed = press(view({ mode: "side-by-side" }));
  fixed.click("Unified");
  match(fixed.html, /proposal-code-diff is-split/);
  // A listener without a layout is only told; the view still starts Unified.
  const told: string[] = [];
  const listening = press(view({ onModeChange: (mode) => told.push(mode) }));
  match(listening.html, /aria-pressed="true"[^>]*>Unified</);
  listening.click("Split");
  deepStrictEqual(told, ["side-by-side"]);
});

Deno.test("ModelChangeView holds the cards' extra slots in order: actions, panel, diff, footer", () => {
  const html = renderToString(
    view({
      actions: <button type="button">Go</button>,
      panel: <p class="slot-panel">panel</p>,
      footer: <p class="slot-footer">footer</p>,
    }),
  );
  const at = (needle: string) => html.indexOf(needle);
  ok(at(">Go<") > 0);
  ok(at(">Go<") < at("slot-panel"));
  ok(at("slot-panel") < at("proposal-code-diff"));
  ok(at("proposal-code-diff") < at("slot-footer"));
});

Deno.test("ModelChangeView takes the header or the receipt when asked, whatever its state", () => {
  // A decided change can keep the plain header: no chip, nothing to fold.
  const header = renderToString(view({ state: "declined", layout: "header" }));
  match(
    header,
    /<article class="chat-proposal model-change is-settled is-declined"/,
  );
  match(header, /<header class="proposal-heading change-heading">/);
  doesNotMatch(header, /<details|change-chip/);
  match(header, /class="revision-diff-host proposal-code-diff"/);
  // A pending one can be a receipt.
  const receipt = renderToString(view({ layout: "receipt" }));
  match(receipt, /<details class="proposal-receipt" open>/);
  match(receipt, /is-pending">Pending</);
  doesNotMatch(receipt, /<header/);
  // Without it, the state and `open` decide, as before.
  match(renderToString(view()), /<header class="proposal-heading/);
  match(renderToString(view({ state: "applied" })), /<details/);
});

/**
 * The production card with its real hooks, run without a browser DOM: the
 * card is called inside a probe, so its state survives renders, and the markup
 * is read from the vnode it returns. `move` is the host changing the change
 * under a decision still being made.
 */
async function withCard(
  first: ChangeWithDiff,
  handlers: Pick<ModelChangeCardProps, "onDecide" | "onAdjustment">,
  exercise: (card: {
    html(): string;
    click(label: string): Promise<void>;
    type(text: string): Promise<void>;
    submit(): Promise<void>;
    move(change: ChangeWithDiff): Promise<void>;
    settle(): Promise<void>;
  }) => Promise<void>,
) {
  const documentBefore = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const frameBefore = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestAnimationFrame",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {},
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: () => 0,
  });
  let node: VNode | undefined;
  function Probe({ change }: { change: ChangeWithDiff }) {
    node = ModelChangeCard({
      id: `change-${change.id}`,
      change,
      decision: decisionState(change),
      proposedBy: "Designer",
      adjustmentMessage: ask,
      ...handlers,
    });
    return null;
  }
  /** The handlers of the latest render: its buttons' clicks, field and form. */
  const grab = () => press(node!);
  const root = {} as HTMLElement;
  try {
    await act(() => render(h(Probe, { change: first }), root));
    await exercise({
      html: () => grab().html,
      click: (label) =>
        act(() => {
          void grab().click(label);
        }),
      type: (text) =>
        act(() => {
          grab().input?.({ currentTarget: { value: text } });
        }),
      submit: () =>
        act(async () => {
          grab().submit?.({ preventDefault() {} });
          await settle();
        }),
      move: (change) => act(() => render(h(Probe, { change }), root)),
      settle: () => act(settle),
    });
  } finally {
    await act(() => render(null, root));
    for (
      const [name, descriptor] of [
        ["document", documentBefore],
        ["requestAnimationFrame", frameBefore],
      ] as const
    ) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}
/** What a card that has not been folded looks like: its header, no fold. */
function isHeader(html: string) {
  match(html, /<header class="proposal-heading change-heading">/);
  doesNotMatch(html, /<details class="proposal-receipt"/);
}

Deno.test("a declined change keeps its header and its form while an adjustment is made and sent", async () => {
  const sent = deferred<boolean>();
  const calls: string[] = [];
  await withCard(grant(), {
    onDecide: (verdict) => {
      calls.push(verdict);
      return Promise.resolve(true);
    },
    onAdjustment: (message) => {
      calls.push(message);
      return sent.promise;
    },
  }, async (card) => {
    await card.click("Adjust");
    match(
      card.html(),
      /<article class="chat-proposal model-change is-pending"/,
    );
    match(card.html(), /<textarea/);
    // The host declines the change while the form is still open.
    await card.move(grant({ status: "refused" }));
    let html = card.html();
    match(
      html,
      /<article class="chat-proposal model-change is-settled is-declined"/,
    );
    isHeader(html);
    match(html, /<form class="proposal-adjustment"/);
    doesNotMatch(html, /proposal-actions"><button[^>]*>Accept/);
    await card.type("Limit access to one site");
    match(card.html(), /<textarea[^>]*value="Limit access to one site"/);
    // Sending: the form stays where it is, locked, under no chip.
    await card.submit();
    html = card.html();
    isHeader(html);
    match(html, /<textarea[^>]*disabled/);
    match(html, />Sending…</);
    deepStrictEqual(calls, ["refuse", "Limit access to one site"]);
    // The request failed: the error and the form are still there to retry.
    sent.resolve(false);
    await card.settle();
    html = card.html();
    isHeader(html);
    match(
      html,
      /<p class="proposal-error" role="alert">The proposal was declined, but the request was not sent\. Send it again\.<\/p>/,
    );
    match(html, /<form class="proposal-adjustment"/);
    doesNotMatch(html, /<textarea[^>]*disabled/);
    // Cancelling ends the form, but the failure remains visible in the receipt.
    await card.click("Cancel");
    html = card.html();
    equal(
      parse(html).querySelector<HTMLDetailsElement>(".proposal-receipt")!.open,
      true,
    );
    match(html, /<span class="change-chip is-declined"\s*>Declined<\/span>/);
    doesNotMatch(html, /<header|<textarea/);
  });
});

Deno.test("an adjustment that was sent folds the declined change as requested", async () => {
  await withCard(grant(), {
    onDecide: () => Promise.resolve(true),
    onAdjustment: () => Promise.resolve(true),
  }, async (card) => {
    await card.click("Adjust");
    await card.type("Limit access to one site");
    await card.move(grant({ status: "refused" }));
    isHeader(card.html());
    await card.submit();
    const html = card.html();
    match(html, /<details class="proposal-receipt"><summary>/);
    const chip = within(html).byText("Adjustment requested");
    equal(chip.getAttribute("title"), "Adjustment requested");
    doesNotMatch(html, /<header|<textarea|proposal-error/);
  });
});

Deno.test("a change decided while its Accept or Decline is still working keeps its header until that ends", async () => {
  const answer = deferred<boolean>();
  await withCard(grant(), {
    onDecide: () => answer.promise,
    onAdjustment: () => Promise.resolve(true),
  }, async (card) => {
    await card.click("Decline");
    let html = card.html();
    match(html, /<article class="chat-proposal model-change is-pending"/);
    match(html, />Working…</);
    // The host has moved the change but the decision has not come back yet.
    await card.move(grant({ status: "refused" }));
    html = card.html();
    match(
      html,
      /<article class="chat-proposal model-change is-settled is-declined"/,
    );
    isHeader(html);
    doesNotMatch(html, /proposal-actions/);
    answer.resolve(true);
    await card.settle();
    html = card.html();
    match(html, /<details class="proposal-receipt"><summary>/);
    doesNotMatch(html, /<details[^>]* open|<header/);
    match(html, /<span class="change-chip is-declined"\s*>Declined<\/span>/);
  });
});

Deno.test("a new team member reads as the member: monogram, name, mission and its rights as marks", () => {
  const member = creation({
    name: "Hook Reviewer",
    operator: {
      kind: "request-team-member",
      instruction: "Review the hooks and propose a better version.",
      provision: {
        budget: { maxAgentDecisions: 3, maxToolProposals: 1, maxFlowSteps: 20 },
        networkHosts: [],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
      },
    },
    teamOrigin: {
      operatorId: "native:designer",
      requestId: "ui-fixture:case:1",
    },
  });
  const html = card(member, "Remurin Talvrek");
  const heading = within(html).byRole("heading", { name: "Hook Reviewer" });
  equal(textOf(heading.querySelector(".agent-tile")!), "HR");
  match(
    html,
    /<p class="member-mission" title="Review the hooks and propose a better version\.">Review the hooks/,
  );
  match(html, /<li\s+title="No network"><svg[^]*?<\/svg>no network<\/li>/);
  match(
    textOf(html),
    /Hook Reviewer Review the hooks and propose a better version\. this Request no network creates no one New member · proposed by Remurin Talvrek/,
  );
  // Nothing exact on the card itself: identities and commits wait inside.
  const shown = html.slice(0, html.indexOf('<div class="inspector-body">'));
  doesNotMatch(shown, /ui-fixture:case:1|0123456|Create team operator/);
  match(html, /<summary title="1 file">SysML /);
});
