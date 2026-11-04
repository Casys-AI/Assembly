import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { ActivityPage } from "./activity/ActivityPage.tsx";
import { FilesPage } from "./files/FilesPage.tsx";
import { RevisionsPage } from "./revisions/RevisionsPage.tsx";
import { createModelFiles } from "../../lib/model/sources/files.ts";
import { createModelHistory } from "../../lib/model/revisions/history.ts";
import {
  createRevisionApi,
  type RevisionSelection,
} from "../../lib/model/revisions/api.ts";
import { localSources } from "../../lib/model/sources/command.ts";
import { press } from "../../test/support/press.ts";
import {
  commit,
  designer,
  history,
  modelHost,
  PROPOSED,
  ROOT,
} from "../../test/support/revision-fixture.ts";
import { sourceTexts } from "../../test/support/files-fixture.ts";
import { HEAD } from "../../test/support/files-fixture.ts";

/**
 * "Last change to this file", from the Files page to the page it opens, over
 * one host that serves every route: the link is built by the first page and
 * must lead to a revision the second can show, however old the commit is and
 * wherever it lives. The pages are read the way their effects read them.
 */
const NOW = Date.parse("2026-10-24T13:00:00Z");
const encoded = encodeURIComponent;

/** The address of the last change that the Files page shows for a file. */
async function lastChangeLink(
  host: ReturnType<typeof modelHost>,
  search: string,
  version?: string,
) {
  const files = createModelFiles({ api: createRevisionApi(host.request) });
  await files.open(version);
  const listing = files.listing.peek();
  ok(listing.status === "ready", "the files could be listed");
  await files.readSources(listing.version);
  const html = renderToString(
    <FilesPage
      versionInfo={{ source: { kind: "main" } }}
      location={{ search }}
      files={files}
      now={NOW}
    />,
  );
  const href = /<a class="last" href="([^"]+)"/.exec(html)?.[1];
  ok(href, "the page shows the last change");
  return href.replaceAll("&amp;", "&");
}

/** The Revisions page at an address, its history read as its effects read it. */
async function revisionsAt(
  host: ReturnType<typeof modelHost>,
  address: string,
) {
  const sources = localSources();
  const url = new URL(address, "http://host.test");
  const named: RevisionSelection | undefined = url.searchParams.get("commit")
    ? { kind: "commit", id: url.searchParams.get("commit")! }
    : undefined;
  const store = createModelHistory({
    api: createRevisionApi(host.request),
    sources,
    selection: () => named,
    onChanged: () => {},
  });
  await store.refresh();
  return press(
    <RevisionsPage
      location={{ search: url.search }}
      sources={sources}
      onChanged={() => {}}
      operators={[designer]}
      history={store}
      now={NOW}
    />,
  ).html;
}

Deno.test("the last change to a file read at a proposal's version is that proposal, opened in Revisions", async () => {
  // The open proposal has a version of its own, which main does not have.
  const OPEN = `commit:${"4".repeat(40)}`;
  const data = history();
  data.revisions.proposals.find((entry) => entry.id === "p-open")!
    .proposalVersion = OPEN;
  const sources = sourceTexts();
  sources[OPEN] = sources[PROPOSED];
  const host = modelHost({ data, files: { sources } });

  // The proposal changed the configuration: its last change is the proposal's.
  const link = await lastChangeLink(
    host,
    `?page=files&version=${encoded(OPEN)}&file=configuration.sysml`,
    OPEN,
  );
  equal(link, `/model?commit=${encoded(OPEN)}`);
  // A file it did not touch is last changed on main, as ever.
  const untouched = await lastChangeLink(
    host,
    `?page=files&version=${encoded(OPEN)}&file=reader.sysml`,
    OPEN,
  );
  equal(
    untouched,
    `/model?commit=${encoded(`commit:${"b".repeat(40)}`)}`,
  );

  // The link opens the proposal, on the Proposals list, not a dead end.
  const html = await revisionsAt(host, link);
  doesNotMatch(html, /not in the loaded history|older than/);
  match(html, /aria-pressed="true"\s*>Proposals/);
  match(html, /<h3>Add a ranking step<\/h3>/);
  match(
    html,
    new RegExp(`href="/model\\?proposal=p-open"[^>]*aria-current="true"`),
  );
  // And the commit of main is still a commit.
  const onMain = await revisionsAt(host, untouched);
  match(onMain, /aria-pressed="true"\s*>Commits/);
  match(onMain, /<h3>Add the reader<\/h3>/);
});

/**
 * A model whose history is `count` commits long, the oldest being ROOT, which
 * made `lib/units.sysml`: further back than the host lists by default.
 */
function oldModel(count: number) {
  const data = history();
  const version = (index: number) =>
    `commit:${(index + 16).toString(16).padStart(40, "0")}`;
  const between = Array.from({ length: count - 3 }, (_, index) =>
    commit(
      version(index),
      index === count - 4 ? ROOT : version(index + 1),
      "local-control",
      `Change ${index}`,
      "2026-10-21T00:00:00Z",
      [],
    ));
  const [head, parent, root] = data.history.commits;
  data.history.commits = [
    head,
    { ...parent, parentVersion: between[0].version },
    ...between,
    root,
  ];
  return modelHost({ data, files: { sources: sourceTexts() } });
}

Deno.test("the last change to a file older than the usual history is found: the history is read as long as the host lists", async () => {
  const host = oldModel(130);
  const link = await lastChangeLink(host, "?page=files&file=lib%2Funits.sysml");
  equal(link, `/model?commit=${encoded(ROOT)}`);
  const html = await revisionsAt(host, link);
  doesNotMatch(html, /not in the loaded history|older than/);
  match(html, /<h2>Admit the initial model<\/h2>/);
  match(html, /aria-pressed="true"\s*>Commits/);
  deepStrictEqual(
    host.requests.filter((entry) => entry.path.startsWith("/api/model-history"))
      .map((entry) => entry.path).slice(-2),
    ["/api/model-history", "/api/model-history?limit=200"],
  );
  // The head, which the usual history holds, costs no longer read.
  const head = oldModel(130);
  await revisionsAt(head, `/model?commit=${encoded(HEAD)}`);
  equal(
    head.requests.filter((entry) => entry.path.startsWith("/api/model-history"))
      .length,
    1,
  );
});

Deno.test("a last change older than the longest history says so, and how far the history reaches", async () => {
  const host = oldModel(230);
  const link = await lastChangeLink(host, "?page=files&file=lib%2Funits.sysml");
  equal(link, `/model?commit=${encoded(ROOT)}`);
  const html = await revisionsAt(host, link);
  match(
    html,
    /<p class="rev-empty" data-code="revision-older">This revision is older than the 200 latest commits\.<\/p>/,
  );
  doesNotMatch(html, /not in the loaded history/);
  // A proposal the host does not know is not "older": it is not there at all.
  const unknown = await revisionsAt(host, "/model?proposal=gone");
  match(unknown, /data-code="revision-absent"/);
});

Deno.test("a file of a waiting proposal's line opens at the proposal's version, and its last change opens the proposal, all over one host", async () => {
  const OPEN = `commit:${"4".repeat(40)}`;
  const data = history();
  data.revisions.proposals.find((entry) => entry.id === "p-open")!
    .proposalVersion = OPEN;
  const sources = sourceTexts();
  sources[OPEN] = sources[PROPOSED];
  const host = modelHost({ data, files: { sources } });

  // The line of the waiting proposal, open, with its change read.
  const shared = localSources();
  const store = createModelHistory({
    api: createRevisionApi(host.request),
    sources: shared,
    selection: () => undefined,
    onChanged: () => {},
  });
  await store.refresh();
  await store.readDiff(HEAD, OPEN);
  const feed = press(
    <ActivityPage
      sources={shared}
      onChanged={() => {}}
      operators={[designer]}
      history={store}
      open="proposal:p-open"
      now={NOW}
    />,
  ).html;
  const file = /<a class="act-path" href="([^"]+)"[^>]*>configuration\.sysml/
    .exec(feed)?.[1];
  ok(file, "the proposal's file is a link");
  const link = file.replaceAll("&amp;", "&");
  equal(
    link,
    `/model?page=files&version=${encoded(OPEN)}&file=configuration.sysml`,
  );

  // Files at that address shows the proposal's text of the file...
  const search = new URL(link, "http://host.test").search;
  const files = createModelFiles({ api: createRevisionApi(host.request) });
  await files.open(OPEN);
  await files.readSources(OPEN);
  const page = renderToString(
    <FilesPage
      versionInfo={{ source: { kind: "main" } }}
      location={{ search }}
      files={files}
      now={NOW}
    />,
  );
  match(page, /part def Ranker;/);
  // ...and the last change to it is the proposal, which Revisions opens.
  const last = /<a class="last" href="([^"]+)"/.exec(page)?.[1];
  ok(last);
  equal(last.replaceAll("&amp;", "&"), `/model?commit=${encoded(OPEN)}`);
  match(
    await revisionsAt(host, last.replaceAll("&amp;", "&")),
    /<h3>Add a ranking step<\/h3>/,
  );
});
