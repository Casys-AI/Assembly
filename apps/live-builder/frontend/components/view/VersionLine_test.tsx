import { doesNotMatch, equal, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { ModelLinkContext } from "./ModelContextLink.tsx";
import { VersionLine } from "./VersionLine.tsx";

const COMMIT = `commit:${"a".repeat(40)}`;

Deno.test("the head of main is its short commit and a chip, with the whole identity under it", () => {
  const html = renderToString(
    <VersionLine version={COMMIT} pinned={false} home="/x" />,
  );
  equal(
    html,
    `<div class="repo-version" data-version="${COMMIT}"><code title="${COMMIT}">aaaaaaa</code><span class="chip" title="The head of main">main</span></div>`,
  );
});

Deno.test("a pinned version links to the current model; the children come after", () => {
  const html = renderToString(
    <VersionLine version={COMMIT} pinned home="/system?select=a">
      <span class="chip warn">In service: bbbbbbb</span>
    </VersionLine>,
  );
  match(html, /<a href="\/system\?select=a">Show current model<\/a>/);
  doesNotMatch(html, /The head of main/);
  match(
    html,
    /Show current model<\/a><span class="chip warn">In service: bbbbbbb<\/span><\/div>$/,
  );
});

Deno.test("a Case pin returns to its own current model without claiming to show Main", () => {
  for (const inspected of [false, true]) {
    const context = `?caseBranch=request%3A7&agent=selected-child${
      inspected ? `&version=${encodeURIComponent(COMMIT)}` : ""
    }`;
    for (
      const home of [
        "/system?select=operator",
        "/system?page=performance",
        "/model?page=files&file=model.sysml",
        "/model?page=releases",
        "/model?page=sysml&view=team",
      ]
    ) {
      const html = renderToString(
        <ModelLinkContext.Provider value={context}>
          <VersionLine version={COMMIT} pinned home={home} />
        </ModelLinkContext.Provider>,
      );
      match(html, />Show current model<\/a>/);
      doesNotMatch(html, /Show main|The head of main/);
      const href = html.match(/href="([^"]+)"/)![1].replaceAll("&amp;", "&");
      const actual = new URL(href, "http://atelier.test");
      const expected = new URL(home, "http://atelier.test");
      expected.searchParams.set("caseBranch", "request:7");
      expected.searchParams.set("agent", "selected-child");
      equal(actual.href, expected.href);
      equal(actual.searchParams.has("version"), false);
    }
  }
});

Deno.test("the current Request model has its own label rather than a Main or historical link", () => {
  const html = renderToString(
    <VersionLine
      version={COMMIT}
      pinned={false}
      home="/model"
      currentLabel="Request model"
    />,
  );
  match(html, />Request model<\/span>/);
  doesNotMatch(html, /Show current model|head of main/);
});
